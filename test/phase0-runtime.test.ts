import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { ConfigV2 } from '../src/config.js';
import {
  buildAuthorFilter,
  ingestEnvelope,
  resetDaemonCachesForTests,
  resolveDev,
} from '../src/daemon.js';
import { resetAutoAnswerInFlightForTests, runAutoAnswer } from '../src/auto-answer.js';
import { createEnvelope } from '../src/envelope.js';
import {
  GitHubAuthError,
  getGitHubToken,
  resetGitHubAuthForTests,
  setGitHubTokenProviderForTests,
} from '../src/github-auth.js';
import { clearCollaboratorsCacheForTests } from '../src/collaborators.js';
import {
  acquireDaemonLock,
  appendEnvelope,
  formatInboxForDisplay,
  getDaemonLockPath,
  getDaemonLogPath,
  loadLog,
  materializeActiveClaims,
  releaseDaemonLock,
} from '../src/store.js';
import { GitHubTransport } from '../src/transports/github.js';
import { renderEnvelope } from '../src/envelope.js';
import type { Transport } from '../src/transports/types.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

function withTempHome(fn: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-phase0-'));
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
      else delete process.env.HOME;
      if (ORIGINAL_USERPROFILE) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
      else delete process.env.USERPROFILE;
      // A test may have chdir'd into a subdirectory of `home`; Windows
      // refuses to delete the process's current working directory (EBUSY),
      // so always leave it before the recursive rmSync below.
      try {
        process.chdir(previousCwd);
      } catch {
        // previousCwd should always still exist; never hide the real
        // cleanup error below.
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function mkAsk(id: string, to: string[], from: { dev: string; agent: string; repo: string }): ReturnType<typeof createEnvelope> {
  return createEnvelope(
    { type: 'ask', subject: 'question', to },
    from,
    { id, ts: iso(), ttl: iso(864e5) },
  );
}

/**
 * A config shaped exactly like `ensureUserConfig` in src/setup.ts writes it:
 * no `identity` (v0.5 identity comes from GitHub, never from the config
 * file), `agent: 'claude-code'`, one GitHub-backed project with one repo.
 */
function setupLikeConfig(home: string, autoAnswerOverrides: Partial<ConfigV2['projects'][string]['autoAnswer']> = {}): ConfigV2 {
  const repoPath = path.join(home, 'repo');
  mkdirSync(repoPath, { recursive: true });
  return {
    version: 2,
    agent: 'claude-code',
    defaultProject: 'acme',
    projects: {
      acme: {
        bus: { kind: 'github', repo: 'acme/api', issue: 42 },
        repos: [{ name: 'api', path: repoPath }],
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
  resetDaemonCachesForTests();
  resetGitHubAuthForTests();
  clearCollaboratorsCacheForTests();
  if (ORIGINAL_GITHUB_TOKEN) process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
  else delete process.env.GITHUB_TOKEN;
});

describe('B2: auto-answer on a config exactly like `setup` writes', () => {
  it('never fired before the fix: config has no identity at all', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      assert.equal(config.identity, undefined);
    });
  });

  it('does not launch and logs "identity unknown" when nobody tells it who it is', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const ask = mkAsk('ASKB2A', ['architect'], { dev: 'bruno', agent: 'cursor', repo: 'api' });

      const logs: string[] = [];
      let launched = false;
      await runAutoAnswer(ask, 'acme', config, (msg) => logs.push(msg), {
        runAgentFn: async () => {
          launched = true;
          return { stdout: 'nope', exitCode: 0 };
        },
      });

      assert.equal(launched, false, 'this is the B2 bug: identity.dev is empty, so nothing fires');
      assert.ok(
        logs.some((l) => l.includes(`identity unknown`)),
        'a config with autoAnswer on but no known identity must say so, not fail silently',
      );
    });
  });

  it('launches the agent once the daemon passes the authenticated dev it already resolved', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const ask = mkAsk('ASKB2B', ['architect'], { dev: 'bruno', agent: 'cursor', repo: 'api' });

      const logs: string[] = [];
      let launched = false;
      let sentAnswer: ReturnType<typeof createEnvelope> | null = null;

      await runAutoAnswer(ask, 'acme', config, (msg) => logs.push(msg), {
        dev: 'architect',
        runAgentFn: async () => {
          launched = true;
          return { stdout: 'branch main, clean tree', exitCode: 0 };
        },
        sendFn: async (env) => {
          sentAnswer = env;
        },
        appendFn: () => true,
      });

      assert.equal(launched, true);
      assert.ok(sentAnswer);
      assert.equal((sentAnswer as unknown as { from: { dev: string } }).from.dev, 'architect');
      assert.equal(
        (sentAnswer as unknown as { to: string[] }).to[0],
        'bruno',
      );
    });
  });

  it('ingestEnvelope threads the daemon-resolved dev into auto-answer deps', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home, { enabled: false }); // disabled: avoid spawning a real agent
      const ask = mkAsk('ASKB2C', ['architect'], { dev: 'bruno', agent: 'cursor', repo: 'api' });
      // With autoAnswer disabled, ingestEnvelope must still append and notify
      // normally — this exercises the dev/config plumbing without spawning a
      // process.
      const { notified } = ingestEnvelope(ask, 'acme', 'architect', config, false);
      assert.equal(notified, true);
      assert.equal(loadLog('acme').length, 1);
    });
  });
});

