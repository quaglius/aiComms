import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { ConfigV2 } from '../src/config.js';
import {
  answererEnv,
  buildReadOnlyAgentSpec,
  parseAgentOutput,
} from '../src/agent-cli.js';
import {
  buildAutoAnswerPrompt,
  gatherThreadHistory,
  formatThreadHistory,
  resetAutoAnswerInFlightForTests,
  runAutoAnswer,
  shouldAutoAnswer,
} from '../src/auto-answer.js';
import { createEnvelope, EnvelopeSchema, threadOf } from '../src/envelope.js';
import { redactSecrets } from '../src/redact.js';
import {
  appendEnvelope,
  compactLog,
  getAnswerSession,
  loadAnswerSessions,
  loadLog,
  resetLogIndexForTests,
  saveAnswerSession,
} from '../src/store.js';
import { getProjectLogPath } from '../src/paths.js';

// Fake credentials are assembled at runtime so no literal token sits in the
// source: secret scanners (GitHub push protection included) flag them.
const FAKE_GHP = 'gh' + 'p_abcdefghijklmnopqrstuvwx1234';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

function withTempHome(fn: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-v07-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
      else delete process.env.HOME;
      if (ORIGINAL_USERPROFILE) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
      else delete process.env.USERPROFILE;
      rmSync(home, { recursive: true, force: true });
    });
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const sampleFrom = { dev: 'ana', agent: 'claude-code', repo: 'acme' };

function setupLikeConfig(home: string, autoAnswerOverrides: Partial<ConfigV2['projects'][string]['autoAnswer']> = {}): ConfigV2 {
  return {
    version: 2,
    agent: 'claude-code',
    defaultProject: 'acme',
    projects: {
      acme: {
        bus: { kind: 'github', repo: 'acme/api', issue: 42 },
        repos: [{ name: 'api', path: home }],
        autoAnswer: {
          enabled: true,
          maxPerRequesterPerHour: 5,
          timeoutSeconds: 120,
          maxAgeMinutes: 10,
          ...autoAnswerOverrides,
        },
      },
    },
  };
}

afterEach(() => {
  resetAutoAnswerInFlightForTests();
  if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
});

