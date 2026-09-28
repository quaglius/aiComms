import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import { prompt } from '../src/prompt.js';
import { joinSpace, resolveSpaceRepo, runStatus } from '../src/space.js';
import { resolveContext } from '../src/context.js';
import { advertisedAutoAnswer, diffGitHubBindings, type GitHubBinding } from '../src/daemon.js';
import { appendEnvelope, compactLog, loadLog } from '../src/store.js';
import { createEnvelope } from '../src/envelope.js';
import { loadConfig, saveConfig, type ConfigV2 } from '../src/config.js';
import { getConfigDir, getConfigPath, getProjectDir } from '../src/paths.js';
import type { GitHubBusConfig } from '../src/transports/types.js';
import { resetGitHubAuthForTests, setGitHubTokenProviderForTests } from '../src/github-auth.js';

/**
 * Runtime fixes from the v0.7 review: findings #1 (prompt.ts hangs/exits
 * without a TTY), #2 (presence failure crashes `status`), #3 (a space
 * unresolvable from a cwd with another project's `.ai-comms.json`), #4
 * (daemon reads config once), #5 (compaction can drop concurrent appends),
 * #6 (`registerSpaceProject` wipes an unreadable config), and #7 (`invite`
 * defaulting to the product repo). See docs/SPEC-v0.7.md.
 */

// --- shared fixtures (mirrors v07-space.test.ts / v07-presence.test.ts) ----

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('USERPROFILE', ORIGINAL_USERPROFILE);
  restoreEnvVar('GITHUB_TOKEN', ORIGINAL_GITHUB_TOKEN);
  globalThis.fetch = ORIGINAL_FETCH;
  process.chdir(ORIGINAL_CWD);
  process.stdin.isTTY = ORIGINAL_STDIN_IS_TTY;
  resetGitHubAuthForTests();
});

async function withTempHome<T>(prefix: string, fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    // A test may have chdir'd into a subdirectory of `home` (e.g. to
    // exercise CLI code that resolves paths off cwd). Windows refuses to
    // delete a directory that is the process's current working directory
    // (EBUSY), so always leave it before the recursive rmSync below.
    try {
      process.chdir(previousCwd);
    } catch {
      // previousCwd should always still exist, but never let this hide
      // the real cleanup error below.
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function useFakeGitHubAuth(): void {
  process.env.GITHUB_TOKEN = 'fake';
  setGitHubTokenProviderForTests(() => null);
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  return {
    lines,
    restore: () => {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    },
  };
}

/** Swallows whatever `prompt()` writes straight to a stream (not through
 *  `console.*`) during `fn`, so a non-interactive prompt's own log lines
 *  don't clutter the test's own output. */
async function withSilencedStdout<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = orig;
  }
}

const silentJoinSteps = {
  profile: { isTTY: false },
  registerMcp: { which: () => false },
  skipDaemonOffer: true,
  detectAgentFn: () => 'cursor',
};

// A trimmed fake of the GitHub endpoints `ai-comms join` touches.
function joinFetchMock(routes: { busIssue?: number; presenceIssue?: number } = {}): typeof fetch {
  const busIssue = routes.busIssue ?? 7;
  const presenceIssue = routes.presenceIssue ?? 8;
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();

    if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ private: true }), { status: 200 });
    }
    if (method === 'GET' && url.includes('/issues?')) {
      const label = /labels=([^&]+)/.exec(url)?.[1] ?? '';
      const issues =
        label === 'ai-comms-bus' ? [{ number: busIssue }] : label === 'ai-comms-presence' ? [{ number: presenceIssue }] : [];
      return new Response(JSON.stringify(issues), { status: 200 });
    }
    if (method === 'GET' && /\/issues\/\d+$/.test(url)) {
      // muteIssue's node_id lookup.
      return new Response(JSON.stringify({ node_id: `node-${url.split('/').pop()}` }), { status: 200 });
    }
    if (method === 'POST' && url === 'https://api.github.com/graphql') {
      return new Response(
        JSON.stringify({ data: { updateSubscription: { subscribable: { viewerSubscription: 'IGNORED' } } } }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  }) as typeof fetch;
}

// =============================================================================
// Finding #1 — prompts hang or silently exit without a TTY (src/prompt.ts)
// =============================================================================

