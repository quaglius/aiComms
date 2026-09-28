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

import { loadCodeowners, ownersForPaths, type CodeownersRule } from '../src/codeowners.js';
import {
  fetchProfiles,
  filePresenceCommentIdCache,
  isOnline,
  membersByRole,
  ONLINE_WINDOW_MS,
  renderDirectory,
  upsertOwnProfile,
  type MemberProfile,
  type PresenceCommentIdCache,
} from '../src/presence.js';
import { loadConfig, saveConfig, type ConfigV2 } from '../src/config.js';
import { resolveContext } from '../src/context.js';
import type { GitHubBusConfig } from '../src/transports/types.js';
import {
  deriveProjectRepos,
  resetDaemonCachesForTests,
  sendPresenceHeartbeat,
  type GitHubBinding,
} from '../src/daemon.js';
import { getDaemonLogPath } from '../src/store.js';
import { maybeUpdateProfile, runSetup } from '../src/setup.js';
import {
  resetGitHubAuthForTests,
  setGitHubTokenProviderForTests,
} from '../src/github-auth.js';
import { clearCollaboratorsCacheForTests } from '../src/collaborators.js';

// --- shared fixtures -------------------------------------------------------

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORIGINAL_CWD = process.cwd();

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('USERPROFILE', ORIGINAL_USERPROFILE);
  restoreEnvVar('GITHUB_TOKEN', ORIGINAL_GITHUB_TOKEN);
  process.chdir(ORIGINAL_CWD);
  resetDaemonCachesForTests();
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

function initGitRepoWithOrigin(dir: string, originUrl: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: dir });
}

interface RawComment {
  id: number;
  body: string;
  user: { login: string };
  updated_at: string;
}

function bodyOf(kind: 'ai-comms-profile', payload: Record<string, unknown>): string {
  return `presence\n\`\`\`json\n${JSON.stringify({ kind, ...payload })}\n\`\`\``;
}

/** A fake of the GitHub issue-comments endpoints presence.ts uses, keyed by
 *  page for GET, plus scripted POST/PATCH behavior. */
function commentsFetchMock(options: {
  pages?: RawComment[][];
  postId?: number;
  patchOk?: (id: number) => boolean;
  calls?: Array<{ method: string; url: string }>;
}): typeof fetch {
  const pages = options.pages ?? [[]];
  const calls = options.calls ?? [];
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url });

    if (method === 'GET' && /\/comments\?/.test(url)) {
      const pageMatch = /[?&]page=(\d+)/.exec(url);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      const body = pages[page - 1] ?? [];
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (method === 'POST' && /\/comments$/.test(url)) {
      return new Response(JSON.stringify({ id: options.postId ?? 500 }), { status: 201 });
    }
    const patchMatch = /\/comments\/(\d+)$/.exec(url);
    if (method === 'PATCH' && patchMatch) {
      const id = Number(patchMatch[1]);
      const ok = options.patchOk ? options.patchOk(id) : true;
      return new Response(
        ok ? JSON.stringify({ id }) : JSON.stringify({ message: 'Not Found' }),
        { status: ok ? 200 : 404 },
      );
    }
    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  }) as typeof fetch;
}

function memoryCache(initial: number | null = null): PresenceCommentIdCache & { sets: number[] } {
  let value = initial;
  const sets: number[] = [];
  return {
    get: () => value,
    set: (id: number) => {
      value = id;
      sets.push(id);
    },
    sets,
  };
}

const bus: GitHubBusConfig = { kind: 'github', repo: 'acme/api', issue: 1, presence: 55 };

// --- presence.ts: isOnline / membersByRole / renderDirectory ---------------

describe('presence — isOnline', () => {
  it('is online just inside the window', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const p: MemberProfile = {
      login: 'ana',
      areas: [],
      repos: [],
      autoAnswer: false,
      lastSeen: new Date(now - (ONLINE_WINDOW_MS - 1000)).toISOString(),
    };
    assert.equal(isOnline(p, now), true);
  });

  it('is offline once past the window', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const p: MemberProfile = {
      login: 'ana',
      areas: [],
      repos: [],
      autoAnswer: false,
      lastSeen: new Date(now - (ONLINE_WINDOW_MS + 1000)).toISOString(),
    };
    assert.equal(isOnline(p, now), false);
  });

  it('is offline with no lastSeen', () => {
    const p: MemberProfile = { login: 'ana', areas: [], repos: [], autoAnswer: false, lastSeen: null };
    assert.equal(isOnline(p), false);
  });
});

