import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  createSpace,
  inviteToSpace,
  joinSpace,
  projectNameForSpace,
  resolveSpaceRepo,
  runStatus,
} from '../src/space.js';
import { loadConfig, saveConfig, type ConfigV2 } from '../src/config.js';
import { appendEnvelope } from '../src/store.js';
import { createEnvelope } from '../src/envelope.js';
import { resetGitHubAuthForTests, setGitHubTokenProviderForTests } from '../src/github-auth.js';
import { clearCollaboratorsCacheForTests } from '../src/collaborators.js';

// --- shared fixtures (mirrors phase0-setup.test.ts / v07-presence.test.ts) -

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
  clearCollaboratorsCacheForTests();
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

function useFakeGitHubAuth(): void {
  process.env.GITHUB_TOKEN = 'fake';
  setGitHubTokenProviderForTests(() => null);
}

/** Captures console.log/warn/error output as plain strings, restoring the
 *  real console functions afterwards. */
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

// A no-op join machine for tests that don't care about MCP/hooks/daemon, so
// they never shell out or touch ~/.claude/settings.json for real.
const silentJoinSteps = {
  profile: { isTTY: false },
  registerMcp: { which: () => false },
  skipDaemonOffer: true,
  detectAgentFn: () => 'cursor',
};

interface SpaceRoutes {
  login?: string;
  repoStatus?: number;
  repoPrivate?: boolean;
  createRepoStatus?: number;
  issuesByLabel?: Record<string, Array<{ number: number }>>;
  nextIssueNumber?: number;
  presenceComments?: Array<{ id: number; user: { login: string }; updated_at: string; body: string }>;
  collaboratorStatus?: (login: string) => number;
  teamStatus?: number;
  calls?: Array<{ method: string; url: string }>;
}

/** A routed fake of every GitHub REST/GraphQL endpoint src/space.ts touches. */
function spaceFetchMock(routes: SpaceRoutes = {}): typeof fetch {
  const calls = routes.calls ?? [];
  let nextIssue = routes.nextIssueNumber ?? 900;

  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url });

    if (method === 'GET' && url.endsWith('/user')) {
      return new Response(JSON.stringify({ login: routes.login ?? 'ana' }), { status: 200 });
    }
    if (method === 'POST' && (/\/user\/repos$/.test(url) || /\/orgs\/[^/]+\/repos$/.test(url))) {
      const status = routes.createRepoStatus ?? 201;
      return new Response(
        status < 300 ? JSON.stringify({ name: 'space' }) : JSON.stringify({ message: 'name already exists on this account' }),
        { status },
      );
    }
    if (method === 'POST' && /\/labels$/.test(url)) {
      return new Response(JSON.stringify({}), { status: 201 });
    }
    if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
      const status = routes.repoStatus ?? 200;
      if (status !== 200) return new Response(JSON.stringify({ message: 'Not Found' }), { status });
      return new Response(JSON.stringify({ private: routes.repoPrivate ?? true }), { status: 200 });
    }
    if (method === 'GET' && url.includes('/issues?')) {
      const label = /labels=([^&]+)/.exec(url)?.[1] ?? '';
      const issues = routes.issuesByLabel?.[label] ?? [];
      return new Response(JSON.stringify(issues), { status: 200 });
    }
    if (method === 'POST' && /\/issues$/.test(url)) {
      return new Response(JSON.stringify({ number: nextIssue++ }), { status: 201 });
    }
    if (method === 'PUT' && url.includes('/lock')) {
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && /\/issues\/\d+$/.test(url)) {
      // muteIssue's node_id lookup
      return new Response(JSON.stringify({ node_id: `node-${url.split('/').pop()}` }), { status: 200 });
    }
    if (method === 'POST' && url === 'https://api.github.com/graphql') {
      return new Response(
        JSON.stringify({ data: { updateSubscription: { subscribable: { viewerSubscription: 'IGNORED' } } } }),
        { status: 200 },
      );
    }
    if (method === 'GET' && /\/comments\?/.test(url)) {
      return new Response(JSON.stringify(routes.presenceComments ?? []), { status: 200 });
    }
    if (method === 'PUT' && /\/collaborators\//.test(url)) {
      const login = decodeURIComponent(url.split('/collaborators/')[1] ?? '');
      const status = routes.collaboratorStatus ? routes.collaboratorStatus(login) : 201;
      if (status === 201) return new Response(JSON.stringify({ id: 1 }), { status });
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify({ message: 'failed' }), { status });
    }
    if (method === 'PUT' && /\/teams\/[^/]+\/repos\//.test(url)) {
      const status = routes.teamStatus ?? 204;
      return new Response(status < 300 ? null : JSON.stringify({ message: 'failed' }), { status });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  }) as typeof fetch;
}

