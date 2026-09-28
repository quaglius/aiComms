import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { getConfigDir, getProjectDir } from './paths.js';
import { loadConfig, type ConfigV2, type AutoAnswerConfig } from './config.js';
import { resolveContext } from './context.js';
import { loadLog } from './store.js';
import { isDirectedTo, isExpired, threadOf, type Envelope } from './envelope.js';
import { SECURITY_PREAMBLE } from './preamble.js';
import { quoteShellArg, resolveCliInvocation } from './cli-path.js';

// --- Identity cache (SPEC-v0.7 §2.7) ----------------------------------------
//
// The hook must never touch the network (it has to run in well under 300ms,
// on every prompt). Identity is normally resolved by asking the transport
// ("who am I on GitHub"), which is a network call — so instead we cache the
// last-known login here, written by `rememberIdentity` whenever the MCP
// server or daemon resolves it for real, and fall back to
// `config.identity?.dev` (the legacy Discord identity) if we've never cached
// one yet.

interface IdentityFile {
  login: string;
  updatedAt: string;
}

function getIdentityPath(): string {
  return path.join(getConfigDir(), 'identity.json');
}

/**
 * Remembers the authenticated login for the hook to read later, without any
 * network access of its own.
 *
 * Not yet wired up to a caller — see the integration report. It should be
 * called from `getCachedIdentity` in src/mcp.ts (after `transport.whoami()`
 * resolves) and from the daemon's own identity resolution, so the cache
 * stays fresh whenever either process is running.
 */
export function rememberIdentity(login: string): void {
  const trimmed = login.trim();
  if (!trimmed) return;
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    const payload: IdentityFile = { login: trimmed, updatedAt: new Date().toISOString() };
    writeFileSync(getIdentityPath(), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch {
    // Best-effort cache only — never break the caller (an MCP tool call or a
    // daemon poll) over a local file write.
  }
}

function readCachedLogin(): string {
  try {
    const raw = JSON.parse(readFileSync(getIdentityPath(), 'utf8')) as Partial<IdentityFile>;
    return typeof raw.login === 'string' ? raw.login.trim() : '';
  } catch {
    return '';
  }
}

function resolveHookIdentity(config: ConfigV2): string {
  const cached = readCachedLogin();
  if (cached) return cached;
  return config.identity?.dev?.trim() ?? '';
}

// --- Hook state (what has already been notified) ----------------------------

const MAX_NOTIFIED = 1000;

interface HookState {
  notified: string[];
}

function getHookStatePath(project: string): string {
  return path.join(getProjectDir(project), 'hook-state.json');
}

function loadHookState(project: string): HookState {
  try {
    const raw = JSON.parse(readFileSync(getHookStatePath(project), 'utf8')) as { notified?: unknown };
    const notified = Array.isArray(raw.notified)
      ? raw.notified.filter((id): id is string => typeof id === 'string')
      : [];
    return { notified };
  } catch {
    return { notified: [] };
  }
}

function saveHookState(project: string, state: HookState): void {
  mkdirSync(getProjectDir(project), { recursive: true });
  const trimmed =
    state.notified.length > MAX_NOTIFIED
      ? state.notified.slice(state.notified.length - MAX_NOTIFIED)
      : state.notified;
  writeFileSync(getHookStatePath(project), JSON.stringify({ notified: trimmed }, null, 2) + '\n', 'utf8');
}

// --- Notice-claiming lock -----------------------------------------------
//
// Both the plugin's hooks/hooks.json (npx) and `ai-comms hooks install`
// (absolute node) can end up registered for the same Claude Code event at
// once, and Claude Code runs matching hooks in parallel — so two `runHook`
// (or `runHook` + `markNotified`) calls can each read hook-state.json before
// either has written it back, and a given notice gets printed twice. A
// short-lived lock file around the read-modify-write makes the claim atomic:
// whichever process gets the lock first is the one that decides what's new.

function getHookLockPath(project: string): string {
  return path.join(getProjectDir(project), 'hook-state.lock');
}

/** How old a lock file has to be before it's assumed abandoned (its owner
 *  crashed or was killed) and taken over rather than waited out. */
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_INTERVAL_MS = 10;
/** Total time a caller will wait for the lock before giving up. Small on
 *  purpose: the hook's whole budget is ~300ms (SPEC-v0.7 §2.7), and losing
 *  this race just means this run prints nothing — the run that won it still
 *  prints (and saves) correctly. */
const LOCK_WAIT_BUDGET_MS = 250;

/**
 * Blocks the current thread for `ms`. Only ever used for the brief retry
 * between lock attempts: a Claude Code hook is a single synchronous script
 * with a hard timeout, so there is no event loop to yield to while still
 * guaranteeing the read-modify-write below stays atomic.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Environments without Atomics.wait on a SharedArrayBuffer (shouldn't
    // happen under the Node >=20 engines requirement): fall back to a tiny
    // busy-wait rather than never retrying.
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  }
}

interface NoticeLock {
  release(): void;
}

/**
 * Exclusive, best-effort lock around a project's hook-state.json
 * read-modify-write. `openSync(..., 'wx')` is create-exclusive, so the
 * acquisition itself is atomic at the filesystem level. Returns `null` when
 * the lock couldn't be acquired within `LOCK_WAIT_BUDGET_MS` — callers must
 * treat that as "someone else has it right now" and skip their write rather
 * than risk racing it.
 */
function acquireNoticeLock(project: string): NoticeLock | null {
  const lockPath = getHookLockPath(project);
  mkdirSync(getProjectDir(project), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release: () => {
          try {
            unlinkSync(lockPath);
          } catch {
            // Already gone — e.g. taken over as stale by another process.
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;

      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue; // the stale lock is gone now — retry immediately.
        }
      } catch {
        continue; // it vanished between the failed create and this stat — retry.
      }

      if (Date.now() >= deadline) return null;
      sleepSync(LOCK_RETRY_INTERVAL_MS);
    }
  }
}

