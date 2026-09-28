// Review-finding fixes for the v0.7 hook path (docs/SPEC-v0.7.md §2.7):
//
//   1. `ai-comms hook` no longer loads the full CLI (commander, the daemon,
//      discord.js, the MCP SDK) — bin/ai-comms.js + src/hook-entry.ts.
//   2. `drainStdin` no longer leaves stdin open/resumed forever.
//   3. `runHook` returns '' immediately under AI_COMMS_ANSWERER.
//   4. Duplicate notices from two concurrently-run hooks are prevented by a
//      lock around the hook-state.json read-modify-write (`acquireNoticeLock`,
//      exercised indirectly through `runHook`/`markNotified`).
//   5. `markNotified` lets a caller (the MCP server) suppress a notice that
//      was already returned inline.
//   6. `autoanswer on --repo-path` is resolved/validated, and `on` refuses to
//      run without an unambiguous repo path.
//   7. `autoanswer` and `profile set` print the "daemon picks this up" hint.
//
// Per-file rule: no network, no real processes except where explicitly noted
// (the concurrency test for #4 and the CLI-level tests for #6/#7, which
// exercise behavior that only exists in cli.ts's command actions and can't
// be reached by importing cli.ts directly — see v07-hooks.test.ts's own note
// on why cli.ts is never imported in tests). Those spawn `tsx` against the
// TypeScript sources directly, so they don't depend on `npm run build`
// having run first.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  AutoAnswerConfigError,
  computeAutoAnswerConfig,
  drainStdin,
  markNotified,
  resolveAutoAnswerRepoPath,
  runHook,
} from '../src/hook.js';
import { createEnvelope, type Envelope } from '../src/envelope.js';
import type { ConfigV2 } from '../src/config.js';
import { appendEnvelope } from '../src/store.js';
import { getProjectDir } from '../src/paths.js';

// --- shared fixtures (mirrors test/v07-hooks.test.ts) -----------------------

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
  restoreEnvVar('AI_COMMS_ANSWERER', undefined);
  process.chdir(ORIGINAL_CWD);
});

async function withTempHome<T>(prefix: string, fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeUserConfig(
  home: string,
  project: string,
  opts: { dev?: string; repos?: { name: string; path: string }[] } = {},
): void {
  const config: ConfigV2 = {
    version: 2,
    identity: { dev: opts.dev ?? 'ana', agent: 'claude-code' },
    agent: 'claude-code',
    defaultProject: project,
    projects: {
      [project]: {
        bus: { kind: 'github', repo: 'acme/api', issue: 1 },
        repos: opts.repos ?? [{ name: 'api', path: path.join(home, 'repo') }],
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
    JSON.stringify({ project, repo: 'api', bus: { kind: 'github', repo: 'acme/api', issue: 1 } }, null, 2) + '\n',
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
}): Envelope {
  const ttl = new Date(Date.parse(overrides.ts) + 24 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return createEnvelope(
    { type: overrides.type, subject: overrides.subject ?? `subject ${overrides.id}`, to: overrides.to },
    { dev: overrides.from, agent: 'cursor', repo: 'api' },
    { id: overrides.id, ts: overrides.ts, ttl },
  );
}

function hookLockPath(project: string): string {
  return path.join(getProjectDir(project), 'hook-state.lock');
}

function hookStatePath(project: string): string {
  return path.join(getProjectDir(project), 'hook-state.json');
}

// --- finding 3: runHook + AI_COMMS_ANSWERER ---------------------------------

describe('runHook — AI_COMMS_ANSWERER short-circuit (finding 3)', () => {
  it('returns "" immediately, and does not mark anything notified, when AI_COMMS_ANSWERER is set', async () => {
    await withTempHome('ai-comms-fix-answerer-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');

      const env = mkEnvelope({ id: 'ANS1', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'ask' });
      appendEnvelope(env, 'acme');
      const now = new Date('2026-09-28T10:05:00Z');

      process.env.AI_COMMS_ANSWERER = '1';
      assert.equal(runHook('user-prompt', repoDir, { now }), '');
      assert.equal(existsSync(hookStatePath('acme')), false, 'must not have touched hook-state.json');

      delete process.env.AI_COMMS_ANSWERER;
      const output = runHook('user-prompt', repoDir, { now });
      assert.ok(output.includes('ANS1'), 'the notice must still be pending once outside the answerer');
    });
  });

  it('behaves normally (unset === falsy)', async () => {
    await withTempHome('ai-comms-fix-answerer-unset-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');
      delete process.env.AI_COMMS_ANSWERER;
      assert.equal(runHook('user-prompt', repoDir), '');
    });
  });
});