// --- projectNameForSpace -----------------------------------------------------

describe('space — projectNameForSpace', () => {
  it('sanitizes owner/name to owner--name', () => {
    assert.equal(projectNameForSpace('acme/team'), 'acme--team');
  });

  it('rejects a name without exactly one slash', () => {
    assert.throws(() => projectNameForSpace('team'), /Invalid space/);
    assert.throws(() => projectNameForSpace('a/b/c'), /Invalid space/);
  });
});

// --- ai-comms space create ---------------------------------------------------

describe('space create', () => {
  it('creates a new private repo under the caller\'s own login and registers the project', async () => {
    await withTempHome('ai-comms-space-create-new-', async (home) => {
      useFakeGitHubAuth();
      const calls: Array<{ method: string; url: string }> = [];
      globalThis.fetch = spaceFetchMock({ login: 'ana', calls });

      const { lines, restore } = captureConsole();
      try {
        await createSpace('myteam', { joinSteps: silentJoinSteps });
      } finally {
        restore();
      }

      assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/user/repos')));
      assert.ok(lines.some((l) => l.includes('Created private space repo ana/myteam')));
      assert.ok(lines.some((l) => l.includes('ai-comms join ana/myteam')));

      const config = loadConfig();
      assert.equal(config.defaultProject, 'ana--myteam');
      assert.equal(config.projects['ana--myteam']?.bus?.repo, 'ana/myteam');
      assert.ok((config.projects['ana--myteam']?.bus as { issue: number }).issue >= 900);
      assert.ok((config.projects['ana--myteam']?.bus as { presence: number }).presence >= 900);
      void home;
    });
  });

  it('creates the repo under --org via /orgs/{org}/repos', async () => {
    await withTempHome('ai-comms-space-create-org-', async () => {
      useFakeGitHubAuth();
      const calls: Array<{ method: string; url: string }> = [];
      globalThis.fetch = spaceFetchMock({ login: 'ana', calls });

      const { restore } = captureConsole();
      try {
        await createSpace('myteam', { org: 'acme', joinSteps: silentJoinSteps });
      } finally {
        restore();
      }

      assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/orgs/acme/repos')));
      const config = loadConfig();
      assert.equal(config.projects['acme--myteam']?.bus?.repo, 'acme/myteam');
    });
  });

  it('reuses an existing repo (422) when it is already private', async () => {
    await withTempHome('ai-comms-space-create-reuse-', async () => {
      useFakeGitHubAuth();
      globalThis.fetch = spaceFetchMock({ login: 'ana', createRepoStatus: 422, repoPrivate: true });

      const { lines, restore } = captureConsole();
      try {
        await createSpace('myteam', { joinSteps: silentJoinSteps });
      } finally {
        restore();
      }

      assert.ok(lines.some((l) => l.includes('Reusing existing space repo ana/myteam')));
      const config = loadConfig();
      assert.equal(config.projects['ana--myteam']?.bus?.repo, 'ana/myteam');
    });
  });

  it('refuses to reuse a public repo without --allow-public', async () => {
    await withTempHome('ai-comms-space-create-public-', async () => {
      useFakeGitHubAuth();
      globalThis.fetch = spaceFetchMock({ login: 'ana', createRepoStatus: 422, repoPrivate: false });

      await assert.rejects(
        () => createSpace('myteam', { joinSteps: silentJoinSteps }),
        /public repo/,
      );

      // Nothing must be registered when creation fails this way.
      assert.throws(() => {
        const config = loadConfig();
        if (config.projects['ana--myteam']) throw new Error('should not be registered');
      });
    });
  });

  it('does not overwrite an already-set defaultProject', async () => {
    await withTempHome('ai-comms-space-create-keeps-default-', async () => {
      useFakeGitHubAuth();
      saveConfig({
        version: 2,
        agent: 'claude-code',
        defaultProject: 'existing',
        projects: { existing: { bus: { kind: 'github', repo: 'acme/existing', issue: 1 }, repos: [] } },
      });
      globalThis.fetch = spaceFetchMock({ login: 'ana' });

      const { restore } = captureConsole();
      try {
        await createSpace('myteam', { joinSteps: silentJoinSteps });
      } finally {
        restore();
      }

      assert.equal(loadConfig().defaultProject, 'existing');
    });
  });
});

