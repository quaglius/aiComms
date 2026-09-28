import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from 'discord.js';
import notifier from 'node-notifier';
import type { ConfigV2 } from './config.js';
import { loadConfig, resolveAutoAnswer } from './config.js';
import { runAutoAnswer } from './auto-answer.js';
import type { Envelope } from './envelope.js';
import type { Transport } from './transports/types.js';
import {
  acquireDaemonLock,
  appendEnvelope,
  getDaemonLogPath,
  loadCursor,
  releaseDaemonLock,
  saveCursor,
  writeDaemonPid,
  removeDaemonPid,
  compactLog,
} from './store.js';
import { rememberIdentity } from './hook.js';
import { getConfigDir, getProjectDir } from './paths.js';
import { createTransport } from './transports/index.js';
import { isDiscordBus, type GitHubBusConfig } from './transports/types.js';
import { GitHubTransport } from './transports/github.js';
import { collectDiscordBindings, runDiscordGateway } from './transports/discord-gateway.js';
import { loadRepoComms, resolveBusFromRepoComms, resolveContext } from './context.js';
import { getRepoCollaborators } from './collaborators.js';
import { getGitRemote } from './git-remote.js';
import { filePresenceCommentIdCache, upsertOwnProfile } from './presence.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const GITHUB_POLL_MS = 15_000;
const LOG_COMPACT_MS = 24 * 60 * 60 * 1000;
/** How often we refresh our own presence profile (spec §2.1: "cada 5
 *  minutos por proyecto"). Editing a comment never notifies, so there's no
 *  cost to doing this more often than someone is likely to check it. */
const PRESENCE_HEARTBEAT_MS = 5 * 60_000;
/** whoami() hits `GET /user`; re-checking it every 15s poll is pure cost for
 *  an identity that essentially never changes mid-session. */
const WHOAMI_CACHE_MS = 10 * 60 * 1000;
/** How long to go without retrying collaborators after a failed listing
 *  (typically a 403: GitHub requires write access on the repo for that
 *  endpoint, so a read-only teammate's daemon can never list it). Matches the
 *  success-case cache TTL in collaborators.ts. */
const COLLABORATORS_UNAVAILABLE_MS = 60 * 60 * 1000;

export interface GitHubBinding {
  project: string;
  bus: GitHubBusConfig;
  repoPath: string;
}

function daemonLog(project: string, message: string, verbose: boolean): void {
  mkdirSync(getProjectDir(project), { recursive: true });
  rotateLogIfNeeded(project);
  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(getDaemonLogPath(project), line, 'utf8');
  if (verbose) {
    process.stderr.write(`[${project}] ${line}`);
  }
}

function rotateLogIfNeeded(project: string): void {
  const logPath = getDaemonLogPath(project);
  if (!existsSync(logPath)) return;
  const size = statSync(logPath).size;
  if (size < MAX_LOG_BYTES) return;
  const rotated = path.join(getProjectDir(project), 'daemon.log.1');
  if (existsSync(rotated)) {
    try {
      renameSync(rotated, path.join(getProjectDir(project), 'daemon.log.2'));
    } catch {
      // ignore
    }
  }
  renameSync(logPath, rotated);
}

function shouldNotify(envelope: Envelope, dev: string): boolean {
  const directed = envelope.to.includes('*') || envelope.to.includes(dev);
  if (!directed) return false;
  if (new Date(envelope.ttl) <= new Date()) return false;
  if (envelope.hops >= 3) return false;
  return true;
}

/**
 * Our own icon for desktop notifications.
 *
 * Windows delivers these through SnoreToast, so the toast carries that app's
 * name and its default icon — which reads as something unrelated and gets
 * ignored. Renaming the app needs a registered AppUserModelID, and an
 * unregistered one makes Windows drop the toast silently, so the icon is the
 * part we can fix without risking the notification itself.
 */
const NOTIFICATION_ICON = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve('../assets/icon.png');
  } catch {
    return undefined;
  }
})();

