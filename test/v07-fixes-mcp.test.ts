// Regression tests for the v0.7 review findings fixed in src/mcp.ts,
// src/bus-ask.ts, src/codeowners.ts, and src/envelope.ts:
//
//  1. A failed presence read must degrade to v0.6 behavior, not abort
//     bus_ask/bus_team.
//  2. GitHub logins are case-insensitive: CODEOWNERS/`to`/self-exclusion
//     must all compare (and canonicalize) case-insensitively.
//  3. A thread-matched reply (not a direct reply_to match) must be directed
//     to the asker, not just anyone in a multi-participant thread.
//  4. bus_send must not assert answered_by: 'agent' — absent means agent.
//
// Follows the mocked-fetch + InMemoryTransport pattern in test/v07-routing.test.ts.

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
import { ownersForPaths, type CodeownersRule } from '../src/codeowners.js';
import { findReplyToAsk, resolveAskRecipients } from '../src/bus-ask.js';
import { clearIdentityCacheForTests, clearProfileCacheForTests, createMcpServer } from '../src/mcp.js';

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

function sampleConfig(cwd: string, presence?: number): ConfigV2 {
  return {
    version: 2,
    identity: { dev: 'ana', agent: 'claude-code' },
    defaultProject: 'acme',
    projects: {
      acme: {
        bus: { kind: 'github', repo: 'acme/acme-api', issue: 7, ...(presence !== undefined ? { presence } : {}) },
        repos: [{ name: 'acme-api', path: cwd }],
      },
    },
  };
}

// =========================================================================
// Finding #1: a failed presence read degrades to v0.6, doesn't abort bus_ask
// =========================================================================

