import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits, type Message } from 'discord.js';
import notifier from 'node-notifier';
import { CONFIG_DIR, getEffectiveToken, loadConfig, type Config } from './config.js';
import { parseEnvelopeFromMessage, type Envelope } from './envelope.js';
import {
  appendEnvelope,
  DAEMON_LOG_PATH,
  loadCursor,
  saveCursor,
  writeDaemonPid,
  removeDaemonPid,
} from './store.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function daemonLog(message: string, verbose: boolean): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  rotateLogIfNeeded();
  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(DAEMON_LOG_PATH, line, 'utf8');
  if (verbose) {
    process.stderr.write(line);
  }
}

function rotateLogIfNeeded(): void {
  if (!existsSync(DAEMON_LOG_PATH)) return;
  const size = statSync(DAEMON_LOG_PATH).size;
  if (size < MAX_LOG_BYTES) return;
  const rotated = path.join(CONFIG_DIR, 'daemon.log.1');
  if (existsSync(rotated)) {
    try {
      renameSync(rotated, path.join(CONFIG_DIR, 'daemon.log.2'));
    } catch {
      // ignore
    }
  }
  renameSync(DAEMON_LOG_PATH, rotated);
}

function shouldNotify(envelope: Envelope, dev: string): boolean {
  const directed =
    envelope.to.includes('*') || envelope.to.includes(dev);
  if (!directed) return false;
  if (new Date(envelope.ttl) <= new Date()) return false;
  if (envelope.hops >= 3) return false;
  return true;
}

function notifyEnvelope(envelope: Envelope, config: Config): void {
  const sound =
    (envelope.type === 'need' || envelope.type === 'ask') &&
    envelope.to.includes(config.dev) &&
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
    daemonLog(`No se pudo notificar: ${envelope.id}`, false);
  }
}

function processMessage(
  message: Message,
  config: Config,
  verbose: boolean,
): void {
  const envelope = parseEnvelopeFromMessage(message.content);
  if (!envelope) {
    if (verbose) {
      daemonLog(`Mensaje sin sobre válido: ${message.id}`, true);
    }
    return;
  }

  saveCursor({ lastMessageId: message.id });

  if (envelope.from.dev === config.dev) return;

  appendEnvelope(envelope);

  if (shouldNotify(envelope, config.dev)) {
    notifyEnvelope(envelope, config);
  }
}

async function backfillHistory(client: Client, config: Config, verbose: boolean): Promise<void> {
  const channel = await client.channels.fetch(config.discord.channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new Error('Canal configurado no es un canal de texto válido');
  }

  const cursor = loadCursor();
  let messages;

  if (cursor?.lastMessageId) {
    messages = await channel.messages.fetch({ after: cursor.lastMessageId, limit: 100 });
  } else {
    messages = await channel.messages.fetch({ limit: 200 });
  }

  const sorted = [...messages.values()].sort(
    (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
  );

  for (const msg of sorted) {
    processMessage(msg, config, verbose);
  }

  if (sorted.length > 0) {
    saveCursor({ lastMessageId: sorted[sorted.length - 1]!.id });
  }
}

export async function runDaemon(options: { verbose?: boolean } = {}): Promise<void> {
  const verbose = options.verbose ?? false;
  const config = loadConfig();
  const token = getEffectiveToken(config);

  writeDaemonPid();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  let reconnectAttempt = 0;

  client.on('ready', async () => {
    reconnectAttempt = 0;
    daemonLog('Daemon conectado', verbose);
    try {
      await backfillHistory(client, config, verbose);
    } catch (err) {
      daemonLog(`Error en backfill: ${String(err)}`, verbose);
    }
  });

  client.on('messageCreate', (message) => {
    if (message.author.bot && message.author.id !== client.user?.id) {
      // otros bots: procesar igual si tienen sobre
    }
    if (message.channelId !== config.discord.channelId) return;
    try {
      processMessage(message, config, verbose);
    } catch (err) {
      daemonLog(`Error procesando mensaje: ${String(err)}`, verbose);
    }
  });

  client.on('error', (err) => {
    daemonLog(`Error de cliente: ${String(err)}`, verbose);
  });

  client.on('shardDisconnect', () => {
    daemonLog('Desconectado, reintentando…', verbose);
  });

  const connectWithBackoff = async (): Promise<void> => {
    for (;;) {
      try {
        await client.login(token);
        return;
      } catch (err) {
        reconnectAttempt++;
        const delay = Math.min(60_000, 1000 * 2 ** reconnectAttempt);
        daemonLog(`Login falló (${String(err)}), reintento en ${delay}ms`, verbose);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };

  process.on('SIGINT', () => {
    removeDaemonPid();
    client.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    removeDaemonPid();
    client.destroy();
    process.exit(0);
  });

  await connectWithBackoff();

  client.on('shardError', async () => {
    reconnectAttempt++;
    const delay = Math.min(60_000, 1000 * 2 ** reconnectAttempt);
    daemonLog(`Shard error, reintento en ${delay}ms`, verbose);
    await new Promise((r) => setTimeout(r, delay));
    try {
      await client.login(token);
    } catch {
      // loop continúa en próximo evento
    }
  });
}