// --- finding 5: markNotified -------------------------------------------------

describe('markNotified (finding 5)', () => {
  it('suppresses a notice runHook would otherwise show (an answer already returned inline)', async () => {
    await withTempHome('ai-comms-fix-marknotified-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');

      const env = mkEnvelope({ id: 'INLINE1', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'answer' });
      appendEnvelope(env, 'acme');

      markNotified('acme', ['INLINE1']);

      const output = runHook('user-prompt', repoDir, { now: new Date('2026-09-28T10:05:00Z') });
      assert.equal(output, '');

      const state = JSON.parse(readFileSync(hookStatePath('acme'), 'utf8'));
      assert.deepEqual(state.notified, ['INLINE1']);
    });
  });

  it('merges into existing notified ids rather than clobbering them', async () => {
    await withTempHome('ai-comms-fix-marknotified-merge-', async (home) => {
      writeUserConfig(home, 'acme');
      mkdirSync(getProjectDir('acme'), { recursive: true });
      writeFileSync(hookStatePath('acme'), JSON.stringify({ notified: ['OLD1'] }), 'utf8');

      markNotified('acme', ['NEW1', 'NEW2']);

      const state = JSON.parse(readFileSync(hookStatePath('acme'), 'utf8'));
      assert.deepEqual(state.notified, ['OLD1', 'NEW1', 'NEW2']);
    });
  });

  it('is a no-op for an empty id list (does not create hook-state.json)', async () => {
    await withTempHome('ai-comms-fix-marknotified-empty-', async (home) => {
      writeUserConfig(home, 'acme');
      markNotified('acme', []);
      assert.equal(existsSync(hookStatePath('acme')), false);
    });
  });
});

// --- finding 4(a): notice-claiming lock -------------------------------------