describe('envelope: v0.7 §1.1 thread/answered_by/needs_human', () => {
  it('createEnvelope emits v:1 when no new field is present', () => {
    const env = createEnvelope({ type: 'ask', subject: 'q', to: ['beto'] }, sampleFrom);
    assert.equal(env.v, 1);
    assert.equal('thread' in env, false);
    assert.equal('answered_by' in env, false);
    assert.equal('needs_human' in env, false);
  });

  it('createEnvelope emits v:2 when thread is present', () => {
    const env = createEnvelope(
      { type: 'ask', subject: 'q', to: ['beto'], thread: 'ROOT1' },
      sampleFrom,
    );
    assert.equal(env.v, 2);
    assert.equal(env.thread, 'ROOT1');
  });

  it('createEnvelope emits v:2 when needs_human is explicitly present (even if false)', () => {
    const env = createEnvelope(
      { type: 'ask', subject: 'q', to: ['beto'], needs_human: false },
      sampleFrom,
    );
    assert.equal(env.v, 2);
    assert.equal(env.needs_human, false);
  });

  it('createEnvelope emits v:2 when answered_by is present', () => {
    const env = createEnvelope(
      { type: 'answer', subject: 're: q', to: ['beto'], answered_by: 'human' },
      sampleFrom,
    );
    assert.equal(env.v, 2);
    assert.equal(env.answered_by, 'human');
  });

  it('threadOf falls back to the envelope id when thread is unset', () => {
    const env = createEnvelope({ type: 'ask', subject: 'q', to: ['beto'] }, sampleFrom, {
      id: 'ROOTID',
      ts: iso(),
      ttl: iso(864e5),
    });
    assert.equal(threadOf(env), 'ROOTID');
  });

  it('threadOf returns the explicit thread when set', () => {
    const env = createEnvelope(
      { type: 'ask', subject: 'follow-up', to: ['beto'], thread: 'ROOTID' },
      sampleFrom,
      { id: 'CHILDID', ts: iso(), ttl: iso(864e5) },
    );
    assert.equal(threadOf(env), 'ROOTID');
  });

  it('round-trips thread/answered_by/needs_human through render+parse', async () => {
    const { renderEnvelope, parseEnvelopeFromContent } = await import('../src/envelope.js');
    const env = createEnvelope(
      {
        type: 'answer',
        subject: 're: config',
        to: ['beto'],
        thread: 'ROOTID',
        answered_by: 'agent',
      },
      sampleFrom,
      { id: 'A1', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );
    const { content } = renderEnvelope(env);
    const parsed = parseEnvelopeFromContent(content);
    assert.deepEqual(parsed, env);
  });

  it('a v:1 envelope round-trips with no trace of the new keys (byte-level back-compat)', async () => {
    const { renderEnvelope, parseEnvelopeFromContent } = await import('../src/envelope.js');
    const env = createEnvelope({ type: 'fyi', subject: 'plain' }, sampleFrom, {
      id: 'PLAIN1',
      ts: '2026-09-16T12:00:00Z',
      ttl: '2026-09-17T12:00:00Z',
    });
    const { content } = renderEnvelope(env);
    assert.ok(!content.includes('"thread"'));
    assert.ok(!content.includes('"answered_by"'));
    assert.ok(!content.includes('"needs_human"'));
    assert.deepEqual(parseEnvelopeFromContent(content), env);
  });

  it('EnvelopeSchema accepts v:1 and v:2, rejects other values', () => {
    const base = {
      id: 'X',
      ts: '2026-09-16T12:00:00Z',
      from: sampleFrom,
      to: ['*'],
      type: 'fyi',
      subject: 's',
      body: '',
      refs: {},
      reply_to: null,
      hops: 0,
      ttl: '2026-09-17T12:00:00Z',
    };
    assert.doesNotThrow(() => EnvelopeSchema.parse({ ...base, v: 1 }));
    assert.doesNotThrow(() => EnvelopeSchema.parse({ ...base, v: 2 }));
    assert.throws(() => EnvelopeSchema.parse({ ...base, v: 3 }));
  });

  it('SendInputSchema accepts thread, answered_by, needs_human', async () => {
    const { SendInputSchema } = await import('../src/envelope.js');
    const parsed = SendInputSchema.parse({
      type: 'ask',
      subject: 'q',
      thread: 'ROOT',
      needs_human: true,
    });
    assert.equal(parsed.thread, 'ROOT');
    assert.equal(parsed.needs_human, true);
  });

  it('still rejects unknown fields (schema stays .strict())', () => {
    assert.throws(() =>
      EnvelopeSchema.parse({
        v: 1,
        id: 'X',
        ts: '2026-09-16T12:00:00Z',
        from: sampleFrom,
        to: ['*'],
        type: 'fyi',
        subject: 's',
        body: '',
        refs: {},
        reply_to: null,
        hops: 0,
        ttl: '2026-09-17T12:00:00Z',
        bogus: true,
      }),
    );
  });
});

describe('auto-answer: needs_human never triggers (SPEC v0.7 §2.5)', () => {
  it('shouldAutoAnswer refuses with reason "needs_human"', () => {
    const ask = createEnvelope(
      { type: 'ask', subject: 'ship it?', to: ['architect'], needs_human: true },
      { dev: 'bruno', agent: 'cursor', repo: 'api' },
    );
    const decision = shouldAutoAnswer(ask, 'architect', true);
    assert.equal(decision.trigger, false);
    assert.equal(decision.reason, 'needs_human');
  });

  it('a needs_human ask never launches the agent end-to-end', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const ask = createEnvelope(
        { type: 'need', subject: 'approve deploy?', to: ['architect'], needs_human: true },
        { dev: 'bruno', agent: 'cursor', repo: 'api' },
        { id: 'NEEDHUMAN1', ts: iso(), ttl: iso(864e5) },
      );
      let launched = false;
      const logs: string[] = [];
      await runAutoAnswer(ask, 'acme', config, (m) => logs.push(m), {
        dev: 'architect',
        runAgentFn: async () => {
          launched = true;
          return { stdout: 'nope', exitCode: 0 };
        },
      });
      assert.equal(launched, false);
    });
  });
});

