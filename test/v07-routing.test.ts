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
import { createEnvelope, parseEnvelopeFromContent, renderEnvelope, type Envelope } from '../src/envelope.js';
import { resetGitHubAuthForTests, setGitHubTokenProviderForTests } from '../src/github-auth.js';
import { formatInboxForDisplay } from '../src/store.js';
import type { CodeownersRule } from '../src/codeowners.js';
import type { MemberProfile } from '../src/presence.js';
import {
  findReplyToAsk,
  formatBusAskReply,
  formatDisplayMarker,
  formatFailFastNotice,
  resolveAskRecipients,
  resolveThreadContinuation,
  shouldFailFast,
} from '../src/bus-ask.js';
import {
  annotateInboxDisplay,
  clearIdentityCacheForTests,
  clearProfileCacheForTests,
  createMcpServer,
  MCP_SERVER_INSTRUCTIONS,
} from '../src/mcp.js';

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
  clearCollaboratorsCacheForTests();
  clearIdentityCacheForTests();
  clearProfileCacheForTests();
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

function profile(overrides: Partial<MemberProfile> & { login: string }): MemberProfile {
  return {
    role: undefined,
    areas: [],
    repos: [],
    agent: undefined,
    autoAnswer: false,
    lastSeen: null,
    ...overrides,
  };
}

// =========================================================================
// resolveAskRecipients (SPEC-v0.7 §2.2)
// =========================================================================