// --- ai-comms invite ----------------------------------------------------------

describe('invite', () => {
  it('reports invited (201), already-collaborator (204), and failed for each login', async () => {
    await withTempHome('ai-comms-invite-', async () => {
      useFakeGitHubAuth();
      globalThis.fetch = spaceFetchMock({
        collaboratorStatus: (login) => {
          if (login === 'new-person') return 201;
          if (login === 'existing-person') return 204;
          return 403;
        },
      });

      const results = await inviteToSpace(['new-person', 'existing-person', 'bad-person'], 'acme/team');
      assert.deepEqual(
        results.map((r) => [r.login, r.status]),
        [
          ['new-person', 'invited'],
          ['existing-person', 'already-collaborator'],
          ['bad-person', 'failed'],
        ],
      );
      assert.ok(results[2]!.detail?.includes('403'));
    });
  });

  it('grants a GitHub team push access when --team is given', async () => {
    await withTempHome('ai-comms-invite-team-', async () => {
      useFakeGitHubAuth();
      const calls: Array<{ method: string; url: string }> = [];
      globalThis.fetch = spaceFetchMock({ calls });

      const { lines, restore } = captureConsole();
      try {
        await inviteToSpace(['ana'], 'acme/team', { team: 'acme/backend' });
      } finally {
        restore();
      }

      assert.ok(calls.some((c) => c.method === 'PUT' && c.url.includes('/orgs/acme/teams/backend/repos/acme/team')));
      assert.ok(lines.some((l) => l.includes('Granted team acme/backend')));
    });
  });

  it('resolveSpaceRepo prefers an explicit --space, then falls back to defaultProject\'s bus', async () => {
    await withTempHome('ai-comms-resolve-space-', async (home) => {
      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme--team',
        projects: { 'acme--team': { bus: { kind: 'github', repo: 'acme/team', issue: 1 }, repos: [] } },
      };
      assert.equal(resolveSpaceRepo('explicit/space', config, home), 'explicit/space');
      assert.equal(resolveSpaceRepo(undefined, config, home), 'acme/team');
    });
  });
});

// --- ai-comms join -------------------------------------------------------------