describe('presence — membersByRole', () => {
  const profiles: MemberProfile[] = [
    { login: 'ana', role: 'Backend', areas: [], repos: [], autoAnswer: false, lastSeen: null },
    { login: 'beto', role: 'infra/platform', areas: [], repos: [], autoAnswer: false, lastSeen: null },
    { login: 'caro', areas: [], repos: [], autoAnswer: false, lastSeen: null },
  ];

  it('matches case-insensitively as a substring', () => {
    assert.deepEqual(membersByRole(profiles, 'back').map((p) => p.login), ['ana']);
    assert.deepEqual(membersByRole(profiles, 'BACKEND').map((p) => p.login), ['ana']);
    assert.deepEqual(membersByRole(profiles, 'infra').map((p) => p.login), ['beto']);
  });

  it('skips members with no role', () => {
    assert.deepEqual(membersByRole(profiles, 'caro'), []);
  });
});

describe('presence — renderDirectory', () => {
  it('renders one line per member with the documented shape', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const profiles: MemberProfile[] = [
      {
        login: 'ana',
        role: 'arquitectura',
        areas: ['api/**'],
        repos: ['acme/api'],
        autoAnswer: true,
        lastSeen: new Date(now - 5 * 60_000).toISOString(),
      },
      { login: 'beto', areas: [], repos: [], autoAnswer: false, lastSeen: null },
    ];

    const lines = renderDirectory(profiles, now).split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'ana · arquitectura · api/** · online (last seen 5m ago) · auto-answer on');
    assert.equal(lines[1], 'beto · (no role) · (no areas) · offline (last seen never) · auto-answer off');
  });

  it('reports "(no profiles yet)" for an empty directory', () => {
    assert.equal(renderDirectory([]), '(no profiles yet)');
  });
});

// --- presence.ts: fetchProfiles ---------------------------------------------

describe('presence — fetchProfiles', () => {
  it('returns [] without any network call when bus.presence is undefined', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const noPresence: GitHubBusConfig = { kind: 'github', repo: 'acme/api', issue: 1 };
    const profiles = await fetchProfiles(noPresence, {
      token: 'x',
      fetchFn: commentsFetchMock({ calls }),
    });
    assert.deepEqual(profiles, []);
    assert.equal(calls.length, 0);
  });

  it('reads one profile per author from the ```json block', async () => {
    const comments: RawComment[] = [
      {
        id: 1,
        user: { login: 'ana' },
        updated_at: '2026-09-28T10:00:00Z',
        body: bodyOf('ai-comms-profile', {
          v: 1,
          role: 'arquitectura',
          areas: ['api/**'],
          repos: ['acme/api'],
          agent: 'claude-code',
          autoAnswer: true,
          lastSeen: '2026-09-28T11:55:00Z',
        }),
      },
      {
        id: 2,
        user: { login: 'beto' },
        updated_at: '2026-09-28T10:01:00Z',
        body: 'just chatting, not a profile comment',
      },
    ];

    const profiles = await fetchProfiles(bus, {
      token: 'x',
      fetchFn: commentsFetchMock({ pages: [comments] }),
    });

    assert.equal(profiles.length, 1);
    assert.deepEqual(profiles[0], {
      login: 'ana',
      role: 'arquitectura',
      areas: ['api/**'],
      repos: ['acme/api'],
      agent: 'claude-code',
      autoAnswer: true,
      lastSeen: '2026-09-28T11:55:00Z',
    });
  });

  it('the most recently updated comment wins when an author has more than one', async () => {
    const comments: RawComment[] = [
      {
        id: 1,
        user: { login: 'ana' },
        updated_at: '2026-09-28T09:00:00Z',
        body: bodyOf('ai-comms-profile', { role: 'old-role', autoAnswer: false }),
      },
      {
        id: 2,
        user: { login: 'ana' },
        updated_at: '2026-09-28T10:00:00Z',
        body: bodyOf('ai-comms-profile', { role: 'new-role', autoAnswer: true }),
      },
    ];

    const profiles = await fetchProfiles(bus, {
      token: 'x',
      fetchFn: commentsFetchMock({ pages: [comments] }),
    });

    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]!.role, 'new-role');
    assert.equal(profiles[0]!.autoAnswer, true);
  });

  it('paginates past the first 100 comments', async () => {
    const page1: RawComment[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      user: { login: `filler-${i}` },
      updated_at: '2026-09-28T09:00:00Z',
      body: 'no profile here',
    }));
    const page2: RawComment[] = [
      {
        id: 101,
        user: { login: 'caro' },
        updated_at: '2026-09-28T09:00:00Z',
        body: bodyOf('ai-comms-profile', { role: 'infra', autoAnswer: false }),
      },
    ];

    const profiles = await fetchProfiles(bus, {
      token: 'x',
      fetchFn: commentsFetchMock({ pages: [page1, page2] }),
    });

    assert.deepEqual(profiles.map((p) => p.login), ['caro']);
  });

  it('honors isAllowedAuthor when given', async () => {
    const comments: RawComment[] = [
      {
        id: 1,
        user: { login: 'stranger' },
        updated_at: '2026-09-28T09:00:00Z',
        body: bodyOf('ai-comms-profile', { role: 'infra', autoAnswer: false }),
      },
    ];

    const profiles = await fetchProfiles(bus, {
      token: 'x',
      fetchFn: commentsFetchMock({ pages: [comments] }),
      isAllowedAuthor: (login) => login !== 'stranger',
    });

    assert.deepEqual(profiles, []);
  });
});