describe('auto-answer: answer envelope carries thread + answered_by (SPEC v0.7 §2.5/2.6)', () => {
  it('publishes answered_by: agent and thread: threadOf(ask)', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const ask = createEnvelope(
        { type: 'ask', subject: 'where is the port configured', to: ['architect'] },
        { dev: 'bruno', agent: 'cursor', repo: 'api' },
        { id: 'ASKTHREAD1', ts: iso(), ttl: iso(864e5) },
      );

      let sent: ReturnType<typeof createEnvelope> | null = null;
      await runAutoAnswer(ask, 'acme', config, () => {}, {
        dev: 'architect',
        runAgentFn: async () => ({
          stdout: JSON.stringify({ result: 'PORT env var, see src/config.ts', session_id: 'S1', is_error: false }),
          exitCode: 0,
        }),
        sendFn: async (env) => {
          sent = env;
        },
        appendFn: () => true,
      });

      assert.ok(sent);
      const answer = sent as unknown as { answered_by: string; thread: string; body: string };
      assert.equal(answer.answered_by, 'agent');
      assert.equal(answer.thread, threadOf(ask));
      assert.equal(answer.thread, 'ASKTHREAD1');
    });
  });

  it('continues an existing thread: the answer keeps the root, not the follow-up id', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const followUp = createEnvelope(
        { type: 'ask', subject: 'and what about staging', to: ['architect'], thread: 'ROOTASK' },
        { dev: 'bruno', agent: 'cursor', repo: 'api' },
        { id: 'FOLLOWUP1', ts: iso(), ttl: iso(864e5) },
      );

      let sent: ReturnType<typeof createEnvelope> | null = null;
      await runAutoAnswer(followUp, 'acme', config, () => {}, {
        dev: 'architect',
        runAgentFn: async () => ({ stdout: 'staging uses STAGING_PORT', exitCode: 0 }),
        sendFn: async (env) => {
          sent = env;
        },
        appendFn: () => true,
      });

      assert.ok(sent);
      assert.equal((sent as unknown as { thread: string }).thread, 'ROOTASK');
    });
  });
});