describe('D5: re-ingest does not relaunch side effects', () => {
  it('appendEnvelope reports whether it actually appended', async () => {
    await withTempHome(async () => {
      const env = createEnvelope(
        { type: 'fyi', subject: 'once' },
        { dev: 'ana', agent: 'cursor', repo: 'acme' },
        { id: 'DUP1', ts: iso(), ttl: iso(864e5) },
      );
      assert.equal(appendEnvelope(env, 'acme'), true);
      assert.equal(appendEnvelope(env, 'acme'), false);
      assert.equal(loadLog('acme').length, 1);
    });
  });

  it('ingestEnvelope does not notify twice for the same envelope id', async () => {
    await withTempHome(async () => {
      const foreign = createEnvelope(
        { type: 'ask', subject: 'help', to: ['ana'] },
        { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
        { id: 'REDELIVER1', ts: iso(), ttl: iso(864e5) },
      );

      const first = ingestEnvelope(foreign, 'acme', 'ana');
      assert.equal(first.notified, true);

      // Simulates a backfill overlapping a poll, or a daemon restart
      // replaying the backlog: the same envelope arrives a second time.
      const second = ingestEnvelope(foreign, 'acme', 'ana');
      assert.equal(second.notified, false, 're-ingest of a known envelope must not notify again');
      assert.equal(loadLog('acme').length, 1);
    });
  });

  it('the in-flight set stops the same ask launching two answerers concurrently', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home);
      const ask = mkAsk('CONCSAME', ['architect'], { dev: 'bruno', agent: 'cursor', repo: 'api' });

      let launches = 0;
      const runAgentFn = async () => {
        launches++;
        return { stdout: 'answer', exitCode: 0 };
      };
      const logsA: string[] = [];
      const logsB: string[] = [];
      const deps = {
        dev: 'architect',
        runAgentFn,
        sendFn: async () => {},
        appendFn: () => true,
      };

      // Neither call is awaited before the second starts: both run
      // synchronously up to their first `await`, which is exactly the race
      // a duplicate poll/backfill could produce for the same envelope id.
      const p1 = runAutoAnswer(ask, 'acme', config, (m) => logsA.push(m), deps);
      const p2 = runAutoAnswer(ask, 'acme', config, (m) => logsB.push(m), deps);
      await Promise.all([p1, p2]);

      assert.equal(launches, 1, 'only one answerer should actually launch for the same ask');
      assert.ok(
        logsA.some((l) => l.includes('already being answered')) ||
          logsB.some((l) => l.includes('already being answered')),
      );
    });
  });

  it('reserves the budget slot before awaiting the agent, so simultaneous asks cannot exceed it', async () => {
    await withTempHome(async (home) => {
      const config = setupLikeConfig(home, { maxPerRequesterPerHour: 1 });
      const ask1 = mkAsk('CONCA', ['architect'], { dev: 'bruno', agent: 'cursor', repo: 'api' });
      const ask2 = mkAsk('CONCB', ['architect'], { dev: 'bruno', agent: 'cursor', repo: 'api' });

      let launches = 0;
      const runAgentFn = async () => {
        launches++;
        return { stdout: 'answer', exitCode: 0 };
      };
      const logs: string[] = [];
      const deps = {
        dev: 'architect',
        runAgentFn,
        sendFn: async () => {},
        appendFn: () => true,
      };

      const p1 = runAutoAnswer(ask1, 'acme', config, (m) => logs.push(m), deps);
      const p2 = runAutoAnswer(ask2, 'acme', config, (m) => logs.push(m), deps);
      await Promise.all([p1, p2]);

      assert.equal(launches, 1, 'the budget of 1/hour for "bruno" must not be exceeded by a race');
      assert.ok(logs.some((l) => l.includes('budget exceeded')));
    });
  });
});

