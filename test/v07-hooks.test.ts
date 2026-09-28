import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  computeAutoAnswerConfig,
  formatNoticeLine,
  installClaudeHooks,
  rememberIdentity,
  runHook,
  threadOf,
  uninstallClaudeHooks,
} from '../src/hook.js';
import { registerMcpForAgents, upsertCodexMcpBlock, type ExecResult } from '../src/agents-config.js';
import { muteIssue } from '../src/github-subscription.js';
import { createEnvelope, type Envelope } from '../src/envelope.js';
import type { ConfigV2 } from '../src/config.js';
import { appendEnvelope } from '../src/store.js';

// --- shared fixtures -------------------------------------------------------

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_CWD = process.cwd();

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('USERPROFILE', ORIGINAL_USERPROFILE);
  process.chdir(ORIGINAL_CWD);
});

/** Runs `fn` with HOME/USERPROFILE pointed at a fresh temp dir, and always
 *  cleans that dir up, even if `fn` throws or its assertion rejects. */
async function withTempHome<T>(prefix: string, fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function writeUserConfig(home: string, project: string, dev = 'ana'): void {
  const config: ConfigV2 = {
    version: 2,
    identity: { dev, agent: 'claude-code' },
    agent: 'claude-code',
    defaultProject: project,
    projects: {
      [project]: {
        bus: { kind: 'github', repo: 'acme/api', issue: 1 },
        repos: [{ name: 'api', path: path.join(home, 'repo') }],
      },
    },
  };
  mkdirSync(path.join(home, '.ai-comms'), { recursive: true });
  writeFileSync(path.join(home, '.ai-comms', 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function writeRepoComms(repoDir: string, project: string): void {
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    path.join(repoDir, '.ai-comms.json'),
    JSON.stringify(
      { project, repo: 'api', bus: { kind: 'github', repo: 'acme/api', issue: 1 } },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

function mkEnvelope(overrides: {
  id: string;
  ts: string;
  from: string;
  to: string[];
  type: Envelope['type'];
  subject?: string;
  ttlHoursFromTs?: number;
}): Envelope {
  const ttl = new Date(Date.parse(overrides.ts) + (overrides.ttlHoursFromTs ?? 24) * 3600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  return createEnvelope(
    { type: overrides.type, subject: overrides.subject ?? `subject ${overrides.id}`, to: overrides.to },
    { dev: overrides.from, agent: 'cursor', repo: 'api' },
    { id: overrides.id, ts: overrides.ts, ttl },
  );
}

// --- SPEC-v0.7 §2.7: runHook -------------------------------------------------

describe('runHook — resolution failures degrade to empty output', () => {
  it('returns "" when there is no config at all', async () => {
    await withTempHome('ai-comms-hook-noconfig-', async (home) => {
      const repoDir = path.join(home, 'repo');
      mkdirSync(repoDir, { recursive: true });
      assert.equal(runHook('user-prompt', repoDir), '');
    });
  });

  it('returns "" when the project cannot be resolved from cwd', async () => {
    await withTempHome('ai-comms-hook-noproject-', async (home) => {
      writeUserConfig(home, 'acme');
      const elsewhere = path.join(home, 'unrelated');
      mkdirSync(elsewhere, { recursive: true });
      // No .ai-comms.json here and no repo of "acme" registered at this cwd.
      assert.equal(runHook('session-start', elsewhere), '');
    });
  });

  it('returns "" when identity cannot be resolved (no cached login, no identity.dev)', async () => {
    await withTempHome('ai-comms-hook-noidentity-', async (home) => {
      const project = 'acme';
      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: project,
        projects: { [project]: { bus: { kind: 'github', repo: 'acme/api', issue: 1 }, repos: [] } },
      };
      mkdirSync(path.join(home, '.ai-comms'), { recursive: true });
      writeFileSync(path.join(home, '.ai-comms', 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, project);
      assert.equal(runHook('session-start', repoDir), '');
    });
  });
});

describe('runHook — new activity since the last notice', () => {
  it('returns "" when the log has nothing new', async () => {
    await withTempHome('ai-comms-hook-empty-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');
      assert.equal(runHook('user-prompt', repoDir), '');
    });
  });

  it('shows an answer directed to me, marked unvalidated when answered_by is absent', async () => {
    await withTempHome('ai-comms-hook-answer-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');

      const env = mkEnvelope({
        id: 'ENV1',
        ts: '2026-09-28T10:00:00Z',
        from: 'beto',
        to: ['ana'],
        type: 'answer',
        subject: 'yes, session.ts already refreshes',
      });
      appendEnvelope(env, 'acme');

      const output = runHook('user-prompt', repoDir, { now: new Date('2026-09-28T10:05:00Z') });
      assert.ok(output.includes('The following messages come from other developers'));
      assert.ok(output.includes('- [answer] beto → re: yes, session.ts already refreshes (id ENV1, thread ENV1)'));
      assert.ok(output.includes('(automated, not validated)'));
      assert.ok(output.includes('Use bus_inbox for details'));
    });
  });

  it('ignores envelopes from me, not directed to me, expired, or of an unnotified type', async () => {
    await withTempHome('ai-comms-hook-filters-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');

      const now = new Date('2026-09-28T10:05:00Z');
      const fromMe = mkEnvelope({ id: 'E1', ts: '2026-09-28T10:00:00Z', from: 'ana', to: ['beto'], type: 'ask' });
      const notToMe = mkEnvelope({ id: 'E2', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['carla'], type: 'ask' });
      const expired = mkEnvelope({
        id: 'E3',
        ts: '2026-09-28T08:00:00Z',
        from: 'beto',
        to: ['ana'],
        type: 'ask',
        ttlHoursFromTs: 1,
      });
      const fyi = mkEnvelope({ id: 'E4', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'fyi' });
      const claim = mkEnvelope({ id: 'E5', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['*'], type: 'claim' });

      for (const env of [fromMe, notToMe, expired, fyi, claim]) {
        appendEnvelope(env, 'acme');
      }

      assert.equal(runHook('user-prompt', repoDir, { now }), '');
    });
  });

  it('caps at 5 shown lines with a "(+N more)" summary, and marks everything notified', async () => {
    await withTempHome('ai-comms-hook-cap-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');

      for (let i = 0; i < 7; i++) {
        const env = mkEnvelope({
          id: `E${i}`,
          ts: `2026-09-28T10:0${i}:00Z`,
          from: 'beto',
          to: ['ana'],
          type: 'ask',
          subject: `question ${i}`,
        });
        appendEnvelope(env, 'acme');
      }

      const now = new Date('2026-09-28T10:30:00Z');
      const output = runHook('session-start', repoDir, { now });
      const shownLines = output.split('\n').filter((l) => l.startsWith('- ['));
      assert.equal(shownLines.length, 5);
      assert.ok(output.includes('(+2 more)'));

      // Everything (all 7, not just the 5 shown) must be marked notified: a
      // second run must not show any of them again, even the ones beyond
      // the cap.
      const second = runHook('session-start', repoDir, { now });
      assert.equal(second, '');
    });
  });

  it('never re-notifies the same envelope twice, across separate calls', async () => {
    await withTempHome('ai-comms-hook-idempotent-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');

      const env = mkEnvelope({ id: 'ONE', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'need' });
      appendEnvelope(env, 'acme');

      const now = new Date('2026-09-28T10:05:00Z');
      const first = runHook('user-prompt', repoDir, { now });
      assert.ok(first.includes('ONE'));

      const second = runHook('user-prompt', repoDir, { now });
      assert.equal(second, '');

      const statePath = path.join(home, '.ai-comms', 'projects', 'acme', 'hook-state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.deepEqual(state.notified, ['ONE']);
    });
  });

  it('resolves identity from the cached login (rememberIdentity) ahead of config.identity.dev', async () => {
    await withTempHome('ai-comms-hook-cached-identity-', async (home) => {
      // config.identity.dev says "wrong-dev"; the cached login (as written
      // by rememberIdentity, which the MCP server / daemon call after a
      // real whoami()) says "ana" and must win.
      const project = 'acme';
      const config: ConfigV2 = {
        version: 2,
        identity: { dev: 'wrong-dev', agent: 'claude-code' },
        agent: 'claude-code',
        defaultProject: project,
        projects: { [project]: { bus: { kind: 'github', repo: 'acme/api', issue: 1 }, repos: [] } },
      };
      mkdirSync(path.join(home, '.ai-comms'), { recursive: true });
      writeFileSync(path.join(home, '.ai-comms', 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
      rememberIdentity('ana');

      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, project);

      const env = mkEnvelope({ id: 'X1', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'ask' });
      appendEnvelope(env, project);

      const output = runHook('user-prompt', repoDir, { now: new Date('2026-09-28T10:05:00Z') });
      assert.ok(output.includes('X1'), 'expected the hook to notify ana (cached login), not wrong-dev');
    });
  });

  it('runs well under a generous bound on a 5,000-envelope log', async () => {
    await withTempHome('ai-comms-hook-perf-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');

      const lines: string[] = [];
      for (let i = 0; i < 5000; i++) {
        const type = i % 4 === 0 ? 'ask' : i % 4 === 1 ? 'answer' : i % 4 === 2 ? 'fyi' : 'claim';
        const env = mkEnvelope({
          id: `PERF${i}`,
          ts: new Date(Date.parse('2026-09-28T00:00:00Z') + i * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          from: i % 5 === 0 ? 'ana' : 'beto',
          to: i % 3 === 0 ? ['ana'] : ['*'],
          type: type as Envelope['type'],
        });
        lines.push(JSON.stringify(env));
      }
      mkdirSync(path.join(home, '.ai-comms', 'projects', 'acme'), { recursive: true });
      writeFileSync(
        path.join(home, '.ai-comms', 'projects', 'acme', 'log.jsonl'),
        lines.join('\n') + '\n',
        'utf8',
      );

      const start = Date.now();
      const output = runHook('user-prompt', repoDir, { now: new Date('2026-09-29T00:00:00Z') });
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 1000, `expected runHook to finish in well under 1s, took ${elapsed}ms`);
      assert.ok(output.length > 0);
    });
  });
});