function notifyEnvelope(envelope: Envelope, dev: string): void {
  // A question that waits on this person — directed, or explicitly asking for
  // a human decision — is the one notification worth a sound.
  const sound =
    (envelope.type === 'need' || envelope.type === 'ask') &&
    envelope.to.includes(dev) &&
    (!envelope.to.includes('*') || envelope.needs_human === true);

  const title = `ai-comms · ${envelope.type} · ${envelope.from.dev}/${envelope.from.agent}`;
  const message = envelope.subject;

  try {
    notifier.notify({
      title,
      message,
      sound: sound ? true : false,
      wait: false,
      icon: NOTIFICATION_ICON,
    });
  } catch {
    // ignore
  }
}

const AUTO_ANSWER_FAILURE_NOTICE_MS = 60 * 60 * 1000;
let lastAutoAnswerFailureNotice = 0;

function notifyAutoAnswerFailure(message: string): void {
  const now = Date.now();
  if (now - lastAutoAnswerFailureNotice < AUTO_ANSWER_FAILURE_NOTICE_MS) return;
  lastAutoAnswerFailureNotice = now;
  try {
    notifier.notify({
      title: 'ai-comms · auto-answer failed',
      message: `${message.slice(0, 160)} — your teammate got no reply. Check that your agent CLI is still signed in.`,
      sound: false,
      wait: false,
      icon: NOTIFICATION_ICON,
    });
  } catch {
    // ignore
  }
}

/**
 * Persist every valid envelope; notify and auto-answer only for messages from
 * other devs, and only when the envelope is actually new.
 *
 * `appendEnvelope` dedupes by id, but a re-ingest (backfill overlapping a
 * poll, a daemon restart replaying the backlog) must not repeat the side
 * effects: relaunching the answerer for an ask it already answered, or a
 * second desktop notification for the same message.
 */
export function ingestEnvelope(
  envelope: Envelope,
  project: string,
  dev: string,
  config?: ConfigV2,
  verbose = false,
): { notified: boolean } {
  const appended = appendEnvelope(envelope, project);
  if (!appended) return { notified: false };

  if (config) {
    void runAutoAnswer(
      envelope,
      project,
      config,
      (message) => {
        daemonLog(project, message, verbose);
        if (/auto-answer (failed|produced no answer)/.test(message)) {
          notifyAutoAnswerFailure(message);
        }
      },
      { dev },
    );
  }

  if (envelope.from.dev === dev) return { notified: false };

  if (shouldNotify(envelope, dev)) {
    notifyEnvelope(envelope, dev);
    return { notified: true };
  }
  return { notified: false };
}

function collectGitHubBindings(config: ConfigV2): GitHubBinding[] {
  const bindings: GitHubBinding[] = [];

  for (const [project, projectConfig] of Object.entries(config.projects ?? {})) {
    const bus = projectConfig.bus;
    if (!bus || bus.kind !== 'github') continue;

    const repoPath = projectConfig.repos?.[0]?.path ?? process.cwd();
    bindings.push({ project, bus, repoPath });
  }

  return bindings;
}

interface WhoamiCacheEntry {
  dev: string;
  fetchedAt: number;
}

const whoamiCache = new Map<string, WhoamiCacheEntry>();
const collaboratorsUnavailableUntil = new Map<string, number>();
const collaboratorsWarned = new Set<string>();

export function resetDaemonCachesForTests(): void {
  whoamiCache.clear();
  collaboratorsUnavailableUntil.clear();
  collaboratorsWarned.clear();
}

/**
 * The authenticated login for a binding, refreshed at most every
 * {@link WHOAMI_CACHE_MS} (or sooner on failure, to retry rather than stick
 * with a stale identity).
 *
 * whoami() hits `GET /user`. Calling it on every 15s poll, for every project,
 * is a `gh`/GitHub API request that buys nothing — the authenticated login
 * essentially never changes mid-session.
 */
