import type { Envelope } from './envelope.js';
import { renderEnvelope } from './envelope.js';

const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordMessage {
  id: string;
  content: string;
}

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

function parseRetryAfter(headers: Headers): number | undefined {
  const resetAfter = headers.get('X-RateLimit-Reset-After');
  if (resetAfter) {
    const n = Number.parseFloat(resetAfter);
    if (Number.isFinite(n)) return Math.ceil(n * 1000);
  }
  const retryAfter = headers.get('Retry-After');
  if (retryAfter) {
    const n = Number.parseFloat(retryAfter);
    if (Number.isFinite(n)) return Math.ceil(n * 1000);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discordFetch(
  url: string,
  token: string,
  init: RequestInit,
  maxAttempts = 3,
): Promise<Response> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 429) {
      const retryMs = parseRetryAfter(response.headers) ?? 1000 * attempt;
      if (attempt >= maxAttempts) {
        throw new DiscordApiError('Rate limit excedido en Discord', 429, retryMs);
      }
      await sleep(retryMs);
      continue;
    }

    return response;
  }

  throw new DiscordApiError('Falló tras reintentos', 429);
}

export async function sendEnvelope(
  envelope: Envelope,
  channelId: string,
  token: string,
): Promise<{ id: string; truncated: boolean }> {
  const { content, truncated } = renderEnvelope(envelope);
  const url = `${DISCORD_API}/channels/${channelId}/messages`;
  const response = await discordFetch(url, token, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new DiscordApiError(
      `Error al enviar mensaje (${response.status}): ${text.slice(0, 200)}`,
      response.status,
    );
  }

  const data = (await response.json()) as { id: string };
  return { id: data.id, truncated };
}

export async function fetchMessagesAfter(
  channelId: string,
  token: string,
  afterMessageId: string,
  limit = 100,
): Promise<DiscordMessage[]> {
  const collected: DiscordMessage[] = [];
  let after = afterMessageId;

  while (collected.length < limit) {
    const batchLimit = Math.min(100, limit - collected.length);
    const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
    url.searchParams.set('after', after);
    url.searchParams.set('limit', String(batchLimit));

    const response = await discordFetch(url.toString(), token, { method: 'GET' });
    if (!response.ok) {
      const text = await response.text();
      throw new DiscordApiError(
        `Error al leer historial (${response.status}): ${text.slice(0, 200)}`,
        response.status,
      );
    }

    const batch = (await response.json()) as DiscordMessage[];
    if (batch.length === 0) break;

    collected.push(...batch);
    after = batch[0]!.id;
    if (batch.length < batchLimit) break;
  }

  return collected.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
}

export async function fetchRecentMessages(
  channelId: string,
  token: string,
  limit = 200,
): Promise<DiscordMessage[]> {
  const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
  url.searchParams.set('limit', String(Math.min(limit, 100)));

  const collected: DiscordMessage[] = [];
  let before: string | undefined;

  while (collected.length < limit) {
    const pageUrl = new URL(url);
    if (before) pageUrl.searchParams.set('before', before);
    const batchLimit = Math.min(100, limit - collected.length);
    pageUrl.searchParams.set('limit', String(batchLimit));

    const response = await discordFetch(pageUrl.toString(), token, { method: 'GET' });
    if (!response.ok) {
      const text = await response.text();
      throw new DiscordApiError(
        `Error al leer historial (${response.status}): ${text.slice(0, 200)}`,
        response.status,
      );
    }

    const batch = (await response.json()) as DiscordMessage[];
    if (batch.length === 0) break;
    collected.push(...batch);
    before = batch[batch.length - 1]!.id;
    if (batch.length < batchLimit) break;
  }

  return collected.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
}

export async function getBotUser(token: string): Promise<{ id: string; username: string }> {
  const response = await discordFetch(`${DISCORD_API}/users/@me`, token, { method: 'GET' });
  if (!response.ok) {
    throw new DiscordApiError('Token inválido o sin acceso', response.status);
  }
  return (await response.json()) as { id: string; username: string };
}

export async function getChannel(
  channelId: string,
  token: string,
): Promise<{ id: string; name?: string; type: number }> {
  const response = await discordFetch(
    `${DISCORD_API}/channels/${channelId}`,
    token,
    { method: 'GET' },
  );
  if (!response.ok) {
    throw new DiscordApiError('Canal inaccesible o ID inválido', response.status);
  }
  return (await response.json()) as { id: string; name?: string; type: number };
}

export async function checkBotPermissions(
  channelId: string,
  token: string,
): Promise<{ ok: boolean; missing: string[] }> {
  const response = await discordFetch(
    `${DISCORD_API}/channels/${channelId}`,
    token,
    { method: 'GET' },
  );
  if (!response.ok) {
    return { ok: false, missing: ['VIEW_CHANNEL'] };
  }

  const channel = (await response.json()) as { guild_id?: string };
  if (!channel.guild_id) {
    return { ok: true, missing: [] };
  }

  const bot = await getBotUser(token);
  const memberResp = await discordFetch(
    `${DISCORD_API}/guilds/${channel.guild_id}/members/${bot.id}`,
    token,
    { method: 'GET' },
  );
  if (!memberResp.ok) {
    return { ok: false, missing: ['guild membership'] };
  }

  return { ok: true, missing: [] };
}
