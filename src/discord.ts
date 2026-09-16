import type { Envelope } from './envelope.js';
import { renderEnvelope } from './envelope.js';

const DISCORD_API = 'https://discord.com/api/v10';

export const REQUIRED_PERMISSIONS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
} as const;

export const REQUIRED_PERMISSION_BITS =
  REQUIRED_PERMISSIONS.VIEW_CHANNEL |
  REQUIRED_PERMISSIONS.SEND_MESSAGES |
  REQUIRED_PERMISSIONS.READ_MESSAGE_HISTORY;

export const PERMISSION_NAMES: Record<string, bigint> = {
  VIEW_CHANNEL: REQUIRED_PERMISSIONS.VIEW_CHANNEL,
  SEND_MESSAGES: REQUIRED_PERMISSIONS.SEND_MESSAGES,
  READ_MESSAGE_HISTORY: REQUIRED_PERMISSIONS.READ_MESSAGE_HISTORY,
};

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

export async function discordFetch(
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
        throw new DiscordApiError('Discord rate limit exceeded', 429, retryMs);
      }
      await sleep(retryMs);
      continue;
    }

    return response;
  }

  throw new DiscordApiError('Failed after retries', 429);
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
      `Failed to send message (${response.status}): ${text.slice(0, 200)}`,
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
        `Failed to read history (${response.status}): ${text.slice(0, 200)}`,
        response.status,
      );
    }

    const batch = (await response.json()) as DiscordMessage[];
    if (batch.length === 0) break;

    collected.push(...batch);
    after = batch[0]!.id;
    if (batch.length < batchLimit) break;
  }

  return collected.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
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
        `Failed to read history (${response.status}): ${text.slice(0, 200)}`,
        response.status,
      );
    }

    const batch = (await response.json()) as DiscordMessage[];
    if (batch.length === 0) break;
    collected.push(...batch);
    before = batch[batch.length - 1]!.id;
    if (batch.length < batchLimit) break;
  }

  return collected.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

export async function getBotUser(token: string): Promise<{ id: string; username: string }> {
  const response = await discordFetch(`${DISCORD_API}/users/@me`, token, { method: 'GET' });
  if (!response.ok) {
    throw new DiscordApiError('Invalid token or no access', response.status);
  }
  return (await response.json()) as { id: string; username: string };
}

export async function getChannel(
  channelId: string,
  token: string,
): Promise<{
  id: string;
  name?: string;
  type: number;
  guild_id?: string;
  permission_overwrites?: PermissionOverwrite[];
}> {
  const response = await discordFetch(
    `${DISCORD_API}/channels/${channelId}`,
    token,
    { method: 'GET' },
  );
  if (!response.ok) {
    throw new DiscordApiError('Channel inaccessible or invalid ID', response.status);
  }
  return (await response.json()) as {
    id: string;
    name?: string;
    type: number;
    guild_id?: string;
    permission_overwrites?: PermissionOverwrite[];
  };
}

interface PermissionOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

interface GuildRole {
  id: string;
  permissions: string;
  position: number;
}

export function computeEffectivePermissions(
  guildId: string,
  everyonePermissions: bigint,
  memberRoleIds: string[],
  roles: GuildRole[],
  overwrites: PermissionOverwrite[],
  memberId: string,
): bigint {
  const roleMap = new Map(roles.map((r) => [r.id, r]));
  const memberRoles = memberRoleIds
    .map((id) => roleMap.get(id))
    .filter((r): r is GuildRole => Boolean(r))
    .sort((a, b) => b.position - a.position);

  let perms = everyonePermissions;
  for (const role of memberRoles) {
    perms |= BigInt(role.permissions || '0');
  }

  if ((perms & (1n << 3n)) !== 0n) {
    return (1n << 31n) - 1n;
  }

  const applyOverwrite = (overwrite: PermissionOverwrite): void => {
    const allow = BigInt(overwrite.allow || '0');
    const deny = BigInt(overwrite.deny || '0');
    perms = (perms & ~deny) | allow;
  };

  const everyoneOverwrite = overwrites.find((o) => o.type === 0 && o.id === guildId);
  if (everyoneOverwrite) applyOverwrite(everyoneOverwrite);

  for (const role of memberRoles) {
    const ow = overwrites.find((o) => o.type === 0 && o.id === role.id);
    if (ow) applyOverwrite(ow);
  }

  const memberOverwrite = overwrites.find((o) => o.type === 1 && o.id === memberId);
  if (memberOverwrite) applyOverwrite(memberOverwrite);

  return perms;
}

export async function checkBotPermissions(
  channelId: string,
  token: string,
): Promise<{ ok: boolean; missing: string[] }> {
  const channel = await getChannel(channelId, token);
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

  const member = (await memberResp.json()) as { roles: string[] };

  const guildResp = await discordFetch(
    `${DISCORD_API}/guilds/${channel.guild_id}`,
    token,
    { method: 'GET' },
  );
  if (!guildResp.ok) {
    return { ok: false, missing: ['guild access'] };
  }

  const guild = (await guildResp.json()) as { id: string; roles: GuildRole[] };
  const everyoneRole = guild.roles.find((r) => r.id === guild.id);
  const everyonePerms = BigInt(everyoneRole?.permissions || '0');

  const effective = computeEffectivePermissions(
    guild.id,
    everyonePerms,
    member.roles,
    guild.roles,
    channel.permission_overwrites ?? [],
    bot.id,
  );

  const missing: string[] = [];
  for (const [name, bit] of Object.entries(PERMISSION_NAMES)) {
    if ((effective & bit) === 0n) {
      missing.push(name);
    }
  }

  return { ok: missing.length === 0, missing };
}