export async function resolveDev(
  binding: GitHubBinding,
  transport: Transport,
  config: ConfigV2,
  verbose: boolean,
  now = Date.now(),
): Promise<string> {
  const cached = whoamiCache.get(binding.project);
  if (cached && now - cached.fetchedAt < WHOAMI_CACHE_MS) {
    return cached.dev;
  }
  try {
    const dev = (await transport.whoami()).dev;
    whoamiCache.set(binding.project, { dev, fetchedAt: now });
    // The Claude Code hook runs on every prompt and must not touch the
    // network, so it reads the login we last authenticated as.
    rememberIdentity(dev);
    return dev;
  } catch (err) {
    daemonLog(binding.project, `whoami failed: ${String(err)}`, verbose);
    if (cached) return cached.dev;
    return config.identity?.dev ?? '';
  }
}

/**
 * Builds the collaborator allowlist for a binding, so inbound comments from
 * accounts that are not on the repo are never ingested — "private by
 * default" otherwise only holds for who can *read* the bus, not who can
 * *post* to it (on a public repo, that's anyone with a GitHub account).
 *
 * `getRepoCollaborators` requires write/maintain/admin on the repo, so a
 * read-only teammate's daemon gets a 403 every time. Rather than fail
 * silently or spam the log every 15s, this accepts all authors (unfiltered
 * is the pre-existing behavior) and logs a single warning per project,
 * backing off from retrying the listing for an hour.
 */
export async function buildAuthorFilter(
  binding: GitHubBinding,
  verbose: boolean,
  now = Date.now(),
): Promise<((login: string) => boolean) | undefined> {
  const unavailableUntil = collaboratorsUnavailableUntil.get(binding.project);
  if (unavailableUntil && now < unavailableUntil) {
    return undefined;
  }

  try {
    const collaborators = await getRepoCollaborators(binding.bus.repo);
    collaboratorsUnavailableUntil.delete(binding.project);
    const allowed = new Set(collaborators);
    return (login) => allowed.has(login);
  } catch (err) {
    collaboratorsUnavailableUntil.set(binding.project, now + COLLABORATORS_UNAVAILABLE_MS);
    if (!collaboratorsWarned.has(binding.project)) {
      collaboratorsWarned.add(binding.project);
      daemonLog(
        binding.project,
        `Could not list collaborators for ${binding.bus.repo} (${String(err)}). GitHub requires ` +
          "write/maintain/admin access on the repo for that endpoint, so a read-only teammate's " +
          'daemon always gets a 403 here. Inbound authors are NOT being filtered by team membership ' +
          `for project "${binding.project}" until this succeeds.`,
        verbose,
      );
    }
    return undefined;
  }
}

async function githubTransportForBinding(
  binding: GitHubBinding,
  config: ConfigV2,
  verbose: boolean,
  cursor: ReturnType<typeof loadCursor>,
) {
  const ctx = resolveContext(binding.repoPath, config, { projectOverride: binding.project });
  const isAllowedAuthor = await buildAuthorFilter(binding, verbose);
  return createTransport(ctx, config, {
    onIdentityMismatch: (declared, actual, commentId) => {
      daemonLog(
        binding.project,
        `identity mismatch on comment ${commentId}: payload declared "${declared}", GitHub author "${actual}"`,
        verbose,
      );
    },
    getEtag: () => cursor?.etag,
    setEtag: (etag) => {
      if (etag) {
        saveCursor(binding.project, { ...loadCursor(binding.project), etag });
      }
    },
    isAllowedAuthor,
    onRejectedAuthor: (login, commentId) => {
      daemonLog(
        binding.project,
        `rejected comment ${commentId} from "${login}": not a collaborator on ${binding.bus.repo}`,
        verbose,
      );
    },
  });
}

async function pollGitHubBinding(
  binding: GitHubBinding,
  config: ConfigV2,
  verbose: boolean,
): Promise<void> {
  const cursor = loadCursor(binding.project);
  const transport = await githubTransportForBinding(binding, config, verbose, cursor);
  const dev = await resolveDev(binding, transport, config, verbose);

  const result = await transport.fetchSince(cursor?.lastSince ?? null);

  if (result.envelopes.length === 0 && result.cursor === (cursor?.lastSince ?? null)) {
    return;
  }

  for (const envelope of result.envelopes) {
    ingestEnvelope(envelope, binding.project, dev, config, verbose);
  }

  if (result.cursor && result.cursor !== cursor?.lastSince) {
    saveCursor(binding.project, {
      ...loadCursor(binding.project),
      lastSince: result.cursor,
    });
  }
}

