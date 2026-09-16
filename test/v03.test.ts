import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildReadOnlyAgentSpec,
  isReadOnlyAgentSupported,
} from '../src/agent-cli.js';
import {
  shouldAutoAnswer,
  runAutoAnswer,
  isTooOldToAnswer,
  resolveAutoAnswerRepoPath,
} from '../src/auto-answer.js';
import {
  countRequesterUsage,
  isBudgetAvailable,
  pruneBudgetEntries,
  recordBudgetUse,
} from '../src/budget.js';
import {
  buildBusAskEnvelope,
  findReplyToAsk,
  PENDING_REPLY_NOTICE,
  waitForBusAskReply,
} from '../src/bus-ask.js';
import { createEnvelope } from '../src/envelope.js';
import {
  buildInstructionsBlock,
  INSTRUCTIONS_END,
  INSTRUCTIONS_START,
  upsertInstructionsBlock,
  writeInstructionsToFile,
} from '../src/instructions.js';
import { appendEnvelope, loadLog } from '../src/store.js';
import type { ConfigV2 } from '../src/config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

function withTempHome(fn: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-v03-'));
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

function sampleConfig(home: string, overrides: Partial<ConfigV2> = {}): ConfigV2 {
  const repoPath = path.join(home, 'repo');
  mkdirSync(repoPath, { recursive: true });
  return {
    version: 2,
    identity: { dev: 'ana', agent: 'claude-code' },
    defaultProject: 'acme',
    projects: {
      acme: {
        discord: { channelId: '111' },
        repos: [{ name: 'acme-api', path: repoPath }],
        autoAnswer: { enabled: true, maxPerRequesterPerHour: 2, timeoutSeconds: 120 },
      },
    },
    ...overrides,
  };
}

describe('bus_ask waitForBusAskReply', () => {
  it('returns the reply when an answer appears in the log', async () => {
    await withTempHome(async (home) => {
      const project = 'acme';
      const ask = createEnvelope(
        { type: 'ask', subject: 'schema?', to: ['beto'], body: 'details' },
        { dev: 'ana', agent: 'cursor', repo: 'acme-api' },
        { id: 'ASK1', ts: new Date().toISOString().replace(/.d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/.d{3}Z$/, 'Z') },
      );
      const answer = createEnvelope(
        {
          type: 'answer',
          subject: 're: schema?',
          body: 'see src/schema.ts',
          to: ['ana'],
          reply_to: 'ASK1',
        },
        { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
        { id: 'ANS1', ts: '2026-09-16T12:00:05Z', ttl: '2026-09-17T12:00:00Z' },
      );

      let polls = 0;
      const loadLogFn = () => {
        polls++;
        return polls >= 2 ? [ask, answer] : [ask];
      };

      const result = await waitForBusAskReply('acme', 'ASK1', 10_000, {
        pollMs: 1,
        loadLogFn: () => loadLogFn(),
        sleepFn: async () => {},
        nowFn: () => Date.now(),
      });

      assert.equal(result.kind, 'reply');
      if (result.kind === 'reply') {
        assert.equal(result.envelope.id, 'ANS1');
      }
    });
  });

  it('returns pending notice when timeout elapses', async () => {
    await withTempHome(async () => {
      const ask = createEnvelope(
        { type: 'ask', subject: 'waiting', to: ['beto'] },
        { dev: 'ana', agent: 'cursor', repo: 'acme-api' },
        { id: 'ASK2', ts: new Date().toISOString().replace(/.d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/.d{3}Z$/, 'Z') },
      );

      let now = 0;
      const result = await waitForBusAskReply('acme', 'ASK2', 5, {
        pollMs: 2,
        loadLogFn: () => [ask],
        sleepFn: async (ms) => {
          now += ms;
        },
        nowFn: () => now,
      });

      assert.equal(result.kind, 'pending');
      assert.match(PENDING_REPLY_NOTICE, /pending/);
    });
  });

  it('findReplyToAsk accepts counter-questions', () => {
    const askId = 'ASK3';
    const counter = createEnvelope(
      { type: 'ask', subject: 'which endpoint?', to: ['ana'], reply_to: askId },
      { dev: 'beto', agent: 'cursor', repo: 'acme-web' },
      { id: 'ASK4', ts: '2026-09-16T12:01:00Z', ttl: '2026-09-17T12:00:00Z' },
    );
    assert.equal(findReplyToAsk([counter], askId)?.id, 'ASK4');
  });

  it('buildBusAskEnvelope keeps question in subject and body', () => {
    const env = buildBusAskEnvelope(
      'What is the response shape?',
      ['beto'],
      { dev: 'ana', agent: 'cursor', repo: 'acme-api' },
      'GET /users',
    );
    assert.equal(env.type, 'ask');
    assert.match(env.subject, /response shape/);
    assert.match(env.body, /GET \/users/);
    assert.deepEqual(env.to, ['beto']);
  });
});

describe('auto-answer budget', () => {
  it('blocks at the limit and recovers when the window rolls', async () => {
    await withTempHome(async (home) => {
      const project = 'acme';
      const now = new Date('2026-09-16T12:00:00Z').getTime();

      recordBudgetUse(project, 'beto', new Date(now - 30 * 60 * 1000));
      recordBudgetUse(project, 'beto', new Date(now - 20 * 60 * 1000));

      assert.equal(isBudgetAvailable(project, 'beto', 2, now), false);

      const pruned = pruneBudgetEntries(
        [
          { requester: 'beto', ts: '2026-09-16T10:30:00Z' },
          { requester: 'beto', ts: '2026-09-16T11:00:00Z' },
        ],
        new Date('2026-09-16T13:00:00Z').getTime(),
      );
      assert.equal(countRequesterUsage(pruned, 'beto', new Date('2026-09-16T13:00:00Z').getTime()), 0);
      assert.equal(
        isBudgetAvailable(project, 'beto', 2, new Date('2026-09-16T13:00:00Z').getTime()),
        true,
      );
    });
  });
});

describe('auto-answer triggers', () => {
  const baseAsk = createEnvelope(
    { type: 'ask', subject: 'help', to: ['ana'] },
    { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
    { id: 'A1', ts: new Date().toISOString().replace(/.d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/.d{3}Z$/, 'Z') },
  );

  it('does not trigger for fyi', () => {
    const fyi = createEnvelope(
      { type: 'fyi', subject: 'changed', to: ['ana'] },
      { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
      { id: 'F1', ts: new Date().toISOString().replace(/.d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/.d{3}Z$/, 'Z') },
    );
    assert.equal(shouldAutoAnswer(fyi, 'ana', true).trigger, false);
  });

  it('does not trigger for broadcast ask', () => {
    const broadcast = createEnvelope(
      { type: 'ask', subject: 'help', to: ['*'] },
      { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
      { id: 'A2', ts: new Date().toISOString().replace(/.d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/.d{3}Z$/, 'Z') },
    );
    assert.equal(shouldAutoAnswer(broadcast, 'ana', true).trigger, false);
  });

  it('does not trigger when hops >= 3', () => {
    const blocked = createEnvelope(
      { type: 'ask', subject: 'help', to: ['ana'] },
      { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
      { id: 'A3', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z', hops: 3 },
    );
    assert.equal(shouldAutoAnswer(blocked, 'ana', true).trigger, false);
  });

  it('does not trigger for own envelopes', () => {
    const own = createEnvelope(
      { type: 'ask', subject: 'help', to: ['beto'] },
      { dev: 'ana', agent: 'cursor', repo: 'acme-api' },
      { id: 'A4', ts: new Date().toISOString().replace(/.d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/.d{3}Z$/, 'Z') },
    );
    assert.equal(shouldAutoAnswer(own, 'ana', true).trigger, false);
  });

  it('triggers for directed ask when enabled', () => {
    assert.equal(shouldAutoAnswer(baseAsk, 'ana', true).trigger, true);
    assert.equal(shouldAutoAnswer(baseAsk, 'ana', false).trigger, false);
  });
});

describe('unsupported agent CLI', () => {
  it('does not launch unsupported agents and logs the reason', async () => {
    await withTempHome(async (home) => {
      const config = sampleConfig(home, {
        identity: { dev: 'ana', agent: 'codex' },
      });
      const ask = createEnvelope(
        { type: 'ask', subject: 'help', to: ['ana'] },
        { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
        { id: 'ASKX', ts: new Date().toISOString().replace(/.d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/.d{3}Z$/, 'Z') },
      );

      const logs: string[] = [];
      let launched = false;

      await runAutoAnswer(ask, 'acme', config, (msg) => logs.push(msg), {
        runAgentFn: async () => {
          launched = true;
          return { stdout: 'nope', exitCode: 0 };
        },
      });

      assert.equal(launched, false);
      assert.ok(logs.some((line) => line.includes('unsupported agent "codex"')));
      assert.equal(isReadOnlyAgentSupported('codex'), false);
      assert.ok('error' in buildReadOnlyAgentSpec('codex', 'prompt', '/tmp'));
    });
  });

  it('launches claude-code with read-only tool restriction', () => {
    const spec = buildReadOnlyAgentSpec('claude-code', 'answer this', '/repo');
    assert.ok(!('error' in spec));
    if (!('error' in spec)) {
      assert.deepEqual(spec.launch.args.slice(0, 3), ['-p', '--allowedTools', 'Read,Grep,Glob']);
      assert.equal(spec.launch.args[3], '--disallowedTools');
      // Read-only stops the answerer writing; it does nothing to stop it
      // disclosing, and the answer is published to the channel.
      for (const secret of ['Read(**/.env)', 'Grep(**/.env)', 'Read(**/*credential*)', 'Read(**/.ssh/**)']) {
        assert.ok(spec.launch.args.includes(secret), `falta la denegación ${secret}`);
      }
      assert.equal(spec.launch.stdin, 'answer this');
      assert.ok(
        !spec.launch.args.includes('answer this'),
        'el prompt es texto de un tercero: nunca en argv',
      );
    }
  });

  it('refuses cursor: it cannot deny reads, and answers are published', () => {
    const spec = buildReadOnlyAgentSpec('cursor', 'answer this', '/repo');
    assert.ok('error' in spec);
    assert.equal(isReadOnlyAgentSupported('cursor'), false);
  });
});

describe('instructions block', () => {
  it('rewrites between markers without touching surrounding content', () => {
    const original = [
      '# Project',
      '',
      'Keep this line.',
      '',
      INSTRUCTIONS_START,
      'old block',
      INSTRUCTIONS_END,
      '',
      'Also keep this.',
      '',
    ].join('\n');

    const block = buildInstructionsBlock({
      project: 'acme',
      repos: ['acme-api', 'acme-web'],
      team: ['ana', 'beto'],
    });

    const updated = upsertInstructionsBlock(original, block);
    assert.match(updated, /Keep this line\./);
    assert.match(updated, /Also keep this\./);
    assert.match(updated, /bus_ask/);
    assert.equal((updated.match(new RegExp(INSTRUCTIONS_START, 'g')) ?? []).length, 1);
    assert.doesNotMatch(updated, /old block/);
  });

  it('does not duplicate the block when written twice', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-comms-instr-'));
    const file = path.join(dir, 'CLAUDE.md');
    writeFileSync(file, '# Title\n\n', 'utf8');

    const block = buildInstructionsBlock({
      project: 'acme',
      repos: ['acme-api'],
      team: ['ana'],
    });

    writeInstructionsToFile(file, block);
    writeInstructionsToFile(file, block);

    const content = readFileSync(file, 'utf8');
    assert.equal((content.match(new RegExp(INSTRUCTIONS_START, 'g')) ?? []).length, 1);
    assert.match(content, /# Title/);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('auto-answer budget skip', () => {
  it('skips when budget exceeded and logs reason', async () => {
    await withTempHome(async (home) => {
      const config = sampleConfig(home);
      const project = 'acme';
      const now = Date.now();
      recordBudgetUse(project, 'beto', new Date(now - 5 * 60 * 1000));
      recordBudgetUse(project, 'beto', new Date(now - 4 * 60 * 1000));

      const ask = createEnvelope(
        { type: 'ask', subject: 'help', to: ['ana'] },
        { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
        { id: 'ASKB', ts: new Date().toISOString().replace(/.d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/.d{3}Z$/, 'Z') },
      );

      const logs: string[] = [];
      let launched = false;
      await runAutoAnswer(ask, project, config, (msg) => logs.push(msg), {
        runAgentFn: async () => {
          launched = true;
          return { stdout: 'ok', exitCode: 0 };
        },
        isBudgetAvailableFn: () => false,
      });

      assert.equal(launched, false);
      assert.ok(logs.some((line) => line.includes('budget exceeded')));
    });
  });
});

describe('auto-answer publishes answer', () => {
  it('publishes answer without launching when agent succeeds', async () => {
    await withTempHome(async (home) => {
      const config = sampleConfig(home);
      const project = 'acme';
      const ask = createEnvelope(
        { type: 'ask', subject: 'help', to: ['ana'] },
        { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
        { id: 'ASKP', ts: new Date().toISOString().replace(/.d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/.d{3}Z$/, 'Z') },
      );

      const sent: unknown[] = [];
      await runAutoAnswer(ask, project, config, () => {}, {
        runAgentFn: async () => ({ stdout: 'branch main, clean tree', exitCode: 0 }),
        sendFn: async (env) => {
          sent.push(env);
          return { id: 'discord1', truncated: false };
        },
        getTokenFn: () => ({ token: 't', source: 'secrets' as const }),
        appendFn: (env, proj) => appendEnvelope(env, proj),
        logFn: () => [],
        isBudgetAvailableFn: () => true,
        recordBudgetFn: () => {},
      });

      assert.equal(sent.length, 1);
      const answer = sent[0] as ReturnType<typeof createEnvelope>;
      assert.equal(answer.type, 'answer');
      assert.equal(answer.reply_to, 'ASKP');
      assert.equal(answer.hops, 1);
      assert.match(answer.body, /branch main/);
    });
  });
});

describe('auto-answer freshness window', () => {
  const fresh = createEnvelope(
    { type: 'ask', subject: 'still waiting', to: ['ana'] },
    { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
  );

  it('answers an ask that just arrived', () => {
    assert.equal(isTooOldToAnswer(fresh, 10), false);
  });

  it('refuses an ask nobody is waiting on any more', () => {
    // bus_ask blocks for at most two minutes: answering a six-hour-old ask
    // reaches nobody and spends the responder's quota. This is also what stops
    // a daemon restart from replying to the whole backfilled backlog.
    const old = createEnvelope(
      { type: 'ask', subject: 'long gone', to: ['ana'] },
      { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
      { ts: new Date(Date.now() - 6 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
    );
    assert.equal(isTooOldToAnswer(old, 10), true);
  });
});

describe('auto-answer repo resolution', () => {
  const oneRepo = { discord: { channelId: '1' }, repos: [{ name: 'acme-api', path: '/code/api' }] };
  const threeRepos = {
    discord: { channelId: '1' },
    repos: [
      { name: 'acme-api', path: '/code/api' },
      { name: 'acme-web', path: '/code/web' },
      { name: 'acme-jobs', path: '/code/jobs' },
    ],
  };

  it('infers the path when the project has a single repo', () => {
    assert.equal(resolveAutoAnswerRepoPath(oneRepo), '/code/api');
  });

  it('refuses to guess across several repos', () => {
    assert.equal(resolveAutoAnswerRepoPath(threeRepos), null);
  });

  it('uses an explicit repoPath, which is how multi-repo projects work', () => {
    assert.equal(resolveAutoAnswerRepoPath(threeRepos, '/code'), '/code');
  });

  it('lets an explicit repoPath win over a single inferred repo', () => {
    assert.equal(resolveAutoAnswerRepoPath(oneRepo, '/elsewhere'), '/elsewhere');
  });
});