describe('bus_ask — a failed presence read degrades to v0.6 (finding #1)', () => {
  it('still sends and waits for the answer with an explicit `to`, even when the presence issue GET returns 500', async () => {
    await withTempHome('ai-comms-presence-500-', async (home) => {
      const cwd = path.join(home, 'work');
      mkdirSync(cwd, { recursive: true });

      mkdirSync(getConfigDir(), { recursive: true });
      writeFileSync(getConfigPath(), JSON.stringify(sampleConfig(cwd, 9), null, 2) + '\n');
      setGitHubTokenProviderForTests(() => 'gh-test-token');

      let askEnvelope: Envelope | undefined;
      let presenceReadCount = 0;
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
        // The presence issue is unreachable — a 5xx, a rate limit, or a
        // deleted presence issue all look the same from here: non-2xx.
        if (u.includes('/issues/9/comments') && method === 'GET') {
          presenceReadCount++;
          return new Response('rate limited', { status: 500 });
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
            { type: 'answer', subject: 're: deploy', body: 'yes, done', to: ['ana'], reply_to: askEnvelope.id },
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
            arguments: { question: 'is the deploy done?', to: ['beto'], timeout_s: 5 },
          });
        } finally {
          await client.close();
          await server.close();
        }

        const content = result.content as Array<{ type: string; text?: string }>;
        const text = content[0]?.text ?? '';

        assert.ok(askEnvelope, 'bus_ask must still publish the ask even though presence is unreachable');
        assert.ok(presenceReadCount > 0, 'sanity: the presence issue really was read and really did fail');
        assert.doesNotMatch(text, /^Error:/, `bus_ask must not error out on a failed presence read: ${text}`);
        assert.match(text, /yes, done/, 'bus_ask must have waited for and returned the answer (v0.6 behavior)');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe('bus_team — reports why the directory is unavailable instead of erroring (finding #1)', () => {
  it('lists collaborators with a "(directory unavailable: ...)" note when the presence read fails', async () => {
    await withTempHome('ai-comms-bus-team-500-', async (home) => {
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
          return new Response('nope', { status: 404 });
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
        assert.match(text, /directory unavailable/);
        assert.match(text, /beto/, 'must still list the plain collaborator, not just the failure');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

// =========================================================================
// Finding #2: case-insensitive logins
// =========================================================================

describe('resolveAskRecipients — case-insensitive CODEOWNERS/`to`/self (finding #2)', () => {
  it('CODEOWNERS @Alice routes to the collaborator "alice" (canonical casing, not the file\'s)', () => {
    const rules: CodeownersRule[] = [{ pattern: '/docs/', owners: ['Alice'] }];
    const outcome = resolveAskRecipients({
      paths: ['docs/x.md'],
      self: 'ana',
      team: ['ana', 'alice'],
      profiles: [],
      codeownersRules: rules,
    });
    assert.deepEqual(outcome, { kind: 'ok', recipients: ['alice'], via: 'CODEOWNERS: alice' });
  });

  it('canonicalizes to a profile\'s login casing when the collaborator list does not have the login', () => {
    const rules: CodeownersRule[] = [{ pattern: '/docs/', owners: ['Alice'] }];
    const outcome = resolveAskRecipients({
      paths: ['docs/x.md'],
      self: 'ana',
      team: [],
      profiles: [{ login: 'alice', areas: [], repos: [], autoAnswer: false, lastSeen: null }],
      codeownersRules: rules,
      collaboratorsUnavailable: true,
    });
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind === 'ok') assert.deepEqual(outcome.recipients, ['alice']);
  });

  it('excludes self case-insensitively from an explicit `to`', () => {
    const outcome = resolveAskRecipients({
      to: ['Ana', 'beto'],
      self: 'ana',
      team: ['ana', 'beto'],
      profiles: [],
      codeownersRules: null,
    });
    assert.deepEqual(outcome, { kind: 'ok', recipients: ['beto'] });
  });

  it('dedupes two differently-cased spellings of the same login into one recipient', () => {
    const outcome = resolveAskRecipients({
      to: ['Beto', 'beto'],
      self: 'ana',
      team: ['ana', 'beto'],
      profiles: [],
      codeownersRules: null,
    });
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind === 'ok') assert.deepEqual(outcome.recipients, ['beto']);
  });
});

describe('codeowners — case-insensitive owner dedupe across rules (finding #2d)', () => {
  it('dedupes owners named with different casing in different matching rules, keeping first-seen casing', () => {
    const rules: CodeownersRule[] = [
      { pattern: 'a/**', owners: ['Alice'] },
      { pattern: 'b/**', owners: ['alice'] },
    ];
    const owners = ownersForPaths(rules, ['a/x.ts', 'b/y.ts']);
    assert.deepEqual(owners, ['Alice']);
  });
});

describe('bus_ask end-to-end — CODEOWNERS @Alice routes to collaborator alice (finding #2)', () => {
  it('publishes the envelope `to` the canonical login, not the CODEOWNERS casing', async () => {
    await withTempHome('ai-comms-codeowners-casing-e2e-', async (home) => {
      const cwd = path.join(home, 'work');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(path.join(cwd, '.git'));
      writeFileSync(path.join(cwd, 'CODEOWNERS'), '/docs/api/ @Alice\n', 'utf8');

      mkdirSync(getConfigDir(), { recursive: true });
      writeFileSync(getConfigPath(), JSON.stringify(sampleConfig(cwd), null, 2) + '\n');
      setGitHubTokenProviderForTests(() => 'gh-test-token');

      let askEnvelope: Envelope | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        if (u.endsWith('/user')) return new Response(JSON.stringify({ login: 'ana' }), { status: 200 });
        if (u.includes('/collaborators')) {
          return new Response(JSON.stringify([{ login: 'ana' }, { login: 'alice' }]), { status: 200 });
        }
        if (u.includes('/issues/7/comments') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { body: string };
          askEnvelope = parseEnvelopeFromContent(body.body) ?? undefined;
          return new Response(JSON.stringify({ id: 500 }), { status: 201 });
        }
        if (u.includes('/issues/7/comments') && method === 'GET') {
          return new Response(JSON.stringify([]), { status: 200 });
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
            arguments: { question: 'what changed?', paths: ['docs/api/openapi.yaml'], timeout_s: 1 },
          });
        } finally {
          await client.close();
          await server.close();
        }

        const content = result.content as Array<{ type: string; text?: string }>;
        const text = content[0]?.text ?? '';
        assert.ok(askEnvelope, 'the ask must have been published');
        assert.deepEqual(askEnvelope!.to, ['alice']);
        assert.match(text, /Resolved via CODEOWNERS: alice/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

// =========================================================================
// Finding #3: a thread-matched reply must be directed to the asker
// =========================================================================

describe('findReplyToAsk — multi-participant thread must be directed to the asker (finding #3)', () => {
  const root = createEnvelope(
    { type: 'ask', subject: 'q1', to: ['bob'] },
    { dev: 'ana', agent: 'claude-code', repo: 'acme-api' },
    { id: 'ASK-ROOT', ts: '2026-09-28T10:00:00Z' },
  );
  const carolFollowUp = createEnvelope(
    { type: 'ask', subject: 'q-carol', to: ['bob'], thread: 'ASK-ROOT' },
    { dev: 'carol', agent: 'claude-code', repo: 'acme-api' },
    { id: 'ASK-CAROL', ts: '2026-09-28T10:05:00Z' },
  );
  const anaFollowUp = createEnvelope(
    { type: 'ask', subject: 'q-ana', to: ['bob'], thread: 'ASK-ROOT' },
    { dev: 'ana', agent: 'claude-code', repo: 'acme-api' },
    { id: 'ASK-ANA', ts: '2026-09-28T10:06:00Z' },
  );
  const answerToCarol = createEnvelope(
    { type: 'answer', subject: 're-carol', to: ['carol'], reply_to: 'ASK-CAROL', thread: 'ASK-ROOT' },
    { dev: 'bob', agent: 'claude-code', repo: 'acme-web' },
    { id: 'ANS-CAROL', ts: '2026-09-28T10:10:00Z' },
  );
  const log = [root, carolFollowUp, anaFollowUp, answerToCarol];

  it('does not hand Bob\'s answer to Carol back as the reply to Ana\'s follow-up', () => {
    const found = findReplyToAsk(log, 'ASK-ANA', {
      threadId: 'ASK-ROOT',
      sinceTs: anaFollowUp.ts,
      self: 'ana',
    });
    assert.equal(found, null);
  });

  it('does match once the actual answer to Ana\'s follow-up arrives', () => {
    const answerToAna = createEnvelope(
      { type: 'answer', subject: 're-ana', to: ['ana'], reply_to: 'ASK-ANA', thread: 'ASK-ROOT' },
      { dev: 'bob', agent: 'claude-code', repo: 'acme-web' },
      { id: 'ANS-ANA', ts: '2026-09-28T10:11:00Z' },
    );
    const found = findReplyToAsk([...log, answerToAna], 'ASK-ANA', {
      threadId: 'ASK-ROOT',
      sinceTs: anaFollowUp.ts,
      self: 'ana',
    });
    assert.equal(found?.id, 'ANS-ANA');
  });

  it('matches case-insensitively (self "Ana" against `to: ["ana"]`)', () => {
    const answerToAna = createEnvelope(
      { type: 'answer', subject: 're-ana', to: ['ana'], reply_to: 'ASK-ANA', thread: 'ASK-ROOT' },
      { dev: 'bob', agent: 'claude-code', repo: 'acme-web' },
      { id: 'ANS-ANA-2', ts: '2026-09-28T10:12:00Z' },
    );
    const found = findReplyToAsk([...log, answerToAna], 'ASK-ANA', {
      threadId: 'ASK-ROOT',
      sinceTs: anaFollowUp.ts,
      self: 'Ana',
    });
    assert.equal(found?.id, 'ANS-ANA-2');
  });

  it('still matches a direct reply_to without a self check, unaffected by the thread rule', () => {
    const answer = createEnvelope(
      { type: 'answer', subject: 're', to: ['carol'], reply_to: 'ASK-CAROL' },
      { dev: 'bob', agent: 'claude-code', repo: 'acme-web' },
      { id: 'ANS-DIRECT' },
    );
    assert.equal(findReplyToAsk([answer], 'ASK-CAROL', { self: 'carol' })?.id, 'ANS-DIRECT');
  });
});

describe('bus_ask end-to-end — a multi-participant thread does not return someone else\'s answer (finding #3)', () => {
  it('times out (pending) rather than showing an answer addressed to someone else in the same thread', async () => {
    await withTempHome('ai-comms-thread-multi-e2e-', async (home) => {
      const cwd = path.join(home, 'work');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(getConfigDir(), { recursive: true });
      writeFileSync(getConfigPath(), JSON.stringify(sampleConfig(cwd), null, 2) + '\n');
      setGitHubTokenProviderForTests(() => 'gh-test-token');

      let askEnvelope: Envelope | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        if (u.endsWith('/user')) return new Response(JSON.stringify({ login: 'ana' }), { status: 200 });
        if (u.includes('/collaborators')) {
          return new Response(
            JSON.stringify([{ login: 'ana' }, { login: 'beto' }, { login: 'carol' }]),
            { status: 200 },
          );
        }
        if (u.includes('/issues/7/comments') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { body: string };
          askEnvelope = parseEnvelopeFromContent(body.body) ?? undefined;
          return new Response(JSON.stringify({ id: 999 }), { status: 201 });
        }
        if (u.includes('/issues/7/comments') && method === 'GET') {
          if (!askEnvelope) return new Response(JSON.stringify([]), { status: 200 });
          // A newer answer in the very same thread — but addressed to carol,
          // not to ana (the asker). Must never be handed back as Ana's reply.
          const threadRoot = askEnvelope.thread ?? askEnvelope.id;
          const answerToCarol = createEnvelope(
            {
              type: 'answer',
              subject: 're',
              body: 'see carol',
              to: ['carol'],
              reply_to: threadRoot,
              thread: threadRoot,
            },
            { dev: 'beto', agent: 'claude-code', repo: 'acme-web' },
          );
          const { content } = renderEnvelope(answerToCarol);
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
              question: 'follow-up from ana',
              to: ['beto'],
              thread: 'THREAD-ROOT-NOT-IN-LOCAL-LOG',
              timeout_s: 1,
            },
          });
        } finally {
          await client.close();
          await server.close();
        }

        const content = result.content as Array<{ type: string; text?: string }>;
        const text = content[0]?.text ?? '';
        assert.doesNotMatch(text, /see carol/i, 'must never surface an answer addressed to someone else');
        assert.match(text, /No answer arrived before the timeout/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

// =========================================================================
// Finding #4: bus_send must not assert answered_by: 'agent'
// =========================================================================

describe('bus_send — human_approved omitted keeps the envelope v:1 (finding #4)', () => {
  it('publishes with no `answered_by` key at all (not "agent") and v:1 when human_approved is omitted', async () => {
    await withTempHome('ai-comms-v1-answer-', async (home) => {
      const cwd = path.join(home, 'work');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(getConfigDir(), { recursive: true });
      writeFileSync(getConfigPath(), JSON.stringify(sampleConfig(cwd), null, 2) + '\n');
      setGitHubTokenProviderForTests(() => 'gh-test-token');

      let posted: Envelope | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        if (u.endsWith('/user')) return new Response(JSON.stringify({ login: 'ana' }), { status: 200 });
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
        try {
          await client.callTool({
            name: 'bus_send',
            arguments: {
              type: 'answer',
              subject: 're: schema',
              body: 'yes, it does',
              to: ['beto'],
              reply_to: 'ASK1',
              project: 'acme',
              // human_approved intentionally omitted.
            },
          });
        } finally {
          await client.close();
          await server.close();
        }

        assert.ok(posted, 'bus_send must have published an envelope');
        assert.equal('answered_by' in posted!, false, 'answered_by must be absent, not "agent"');
        assert.equal(posted!.v, 1, 'no v0.7-only field is set, so the envelope must stay v:1');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
