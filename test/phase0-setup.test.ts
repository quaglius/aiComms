import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { afterEach, describe, it } from 'node:test';

import {
  detectAgent,
  offerDaemonInstall,
  runSetup,
  writeMcpConfig,
} from '../src/setup.js';
import { resetGitHubAuthForTests, setGitHubTokenProviderForTests } from '../src/github-auth.js';

// --- shared fixtures -------------------------------------------------------

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CWD = process.cwd();

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
  resetGitHubAuthForTests();
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
    rmSync(home, { recursive: true, force: true });
  }
}

function initGitRepoWithOrigin(dir: string, originUrl: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: dir });
}

interface MockRoutes {
  repoPrivate?: boolean;
  issues?: Array<{ number: number; pull_request?: unknown }>;
  createIssueNumber?: number;
  collaborators?: string[];
  /** HTTP status for the lock PUT; defaults to 204 (success). */
  lockStatus?: number;
  calls?: Array<{ method: string; url: string }>;
}

/** A minimal fake of the GitHub REST endpoints `runSetup` touches, routed by
 *  method + URL shape so each test only has to say what it cares about. */
function mockGithubFetch(routes: MockRoutes): typeof fetch {
  const calls = routes.calls ?? [];
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url });

    // GET /repos/{owner}/{repo} — nothing after it — is the visibility check.
    if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ private: routes.repoPrivate ?? true }), { status: 200 });
    }
    if (method === 'GET' && url.includes('/issues?')) {
      return new Response(JSON.stringify(routes.issues ?? []), { status: 200 });
    }
    if (method === 'POST' && /\/issues$/.test(url)) {
      return new Response(JSON.stringify({ number: routes.createIssueNumber ?? 99 }), { status: 201 });
    }
    if (method === 'PUT' && url.includes('/lock')) {
      const status = routes.lockStatus ?? 204;
      return new Response(status === 204 ? null : JSON.stringify({ message: 'locked forbidden' }), {
        status,
      });
    }
    if (method === 'GET' && url.includes('/collaborators')) {
      return new Response(
        JSON.stringify((routes.collaborators ?? []).map((login) => ({ login }))),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  }) as typeof fetch;
}

function useFakeGitHubAuth(): void {
  process.env.GITHUB_TOKEN = 'fake';
  setGitHubTokenProviderForTests(() => null);
}

// --- B3: setup must not rewrite a valid committed .ai-comms.json -----------

describe('B3 — setup respects an existing valid .ai-comms.json', () => {
  it('leaves the committed file byte-identical for a teammate in a differently-named folder', async () => {
    await withTempHome('ai-comms-b3-reuse-', async (home) => {
      useFakeGitHubAuth();

      // Cloned as "web-bruno" — a different folder name than the repo, and
      // than the project name in the committed file. Neither should leak
      // into the rewritten file, because it must not be rewritten at all.
      const repoDir = path.join(home, 'workspace', 'web-bruno');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');

      const committed = {
        project: 'acme',
        repo: 'web',
        bus: { kind: 'github', repo: 'acme/api', issue: 42 },
      };
      const committedContent = JSON.stringify(committed, null, 2) + '\n';
      writeFileSync(path.join(repoDir, '.ai-comms.json'), committedContent, 'utf8');

      const calls: Array<{ method: string; url: string }> = [];
      globalThis.fetch = mockGithubFetch({ collaborators: ['ana', 'beto'], calls });

      process.chdir(repoDir);
      await runSetup({ skipDaemonOffer: true });

      const after = readFileSync(path.join(repoDir, '.ai-comms.json'), 'utf8');
      assert.equal(after, committedContent, '.ai-comms.json must not be rewritten');

      // Reusing an already-known bus must not re-check visibility or
      // re-lock — the only network calls are the (read-only) collaborators
      // lookup used for the CLAUDE.md team line, and — new in v0.7 — finding
      // (or creating) and locking the presence issue, since this committed
      // file predates presence and doesn't carry `bus.presence` (spec §2.1:
      // stored in user config instead, never by rewriting the file).
      assert.ok(calls.length > 0);
      assert.ok(
        calls.every((c) => c.url.includes('/collaborators') || c.url.includes('/issues')),
        `expected only collaborators/presence-issue calls, got: ${JSON.stringify(calls)}`,
      );

      const userConfig = JSON.parse(
        readFileSync(path.join(home, '.ai-comms', 'config.json'), 'utf8'),
      );
      // presence: 99 — the mock's generic /issues route doesn't filter by
      // label, so with no `issues` fixture given it finds none and the
      // presence lookup falls through to creating one (mock's default
      // createIssueNumber).
      assert.deepEqual(userConfig.projects.acme.bus, {
        kind: 'github',
        repo: 'acme/api',
        issue: 42,
        presence: 99,
      });
      assert.equal(userConfig.projects.acme.repos[0].name, 'web');
    });
  });

  it('derives repo (and default project) from the origin remote, not the folder name, on a fresh setup', async () => {
    await withTempHome('ai-comms-b3-fresh-', async (home) => {
      useFakeGitHubAuth();

      const repoDir = path.join(home, 'workspace', 'web-bruno');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');

      globalThis.fetch = mockGithubFetch({
        repoPrivate: true,
        issues: [{ number: 7 }],
        collaborators: ['ana'],
      });

      process.chdir(repoDir);
      await runSetup({ skipDaemonOffer: true });

      const written = JSON.parse(readFileSync(path.join(repoDir, '.ai-comms.json'), 'utf8'));
      assert.equal(written.repo, 'web', 'repo must come from origin, not the "web-bruno" folder');
      assert.equal(written.project, 'web', 'default project must also come from origin');
      // presence: 7 — the mock's generic /issues route returns the same
      // fixture regardless of the `labels=` filter, so the presence lookup
      // "finds" the same #7 as the bus issue here. On real GitHub these are
      // two distinct, differently-labeled issues.
      assert.deepEqual(written.bus, { kind: 'github', repo: 'acme/web', issue: 7, presence: 7 });
    });
  });

  it('rejects a conflicting --project against an existing committed file', async () => {
    await withTempHome('ai-comms-b3-conflict-', async (home) => {
      useFakeGitHubAuth();

      const repoDir = path.join(home, 'workspace', 'web-bruno');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');
      writeFileSync(
        path.join(repoDir, '.ai-comms.json'),
        JSON.stringify({
          project: 'acme',
          repo: 'web',
          bus: { kind: 'github', repo: 'acme/api', issue: 42 },
        }) + '\n',
        'utf8',
      );

      process.chdir(repoDir);
      await assert.rejects(
        () => runSetup({ skipDaemonOffer: true, project: 'someone-else' }),
        /conflicts with .*\.ai-comms\.json/,
      );
    });
  });
});