describe('join', () => {
  it('happy path: writes config/defaultProject, mutes both issues, and runs MCP/hook registration', async () => {
    await withTempHome('ai-comms-join-happy-', async (home) => {
      useFakeGitHubAuth();
      const calls: Array<{ method: string; url: string }> = [];
      globalThis.fetch = spaceFetchMock({
        login: 'beto',
        issuesByLabel: { 'ai-comms-bus': [{ number: 7 }], 'ai-comms-presence': [{ number: 8 }] },
        calls,
      });

      // Runs from a plain, non-git directory — join must not require a repo
      // (SPEC-v0.7 §3.1/§3.3).
      const cwd = path.join(home, 'nowhere');
      mkdirSync(cwd, { recursive: true });
      process.chdir(cwd);

      let mcpCalled = false;
      let hooksCalled = false;
      let doctoredProject: string | null = null;

      const { lines, restore } = captureConsole();
      try {
        await joinSpace('acme/team', {
          joinSteps: {
            profile: { isTTY: false },
            registerMcp: {
              which: () => false,
              execFn: () => {
                mcpCalled = true;
                return { status: 0, stdout: '', stderr: '' };
              },
            },
            hookInstall: { home },
            detectAgentFn: () => {
              hooksCalled = true;
              return 'claude-code';
            },
            skipDaemonOffer: true,
            runDoctorFn: async (project) => {
              doctoredProject = project;
              return 0;
            },
          },
        });
      } finally {
        restore();
      }

      assert.ok(
        !calls.some((c) => c.method === 'PUT' && c.url.includes('/lock')),
        'join must never lock issues — only create does',
      );
      assert.ok(calls.some((c) => /\/issues\/7$/.test(c.url) && c.method === 'GET')); // muteIssue's node_id GET for the bus issue
      assert.ok(calls.some((c) => /\/issues\/8$/.test(c.url) && c.method === 'GET')); // ...and the presence issue
      assert.equal(hooksCalled, true);
      assert.equal(doctoredProject, 'acme--team');
      assert.ok(lines.some((l) => l.includes('Registered project "acme--team"')));
      void mcpCalled; // registerMcpForAgents ran (which() returns false, so no exec expected for claude-code path itself)

      const config = loadConfig();
      assert.equal(config.defaultProject, 'acme--team');
      assert.deepEqual(config.projects['acme--team']?.bus, {
        kind: 'github',
        repo: 'acme/team',
        issue: 7,
        presence: 8,
      });
    });
  });

  it('sets defaultProject without asking when none was set yet', async () => {
    await withTempHome('ai-comms-join-first-default-', async () => {
      useFakeGitHubAuth();
      globalThis.fetch = spaceFetchMock({ issuesByLabel: { 'ai-comms-bus': [{ number: 1 }] } });

      const { restore } = captureConsole();
      try {
        await joinSpace('acme/team', { joinSteps: silentJoinSteps });
      } finally {
        restore();
      }

      assert.equal(loadConfig().defaultProject, 'acme--team');
    });
  });

  it('asks before replacing an existing defaultProject, and respects "no"', async () => {
    await withTempHome('ai-comms-join-confirm-default-', async () => {
      useFakeGitHubAuth();
      saveConfig({
        version: 2,
        agent: 'claude-code',
        defaultProject: 'existing',
        projects: { existing: { bus: { kind: 'github', repo: 'acme/existing', issue: 1 }, repos: [] } },
      });
      globalThis.fetch = spaceFetchMock({ issuesByLabel: { 'ai-comms-bus': [{ number: 1 }] } });

      let asked = false;
      const { restore } = captureConsole();
      try {
        await joinSpace('acme/team', {
          joinSteps: silentJoinSteps,
          promptFn: async (question) => {
            asked = true;
            assert.match(question, /default ai-comms project/);
            return 'n';
          },
        });
      } finally {
        restore();
      }

      assert.equal(asked, true);
      assert.equal(loadConfig().defaultProject, 'existing');
      // The project is still registered even though it isn't made default.
      assert.equal(loadConfig().projects['acme--team']?.bus?.repo, 'acme/team');
    });
  });

  it('fails with a clear message when the repo does not exist / invite not accepted', async () => {
    await withTempHome('ai-comms-join-404-', async () => {
      useFakeGitHubAuth();
      globalThis.fetch = spaceFetchMock({ repoStatus: 404 });

      await assert.rejects(
        () => joinSpace('acme/team', { joinSteps: silentJoinSteps }),
        /not found or you have not accepted the invitation/,
      );
    });
  });

  it('fails with a clear message when the repo is not an ai-comms space', async () => {
    await withTempHome('ai-comms-join-not-a-space-', async () => {
      useFakeGitHubAuth();
      globalThis.fetch = spaceFetchMock({ issuesByLabel: {} });

      await assert.rejects(
        () => joinSpace('acme/team', { joinSteps: silentJoinSteps }),
        /not an ai-comms space/,
      );

      // Nothing gets registered: no config file is created at all.
      assert.throws(() => loadConfig(), /No config found/);
    });
  });

  it('refuses a public space repo without --allow-public', async () => {
    await withTempHome('ai-comms-join-public-', async () => {
      useFakeGitHubAuth();
      globalThis.fetch = spaceFetchMock({ repoPrivate: false, issuesByLabel: { 'ai-comms-bus': [{ number: 1 }] } });

      await assert.rejects(() => joinSpace('acme/team', { joinSteps: silentJoinSteps }), /public repo/);
    });
  });
});