async function backfillGitHubBinding(
  binding: GitHubBinding,
  config: ConfigV2,
  verbose: boolean,
): Promise<void> {
  const cursor = loadCursor(binding.project);
  const transport = await githubTransportForBinding(binding, config, verbose, cursor);
  const dev = await resolveDev(binding, transport, config, verbose);

  const result = await (transport.backfill?.(cursor?.lastSince ?? null) ??
    transport.fetchSince(cursor?.lastSince ?? null));
  for (const envelope of result.envelopes) {
    ingestEnvelope(envelope, binding.project, dev, config, verbose);
  }

  if (result.cursor) {
    saveCursor(binding.project, {
      ...loadCursor(binding.project),
      lastSince: result.cursor,
    });
  }
}

/**
 * `owner/repo` for every repo registered under this project, derived from
 * each local path's git `origin` — not the local folder name, which is
 * meaningless off this machine. Falls back to the bus repo alone when none
 * of the registered paths are derivable (e.g. deleted/moved locally).
 */
export function deriveProjectRepos(project: string, config: ConfigV2, binding: GitHubBinding): string[] {
  const repos = config.projects[project]?.repos ?? [];
  const derived: string[] = [];
  for (const entry of repos) {
    try {
      derived.push(getGitRemote(entry.path).fullName);
    } catch {
      // Not a git repo (any more), or no "origin" — not derivable.
    }
  }
  return derived.length > 0 ? [...new Set(derived)] : [binding.bus.repo];
}

/**
 * Publishes our own presence profile for a binding whose bus has a presence
 * issue configured (§2.1). Best-effort: a failure here must never take down
 * the daemon or block polling — it's just logged.
 */
export async function sendPresenceHeartbeat(
  binding: GitHubBinding,
  config: ConfigV2,
  verbose: boolean,
): Promise<void> {
  if (binding.bus.presence === undefined) return;

  try {
    // A plain transport, not `githubTransportForBinding` — the heartbeat only
    // needs `whoami()`, and building the full transport also fetches the
    // collaborator allowlist, which is wasted work here.
    const transport = new GitHubTransport({ repo: binding.bus.repo, issue: binding.bus.issue });
    const dev = await resolveDev(binding, transport, config, verbose);
    if (!dev) {
      daemonLog(binding.project, 'presence heartbeat skipped: identity unknown', verbose);
      return;
    }

    const autoAnswer = resolveAutoAnswer(config.projects[binding.project]);

    await upsertOwnProfile(
      binding.bus,
      dev,
      {
        role: config.profile?.role,
        areas: config.profile?.areas ?? [],
        repos: deriveProjectRepos(binding.project, config, binding),
        agent: config.agent ?? config.identity?.agent ?? 'claude-code',
        autoAnswer: autoAnswer.enabled,
        lastSeen: new Date().toISOString(),
      },
      { commentIdCache: filePresenceCommentIdCache(binding.project) },
    );
    daemonLog(binding.project, `presence heartbeat published for ${dev}`, verbose);
  } catch (err) {
    daemonLog(binding.project, `presence heartbeat failed: ${String(err)}`, verbose);
  }
}

function buildDiscordBusMap(config: ConfigV2): Map<string, { kind: 'discord'; channelId: string }> {
  const map = new Map<string, { kind: 'discord'; channelId: string }>();

  for (const [project, projectConfig] of Object.entries(config.projects ?? {})) {
    if (projectConfig.discord) {
      map.set(project, { kind: 'discord', channelId: projectConfig.discord.channelId });
    }
    for (const repo of projectConfig.repos ?? []) {
      const repoCommsPath = path.join(repo.path, '.ai-comms.json');
      if (!existsSync(repoCommsPath)) continue;
      try {
        const repoComms = loadRepoComms(repoCommsPath);
        if (repoComms.project !== project) continue;
        const bus = resolveBusFromRepoComms(repoComms);
        if (isDiscordBus(bus)) {
          map.set(project, bus);
        }
      } catch {
        // skip invalid
      }
    }
  }

  return map;
}