// --- Formatting ---------------------------------------------------------

export { threadOf };

const NOTIFIED_TYPES = new Set(['answer', 'ask', 'need']);

export function formatNoticeLine(envelope: Envelope): string {
  const subject = envelope.subject || '(no subject)';
  let line = `- [${envelope.type}] ${envelope.from.dev} → re: ${subject} (id ${envelope.id}, thread ${threadOf(envelope)})`;
  // SPEC-v0.7 §2.5: an answer without `answered_by` is shown as unvalidated —
  // nobody confirmed a human approved it.
  if (envelope.type === 'answer' && envelope.answered_by !== 'human') {
    line += ' (automated, not validated)';
  }
  return line;
}

const MAX_SHOWN = 5;

export interface RunHookOptions {
  now?: Date;
}

/**
 * Builds the text a `SessionStart`/`UserPromptSubmit` hook prints: a short
 * summary of what's new on the bus for me since the last notice (answers to
 * my questions, and questions/needs directed at me), or an empty string when
 * there is nothing new.
 *
 * Reads only the local log — never the network — so it can run on every
 * prompt. `kind` is accepted for parity with the two Claude Code hook
 * events; both currently produce the same output.
 */
export function runHook(
  kind: 'session-start' | 'user-prompt',
  cwd: string,
  opts: RunHookOptions = {},
): string {
  void kind;

  // The auto-answerer launches `claude` headlessly, in the user's repo, to
  // answer a bus question on their behalf. If the user's own SessionStart/
  // UserPromptSubmit hooks also run inside that headless session (same cwd,
  // same inherited hook config), they would mark the user's own pending
  // notices as notified without the user ever having seen them. The
  // answerer sets AI_COMMS_ANSWERER=1 in that subprocess's env only — bail
  // out before touching anything.
  if (process.env.AI_COMMS_ANSWERER) return '';

  let config: ConfigV2;
  try {
    config = loadConfig();
  } catch {
    return '';
  }

  let project: string;
  try {
    project = resolveContext(cwd, config).project;
  } catch {
    return '';
  }

  const dev = resolveHookIdentity(config);
  if (!dev) return '';

  let log: Envelope[];
  try {
    log = loadLog(project);
  } catch {
    return '';
  }

  const now = opts.now ?? new Date();

  // Everything from here on reads and then writes hook-state.json — do it
  // under the notice-claiming lock so a concurrently-running hook (both the
  // plugin's and an installed one firing for the same event) can't read the
  // same "not yet notified" state we're about to act on.
  const lock = acquireNoticeLock(project);
  if (!lock) return ''; // another run holds it right now; don't risk a duplicate.

  try {
    const state = loadHookState(project);
    const alreadyNotified = new Set(state.notified);

    const relevant = log.filter((env) => {
      if (env.from.dev === dev) return false;
      if (!NOTIFIED_TYPES.has(env.type)) return false;
      if (!isDirectedTo(env, dev)) return false;
      if (isExpired(env, now)) return false;
      if (alreadyNotified.has(env.id)) return false;
      return true;
    });

    if (relevant.length === 0) return '';

    // Most recent first, so the 5 shown (out of a possibly larger backlog) are
    // the most relevant ones.
    relevant.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

    const shown = relevant.slice(0, MAX_SHOWN);
    const extra = relevant.length - shown.length;

    const lines = shown.map(formatNoticeLine);
    if (extra > 0) lines.push(`(+${extra} more)`);
    lines.push('Use bus_inbox for details; reply to questions with bus_send type answer and reply_to.');

    saveHookState(project, {
      notified: [...state.notified, ...relevant.map((e) => e.id)],
    });

    return `${SECURITY_PREAMBLE}\n\n${lines.join('\n')}`;
  } finally {
    lock.release();
  }
}

