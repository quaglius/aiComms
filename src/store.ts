import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import {
  type Envelope,
  EnvelopeSchema,
  globsOverlap,
  isDirectedTo,
  isExpired,
  isHopsBlocked,
} from './envelope.js';

export const LOG_PATH = path.join(CONFIG_DIR, 'log.jsonl');
export const CURSOR_PATH = path.join(CONFIG_DIR, 'cursor.json');
export const READ_PATH = path.join(CONFIG_DIR, 'read.json');
export const DAEMON_LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');
export const DAEMON_PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');

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
}

function ensureDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

export function appendEnvelope(
  envelope: Envelope,
  logPath = LOG_PATH,
  existing?: Envelope[],
): void {
  const known = existing ?? loadLog(logPath);
  if (known.some((e) => e.id === envelope.id)) return;
  ensureDir();
  appendFileSync(logPath, JSON.stringify(envelope) + '\n', 'utf8');
}

export function loadLog(logPath = LOG_PATH): Envelope[] {
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const envelopes: Envelope[] = [];
  for (const line of lines) {
    try {
      const parsed = EnvelopeSchema.parse(JSON.parse(line));
      envelopes.push(parsed);
    } catch {
      // línea corrupta: ignorar
    }
  }
  return envelopes;
}

export function loadCursor(cursorPath = CURSOR_PATH): CursorState | null {
  if (!existsSync(cursorPath)) return null;
  try {
    return JSON.parse(readFileSync(cursorPath, 'utf8')) as CursorState;
  } catch {
    return null;
  }
}

export function saveCursor(state: CursorState, cursorPath = CURSOR_PATH): void {
  ensureDir();
  writeFileSync(cursorPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function loadReadState(readPath = READ_PATH): ReadState {
  if (!existsSync(readPath)) return { ids: [] };
  try {
    const raw = JSON.parse(readFileSync(readPath, 'utf8')) as ReadState;
    return { ids: Array.isArray(raw.ids) ? raw.ids : [] };
  } catch {
    return { ids: [] };
  }
}

export function saveReadState(state: ReadState, readPath = READ_PATH): void {
  ensureDir();
  writeFileSync(readPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function markRead(ids: string[], readPath = READ_PATH): void {
  const state = loadReadState(readPath);
  const merged = new Set([...state.ids, ...ids]);
  saveReadState({ ids: [...merged] }, readPath);
}

export function getLogLastModified(logPath = LOG_PATH): Date | null {
  if (!existsSync(logPath)) return null;
  return statSync(logPath).mtime;
}

export function isDaemonRunning(pidPath = DAEMON_PID_PATH): boolean {
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

export function writeDaemonPid(pid = process.pid, pidPath = DAEMON_PID_PATH): void {
  ensureDir();
  writeFileSync(pidPath, String(pid) + '\n', 'utf8');
}

export function removeDaemonPid(pidPath = DAEMON_PID_PATH): void {
  if (existsSync(pidPath)) {
    try {
      writeFileSync(pidPath, '');
    } catch {
      // ignore
    }
  }
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
  now = new Date(),
): ClaimConflict[] {
  const active = materializeActiveClaims(envelopes, now);
  const conflicts: ClaimConflict[] = [];

  for (const claim of active) {
    if (claim.dev === dev) continue;
    // Los globs de un claim son relativos a su repo. Un proyecto puede
    // abarcar varios repos donde la misma ruta existe en más de uno:
    // comparar globs entre repos produce conflictos falsos.
    if (claim.repo !== repo) continue;
    if (globsOverlap(paths, claim.paths)) {
      conflicts.push({
        claimId: claim.id,
        dev: claim.dev,
        agent: claim.agent,
        repo: claim.repo,
        paths: claim.paths,
        until: claim.until,
      });
    }
  }

  return conflicts;
}

export function materializeInbox(
  envelopes: Envelope[],
  dev: string,
  options: { since?: string; unreadOnly?: boolean; now?: Date } = {},
): Envelope[] {
  const now = options.now ?? new Date();
  const read = loadReadState();
  const readSet = new Set(read.ids);
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
  logPath = LOG_PATH,
  staleMs = 5 * 60 * 1000,
  now = Date.now(),
): boolean {
  const mtime = getLogLastModified(logPath);
  if (!mtime) return true;
  return now - mtime.getTime() > staleMs;
}