describe('formatNoticeLine / threadOf — v0.7 thread & answered_by rendering', () => {
  // envelope.ts (out of this module's scope, SPEC-v0.7 §1.1) has not gained
  // `thread`/`answered_by` yet in this worktree, so these are exercised
  // directly against constructed objects rather than through the (currently
  // v1-only, strict-schema) log pipeline. Once envelope.ts adds the fields,
  // the same behavior will apply end-to-end through runHook.
  it('threadOf falls back to the envelope id when there is no thread', () => {
    const env = mkEnvelope({ id: 'T1', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'answer' });
    assert.equal(threadOf(env), 'T1');
  });

  it('threadOf prefers an explicit thread id', () => {
    const env = mkEnvelope({ id: 'T2', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'answer' });
    const withThread = { ...env, thread: 'ROOT1' } as Envelope;
    assert.equal(threadOf(withThread), 'ROOT1');
  });

  it('marks an answer as automated/unvalidated unless answered_by is "human"', () => {
    const env = mkEnvelope({
      id: 'T3',
      ts: '2026-09-28T10:00:00Z',
      from: 'beto',
      to: ['ana'],
      type: 'answer',
      subject: 'do it this way',
    });
    const automated = formatNoticeLine(env);
    assert.ok(automated.includes('(automated, not validated)'));

    const human = { ...env, answered_by: 'human' } as Envelope;
    const humanLine = formatNoticeLine(human);
    assert.ok(!humanLine.includes('(automated, not validated)'));

    const agent = { ...env, answered_by: 'agent' } as Envelope;
    assert.ok(formatNoticeLine(agent).includes('(automated, not validated)'));
  });

  it('never marks a question (ask/need) as unvalidated', () => {
    const env = mkEnvelope({ id: 'T4', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'ask' });
    assert.ok(!formatNoticeLine(env).includes('automated'));
  });
});

