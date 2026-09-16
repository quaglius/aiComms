import type { Envelope } from '../envelope.js';

export interface DiscordWebhookNotifierConfig {
  kind: 'discord-webhook';
  urlRef: string;
}

export type NotifierConfig = DiscordWebhookNotifierConfig;

export interface Notifier {
  notify(envelope: Envelope): Promise<void>;
  describe(): string;
}
