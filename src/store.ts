import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
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
  lastMessageId: string;
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

export function appendEnvelope(
  envelope: Envelope,
  project: string,
  existing?: Envelope[],
): void {
  const logPath = getProjectLogPath(project);
  const known = existing ?? loadLog(project);
  if (known.some((e) => e.id === envelope.id)) return;
  ensureProjectDir(project);
  appendFileSync(logPath, JSON.stringify(envelope) + '\n', 'utf8');
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
  const released = new Set<string>();
  const claims: ActiveClaim[] = [];

  for (const env of envelopes) {
    if (env.type === 'release' && env.reply_to) {
      released.add(env.reply_to);
    }
  }

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
  const map = new Map<string, Envelope>();
  for (const env of envelopes) {
    if (env.type === 'release' && env.reply_to) {
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
