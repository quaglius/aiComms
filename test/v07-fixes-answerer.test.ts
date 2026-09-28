import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, afterEach } from 'node:test';

import type { ConfigV2 } from '../src/config.js';
import { answererEnv, buildReadOnlyAgentSpec } from '../src/agent-cli.js';
import {
  canAutoAnswer,
  gatherThreadHistory,
  resetAutoAnswerInFlightForTests,
  resolveAutoAnswerRepoPath,
  runAutoAnswer,
  validateAnswerRepoPath,
} from '../src/auto-answer.js';
import { createEnvelope, threadOf } from '../src/envelope.js';
import { redactSecrets } from '../src/redact.js';

// Fake credentials are assembled at runtime by concatenation so no literal
// token sits in the source — GitHub push protection (and any other secret
// scanner) would otherwise flag a real-shaped literal, per the task's own
// instruction. See test/v07-answerer.test.ts for the same convention.
const FAKE_AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const FAKE_AWS_SECRET = 'wJalrXUtn' + 'FEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

function withTempHome(fn: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-v07fix-'));
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

afterEach(() => {
  resetAutoAnswerInFlightForTests();
});

// ---------------------------------------------------------------------------
// Finding 1: the answerer must not inherit the user's Claude settings.
// ---------------------------------------------------------------------------

describe('finding 1: answerer launch does not inherit user Claude settings', () => {
  it('uses --setting-sources "" (never "user") and caps built-in tools with --tools', () => {
    const spec = buildReadOnlyAgentSpec('claude-code', 'answer this', '/repo');
    assert.ok(!('error' in spec));
    if ('error' in spec) return;

    const args = spec.launch.args;
    const settingSourcesIdx = args.indexOf('--setting-sources');
    assert.ok(settingSourcesIdx !== -1);
    assert.equal(args[settingSourcesIdx + 1], '');
    assert.ok(!args.includes('user'), 'must never pass --setting-sources user');

    const toolsIdx = args.indexOf('--tools');
    assert.ok(toolsIdx !== -1, '--tools must be present to cap the built-in tool surface');
    assert.equal(args[toolsIdx + 1], 'Read,Grep,Glob');

    // The rest of the hardened contract (SPEC v0.7 §4) must still hold.
    assert.ok(args.includes('--permission-mode'));
    assert.ok(args.includes('dontAsk'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('json'));
    assert.ok(args.includes('--allowedTools'));
    assert.ok(args.includes('Read(./**)'));
    assert.ok(args.includes('Grep(./**)'));
    assert.ok(args.includes('Glob(./**)'));
    assert.ok(args.includes('--disallowedTools'));
  });

  it('the restriction description mentions the new flags', () => {
    const spec = buildReadOnlyAgentSpec('claude-code', 'p', '/repo');
    assert.ok(!('error' in spec));
    if ('error' in spec) return;
    assert.match(spec.restriction, /--setting-sources/);
    assert.match(spec.restriction, /--tools/);
  });

  it('--resume still works alongside the new flags', () => {
    const spec = buildReadOnlyAgentSpec('claude-code', 'p', '/repo', { sessionId: 'SESS9' });
    assert.ok(!('error' in spec));
    if ('error' in spec) return;
    const idx = spec.launch.args.indexOf('--resume');
    assert.ok(idx !== -1);
    assert.equal(spec.launch.args[idx + 1], 'SESS9');
  });

  it('answererEnv sets AI_COMMS_ANSWERER=1 so a hook can recognize the answerer and stay quiet', () => {
    const env = answererEnv({ PATH: '/usr/bin', HOME: '/home/ana' });
    assert.equal(env.AI_COMMS_ANSWERER, '1');
  });

  it('answererEnv still drops the live-session variables while adding the marker', () => {
    const env = answererEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'the-users-session',
      CLAUDE_PID: '123',
    });
    assert.deepEqual(env, { PATH: '/usr/bin', AI_COMMS_ANSWERER: '1' });
  });
});

// ---------------------------------------------------------------------------
// Finding 2: .env variants that must now be denied.
// ---------------------------------------------------------------------------

