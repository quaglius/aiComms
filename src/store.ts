import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  getConfigDir,
  getProjectCursorPath,
  getProjectDaemonLogPath,
  getProjectDaemonPidPath,
  getProjectDir,
  getProjectLogPath,
  getProjectReadPath,
} from './paths.js';
import {
  type Envelope,
  EnvelopeSchema,
  globsOverlap,
  isDirectedTo,
  isExpired,
  isHopsBlocked,
} from './envelope.js';
import { formatDuration, formatRemaining, overlapRemainingMs } from './time.js';

export interface CursorState {
  lastMessageId?: string;
  lastSince?: string;
  etag?: string;
}

export interface ReadState {
  ids: string[];
}

export interface ActiveClaim {
  id: string;
  dev: string;
  agent: string;
  repo: string;
  paths: string[];
  until: string;
  subject: string;
}

export interface ClaimConflict {
  claimId: string;
  dev: string;
  agent: string;
  repo: string;
  paths: string[];
  until: string;
  overlapRemaining: string;
}

function ensureProjectDir(project: string): void {
  mkdirSync(getProjectDir(project), { recursive: true });
}

/**
 * Append an envelope to the project log, deduping by id.
 *
 * Returns whether it was actually appended (`false` for a duplicate). Callers
 * that trigger side effects on ingest — auto-answer, desktop notifications —
 * must only do so when this returns `true`: a re-ingest (backfill overlap, a
 * daemon restart replaying the backlog, two polls racing) must not relaunch
 * the answerer or notify a second time for a message already handled.
 */
export function appendEnvelope(
  envelope: Envelope,
  project: string,
  existing?: Envelope[],
): boolean {
  const logPath = getProjectLogPath(project);
  const known = existing ?? loadLog(project);
  if (known.some((e) => e.id === envelope.id)) return false;
  ensureProjectDir(project);
  appendFileSync(logPath, JSON.stringify(envelope) + '\n', 'utf8');
  return true;
}

export function loadLog(project: string): Envelope[] {
  const logPath = getProjectLogPath(project);
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const envelopes: Envelope[] = [];
  for (const line of lines) {
    try {
      const parsed = EnvelopeSchema.parse(JSON.parse(line));
      envelopes.push(parsed);
    } catch {
      // corrupt line: skip
    }
  }
  return envelopes;
}

export function loadCursor(project: string): CursorState | null {
  const cursorPath = getProjectCursorPath(project);
  if (!existsSync(cursorPath)) return null;
  try {
    return JSON.parse(readFileSync(cursorPath, 'utf8')) as CursorState;
  } catch {
    return null;
  }
}