/**
 * Marks `ids` as already notified without printing anything. The MCP server
 * calls this for a `bus_ask` reply it already returned inline to the caller,
 * so the next hook run doesn't show that same answer again as if it were new
 * (SPEC-v0.7 §2.7 fix: answers already returned inline being shown again).
 * Uses the same lock as `runHook`'s read-modify-write.
 */
export function markNotified(project: string, ids: string[]): void {
  if (ids.length === 0) return;
  const lock = acquireNoticeLock(project);
  try {
    const state = loadHookState(project);
    const merged = new Set([...state.notified, ...ids]);
    saveHookState(project, { notified: [...merged] });
  } finally {
    lock?.release();
  }
}

// --- Claude Code hook stdin handling -----------------------------------

/**
 * Claude Code hooks pipe a JSON payload on stdin and expect the process to
 * exit promptly either way. We don't need that payload (the hook resolves
 * everything itself from the local log and cwd), but an unread, unclosed
 * stdin can leave the hook process hanging when stdin is a pipe rather than
 * a TTY — so drain it, bounded by a short timeout in case it's never closed,
 * and always pause+destroy the stream once we're done with it (whether it
 * ended on its own or we hit the timeout) so an open pipe can't keep the
 * process alive after `main()` returns.
 *
 * Shared by both `ai-comms hook <kind>` (src/cli.ts) and the lightweight
 * `hook-entry.ts` bin/ai-comms.js dispatches to instead, so the fix applies
 * to whichever one actually runs.
 *
 * `stdin` defaults to the real `process.stdin` and is only ever overridden
 * by tests, so they can exercise the timeout/cleanup paths against an
 * in-memory fake instead of a real OS pipe.
 */
export function drainStdin(timeoutMs = 200, stdin: NodeJS.ReadStream = process.stdin): Promise<void> {
  return new Promise((resolve) => {
    if (stdin.isTTY) {
      resolve();
      return;
    }

    let done = false;
    const onData = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', finish);
      stdin.off('error', finish);
      try {
        stdin.pause();
      } catch {
        // ignore — best-effort cleanup only.
      }
      try {
        stdin.destroy();
      } catch {
        // ignore
      }
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    stdin.on('data', onData);
    stdin.once('end', finish);
    stdin.once('error', finish);
    stdin.resume();
  });
}

// --- ai-comms hooks install / uninstall -------------------------------------

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit'] as const;
export type ClaudeHookEvent = (typeof HOOK_EVENTS)[number];

const HOOK_KIND_FOR_EVENT: Record<ClaudeHookEvent, 'session-start' | 'user-prompt'> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt',
};