describe('auto-answer: prompt includes thread history and SPEC guidance (§2.5/§2.6/§4)', () => {
  it('gatherThreadHistory excludes the ask, sorts oldest-first, caps at 10', () => {
    const thread = 'ROOT';
    const ask = createEnvelope(
      { type: 'ask', subject: 'latest', to: ['architect'], thread },
      { dev: 'bruno', agent: 'cursor', repo: 'api' },
      { id: 'ASKX', ts: iso(1000), ttl: iso(864e5) },
    );
    const log = [];
    for (let i = 0; i < 12; i++) {
      log.push(
        createEnvelope(
          { type: 'answer', subject: `turn ${i}`, to: ['bruno'], thread },
          { dev: 'architect', agent: 'claude-code', repo: 'api' },
          { id: `TURN${i}`, ts: iso(i * 10), ttl: iso(864e5) },
        ),
      );
    }
    // A message from an unrelated thread must never show up.
    log.push(
      createEnvelope(
        { type: 'ask', subject: 'unrelated', to: ['architect'] },
        { dev: 'carla', agent: 'cursor', repo: 'api' },
        { id: 'OTHERTHREAD', ts: iso(5), ttl: iso(864e5) },
      ),
    );

    const history = gatherThreadHistory(log, ask);
    assert.equal(history.length, 10);
    assert.ok(!history.some((e) => e.id === 'ASKX'));
    assert.ok(!history.some((e) => e.id === 'OTHERTHREAD'));
    // oldest-first: turns 2..11 kept (0 and 1 dropped by the cap of 10)
    assert.equal(history[0]!.id, 'TURN2');
    assert.equal(history[9]!.id, 'TURN11');
  });

  it('formatThreadHistory renders "[type] dev/repo: subject — body" and cuts bodies to 800 chars', () => {
    const longBody = 'x'.repeat(900);
    const env = createEnvelope(
      { type: 'answer', subject: 'earlier answer', to: ['bruno'], body: longBody },
      { dev: 'architect', agent: 'claude-code', repo: 'api' },
      { id: 'H1', ts: iso(), ttl: iso(864e5) },
    );
    const rendered = formatThreadHistory([env]);
    assert.match(rendered, /^\[answer\] architect\/api: earlier answer — x+$/);
    const bodyPart = rendered.split(' — ')[1]!;
    assert.equal(bodyPart.length, 800);
  });

  it('formatThreadHistory has a placeholder for an empty thread', () => {
    assert.match(formatThreadHistory([]), /no earlier messages/);
  });

  it('buildAutoAnswerPrompt folds in the thread history', () => {
    const thread = 'ROOT2';
    const ask = createEnvelope(
      { type: 'ask', subject: 'next question', to: ['architect'], thread },
      { dev: 'bruno', agent: 'cursor', repo: 'api' },
      { id: 'ASKY', ts: iso(1000), ttl: iso(864e5) },
    );
    const prior = createEnvelope(
      { type: 'ask', subject: 'first question', to: ['architect'], thread, body: 'about ports' },
      { dev: 'bruno', agent: 'cursor', repo: 'api' },
      { id: 'PRIOR1', ts: iso(0), ttl: iso(864e5) },
    );
    const prompt = buildAutoAnswerPrompt(ask, [prior]);
    assert.match(prompt, /\[ask\] bruno\/api: first question — about ports/);
  });

  it('buildAutoAnswerPrompt tells the model to defer decisions to the human (§2.5)', () => {
    const ask = createEnvelope({ type: 'ask', subject: 'q', to: ['architect'] }, sampleFrom);
    const prompt = buildAutoAnswerPrompt(ask, []);
    assert.match(prompt, /validation/i);
    assert.match(prompt, /do not decide it yourself/i);
  });

  it('buildAutoAnswerPrompt tells the model to answer config questions with names/sources, never values, and to suggest documenting undocumented ones (§4)', () => {
    const ask = createEnvelope({ type: 'ask', subject: 'q', to: ['architect'] }, sampleFrom);
    const prompt = buildAutoAnswerPrompt(ask, []);
    assert.match(prompt, /never the actual value/i);
    assert.match(prompt, /Suggestion: document this in <file>/);
  });
});

describe('agent-cli: parseAgentOutput (SPEC v0.7 §4)', () => {
  it('parses the JSON output-format payload', () => {
    const out = parseAgentOutput({
      stdout: JSON.stringify({ result: 'the answer', session_id: 'SESS1', is_error: false }),
      exitCode: 0,
    });
    assert.deepEqual(out, { text: 'the answer', sessionId: 'SESS1', isError: false });
  });

  it('is_error:true in the JSON payload is honored even with exitCode 0', () => {
    const out = parseAgentOutput({
      stdout: JSON.stringify({ result: '', session_id: 'SESS1', is_error: true }),
      exitCode: 0,
    });
    assert.equal(out.isError, true);
  });

  it('falls back to raw text when stdout is not JSON', () => {
    const out = parseAgentOutput({ stdout: 'branch main, clean tree', exitCode: 0 });
    assert.deepEqual(out, { text: 'branch main, clean tree', sessionId: null, isError: false });
  });

  it('a non-zero exit with non-JSON stdout is an error with no session', () => {
    const out = parseAgentOutput({ stdout: 'boom', exitCode: 1 });
    assert.equal(out.isError, true);
    assert.equal(out.sessionId, null);
  });
});

