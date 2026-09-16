import type { Envelope } from './envelope.js';
import { createEnvelope, type SendInput } from './envelope.js';
import { loadLog } from './store.js';

export const BUS_ASK_POLL_MS = 2000;
export const BUS_ASK_DEFAULT_TIMEOUT_S = 60;
export const BUS_ASK_MAX_TIMEOUT_S = 120;

export const PENDING_REPLY_NOTICE =
  'No answer arrived before the timeout. The ask remains in the recipient inbox as pending.';

export function clampBusAskTimeout(timeoutS?: number): number {
  const value = timeoutS ?? BUS_ASK_DEFAULT_TIMEOUT_S;
  return Math.min(Math.max(1, value), BUS_ASK_MAX_TIMEOUT_S);
}

export function defaultBusAskRecipients(team: string[], dev: string): string[] | null {
  const recipients = team.filter((member) => member !== dev);
  return recipients.length > 0 ? recipients : null;
}

export function buildBusAskEnvelope(
  question: string,
  to: string[],
  from: { dev: string; agent: string; repo: string },
  context?: string,
): Envelope {
  const bodyParts = [context, question].filter((part) => part && part.trim().length > 0);
  const body = bodyParts.join('\n\n').slice(0, 600);
  const subject = question.replace(/\s+/g, ' ').trim().slice(0, 120);

  const input: SendInput = {
    type: 'ask',
    subject: subject || 'question',
    body,
    to,
  };

  return createEnvelope(input, from);
}

export function findReplyToAsk(log: Envelope[], askId: string): Envelope | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const env = log[i]!;
    if (env.reply_to !== askId) continue;
    if (env.type === 'answer' || env.type === 'ask' || env.type === 'need') {
      return env;
    }
  }
  return null;
}

export function formatBusAskReply(envelope: Envelope): string {
  const header = `[${envelope.type} from ${envelope.from.dev}/${envelope.from.agent} · ${envelope.from.repo}]`;
  const parts = [header, envelope.subject];
  if (envelope.body) parts.push(envelope.body);
  return parts.join('\n');
}

export async function waitForBusAskReply(
  project: string,
  askId: string,
  timeoutMs: number,
  options: {
    pollMs?: number;
    loadLogFn?: (project: string) => Envelope[];
    sleepFn?: (ms: number) => Promise<void>;
    nowFn?: () => number;
  } = {},
): Promise<{ kind: 'reply'; envelope: Envelope } | { kind: 'pending' }> {
  const pollMs = options.pollMs ?? BUS_ASK_POLL_MS;
  const loadLogFn = options.loadLogFn ?? loadLog;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const nowFn = options.nowFn ?? (() => Date.now());

  const deadline = nowFn() + timeoutMs;

  while (nowFn() < deadline) {
    const reply = findReplyToAsk(loadLogFn(project), askId);
    if (reply) return { kind: 'reply', envelope: reply };

    const remaining = deadline - nowFn();
    if (remaining <= 0) break;
    await sleepFn(Math.min(pollMs, remaining));
  }

  return { kind: 'pending' };
}
