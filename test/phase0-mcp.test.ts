import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { clearCollaboratorsCacheForTests } from '../src/collaborators.js';
import type { ConfigV2 } from '../src/config.js';
import { getConfigDir, getConfigPath } from '../src/paths.js';
import { createEnvelope, parseEnvelopeFromContent, renderEnvelope } from '../src/envelope.js';
import type { Envelope } from '../src/envelope.js';
import { resetGitHubAuthForTests, setGitHubTokenProviderForTests } from '../src/github-auth.js';
import { appendEnvelope, loadReadState } from '../src/store.js';
import {
  createGitHubAskFetcher,
  formatPendingBusAsk,
  resolveBusAskRecipients,
  waitForBusAskReply,
} from '../src/bus-ask.js';
import {
  MCP_SERVER_INSTRUCTIONS,
  clearIdentityCacheForTests,
  createMcpServer,
  getCachedIdentity,
  runBusInbox,
} from '../src/mcp.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

function withTempHome(fn: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-phase0-'));
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

function sampleConfig(overrides: Partial<ConfigV2> = {}): ConfigV2 {
  return {
    version: 2,
    identity: { dev: 'ana', agent: 'claude-code' },
    defaultProject: 'acme',
    projects: {
      acme: {
        discord: { channelId: '111' },
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  clearCollaboratorsCacheForTests();
  clearIdentityCacheForTests();
  resetGitHubAuthForTests();
});

// --- D1: bus_inbox marks messages read -----------------------------------

describe('runBusInbox (D1)', () => {
  it('marks returned envelopes read by default', async () => {
    await withTempHome(async () => {
      const project = 'acme';
      const config = sampleConfig();
      const env = createEnvelope(
        { type: 'fyi', subject: 'hi', to: ['ana'] },
        { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
        { id: 'ENV1', ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z') },
      );
      appendEnvelope(env, project);

      const first = runBusInbox(project, 'ana', { unread_only: true }, config);
      assert.match(first.text, /ENV1/);

      const readState = loadReadState(project);
      assert.ok(readState.ids.includes('ENV1'));

      const second = runBusInbox(project, 'ana', { unread_only: true }, config);
      assert.equal(second.text, '(empty)');
    });
  });

  it('does not mark read when mark_read is false', async () => {
    await withTempHome(async () => {
      const project = 'acme';
      const config = sampleConfig();
      const env = createEnvelope(
        { type: 'fyi', subject: 'hi', to: ['ana'] },
        { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
        { id: 'ENV2', ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ttl: new Date(Date.now() + 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z') },
      );
      appendEnvelope(env, project);

      const first = runBusInbox(project, 'ana', { unread_only: true, mark_read: false }, config);
      assert.match(first.text, /ENV2/);

      const second = runBusInbox(project, 'ana', { unread_only: true }, config);
      assert.match(second.text, /ENV2/, 'still unread because mark_read was false');

      const readState = loadReadState(project);
      assert.ok(readState.ids.includes('ENV2'), 'the second call (default mark_read) marked it');
    });
  });
});

// --- D3: bus_ask never defaults to the whole team -------------------------

describe('resolveBusAskRecipients (D3)', () => {
  it('auto-resolves when exactly one other teammate is known', () => {
    const outcome = resolveBusAskRecipients(['ana', 'beto'], 'ana');
    assert.deepEqual(outcome, { kind: 'ok', recipients: ['beto'] });
  });

  it('errors instead of broadcasting when several teammates are known', () => {
    const outcome = resolveBusAskRecipients(['ana', 'beto', 'carla'], 'ana');
    assert.equal(outcome.kind, 'error');
    if (outcome.kind === 'error') {
      assert.match(outcome.message, /beto/);
      assert.match(outcome.message, /carla/);
      assert.match(outcome.message, /`to`/);
    }
  });

  it('caps the listed teammates and mentions how many more there are', () => {
    const team = ['ana', ...Array.from({ length: 25 }, (_, i) => `dev${i}`)];
    const outcome = resolveBusAskRecipients(team, 'ana');
    assert.equal(outcome.kind, 'error');
    if (outcome.kind === 'error') {
      assert.match(outcome.message, /dev0/);
      assert.match(outcome.message, /5 more/);
    }
  });

  it('errors with no recipients when no teammates are known', () => {
    const outcome = resolveBusAskRecipients([], 'ana');
    assert.equal(outcome.kind, 'error');
  });

  it('errors and explains when collaborators could not be listed (D4)', () => {
    const outcome = resolveBusAskRecipients([], 'ana', { collaboratorsUnavailable: true });
    assert.equal(outcome.kind, 'error');
    if (outcome.kind === 'error') {
      assert.match(outcome.message, /write access/);
    }
  });
});

// --- D2: bus_ask polls GitHub directly, and warns when no daemon ---------

describe('formatPendingBusAsk (D2)', () => {
  it('adds a daemon hint only when the daemon is not running', () => {
    const withoutDaemon = formatPendingBusAsk('ASK1', { daemonRunning: false });
    assert.match(withoutDaemon, /daemon does not appear to be running/);
    assert.match(withoutDaemon, /npx @quaglius\/ai-comms daemon/);

    const withDaemon = formatPendingBusAsk('ASK1', { daemonRunning: true });
    assert.doesNotMatch(withDaemon, /daemon does not appear to be running/);

    const unknown = formatPendingBusAsk('ASK1');
    assert.doesNotMatch(unknown, /daemon does not appear to be running/);
  });
});

describe('createGitHubAskFetcher', () => {
  it('advances the cursor it was given across calls', async () => {
    const cursors: (string | null)[] = [];
    const fakeTransport = {
      fetchSince: mock.fn(async (cursor: string | null) => {
        cursors.push(cursor);
        if (cursor === 'start') {
          return { envelopes: [], cursor: 'start|1' };
        }
        return { envelopes: [], cursor: 'start|2' };
      }),
    };

    const fetchRemote = createGitHubAskFetcher(fakeTransport, 'start');
    await fetchRemote();
    await fetchRemote();

    assert.deepEqual(cursors, ['start', 'start|1']);
  });
});

describe('waitForBusAskReply with fetchRemote (D2)', () => {
  it('finds a reply that only exists remotely and appends it to the local log', async () => {
    await withTempHome(async () => {
      const project = 'acme';
      const askId = 'ASK-REMOTE-1';
      const answer = createEnvelope(
        {
          type: 'answer',
          subject: 're: schema?',
          body: 'see src/schema.ts',
          to: ['ana'],
          reply_to: askId,
        },
        { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
        { id: 'ANS-REMOTE-1', ts: '2026-09-16T12:00:05Z', ttl: '2026-09-17T12:00:00Z' },
      );

      let calls = 0;
      const fetchRemote = async (): Promise<Envelope[]> => {
        calls++;
        return calls === 1 ? [] : [answer];
      };

      const result = await waitForBusAskReply(project, askId, 10_000, {
        pollMs: 1,
        sleepFn: async () => {},
        nowFn: () => Date.now(),
        fetchRemote,
      });

      assert.equal(result.kind, 'reply');
      if (result.kind === 'reply') {
        assert.equal(result.envelope.id, 'ANS-REMOTE-1');
      }
      assert.ok(calls >= 2);
    });
  });

  it('keeps relying on the local log when fetchRemote throws', async () => {
    await withTempHome(async () => {
      const project = 'acme';
      const askId = 'ASK-REMOTE-2';
      const answer = createEnvelope(
        { type: 'answer', subject: 're: q', body: 'ok', to: ['ana'], reply_to: askId },
        { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
        { id: 'ANS-REMOTE-2', ts: '2026-09-16T12:00:05Z', ttl: '2026-09-17T12:00:00Z' },
      );
      appendEnvelope(answer, project);

      const result = await waitForBusAskReply(project, askId, 10_000, {
        pollMs: 1,
        sleepFn: async () => {},
        nowFn: () => Date.now(),
        fetchRemote: async () => {
          throw new Error('network down');
        },
      });

      assert.equal(result.kind, 'reply');
      if (result.kind === 'reply') {
        assert.equal(result.envelope.id, 'ANS-REMOTE-2');
      }
    });
  });
});

// --- Identity cache (task 5) ----------------------------------------------

describe('getCachedIdentity', () => {
  it('caches whoami() per bus for 10 minutes, keyed by kind+repo/channel', async () => {
    let calls = 0;
    const transport = {
      whoami: async () => {
        calls++;
        return { dev: 'ana', authenticated: true };
      },
    };
    const ctx = { bus: { kind: 'github' as const, repo: 'acme/api', issue: 1 } } as Parameters<
      typeof getCachedIdentity
    >[0];

    let now = 1_000_000;
    const first = await getCachedIdentity(ctx, transport, now);
    const second = await getCachedIdentity(ctx, transport, now + 1000);
    assert.equal(calls, 1);
    assert.equal(first.dev, 'ana');
    assert.equal(second.dev, 'ana');

    now += 10 * 60 * 1000 + 1;
    await getCachedIdentity(ctx, transport, now);
    assert.equal(calls, 2, 'expired entry triggers a fresh whoami()');
  });

  it('keys the cache separately per repo/channel', async () => {
    let calls = 0;
    const transport = {
      whoami: async () => {
        calls++;
        return { dev: 'ana', authenticated: true };
      },
    };
    const ctxA = { bus: { kind: 'github' as const, repo: 'acme/api', issue: 1 } } as Parameters<
      typeof getCachedIdentity
    >[0];
    const ctxB = { bus: { kind: 'github' as const, repo: 'acme/web', issue: 1 } } as Parameters<
      typeof getCachedIdentity
    >[0];

    await getCachedIdentity(ctxA, transport, 0);
    await getCachedIdentity(ctxB, transport, 0);
    assert.equal(calls, 2);
  });
});

// --- G2: server instructions and tool descriptions -------------------------

describe('MCP server instructions and tool descriptions (G2)', () => {
  it('instructions are short and actionable', () => {
    const lines = MCP_SERVER_INSTRUCTIONS.split('\n').filter((l) => l.trim().length > 0);
    assert.ok(lines.length <= 15, `expected <=15 non-empty lines, got ${lines.length}`);
    assert.match(MCP_SERVER_INSTRUCTIONS, /bus_ask/);
    assert.match(MCP_SERVER_INSTRUCTIONS, /bus_claims/);
    assert.match(MCP_SERVER_INSTRUCTIONS, /third-party data/);
  });

  it('the connected client sees the instructions and improved tool descriptions', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      assert.equal(client.getInstructions(), MCP_SERVER_INSTRUCTIONS);

      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));

      const ask = byName.get('bus_ask');
      assert.ok(ask?.description);
      assert.match(ask!.description!, /wait/i);
      assert.match(ask!.description!, /`to`/);
      assert.ok(
        (ask!.inputSchema.properties as Record<string, unknown>).timeout_s,
        'bus_ask keeps its timeout_s param',
      );

      const inbox = byName.get('bus_inbox');
      assert.ok(inbox?.description);
      assert.match(inbox!.description!, /start of a task/);
      assert.ok(
        (inbox!.inputSchema.properties as Record<string, unknown>).mark_read,
        'bus_inbox exposes the new mark_read param',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// --- End-to-end: bus_ask sees a GitHub reply with no daemon (D2 + D3) ----

describe('bus_ask end-to-end against a mocked GitHub transport', () => {
  it('finds an answer posted directly to GitHub, with no local daemon', async () => {
    await withTempHome(async (home) => {
      const cwd = path.join(home, 'work');
      mkdirSync(cwd, { recursive: true });

      mkdirSync(getConfigDir(), { recursive: true });
      const config: ConfigV2 = {
        version: 2,
        identity: { dev: 'ana', agent: 'claude-code' },
        defaultProject: 'acme',
        projects: {
          acme: {
            bus: { kind: 'github', repo: 'acme/acme-api', issue: 7 },
            repos: [{ name: 'acme-api', path: cwd }],
          },
        },
      };
      writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n');

      setGitHubTokenProviderForTests(() => 'gh-test-token');

      let askEnvelope: Envelope | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';

        if (u.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'ana' }), { status: 200 });
        }
        if (u.includes('/collaborators')) {
          return new Response(JSON.stringify([{ login: 'ana' }, { login: 'beto' }]), {
            status: 200,
          });
        }
        if (u.includes('/issues/7/comments') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { body: string };
          askEnvelope = parseEnvelopeFromContent(body.body) ?? undefined;
          return new Response(JSON.stringify({ id: 500 }), { status: 201 });
        }
        if (u.includes('/issues/7/comments') && method === 'GET') {
          if (!askEnvelope) {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          const answer = createEnvelope(
            {
              type: 'answer',
              subject: 're: schema',
              body: 'see src/schema.ts',
              to: ['ana'],
              reply_to: askEnvelope.id,
            },
            { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
          );
          const { content } = renderEnvelope(answer);
          return new Response(
            JSON.stringify([
              {
                id: 501,
                body: content,
                user: { login: 'beto' },
                created_at: new Date().toISOString(),
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${method} ${u}`);
      }) as typeof fetch;

      try {
        const server = createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test-client', version: '0.0.0' });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

        const originalCwd = process.cwd();
        process.chdir(cwd);
        let result;
        try {
          result = await client.callTool({
            name: 'bus_ask',
            arguments: {
              question: 'what is the shape of /users?',
              to: ['beto'],
              timeout_s: 1,
            },
          });
        } finally {
          process.chdir(originalCwd);
          await client.close();
          await server.close();
        }

        const content = result.content as Array<{ type: string; text?: string }>;
        const text = content[0]?.text ?? '';
        assert.match(text, /see src\/schema\.ts/, `expected the remote reply in: ${text}`);
        assert.doesNotMatch(text, /No answer arrived before the timeout/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