describe('resolveAskRecipients — routing order', () => {
  it('explicit `to` wins immediately, excluding self, even when paths/role are also set', () => {
    const outcome = resolveAskRecipients({
      to: ['beto', 'ana'],
      paths: ['docs/**'],
      role: 'backend',
      self: 'ana',
      team: ['ana', 'beto', 'carla'],
      profiles: [],
      codeownersRules: null,
    });
    assert.deepEqual(outcome, { kind: 'ok', recipients: ['beto'] });
  });

  it('errors when `to` is empty after excluding yourself', () => {
    const outcome = resolveAskRecipients({
      to: ['ana'],
      self: 'ana',
      team: [],
      profiles: [],
      codeownersRules: null,
    });
    assert.equal(outcome.kind, 'error');
    if (outcome.kind === 'error') assert.match(outcome.message, /`to`/);
  });

  it('resolves paths via CODEOWNERS, naming how it resolved', () => {
    const rules: CodeownersRule[] = [{ pattern: '/docs/api/', owners: ['beto'] }];
    const outcome = resolveAskRecipients({
      paths: ['docs/api/openapi.yaml'],
      self: 'ana',
      team: ['ana', 'beto', 'carla'],
      profiles: [],
      codeownersRules: rules,
    });
    assert.deepEqual(outcome, { kind: 'ok', recipients: ['beto'], via: 'CODEOWNERS: beto' });
  });

  it('excludes self from CODEOWNERS owners', () => {
    const rules: CodeownersRule[] = [{ pattern: '/docs/', owners: ['ana', 'beto'] }];
    const outcome = resolveAskRecipients({
      paths: ['docs/x.md'],
      self: 'ana',
      team: ['ana', 'beto'],
      profiles: [],
      codeownersRules: rules,
    });
    assert.deepEqual(outcome, { kind: 'ok', recipients: ['beto'], via: 'CODEOWNERS: beto' });
  });

  it('falls back to profile areas when there is no CODEOWNERS file at all', () => {
    const outcome = resolveAskRecipients({
      paths: ['infra/terraform/main.tf'],
      self: 'ana',
      team: ['ana', 'beto', 'carla'],
      profiles: [
        profile({ login: 'beto', areas: ['infra/**'] }),
        profile({ login: 'carla', areas: ['frontend/**'] }),
      ],
      codeownersRules: null,
    });
    assert.deepEqual(outcome, { kind: 'ok', recipients: ['beto'], via: 'profile areas: beto' });
  });

  it('falls back to profile areas when CODEOWNERS names no owner for the path', () => {
    const rules: CodeownersRule[] = [{ pattern: '/docs/', owners: ['someone-else'] }];
    const outcome = resolveAskRecipients({
      paths: ['infra/terraform/main.tf'],
      self: 'ana',
      team: ['ana', 'beto'],
      profiles: [profile({ login: 'beto', areas: ['infra/**'] })],
      codeownersRules: rules,
    });
    assert.deepEqual(outcome, { kind: 'ok', recipients: ['beto'], via: 'profile areas: beto' });
  });

  it('resolves by role via membersByRole when paths do not apply', () => {
    const outcome = resolveAskRecipients({
      role: 'infra',
      self: 'ana',
      team: ['ana', 'beto', 'carla'],
      profiles: [
        profile({ login: 'beto', role: 'infra/platform' }),
        profile({ login: 'carla', role: 'frontend' }),
      ],
      codeownersRules: null,
    });
    assert.deepEqual(outcome, { kind: 'ok', recipients: ['beto'], via: 'role "infra": beto' });
  });

  it('falls back to the only other known teammate when nothing else resolves', () => {
    const outcome = resolveAskRecipients({
      self: 'ana',
      team: ['ana', 'beto'],
      profiles: [],
      codeownersRules: null,
    });
    assert.deepEqual(outcome, {
      kind: 'ok',
      recipients: ['beto'],
      via: 'the only known teammate: beto',
    });
  });

  it('errors with the team directory when several teammates are known and nothing else resolved', () => {
    const profiles = [
      profile({ login: 'beto', role: 'infra', areas: ['infra/**'], autoAnswer: true }),
      profile({ login: 'carla', role: 'frontend' }),
    ];
    const outcome = resolveAskRecipients({
      self: 'ana',
      team: ['ana', 'beto', 'carla'],
      profiles,
      codeownersRules: null,
    });
    assert.equal(outcome.kind, 'error');
    if (outcome.kind === 'error') {
      assert.match(outcome.message, /beto/);
      assert.match(outcome.message, /carla/);
      assert.match(outcome.message, /`to`/);
    }
  });

  it('lists known teammates in the error when no profiles are configured at all', () => {
    const outcome = resolveAskRecipients({
      self: 'ana',
      team: ['ana', 'beto', 'carla'],
      profiles: [],
      codeownersRules: null,
    });
    assert.equal(outcome.kind, 'error');
    if (outcome.kind === 'error') {
      assert.match(outcome.message, /Known teammates: beto, carla/);
    }
  });

  it('reports the collaborators-unavailable error only after paths/role fail to resolve', () => {
    const rules: CodeownersRule[] = [{ pattern: '/docs/', owners: ['beto'] }];
    const resolved = resolveAskRecipients({
      paths: ['docs/x.md'],
      self: 'ana',
      team: [],
      profiles: [],
      codeownersRules: rules,
      collaboratorsUnavailable: true,
    });
    assert.equal(resolved.kind, 'ok');

    const unresolved = resolveAskRecipients({
      self: 'ana',
      team: [],
      profiles: [],
      codeownersRules: null,
      collaboratorsUnavailable: true,
    });
    assert.equal(unresolved.kind, 'error');
    if (unresolved.kind === 'error') assert.match(unresolved.message, /write access/);
  });

  it('never resolves to "everyone": every branch names specific people or errors', () => {
    // A broad CODEOWNERS rule still only names the owners it lists, never '*'.
    const rules: CodeownersRule[] = [{ pattern: '*', owners: ['beto', 'carla'] }];
    const outcome = resolveAskRecipients({
      paths: ['anything.ts'],
      self: 'ana',
      team: ['ana', 'beto', 'carla', 'dave'],
      profiles: [],
      codeownersRules: rules,
    });
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind === 'ok') {
      assert.ok(!outcome.recipients.includes('dave'), 'must not silently include an unnamed teammate');
      assert.deepEqual(outcome.recipients.sort(), ['beto', 'carla']);
    }
  });
});

// =========================================================================
// shouldFailFast / formatFailFastNotice (SPEC-v0.7 §2.3)
// =========================================================================

