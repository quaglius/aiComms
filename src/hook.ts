import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getConfigDir, getProjectDir } from './paths.js';
import { loadConfig, type ConfigV2, type AutoAnswerConfig } from './config.js';
import { resolveContext } from './context.js';
import { loadLog } from './store.js';
import { isDirectedTo, isExpired, type Envelope } from './envelope.js';
import { SECURITY_PREAMBLE } from './mcp.js';
import { PACKAGE_VERSION } from './version.js';

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

// --- Formatting ---------------------------------------------------------

/**
 * `envelope.thread` / `envelope.answered_by` are new in SPEC-v0.7 §1.1
 * (src/envelope.ts), which is out of this module's scope and has not added
 * them to the `Envelope` type yet in this worktree. This local extension —
 * and the `threadOf` fallback below, which mirrors the spec's
 * `threadOf(envelope) = envelope.thread ?? envelope.id` — should be deleted
 * and replaced with the real import once envelope.ts gains those fields.
 */
type EnvelopeV2 = Envelope & {
  thread?: string | null;
  answered_by?: 'agent' | 'human';
};

/** @see EnvelopeV2 */
export function threadOf(envelope: Envelope): string {
  return (envelope as EnvelopeV2).thread ?? envelope.id;
}

const NOTIFIED_TYPES = new Set(['answer', 'ask', 'need']);

export function formatNoticeLine(envelope: Envelope): string {
  const v2 = envelope as EnvelopeV2;
  const subject = envelope.subject || '(no subject)';
  let line = `- [${envelope.type}] ${envelope.from.dev} → re: ${subject} (id ${envelope.id}, thread ${threadOf(envelope)})`;
  // SPEC-v0.7 §2.5: an answer without `answered_by` is shown as unvalidated —
  // nobody confirmed a human approved it.
  if (envelope.type === 'answer' && v2.answered_by !== 'human') {
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

/**
 * Absolute node + absolute CLI script, falling back to an absolute `npx`
 * when running from an npx cache. Copied from `resolveDaemonCommand` in
 * src/setup.ts (adapted to not append a subcommand — callers append
 * `hook <kind>` themselves) because this module's scope is not allowed to
 * edit or import from setup.ts. Dedupe the two at integration.
 */
function resolveCliInvocation(): { command: string; args: string[] } {
  const nodeExec = process.execPath;
  const binPath = fileURLToPath(new URL('../bin/ai-comms.js', import.meta.url));

  if (!binPath.includes('_npx')) {
    return { command: nodeExec, args: [binPath] };
  }

  const npxName = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const npxPath = path.join(path.dirname(nodeExec), npxName);
  return { command: npxPath, args: ['-y', `@quaglius/ai-comms@${PACKAGE_VERSION}`] };
}

/** Copied from `quoteShellArg` in src/setup.ts — see resolveCliInvocation. */
function quoteShellArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
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
  const resolvedRepoPath = repoPath ?? prev?.repoPath;
  if (resolvedRepoPath !== undefined) next.repoPath = resolvedRepoPath;
  return next;
}
