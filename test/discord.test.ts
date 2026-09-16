import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { Envelope } from '../src/envelope.js';
import { createEnvelope } from '../src/envelope.js';

describe('discord REST send', () => {
  it('sends with Authorization Bot and respects truncation', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: '999' }), { status: 200 });
    }) as typeof fetch;

    try {
      const { sendEnvelope } = await import('../src/discord.js');
      const envelope = createEnvelope(
        { type: 'fyi', subject: 'test rest', body: 'hello' },
        { dev: 'dani', agent: 'cursor', repo: 'ai-comms' },
      );

      const result = await sendEnvelope(envelope, 'chan123', 'fake-token');
      assert.equal(result.id, '999');
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /channels\/chan123\/messages$/);

      const headers = calls[0]!.init.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bot fake-token');

      const body = JSON.parse(String(calls[0]!.init.body)) as { content: string };
      assert.ok(body.content.includes('```json'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries on 429 up to 3 times', async () => {
    let attempts = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = mock.fn(async () => {
      attempts++;
      if (attempts < 3) {
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return new Response(JSON.stringify({ id: '1' }), { status: 200 });
    }) as typeof fetch;

    try {
      const { sendEnvelope } = await import('../src/discord.js');
      const envelope = createEnvelope(
        { type: 'done', subject: 'ok' },
        { dev: 'dani', agent: 'cursor', repo: 'ai-comms' },
      );
      await sendEnvelope(envelope, 'c', 't');
      assert.equal(attempts, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('doctor without config', () => {
  it('returns a clear error without stack trace', async () => {
    const originalExit = process.exitCode;
    const stderr: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    const { ConfigError, getConfigPath } = await import('../src/config.js');

    try {
      assert.throws(() => {
        throw new ConfigError(
          `No config found at ${getConfigPath()}. Run "ai-comms init" to create one.`,
        );
      });

      const output = stderr.join('');
      assert.ok(!output.includes('at '));
    } finally {
      process.stderr.write = originalWrite;
      process.exitCode = originalExit;
    }
  });
});

describe('parseEnvelopeFromMessage tolerance', () => {
  it('returns null for human messages without json', async () => {
    const { parseEnvelopeFromMessage } = await import('../src/envelope.js');
    assert.equal(parseEnvelopeFromMessage('hey team, check the PR when you can'), null);
    assert.equal(parseEnvelopeFromMessage('```json\n{not json}\n```'), null);
  });
});
