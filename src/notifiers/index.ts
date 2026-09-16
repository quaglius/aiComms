import type { NotifierConfig } from './types.js';
import { DiscordWebhookNotifier } from './discord-webhook.js';
import type { Notifier } from './types.js';

export type { Notifier, NotifierConfig, DiscordWebhookNotifierConfig } from './types.js';
export { formatNotifierLine } from './discord-webhook.js';

export function createNotifiers(configs: NotifierConfig[], project: string): Notifier[] {
  return configs.map((cfg) => {
    if (cfg.kind === 'discord-webhook') {
      return new DiscordWebhookNotifier(cfg, project);
    }
    throw new Error(`Unknown notifier kind: ${(cfg as { kind: string }).kind}`);
  });
}