// --- presence.ts: upsertOwnProfile ------------------------------------------

describe('presence — upsertOwnProfile', () => {
  const ownProfile: Omit<MemberProfile, 'login'> = {
    role: 'backend',
    areas: ['src/**'],
    repos: ['acme/api'],
    agent: 'claude-code',
    autoAnswer: true,
    lastSeen: '2026-09-28T12:00:00Z',
  };

  it('throws when the bus has no presence issue configured', async () => {
    const noPresence: GitHubBusConfig = { kind: 'github', repo: 'acme/api', issue: 1 };
    await assert.rejects(() => upsertOwnProfile(noPresence, 'ana', ownProfile, { token: 'x' }));
  });

  it('PATCHes the cached comment id directly, without scanning first', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const cache = memoryCache(42);
    await upsertOwnProfile(bus, 'ana', ownProfile, {
      token: 'x',
      fetchFn: commentsFetchMock({ calls }),
      commentIdCache: cache,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'PATCH');
    assert.ok(calls[0]!.url.endsWith('/issues/comments/42'));
  });

  it('finds our own comment by author and PATCHes it when nothing is cached', async () => {
    const comments: RawComment[] = [
      {
        id: 7,
        user: { login: 'someone-else' },
        updated_at: '2026-09-28T09:00:00Z',
        body: bodyOf('ai-comms-profile', { role: 'x', autoAnswer: false }),
      },
      {
        id: 9,
        user: { login: 'ana' },
        updated_at: '2026-09-28T09:00:00Z',
        body: bodyOf('ai-comms-profile', { role: 'old', autoAnswer: false }),
      },
    ];
    const calls: Array<{ method: string; url: string }> = [];
    const cache = memoryCache(null);

    await upsertOwnProfile(bus, 'ana', ownProfile, {
      token: 'x',
      fetchFn: commentsFetchMock({ pages: [comments], calls }),
      commentIdCache: cache,
    });

    assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/issues/comments/9')));
    assert.deepEqual(cache.sets, [9]);
  });

  it('posts a new comment when nothing is cached or found', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const cache = memoryCache(null);

    await upsertOwnProfile(bus, 'ana', ownProfile, {
      token: 'x',
      fetchFn: commentsFetchMock({ pages: [[]], postId: 123, calls }),
      commentIdCache: cache,
    });

    assert.ok(calls.some((c) => c.method === 'POST'));
    assert.deepEqual(cache.sets, [123]);
  });

  it('falls back to scanning/creating when the cached id 404s (comment was deleted)', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const cache = memoryCache(999);

    await upsertOwnProfile(bus, 'ana', ownProfile, {
      token: 'x',
      fetchFn: commentsFetchMock({ pages: [[]], postId: 321, patchOk: (id) => id !== 999, calls }),
      commentIdCache: cache,
    });

    assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/999')));
    assert.ok(calls.some((c) => c.method === 'POST'));
    assert.deepEqual(cache.sets, [321]);
  });

  it('the posted/patched body carries a short human line and a compact json block', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let sentBody = '';
    const fetchFn: typeof fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push({ method, url });
      if (method === 'GET') return new Response(JSON.stringify([]), { status: 200 });
      if (method === 'POST') {
        sentBody = JSON.parse(init.body as string).body;
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      throw new Error('unexpected');
    }) as typeof fetch;

    await upsertOwnProfile(bus, 'ana', ownProfile, { token: 'x', fetchFn });

    assert.match(sentBody, /^ai-comms presence/);
    assert.match(sentBody, /```json\n\{.*\}\n```$/s);
    const jsonMatch = /```json\n([\s\S]*?)\n```/.exec(sentBody)!;
    const payload = JSON.parse(jsonMatch[1]!);
    assert.equal(payload.kind, 'ai-comms-profile');
    assert.equal(payload.role, 'backend');
    assert.deepEqual(payload.areas, ['src/**']);
    assert.equal(payload.autoAnswer, true);
  });
});

