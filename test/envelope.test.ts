import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createEnvelope,
  EnvelopeSchema,
  globsOverlap,
  isExpired,
  isHopsBlocked,
  isDirectedTo,
  parseEnvelopeFromMessage,
  renderEnvelope,
  validateClaimInput,
} from '../src/envelope.js';
import {
  findClaimConflicts,
  materializeActiveClaims,
  materializeInbox,
} from '../src/store.js';

const sampleFrom = { dev: 'ana', agent: 'claude-code', repo: 'acme' };

describe('envelope render/parse round-trip', () => {
  it('preserva el sobre completo', () => {
    const envelope = createEnvelope(
      {
        type: 'fyi',
        subject: 'decisión tomada',
        body: 'ver `src/foo.ts`',
        refs: {
          branch: 'feat/x',
          pr: 'https://github.com/acme/acme-web/pull/7',
        },
      },
      sampleFrom,
      {
        id: '01J8TEST000000000000000001',
        ts: '2026-09-16T12:00:00Z',
        ttl: '2026-09-17T12:00:00Z',
      },
    );

    const { content, truncated } = renderEnvelope(envelope);
    assert.equal(truncated, false);

    const parsed = parseEnvelopeFromMessage(content);
    assert.deepEqual(parsed, envelope);
  });

  it('serializa el sobre compacto, sin indentar', () => {
    const envelope = createEnvelope(
      { type: 'fyi', subject: 'compacto' },
      sampleFrom,
      {
        id: '01J8TEST000000000000000009',
        ts: '2026-09-16T12:00:00Z',
        ttl: '2026-09-17T12:00:00Z',
      },
    );

    const { content } = renderEnvelope(envelope);
    assert.ok(content.includes('{"v":1,'), 'el JSON debe ir compacto');
    assert.ok(!content.includes('\n  "v": 1'), 'no debe ir indentado');
    assert.deepEqual(parseEnvelopeFromMessage(content), envelope);
  });


  it('trunca body cuando supera 1900 chars', () => {
    const longBody = 'z'.repeat(600);
    const envelope = createEnvelope(
      {
        type: 'contract',
        subject: 'S'.repeat(120),
        body: longBody,
        refs: {
          branch: 'feat/' + 'branch-name-'.repeat(8),
          paths: Array.from({ length: 12 }, (_, i) => `src/pkg-${i}/${'dir/'.repeat(6)}**`),
        },
      },
      {
        dev: 'developer-with-long-slug',
        agent: 'claude-code-enterprise',
        repo: 'acme-monorepo-v2',
      },
      {
        id: '01J8TEST000000000000000002',
        ts: '2026-09-16T12:00:00Z',
        ttl: '2026-09-17T12:00:00Z',
      },
    );

    const { content, truncated } = renderEnvelope(envelope);
    assert.equal(truncated, true);
    assert.ok(content.length <= 1900);

    const parsed = parseEnvelopeFromMessage(content);
    assert.ok(parsed);
    assert.ok(parsed!.body.endsWith('…'));
    assert.ok(parsed!.body.length < longBody.length);
  });
});

describe('schema validation', () => {
  it('acepta campos opcionales mínimos', () => {
    const env = createEnvelope({ type: 'done', subject: 'mergeado' }, sampleFrom);
    assert.doesNotThrow(() => EnvelopeSchema.parse(env));
  });

  it('rechaza tipo desconocido', () => {
    assert.throws(() =>
      EnvelopeSchema.parse({
        v: 1,
        id: '01J8X',
        ts: '2026-09-16T12:00:00Z',
        from: sampleFrom,
        to: ['*'],
        type: 'ping',
        subject: 'hola',
        body: '',
        refs: {},
        reply_to: null,
        hops: 0,
        ttl: '2026-09-17T12:00:00Z',
      }),
    );
  });

  it('rechaza subject demasiado largo', () => {
    assert.throws(() =>
      createEnvelope({ type: 'ask', subject: 'a'.repeat(121) }, sampleFrom),
    );
  });

  it('validateClaimInput exige paths y until', () => {
    assert.equal(
      validateClaimInput({ type: 'claim', subject: 'reservo', refs: {} }),
      'claim requiere refs.paths con al menos un glob',
    );
    assert.equal(
      validateClaimInput({
        type: 'claim',
        subject: 'reservo',
        refs: { paths: ['src/**'] },
      }),
      'claim requiere refs.until',
    );
    assert.equal(
      validateClaimInput({
        type: 'claim',
        subject: 'reservo',
        refs: { paths: ['src/**'], until: '2026-09-17T12:00:00Z' },
      }),
      null,
    );
  });
});