describe('auto-answer: session memory per thread (SPEC v0.7 §4)', () => {
  it('an ask with no prior session launches without --resume, and saves the returned session', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const ask = createEnvelope(
        { type: 'ask', subject: 'q1', to: ['architect'] },
        { dev: 'bruno', agent: 'cursor', repo: 'api' },
        { id: 'SESSASK1', ts: iso(), ttl: iso(864e5) },
      );

      let sawResumeFlag = false;
      await runAutoAnswer(ask, 'acme', config, () => {}, {
        dev: 'architect',
        runAgentFn: async (spec) => {
          if (spec.args.includes('--resume')) sawResumeFlag = true;
          return {
            stdout: JSON.stringify({ result: 'answer 1', session_id: 'SESS-A', is_error: false }),
            exitCode: 0,
          };
        },
        sendFn: async () => {},
        appendFn: () => true,
      });

      assert.equal(sawResumeFlag, false);
      assert.equal(getAnswerSession('acme', threadOf(ask)), 'SESS-A');
    });
  });

  it('a follow-up ask in the same thread resumes the saved session', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const thread = 'RESUMEROOT';
      saveAnswerSession('acme', thread, 'SESS-EXISTING');

      const followUp = createEnvelope(
        { type: 'ask', subject: 'q2', to: ['architect'], thread },
        { dev: 'bruno', agent: 'cursor', repo: 'api' },
        { id: 'SESSASK2', ts: iso(), ttl: iso(864e5) },
      );

      let resumedWith: string | null = null;
      await runAutoAnswer(followUp, 'acme', config, () => {}, {
        dev: 'architect',
        runAgentFn: async (spec) => {
          const idx = spec.args.indexOf('--resume');
          if (idx !== -1) resumedWith = spec.args[idx + 1] ?? null;
          return {
            stdout: JSON.stringify({ result: 'answer 2', session_id: 'SESS-EXISTING', is_error: false }),
            exitCode: 0,
          };
        },
        sendFn: async () => {},
        appendFn: () => true,
      });

      assert.equal(resumedWith, 'SESS-EXISTING');
    });
  });

  it('retries once without --resume when the resumed run fails, and still publishes', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const thread = 'RETRYROOT';
      saveAnswerSession('acme', thread, 'SESS-STALE');

      const followUp = createEnvelope(
        { type: 'ask', subject: 'q3', to: ['architect'], thread },
        { dev: 'bruno', agent: 'cursor', repo: 'api' },
        { id: 'SESSASK3', ts: iso(), ttl: iso(864e5) },
      );

      let calls = 0;
      let sent: ReturnType<typeof createEnvelope> | null = null;
      const logs: string[] = [];
      await runAutoAnswer(followUp, 'acme', config, (m) => logs.push(m), {
        dev: 'architect',
        runAgentFn: async (spec) => {
          calls++;
          const resumed = spec.args.includes('--resume');
          if (resumed) {
            return { stdout: JSON.stringify({ result: '', session_id: null, is_error: true }), exitCode: 1 };
          }
          return {
            stdout: JSON.stringify({ result: 'fresh answer', session_id: 'SESS-NEW', is_error: false }),
            exitCode: 0,
          };
        },
        sendFn: async (env) => {
          sent = env;
        },
        appendFn: () => true,
      });

      assert.equal(calls, 2, 'must retry exactly once without --resume');
      assert.ok(sent);
      assert.equal((sent as unknown as { body: string }).body, 'fresh answer');
      assert.ok(logs.some((l) => l.includes('retrying without --resume')));
      assert.equal(getAnswerSession('acme', thread), 'SESS-NEW');
    });
  });
});

