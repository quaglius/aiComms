import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { clearCollaboratorsCacheForTests } from '../src/collaborators.js';
import {
  GitHubAuthError,
  getGitHubToken,
  resetGitHubAuthForTests,
  setGitHubTokenProviderForTests,
} from '../src/github-auth.js';
import { createEnvelope, renderEnvelope } from '../src/envelope.js';
import { formatNotifierLine } from '../src/notifiers/index.js';
import { GitHubTransport } from '../src/transports/github.js';
import { resolveContext } from '../src/context.js';
import { DiscordTransport } from '../src/transports/discord.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  clearCollaboratorsCacheForTests();
  resetGitHubAuthForTests();
});

describe('GitHub identity override', () => {
  it('reads comment with forged from.dev as the GitHub author and logs mismatch', async () => {
    const mismatches: string[] = [];
    const envelope = createEnvelope(
      { type: 'fyi', subject: 'hello' },
      { dev: 'fake-ana', agent: 'cursor', repo: 'acme-api' },
      { id: 'ENV1', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );
    const { content } = await import('../src/envelope.js').then((m) => m.renderEnvelope(envelope));

    const fetchFn = mock.fn(async () => {
      return new Response(
        JSON.stringify([
          {
            id: 42,
            body: content,
            user: { login: 'real-ana' },
            created_at: '2026-09-16T12:01:00Z',
          },
        ]),
        { status: 200, headers: { ETag: '"abc"' } },
      );
    }) as typeof fetch;

    const transport = new GitHubTransport({
      repo: 'acme/acme-api',
      issue: 7,
      token: 'gh-test',
      fetchFn,
      onIdentityMismatch: (declared, actual) => {
        mismatches.push(`${declared}->${actual}`);
      },
    });

    const result = await transport.fetchSince(null);
    assert.equal(result.envelopes.length, 1);
    assert.equal(result.envelopes[0]!.from.dev, 'real-ana');
    assert.deepEqual(mismatches, ['fake-ana->real-ana']);
    assert.equal(result.cursor, '2026-09-16T12:01:00Z');
  });
});

describe('GitHub pagination and 304', () => {
  it('paginates comments and advances cursor', async () => {
    const mkComment = (id: number, login: string, ts: string) => {
      const env = createEnvelope(
        { type: 'fyi', subject: `m${id}` },
        { dev: login, agent: 'cursor', repo: 'acme-api' },
        { id: `ENV${id}`, ts, ttl: '2026-09-17T12:00:00Z' },
      );
      const { content } = renderEnvelope(env);
      return { id, body: content, user: { login }, created_at: ts };
    };

    const page1 = Array.from({ length: 100 }, (_, i) =>
      mkComment(i + 1, 'ana', `2026-09-16T11:${String(i % 60).padStart(2, '0')}:00Z`),
    );
    const fetchFn = mock.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('page=2')) {
        return new Response(JSON.stringify([mkComment(101, 'beto', '2026-09-16T12:02:00Z')]), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(page1), { status: 200 });
    }) as typeof fetch;

    const transport = new GitHubTransport({
      repo: 'acme/acme-api',
      issue: 7,
      token: 'gh-test',
      fetchFn,
    });

    const result = await transport.fetchAllSince(null);
    assert.equal(result.envelopes.length, 101);
    assert.equal(result.cursor, '2026-09-16T12:02:00Z');
  });

  it('returns no envelopes and keeps cursor on 304', async () => {
    const fetchFn = mock.fn(async () => {
      return new Response(null, { status: 304, headers: { ETag: '"same"' } });
    }) as typeof fetch;

    const transport = new GitHubTransport({
      repo: 'acme/acme-api',
      issue: 7,
      token: 'gh-test',
      fetchFn,
      getEtag: () => '"same"',
    });

    const result = await transport.fetchSince('2026-09-16T12:00:00Z');
    assert.equal(result.envelopes.length, 0);
    assert.equal(result.cursor, '2026-09-16T12:00:00Z');
  });
});

describe('GitHub auth errors', () => {
  it('reports gh auth login when no token is available', () => {
    delete process.env.GITHUB_TOKEN;
    setGitHubTokenProviderForTests(() => null);
    assert.throws(() => getGitHubToken(), (err: GitHubAuthError) => {
      assert.equal(err.message, 'gh auth login');
      return true;
    });
  });

  it('uses GITHUB_TOKEN when gh is unavailable', () => {
    process.env.GITHUB_TOKEN = 'env-token';
    setGitHubTokenProviderForTests(() => null);
    assert.equal(getGitHubToken(), 'env-token');
  });
});

describe('Discord notifier', () => {
  it('formats a readable line without a json envelope block', () => {
    const envelope = createEnvelope(
      { type: 'ask', subject: 'schema?', to: ['beto'] },
      { dev: 'ana', agent: 'cursor', repo: 'acme-api' },
    );
    const line = formatNotifierLine(envelope);
    assert.ok(!line.includes('```json'));
    assert.match(line, /schema\?/);
    assert.match(line, /ana\/cursor/);
  });
});

describe('legacy Discord config', () => {
  it('resolves context and sends via discord transport', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-v05-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const repo = path.join(home, 'acme-api');
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      path.join(repo, '.ai-comms.json'),
      JSON.stringify({
        project: 'acme',
        repo: 'acme-api',
        discord: { channelId: '111' },
        team: ['ana', 'beto'],
      }) + '\n',
    );
    mkdirSync(path.join(home, '.ai-comms'), { recursive: true });
    writeFileSync(
      path.join(home, '.ai-comms', 'config.json'),
      JSON.stringify({
        version: 2,
        identity: { dev: 'ana', agent: 'cursor' },
        agent: 'cursor',
        defaultProject: 'acme',
        projects: { acme: { discord: { channelId: '111' } } },
      }) + '\n',
    );
    writeFileSync(
      path.join(home, '.ai-comms', 'secrets.json'),
      JSON.stringify({ acme: { token: 'discord-token' } }) + '\n',
    );

    const config = (await import('../src/config.js')).loadConfig();
    const ctx = resolveContext(repo, config);
    assert.equal(ctx.bus.kind, 'discord');
    assert.equal(ctx.channelId, '111');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({ id: '999' }), { status: 200 });
    }) as typeof fetch;

    try {
      const transport = new DiscordTransport({
        channelId: '111',
        project: 'acme',
        configuredDev: 'ana',
        token: 'discord-token',
      });
      const identity = await transport.whoami();
      assert.equal(identity.dev, 'ana');
      assert.equal(identity.authenticated, false);
      assert.ok(identity.warning);

      const envelope = createEnvelope(
        { type: 'fyi', subject: 'legacy ok' },
        { dev: 'ana', agent: 'cursor', repo: 'acme-api' },
      );
      await transport.send(envelope);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