describe('presence — filePresenceCommentIdCache', () => {
  it('round-trips through ~/.ai-comms/projects/<p>/presence.json', async () => {
    await withTempHome('ai-comms-presence-cache-', async (home) => {
      const cache = filePresenceCommentIdCache('acme');
      assert.equal(cache.get(), null);

      cache.set(77);
      assert.equal(cache.get(), 77);

      const raw = JSON.parse(
        readFileSync(path.join(home, '.ai-comms', 'projects', 'acme', 'presence.json'), 'utf8'),
      );
      assert.equal(raw.commentId, 77);
    });
  });

  it('treats a missing or corrupt file as no cached id', async () => {
    await withTempHome('ai-comms-presence-cache-bad-', async (home) => {
      const dir = path.join(home, '.ai-comms', 'projects', 'acme');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'presence.json'), 'not json', 'utf8');
      const cache = filePresenceCommentIdCache('acme');
      assert.equal(cache.get(), null);
    });
  });
});

// --- codeowners.ts -----------------------------------------------------------

describe('codeowners — loadCodeowners', () => {
  function makeRepo(prefix: string): string {
    return mkdtempSync(path.join(tmpdir(), prefix));
  }

  it('returns null when no CODEOWNERS file exists anywhere it looks', () => {
    const repo = makeRepo('ai-comms-codeowners-none-');
    try {
      assert.equal(loadCodeowners(repo), null);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('prefers .github/CODEOWNERS over the root and docs/ copies', () => {
    const repo = makeRepo('ai-comms-codeowners-order-');
    try {
      mkdirSync(path.join(repo, '.github'), { recursive: true });
      mkdirSync(path.join(repo, 'docs'), { recursive: true });
      writeFileSync(path.join(repo, '.github', 'CODEOWNERS'), '* @from-github\n', 'utf8');
      writeFileSync(path.join(repo, 'CODEOWNERS'), '* @from-root\n', 'utf8');
      writeFileSync(path.join(repo, 'docs', 'CODEOWNERS'), '* @from-docs\n', 'utf8');

      const rules = loadCodeowners(repo);
      assert.deepEqual(rules, [{ pattern: '*', owners: ['from-github'] }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('falls back to docs/CODEOWNERS when the others are absent', () => {
    const repo = makeRepo('ai-comms-codeowners-docs-');
    try {
      mkdirSync(path.join(repo, 'docs'), { recursive: true });
      writeFileSync(path.join(repo, 'docs', 'CODEOWNERS'), '/src/ @doc-owner\n', 'utf8');
      assert.deepEqual(loadCodeowners(repo), [{ pattern: '/src/', owners: ['doc-owner'] }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ignores comments/blank lines, teams, and emails; keeps @logins without the @', () => {
    const repo = makeRepo('ai-comms-codeowners-parse-');
    try {
      writeFileSync(
        path.join(repo, 'CODEOWNERS'),
        [
          '# top-level comment',
          '',
          '/src/api/ @ana @acme/backend-team someone@example.com',
          '',
        ].join('\n'),
        'utf8',
      );
      assert.deepEqual(loadCodeowners(repo), [{ pattern: '/src/api/', owners: ['ana'] }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('codeowners — ownersForPaths', () => {
  it('the last matching rule wins for a given path (GitHub semantics)', () => {
    const rules: CodeownersRule[] = [
      { pattern: '*', owners: ['default-owner'] },
      { pattern: '/src/api/', owners: ['api-owner'] },
      { pattern: '/src/api/legacy/', owners: ['legacy-owner'] },
    ];
    assert.deepEqual(ownersForPaths(rules, ['src/api/legacy/old.ts']), ['legacy-owner']);
    assert.deepEqual(ownersForPaths(rules, ['src/api/handler.ts']), ['api-owner']);
    assert.deepEqual(ownersForPaths(rules, ['README.md']), ['default-owner']);
  });

  it('a leading slash anchors to the repo root', () => {
    const rules: CodeownersRule[] = [{ pattern: '/build/', owners: ['build-owner'] }];
    assert.deepEqual(ownersForPaths(rules, ['build/output.js']), ['build-owner']);
    // nested "build/" elsewhere in the tree must NOT match an anchored rule
    assert.deepEqual(ownersForPaths(rules, ['src/build/output.js']), []);
  });

  it('a pattern without any slash matches at any depth', () => {
    const rules: CodeownersRule[] = [{ pattern: '*.md', owners: ['docs-owner'] }];
    assert.deepEqual(ownersForPaths(rules, ['README.md']), ['docs-owner']);
    assert.deepEqual(ownersForPaths(rules, ['docs/guide/README.md']), ['docs-owner']);
  });

  it('accepts a query that is itself a glob and overlaps a narrower rule', () => {
    const rules: CodeownersRule[] = [{ pattern: '/src/api/handler.ts', owners: ['handler-owner'] }];
    assert.deepEqual(ownersForPaths(rules, ['src/api/**']), ['handler-owner']);
  });

  it('accepts a query glob matching a broader directory rule', () => {
    const rules: CodeownersRule[] = [{ pattern: '/src/', owners: ['src-owner'] }];
    assert.deepEqual(ownersForPaths(rules, ['src/api/**']), ['src-owner']);
  });

  it('unions owners across several query paths and dedupes', () => {
    const rules: CodeownersRule[] = [
      { pattern: '/src/api/', owners: ['api-owner'] },
      { pattern: '/docs/adr/', owners: ['api-owner', 'arch-owner'] },
    ];
    assert.deepEqual(
      [...ownersForPaths(rules, ['src/api/x.ts', 'docs/adr/0001.md'])].sort(),
      ['api-owner', 'arch-owner'],
    );
  });

  it('returns [] when nothing matches', () => {
    const rules: CodeownersRule[] = [{ pattern: '/src/api/', owners: ['api-owner'] }];
    assert.deepEqual(ownersForPaths(rules, ['docs/readme.md']), []);
  });
});

// --- config.ts / context.ts: presence + profile schema, merge, fallback -----

describe('config — schema accepts presence and profile', () => {
  it('ConfigV2Schema accepts a GitHub bus with presence and a root profile', async () => {
    await withTempHome('ai-comms-schema-config-', async () => {
      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        profile: { role: 'backend', areas: ['src/**'] },
        projects: {
          acme: {
            bus: { kind: 'github', repo: 'acme/api', issue: 1, presence: 2 },
            repos: [],
          },
        },
      };
      saveConfig(config);
      const reloaded = loadConfig();
      assert.equal(reloaded.projects.acme!.bus!.presence, 2);
      assert.deepEqual(reloaded.profile, { role: 'backend', areas: ['src/**'] });
    });
  });
});

describe('context — presence merges from user config when the repo file lacks it', () => {
  it('fills bus.presence from ~/.ai-comms/config.json when it matches repo/issue', async () => {
    await withTempHome('ai-comms-ctx-presence-', async (home) => {
      const repoDir = path.join(home, 'repo');
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(
        path.join(repoDir, '.ai-comms.json'),
        JSON.stringify({
          project: 'acme',
          repo: 'api',
          bus: { kind: 'github', repo: 'acme/api', issue: 42 },
        }) + '\n',
        'utf8',
      );

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {
          acme: {
            bus: { kind: 'github', repo: 'acme/api', issue: 42, presence: 99 },
            repos: [{ name: 'api', path: repoDir }],
          },
        },
      };

      const ctx = resolveContext(repoDir, config);
      assert.equal(ctx.source, 'repo');
      assert.ok(ctx.bus.kind === 'github');
      assert.equal((ctx.bus as GitHubBusConfig).presence, 99);
    });
  });

  it('does not merge presence when the user config bus points at a different issue', async () => {
    await withTempHome('ai-comms-ctx-presence-mismatch-', async (home) => {
      const repoDir = path.join(home, 'repo');
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(
        path.join(repoDir, '.ai-comms.json'),
        JSON.stringify({
          project: 'acme',
          repo: 'api',
          bus: { kind: 'github', repo: 'acme/api', issue: 42 },
        }) + '\n',
        'utf8',
      );

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {
          acme: {
            bus: { kind: 'github', repo: 'acme/api', issue: 7, presence: 99 },
            repos: [],
          },
        },
      };

      const ctx = resolveContext(repoDir, config);
      assert.ok(ctx.bus.kind === 'github');
      assert.equal((ctx.bus as GitHubBusConfig).presence, undefined);
    });
  });
});

describe('context — §3.3 fallback with no .ai-comms.json anywhere', () => {
  it('uses defaultProject bus with repo derived from git origin', async () => {
    await withTempHome('ai-comms-ctx-fallback-git-', async (home) => {
      const repoDir = path.join(home, 'some-folder-name');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {
          acme: { bus: { kind: 'github', repo: 'acme/web', issue: 5 }, repos: [] },
        },
      };

      const ctx = resolveContext(repoDir, config);
      assert.equal(ctx.project, 'acme');
      assert.equal(ctx.repo, 'web', 'repo must come from origin, not the folder name');
      assert.equal(ctx.source, 'user-config');
      assert.ok(ctx.bus.kind === 'github');
      assert.equal((ctx.bus as GitHubBusConfig).issue, 5);
    });
  });

  it('falls back to the cwd basename when there is no git repo at all', async () => {
    await withTempHome('ai-comms-ctx-fallback-nogit-', async (home) => {
      const cwdDir = path.join(home, 'my-folder');
      mkdirSync(cwdDir, { recursive: true });

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {
          acme: { bus: { kind: 'github', repo: 'acme/web', issue: 5 }, repos: [] },
        },
      };

      const ctx = resolveContext(cwdDir, config);
      assert.equal(ctx.repo, 'my-folder');
      assert.equal(ctx.source, 'user-config');
    });
  });

  it('still throws the usual error when defaultProject has no bus', async () => {
    await withTempHome('ai-comms-ctx-fallback-none-', async (home) => {
      const cwdDir = path.join(home, 'my-folder');
      mkdirSync(cwdDir, { recursive: true });

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {},
      };

      assert.throws(() => resolveContext(cwdDir, config), /Could not resolve project\/repo context/);
    });
  });
});

// --- daemon.ts: deriveProjectRepos / sendPresenceHeartbeat ------------------

describe('daemon — deriveProjectRepos', () => {
  it('derives owner/repo from each registered repo path\'s git origin', async () => {
    await withTempHome('ai-comms-derive-repos-', async (home) => {
      const repoA = path.join(home, 'a');
      const repoB = path.join(home, 'b');
      initGitRepoWithOrigin(repoA, 'git@github.com:acme/api.git');
      initGitRepoWithOrigin(repoB, 'git@github.com:acme/web.git');

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {
          acme: {
            bus: { kind: 'github', repo: 'acme/api', issue: 1 },
            repos: [
              { name: 'api', path: repoA },
              { name: 'web', path: repoB },
            ],
          },
        },
      };
      const binding: GitHubBinding = {
        project: 'acme',
        bus: { kind: 'github', repo: 'acme/api', issue: 1 },
        repoPath: repoA,
      };

      assert.deepEqual(
        [...deriveProjectRepos('acme', config, binding)].sort(),
        ['acme/api', 'acme/web'],
      );
    });
  });

  it('falls back to bus.repo when no registered path is derivable', async () => {
    await withTempHome('ai-comms-derive-repos-fallback-', async (home) => {
      const notGit = path.join(home, 'not-a-repo');
      mkdirSync(notGit, { recursive: true });

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {
          acme: {
            bus: { kind: 'github', repo: 'acme/api', issue: 1 },
            repos: [{ name: 'x', path: notGit }],
          },
        },
      };
      const binding: GitHubBinding = {
        project: 'acme',
        bus: { kind: 'github', repo: 'acme/api', issue: 1 },
        repoPath: notGit,
      };

      assert.deepEqual(deriveProjectRepos('acme', config, binding), ['acme/api']);
    });
  });
});

describe('daemon — sendPresenceHeartbeat', () => {
  it('does nothing (no network call) when the bus has no presence issue', async () => {
    await withTempHome('ai-comms-heartbeat-none-', async (home) => {
      useFakeGitHubAuth();
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        throw new Error('should not be called');
      }) as typeof fetch;

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: { acme: { bus: { kind: 'github', repo: 'acme/api', issue: 1 }, repos: [] } },
      };
      const binding: GitHubBinding = {
        project: 'acme',
        bus: { kind: 'github', repo: 'acme/api', issue: 1 },
        repoPath: home,
      };

      await sendPresenceHeartbeat(binding, config, false);
      assert.equal(called, false);
    });
  });

  it('publishes role/areas/agent/autoAnswer/lastSeen for our authenticated login', async () => {
    await withTempHome('ai-comms-heartbeat-ok-', async (home) => {
      useFakeGitHubAuth();

      let postedBody: Record<string, unknown> | null = null;
      globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init.method ?? 'GET').toUpperCase();
        if (method === 'GET' && url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'ana' }), { status: 200 });
        }
        if (method === 'GET' && /\/comments\?/.test(url)) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (method === 'POST' && /\/comments$/.test(url)) {
          postedBody = JSON.parse((init.body as string) ?? '{}');
          return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }) as typeof fetch;

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        profile: { role: 'backend', areas: ['src/**'] },
        projects: {
          acme: {
            bus: { kind: 'github', repo: 'acme/api', issue: 1, presence: 9 },
            // Exactly one registered repo, so daemon.ts's advertisedAutoAnswer
            // (v0.7 fixes review finding #4) can resolve a repo path and
            // actually advertise autoAnswer: true below — an empty `repos`
            // has no path an auto-answer could run from, so it would (rightly)
            // advertise false regardless of `autoAnswer.enabled`.
            // A real directory that is not the home itself: the answerer refuses
            // to run with $HOME as its repo.
            repos: [{ name: 'api', path: mkdtempSync(path.join(home, 'repo-')) }],
            autoAnswer: { enabled: true, maxPerRequesterPerHour: 5, timeoutSeconds: 120, maxAgeMinutes: 10 },
          },
        },
      };
      const binding: GitHubBinding = {
        project: 'acme',
        bus: { kind: 'github', repo: 'acme/api', issue: 1, presence: 9 },
        repoPath: home,
      };

      await sendPresenceHeartbeat(binding, config, false);

      assert.ok(postedBody);
      const bodyText = (postedBody as { body: string }).body;
      const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(bodyText)![1]!);
      assert.equal(payload.role, 'backend');
      assert.deepEqual(payload.areas, ['src/**']);
      assert.equal(payload.agent, 'claude-code');
      assert.equal(payload.autoAnswer, true);
      assert.ok(payload.lastSeen);
    });
  });

  it('never throws — a fetch failure is logged, not fatal', async () => {
    await withTempHome('ai-comms-heartbeat-fail-', async (home) => {
      useFakeGitHubAuth();
      // whoami() succeeds (so we get past identity resolution), but every
      // presence-issue call fails — this exercises upsertOwnProfile's error
      // path inside sendPresenceHeartbeat's try/catch, not the whoami one.
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'ana' }), { status: 200 });
        }
        return new Response('boom', { status: 500 });
      }) as typeof fetch;

      const config: ConfigV2 = {
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {
          acme: { bus: { kind: 'github', repo: 'acme/api', issue: 1, presence: 9 }, repos: [] },
        },
      };
      const binding: GitHubBinding = {
        project: 'acme',
        bus: { kind: 'github', repo: 'acme/api', issue: 1, presence: 9 },
        repoPath: home,
      };

      await sendPresenceHeartbeat(binding, config, false);

      const log = readFileSync(getDaemonLogPath('acme'), 'utf8');
      assert.match(log, /presence heartbeat failed/);
    });
  });
});