describe('auto-answer: redaction before publishing (SPEC v0.7 §4)', () => {
  it('redacts a secret from the agent output before publishing, and notes + logs it', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const ask = createEnvelope(
        { type: 'ask', subject: 'what token do I use', to: ['architect'] },
        { dev: 'bruno', agent: 'cursor', repo: 'api' },
        { id: 'REDASK1', ts: iso(), ttl: iso(864e5) },
      );

      let sent: ReturnType<typeof createEnvelope> | null = null;
      const logs: string[] = [];
      await runAutoAnswer(ask, 'acme', config, (m) => logs.push(m), {
        dev: 'architect',
        runAgentFn: async () => ({
          stdout: JSON.stringify({
            result: 'use ' + FAKE_GHP + ' for CI',
            session_id: 'S1',
            is_error: false,
          }),
          exitCode: 0,
        }),
        sendFn: async (env) => {
          sent = env;
        },
        appendFn: () => true,
      });

      assert.ok(sent);
      const body = (sent as unknown as { body: string }).body;
      assert.ok(!body.includes(FAKE_GHP));
      assert.match(body, /\[redacted\]/);
      assert.match(body, /\[ai-comms redacted 1 possible secret\(s\) from this answer\]/);
      assert.ok(logs.some((l) => l.includes('auto-answer redacted 1 possible secret(s) for REDASK1: github-token')));
    });
  });

  it('does not add a redaction note when nothing was redacted', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const ask = createEnvelope(
        { type: 'ask', subject: 'where is main', to: ['architect'] },
        { dev: 'bruno', agent: 'cursor', repo: 'api' },
        { id: 'CLEANASK1', ts: iso(), ttl: iso(864e5) },
      );

      let sent: ReturnType<typeof createEnvelope> | null = null;
      await runAutoAnswer(ask, 'acme', config, () => {}, {
        dev: 'architect',
        runAgentFn: async () => ({
          stdout: JSON.stringify({ result: 'src/index.ts', session_id: 'S1', is_error: false }),
          exitCode: 0,
        }),
        sendFn: async (env) => {
          sent = env;
        },
        appendFn: () => true,
      });

      assert.ok(sent);
      assert.equal((sent as unknown as { body: string }).body, 'src/index.ts');
    });
  });
});

describe('redact.ts: pattern coverage and false positives (SPEC v0.7 §4)', () => {
  const cases: Array<{ name: string; text: string; pattern: string }> = [
    { name: 'github ghp_ token', text: FAKE_GHP, pattern: 'github-token' },
    { name: 'github fine-grained pat', text: 'github' + '_pat_abcdefghijklmnopqrstuvwxyz1234567890', pattern: 'github-token' },
    { name: 'anthropic sk-ant- key', text: 'sk' + '-ant-api03-abcdefghijklmnopqrstuv1234567890', pattern: 'sk-api-key' },
    { name: 'openai-shaped sk- key', text: 'sk' + '-abcdefghijklmnopqrstuvwxyz123456', pattern: 'sk-api-key' },
    { name: 'aws access key id AKIA', text: 'AKIA' + 'ABCDEFGHIJKLMNOP', pattern: 'aws-access-key-id' },
    { name: 'aws temp access key ASIA', text: 'ASIA' + 'ABCDEFGHIJKLMNOP', pattern: 'aws-access-key-id' },
    { name: 'slack token', text: 'xo' + 'xb-1234567890-abcdefghijklmno', pattern: 'slack-token' },
    { name: 'google api key', text: 'AI' + 'zaSyAbcdefghijklmnopqrstuvwxyz1234', pattern: 'google-api-key' },
    {
      name: 'private key block',
      text: '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIBOgIBAAJ\n-----END RSA ' + 'PRIVATE KEY-----',
      pattern: 'private-key-block',
    },
    { name: 'credential uri', text: 'postgres://admin:S3cr3tPass@db.internal:5432/app', pattern: 'credential-uri' },
    { name: 'quoted password assignment', text: 'password: "hunter2hunter2"', pattern: 'secret-assignment' },
    { name: 'unquoted token assignment', text: 'token=abcdefgh12345678', pattern: 'secret-assignment' },
  ];

  for (const c of cases) {
    it(`redacts ${c.name}`, () => {
      const { text, findings } = redactSecrets(c.text);
      assert.ok(findings.includes(c.pattern), `expected finding "${c.pattern}", got ${JSON.stringify(findings)}`);
      assert.match(text, /\[redacted\]/);
      assert.notEqual(text, c.text, 'the matched secret must have been replaced');
    });
  }

  it('findings are pattern names, never the matched secret text', () => {
    const { findings } = redactSecrets('token: "abcdefgh12345678"');
    for (const f of findings) {
      assert.ok(!f.includes('abcdefgh12345678'));
    }
  });

  it('does not flag "const token = getToken()" (function call, not a literal)', () => {
    const { text, findings } = redactSecrets('const token = getToken();');
    assert.deepEqual(findings, []);
    assert.equal(text, 'const token = getToken();');
  });

  it('does not flag ordinary code mentioning these words with short values', () => {
    const { findings } = redactSecrets('isPassword = true; const secretSauce = fn();');
    assert.deepEqual(findings, []);
  });

  it('leaves text with no secrets untouched', () => {
    const { text, findings } = redactSecrets('see src/foo.ts line 42, branch main is clean');
    assert.equal(findings.length, 0);
    assert.equal(text, 'see src/foo.ts line 42, branch main is clean');
  });
});