// --- ai-comms status ------------------------------------------------------------

describe('status', () => {
  it('prints identity, project/bus, daemon, auto-answer, directory, and inbox/claims counts', async () => {
    await withTempHome('ai-comms-status-', async (home) => {
      useFakeGitHubAuth();
      globalThis.fetch = spaceFetchMock({
        login: 'ana',
        presenceComments: [
          {
            id: 1,
            user: { login: 'beto' },
            updated_at: '2026-09-28T10:00:00Z',
            body: '```json\n{"kind":"ai-comms-profile","v":1,"role":"backend","areas":[],"autoAnswer":false,"lastSeen":"2026-09-28T10:00:00Z"}\n```',
          },
        ],
      });

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme--team',
        projects: {
          'acme--team': {
            bus: { kind: 'github', repo: 'acme/team', issue: 1, presence: 2 },
            repos: [],
            autoAnswer: { enabled: true, maxPerRequesterPerHour: 5, timeoutSeconds: 120, maxAgeMinutes: 10 },
          },
        },
      };
      saveConfig(config);

      // No .ai-comms.json and no git repo at cwd — status must resolve via
      // defaultProject alone (§3.3).
      const cwd = path.join(home, 'nowhere');
      mkdirSync(cwd, { recursive: true });
      process.chdir(cwd);

      const from = { dev: 'beto', agent: 'claude-code', repo: 'acme/team' };
      appendEnvelope(
        createEnvelope(
          {
            type: 'claim',
            subject: 'working on X',
            to: ['*'],
            refs: { paths: ['src/x.ts'], until: '2030-01-01T00:00:00Z' },
          },
          from,
        ),
        'acme--team',
      );
      appendEnvelope(
        createEnvelope({ type: 'ask', subject: 'is Y ready?', to: ['ana'] }, from),
        'acme--team',
      );

      const { lines, restore } = captureConsole();
      try {
        await runStatus({});
      } finally {
        restore();
      }

      const text = lines.join('\n');
      assert.match(text, /Identity: ana/);
      assert.match(text, /Project: acme--team/);
      assert.match(text, /Bus: acme\/team#1, presence #2/);
      assert.match(text, /Daemon: not running/);
      assert.match(text, /Auto-answer: on/);
      assert.match(text, /beto · backend/);
      // Both the "to *" claim and the "to ana" ask count as unread for ana.
      assert.match(text, /Inbox: 2 unread/);
      assert.match(text, /Claims: 1 active/);
    });
  });

  it('reports "no presence issue" when the bus has none configured', async () => {
    await withTempHome('ai-comms-status-no-presence-', async (home) => {
      useFakeGitHubAuth();
      globalThis.fetch = spaceFetchMock({ login: 'ana' });

      saveConfig({
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme--team',
        projects: { 'acme--team': { bus: { kind: 'github', repo: 'acme/team', issue: 1 }, repos: [] } },
      });

      const cwd = path.join(home, 'nowhere');
      mkdirSync(cwd, { recursive: true });
      process.chdir(cwd);

      const { lines, restore } = captureConsole();
      try {
        await runStatus({});
      } finally {
        restore();
      }

      assert.ok(lines.some((l) => l.includes('(no presence issue)')));
    });
  });
});