interface ClaudeHookCommand {
  type: string;
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks: ClaudeHookCommand[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: Partial<Record<string, ClaudeHookGroup[]>>;
  [key: string]: unknown;
}

function buildHookCommand(
  kind: 'session-start' | 'user-prompt',
  override?: { command: string; args: string[] },
): string {
  const { command, args } = override ?? resolveCliInvocation();
  return [command, ...args, 'hook', kind].map(quoteShellArg).join(' ');
}

/**
 * True when a hook command line is one we installed: it invokes our `hook
 * <kind>` subcommand. Used both to make `install` idempotent (skip an event
 * that already has one of ours) and to make `uninstall` only ever remove
 * entries we added, never a hook some other tool configured.
 */
function isOurHookCommand(command: string): boolean {
  return command.includes('ai-comms') && /\bhook\s+(session-start|user-prompt)\b/.test(command);
}

function readClaudeSettings(settingsPath: string): { settings: ClaudeSettings; existed: boolean } | null {
  if (!existsSync(settingsPath)) return { settings: {}, existed: false };
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return { settings: raw as ClaudeSettings, existed: true };
  } catch {
    return null;
  }
}

export interface HookInstallOptions {
  home?: string;
  /** Overrides the resolved node+cli invocation. Tests only. */
  command?: { command: string; args: string[] };
}

export interface HookInstallOutcome {
  settingsPath: string;
  installed: ClaudeHookEvent[];
  alreadyInstalled: ClaudeHookEvent[];
  /** Set, and nothing written, when the settings file exists but could not be parsed. */
  failed?: string;
}

/**
 * Merges the `SessionStart`/`UserPromptSubmit` hooks into
 * `~/.claude/settings.json`, preserving every other hook and setting.
 * Idempotent: an event that already has one of our hooks is left alone.
 *
 * Note on the plugin/`hooks install` double-registration: the review finding
 * asked us to also detect, here, when the ai-comms *plugin* (which ships its
 * own `hooks/hooks.json`) is installed, and say so instead of installing a
 * second copy. There is no dependable signal for that from this package
 * alone — a plugin can be enabled via `~/.claude/settings.json`'s
 * `enabledPlugins`, via a synced marketplace bucket under
 * `~/.claude/plugins/synced/…`, or (in this session's own environment) not
 * show up under a stable, documented key at all — so guessing at the format
 * risks a false "not needed" that silently leaves the user with no hooks at
 * all. We rely solely on the concurrency-safe lock in `runHook`/
 * `markNotified` (acquireNoticeLock) to make a double-registration harmless
 * (one duplicate print, never two) rather than trying to prevent the
 * double-registration itself.
 */
export function installClaudeHooks(opts: HookInstallOptions = {}): HookInstallOutcome {
  const home = opts.home ?? homedir();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const read = readClaudeSettings(settingsPath);
  if (!read) {
    return {
      settingsPath,
      installed: [],
      alreadyInstalled: [],
      failed: `${settingsPath} exists but is not valid JSON — left untouched.`,
    };
  }

  const { settings } = read;
  const hooks: Partial<Record<string, ClaudeHookGroup[]>> = { ...(settings.hooks ?? {}) };
  const installed: ClaudeHookEvent[] = [];
  const alreadyInstalled: ClaudeHookEvent[] = [];

  for (const event of HOOK_EVENTS) {
    const group = hooks[event] ?? [];
    const hasOurs = group.some((g) => g.hooks?.some((h) => h.type === 'command' && isOurHookCommand(h.command)));
    if (hasOurs) {
      alreadyInstalled.push(event);
      continue;
    }
    const command = buildHookCommand(HOOK_KIND_FOR_EVENT[event], opts.command);
    hooks[event] = [...group, { hooks: [{ type: 'command', command, timeout: 10 }] }];
    installed.push(event);
  }

  if (installed.length > 0) {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ ...settings, hooks }, null, 2) + '\n', 'utf8');
  }

  return { settingsPath, installed, alreadyInstalled };
}

export interface HookUninstallOutcome {
  settingsPath: string;
  removed: ClaudeHookEvent[];
  failed?: string;
}