describe('shouldFailFast', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');

  it('never fails fast with no presence data at all (v0.6 behavior)', () => {
    assert.equal(shouldFailFast(['beto'], [], undefined, now), false);
  });

  it('fails fast when needs_human is set, regardless of who is online', () => {
    const profiles = [profile({ login: 'beto', autoAnswer: true, lastSeen: new Date(now).toISOString() })];
    assert.equal(shouldFailFast(['beto'], profiles, true, now), true);
  });

  it('does not fail fast when a recipient is online with autoAnswer', () => {
    const profiles = [profile({ login: 'beto', autoAnswer: true, lastSeen: new Date(now).toISOString() })];
    assert.equal(shouldFailFast(['beto'], profiles, undefined, now), false);
  });

  it('fails fast when the recipient is offline', () => {
    const profiles = [
      profile({ login: 'beto', autoAnswer: true, lastSeen: new Date(now - 60 * 60_000).toISOString() }),
    ];
    assert.equal(shouldFailFast(['beto'], profiles, undefined, now), true);
  });

  it('fails fast when the recipient is online but autoAnswer is off', () => {
    const profiles = [profile({ login: 'beto', autoAnswer: false, lastSeen: new Date(now).toISOString() })];
    assert.equal(shouldFailFast(['beto'], profiles, undefined, now), true);
  });

  it('does not fail fast if at least one of several recipients can auto-answer', () => {
    const profiles = [
      profile({ login: 'beto', autoAnswer: false, lastSeen: new Date(now).toISOString() }),
      profile({ login: 'carla', autoAnswer: true, lastSeen: new Date(now).toISOString() }),
    ];
    assert.equal(shouldFailFast(['beto', 'carla'], profiles, undefined, now), false);
  });
});

describe('formatFailFastNotice', () => {
  it('explains why, and points at bus_inbox and the next-prompt hook', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const profiles = [
      profile({ login: 'beto', autoAnswer: true, lastSeen: new Date(now - 60 * 60_000).toISOString() }),
    ];
    const text = formatFailFastNotice('ASK1', ['beto'], profiles, undefined, now);
    assert.match(text, /beto/);
    assert.match(text, /offline/);
    assert.match(text, /bus_inbox/);
    assert.match(text, /next prompt/);
  });

  it('marks a needs_human ask distinctly from an offline recipient', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const profiles = [profile({ login: 'beto', autoAnswer: true, lastSeen: new Date(now).toISOString() })];
    const text = formatFailFastNotice('ASK2', ['beto'], profiles, true, now);
    assert.match(text, /needs a human decision/);
  });
});

// =========================================================================
// resolveThreadContinuation / findReplyToAsk (SPEC-v0.7 §2.6)
// =========================================================================

describe('resolveThreadContinuation', () => {
  it('returns {} for a plain new-thread ask', () => {
    assert.deepEqual(resolveThreadContinuation([], undefined), {});
  });

  it('uses the given id itself as the root when it is not in the local log', () => {
    assert.deepEqual(resolveThreadContinuation([], 'UNKNOWN-ID'), { thread: 'UNKNOWN-ID', reply_to: undefined });
  });

  it('resolves to the root of an existing thread and reply_to the latest answer', () => {
    const root = createEnvelope(
      { type: 'ask', subject: 'q1', to: ['beto'] },
      { dev: 'ana', agent: 'claude-code', repo: 'acme-api' },
      { id: 'ASK-ROOT' },
    );
    const oldAnswer = createEnvelope(
      { type: 'answer', subject: 're: q1', to: ['ana'], reply_to: 'ASK-ROOT', thread: 'ASK-ROOT' },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
      { id: 'ANS-OLD', ts: '2026-09-28T10:00:00Z' },
    );
    const newAnswer = createEnvelope(
      { type: 'answer', subject: 're: q1', to: ['ana'], reply_to: 'ASK-ROOT', thread: 'ASK-ROOT' },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
      { id: 'ANS-NEW', ts: '2026-09-28T11:00:00Z' },
    );
    const result = resolveThreadContinuation([root, oldAnswer, newAnswer], 'ASK-ROOT');
    assert.deepEqual(result, { thread: 'ASK-ROOT', reply_to: 'ANS-NEW' });
  });

  it('resolves through an intermediate envelope to the same root (threadOf)', () => {
    const root = createEnvelope(
      { type: 'ask', subject: 'q1', to: ['beto'] },
      { dev: 'ana', agent: 'claude-code', repo: 'acme-api' },
      { id: 'ASK-ROOT' },
    );
    const followUp = createEnvelope(
      { type: 'ask', subject: 'q2', to: ['beto'], thread: 'ASK-ROOT' },
      { dev: 'ana', agent: 'claude-code', repo: 'acme-api' },
      { id: 'ASK-FOLLOWUP' },
    );
    const result = resolveThreadContinuation([root, followUp], 'ASK-FOLLOWUP');
    assert.equal(result.thread, 'ASK-ROOT');
    assert.equal(result.reply_to, undefined, 'no answer yet in the thread');
  });
});