describe('prompt() — non-interactive input never hangs', () => {
  it('returns the default immediately on a non-TTY stream, and logs the question + default', async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadableStream & { isTTY?: boolean };
    input.isTTY = false;
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => {
      written += chunk.toString();
    });

    const answer = await Promise.race([
      prompt('Make this your default project?', 'N', { input, output }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('prompt() hung')), 1000)),
    ]);

    assert.equal(answer, 'N');
    assert.match(written, /Make this your default project\?/);
    assert.match(written, /→ N \(non-interactive\)/);
  });

  it('resolves to an empty string (not undefined, not a hang) when no default is given either', async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadableStream & { isTTY?: boolean };
    input.isTTY = false;
    const output = new PassThrough();
    output.resume();

    const answer = await prompt('What is your role?', undefined, { input, output });
    assert.equal(answer, '');
  });

  it('does not hang when a TTY-like stream closes (EOF) before an answer arrives', async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadableStream & { isTTY?: boolean };
    input.isTTY = true;
    const output = new PassThrough();
    output.resume();

    const promise = prompt('Install daemon?', 'Y', { input, output });
    // Simulate Ctrl-D / the session ending with nothing typed.
    (input as unknown as PassThrough).end();

    const answer = await Promise.race([
      promise,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('prompt() hung on EOF')), 1000)),
    ]);
    assert.equal(answer, 'Y');
  });
});

describe('joinSpace — non-interactive with an existing default project', () => {
  it('keeps the existing default (asks nothing that blocks) and still registers the new project', async () => {
    await withTempHome('ai-comms-join-noninteractive-', async (home) => {
      useFakeGitHubAuth();
      globalThis.fetch = joinFetchMock();

      saveConfig({
        version: 2,
        agent: 'claude-code',
        defaultProject: 'existing',
        projects: { existing: { bus: { kind: 'github', repo: 'acme/existing', issue: 1 }, repos: [] } },
      });

      const cwd = path.join(home, 'nowhere');
      mkdirSync(cwd, { recursive: true });
      process.chdir(cwd);

      // No promptFn override: registerSpaceProject falls back to the real
      // `prompt()`, which must not hang given a non-TTY stdin (review
      // finding #1's repro: `ai-comms join acme/space < /dev/null`).
      process.stdin.isTTY = false;

      const { restore } = captureConsole();
      let result: void;
      try {
        result = await withSilencedStdout(() =>
          Promise.race([
            joinSpace('acme/space', { joinSteps: silentJoinSteps }),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('joinSpace() hung')), 2000)),
          ]),
        );
      } finally {
        restore();
      }
      void result;

      const config = loadConfig();
      // The default project prompt's default is "N" (keep the existing
      // default) — a non-interactive run must not silently switch it.
      assert.equal(config.defaultProject, 'existing');
      // The new project is still registered even though it didn't become default.
      assert.equal(config.projects['acme--space']?.bus?.repo, 'acme/space');
    });
  });
});

// =============================================================================
// Finding #2 — presence failure crashes `ai-comms status` (src/space.ts)
// =============================================================================

describe('runStatus — degrades instead of crashing on presence/identity failures', () => {
  function statusConfig(): ConfigV2 {
    return {
      version: 2,
      agent: 'claude-code',
      defaultProject: 'acme--team',
      projects: {
        'acme--team': {
          bus: { kind: 'github', repo: 'acme/team', issue: 1, presence: 2 },
          repos: [],
        },
      },
    };
  }

  it('prints "(could not verify identity: ...)" and keeps going when whoami fails', async () => {
    await withTempHome('ai-comms-status-identity-fail-', async (home) => {
      useFakeGitHubAuth();
      globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init.method ?? 'GET').toUpperCase();
        if (method === 'GET' && url.endsWith('/user')) {
          return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
        }
        if (method === 'GET' && /\/comments\?/.test(url)) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`Unexpected fetch in test: ${method} ${url}`);
      }) as typeof fetch;

      saveConfig(statusConfig());
      const cwd = path.join(home, 'nowhere');
      mkdirSync(cwd, { recursive: true });
      process.chdir(cwd);

      const { lines, restore } = captureConsole();
      try {
        await runStatus({});
      } finally {
        restore();
      }

      const text = lines.join('\n');
      assert.match(text, /Identity: \(could not verify identity:/);
      // Everything after identity still runs.
      assert.match(text, /Project: acme--team/);
      assert.match(text, /Bus: acme\/team#1, presence #2/);
      assert.match(text, /Inbox: \d+ unread/);
      assert.match(text, /Claims: \d+ active/);
    });
  });

  it('prints "(could not read the directory: ...)" and keeps going when fetchProfiles fails', async () => {
    await withTempHome('ai-comms-status-presence-fail-', async (home) => {
      useFakeGitHubAuth();
      globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init.method ?? 'GET').toUpperCase();
        if (method === 'GET' && url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'ana' }), { status: 200 });
        }
        if (method === 'GET' && /\/comments\?/.test(url)) {
          return new Response(JSON.stringify({ message: 'Server Error' }), { status: 500 });
        }
        throw new Error(`Unexpected fetch in test: ${method} ${url}`);
      }) as typeof fetch;

      saveConfig(statusConfig());
      const cwd = path.join(home, 'nowhere');
      mkdirSync(cwd, { recursive: true });
      process.chdir(cwd);

      const { lines, restore } = captureConsole();
      try {
        await runStatus({});
      } finally {
        restore();
      }

      const text = lines.join('\n');
      assert.match(text, /Identity: ana/);
      assert.match(text, /\(could not read the directory:/);
      assert.match(text, /Inbox: \d+ unread/);
      assert.match(text, /Claims: \d+ active/);
    });
  });
});