describe('store: in-memory id index and its invalidation (SPEC v0.7 §4)', () => {
  it('detects a duplicate written by "another process" after the index was already warm', () => {
    resetLogIndexForTests();
    return withTempHome(async () => {
      const env = createEnvelope(
        { type: 'fyi', subject: 'first' },
        sampleFrom,
        { id: 'IDX1', ts: iso(), ttl: iso(864e5) },
      );
      // Warms this process's in-memory index.
      assert.equal(appendEnvelope(env, 'acme'), true);
      assert.equal(appendEnvelope(env, 'acme'), false);

      // Simulate a second process (the daemon, or the MCP server) appending
      // directly to the same file, bypassing this process's cache entirely.
      const other = createEnvelope(
        { type: 'fyi', subject: 'from another process' },
        { dev: 'beto', agent: 'cursor', repo: 'acme' },
        { id: 'IDX2', ts: iso(1), ttl: iso(864e5) },
      );
      appendFileSync(getProjectLogPath('acme'), JSON.stringify(other) + '\n', 'utf8');

      // The size/mtime changed under us: appendEnvelope must notice and
      // treat IDX2 as a known id rather than trust a stale in-memory set.
      assert.equal(appendEnvelope(other, 'acme'), false);
      assert.equal(loadLog('acme').length, 2);
    });
  });
});