// --- SPEC-v0.7 §3.1: computeAutoAnswerConfig --------------------------------

describe('computeAutoAnswerConfig', () => {
  it('defaults every field when there was no prior config', () => {
    const result = computeAutoAnswerConfig(undefined, true);
    assert.deepEqual(result, {
      enabled: true,
      maxPerRequesterPerHour: 5,
      timeoutSeconds: 120,
      maxAgeMinutes: 10,
    });
  });

  it('keeps existing custom fields (including repoPath) when only toggling enabled', () => {
    const prev = {
      enabled: false,
      maxPerRequesterPerHour: 9,
      timeoutSeconds: 30,
      maxAgeMinutes: 15,
      repoPath: '/repos/api',
    };
    const result = computeAutoAnswerConfig(prev, true);
    assert.deepEqual(result, { ...prev, enabled: true });
  });

  it('overrides repoPath only when one is explicitly passed', () => {
    const prev = { enabled: true, maxPerRequesterPerHour: 5, timeoutSeconds: 120, maxAgeMinutes: 10, repoPath: '/old' };
    const result = computeAutoAnswerConfig(prev, false, '/new');
    // computeAutoAnswerConfig runs the passed repoPath through path.resolve()
    // (see its doc comment), which is a no-op on POSIX but turns a bare
    // `/new` into a drive-absolute `D:\new` on Windows — so the expectation
    // has to go through the same resolution rather than assume POSIX form.
    assert.equal(result.repoPath, path.resolve('/new'));
    assert.equal(result.enabled, false);
  });

  it('turning off does not drop repoPath (so turning back on later keeps it)', () => {
    const prev = { enabled: true, maxPerRequesterPerHour: 5, timeoutSeconds: 120, maxAgeMinutes: 10, repoPath: '/repos/api' };
    const result = computeAutoAnswerConfig(prev, false);
    assert.equal(result.repoPath, '/repos/api');
    assert.equal(result.enabled, false);
  });
});

