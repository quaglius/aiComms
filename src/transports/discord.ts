import type { Envelope } from '../envelope.js';
import { parseEnvelopeFromContent } from '../envelope.js';
import { getEffectiveToken } from '../secrets.js';
import type {
  Transport,
  TransportFetchResult,
  TransportIdentity,
  TransportSendResult,
} from './types.js';
import { sendEnvelopeToChannel, fetchMessagesAfter } from './discord-api.js';

export interface DiscordTransportOptions {
  channelId: string;
  project: string;
  configuredDev: string;
  token?: string;
}

export class DiscordTransport implements Transport {
  private readonly channelId: string;
  private readonly project: string;
  private readonly configuredDev: string;
  private readonly token?: string;

  constructor(options: DiscordTransportOptions) {
    this.channelId = options.channelId;
    this.project = options.project;
    this.configuredDev = options.configuredDev;
    this.token = options.token;
  }

  private resolveToken(): string {
    if (this.token) return this.token;
    return getEffectiveToken(this.project).token;
  }

  describe(): string {
    return `Discord channel ${this.channelId} (legacy — identity is not authenticated)`;
  }

  async whoami(): Promise<TransportIdentity> {
    return {
      dev: this.configuredDev,
      authenticated: false,
      warning:
        'Discord transport does not authenticate identity. Run "ai-comms setup" to migrate to GitHub.',
    };
  }

  async send(envelope: Envelope): Promise<TransportSendResult> {
    const result = await sendEnvelopeToChannel(envelope, this.channelId, this.resolveToken());
    return { id: result.id, truncated: result.truncated };
  }

  async fetchSince(cursor: string | null): Promise<TransportFetchResult> {
    if (!cursor) {
      return { envelopes: [], cursor };
    }

    const messages = await fetchMessagesAfter(this.channelId, this.resolveToken(), cursor);
    const envelopes: Envelope[] = [];
    let latestCursor = cursor;

    for (const message of messages) {
      const parsed = parseEnvelopeFromContent(message.content);
      if (!parsed) continue;
      envelopes.push(parsed);
      if (BigInt(message.id) > BigInt(latestCursor)) {
        latestCursor = message.id;
      }
    }

    return { envelopes, cursor: latestCursor };
  }
}
