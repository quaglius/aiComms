import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from 'discord.js';
import notifier from 'node-notifier';
import type { ConfigV2 } from './config.js';
import { loadConfig } from './config.js';
import { runAutoAnswer } from './auto-answer.js';
import type { Envelope } from './envelope.js';
import {
  appendEnvelope,
  getDaemonLogPath,
  loadCursor,
  saveCursor,
  writeDaemonPid,
  removeDaemonPid,
} from './store.js';
import { getConfigDir, getProjectDir } from './paths.js';
import { createTransport } from './transports/index.js';
import { isDiscordBus, type GitHubBusConfig } from './transports/types.js';
import { collectDiscordBindings, runDiscordGateway } from './transports/discord-gateway.js';
import { loadRepoComms, resolveBusFromRepoComms, resolveContext } from './context.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const GITHUB_POLL_MS = 15_000;

interface GitHubBinding {
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
  const sound =
    (envelope.type === 'need' || envelope.type === 'ask') &&
    envelope.to.includes(dev) &&
    !envelope.to.includes('*');

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

/** Persist every valid envelope; notify only for messages from other devs. */
export function ingestEnvelope(
  envelope: Envelope,
  project: string,
  dev: string,
  config?: ConfigV2,
  verbose = false,
): { notified: boolean } {
  appendEnvelope(envelope, project);

  if (config) {
    void runAutoAnswer(envelope, project, config, (message) => {
      daemonLog(project, message, verbose);
      if (/auto-answer (failed|produced no answer)/.test(message)) {
        notifyAutoAnswerFailure(message);
      }
    });
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

async function pollGitHubBinding(
  binding: GitHubBinding,
  config: ConfigV2,
  verbose: boolean,
): Promise<void> {
  const cursor = loadCursor(binding.project);

  const ctx = resolveContext(binding.repoPath, config, { projectOverride: binding.project });
  const transport = createTransport(ctx, config, {
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
  });

  let dev = config.identity?.dev ?? '';
  try {
    dev = (await transport.whoami()).dev;
  } catch (err) {
    daemonLog(binding.project, `whoami failed: ${String(err)}`, verbose);
  }

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

  const ctx = resolveContext(binding.repoPath, config, { projectOverride: binding.project });
  const transport = createTransport(ctx, config, {
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
  });

  let dev = config.identity?.dev ?? '';
  try {
    dev = (await transport.whoami()).dev;
  } catch {
    // logged on poll
  }

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

  const shutdown = () => {
    for (const timer of pollTimers) {
      clearInterval(timer);
    }
    for (const project of projects) {
      removeDaemonPid(project);
    }
    for (const client of clients) {
      client.destroy();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>(() => {
    // keep alive
  });
}