export async function runDaemon(options: { verbose?: boolean } = {}): Promise<void> {
  const verbose = options.verbose ?? false;

  // Two daemons on the same bus — an autostarted one plus a manually run
  // one, or a laptop and a desktop both online — would each answer the same
  // question, doubling every auto-answer. Acquire the single-instance lock
  // before anything else so a second `ai-comms daemon` fails fast and says
  // why, instead of quietly running alongside the first.
  const lock = acquireDaemonLock();
  if (!lock.acquired) {
    throw new Error(`ai-comms daemon is already running (pid ${lock.pid}).`);
  }

  try {
    await runDaemonLocked(verbose);
  } catch (err) {
    releaseDaemonLock();
    throw err;
  }
}

async function runDaemonLocked(verbose: boolean): Promise<void> {
  const config = loadConfig();

  const discordBusMap = buildDiscordBusMap(config);
  const discordGroups = collectDiscordBindings(config, discordBusMap);
  const githubBindings = collectGitHubBindings(config);

  if (discordGroups.length === 0 && githubBindings.length === 0) {
    throw new Error(
      'No projects with a configured transport. Run "ai-comms setup" or configure a legacy Discord project.',
    );
  }

  mkdirSync(getConfigDir(), { recursive: true });

  const projects = [
    ...new Set([
      ...discordGroups.flatMap((g) => g.bindings.map((b) => b.project)),
      ...githubBindings.map((b) => b.project),
    ]),
  ];

  for (const project of projects) {
    writeDaemonPid(project);
  }

  const clients: Client[] = [];

  for (const group of discordGroups) {
    const client = await runDiscordGateway(group.bindings, {
      onEnvelope: (project, envelope, messageId) => {
        saveCursor(project, {
          ...loadCursor(project),
          lastMessageId: messageId,
        });
        const dev = config.identity?.dev ?? '';
        ingestEnvelope(envelope, project, dev, config, verbose);
      },
      onLog: (project, message) => {
        daemonLog(project, message, verbose);
      },
    }, group.token);
    clients.push(client);
  }

  for (const binding of githubBindings) {
    try {
      await backfillGitHubBinding(binding, config, verbose);
      daemonLog(binding.project, 'GitHub backfill complete', verbose);
    } catch (err) {
      daemonLog(binding.project, `GitHub backfill error: ${String(err)}`, verbose);
    }
  }

  const pollTimers: NodeJS.Timeout[] = [];
  for (const binding of githubBindings) {
    const timer = setInterval(() => {
      void pollGitHubBinding(binding, config, verbose).catch((err) => {
        daemonLog(binding.project, `GitHub poll error: ${String(err)}`, verbose);
      });
    }, GITHUB_POLL_MS);
    pollTimers.push(timer);
  }

  // The log is append-only; without compaction it grows forever and every
  // reader pays for it. Compact at start and once a day.
  const compact = () => {
    for (const project of projects) {
      try {
        const { kept, removed } = compactLog(project);
        if (removed > 0) daemonLog(project, `log compacted: kept ${kept}, removed ${removed}`, verbose);
      } catch (err) {
        daemonLog(project, `log compaction failed: ${String(err)}`, verbose);
      }
    }
  };
  compact();
  const compactTimer = setInterval(compact, LOG_COMPACT_MS);

  const presenceTimers: NodeJS.Timeout[] = [];
  for (const binding of githubBindings) {
    if (binding.bus.presence === undefined) continue;
    void sendPresenceHeartbeat(binding, config, verbose);
    const timer = setInterval(() => {
      void sendPresenceHeartbeat(binding, config, verbose);
    }, PRESENCE_HEARTBEAT_MS);
    presenceTimers.push(timer);
  }

  const shutdown = () => {
    for (const timer of pollTimers) {
      clearInterval(timer);
    }
    for (const timer of presenceTimers) {
      clearInterval(timer);
    }
    clearInterval(compactTimer);
    for (const project of projects) {
      removeDaemonPid(project);
    }
    for (const client of clients) {
      client.destroy();
    }
    releaseDaemonLock();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>(() => {
    // keep alive
  });
}
