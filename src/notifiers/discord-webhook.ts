import type { Envelope, MessageType } from '../envelope.js';
import { resolveSecretRef } from '../secrets.js';
import type { DiscordWebhookNotifierConfig, Notifier } from './types.js';

const TYPE_EMOJI: Record<MessageType, string> = {
  claim: '🔒',
  release: '🔓',
  contract: '📜',
  need: '🆘',
  ask: '❓',
  answer: '💬',
  fyi: 'ℹ️',
  done: '✅',
};

export function formatNotifierLine(envelope: Envelope): string {
  const emoji = TYPE_EMOJI[envelope.type];
  return `${emoji} **${envelope.type}** ${envelope.from.dev}/${envelope.from.agent} · ${envelope.from.repo}\n${envelope.subject}`;
}

export class DiscordWebhookNotifier implements Notifier {
  private readonly url: string;

  constructor(config: DiscordWebhookNotifierConfig, project: string) {
    this.url = resolveSecretRef(config.urlRef, project);
  }

  describe(): string {
    return 'Discord webhook (one-way notification)';
  }

  async notify(envelope: Envelope): Promise<void> {
    const content = formatNotifierLine(envelope);
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Discord webhook notification failed (${response.status}): ${text.slice(0, 200)}`,
      );
    }
  }
}
