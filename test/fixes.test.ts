import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { validateRecipients } from '../src/context.js';
import { ingestEnvelope } from '../src/daemon.js';
import { createEnvelope } from '../src/envelope.js';
import {
  findClaimConflicts,
  formatActiveClaim,
  formatClaimConflict,
  formatInboxForDisplay,
  loadLog,
  materializeActiveClaims,
} from '../src/store.js';
import { formatDuration, overlapRemainingMs } from '../src/time.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

function withTempHome(fn: (home: string) => void): void {
  const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-fixes-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fn(home);
  } finally {
    if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
    else delete process.env.HOME;
    if (ORIGINAL_USERPROFILE) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
    else delete process.env.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  }
}

describe('daemon persists own envelopes', () => {
  it('writes own envelopes to log.jsonl but does not notify', () => {
    withTempHome((home) => {
      const project = 'acme';
      const projectDir = path.join(home, '.ai-comms', 'projects', project);
      mkdirSync(projectDir, { recursive: true });

      const own = createEnvelope(
        {
          type: 'claim',
          subject: 'my paths',
          refs: { paths: ['src/**'], until: '2026-09-16T21:00:00Z' },
        },
        { dev: 'ana', agent: 'cursor', repo: 'acme-api' },
        { id: 'OWN1', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
      );

      const { notified } = ingestEnvelope(own, project, 'ana');
      assert.equal(notified, false);

      const log = loadLog(project);
      assert.equal(log.length, 1);
      assert.equal(log[0]!.id, 'OWN1');

      const now = new Date('2026-09-16T15:00:00Z');
      const claims = materializeActiveClaims(log, now);
      assert.equal(claims.length, 1);
      assert.equal(claims[0]!.dev, 'ana');
    });
  });

  it('notifies for foreign envelopes', () => {
    withTempHome(() => {
      const foreign = createEnvelope(
        { type: 'ask', subject: 'help', to: ['ana'] },
        { dev: 'beto', agent: 'cursor', repo: 'acme-api' },
        { id: 'F1', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
      );

      const { notified } = ingestEnvelope(foreign, 'acme', 'ana');
      assert.equal(notified, true);
    });
  });
});

describe('claim overlap formatting', () => {
  const now = new Date('2026-09-16T12:03:00Z');

  it('reports explicit overlap duration between two active claims', () => {
    const other = createEnvelope(
      {
        type: 'claim',
        subject: 'theirs',
        refs: { paths: ['src/overlap/**'], until: '2026-09-16T15:00:00Z' },
      },
      { dev: 'beto', agent: 'cursor', repo: 'acme' },
      { id: 'OTHER', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    const newUntil = '2026-09-16T18:00:00Z';
    const conflicts = findClaimConflicts(
      ['src/overlap/**'],
      'ana',
      'acme',
      [other],
      { now, newUntil },
    );

    assert.equal(conflicts.length, 1);
    const expectedMs = overlapRemainingMs(newUntil, '2026-09-16T15:00:00Z', now);
    assert.equal(conflicts[0]!.overlapRemaining, formatDuration(expectedMs));
    assert.equal(conflicts[0]!.overlapRemaining, '2h57m');

    const line = formatClaimConflict(conflicts[0]!);
    assert.match(line, /both active now, overlap 2h57m/);
  });

  it('formats active claims with remaining time instead of bare until', () => {
    const claim = createEnvelope(
      {
        type: 'claim',
        subject: 'etl',
        refs: { paths: ['src/**'], until: '2026-09-16T21:00:00Z' },
      },
      { dev: 'beto', agent: 'cursor', repo: 'acme' },
      { id: 'C1', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    const line = formatActiveClaim(
      materializeActiveClaims([claim], now)[0]!,
      now,
    );
    assert.match(line, /active 8h57m/);
    assert.doesNotMatch(line, /until=/);
  });
});

describe('recipient validation', () => {
  const ask = createEnvelope(
    { type: 'ask', subject: 'question', to: ['beto'] },
    { dev: 'beto', agent: 'cursor', repo: 'acme' },
    { id: 'ASK1', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
  );

  it('allows reply_to author even when not in team roster', () => {
    const warnings = validateRecipients(['beto'], ['ana'], 'ana', {
      log: [ask],
      replyTo: 'ASK1',
    });
    assert.deepEqual(warnings, []);
  });

  it('warns for unknown roster recipient but does not block', () => {
    const warnings = validateRecipients(['caro'], ['ana', 'beto'], 'ana');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /not in team roster/);
    assert.match(warnings[0]!, /sending directed anyway/);
  });

  it('preserves directed to field in envelope creation', () => {
    const envelope = createEnvelope(
      { type: 'need', subject: 'help', to: ['caro'] },
      { dev: 'ana', agent: 'cursor', repo: 'acme' },
    );
    assert.deepEqual(envelope.to, ['caro']);
  });
});

describe('inbox released claim association', () => {
  it('marks released claims and links them to their release', () => {
    const claim = createEnvelope(
      {
        type: 'claim',
        subject: 'temp',
        to: ['*'],
        refs: { paths: ['src/**'], until: '2026-09-16T21:00:00Z' },
      },
      { dev: 'beto', agent: 'cursor', repo: 'acme' },
      { id: 'C1', ts: '2026-09-16T12:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );
    const release = createEnvelope(
      {
        type: 'release',
        subject: 'done',
        to: ['*'],
        reply_to: 'C1',
      },
      { dev: 'beto', agent: 'cursor', repo: 'acme' },
      { id: 'R1', ts: '2026-09-16T13:00:00Z', ttl: '2026-09-17T12:00:00Z' },
    );

    const log = [claim, release];
    const formatted = formatInboxForDisplay([claim, release], log);

    assert.match(formatted, /\[released — see release R1 @ 2026-09-16T13:00:00Z\]/);
    assert.match(formatted, /\[releases claim C1\]/);
    assert.ok(formatted.includes('"id": "C1"') || formatted.includes('"id":"C1"'));
    assert.ok(formatted.includes('"id": "R1"') || formatted.includes('"id":"R1"'));
  });
});