describe('runHook — notice-claiming lock (finding 4a)', () => {
  it('yields (returns "" without writing) when another run already holds the lock', async () => {
    await withTempHome('ai-comms-fix-lock-held-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');

      const env = mkEnvelope({ id: 'LOCK1', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'ask' });
      appendEnvelope(env, 'acme');

      // Simulate a concurrently-running hook that already grabbed the lock
      // and hasn't released it yet.
      mkdirSync(getProjectDir('acme'), { recursive: true });
      writeFileSync(hookLockPath('acme'), '999999');

      const start = Date.now();
      const output = runHook('user-prompt', repoDir, { now: new Date('2026-09-28T10:05:00Z') });
      const elapsed = Date.now() - start;

      assert.equal(output, '', 'must yield rather than double-process while the lock is held');
      assert.equal(existsSync(hookStatePath('acme')), false, 'must not have written hook-state.json');
      assert.ok(elapsed < 2000, `expected the wait budget to bound this well under 2s, took ${elapsed}ms`);
    });
  });

  it('takes over a stale lock (its owner presumed crashed) instead of waiting it out', async () => {
    await withTempHome('ai-comms-fix-lock-stale-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');

      const env = mkEnvelope({ id: 'STALE1', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'ask' });
      appendEnvelope(env, 'acme');

      mkdirSync(getProjectDir('acme'), { recursive: true });
      writeFileSync(hookLockPath('acme'), '999999');
      // Back-date the lock file well past the staleness threshold.
      const old = new Date(Date.now() - 60_000);
      utimesSync(hookLockPath('acme'), old, old);

      const start = Date.now();
      const output = runHook('user-prompt', repoDir, { now: new Date('2026-09-28T10:05:00Z') });
      const elapsed = Date.now() - start;

      assert.ok(output.includes('STALE1'), 'a stale lock must be taken over, not waited out');
      assert.ok(elapsed < 500, `expected an immediate takeover, took ${elapsed}ms`);
    });
  });

  it('two runHook calls racing on the same project print a given notice exactly once (real concurrency)', async () => {
    await withTempHome('ai-comms-fix-lock-race-', async (home) => {
      writeUserConfig(home, 'acme');
      const repoDir = path.join(home, 'repo');
      writeRepoComms(repoDir, 'acme');

      const env = mkEnvelope({ id: 'RACE1', ts: '2026-09-28T10:00:00Z', from: 'beto', to: ['ana'], type: 'ask' });
      appendEnvelope(env, 'acme');

      const require2 = createRequire(import.meta.url);
      const tsxCli = require2.resolve('tsx/cli');

      const harnessDir = mkdtempSync(path.join(tmpdir(), 'ai-comms-fix-lock-harness-'));
      const harnessFile = path.join(harnessDir, 'run-hook.mts');
      const hookSrc = path.resolve('src/hook.js');
      writeFileSync(
        harnessFile,
        [
          `import { runHook } from ${JSON.stringify(hookSrc)};`,
          `const out = runHook('user-prompt', process.argv[2], { now: new Date(process.argv[3]) });`,
          `process.stdout.write(out);`,
        ].join('\n'),
        'utf8',
      );

      const runOnce = (): Promise<string> =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [tsxCli, harnessFile, repoDir, '2026-09-28T10:05:00Z'],
            { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => (out += String(d)));
          child.stderr.on('data', (d) => (err += String(d)));
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code !== 0) reject(new Error(`harness exited ${code}: ${err}`));
            else resolve(out);
          });
        });

      try {
        const [a, b] = await Promise.all([runOnce(), runOnce()]);
        const occurrences = [a, b].filter((out) => out.includes('RACE1')).length;
        assert.equal(occurrences, 1, `expected RACE1 to be printed exactly once across both runs, got: ${JSON.stringify([a, b])}`);

        const state = JSON.parse(readFileSync(hookStatePath('acme'), 'utf8'));
        assert.deepEqual(state.notified, ['RACE1']);
      } finally {
        rmSync(harnessDir, { recursive: true, force: true });
      }
    });
  });
});

// --- finding 2: drainStdin never leaves stdin open --------------------------

interface FakeStdin extends NodeJS.ReadStream {
  paused: boolean;
  destroyed: boolean;
  resumed: boolean;
}

function makeFakeStdin(isTTY: boolean): FakeStdin {
  const emitter = new EventEmitter() as unknown as FakeStdin;
  emitter.isTTY = isTTY as never;
  emitter.paused = false;
  emitter.destroyed = false;
  emitter.resumed = false;
  emitter.pause = (() => {
    emitter.paused = true;
    return emitter;
  }) as never;
  emitter.destroy = (() => {
    emitter.destroyed = true;
    return emitter;
  }) as never;
  emitter.resume = (() => {
    emitter.resumed = true;
    return emitter;
  }) as never;
  return emitter;
}