// --- B5: private by default -------------------------------------------------

describe('B5 — private by default', () => {
  it('refuses a public bus repo', async () => {
    await withTempHome('ai-comms-b5-public-', async (home) => {
      useFakeGitHubAuth();
      const repoDir = path.join(home, 'repo');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');
      globalThis.fetch = mockGithubFetch({ repoPrivate: false });

      process.chdir(repoDir);
      await assert.rejects(() => runSetup({ skipDaemonOffer: true }), /public repo/);
      assert.equal(existsSync(path.join(repoDir, '.ai-comms.json')), false);
    });
  });

  it('proceeds on a public repo with --allow-public', async () => {
    await withTempHome('ai-comms-b5-allow-', async (home) => {
      useFakeGitHubAuth();
      const repoDir = path.join(home, 'repo');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');
      globalThis.fetch = mockGithubFetch({
        repoPrivate: false,
        issues: [{ number: 3 }],
        collaborators: [],
      });

      process.chdir(repoDir);
      await runSetup({ skipDaemonOffer: true, allowPublic: true });

      const written = JSON.parse(readFileSync(path.join(repoDir, '.ai-comms.json'), 'utf8'));
      assert.equal(written.bus.issue, 3);
    });
  });

  it('locks the bus issue after finding/creating it', async () => {
    await withTempHome('ai-comms-b5-lock-', async (home) => {
      useFakeGitHubAuth();
      const repoDir = path.join(home, 'repo');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');
      const calls: Array<{ method: string; url: string }> = [];
      globalThis.fetch = mockGithubFetch({
        repoPrivate: true,
        issues: [{ number: 3 }],
        collaborators: [],
        calls,
      });

      process.chdir(repoDir);
      await runSetup({ skipDaemonOffer: true });

      assert.ok(
        calls.some((c) => c.method === 'PUT' && c.url.includes('/issues/3/lock')),
        `expected a lock PUT, got: ${JSON.stringify(calls)}`,
      );
    });
  });

  it('does not abort setup when locking fails (e.g. 403 without write access)', async () => {
    await withTempHome('ai-comms-b5-lock-fail-', async (home) => {
      useFakeGitHubAuth();
      const repoDir = path.join(home, 'repo');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');
      globalThis.fetch = mockGithubFetch({
        repoPrivate: true,
        issues: [{ number: 3 }],
        collaborators: [],
        lockStatus: 403,
      });

      process.chdir(repoDir);
      await runSetup({ skipDaemonOffer: true });

      assert.ok(existsSync(path.join(repoDir, '.ai-comms.json')));
    });
  });
});

// --- D6: .mcp.json merge ----------------------------------------------------

