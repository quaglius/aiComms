import { Client, GatewayIntentBits, type Message } from 'discord.js';
import type { ConfigV2 } from '../config.js';
import { parseEnvelopeFromContent } from '../envelope.js';
import { getEffectiveToken } from '../secrets.js';
import { loadCursor, saveCursor } from '../store.js';
import type { DiscordBusConfig } from './types.js';

const MAX_FETCH_PAGE = 100;
const COLD_START_HISTORY = 200;

export interface DiscordGatewayBinding {
  channelId: string;
  project: string;
}

export interface DiscordGatewayHandlers {
  onEnvelope: (project: string, envelope: NonNullable<ReturnType<typeof parseEnvelopeFromContent>>, messageId: string) => void;
  onLog: (project: string, message: string) => void;
}

function sortById<T extends { id: string }>(messages: T[]): T[] {
  return [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

async function backfillHistory(
  client: Client,
  channelId: string,
  project: string,
  handlers: DiscordGatewayHandlers,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new Error(`Channel ${channelId} is not a valid text channel`);
  }

  const cursor = loadCursor(project);
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
    const envelope = parseEnvelopeFromContent(msg.content);
    if (!envelope) continue;
    handlers.onEnvelope(project, envelope, msg.id);
  }

  if (sorted.length > 0) {
    saveCursor(project, { ...cursor, lastMessageId: sorted[sorted.length - 1]!.id });
  }
}

export async function runDiscordGateway(
  bindings: DiscordGatewayBinding[],
  handlers: DiscordGatewayHandlers,
  token: string,
): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const channelIds = new Set(bindings.map((b) => b.channelId));
  const projectByChannel = new Map(bindings.map((b) => [b.channelId, b.project]));

  let reconnectAttempt = 0;

  client.on('ready', async () => {
    reconnectAttempt = 0;
    for (const binding of bindings) {
      handlers.onLog(binding.project, 'Daemon connected');
      try {
        await backfillHistory(client, binding.channelId, binding.project, handlers);
      } catch (err) {
        handlers.onLog(binding.project, `Backfill error: ${String(err)}`);
      }
    }
  });

  client.on('messageCreate', (message) => {
    if (!channelIds.has(message.channelId)) return;
    const project = projectByChannel.get(message.channelId);
    if (!project) return;
    try {
      const envelope = parseEnvelopeFromContent(message.content);
      if (!envelope) return;
      handlers.onEnvelope(project, envelope, message.id);
    } catch (err) {
      handlers.onLog(project, `Error processing message: ${String(err)}`);
    }
  });

  client.on('error', (err) => {
    for (const binding of bindings) {
      handlers.onLog(binding.project, `Client error: ${String(err)}`);
    }
  });

  const connectWithBackoff = async (): Promise<void> => {
    for (;;) {
      try {
        await client.login(token);
        return;
      } catch (err) {
        reconnectAttempt++;
        const delay = Math.min(60_000, 1000 * 2 ** reconnectAttempt);
        for (const binding of bindings) {
          handlers.onLog(binding.project, `Login failed (${String(err)}), retrying in ${delay}ms`);
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };

  await connectWithBackoff();
  return client;
}

export function collectDiscordBindings(
  config: ConfigV2,
  repoCommsByProject: Map<string, DiscordBusConfig>,
): Array<{ token: string; bindings: DiscordGatewayBinding[] }> {
  const byToken = new Map<string, DiscordGatewayBinding[]>();

  for (const [project, projectConfig] of Object.entries(config.projects ?? {})) {
    const bus = repoCommsByProject.get(project) ??
      (projectConfig.discord
        ? { kind: 'discord' as const, channelId: projectConfig.discord.channelId }
        : null);
    if (!bus || bus.kind !== 'discord') continue;

    try {
      const { token } = getEffectiveToken(project);
      const existing = byToken.get(token) ?? [];
      if (!existing.some((c) => c.channelId === bus.channelId && c.project === project)) {
        existing.push({ channelId: bus.channelId, project });
      }
      byToken.set(token, existing);
    } catch {
      // project without token: daemon skips it; doctor will report it
    }
  }

  return [...byToken.entries()].map(([token, bindings]) => ({ token, bindings }));
}