describe('findReplyToAsk — thread matching (SPEC-v0.7 §2.6)', () => {
  it('still matches a direct reply_to with no threadId given (unchanged v0.6 behavior)', () => {
    const answer = createEnvelope(
      { type: 'answer', subject: 're', to: ['ana'], reply_to: 'ASK1' },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
      { id: 'ANS1' },
    );
    assert.equal(findReplyToAsk([answer], 'ASK1')?.id, 'ANS1');
  });

  it('accepts a reply that names the thread instead of this specific ask id', () => {
    const followUp = createEnvelope(
      { type: 'ask', subject: 'q2', to: ['beto'], thread: 'ASK-ROOT' },
      { dev: 'ana', agent: 'claude-code', repo: 'acme-api' },
      { id: 'ASK-FOLLOWUP', ts: '2026-09-28T11:00:00Z' },
    );
    const answer = createEnvelope(
      // Replies to the thread root rather than the follow-up specifically.
      { type: 'answer', subject: 're', to: ['ana'], reply_to: 'ASK-ROOT', thread: 'ASK-ROOT' },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
      { id: 'ANS-THREAD', ts: '2026-09-28T11:05:00Z' },
    );
    const found = findReplyToAsk([followUp, answer], 'ASK-FOLLOWUP', {
      threadId: 'ASK-ROOT',
      sinceTs: '2026-09-28T11:00:00Z',
    });
    assert.equal(found?.id, 'ANS-THREAD');
  });

  it('ignores a thread match published before the ask went out (stale answer)', () => {
    const staleAnswer = createEnvelope(
      { type: 'answer', subject: 're', to: ['ana'], reply_to: 'ASK-ROOT', thread: 'ASK-ROOT' },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
      { id: 'ANS-STALE', ts: '2026-09-28T09:00:00Z' },
    );
    const found = findReplyToAsk([staleAnswer], 'ASK-FOLLOWUP', {
      threadId: 'ASK-ROOT',
      sinceTs: '2026-09-28T11:00:00Z',
    });
    assert.equal(found, null);
  });
});

// =========================================================================
// Display markers (SPEC-v0.7 §2.5)
// =========================================================================

