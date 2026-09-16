import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits, type Message } from 'discord.js';
import notifier from 'node-notifier';
import type { ConfigV2 } from './config.js';
import { loadConfig } from './config.js';
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
      // proyecto sin token: el daemon lo omite; doctor lo reportará
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

  const title = `${envelope.type} · ${envelope.from.dev}/${envelope.from.agent}`;
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

function processMessage(
  message: Message,
  project: string,
  dev: string,
  verbose: boolean,
): void {
  const envelope = parseEnvelopeFromMessage(message.content);
  if (!envelope) {
    if (verbose) {
      daemonLog(project, `Mensaje sin sobre válido: ${message.id}`, true);
    }
    return;
  }

  saveCursor(project, { lastMessageId: message.id });

  if (envelope.from.dev === dev) return;

  appendEnvelope(envelope, project);

  if (shouldNotify(envelope, dev)) {
    notifyEnvelope(envelope, dev);
  }
}

async function backfillHistory(
  client: Client,
  channelId: string,
  project: string,
  dev: string,
  verbose: boolean,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new Error(`Canal ${channelId} no es un canal de texto válido`);
  }

  const cursor = loadCursor(project);
  let messages;

  if (cursor?.lastMessageId) {
    messages = await channel.messages.fetch({ after: cursor.lastMessageId, limit: 100 });
  } else {
    messages = await channel.messages.fetch({ limit: 200 });
  }

  const sorted = [...messages.values()].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : 1,
  );

  for (const msg of sorted) {
    processMessage(msg, project, dev, verbose);
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
      daemonLog(binding.project, 'Daemon conectado', verbose);
      try {
        await backfillHistory(
          client,
          binding.channelId,
          binding.project,
          config.identity.dev,
          verbose,
        );
      } catch (err) {
        daemonLog(binding.project, `Error en backfill: ${String(err)}`, verbose);
      }
    }
  });

  client.on('messageCreate', (message) => {
    if (!channelIds.has(message.channelId)) return;
    const project = projectByChannel.get(message.channelId);
    if (!project) return;
    try {
      processMessage(message, project, config.identity.dev, verbose);
    } catch (err) {
      daemonLog(project, `Error procesando mensaje: ${String(err)}`, verbose);
    }
  });

  client.on('error', (err) => {
    for (const binding of group.channels) {
      daemonLog(binding.project, `Error de cliente: ${String(err)}`, verbose);
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
            `Login falló (${String(err)}), reintento en ${delay}ms`,
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
      'No hay proyectos con token configurado. Ejecutá "ai-comms secret set <project>".',
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
    // mantener vivo
  });
}