// --- SPEC-v0.7 §2.7: ai-comms hooks install / uninstall ---------------------

describe('installClaudeHooks / uninstallClaudeHooks', () => {
  it('creates ~/.claude/settings.json from scratch with both hooks, using absolute node+cli', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-hooks-fresh-'));
    try {
      const command = { command: '/usr/bin/node', args: ['/opt/ai-comms/bin/ai-comms.js'] };
      const result = installClaudeHooks({ home, command });
      assert.deepEqual(result.installed.sort(), ['SessionStart', 'UserPromptSubmit']);
      assert.deepEqual(result.alreadyInstalled, []);

      const settings = JSON.parse(readFileSync(result.settingsPath, 'utf8'));
      const sessionStartCmd = settings.hooks.SessionStart[0].hooks[0].command;
      const userPromptCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
      assert.equal(sessionStartCmd, '/usr/bin/node /opt/ai-comms/bin/ai-comms.js hook session-start');
      assert.equal(userPromptCmd, '/usr/bin/node /opt/ai-comms/bin/ai-comms.js hook user-prompt');
      assert.equal(settings.hooks.SessionStart[0].hooks[0].timeout, 10);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('is idempotent: installing twice does not duplicate entries', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-hooks-idempotent-'));
    try {
      const command = { command: '/usr/bin/node', args: ['/opt/ai-comms/bin/ai-comms.js'] };
      installClaudeHooks({ home, command });
      const second = installClaudeHooks({ home, command });
      assert.deepEqual(second.installed, []);
      assert.deepEqual(second.alreadyInstalled.sort(), ['SessionStart', 'UserPromptSubmit']);

      const settings = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
      assert.equal(settings.hooks.SessionStart.length, 1);
      assert.equal(settings.hooks.SessionStart[0].hooks.length, 1);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('merges into an existing settings.json, preserving unrelated hooks and settings', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-hooks-merge-'));
    try {
      mkdirSync(path.join(home, '.claude'), { recursive: true });
      const existing = {
        theme: 'dark',
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pretool' }] }],
        },
      };
      writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(existing, null, 2), 'utf8');

      const command = { command: '/usr/bin/node', args: ['/opt/ai-comms/bin/ai-comms.js'] };
      installClaudeHooks({ home, command });

      const settings = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
      assert.equal(settings.theme, 'dark');
      assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash');
      assert.ok(settings.hooks.SessionStart);
      assert.ok(settings.hooks.UserPromptSubmit);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('leaves an unparseable settings.json untouched and reports failure', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-hooks-bad-'));
    try {
      mkdirSync(path.join(home, '.claude'), { recursive: true });
      const original = '{ not json';
      writeFileSync(path.join(home, '.claude', 'settings.json'), original, 'utf8');

      const result = installClaudeHooks({ home });
      assert.ok(result.failed);
      assert.equal(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), original);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('uninstall removes only our hooks, keeping unrelated ones intact', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-hooks-uninstall-'));
    try {
      mkdirSync(path.join(home, '.claude'), { recursive: true });
      const existing = {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'echo something-else' }] },
          ],
        },
      };
      writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(existing, null, 2), 'utf8');

      const command = { command: '/usr/bin/node', args: ['/opt/ai-comms/bin/ai-comms.js'] };
      installClaudeHooks({ home, command });

      const result = uninstallClaudeHooks({ home });
      assert.deepEqual(result.removed, ['SessionStart', 'UserPromptSubmit']);

      const settings = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
      assert.equal(settings.hooks.UserPromptSubmit.length, 1);
      assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'echo something-else');
      assert.equal(settings.hooks.SessionStart, undefined);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('uninstall is a no-op when there is no settings.json', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-hooks-uninstall-missing-'));
    try {
      const result = uninstallClaudeHooks({ home });
      assert.deepEqual(result.removed, []);
      assert.equal(existsSync(result.settingsPath), false);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

// --- SPEC-v0.7 §3.2: registerMcpForAgents -----------------------------------

function execResult(status: number, stdout = '', stderr = ''): ExecResult {
  return { status, stdout, stderr };
}

describe('registerMcpForAgents — Claude Code', () => {
  it('skips when `claude` is not on PATH', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-claude-skip-'));
    try {
      const results = registerMcpForAgents({
        home,
        which: () => false,
        execFn: () => execResult(1, '', 'should not be called'),
        version: '0.7.0',
      });
      const claude = results.find((r) => r.agent === 'claude-code')!;
      assert.equal(claude.status, 'skipped');
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('registers fresh when `claude mcp add` succeeds', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-claude-register-'));
    try {
      const calls: string[][] = [];
      const results = registerMcpForAgents({
        home,
        which: () => true,
        execFn: (command, args) => {
          calls.push([command, ...args]);
          return execResult(0);
        },
        version: '0.7.0',
      });
      const claude = results.find((r) => r.agent === 'claude-code')!;
      assert.equal(claude.status, 'registered');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], [
        'claude',
        'mcp',
        'add',
        '--scope',
        'user',
        'ai-comms',
        '--',
        'npx',
        '-y',
        '@quaglius/ai-comms@0.7.0',
        'mcp',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('removes and re-adds when the entry already exists', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-claude-update-'));
    try {
      const calls: string[][] = [];
      let addCalls = 0;
      const results = registerMcpForAgents({
        home,
        which: () => true,
        execFn: (command, args) => {
          calls.push([command, ...args]);
          if (args[0] === 'mcp' && args[1] === 'add') {
            addCalls++;
            if (addCalls === 1) {
              return execResult(1, '', 'Error: MCP server "ai-comms" already exists');
            }
          }
          return execResult(0);
        },
        version: '0.7.0',
      });
      const claude = results.find((r) => r.agent === 'claude-code')!;
      assert.equal(claude.status, 'updated');
      assert.ok(calls.some((c) => c[1] === 'mcp' && c[2] === 'remove'));
      assert.equal(addCalls, 2);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('reports failure with a manual command when add fails for another reason', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-claude-fail-'));
    try {
      const results = registerMcpForAgents({
        home,
        which: () => true,
        execFn: () => execResult(1, '', 'permission denied'),
        version: '0.7.0',
      });
      const claude = results.find((r) => r.agent === 'claude-code')!;
      assert.equal(claude.status, 'failed');
      assert.ok(claude.detail.includes('claude mcp add --scope user ai-comms'));
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('registerMcpForAgents — Cursor / Gemini CLI (JSON merge)', () => {
  it('skips when ~/.cursor and ~/.gemini do not exist', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-none-'));
    try {
      const results = registerMcpForAgents({ home, which: () => false, version: '0.7.0' });
      assert.equal(results.find((r) => r.agent === 'cursor')!.status, 'skipped');
      assert.equal(results.find((r) => r.agent === 'gemini-cli')!.status, 'skipped');
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('registers into a fresh ~/.cursor/mcp.json, then reports "skipped" (already matches) on a second run', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-cursor-'));
    try {
      mkdirSync(path.join(home, '.cursor'), { recursive: true });
      const first = registerMcpForAgents({ home, which: () => false, version: '0.7.0' });
      assert.equal(first.find((r) => r.agent === 'cursor')!.status, 'registered');

      const second = registerMcpForAgents({ home, which: () => false, version: '0.7.0' });
      assert.equal(second.find((r) => r.agent === 'cursor')!.status, 'skipped');

      const third = registerMcpForAgents({ home, which: () => false, version: '0.7.1' });
      assert.equal(third.find((r) => r.agent === 'cursor')!.status, 'updated');

      const mcpJson = JSON.parse(readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
      assert.ok(mcpJson.mcpServers['ai-comms'].args.includes('@quaglius/ai-comms@0.7.1'));
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('merges ~/.gemini/settings.json without disturbing other servers', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-gemini-'));
    try {
      mkdirSync(path.join(home, '.gemini'), { recursive: true });
      writeFileSync(
        path.join(home, '.gemini', 'settings.json'),
        JSON.stringify({ mcpServers: { other: { command: 'foo' } } }, null, 2),
        'utf8',
      );

      const results = registerMcpForAgents({ home, which: () => false, version: '0.7.0' });
      assert.equal(results.find((r) => r.agent === 'gemini-cli')!.status, 'registered');

      const settings = JSON.parse(readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
      assert.deepEqual(settings.mcpServers.other, { command: 'foo' });
      assert.equal(settings.mcpServers['ai-comms'].command, 'npx');
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('leaves an unparseable mcp.json untouched and reports failure', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-cursor-bad-'));
    try {
      mkdirSync(path.join(home, '.cursor'), { recursive: true });
      const original = '{ not json';
      writeFileSync(path.join(home, '.cursor', 'mcp.json'), original, 'utf8');

      const results = registerMcpForAgents({ home, which: () => false, version: '0.7.0' });
      assert.equal(results.find((r) => r.agent === 'cursor')!.status, 'failed');
      assert.equal(readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'), original);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('registerMcpForAgents — Codex (config.toml textual edit)', () => {
  it('skips when ~/.codex does not exist', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-codex-none-'));
    try {
      const results = registerMcpForAgents({ home, which: () => false, version: '0.7.0' });
      assert.equal(results.find((r) => r.agent === 'codex')!.status, 'skipped');
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('creates config.toml fresh when ~/.codex exists but the file does not', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-codex-fresh-'));
    try {
      mkdirSync(path.join(home, '.codex'), { recursive: true });
      const results = registerMcpForAgents({ home, which: () => false, version: '0.7.0' });
      assert.equal(results.find((r) => r.agent === 'codex')!.status, 'registered');
      const content = readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
      assert.match(content, /\[mcp_servers\.ai-comms\]/);
      assert.match(content, /@quaglius\/ai-comms@0\.7\.0/);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('replaces only the ai-comms table, leaving other tables untouched', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-codex-replace-'));
    try {
      mkdirSync(path.join(home, '.codex'), { recursive: true });
      const original = [
        '[some_other_table]',
        'foo = "bar"',
        '',
        '[mcp_servers.ai-comms]',
        'command = "npx"',
        'args = ["-y", "@quaglius/ai-comms@0.6.0", "mcp"]',
        '',
        '[mcp_servers.other]',
        'command = "other-cmd"',
        '',
      ].join('\n');
      writeFileSync(path.join(home, '.codex', 'config.toml'), original, 'utf8');

      const results = registerMcpForAgents({ home, which: () => false, version: '0.7.0' });
      assert.equal(results.find((r) => r.agent === 'codex')!.status, 'updated');

      const content = readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
      assert.match(content, /\[some_other_table\]\nfoo = "bar"/);
      assert.match(content, /\[mcp_servers\.other\]\ncommand = "other-cmd"/);
      assert.match(content, /@quaglius\/ai-comms@0\.7\.0/);
      assert.ok(!content.includes('@quaglius/ai-comms@0.6.0'));
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('is idempotent: running twice with the same version leaves the file unchanged', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-agents-codex-idempotent-'));
    try {
      mkdirSync(path.join(home, '.codex'), { recursive: true });
      registerMcpForAgents({ home, which: () => false, version: '0.7.0' });
      const after1 = readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');

      const results = registerMcpForAgents({ home, which: () => false, version: '0.7.0' });
      assert.equal(results.find((r) => r.agent === 'codex')!.status, 'skipped');
      const after2 = readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
      assert.equal(after1, after2);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('upsertCodexMcpBlock appends to an empty file', () => {
    const result = upsertCodexMcpBlock('', '0.7.0');
    assert.match(result, /^\[mcp_servers\.ai-comms\]/);
  });

  it('upsertCodexMcpBlock preserves a nested subtable of ai-comms as part of its own block', () => {
    const original = [
      '[mcp_servers.ai-comms]',
      'command = "npx"',
      'args = ["-y", "@quaglius/ai-comms@0.6.0", "mcp"]',
      '',
      '[mcp_servers.ai-comms.env]',
      'FOO = "bar"',
      '',
      '[unrelated]',
      'x = 1',
      '',
    ].join('\n');
    const result = upsertCodexMcpBlock(original, '0.7.0');
    // The nested [mcp_servers.ai-comms.env] table is considered ours and is
    // dropped along with the rest of our regenerated block; [unrelated] survives.
    assert.ok(!result.includes('mcp_servers.ai-comms.env'));
    assert.match(result, /\[unrelated\]\nx = 1/);
    assert.match(result, /@quaglius\/ai-comms@0\.7\.0/);
  });
});

// --- SPEC-v0.7 §3.4: muteIssue -----------------------------------------------

describe('muteIssue', () => {
  it('mutes successfully: GETs the issue for node_id, then POSTs the GraphQL mutation', async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: init.body as string | undefined });

      if (method === 'GET' && url.includes('/issues/42')) {
        return new Response(JSON.stringify({ node_id: 'I_kwDOABC123' }), { status: 200 });
      }
      if (method === 'POST' && url.includes('/graphql')) {
        return new Response(
          JSON.stringify({ data: { updateSubscription: { subscribable: { viewerSubscription: 'IGNORED' } } } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const result = await muteIssue('acme/api', 42, { fetchFn, token: 'tok' });
    assert.equal(result.ok, true);
    assert.match(result.detail, /IGNORED/);
    assert.equal(calls.length, 2);
    const graphqlCall = calls[1]!;
    const parsedBody = JSON.parse(graphqlCall.body!);
    assert.equal(parsedBody.variables.id, 'I_kwDOABC123');
    assert.match(parsedBody.query, /updateSubscription/);
  });

  it('never throws when the issue GET fails, and returns ok:false', async () => {
    const fetchFn = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    const result = await muteIssue('acme/api', 42, { fetchFn, token: 'tok' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /404/);
  });

  it('returns ok:false when the GraphQL call itself is non-ok', async () => {
    const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input.toString();
      if ((init.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ node_id: 'I_abc' }), { status: 200 });
      }
      return new Response('server error', { status: 500 });
    }) as typeof fetch;
    const result = await muteIssue('acme/api', 42, { fetchFn, token: 'tok' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /500/);
  });

  it('returns ok:false when GraphQL responds with an errors array', async () => {
    const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input.toString();
      if ((init.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ node_id: 'I_abc' }), { status: 200 });
      }
      return new Response(JSON.stringify({ errors: [{ message: 'not authorized' }] }), { status: 200 });
    }) as typeof fetch;
    const result = await muteIssue('acme/api', 42, { fetchFn, token: 'tok' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /not authorized/);
  });

  it('never throws when fetch itself throws', async () => {
    const fetchFn = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const result = await muteIssue('acme/api', 42, { fetchFn, token: 'tok' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /network down/);
  });

  it('never throws on an invalid owner/repo', async () => {
    const result = await muteIssue('not-a-valid-ref', 1, { fetchFn: (async () => new Response()) as typeof fetch });
    assert.equal(result.ok, false);
  });
});