describe('claims materialization', () => {
  const now = new Date('2026-09-16T15:00:00Z');

  it('lista claims vigentes con dueño y vencimiento', () => {
    const claim = createEnvelope(
      {
        type: 'claim',
        subject: 'etl',
        refs: { paths: ['src/analytics/**'], until: '2026-09-16T21:00:00Z' },
      },
      { dev: 'beto', agent: 'cursor', repo: 'acme' },
      { id: 'CLAIM1', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    const active = materializeActiveClaims([claim], now);
    assert.equal(active.length, 1);
    assert.equal(active[0]!.dev, 'beto');
    assert.equal(active[0]!.until, '2026-09-16T21:00:00Z');
  });

  it('excluye claims vencidos', () => {
    const claim = createEnvelope(
      {
        type: 'claim',
        subject: 'viejo',
        refs: { paths: ['src/**'], until: '2026-09-16T10:00:00Z' },
      },
      sampleFrom,
      { id: 'OLD', ts: '2026-09-15T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    assert.equal(materializeActiveClaims([claim], now).length, 0);
  });

  it('excluye claims liberados', () => {
    const claim = createEnvelope(
      {
        type: 'claim',
        subject: 'temp',
        refs: { paths: ['src/**'], until: '2026-09-16T21:00:00Z' },
      },
      sampleFrom,
      { id: 'C1', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );
    const release = createEnvelope(
      {
        type: 'release',
        subject: 'libero',
        reply_to: 'C1',
      },
      sampleFrom,
      { id: 'R1', ts: '2026-09-16T13:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    assert.equal(materializeActiveClaims([claim, release], now).length, 0);
  });

  it('detecta solapamiento de globs', () => {
    assert.ok(globsOverlap(['src/analytics/**'], ['src/analytics/etl/**']));
    assert.ok(!globsOverlap(['src/a/**'], ['src/b/**']));
  });

  it('findClaimConflicts ignora claims propios', () => {
    const own = createEnvelope(
      {
        type: 'claim',
        subject: 'mio',
        refs: { paths: ['src/**'], until: '2026-09-16T21:00:00Z' },
      },
      sampleFrom,
      { id: 'OWN', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    const ownOnly = findClaimConflicts(
      ['src/overlap/**'],
      'ana',
      'acme',
      [own],
      now,
    );
    assert.equal(ownOnly.length, 0);

    const other = createEnvelope(
      {
        type: 'claim',
        subject: 'ajeno',
        refs: { paths: ['src/overlap/**'], until: '2026-09-16T22:00:00Z' },
      },
      { dev: 'beto', agent: 'cursor', repo: 'acme' },
      { id: 'OTHER', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    const conflicts = findClaimConflicts(
      ['src/overlap/**'],
      'ana',
      'acme',
      [own, other],
      now,
    );
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.dev, 'beto');
  });

  it('no conflictúa entre repos distintos con el mismo glob', () => {
    // internal/** existe tanto en acme-api como en acme-web.
    const enCore = createEnvelope(
      {
        type: 'claim',
        subject: 'etl en core',
        refs: { paths: ['internal/**'], until: '2026-09-16T22:00:00Z' },
      },
      { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
      { id: 'CORE', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    const mismoRepo = findClaimConflicts(
      ['internal/**'],
      'ana',
      'acme-api',
      [enCore],
      now,
    );
    assert.equal(mismoRepo.length, 1);
    assert.equal(mismoRepo[0]!.repo, 'acme-api');

    const otroRepo = findClaimConflicts(
      ['internal/**'],
      'ana',
      'acme-web',
      [enCore],
      now,
    );
    assert.equal(otroRepo.length, 0);
  });
});

describe('inbox filters', () => {
  const now = new Date('2026-09-16T15:00:00Z');

  it('corta por TTL vencido', () => {
    const expired = createEnvelope(
      { type: 'ask', subject: 'viejo', to: ['ana'] },
      { dev: 'beto', agent: 'cursor', repo: 'x' },
      {
        id: 'E1',
        ts: '2026-09-15T12:00:00Z',
        ttl: '2026-09-15T13:00:00Z',
      },
    );

    const inbox = materializeInbox([expired], 'ana', { now });
    assert.equal(inbox.length, 0);
    assert.equal(isExpired(expired, now), true);
  });

  it('corta por hops >= 3', () => {
    const blocked = createEnvelope(
      { type: 'need', subject: 'blocked', to: ['ana'] },
      { dev: 'beto', agent: 'cursor', repo: 'x' },
      {
        id: 'H1',
        ts: '2026-09-16T12:00:00Z',
        ttl: '2026-09-17T12:00:00Z',
        hops: 3,
      },
    );

    assert.equal(isHopsBlocked(blocked), true);
    const inbox = materializeInbox([blocked], 'ana', { now });
    assert.equal(inbox.length, 0);
  });

  it('incluye broadcast * y excluye propios', () => {
    const foreign = createEnvelope(
      { type: 'fyi', subject: 'broadcast', to: ['*'] },
      { dev: 'beto', agent: 'cursor', repo: 'x' },
      { id: 'F1', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );
    const own = createEnvelope(
      { type: 'fyi', subject: 'propio', to: ['*'] },
      sampleFrom,
      { id: 'F2', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    const inbox = materializeInbox([foreign, own], 'ana', { now });
    assert.equal(inbox.length, 1);
    assert.equal(isDirectedTo(foreign, 'ana'), true);
  });
});