export function saveCursor(project: string, state: CursorState): void {
  ensureProjectDir(project);
  writeFileSync(getProjectCursorPath(project), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function loadReadState(project: string): ReadState {
  const readPath = getProjectReadPath(project);
  if (!existsSync(readPath)) return { ids: [] };
  try {
    const raw = JSON.parse(readFileSync(readPath, 'utf8')) as ReadState;
    return { ids: Array.isArray(raw.ids) ? raw.ids : [] };
  } catch {
    return { ids: [] };
  }
}

export function saveReadState(project: string, state: ReadState): void {
  ensureProjectDir(project);
  writeFileSync(getProjectReadPath(project), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function markRead(project: string, ids: string[]): void {
  const state = loadReadState(project);
  const merged = new Set([...state.ids, ...ids]);
  saveReadState(project, { ids: [...merged] });
}

export function getLogLastModified(project: string): Date | null {
  const logPath = getProjectLogPath(project);
  if (!existsSync(logPath)) return null;
  return statSync(logPath).mtime;
}

export function isDaemonRunning(project: string): boolean {
  const pidPath = getProjectDaemonPidPath(project);
  if (!existsSync(pidPath)) return false;
  try {
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeDaemonPid(project: string, pid = process.pid): void {
  ensureProjectDir(project);
  writeFileSync(getProjectDaemonPidPath(project), String(pid) + '\n', 'utf8');
}

export function removeDaemonPid(project: string): void {
  const pidPath = getProjectDaemonPidPath(project);
  if (existsSync(pidPath)) {
    try {
      writeFileSync(pidPath, '');
    } catch {
      // ignore
    }
  }
}

export function getDaemonLogPath(project: string): string {
  return getProjectDaemonLogPath(project);
}

export function materializeActiveClaims(
  envelopes: Envelope[],
  now = new Date(),
): ActiveClaim[] {
  const claimsById = new Map<string, Envelope>();
  for (const env of envelopes) {
    if (env.type === 'claim') claimsById.set(env.id, env);
  }

  // Identity is authenticated by the transport, so a release only counts when
  // it comes from the same dev who made the claim — otherwise anyone on the
  // bus could release anyone else's claim just by posting a `release`.
  const released = new Set<string>();
  for (const env of envelopes) {
    if (env.type !== 'release' || !env.reply_to) continue;
    const claim = claimsById.get(env.reply_to);
    if (claim && claim.from.dev === env.from.dev) {
      released.add(env.reply_to);
    }
  }

  const claims: ActiveClaim[] = [];
  for (const env of envelopes) {
    if (env.type !== 'claim') continue;
    if (released.has(env.id)) continue;
    if (!env.refs.paths?.length || !env.refs.until) continue;
    if (new Date(env.refs.until) <= now) continue;

    claims.push({
      id: env.id,
      dev: env.from.dev,
      agent: env.from.agent,
      repo: env.from.repo,
      paths: env.refs.paths,
      until: env.refs.until,
      subject: env.subject,
    });
  }

  return claims;
}

export function findClaimConflicts(
  paths: string[],
  dev: string,
  repo: string,
  envelopes: Envelope[],
  options: { now?: Date; newUntil?: string } = {},
): ClaimConflict[] {
  const now = options.now ?? new Date();
  const newUntil = options.newUntil;
  const active = materializeActiveClaims(envelopes, now);
  const conflicts: ClaimConflict[] = [];

  for (const claim of active) {
    if (claim.dev === dev) continue;
    if (claim.repo !== repo) continue;
    if (globsOverlap(paths, claim.paths)) {
      const overlapMs =
        newUntil != null
          ? overlapRemainingMs(newUntil, claim.until, now)
          : overlapRemainingMs(claim.until, claim.until, now);
      conflicts.push({
        claimId: claim.id,
        dev: claim.dev,
        agent: claim.agent,
        repo: claim.repo,
        paths: claim.paths,
        until: claim.until,
        overlapRemaining: formatDuration(overlapMs),
      });
    }
  }

  return conflicts;
}

export function formatActiveClaim(claim: ActiveClaim, now = new Date()): string {
  const remaining = formatRemaining(claim.until, now);
  return `${claim.id} · ${claim.dev}/${claim.agent} · ${claim.repo} · active ${remaining} · paths=${claim.paths.join(', ')} · ${claim.subject}`;
}

export function formatClaimConflict(conflict: ClaimConflict): string {
  return (
    `- ${conflict.claimId} (${conflict.dev}/${conflict.agent} · ${conflict.repo}) ` +
    `paths=${conflict.paths.join(', ')} — both active now, overlap ${conflict.overlapRemaining}`
  );
}

function releasesByClaimId(envelopes: Envelope[]): Map<string, Envelope> {
  const claimsById = new Map<string, Envelope>();
  for (const env of envelopes) {
    if (env.type === 'claim') claimsById.set(env.id, env);
  }

  // Same rule as materializeActiveClaims: only the claim's own author can
  // release it, so the inbox must not show someone else's release as valid.
  const map = new Map<string, Envelope>();
  for (const env of envelopes) {
    if (env.type !== 'release' || !env.reply_to) continue;
    const claim = claimsById.get(env.reply_to);
    if (claim && claim.from.dev === env.from.dev) {
      map.set(env.reply_to, env);
    }
  }
  return map;
}

export function formatInboxForDisplay(inbox: Envelope[], log: Envelope[]): string {
  if (inbox.length === 0) return '(empty)';

  const releases = releasesByClaimId(log);

  return inbox
    .map((env) => {
      const lines: string[] = [];
      if (env.type === 'claim' && releases.has(env.id)) {
        const release = releases.get(env.id)!;
        lines.push(`[released — see release ${release.id} @ ${release.ts}]`);
      }
      if (env.type === 'release' && env.reply_to) {
        lines.push(`[releases claim ${env.reply_to}]`);
      }
      lines.push(JSON.stringify(env, null, 2));
      return lines.join('\n');
    })
    .join('\n\n');
}

export function materializeInbox(
  envelopes: Envelope[],
  dev: string,
  options: {
    since?: string;
    unreadOnly?: boolean;
    now?: Date;
    readState?: ReadState;
  } = {},
): Envelope[] {
  const now = options.now ?? new Date();
  const readSet = new Set((options.readState ?? { ids: [] }).ids);
  const sinceDate = options.since ? new Date(options.since) : null;

  return envelopes.filter((env) => {
    if (env.from.dev === dev) return false;
    if (!isDirectedTo(env, dev)) return false;
    if (isExpired(env, now)) return false;
    if (isHopsBlocked(env)) return false;
    if (sinceDate && new Date(env.ts) < sinceDate) return false;
    if (options.unreadOnly && readSet.has(env.id)) return false;
    return true;
  });
}

export function isLogStale(
  project: string,
  staleMs = 5 * 60 * 1000,
  now = Date.now(),
): boolean {
  const mtime = getLogLastModified(project);
  if (!mtime) return true;
  return now - mtime.getTime() > staleMs;
}

export function isAnyDaemonRunning(projects: string[]): boolean {
  return projects.some((p) => isDaemonRunning(p));
}

export function getDaemonLockPath(): string {
  return path.join(getConfigDir(), 'daemon.lock');
}

function readDaemonLockPid(): number | null {
  const lockPath = getDaemonLockPath();
  if (!existsSync(lockPath)) return null;
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` belongs to a live process.
 *
 * Signal 0 sends nothing — it only probes. ESRCH ("no such process") or a
 * permission error both mean it is safe to treat the pid as gone; anything
 * that does not throw means it is still alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type DaemonLockResult = { acquired: true } | { acquired: false; pid: number };

/**
 * Single-instance lock for the daemon.
 *
 * Two daemons watching the same bus — an autostarted one plus a manually run
 * one, or a laptop and a desktop both online — each answer the same question,
 * doubling every auto-answer. The lock file holds the owning pid: a stale one
 * (its process no longer alive) is taken over rather than treated as a
 * conflict, so a daemon that crashed or was killed -9 doesn't permanently
 * block a new one from starting.
 */
export function acquireDaemonLock(
  pid = process.pid,
  isAliveFn: (pid: number) => boolean = isPidAlive,
): DaemonLockResult {
  mkdirSync(getConfigDir(), { recursive: true });
  const existingPid = readDaemonLockPid();
  if (existingPid != null && existingPid !== pid && isAliveFn(existingPid)) {
    return { acquired: false, pid: existingPid };
  }
  writeFileSync(getDaemonLockPath(), String(pid) + '\n', 'utf8');
  return { acquired: true };
}

/**
 * Releases the lock, but only if it still names this pid — a lock already
 * taken over by a newer daemon (because this one went stale) must not be
 * deleted out from under that newer daemon on this one's shutdown.
 */
export function releaseDaemonLock(pid = process.pid): void {
  if (readDaemonLockPid() !== pid) return;
  try {
    unlinkSync(getDaemonLockPath());
  } catch {
    // ignore
  }
}