// =============================================================================
// Finding #3 — space project unresolvable from a cwd with another project's
// `.ai-comms.json` (src/context.ts)
// =============================================================================

describe('resolveContext — override names a space unrelated to cwd\'s committed project', () => {
  function writeRepoComms(repoDir: string): void {
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      path.join(repoDir, '.ai-comms.json'),
      JSON.stringify({
        project: 'widgets-api',
        repo: 'widgets-api',
        bus: { kind: 'github', repo: 'acme/widgets-api', issue: 1 },
      }) + '\n',
      'utf8',
    );
  }

  it('falls back to the §3.3 style context for the override project instead of throwing', async () => {
    await withTempHome('ai-comms-ctx-override-fallback-', async (home) => {
      const repoDir = path.join(home, 'widgets-api');
      writeRepoComms(repoDir);

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'widgets-api',
        projects: {
          'widgets-api': {
            bus: { kind: 'github', repo: 'acme/widgets-api', issue: 1 },
            repos: [{ name: 'widgets-api', path: repoDir }],
          },
          // A team space: no registered repos at all (spec §3.1) — this is
          // exactly the shape that made every daemon poll for a space fail
          // from inside any repo that itself has a committed .ai-comms.json.
          'acme--space': {
            bus: { kind: 'github', repo: 'acme/space', issue: 5, presence: 6 },
            repos: [],
          },
        },
      };

      const ctx = resolveContext(repoDir, config, { projectOverride: 'acme--space' });
      assert.equal(ctx.project, 'acme--space');
      assert.equal(ctx.source, 'user-config');
      assert.ok(ctx.bus.kind === 'github');
      assert.equal((ctx.bus as GitHubBusConfig).repo, 'acme/space');
      assert.equal((ctx.bus as GitHubBusConfig).issue, 5);
      // repoDir has no .git, so repo falls back to the cwd's basename.
      assert.equal(ctx.repo, 'widgets-api');
    });
  });

  it('still throws the usual error when the override project does not exist at all', async () => {
    await withTempHome('ai-comms-ctx-override-missing-', async (home) => {
      const repoDir = path.join(home, 'widgets-api');
      writeRepoComms(repoDir);

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'widgets-api',
        projects: {
          'widgets-api': {
            bus: { kind: 'github', repo: 'acme/widgets-api', issue: 1 },
            repos: [{ name: 'widgets-api', path: repoDir }],
          },
        },
      };

      assert.throws(
        () => resolveContext(repoDir, config, { projectOverride: 'ghost--space' }),
        /does not match/,
      );
    });
  });

  it('still throws when the override project exists but has no bus configured', async () => {
    await withTempHome('ai-comms-ctx-override-no-bus-', async (home) => {
      const repoDir = path.join(home, 'widgets-api');
      writeRepoComms(repoDir);

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'widgets-api',
        projects: {
          'widgets-api': {
            bus: { kind: 'github', repo: 'acme/widgets-api', issue: 1 },
            repos: [{ name: 'widgets-api', path: repoDir }],
          },
          'no-bus-project': {},
        },
      };

      assert.throws(
        () => resolveContext(repoDir, config, { projectOverride: 'no-bus-project' }),
        /does not match/,
      );
    });
  });
});

// =============================================================================
// Finding #4 — daemon reads config once (src/daemon.ts)
// =============================================================================