describe('store: compactLog retention (SPEC v0.7 §4)', () => {
  it('drops envelopes whose ttl expired more than 7 days ago, keeps everything else', async () => {
    await withTempHome(async () => {
      const veryOld = createEnvelope(
        { type: 'ask', subject: 'ancient', to: ['*'] },
        sampleFrom,
        { id: 'OLD1', ts: iso(-20 * 864e5), ttl: iso(-8 * 864e5) },
      );
      const recentEnough = createEnvelope(
        { type: 'ask', subject: 'recentish', to: ['*'] },
        sampleFrom,
        { id: 'RECENT1', ts: iso(-2 * 864e5), ttl: iso(-1 * 864e5) },
      );
      const notExpired = createEnvelope(
        { type: 'ask', subject: 'fresh', to: ['*'] },
        sampleFrom,
        { id: 'FRESH1', ts: iso(), ttl: iso(864e5) },
      );
      appendEnvelope(veryOld, 'acme');
      appendEnvelope(recentEnough, 'acme');
      appendEnvelope(notExpired, 'acme');

      const result = compactLog('acme');
      assert.equal(result.removed, 1);
      const ids = loadLog('acme').map((e) => e.id);
      assert.ok(!ids.includes('OLD1'));
      assert.ok(ids.includes('RECENT1'));
      assert.ok(ids.includes('FRESH1'));
    });
  });

  it('keeps an active claim regardless of its own ttl age', async () => {
    await withTempHome(async () => {
      const longClaim = createEnvelope(
        {
          type: 'claim',
          subject: 'long migration',
          refs: { paths: ['src/**'], until: iso(30 * 864e5) },
        },
        sampleFrom,
        // ttl (24h default, already long past) is much shorter than refs.until.
        { id: 'CLAIMLONG1', ts: iso(-10 * 864e5), ttl: iso(-9 * 864e5) },
      );
      appendEnvelope(longClaim, 'acme');

      const result = compactLog('acme');
      assert.equal(result.removed, 0);
      assert.ok(loadLog('acme').some((e) => e.id === 'CLAIMLONG1'));
    });
  });

  it('keeps only the most recent 200 contract/done/fyi even when all are old', async () => {
    await withTempHome(async () => {
      for (let i = 0; i < 205; i++) {
        const env = createEnvelope(
          { type: 'fyi', subject: `decision ${i}` },
          sampleFrom,
          { id: `FYI${i}`, ts: iso(-20 * 864e5 + i * 1000), ttl: iso(-19 * 864e5 + i * 1000) },
        );
        appendEnvelope(env, 'acme');
      }

      const result = compactLog('acme');
      assert.equal(result.kept, 200);
      assert.equal(result.removed, 5);
      const ids = loadLog('acme').map((e) => e.id);
      assert.ok(!ids.includes('FYI0'));
      assert.ok(!ids.includes('FYI4'));
      assert.ok(ids.includes('FYI5'));
      assert.ok(ids.includes('FYI204'));
    });
  });

  it('rewrites the log file atomically (a compact leaves no partial file)', async () => {
    await withTempHome(async () => {
      const old = createEnvelope(
        { type: 'ask', subject: 'old', to: ['*'] },
        sampleFrom,
        { id: 'ATOMIC1', ts: iso(-20 * 864e5), ttl: iso(-8 * 864e5) },
      );
      appendEnvelope(old, 'acme');
      compactLog('acme');
      const raw = readFileSync(getProjectLogPath('acme'), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      assert.equal(lines.length, 0);
    });
  });

  it('is a no-op (removed: 0) when nothing needs pruning', async () => {
    await withTempHome(async () => {
      const fresh = createEnvelope({ type: 'fyi', subject: 'fresh' }, sampleFrom, {
        id: 'NOOP1',
        ts: iso(),
        ttl: iso(864e5),
      });
      appendEnvelope(fresh, 'acme');
      const result = compactLog('acme');
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 1);
    });
  });
});

describe('store: answer-sessions.json (SPEC v0.7 §4)', () => {
  it('round-trips a session id for a thread', async () => {
    await withTempHome(async () => {
      assert.equal(getAnswerSession('acme', 'T1'), null);
      saveAnswerSession('acme', 'T1', 'SESSXYZ');
      assert.equal(getAnswerSession('acme', 'T1'), 'SESSXYZ');
    });
  });

  it('overwrites the session id for the same thread', async () => {
    await withTempHome(async () => {
      saveAnswerSession('acme', 'T1', 'FIRST');
      saveAnswerSession('acme', 'T1', 'SECOND');
      assert.equal(getAnswerSession('acme', 'T1'), 'SECOND');
      assert.equal(Object.keys(loadAnswerSessions('acme')).length, 1);
    });
  });

  it('caps stored threads to the most recent 200, evicting the oldest', async () => {
    await withTempHome(async () => {
      for (let i = 0; i < 205; i++) {
        saveAnswerSession('acme', `T${i}`, `S${i}`);
      }
      const sessions = loadAnswerSessions('acme');
      assert.equal(Object.keys(sessions).length, 200);
      assert.equal(getAnswerSession('acme', 'T0'), null);
      assert.equal(getAnswerSession('acme', 'T4'), null);
      assert.equal(getAnswerSession('acme', 'T5'), 'S5');
      assert.equal(getAnswerSession('acme', 'T204'), 'S204');
    });
  });
});