describe('D6 — writeMcpConfig merges instead of leaving an existing file untouched', () => {
  it('adds ai-comms alongside an existing MCP server, preserving it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-comms-d6-merge-'));
    try {
      const target = path.join(dir, '.mcp.json');
      writeFileSync(
        target,
        JSON.stringify({ mcpServers: { other: { command: 'foo', args: ['bar'] } } }, null, 2) + '\n',
        'utf8',
      );

      writeMcpConfig(dir);

      const result = JSON.parse(readFileSync(target, 'utf8'));
      assert.deepEqual(result.mcpServers.other, { command: 'foo', args: ['bar'] });
      assert.equal(result.mcpServers['ai-comms'].command, 'npx');
      assert.ok(result.mcpServers['ai-comms'].args.includes('mcp'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an unparseable .mcp.json untouched', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-comms-d6-bad-'));
    try {
      const target = path.join(dir, '.mcp.json');
      const original = '{ this is not json';
      writeFileSync(target, original, 'utf8');

      writeMcpConfig(dir);

      assert.equal(readFileSync(target, 'utf8'), original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- B4: daemon autostart ---------------------------------------------------

describe('B4 — daemon autostart', () => {
  it('writes the systemd unit on a fresh HOME (no ~/.config yet) without throwing, and activates it', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-b4-linux-'));
    try {
      const calls: Array<{ command: string; args: string[] }> = [];
      const execFn = (command: string, args: string[]) => {
        calls.push({ command, args });
      };

      await offerDaemonInstall({ answer: 'Y', platform: 'linux', home, execFn });

      const servicePath = path.join(home, '.config', 'systemd', 'user', 'ai-comms-daemon.service');
      assert.ok(existsSync(servicePath));
      const content = readFileSync(servicePath, 'utf8');
      assert.match(content, /Environment="PATH=/);
      assert.match(content, /^ExecStart=\S/m);
      // Whatever the resolved command is (node+bin, or npx as a fallback),
      // it must be absolute — never the bare `ai-comms` that requires a
      // global install and a PATH launchd/systemd don't have.
      const execStartLine = /^ExecStart=(.+)$/m.exec(content)?.[1] ?? '';
      const firstToken = execStartLine.split(' ')[0]!.replace(/^"|"$/g, '');
      assert.ok(path.isAbsolute(firstToken), `expected an absolute ExecStart, got "${execStartLine}"`);

      assert.deepEqual(calls[0], { command: 'systemctl', args: ['--user', 'daemon-reload'] });
      assert.deepEqual(calls[1], {
        command: 'systemctl',
        args: ['--user', 'enable', '--now', 'ai-comms-daemon.service'],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes a macOS plist with absolute paths and loads it', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-b4-mac-'));
    try {
      const calls: Array<{ command: string; args: string[] }> = [];
      const execFn = (command: string, args: string[]) => {
        calls.push({ command, args });
      };

      await offerDaemonInstall({ answer: 'Y', platform: 'darwin', home, execFn });

      const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.ai-comms.daemon.plist');
      assert.ok(existsSync(plistPath));
      const content = readFileSync(plistPath, 'utf8');

      const firstArg = /<array>\s*<string>([^<]+)<\/string>/.exec(content)?.[1];
      assert.ok(firstArg, 'plist should list a ProgramArguments entry');
      assert.ok(path.isAbsolute(firstArg!), `expected an absolute path, got "${firstArg}"`);

      assert.match(content, /<key>EnvironmentVariables<\/key>/);
      assert.match(content, /<key>PATH<\/key>/);
      assert.match(content, /<key>ThrottleInterval<\/key>/);
      assert.match(content, /<key>StandardOutPath<\/key>/);
      assert.match(content, /<key>StandardErrorPath<\/key>/);

      assert.ok(calls.some((c) => c.command === 'launchctl' && c.args[0] === 'unload'));
      assert.ok(
        calls.some(
          (c) => c.command === 'launchctl' && c.args[0] === 'load' && c.args.includes(plistPath),
        ),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not throw when activation fails, and still leaves the unit file in place', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-b4-fail-'));
    try {
      const execFn = () => {
        throw new Error('systemctl: command not found');
      };

      await offerDaemonInstall({ answer: 'Y', platform: 'linux', home, execFn });

      const servicePath = path.join(home, '.config', 'systemd', 'user', 'ai-comms-daemon.service');
      assert.ok(existsSync(servicePath), 'the unit file should still be written');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('declines when the answer is "n"', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-b4-decline-'));
    try {
      await offerDaemonInstall({ answer: 'n', platform: 'linux', home, execFn: () => {} });
      assert.equal(existsSync(path.join(home, '.config', 'systemd', 'user')), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- D16: detectAgent recognizes CLAUDECODE ---------------------------------

describe('D16 — detectAgent recognizes CLAUDECODE', () => {
  it('detects claude-code from CLAUDECODE, ahead of other agent env vars', () => {
    const keys = [
      'AI_COMMS_AGENT',
      'CURSOR_TRACE_ID',
      'CURSOR_SESSION',
      'CLAUDE_CODE',
      'CLAUDECODE',
      'CODEX_HOME',
      'GEMINI_CLI',
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

    try {
      for (const key of ['AI_COMMS_AGENT', 'CURSOR_TRACE_ID', 'CURSOR_SESSION', 'CLAUDE_CODE', 'CODEX_HOME']) {
        delete process.env[key];
      }
      process.env.CLAUDECODE = '1';
      // Also set another agent's env var: if the CLAUDECODE check were
      // missing (the bug), this would fall through to it and misreport.
      process.env.GEMINI_CLI = '1';

      assert.equal(detectAgent(), 'claude-code');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        restoreEnvVar(key, value);
      }
    }
  });
});