describe('daemon — diffGitHubBindings (pure, drives the config hot-reload)', () => {
  function binding(project: string, issue: number): GitHubBinding {
    return { project, bus: { kind: 'github', repo: `acme/${project}`, issue }, repoPath: '/repo' };
  }

  it('reports a brand-new project as added, and nothing removed', () => {
    const diff = diffGitHubBindings([binding('a', 1)], [binding('a', 1), binding('b', 2)]);
    assert.deepEqual(
      diff.added.map((b) => b.project),
      ['b'],
    );
    assert.deepEqual(diff.removed, []);
  });

  it('reports a dropped project as removed, and nothing added', () => {
    const diff = diffGitHubBindings([binding('a', 1), binding('b', 2)], [binding('a', 1)]);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, ['b']);
  });

  it('reports a project whose bus changed as both removed (old timer) and added (new timer)', () => {
    const diff = diffGitHubBindings([binding('a', 1)], [binding('a', 99)]);
    assert.deepEqual(diff.removed, ['a']);
    assert.deepEqual(
      diff.added.map((b) => b.bus.issue),
      [99],
    );
  });

  it('reports nothing when the bindings are unchanged', () => {
    const diff = diffGitHubBindings([binding('a', 1)], [binding('a', 1)]);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
  });
});

describe('daemon — advertisedAutoAnswer (presence heartbeat flag)', () => {
  function config(overrides: Partial<ConfigV2['projects'][string]> = {}, agent = 'claude-code'): ConfigV2 {
    return {
      version: 2,
      agent,
      defaultProject: 'acme',
      projects: {
        acme: {
          bus: { kind: 'github', repo: 'acme/api', issue: 1 },
          repos: [{ name: 'api', path: '/repo/api' }],
          autoAnswer: { enabled: true, maxPerRequesterPerHour: 5, timeoutSeconds: 120, maxAgeMinutes: 10 },
          ...overrides,
        },
      },
    };
  }

  it('is true when enabled, the agent supports read-only launch, and exactly one repo is registered', async () => {
    await withTempHome('ai-comms-advertised-one-repo-', async (home) => {
      const repo = mkdtempSync(path.join(home, 'api-'));
      assert.equal(advertisedAutoAnswer(config({ repos: [{ name: 'api', path: repo }] }), 'acme'), true);
    });
  });

  it('is false when the only registered repo no longer exists', () => {
    assert.equal(advertisedAutoAnswer(config(), 'acme'), false);
  });

  it('is false when autoAnswer is disabled', () => {
    const cfg = config({ autoAnswer: { enabled: false, maxPerRequesterPerHour: 5, timeoutSeconds: 120, maxAgeMinutes: 10 } });
    assert.equal(advertisedAutoAnswer(cfg, 'acme'), false);
  });

  it('is false when the configured agent has no read-only launcher', () => {
    const cfg = config({}, 'cursor');
    assert.equal(advertisedAutoAnswer(cfg, 'acme'), false);
  });

  it('is false when there is no single registered repo and no explicit repoPath', () => {
    const cfg = config({ repos: [] });
    assert.equal(advertisedAutoAnswer(cfg, 'acme'), false);

    const cfgTwoRepos = config({
      repos: [
        { name: 'a', path: '/repo/a' },
        { name: 'b', path: '/repo/b' },
      ],
    });
    assert.equal(advertisedAutoAnswer(cfgTwoRepos, 'acme'), false);
  });

  it('is false when an explicit repoPath does not exist on disk', () => {
    const cfg = config({
      autoAnswer: {
        enabled: true,
        maxPerRequesterPerHour: 5,
        timeoutSeconds: 120,
        maxAgeMinutes: 10,
        repoPath: '/definitely/not/a/real/path/ai-comms-test',
      },
    });
    assert.equal(advertisedAutoAnswer(cfg, 'acme'), false);
  });

  it('is true when an explicit repoPath does exist on disk', async () => {
    await withTempHome('ai-comms-advertised-repopath-', async (home) => {
      const cfg = config({
        repos: [],
        autoAnswer: {
          enabled: true,
          maxPerRequesterPerHour: 5,
          timeoutSeconds: 120,
          maxAgeMinutes: 10,
          repoPath: mkdtempSync(path.join(home, 'repos-')),
        },
      });
      assert.equal(advertisedAutoAnswer(cfg, 'acme'), true);
    });
  });
});

// =============================================================================
// Finding #5 — compaction can drop concurrent appends (src/store.ts)
// =============================================================================