/** Removes only the hook entries `installClaudeHooks` would have added, leaving everything else untouched. */
export function uninstallClaudeHooks(opts: { home?: string } = {}): HookUninstallOutcome {
  const home = opts.home ?? homedir();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const read = readClaudeSettings(settingsPath);
  if (!read) {
    return { settingsPath, removed: [], failed: `${settingsPath} exists but is not valid JSON — left untouched.` };
  }
  if (!read.existed) {
    return { settingsPath, removed: [] };
  }

  const { settings } = read;
  const hooks: Partial<Record<string, ClaudeHookGroup[]>> = { ...(settings.hooks ?? {}) };
  const removed: ClaudeHookEvent[] = [];

  for (const event of HOOK_EVENTS) {
    const group = hooks[event];
    if (!group) continue;

    let touched = false;
    const filtered: ClaudeHookGroup[] = [];
    for (const g of group) {
      const before = g.hooks.length;
      const nextHooks = g.hooks.filter((h) => !(h.type === 'command' && isOurHookCommand(h.command)));
      if (nextHooks.length !== before) touched = true;
      if (nextHooks.length > 0) filtered.push({ ...g, hooks: nextHooks });
    }

    if (!touched) continue;
    removed.push(event);
    if (filtered.length > 0) hooks[event] = filtered;
    else delete hooks[event];
  }

  if (removed.length > 0) {
    const nextSettings: ClaudeSettings = { ...settings };
    if (Object.keys(hooks).length > 0) nextSettings.hooks = hooks;
    else delete nextSettings.hooks;
    writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2) + '\n', 'utf8');
  }

  return { settingsPath, removed };
}

// --- ai-comms autoanswer on|off ---------------------------------------------
//
// Colocated here rather than in cli.ts: cli.ts's bottom-of-file
// `program.parseAsync(process.argv)` runs as an import side effect (it is
// how bin/ai-comms.js boots the CLI — see bin/ai-comms.js), so importing
// cli.ts from a test would parse the test runner's own argv as CLI input.
// Keeping the pure computation here instead of inlined in the `autoanswer`
// command action keeps it unit-testable without that risk.

/**
 * The next `autoAnswer` config for a project after an `ai-comms autoanswer
 * on|off` run: only `enabled` (and, if passed, `repoPath`) changes — every
 * other field, and `repoPath` when `--repo-path` was not given, is kept from
 * whatever was already configured, falling back to the schema defaults only
 * when there was nothing configured yet.
 */
export function computeAutoAnswerConfig(
  prev: AutoAnswerConfig | undefined,
  enabled: boolean,
  repoPath?: string,
): AutoAnswerConfig {
  const next: AutoAnswerConfig = {
    enabled,
    maxPerRequesterPerHour: prev?.maxPerRequesterPerHour ?? 5,
    timeoutSeconds: prev?.timeoutSeconds ?? 120,
    maxAgeMinutes: prev?.maxAgeMinutes ?? 10,
  };
  // A freshly-passed `--repo-path` is resolved to an absolute path before
  // it's stored, whatever form the user typed it in (relative to cwd, `~`
  // left un-expanded by the shell, a trailing slash, ...) — see
  // `resolveAutoAnswerRepoPath`, which the `autoanswer` command runs first to
  // validate it (existence, directory-ness, not $HOME, not a filesystem
  // root) before ever reaching here. An already-stored `prev.repoPath` was
  // resolved the same way when it was set, so it's left as-is.
  const resolvedRepoPath = repoPath !== undefined ? path.resolve(repoPath) : prev?.repoPath;
  if (resolvedRepoPath !== undefined) next.repoPath = resolvedRepoPath;
  return next;
}

export class AutoAnswerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoAnswerConfigError';
  }
}

/**
 * Validates and resolves a `--repo-path` value for `ai-comms autoanswer on`:
 * must resolve to a directory that exists, and must not be the user's home
 * directory or a filesystem root (both are almost certainly a mistake — the
 * auto-answerer would end up treating every repo on the machine as fair
 * game). Returns the absolute path to store.
 */
export function resolveAutoAnswerRepoPath(repoPath: string): string {
  const resolved = path.resolve(repoPath);

  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new AutoAnswerConfigError(
      `--repo-path "${repoPath}" does not exist or is not a directory (resolved to ${resolved}).`,
    );
  }

  const home = path.resolve(homedir());
  if (resolved === home) {
    throw new AutoAnswerConfigError(
      `--repo-path must not be your home directory (${resolved}) — point it at the directory ` +
        `containing the repo checkout(s) the auto-answerer should read from.`,
    );
  }

  const root = path.parse(resolved).root;
  if (resolved === root) {
    throw new AutoAnswerConfigError(`--repo-path must not be a filesystem root (${resolved}).`);
  }

  return resolved;
}