describe('drainStdin (finding 2)', () => {
  it('resolves immediately for a TTY without touching the stream', async () => {
    const stdin = makeFakeStdin(true);
    await drainStdin(50, stdin);
    assert.equal(stdin.resumed, false);
    assert.equal(stdin.paused, false);
    assert.equal(stdin.destroyed, false);
  });

  it('pauses and destroys the stream once it ends on its own', async () => {
    const stdin = makeFakeStdin(false);
    const donePromise = drainStdin(1000, stdin);
    assert.equal(stdin.resumed, true, 'must resume a piped stdin so it can flow to "end"');
    stdin.emit('end');
    await donePromise;
    assert.equal(stdin.paused, true);
    assert.equal(stdin.destroyed, true);
    assert.equal(stdin.listenerCount('data'), 0, 'listeners must be removed once settled');
    assert.equal(stdin.listenerCount('end'), 0);
  });

  it('pauses and destroys the stream on timeout, for a pipe that never closes', async (t) => {
    // Uses node:test's mock clock rather than a real setTimeout: drainStdin's
    // own timer is deliberately `unref()`'d (so it never *by itself* keeps a
    // real CLI process alive — see its doc comment), which, against a fake
    // stream with no real OS handle backing `resume()`, can otherwise race
    // Node's "is the event loop empty yet" check. A real pipe never has that
    // problem (its own resume() holds a real handle); see the next test.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stdin = makeFakeStdin(false);
    const donePromise = drainStdin(30, stdin);
    t.mock.timers.tick(30);
    await donePromise;
    assert.equal(stdin.paused, true);
    assert.equal(stdin.destroyed, true);
  });

  it('a real hook process exits promptly even when its stdin pipe is left open (integration)', async () => {
    await withTempHome('ai-comms-fix-stdin-hang-', async () => {
      const require2 = createRequire(import.meta.url);
      const tsxCli = require2.resolve('tsx/cli');
      const entry = path.resolve('src/hook-entry.ts');

      const start = Date.now();
      const exited = await new Promise<boolean>((resolve) => {
        // Mirrors `ai-comms hook user-prompt` argv shape: argv[3] is read as
        // `kind`, so pass a throwaway argv[2] the same way bin/ai-comms.js's
        // `hook` dispatch does.
        const child = spawn(process.execPath, [tsxCli, entry, 'hook', 'user-prompt'], {
          env: { ...process.env },
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        // Never write to or end child.stdin — an open pipe, same as the
        // finding's 4s-hang scenario.
        let settled = false;
        child.on('exit', () => {
          settled = true;
          resolve(true);
        });
        setTimeout(() => {
          if (!settled) {
            child.kill();
            resolve(false);
          }
        }, 3000);
      });
      const elapsed = Date.now() - start;
      assert.ok(exited, `hook process should have exited on its own within 3s (took >${elapsed}ms)`);
      assert.ok(elapsed < 2000, `expected it to exit around the ~200ms drain timeout, took ${elapsed}ms`);
    });
  });
});

// --- finding 6: resolveAutoAnswerRepoPath / computeAutoAnswerConfig --------

describe('resolveAutoAnswerRepoPath (finding 6)', () => {
  it('resolves a relative path to an absolute one that exists', async () => {
    await withTempHome('ai-comms-fix-repopath-ok-', async (home) => {
      const dir = path.join(home, 'checkouts');
      mkdirSync(dir, { recursive: true });
      process.chdir(home);
      assert.equal(resolveAutoAnswerRepoPath('checkouts'), path.resolve(dir));
    });
  });

  it('throws when the path does not exist', () => {
    const missing = path.join(tmpdir(), `ai-comms-fix-does-not-exist-${Date.now()}`);
    assert.throws(() => resolveAutoAnswerRepoPath(missing), AutoAnswerConfigError);
  });

  it('throws when the path exists but is a file, not a directory', async () => {
    await withTempHome('ai-comms-fix-repopath-file-', async (home) => {
      const file = path.join(home, 'not-a-dir');
      writeFileSync(file, 'x', 'utf8');
      assert.throws(() => resolveAutoAnswerRepoPath(file), AutoAnswerConfigError);
    });
  });

  it('refuses the home directory', () => {
    assert.throws(() => resolveAutoAnswerRepoPath(homedir()), /home directory/);
  });

  it('refuses a filesystem root', () => {
    const root = path.parse(process.cwd()).root;
    assert.throws(() => resolveAutoAnswerRepoPath(root), /filesystem root/);
  });
});

describe('computeAutoAnswerConfig — repoPath resolution (finding 6)', () => {
  it('resolves a freshly-passed repoPath to an absolute path', () => {
    const result = computeAutoAnswerConfig(undefined, true, 'relative/dir');
    assert.equal(result.repoPath, path.resolve('relative/dir'));
  });

  it('leaves an already-stored (already-absolute) repoPath untouched when none is passed', () => {
    const prev = { enabled: true, maxPerRequesterPerHour: 5, timeoutSeconds: 120, maxAgeMinutes: 10, repoPath: '/repos/api' };
    const result = computeAutoAnswerConfig(prev, true);
    assert.equal(result.repoPath, '/repos/api');
  });
});

// --- findings 6 & 7: `autoanswer` / `profile set` CLI behavior -------------
//
// Only reachable through cli.ts's command actions (registered-repo-count
// refusal, the printed messages) — spawned as a real `tsx` process against
// src/cli.ts directly, the same way v07-hooks.test.ts explains cli.ts can
// never be *imported* in a test (its `program.parseAsync(process.argv)`
// runs as an import side effect).

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const require2 = createRequire(import.meta.url);
  const tsxCli = require2.resolve('tsx/cli');
  return spawnSync(process.execPath, [tsxCli, path.resolve('src/cli.ts'), ...args], {
    encoding: 'utf8',
    env,
    cwd,
  });
}

function setUpProject(
  home: string,
  repos: { name: string; path: string }[],
): { project: string; repoDir: string } {
  const project = 'acme';
  const repoDir = path.join(home, 'repo');
  writeUserConfig(home, project, { repos });
  writeRepoComms(repoDir, project);
  return { project, repoDir };
}

describe('autoanswer on — repo-path requirement (finding 6)', () => {
  it('refuses "on" with zero registered repos and no --repo-path', async () => {
    await withTempHome('ai-comms-fix-cli-aa-zero-', async (home) => {
      const { repoDir } = setUpProject(home, []);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const r = runCli(['autoanswer', 'on'], env, repoDir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /has 0 registered repos/);
      assert.match(r.stderr, /--repo-path <dir containing the repos>/);
    });
  });

  it('refuses "on" with several registered repos and no --repo-path (and none stored)', async () => {
    await withTempHome('ai-comms-fix-cli-aa-multi-', async (home) => {
      const { repoDir } = setUpProject(home, [
        { name: 'api', path: path.join(home, 'repo') },
        { name: 'web', path: path.join(home, 'web') },
      ]);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const r = runCli(['autoanswer', 'on'], env, repoDir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /has 2 registered repos/);
    });
  });

  it('allows "on" with exactly one registered repo and no --repo-path', async () => {
    await withTempHome('ai-comms-fix-cli-aa-single-', async (home) => {
      const { repoDir } = setUpProject(home, [{ name: 'api', path: path.join(home, 'repo') }]);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const r = runCli(['autoanswer', 'on'], env, repoDir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /autoAnswer for "acme": ON/);
    });
  });

  it('stores the resolved absolute path and prints it, and prints the restart hint', async () => {
    await withTempHome('ai-comms-fix-cli-aa-abspath-', async (home) => {
      const { project, repoDir } = setUpProject(home, [
        { name: 'api', path: path.join(home, 'repo') },
        { name: 'web', path: path.join(home, 'web') },
      ]);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const r = runCli(['autoanswer', 'on', '--repo-path', '.'], env, repoDir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`repoPath=${path.resolve(repoDir)}`));
      assert.match(r.stdout, /The running daemon picks this up within a minute\./);

      const saved = JSON.parse(readFileSync(path.join(home, '.ai-comms', 'config.json'), 'utf8'));
      assert.equal(saved.projects[project].autoAnswer.repoPath, path.resolve(repoDir));
    });
  });

  it('refuses a --repo-path that is the home directory', async () => {
    await withTempHome('ai-comms-fix-cli-aa-home-', async (home) => {
      const { repoDir } = setUpProject(home, [{ name: 'api', path: path.join(home, 'repo') }]);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const r = runCli(['autoanswer', 'on', '--repo-path', home], env, repoDir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /home directory/);
    });
  });

  it('"off" does not require the registered-repo check', async () => {
    await withTempHome('ai-comms-fix-cli-aa-off-', async (home) => {
      const { repoDir } = setUpProject(home, []);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const r = runCli(['autoanswer', 'off'], env, repoDir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /autoAnswer for "acme": OFF/);
    });
  });
});

describe('restart hint (finding 7)', () => {
  it('"profile set" prints exactly the daemon-reload hint line', async () => {
    await withTempHome('ai-comms-fix-cli-profile-', async (home) => {
      mkdirSync(path.join(home, '.ai-comms'), { recursive: true });
      writeUserConfig(home, 'acme');
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const r = runCli(['profile', 'set', '--role', 'backend'], env, home);
      assert.equal(r.status, 0, r.stderr);
      const lines = r.stdout.trim().split('\n');
      assert.equal(lines[lines.length - 1], 'The running daemon picks this up within a minute.');
    });
  });
});