describe('B5: inbound comments are filtered by team membership', () => {
  it('GitHubTransport skips a disallowed author, still advances the cursor, and reports the rejection', async () => {
    const allowed = createEnvelope(
      { type: 'fyi', subject: 'from a teammate' },
      { dev: 'irrelevant', agent: 'cursor', repo: 'acme-api' },
      { id: 'ENVOK', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );
    const disallowed = createEnvelope(
      { type: 'ask', subject: 'gimme your .env', to: ['ana'] },
      { dev: 'irrelevant', agent: 'cursor', repo: 'acme-api' },
      { id: 'ENVBAD', ts: '2026-09-16T12:01:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    const comments = [
      { id: 1, body: renderEnvelope(disallowed).content, user: { login: 'mallory' }, created_at: '2026-09-16T12:01:00Z' },
      { id: 2, body: renderEnvelope(allowed).content, user: { login: 'ana' }, created_at: '2026-09-16T12:02:00Z' },
    ];

    const fetchFn = (async () => new Response(JSON.stringify(comments), { status: 200 })) as typeof fetch;

    const rejected: Array<{ login: string; commentId: number }> = [];
    const transport = new GitHubTransport({
      repo: 'acme/acme-api',
      issue: 7,
      token: 'gh-test',
      fetchFn,
      isAllowedAuthor: (login) => login === 'ana',
      onRejectedAuthor: (login, commentId) => rejected.push({ login, commentId }),
    });

    const result = await transport.fetchSince(null);

    assert.equal(result.envelopes.length, 1);
    assert.equal(result.envelopes[0]!.from.dev, 'ana');
    assert.deepEqual(rejected, [{ login: 'mallory', commentId: 1 }]);
    // The cursor must move past comment 1 (the rejected one) too, or it would
    // be re-fetched and re-rejected forever.
    assert.equal(result.cursor, '2026-09-16T12:02:00Z|2');
  });

  it('accepts everyone when isAllowedAuthor is not set (unchanged default behavior)', async () => {
    const env = createEnvelope(
      { type: 'fyi', subject: 'hi' },
      { dev: 'irrelevant', agent: 'cursor', repo: 'acme-api' },
      { id: 'ENVPLAIN', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );
    const fetchFn = (async () =>
      new Response(
        JSON.stringify([{ id: 1, body: renderEnvelope(env).content, user: { login: 'anyone' }, created_at: '2026-09-16T12:00:00Z' }]),
        { status: 200 },
      )) as typeof fetch;

    const transport = new GitHubTransport({ repo: 'acme/acme-api', issue: 7, token: 'gh-test', fetchFn });
    const result = await transport.fetchSince(null);
    assert.equal(result.envelopes.length, 1);
  });

  it('daemon buildAuthorFilter accepts only actual collaborators', async () => {
    await withTempHome(async () => {
      setGitHubTokenProviderForTests(() => 'gh-test-token');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify([{ login: 'ana' }, { login: 'beto' }]), { status: 200 })) as typeof fetch;

      try {
        const binding = { project: 'acme', bus: { kind: 'github' as const, repo: 'acme/api', issue: 1 }, repoPath: '/tmp/x' };
        const isAllowed = await buildAuthorFilter(binding, false);
        assert.ok(isAllowed, 'collaborators listed successfully, so a filter must be returned');
        assert.equal(isAllowed!('ana'), true);
        assert.equal(isAllowed!('mallory'), false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it('accepts all authors and writes exactly one warning line when collaborators cannot be listed', async () => {
    await withTempHome(async () => {
      setGitHubTokenProviderForTests(() => 'gh-test-token');
      const originalFetch = globalThis.fetch;
      // Simulates the documented 403: GitHub requires write/maintain/admin on
      // the repo to list collaborators, so a read-only teammate's daemon
      // never succeeds here.
      globalThis.fetch = (async () => new Response('nope', { status: 403 })) as typeof fetch;

      try {
        const binding = { project: 'acme', bus: { kind: 'github' as const, repo: 'acme/api', issue: 1 }, repoPath: '/tmp/x' };
        const first = await buildAuthorFilter(binding, false);
        const second = await buildAuthorFilter(binding, false);
        assert.equal(first, undefined, 'unfiltered (accept all) when the listing fails');
        assert.equal(second, undefined);

        const log = readFileSync(getDaemonLogPath('acme'), 'utf8');
        const warnLines = log.split('\n').filter((l) => l.includes('NOT being filtered'));
        assert.equal(warnLines.length, 1, 'exactly one warning line per project, not one per poll');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe('D15: only the claim author can release their own claim', () => {
  const now = new Date();
  const until = iso(3600_000);

  it('ignores a release posted by someone other than the claim author', () => {
    const claim = createEnvelope(
      { type: 'claim', subject: 'mine', refs: { paths: ['src/**'], until } },
      { dev: 'ana', agent: 'cursor', repo: 'acme' },
      { id: 'D15C1', ts: iso(-1000), ttl: iso(864e5) },
    );
    const foreignRelease = createEnvelope(
      { type: 'release', subject: 'not yours to release', reply_to: 'D15C1', to: ['*'] },
      { dev: 'mallory', agent: 'cursor', repo: 'acme' },
      { id: 'D15R1', ts: iso(), ttl: iso(864e5) },
    );

    const claims = materializeActiveClaims([claim, foreignRelease], now);
    assert.equal(claims.length, 1, 'the claim stays active: mallory did not make it');
    assert.equal(claims[0]!.id, 'D15C1');

    const formatted = formatInboxForDisplay([claim], [claim, foreignRelease]);
    assert.doesNotMatch(formatted, /released/);
  });

  it('honors a release from the claim author', () => {
    const claim = createEnvelope(
      { type: 'claim', subject: 'mine', refs: { paths: ['src/**'], until } },
      { dev: 'ana', agent: 'cursor', repo: 'acme' },
      { id: 'D15C2', ts: iso(-1000), ttl: iso(864e5) },
    );
    const ownRelease = createEnvelope(
      { type: 'release', subject: 'done', reply_to: 'D15C2', to: ['*'] },
      { dev: 'ana', agent: 'cursor', repo: 'acme' },
      { id: 'D15R2', ts: iso(), ttl: iso(864e5) },
    );

    const claims = materializeActiveClaims([claim, ownRelease], now);
    assert.equal(claims.length, 0);

    const formatted = formatInboxForDisplay([claim, ownRelease], [claim, ownRelease]);
    assert.match(formatted, /\[released — see release D15R2/);
  });
});

describe('B4: single-instance daemon lock', () => {
  it('acquires a fresh lock and writes the pid', async () => {
    await withTempHome(async () => {
      const result = acquireDaemonLock(1234, () => true);
      assert.deepEqual(result, { acquired: true });
      assert.equal(readFileSync(getDaemonLockPath(), 'utf8').trim(), '1234');
    });
  });

  it('refuses to start a second instance while the first pid is alive', async () => {
    await withTempHome(async () => {
      const first = acquireDaemonLock(111, () => true);
      assert.deepEqual(first, { acquired: true });

      const second = acquireDaemonLock(222, () => true);
      assert.deepEqual(second, { acquired: false, pid: 111 });
      // The file must still name the first daemon — a refused second
      // instance must not clobber the lock.
      assert.equal(readFileSync(getDaemonLockPath(), 'utf8').trim(), '111');
    });
  });

  it('takes over a stale lock left by a pid that is no longer alive', async () => {
    await withTempHome(async () => {
      acquireDaemonLock(111, () => true);
      const second = acquireDaemonLock(222, () => false);
      assert.deepEqual(second, { acquired: true });
      assert.equal(readFileSync(getDaemonLockPath(), 'utf8').trim(), '222');
    });
  });

  it('releaseDaemonLock only removes a lock this pid still owns', async () => {
    await withTempHome(async () => {
      acquireDaemonLock(111, () => true);
      releaseDaemonLock(222); // not the owner: must be a no-op
      assert.ok(existsSync(getDaemonLockPath()));

      releaseDaemonLock(111);
      assert.ok(!existsSync(getDaemonLockPath()));
    });
  });
});

describe('D12: cost per request', () => {
  it('getGitHubToken caches a token for 5 minutes and refetches once it expires', () => {
    let calls = 0;
    setGitHubTokenProviderForTests(() => {
      calls++;
      return `tok-${calls}`;
    });

    let now = 0;
    assert.equal(getGitHubToken(now), 'tok-1');
    assert.equal(calls, 1);

    now += 60_000; // 1 minute later, still within the 5-minute TTL
    assert.equal(getGitHubToken(now), 'tok-1');
    assert.equal(calls, 1);

    now += 5 * 60_000 + 1; // past the TTL
    assert.equal(getGitHubToken(now), 'tok-2');
    assert.equal(calls, 2);
  });

  it('setGitHubTokenProviderForTests invalidates any cached token immediately', () => {
    setGitHubTokenProviderForTests(() => 'first');
    assert.equal(getGitHubToken(0), 'first');
    setGitHubTokenProviderForTests(() => 'second');
    assert.equal(getGitHubToken(0), 'second');
  });

  it('resetGitHubAuthForTests clears the cache too', () => {
    setGitHubTokenProviderForTests(() => 'cached-value');
    assert.equal(getGitHubToken(0), 'cached-value');
    resetGitHubAuthForTests();

    delete process.env.GITHUB_TOKEN;
    setGitHubTokenProviderForTests(() => null);
    assert.throws(() => getGitHubToken(0), (err: GitHubAuthError) => {
      assert.equal(err.message, 'gh auth login');
      return true;
    });
  });

  it('daemon resolveDev caches the whoami login for 10 minutes per binding', async () => {
    await withTempHome(async () => {
      const binding = { project: 'acme', bus: { kind: 'github' as const, repo: 'acme/api', issue: 1 }, repoPath: '/tmp/x' };
      let calls = 0;
      const transport: Transport = {
        whoami: async () => {
          calls++;
          return { dev: 'ana', authenticated: true };
        },
        send: async () => ({ id: '1' }),
        fetchSince: async () => ({ envelopes: [], cursor: null }),
        describe: () => 'test',
      };
      const config: ConfigV2 = { version: 2, defaultProject: 'acme', projects: {} };

      let now = 0;
      assert.equal(await resolveDev(binding, transport, config, false, now), 'ana');
      assert.equal(calls, 1);

      now += 5 * 60_000; // well within the 10-minute window
      assert.equal(await resolveDev(binding, transport, config, false, now), 'ana');
      assert.equal(calls, 1, 'a poll inside the cache window must not call whoami() again');

      now += 6 * 60_000; // past the window
      assert.equal(await resolveDev(binding, transport, config, false, now), 'ana');
      assert.equal(calls, 2);
    });
  });

  it('daemon resolveDev falls back to the cached dev on a whoami failure', async () => {
    await withTempHome(async () => {
      const binding = { project: 'acme', bus: { kind: 'github' as const, repo: 'acme/api', issue: 1 }, repoPath: '/tmp/x' };
      let calls = 0;
      const transport: Transport = {
        whoami: async () => {
          calls++;
          if (calls === 1) return { dev: 'ana', authenticated: true };
          throw new Error('rate limited');
        },
        send: async () => ({ id: '1' }),
        fetchSince: async () => ({ envelopes: [], cursor: null }),
        describe: () => 'test',
      };
      const config: ConfigV2 = { version: 2, defaultProject: 'acme', projects: {} };

      let now = 0;
      assert.equal(await resolveDev(binding, transport, config, false, now), 'ana');
      now += 20 * 60_000; // past the window: forces a refresh, which fails
      assert.equal(await resolveDev(binding, transport, config, false, now), 'ana');
      assert.equal(calls, 2);
    });
  });
});