describe('formatDisplayMarker / formatBusAskReply', () => {
  it('marks an answer not explicitly answered_by human', () => {
    const answer = createEnvelope(
      { type: 'answer', subject: 're', body: 'see x', to: ['ana'], reply_to: 'ASK1' },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
    );
    assert.match(formatDisplayMarker(answer) ?? '', /automated answer from beto's AI — not validated by beto/);
    assert.match(formatBusAskReply(answer), /automated answer from beto's AI/);
  });

  it('does not mark an answer explicitly answered_by human', () => {
    const answer = createEnvelope(
      { type: 'answer', subject: 're', body: 'see x', to: ['ana'], reply_to: 'ASK1', answered_by: 'human' },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
    );
    assert.equal(formatDisplayMarker(answer), null);
    assert.doesNotMatch(formatBusAskReply(answer), /automated answer/);
  });

  it('marks an ask/need that needs a human decision', () => {
    const ask = createEnvelope(
      { type: 'ask', subject: 'ship it?', to: ['ana'], needs_human: true },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
    );
    assert.equal(formatDisplayMarker(ask), '[needs a human decision]');
  });

  it('does not mark a plain fact-seeking ask', () => {
    const ask = createEnvelope(
      { type: 'ask', subject: 'what shape?', to: ['ana'] },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
    );
    assert.equal(formatDisplayMarker(ask), null);
  });
});

describe('annotateInboxDisplay (bus_inbox display, SPEC-v0.7 §2.5)', () => {
  it('prefixes the automated-answer marker for a non-human answer, and leaves a plain fyi alone', () => {
    const answer = createEnvelope(
      { type: 'answer', subject: 're', body: 'see x', to: ['ana'], reply_to: 'ASK1' },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
      { id: 'ANS1' },
    );
    const fyi = createEnvelope(
      { type: 'fyi', subject: 'heads up', to: ['ana'] },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
      { id: 'FYI1' },
    );
    const inbox = [answer, fyi];
    const rendered = formatInboxForDisplay(inbox, inbox);
    const annotated = annotateInboxDisplay(rendered, inbox);

    const blocks = annotated.split('\n\n');
    assert.equal(blocks.length, 2);
    assert.match(blocks[0]!, /^\(automated answer from beto's AI/);
    assert.doesNotMatch(blocks[1]!, /automated answer/);
  });

  it('marks a needs_human ask in the inbox listing', () => {
    const ask = createEnvelope(
      { type: 'ask', subject: 'approve deploy?', to: ['ana'], needs_human: true },
      { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
      { id: 'ASK-NH' },
    );
    const inbox = [ask];
    const annotated = annotateInboxDisplay(formatInboxForDisplay(inbox, inbox), inbox);
    assert.match(annotated, /^\[needs a human decision\]/);
  });

  it('leaves the text unchanged when the block count cannot be matched to the inbox', () => {
    const inbox = [
      createEnvelope(
        { type: 'fyi', subject: 'a', to: ['ana'] },
        { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
      ),
    ];
    const weird = 'one\n\ntwo\n\nthree'; // 3 blocks, 1 envelope
    assert.equal(annotateInboxDisplay(weird, inbox), weird);
  });

  it('is a no-op on an empty inbox', () => {
    assert.equal(annotateInboxDisplay('(empty)', []), '(empty)');
  });
});

// =========================================================================
// End-to-end via MCP protocol (mocked GitHub transport, InMemoryTransport)
// =========================================================================

function sampleConfig(cwd: string, presence: number): ConfigV2 {
  return {
    version: 2,
    identity: { dev: 'ana', agent: 'claude-code' },
    defaultProject: 'acme',
    projects: {
      acme: {
        bus: { kind: 'github', repo: 'acme/acme-api', issue: 7, presence },
        repos: [{ name: 'acme-api', path: cwd }],
      },
    },
  };
}

function bodyOfProfile(payload: Record<string, unknown>): string {
  return `ai-comms presence\n\`\`\`json\n${JSON.stringify({ kind: 'ai-comms-profile', v: 1, ...payload })}\n\`\`\``;
}

describe('bus_ask end-to-end — routing via CODEOWNERS + display marker + thread id (SPEC-v0.7 §2.2/§2.5/§2.6)', () => {
  it('resolves the recipient via CODEOWNERS, waits for the (unvalidated) reply, and returns the thread id', async () => {
    await withTempHome('ai-comms-routing-e2e-', async (home) => {
      const cwd = path.join(home, 'work');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(path.join(cwd, '.git'));
      writeFileSync(path.join(cwd, 'CODEOWNERS'), '/docs/api/ @beto\n', 'utf8');

      mkdirSync(getConfigDir(), { recursive: true });
      writeFileSync(getConfigPath(), JSON.stringify(sampleConfig(cwd, 9), null, 2) + '\n');

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
          return new Response(JSON.stringify([{ login: 'ana' }, { login: 'beto' }]), { status: 200 });
        }
        if (u.includes('/issues/9/comments') && method === 'GET') {
          return new Response(
            JSON.stringify([
              {
                id: 1,
                user: { login: 'beto' },
                updated_at: new Date().toISOString(),
                body: bodyOfProfile({
                  role: 'backend',
                  areas: ['docs/**'],
                  repos: ['acme/acme-api'],
                  agent: 'claude-code',
                  autoAnswer: true,
                  lastSeen: new Date().toISOString(),
                }),
              },
            ]),
            { status: 200 },
          );
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
              subject: 're: openapi',
              body: 'see docs/api/openapi.yaml',
              to: ['ana'],
              reply_to: askEnvelope.id,
            },
            { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
          );
          const { content } = renderEnvelope(answer);
          return new Response(
            JSON.stringify([
              { id: 501, body: content, user: { login: 'beto' }, created_at: new Date().toISOString() },
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

        process.chdir(cwd);
        let result;
        try {
          result = await client.callTool({
            name: 'bus_ask',
            arguments: {
              question: 'what changed in the openapi spec?',
              paths: ['docs/api/openapi.yaml'],
              timeout_s: 2,
            },
          });
        } finally {
          await client.close();
          await server.close();
        }

        const content = result.content as Array<{ type: string; text?: string }>;
        const text = content[0]?.text ?? '';
        assert.match(text, /Resolved via CODEOWNERS: beto/, `expected the routing line in: ${text}`);
        assert.match(text, /see docs\/api\/openapi\.yaml/);
        assert.match(
          text,
          /automated answer from beto's AI — not validated by beto/,
          'an answer with no answered_by must show as unvalidated',
        );
        assert.ok(askEnvelope, 'the ask must have been published');
        assert.match(text, new RegExp(`Thread: ${askEnvelope!.id}`));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe('bus_ask end-to-end — fails fast without waiting (SPEC-v0.7 §2.3)', () => {
  it('returns immediately when the only recipient is offline, instead of waiting out timeout_s', async () => {
    await withTempHome('ai-comms-failfast-e2e-', async (home) => {
      const cwd = path.join(home, 'work');
      mkdirSync(cwd, { recursive: true });

      mkdirSync(getConfigDir(), { recursive: true });
      writeFileSync(getConfigPath(), JSON.stringify(sampleConfig(cwd, 9), null, 2) + '\n');

      setGitHubTokenProviderForTests(() => 'gh-test-token');

      const longAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';

        if (u.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'ana' }), { status: 200 });
        }
        if (u.includes('/collaborators')) {
          return new Response(JSON.stringify([{ login: 'ana' }, { login: 'beto' }]), { status: 200 });
        }
        if (u.includes('/issues/9/comments') && method === 'GET') {
          return new Response(
            JSON.stringify([
              {
                id: 1,
                user: { login: 'beto' },
                updated_at: longAgo,
                body: bodyOfProfile({ role: 'backend', areas: [], autoAnswer: true, lastSeen: longAgo }),
              },
            ]),
            { status: 200 },
          );
        }
        if (u.includes('/issues/7/comments') && method === 'POST') {
          return new Response(JSON.stringify({ id: 500 }), { status: 201 });
        }
        throw new Error(`unexpected fetch in fail-fast test: ${method} ${u}`);
      }) as typeof fetch;

      try {
        const server = createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test-client', version: '0.0.0' });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

        process.chdir(cwd);
        const startedAt = Date.now();
        let result;
        try {
          result = await client.callTool({
            name: 'bus_ask',
            arguments: { question: 'is the deploy done?', to: ['beto'], timeout_s: 60 },
          });
        } finally {
          await client.close();
          await server.close();
        }
        const elapsedMs = Date.now() - startedAt;

        const content = result.content as Array<{ type: string; text?: string }>;
        const text = content[0]?.text ?? '';
        assert.match(text, /beto/);
        assert.match(text, /offline/);
        assert.match(text, /bus_inbox/);
        assert.ok(
          elapsedMs < 5000,
          `expected bus_ask to return well under the 60s timeout without waiting, took ${elapsedMs}ms`,
        );
        assert.doesNotMatch(text, /No answer arrived before the timeout/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe('bus_send — human_approved provenance (SPEC-v0.7 §2.5)', () => {
  async function publishAnswer(
    humanApproved: boolean | undefined,
  ): Promise<{ answeredBy: unknown; text: string }> {
    return withTempHome('ai-comms-human-approved-', async (home) => {
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

      let posted: Envelope | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        if (u.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'ana' }), { status: 200 });
        }
        if (u.includes('/collaborators')) {
          return new Response(JSON.stringify([{ login: 'ana' }, { login: 'beto' }]), { status: 200 });
        }
        if (u.includes('/issues/7/comments') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { body: string };
          posted = parseEnvelopeFromContent(body.body) ?? undefined;
          return new Response(JSON.stringify({ id: 900 }), { status: 201 });
        }
        throw new Error(`unexpected fetch: ${method} ${u}`);
      }) as typeof fetch;

      try {
        const server = createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test-client', version: '0.0.0' });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

        process.chdir(cwd);
        let result;
        try {
          result = await client.callTool({
            name: 'bus_send',
            arguments: {
              type: 'answer',
              subject: 're: schema',
              body: 'yes, it does',
              to: ['beto'],
              reply_to: 'ASK1',
              // `project` is passed on purpose — bus_send must not choke on
              // its own extra tool-only params when re-validating the envelope.
              project: 'acme',
              ...(humanApproved !== undefined ? { human_approved: humanApproved } : {}),
            },
          });
        } finally {
          await client.close();
          await server.close();
        }

        assert.ok(posted, 'bus_send must have published an envelope');
        const content = result.content as Array<{ type: string; text?: string }>;
        return { answeredBy: posted!.answered_by, text: content[0]?.text ?? '' };
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  it('publishes answered_by "human" only when human_approved is true', async () => {
    const { answeredBy, text } = await publishAnswer(true);
    assert.equal(answeredBy, 'human');
    assert.match(text, /^Published:/);
  });

  // SPEC-v0.7 §1.1: absent `answered_by` means the same as 'agent' — a
  // v0.6-compatible `bus_send` must not assert it explicitly (that would
  // needlessly bump every plain answer to `v: 2`).
  it('publishes no answered_by (absent, not "agent") for an answer with no human_approved', async () => {
    const { answeredBy } = await publishAnswer(undefined);
    assert.equal(answeredBy, undefined);
  });

  it('publishes no answered_by when human_approved is explicitly false', async () => {
    const { answeredBy } = await publishAnswer(false);
    assert.equal(answeredBy, undefined);
  });
});

describe('bus_team (SPEC-v0.7 §2.4)', () => {
  it('lists the directory plus who you are', async () => {
    await withTempHome('ai-comms-bus-team-', async (home) => {
      const cwd = path.join(home, 'work');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(getConfigDir(), { recursive: true });
      writeFileSync(getConfigPath(), JSON.stringify(sampleConfig(cwd, 9), null, 2) + '\n');
      setGitHubTokenProviderForTests(() => 'gh-test-token');

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        if (u.endsWith('/user')) return new Response(JSON.stringify({ login: 'ana' }), { status: 200 });
        if (u.includes('/collaborators')) {
          return new Response(JSON.stringify([{ login: 'ana' }, { login: 'beto' }]), { status: 200 });
        }
        if (u.includes('/issues/9/comments') && method === 'GET') {
          return new Response(
            JSON.stringify([
              {
                id: 1,
                user: { login: 'beto' },
                updated_at: new Date().toISOString(),
                body: bodyOfProfile({ role: 'backend', areas: ['docs/**'], autoAnswer: true, lastSeen: new Date().toISOString() }),
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

        process.chdir(cwd);
        let result;
        try {
          result = await client.callTool({ name: 'bus_team', arguments: {} });
        } finally {
          await client.close();
          await server.close();
        }

        const content = result.content as Array<{ type: string; text?: string }>;
        const text = content[0]?.text ?? '';
        assert.match(text, /You: ana/);
        assert.match(text, /beto · backend · docs\/\*\*/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe('MCP server instructions mention routing/needs_human/bus_team (SPEC-v0.7 §2.4)', () => {
  it('stays concise while covering the new routing knobs', () => {
    const lines = MCP_SERVER_INSTRUCTIONS.split('\n').filter((l) => l.trim().length > 0);
    assert.ok(lines.length <= 15, `expected <=15 non-empty lines, got ${lines.length}`);
    assert.match(MCP_SERVER_INSTRUCTIONS, /bus_team/);
    assert.match(MCP_SERVER_INSTRUCTIONS, /paths/);
    assert.match(MCP_SERVER_INSTRUCTIONS, /role/);
    assert.match(MCP_SERVER_INSTRUCTIONS, /needs_human/);
  });

  it('createMcpServer(directory) appends the compact directory to the instructions', async () => {
    const server = createMcpServer('Team directory (login — role — areas):\nbeto — backend — docs/**');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const instructions = client.getInstructions() ?? '';
      assert.match(instructions, /Team directory/);
      assert.match(instructions, /beto — backend — docs\/\*\*/);
      assert.ok(instructions.startsWith(MCP_SERVER_INSTRUCTIONS));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('createMcpServer() with no directory matches the plain instructions exactly (backward compatible)', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      assert.equal(client.getInstructions(), MCP_SERVER_INSTRUCTIONS);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