describe('finding 2: broadened .env deny list', () => {
  const newlyDenied = [
    '.env.uat',
    '.env.qa',
    '.env.ci',
    '.env.bak',
    '.env.backup',
    '.env.old',
    '.env.save',
    '.env.docker',
    '.env.stage',
    '.env.preprod',
    '.env.integration',
    '.env.e2e',
  ];

  for (const variant of newlyDenied) {
    it(`denies Read/Grep/Glob of ${variant}`, () => {
      const spec = buildReadOnlyAgentSpec('claude-code', 'p', '/repo');
      assert.ok(!('error' in spec));
      if ('error' in spec) return;
      assert.ok(
        spec.launch.args.includes(`Read(./**/${variant})`),
        `missing deny for Read(./**/${variant})`,
      );
      assert.ok(spec.launch.args.includes(`Grep(./**/${variant})`));
      assert.ok(spec.launch.args.includes(`Glob(./**/${variant})`));
    });
  }

  it('also denies the .env*.bak shape (an editor/cp backup of any .env variant)', () => {
    const spec = buildReadOnlyAgentSpec('claude-code', 'p', '/repo');
    assert.ok(!('error' in spec));
    if ('error' in spec) return;
    assert.ok(spec.launch.args.includes('Read(./**/.env*.bak)'));
  });

  it('still leaves the documented template variants readable', () => {
    const spec = buildReadOnlyAgentSpec('claude-code', 'p', '/repo');
    assert.ok(!('error' in spec));
    if ('error' in spec) return;
    for (const safe of ['.env.example', '.env.sample', '.env.template', '.env.dist']) {
      assert.ok(
        !spec.launch.args.includes(`Read(./**/${safe})`),
        `${safe} must stay readable`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 3: relative/unsafe repoPath must be refused.
// ---------------------------------------------------------------------------

describe('finding 3: validateAnswerRepoPath refuses unsafe paths', () => {
  it('refuses a relative path', () => {
    const result = validateAnswerRepoPath('.');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /absolute/);
  });

  it('refuses a relative path that looks like a real subdir', () => {
    const result = validateAnswerRepoPath('repo/checkout');
    assert.equal(result.ok, false);
  });

  it('refuses a path that does not exist', async () => {
    await withTempHome(async (home) => {
      const result = validateAnswerRepoPath(path.join(home, 'nope'));
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /does not exist/);
    });
  });

  it('refuses a path that exists but is a file, not a directory', async () => {
    await withTempHome(async (home) => {
      const { writeFileSync } = await import('node:fs');
      const file = path.join(home, 'not-a-dir');
      writeFileSync(file, 'x');
      const result = validateAnswerRepoPath(file);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /not a directory/);
    });
  });

  it('refuses the user\'s home directory itself', async () => {
    await withTempHome(async (home) => {
      const result = validateAnswerRepoPath(home);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /home directory/);
    });
  });

  it('refuses an explicit home override even when it differs from $HOME', async () => {
    await withTempHome(async (home) => {
      const otherHome = path.join(home, 'other-home');
      mkdirSync(otherHome, { recursive: true });
      const result = validateAnswerRepoPath(otherHome, { home: otherHome });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /home directory/);
    });
  });

  it('refuses a filesystem root', () => {
    const root = path.parse(process.cwd()).root;
    const result = validateAnswerRepoPath(root);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /filesystem root/);
  });

  it('accepts a real absolute directory that is neither $HOME nor a root', async () => {
    await withTempHome(async (home) => {
      const repo = path.join(home, 'code', 'api');
      mkdirSync(repo, { recursive: true });
      const result = validateAnswerRepoPath(repo);
      assert.deepEqual(result, { ok: true, path: repo });
    });
  });

  it('resolveAutoAnswerRepoPath applies the same checks to an explicit repoPath', async () => {
    await withTempHome(async (home) => {
      const result = resolveAutoAnswerRepoPath(
        { discord: { channelId: '1' }, repos: [] },
        '.',
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /absolute/);
    });
  });

  it('resolveAutoAnswerRepoPath applies the same checks to a single inferred repo', async () => {
    await withTempHome(async (home) => {
      const result = resolveAutoAnswerRepoPath({
        discord: { channelId: '1' },
        repos: [{ name: 'api', path: home }], // the home dir itself: unsafe
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /home directory/);
    });
  });

  it('runAutoAnswer skips and logs the specific reason for an unsafe repoPath, without launching', async () => {
    await withTempHome(async (home) => {
      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {
          acme: {
            bus: { kind: 'github', repo: 'acme/api', issue: 1 },
            repos: [{ name: 'api', path: home }], // unsafe: it's $HOME
            autoAnswer: { enabled: true, maxPerRequesterPerHour: 5, timeoutSeconds: 120, maxAgeMinutes: 10 },
          },
        },
      };
      const ask = createEnvelope(
        { type: 'ask', subject: 'q', to: ['architect'] },
        { dev: 'bruno', agent: 'cursor', repo: 'api' },
        { id: 'UNSAFE1', ts: iso(), ttl: iso(864e5) },
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
      assert.ok(logs.some((l) => l.includes('home directory')), `logs: ${JSON.stringify(logs)}`);
    });
  });
});

// ---------------------------------------------------------------------------
// Finding 4: canAutoAnswer reflects what will actually happen.
// ---------------------------------------------------------------------------

describe('finding 4: canAutoAnswer', () => {
  function baseConfig(overrides: Partial<ConfigV2> = {}): ConfigV2 {
    return {
      version: 2,
      agent: 'claude-code',
      defaultProject: 'acme',
      projects: {
        acme: {
          bus: { kind: 'github', repo: 'acme/api', issue: 1 },
          repos: [],
        },
      },
      ...overrides,
    };
  }

  it('is not ok when autoAnswer is disabled', () => {
    const config = baseConfig();
    const result = canAutoAnswer(config, 'acme');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /disabled/);
  });

  it('is not ok for an unsupported agent', () => {
    const config = baseConfig({ agent: 'codex' });
    config.projects.acme.autoAnswer = {
      enabled: true,
      maxPerRequesterPerHour: 5,
      timeoutSeconds: 120,
      maxAgeMinutes: 10,
    };
    const result = canAutoAnswer(config, 'acme');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /unsupported agent/);
  });

  it('is not ok with zero registered repos and no explicit repoPath, and says so with the fix command', () => {
    const config = baseConfig();
    config.projects.acme.autoAnswer = {
      enabled: true,
      maxPerRequesterPerHour: 5,
      timeoutSeconds: 120,
      maxAgeMinutes: 10,
    };
    const result = canAutoAnswer(config, 'acme');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /ai-comms autoanswer on --repo-path <dir>/);
  });

  it('is not ok with several repos and no explicit repoPath, naming the count (not the zero-repo message)', () => {
    const config = baseConfig();
    config.projects.acme.repos = [
      { name: 'a', path: '/a' },
      { name: 'b', path: '/b' },
    ];
    config.projects.acme.autoAnswer = {
      enabled: true,
      maxPerRequesterPerHour: 5,
      timeoutSeconds: 120,
      maxAgeMinutes: 10,
    };
    const result = canAutoAnswer(config, 'acme');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /2 repos/);
    assert.doesNotMatch(result.reason ?? '', /no repo registered/);
  });

  it('is ok when enabled, agent supported, and repoPath resolves to a real, safe directory', async () => {
    await withTempHome(async (home) => {
      const repo = path.join(home, 'code', 'api');
      mkdirSync(repo, { recursive: true });
      const config = baseConfig();
      config.projects.acme.repos = [{ name: 'api', path: repo }];
      config.projects.acme.autoAnswer = {
        enabled: true,
        maxPerRequesterPerHour: 5,
        timeoutSeconds: 120,
        maxAgeMinutes: 10,
      };
      const result = canAutoAnswer(config, 'acme');
      assert.deepEqual(result, { ok: true });
    });
  });

  it('is not ok for an unknown project', () => {
    const config = baseConfig();
    const result = canAutoAnswer(config, 'does-not-exist');
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Finding 5: v1 compatibility of answers (answered_by/thread omission) and
// reply_to-based thread membership.
// ---------------------------------------------------------------------------

describe('finding 5: v1-compatible answers and reply_to thread membership', () => {
  it('a follow-up answer (thread differs from the ask id) still carries thread', async () => {
    await withTempHome(async (home) => {
      const repo = path.join(home, 'repo');
      mkdirSync(repo, { recursive: true });
      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {
          acme: {
            bus: { kind: 'github', repo: 'acme/api', issue: 1 },
            repos: [{ name: 'api', path: repo }],
            autoAnswer: { enabled: true, maxPerRequesterPerHour: 5, timeoutSeconds: 120, maxAgeMinutes: 10 },
          },
        },
      };
      const followUp = createEnvelope(
        { type: 'ask', subject: 'and staging?', to: ['architect'], thread: 'ROOTX' },
        { dev: 'bruno', agent: 'cursor', repo: 'api' },
        { id: 'FOLLOWX', ts: iso(), ttl: iso(864e5) },
      );
      let sent: unknown = null;
      await runAutoAnswer(followUp, 'acme', config, () => {}, {
        dev: 'architect',
        runAgentFn: async () => ({ stdout: 'staging uses STAGING_PORT', exitCode: 0 }),
        sendFn: async (env) => {
          sent = env;
        },
        appendFn: () => true,
      });
      assert.ok(sent);
      const answer = sent as { thread?: string; answered_by?: string };
      assert.equal(answer.thread, 'ROOTX');
      assert.equal('answered_by' in answer, false);
    });
  });

  it('gatherThreadHistory includes a first-turn agent answer that has no thread field, via its reply_to', () => {
    const ask = createEnvelope(
      { type: 'ask', subject: 'root question', to: ['architect'] },
      { dev: 'bruno', agent: 'cursor', repo: 'api' },
      { id: 'ROOTASK', ts: iso(0), ttl: iso(864e5) },
    );
    // Mirrors what runAutoAnswer now actually publishes for a first-turn
    // answer: reply_to points at the ask, but thread is entirely absent.
    const firstAnswer = createEnvelope(
      { type: 'answer', subject: 're: root question', to: ['bruno'], reply_to: 'ROOTASK' },
      { dev: 'architect', agent: 'claude-code', repo: 'api' },
      { id: 'FIRSTANSWER', ts: iso(10), ttl: iso(864e5) },
    );
    assert.equal('thread' in firstAnswer, false, 'sanity: fixture has no thread field');

    const followUp = createEnvelope(
      { type: 'ask', subject: 'follow up', to: ['architect'], thread: 'ROOTASK' },
      { dev: 'bruno', agent: 'cursor', repo: 'api' },
      { id: 'FOLLOWASK', ts: iso(20), ttl: iso(864e5) },
    );

    const log = [ask, firstAnswer, followUp];
    const history = gatherThreadHistory(log, followUp);
    assert.ok(
      history.some((e) => e.id === 'FIRSTANSWER'),
      `expected FIRSTANSWER in history, got ${JSON.stringify(history.map((e) => e.id))}`,
    );
    assert.ok(history.some((e) => e.id === 'ROOTASK'));
  });

  it('gatherThreadHistory does not pull in an unrelated envelope via an unrelated reply_to chain', () => {
    const otherRoot = createEnvelope(
      { type: 'ask', subject: 'unrelated root', to: ['architect'] },
      { dev: 'carla', agent: 'cursor', repo: 'api' },
      { id: 'OTHERROOT', ts: iso(0), ttl: iso(864e5) },
    );
    const otherAnswer = createEnvelope(
      { type: 'answer', subject: 're: unrelated', to: ['carla'], reply_to: 'OTHERROOT' },
      { dev: 'architect', agent: 'claude-code', repo: 'api' },
      { id: 'OTHERANSWER', ts: iso(5), ttl: iso(864e5) },
    );
    const ask = createEnvelope(
      { type: 'ask', subject: 'my question', to: ['architect'] },
      { dev: 'bruno', agent: 'cursor', repo: 'api' },
      { id: 'MYASK', ts: iso(10), ttl: iso(864e5) },
    );
    const history = gatherThreadHistory([otherRoot, otherAnswer, ask], ask);
    assert.ok(!history.some((e) => e.id === 'OTHERROOT'));
    assert.ok(!history.some((e) => e.id === 'OTHERANSWER'));
  });

  it('a reply_to cycle in untrusted log data does not hang gatherThreadHistory', () => {
    // Third-party data (SPEC v0.7 §0): two envelopes replying to each other.
    // This must terminate, not loop forever.
    const a = createEnvelope(
      { type: 'answer', subject: 'a', to: ['x'], reply_to: 'CYCLEB' },
      { dev: 'architect', agent: 'claude-code', repo: 'api' },
      { id: 'CYCLEA', ts: iso(0), ttl: iso(864e5) },
    );
    const b = createEnvelope(
      { type: 'answer', subject: 'b', to: ['x'], reply_to: 'CYCLEA' },
      { dev: 'architect', agent: 'claude-code', repo: 'api' },
      { id: 'CYCLEB', ts: iso(1), ttl: iso(864e5) },
    );
    const ask = createEnvelope(
      { type: 'ask', subject: 'q', to: ['architect'] },
      { dev: 'bruno', agent: 'cursor', repo: 'api' },
      { id: 'CYCLEASK', ts: iso(2), ttl: iso(864e5) },
    );
    const history = gatherThreadHistory([a, b, ask], ask);
    assert.deepEqual(history, []);
  });
});

// ---------------------------------------------------------------------------
// Finding 6: broadened secret scanner.
// ---------------------------------------------------------------------------

describe('finding 6: broadened secret-assignment scanner', () => {
  const shouldRedact: Array<{ name: string; text: string }> = [
    { name: 'DB_PASSWORD=...', text: 'DB_PASSWORD=Sup3rS3cretValue!' },
    { name: 'STRIPE_SECRET=...', text: 'STRIPE_SECRET=abcdefgh12345678' },
    { name: 'client_secret: ...', text: 'client_secret: abcdefgh12345678' },
    { name: '"password": "..."', text: '"password": "hunter2hunter2"' },
    { name: 'AWS_SECRET_ACCESS_KEY=...', text: 'AWS_SECRET_ACCESS_KEY=' + FAKE_AWS_SECRET },
  ];

  for (const c of shouldRedact) {
    it(`redacts ${c.name}`, () => {
      const { text, findings } = redactSecrets(c.text);
      assert.match(text, /\[redacted\]/, `expected a redaction for: ${c.text}`);
      assert.ok(findings.length > 0);
      assert.ok(!findings.some((f) => f.includes(FAKE_AWS_SECRET)));
    });
  }

  it('the AWS secret-access-key heuristic catches a labeled value not directly adjacent to the label', () => {
    const text = 'the AWS secret access key (rotate soon): ' + FAKE_AWS_SECRET;
    const { text: redacted, findings } = redactSecrets(text);
    assert.ok(findings.includes('aws-secret-access-key'));
    assert.ok(!redacted.includes(FAKE_AWS_SECRET));
    // The anchor word itself is left in place — only the value is redacted.
    assert.match(redacted, /AWS secret access key/);
  });

  const falsePositives: Array<{ name: string; text: string }> = [
    { name: 'const token = getToken() (function call, not a literal)', text: 'const token = getToken();' },
    { name: 'password: string (a TypeScript type annotation)', text: 'interface Creds { password: string; }' },
    { name: 'token=${token} (template interpolation)', text: 'const url = `?token=${token}`;' },
    { name: 'short values behind these words', text: 'isPassword = true; const secretSauce = fn();' },
    { name: 'ordinary prose mentioning aws/secret with no long value nearby', text: 'the aws region and secret rotation policy are documented in docs/ops.md' },
  ];

  for (const c of falsePositives) {
    it(`does not flag: ${c.name}`, () => {
      const { text, findings } = redactSecrets(c.text);
      assert.deepEqual(findings, [], `unexpected findings for ${JSON.stringify(c.text)}: ${JSON.stringify(findings)}`);
      assert.equal(text, c.text);
    });
  }

  it('an AWS access key id (AKIA...) is still caught by the existing pattern, unaffected by the new one', () => {
    const { findings } = redactSecrets('key id: ' + FAKE_AKIA);
    assert.ok(findings.includes('aws-access-key-id'));
  });

  it('findings never contain the matched secret text, only the pattern name', () => {
    const { findings } = redactSecrets('DB_PASSWORD=Sup3rS3cretValue!');
    for (const f of findings) {
      assert.ok(!f.includes('Sup3rS3cretValue'));
    }
  });
});
