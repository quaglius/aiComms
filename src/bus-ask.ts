import type { Envelope } from './envelope.js';
import { createEnvelope, type SendInput } from './envelope.js';
import { appendEnvelope, loadLog } from './store.js';
import type { Transport } from './transports/types.js';

export const BUS_ASK_POLL_MS = 2000;
/** Poll cadence used when we can also ask GitHub directly (see D2 in ANALISIS-v0.5.md). */
export const BUS_ASK_GITHUB_POLL_MS = 3000;
export const BUS_ASK_DEFAULT_TIMEOUT_S = 60;
export const BUS_ASK_MAX_TIMEOUT_S = 120;

/** Cap on how many teammates we'll list by name in an error message. */
export const BUS_ASK_MAX_TEAM_LIST = 20;

export const PENDING_REPLY_NOTICE =
  'No answer arrived before the timeout. The ask remains in the recipient inbox as pending.';

export function clampBusAskTimeout(timeoutS?: number): number {
  const value = timeoutS ?? BUS_ASK_DEFAULT_TIMEOUT_S;
  return Math.min(Math.max(1, value), BUS_ASK_MAX_TIMEOUT_S);
}

/**
 * @deprecated superseded by `resolveBusAskRecipients`, which refuses to
 * default to the whole team (see D3 in docs/ANALISIS-v0.5.md). Kept only so
 * older callers/tests that reach for "everyone but me" keep working.
 */
export function defaultBusAskRecipients(team: string[], dev: string): string[] | null {
  const recipients = team.filter((member) => member !== dev);
  return recipients.length > 0 ? recipients : null;
}

export type BusAskRecipientsOutcome =
  | { kind: 'ok'; recipients: string[] }
  | { kind: 'error'; message: string };

/**
 * Resolves who a `to`-less `bus_ask` should go to, without ever falling back
 * to "everyone" (D3): a broadcast wakes every teammate with auto-answer on,
 * and each one spends quota answering the same question. Auto-resolution
 * only kicks in when exactly one other teammate is known; otherwise the
 * caller has to name the person who owns the topic.
 */
export function resolveBusAskRecipients(
  team: string[],
  dev: string,
  options: { collaboratorsUnavailable?: boolean } = {},
): BusAskRecipientsOutcome {
  if (options.collaboratorsUnavailable) {
    return {
      kind: 'error',
      message:
        'Could not list repo collaborators (GitHub requires write access on the repo to list ' +
        'them). Set `to` explicitly to the teammate who owns this topic.',
    };
  }

  const others = team.filter((member) => member !== dev);

  if (others.length === 1) {
    return { kind: 'ok', recipients: others };
  }

  if (others.length === 0) {
    return {
      kind: 'error',
      message: 'No known teammates. Set `to` explicitly to the teammate who owns this topic.',
    };
  }

  const listed = others.slice(0, BUS_ASK_MAX_TEAM_LIST);
  const omitted = others.length - listed.length;
  const more = omitted > 0 ? `, and ${omitted} more` : '';
  return {
    kind: 'error',
    message:
      '`to` is required: more than one teammate is known, and bus_ask never broadcasts to ' +
      `the whole team. Known teammates: ${listed.join(', ')}${more}. Set \`to\` to the ` +
      'teammate who owns this topic.',
  };
}

export function buildBusAskEnvelope(
  question: string,
  to: string[],
  from: { dev: string; agent: string; repo: string },
  context?: string,
): Envelope {
  const bodyParts = [context, question].filter((part) => part && part.trim().length > 0);
  const body = bodyParts.join('\n\n').slice(0, 4000);
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

/**
 * Builds `waitForBusAskReply`'s `fetchRemote`: a poller that pages a
 * transport's `fetchSince` forward from a starting cursor. Each call
 * advances the cursor to whatever the transport reports next, so repeated
 * calls only ever return genuinely new comments — never the same one twice.
 */
export function createGitHubAskFetcher(
  transport: Pick<Transport, 'fetchSince'>,
  initialCursor: string | null,
): () => Promise<Envelope[]> {
  let cursor = initialCursor;
  return async () => {
    const result = await transport.fetchSince(cursor);
    cursor = result.cursor;
    return result.envelopes;
  };
}

/**
 * The message shown when a `bus_ask` times out without a reply. When the
 * local daemon isn't running, the recipient's agent has no way to see the
 * ask and answer it automatically, so we say so and point at how to start
 * one (D2 in docs/ANALISIS-v0.5.md).
 */
export function formatPendingBusAsk(
  askId: string,
  options: { daemonRunning?: boolean } = {},
): string {
  const daemonNotice =
    options.daemonRunning === false
      ? '\n\nThe ai-comms daemon does not appear to be running for this project, so replies ' +
        'posted after this timeout will not be delivered automatically. Start it with ' +
        '`npx @quaglius/ai-comms daemon`, or re-run bus_ask once the answer is posted.'
      : '';
  return `${PENDING_REPLY_NOTICE}\nAsk id: ${askId}${daemonNotice}`;
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
    /**
     * Optional direct poll of the transport (GitHub only), so a reply that
     * has landed on the bus is seen even when no daemon is running to write
     * it into the local log. Any envelopes it returns are appended to the
     * local log with `appendEnvelope` before we look for the reply again.
     */
    fetchRemote?: () => Promise<Envelope[]>;
  } = {},
): Promise<{ kind: 'reply'; envelope: Envelope } | { kind: 'pending' }> {
  const pollMs = options.pollMs ?? BUS_ASK_POLL_MS;
  const loadLogFn = options.loadLogFn ?? loadLog;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const nowFn = options.nowFn ?? (() => Date.now());
  const fetchRemote = options.fetchRemote;

  const deadline = nowFn() + timeoutMs;

  while (nowFn() < deadline) {
    const reply = findReplyToAsk(loadLogFn(project), askId);
    if (reply) return { kind: 'reply', envelope: reply };

    if (fetchRemote) {
      try {
        const remoteEnvelopes = await fetchRemote();
        for (const envelope of remoteEnvelopes) {
          appendEnvelope(envelope, project);
        }
        if (remoteEnvelopes.length > 0) {
          const remoteReply = findReplyToAsk(loadLogFn(project), askId);
          if (remoteReply) return { kind: 'reply', envelope: remoteReply };
        }
      } catch {
        // Transient GitHub error: keep relying on the local log/daemon for this round.
      }
    }

    const remaining = deadline - nowFn();
    if (remaining <= 0) break;
    await sleepFn(Math.min(pollMs, remaining));
  }

  return { kind: 'pending' };
}