describe('store — compactLog holds the same cross-process lock as appendEnvelope', () => {
  it('folds in an envelope appended between the snapshot and the rename instead of losing it', async () => {
    await withTempHome('ai-comms-compact-race-', async () => {
      const project = 'acme';
      const from = { dev: 'ana', agent: 'claude-code', repo: 'acme/api' };
      const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

      const expired = createEnvelope({ type: 'ask', subject: 'old question', to: ['*'] }, from, {
        ts: oldTs,
        ttl: oldTs,
      });
      assert.equal(appendEnvelope(expired, project), true);

      const interleaved = createEnvelope({ type: 'fyi', subject: 'landed mid-compaction', to: ['*'] }, from);

      const result = compactLog(project, new Date(), {
        afterSnapshot: () => {
          // Simulates another process's `appendEnvelope` landing in the
          // window between compactLog's read and its rename — exactly what
          // the cross-process lock (and this belt-and-braces re-read) exist
          // to close.
          appendFileSync(path.join(getProjectDir(project), 'log.jsonl'), JSON.stringify(interleaved) + '\n', 'utf8');
        },
      });

      const finalLog = loadLog(project);
      assert.ok(
        finalLog.some((e) => e.id === interleaved.id),
        'the envelope appended during compaction must survive it',
      );
      assert.ok(
        !finalLog.some((e) => e.id === expired.id),
        'the long-expired envelope should still have been compacted away',
      );
      assert.equal(result.kept, finalLog.length);
    });
  });

  it('takes over a stale lock file rather than waiting it out', async () => {
    await withTempHome('ai-comms-stale-lock-', async () => {
      const project = 'acme';
      mkdirSync(getProjectDir(project), { recursive: true });
      const lockPath = path.join(getProjectDir(project), '.log.lock');
      writeFileSync(lockPath, '', 'utf8');
      const staleTime = new Date(Date.now() - 60_000); // well past the 10s staleness window
      utimesSync(lockPath, staleTime, staleTime);

      const from = { dev: 'ana', agent: 'claude-code', repo: 'acme/api' };
      const envelope = createEnvelope({ type: 'fyi', subject: 'hi', to: ['*'] }, from);

      const start = Date.now();
      const appended = appendEnvelope(envelope, project);
      const elapsed = Date.now() - start;

      assert.equal(appended, true);
      assert.ok(elapsed < 1000, `should take over a stale lock quickly, took ${elapsed}ms`);
      assert.ok(!existsSync(lockPath), 'the lock must be released again after the append');
    });
  });
});

// =============================================================================
// Finding #6 — registerSpaceProject wipes an unreadable config (src/space.ts)
// =============================================================================

describe('space create/join — an existing but unreadable config is never silently replaced', () => {
  it('rethrows the original loadConfig error (plus where to fix it) instead of overwriting other projects', async () => {
    await withTempHome('ai-comms-regspace-corrupt-', async () => {
      useFakeGitHubAuth();
      globalThis.fetch = joinFetchMock();

      const configPath = getConfigPath();
      mkdirSync(getConfigDir(), { recursive: true });
      writeFileSync(configPath, 'not valid json', 'utf8');

      await assert.rejects(() => joinSpace('acme/team', { joinSteps: silentJoinSteps }), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /malformed JSON/);
        assert.ok(err.message.includes('fix or move'));
        assert.ok(err.message.includes(configPath));
        return true;
      });

      // The file on disk must be untouched, not silently replaced with a
      // config holding only the new space.
      assert.equal(readFileSync(configPath, 'utf8'), 'not valid json');
    });
  });

  it('still starts fresh when there is simply no config file yet', async () => {
    await withTempHome('ai-comms-regspace-missing-', async () => {
      useFakeGitHubAuth();
      globalThis.fetch = joinFetchMock();

      assert.equal(existsSync(getConfigPath()), false);

      await joinSpace('acme/team', { joinSteps: silentJoinSteps });

      const config = loadConfig();
      assert.equal(config.projects['acme--team']?.bus?.repo, 'acme/team');
    });
  });
});

// =============================================================================
// Finding #7 — invite defaults to the product repo (src/space.ts)
// =============================================================================

describe('resolveSpaceRepo — only defaults for an actual team space', () => {
  it('throws instead of defaulting to a per-repo project\'s bus (that would be the product repo)', async () => {
    await withTempHome('ai-comms-resolvespace-product-', async (home) => {
      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'widgets-api',
        projects: {
          'widgets-api': {
            bus: { kind: 'github', repo: 'acme/widgets-api', issue: 1 },
            repos: [{ name: 'widgets-api', path: home }],
          },
        },
      };

      assert.throws(() => resolveSpaceRepo(undefined, config, home), /not a team space/);
      // --space is still honored explicitly, of course.
      assert.equal(resolveSpaceRepo('acme/widgets-api', config, home), 'acme/widgets-api');
    });
  });

  it('still defaults to a real team space\'s bus (owner--name project matching projectNameForSpace)', async () => {
    await withTempHome('ai-comms-resolvespace-space-', async (home) => {
      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme--team',
        projects: {
          'acme--team': { bus: { kind: 'github', repo: 'acme/team', issue: 1 }, repos: [] },
        },
      };
      assert.equal(resolveSpaceRepo(undefined, config, home), 'acme/team');
    });
  });
});