// --- setup.ts: presence issue + profile questions ---------------------------

/** A CODEOWNERS-style label-aware mock: unlike the plain routers used in
 *  phase0-setup.test.ts, this filters `/issues?labels=` by the actual label
 *  so the bus and presence issues resolve independently, the way real
 *  GitHub does. */
function labelAwareMockGithubFetch(routes: {
  repoPrivate?: boolean;
  issuesByLabel?: Record<string, Array<{ number: number }>>;
  nextCreatedIssueNumber?: number;
  collaborators?: string[];
  calls?: Array<{ method: string; url: string }>;
}): typeof fetch {
  const calls = routes.calls ?? [];
  let nextId = routes.nextCreatedIssueNumber ?? 900;
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url });

    if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ private: routes.repoPrivate ?? true }), { status: 200 });
    }
    if (method === 'GET' && url.includes('/issues?')) {
      const label = /labels=([^&]+)/.exec(url)?.[1] ?? '';
      const issues = routes.issuesByLabel?.[label] ?? [];
      return new Response(JSON.stringify(issues), { status: 200 });
    }
    if (method === 'POST' && /\/issues$/.test(url)) {
      const id = nextId++;
      return new Response(JSON.stringify({ number: id }), { status: 201 });
    }
    if (method === 'PUT' && url.includes('/lock')) {
      return new Response(null, { status: 204 });
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

describe('setup — presence issue (fresh repo, label-aware)', () => {
  it('finds/creates the presence issue independently of the bus issue and writes both to .ai-comms.json', async () => {
    await withTempHome('ai-comms-presence-setup-fresh-', async (home) => {
      useFakeGitHubAuth();
      const repoDir = path.join(home, 'repo');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');

      const calls: Array<{ method: string; url: string }> = [];
      globalThis.fetch = labelAwareMockGithubFetch({
        repoPrivate: true,
        issuesByLabel: { 'ai-comms-bus': [{ number: 7 }] }, // presence label -> none -> created
        collaborators: [],
        calls,
      });

      process.chdir(repoDir);
      await runSetup({ skipDaemonOffer: true });

      const written = JSON.parse(readFileSync(path.join(repoDir, '.ai-comms.json'), 'utf8'));
      assert.equal(written.bus.issue, 7);
      assert.notEqual(written.bus.presence, written.bus.issue, 'bus and presence must be distinct issues');
      assert.ok(written.bus.presence >= 900);

      assert.ok(calls.some((c) => c.method === 'PUT' && c.url.includes(`/issues/${written.bus.presence}/lock`)));

      // project defaults to the repo name ("web") derived from `origin` when
      // --project isn't given.
      const userConfig = JSON.parse(readFileSync(path.join(home, '.ai-comms', 'config.json'), 'utf8'));
      assert.equal(userConfig.projects.web.bus.presence, written.bus.presence);
    });
  });
});

describe('setup — presence issue (existing committed file without presence)', () => {
  it('stores presence only in user config, never rewriting the committed file', async () => {
    await withTempHome('ai-comms-presence-setup-reuse-', async (home) => {
      useFakeGitHubAuth();
      const repoDir = path.join(home, 'repo');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');

      const committed = {
        project: 'acme',
        repo: 'web',
        bus: { kind: 'github', repo: 'acme/api', issue: 42 },
      };
      const committedContent = JSON.stringify(committed, null, 2) + '\n';
      writeFileSync(path.join(repoDir, '.ai-comms.json'), committedContent, 'utf8');

      globalThis.fetch = labelAwareMockGithubFetch({
        issuesByLabel: { 'ai-comms-presence': [{ number: 314 }] },
        collaborators: [],
      });

      process.chdir(repoDir);
      await runSetup({ skipDaemonOffer: true });

      const after = readFileSync(path.join(repoDir, '.ai-comms.json'), 'utf8');
      assert.equal(after, committedContent, '.ai-comms.json must not be rewritten');

      const userConfig = JSON.parse(readFileSync(path.join(home, '.ai-comms', 'config.json'), 'utf8'));
      assert.equal(userConfig.projects.acme.bus.presence, 314);
    });
  });

  it('reuses presence straight from the committed file without any lookup when already present', async () => {
    await withTempHome('ai-comms-presence-setup-already-', async (home) => {
      useFakeGitHubAuth();
      const repoDir = path.join(home, 'repo');
      initGitRepoWithOrigin(repoDir, 'git@github.com:acme/web.git');

      const committed = {
        project: 'acme',
        repo: 'web',
        bus: { kind: 'github', repo: 'acme/api', issue: 42, presence: 55 },
      };
      writeFileSync(path.join(repoDir, '.ai-comms.json'), JSON.stringify(committed, null, 2) + '\n', 'utf8');

      const calls: Array<{ method: string; url: string }> = [];
      globalThis.fetch = labelAwareMockGithubFetch({ collaborators: [], calls });

      process.chdir(repoDir);
      await runSetup({ skipDaemonOffer: true });

      assert.ok(
        calls.every((c) => c.url.includes('/collaborators')),
        `expected no presence-issue lookup when already known, got: ${JSON.stringify(calls)}`,
      );

      const userConfig = JSON.parse(readFileSync(path.join(home, '.ai-comms', 'config.json'), 'utf8'));
      assert.equal(userConfig.projects.acme.bus.presence, 55);
    });
  });
});

describe('setup — maybeUpdateProfile', () => {
  it('is skipped entirely when stdin is not a TTY', async () => {
    await withTempHome('ai-comms-profile-notty-', async () => {
      saveConfig({ version: 2, agent: 'claude-code', defaultProject: 'acme', projects: {} });
      let promptCalls = 0;
      await maybeUpdateProfile({
        isTTY: false,
        promptFn: async () => {
          promptCalls++;
          return '';
        },
      });
      assert.equal(promptCalls, 0);
      assert.equal(loadConfig().profile, undefined);
    });
  });

  it('saves role/areas from the answers when interactive', async () => {
    await withTempHome('ai-comms-profile-tty-', async () => {
      saveConfig({ version: 2, agent: 'claude-code', defaultProject: 'acme', projects: {} });
      const answers = ['arquitectura', 'api/**, docs/adr/**'];
      await maybeUpdateProfile({
        isTTY: true,
        promptFn: async () => answers.shift() ?? '',
      });
      const config = loadConfig();
      assert.equal(config.profile?.role, 'arquitectura');
      assert.deepEqual(config.profile?.areas, ['api/**', 'docs/adr/**']);
    });
  });

  it('keeps the existing profile as the default when the answers echo it back (Enter-skip)', async () => {
    await withTempHome('ai-comms-profile-tty-keep-', async () => {
      saveConfig({
        version: 2,
        agent: 'claude-code',
        defaultProject: 'acme',
        projects: {},
        profile: { role: 'infra', areas: ['ops/**'] },
      });

      const seenDefaults: (string | undefined)[] = [];
      await maybeUpdateProfile({
        isTTY: true,
        promptFn: async (_q, def) => {
          seenDefaults.push(def);
          return def ?? '';
        },
      });

      assert.deepEqual(seenDefaults, ['infra', 'ops/**']);
      const config = loadConfig();
      assert.equal(config.profile?.role, 'infra');
      assert.deepEqual(config.profile?.areas, ['ops/**']);
    });
  });
});
