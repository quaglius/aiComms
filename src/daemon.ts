import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits, type Message } from 'discord.js';
import notifier from 'node-notifier';
import type { ConfigV2 } from './config.js';
import { loadConfig } from './config.js';
import { runAutoAnswer } from './auto-answer.js';
import { parseEnvelopeFromMessage, type Envelope } from './envelope.js';
import { getEffectiveToken } from './secrets.js';
import {
  appendEnvelope,
  getDaemonLogPath,
  loadCursor,
  saveCursor,
  writeDaemonPid,
  removeDaemonPid,
} from './store.js';
import { getConfigDir, getProjectDir } from './paths.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

interface ChannelBinding {
  channelId: string;
  project: string;
}

interface TokenGroup {
  token: string;
  channels: ChannelBinding[];
}

function collectTokenGroups(config: ConfigV2): TokenGroup[] {
  const byToken = new Map<string, ChannelBinding[]>();

  for (const [project, projectConfig] of Object.entries(config.projects ?? {})) {
    const channelId = projectConfig.discord.channelId;
    try {
      const { token } = getEffectiveToken(project);
      const existing = byToken.get(token) ?? [];
      if (!existing.some((c) => c.channelId === channelId && c.project === project)) {
        existing.push({ channelId, project });
      }
      byToken.set(token, existing);
    } catch {
      // project without token: daemon skips it; doctor will report it
    }
  }

  return [...byToken.entries()].map(([token, channels]) => ({ token, channels }));
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

function notifyEnvelope(envelope: Envelope, dev: string): void {
  const sound =
    (envelope.type === 'need' || envelope.type === 'ask') &&
    envelope.to.includes(dev) &&
    !envelope.to.includes('*');

  // Prefix with the tool name: on Windows the toast is delivered by SnoreToast
  // and shows *its* name, not ours, so the title is the only place the user can
  // tell where the notification came from. A notification you don't recognise
  // is a notification you ignore.
  const title = `ai-comms · ${envelope.type} · ${envelope.from.dev}/${envelope.from.agent}`;
  const message = envelope.subject;

  try {
    notifier.notify({
      title,
      message,
      sound: sound ? true : false,
      wait: false,
    });
  } catch {
    // ignore
  }
}

/** At most one auto-answer failure notification per hour, so a broken CLI
 * session cannot turn into a stream of toasts. */
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
    });
  } catch {
    // ignore
  }
}

function processMessage(
  message: Message,
  project: string,
  config: ConfigV2,
  verbose: boolean,
): void {
  const envelope = parseEnvelopeFromMessage(message.content);
  if (!envelope) {
    if (verbose) {
      daemonLog(project, `Message without valid envelope: ${message.id}`, true);
    }
    return;
  }

  saveCursor(project, { lastMessageId: message.id });

  ingestEnvelope(envelope, project, config.identity.dev, config, verbose);
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
      // A failing answerer is silent by nature: the teammate just never hears
      // back. The usual cause is an expired CLI session, which can sit broken
      // for days. Surface it once so the human can re-authenticate.
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

/** Discord's hard per-request cap on `limit` for channel message fetches. */
const MAX_FETCH_PAGE = 100;
/** How far back to read when there is no cursor yet. */
const COLD_START_HISTORY = 200;

function sortById<T extends { id: string }>(messages: T[]): T[] {
  return [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

async function backfillHistory(
  client: Client,
  channelId: string,
  project: string,
  config: ConfigV2,
  verbose: boolean,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new Error(`Channel ${channelId} is not a valid text channel`);
  }

  const cursor = loadCursor(project);

  // Discord caps `limit` at 100 per request, so both paths have to paginate.
  // Without this, a cold start silently loses every claim older than the last
  // 100 messages, and a daemon that was down for a while misses the backlog.
  const collected: Message[] = [];

  if (cursor?.lastMessageId) {
    let after = cursor.lastMessageId;
    for (;;) {
      const page = await channel.messages.fetch({ after, limit: MAX_FETCH_PAGE });
      if (page.size === 0) break;
      const asc = sortById([...page.values()]);
      collected.push(...asc);
      after = asc[asc.length - 1]!.id;
      if (page.size < MAX_FETCH_PAGE) break;
    }
  } else {
    let before: string | undefined;
    while (collected.length < COLD_START_HISTORY) {
      const page = await channel.messages.fetch({
        limit: Math.min(MAX_FETCH_PAGE, COLD_START_HISTORY - collected.length),
        ...(before ? { before } : {}),
      });
      if (page.size === 0) break;
      const asc = sortById([...page.values()]);
      collected.push(...asc);
      before = asc[0]!.id;
      if (page.size < MAX_FETCH_PAGE) break;
    }
  }

  const sorted = sortById(collected);

  for (const msg of sorted) {
    processMessage(msg, project, config, verbose);
  }

  if (sorted.length > 0) {
    saveCursor(project, { lastMessageId: sorted[sorted.length - 1]!.id });
  }
}

async function runClientForToken(
  group: TokenGroup,
  config: ConfigV2,
  verbose: boolean,
): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const channelIds = new Set(group.channels.map((c) => c.channelId));
  const projectByChannel = new Map(group.channels.map((c) => [c.channelId, c.project]));

  let reconnectAttempt = 0;

  client.on('ready', async () => {
    reconnectAttempt = 0;
    for (const binding of group.channels) {
      daemonLog(binding.project, 'Daemon connected', verbose);
      try {
        await backfillHistory(
          client,
          binding.channelId,
          binding.project,
          config,
          verbose,
        );
      } catch (err) {
        daemonLog(binding.project, `Backfill error: ${String(err)}`, verbose);
      }
    }
  });

  client.on('messageCreate', (message) => {
    if (!channelIds.has(message.channelId)) return;
    const project = projectByChannel.get(message.channelId);
    if (!project) return;
    try {
      processMessage(message, project, config, verbose);
    } catch (err) {
      daemonLog(project, `Error processing message: ${String(err)}`, verbose);
    }
  });

  client.on('error', (err) => {
    for (const binding of group.channels) {
      daemonLog(binding.project, `Client error: ${String(err)}`, verbose);
    }
  });

  const connectWithBackoff = async (): Promise<void> => {
    for (;;) {
      try {
        await client.login(group.token);
        return;
      } catch (err) {
        reconnectAttempt++;
        const delay = Math.min(60_000, 1000 * 2 ** reconnectAttempt);
        for (const binding of group.channels) {
          daemonLog(
            binding.project,
            `Login failed (${String(err)}), retrying in ${delay}ms`,
            verbose,
          );
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };

  await connectWithBackoff();
  return client;
}

export async function runDaemon(options: { verbose?: boolean } = {}): Promise<void> {
  const verbose = options.verbose ?? false;
  const config = loadConfig();
  const groups = collectTokenGroups(config);

  if (groups.length === 0) {
    throw new Error(
      'No projects with a configured token. Run "ai-comms secret set <project>".',
    );
  }

  mkdirSync(getConfigDir(), { recursive: true });

  const projects = [...new Set(groups.flatMap((g) => g.channels.map((c) => c.project)))];
  for (const project of projects) {
    writeDaemonPid(project);
  }

  const clients: Client[] = [];
  for (const group of groups) {
    clients.push(await runClientForToken(group, config, verbose));
  }

  const shutdown = () => {
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
