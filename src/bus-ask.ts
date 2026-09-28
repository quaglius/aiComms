import type { Envelope } from './envelope.js';
import { createEnvelope, globsOverlap, threadOf, type SendInput } from './envelope.js';
import { appendEnvelope, loadLog } from './store.js';
import type { Transport } from './transports/types.js';
import { ownersForPaths, type CodeownersRule } from './codeowners.js';
import { isOnline, membersByRole, renderDirectory, type MemberProfile } from './presence.js';

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

/**
 * SPEC-v0.7 §2.2: resolves who a `to`-less `bus_ask` should go to, in order:
 * explicit `to` → `paths` via CODEOWNERS, falling back to profiles whose
 * `areas` overlap `paths` when there is no CODEOWNERS file or it names no
 * owner → `role` via `membersByRole` → exactly one other known teammate →
 * error (with the team directory, so the agent can pick). Always excludes
 * `self`. Never resolves to "everyone" — every branch either names specific
 * people or errors.
 *
 * Pure: `codeownersRules` and `profiles` are passed in already loaded, so
 * this has no filesystem or network access of its own (the caller resolves
 * the repo root and fetches presence — see `resolveCodeownersRulesForCtx` /
 * `getCachedProfiles` in src/mcp.ts).
 */
export interface ResolveAskRecipientsInput {
  to?: string[];
  paths?: string[];
  role?: string;
  self: string;
  team: string[];
  profiles: MemberProfile[];
  codeownersRules: CodeownersRule[] | null;
  /** GitHub 403 on listing collaborators (D4) — the team roster is unusable. */
  collaboratorsUnavailable?: boolean;
}

export type AskRoutingOutcome =
  | { kind: 'ok'; recipients: string[]; via?: string }
  | { kind: 'error'; message: string };

function dedupeExcludingSelf(list: string[], self: string): string[] {
  return [...new Set(list)].filter((login) => login !== self);
}

export function resolveAskRecipients(input: ResolveAskRecipientsInput): AskRoutingOutcome {
  const { to, paths, role, self, team, profiles, codeownersRules, collaboratorsUnavailable } = input;

  if (to !== undefined) {
    const recipients = dedupeExcludingSelf(to, self);
    if (recipients.length === 0) {
      return {
        kind: 'error',
        message:
          '`to` cannot be empty (after excluding yourself). Set it to the teammate who owns ' +
          'this topic, or omit it to let ai-comms resolve it.',
      };
    }
    return { kind: 'ok', recipients };
  }

  if (paths && paths.length > 0) {
    if (codeownersRules && codeownersRules.length > 0) {
      const owners = dedupeExcludingSelf(ownersForPaths(codeownersRules, paths), self);
      if (owners.length > 0) {
        return { kind: 'ok', recipients: owners, via: `CODEOWNERS: ${owners.join(', ')}` };
      }
    }
    // No CODEOWNERS file, or it named no owner for these paths — fall back to
    // profiles whose declared areas overlap the asked-about paths.
    const byAreas = dedupeExcludingSelf(
      profiles.filter((p) => p.areas.length > 0 && globsOverlap(p.areas, paths)).map((p) => p.login),
      self,
    );
    if (byAreas.length > 0) {
      return { kind: 'ok', recipients: byAreas, via: `profile areas: ${byAreas.join(', ')}` };
    }
  }

  if (role && role.trim()) {
    const byRole = dedupeExcludingSelf(membersByRole(profiles, role).map((p) => p.login), self);
    if (byRole.length > 0) {
      return { kind: 'ok', recipients: byRole, via: `role "${role}": ${byRole.join(', ')}` };
    }
  }

  if (collaboratorsUnavailable) {
    return {
      kind: 'error',
      message:
        'Could not list repo collaborators (GitHub requires write access on the repo to list ' +
        'them), and `paths`/`role` did not resolve a recipient either. Set `to` explicitly to ' +
        'the teammate who owns this topic.',
    };
  }

  const others = dedupeExcludingSelf(team, self);
  if (others.length === 1) {
    return { kind: 'ok', recipients: others, via: `the only known teammate: ${others[0]}` };
  }

  const listed = others.slice(0, BUS_ASK_MAX_TEAM_LIST);
  const omitted = others.length - listed.length;
  const more = omitted > 0 ? `, and ${omitted} more` : '';
  const who =
    profiles.length > 0
      ? `Team directory:\n${renderDirectory(profiles)}`
      : others.length > 0
        ? `Known teammates: ${listed.join(', ')}${more}.`
        : '(no teammates known)';

  return {
    kind: 'error',
    message:
      'Could not resolve who to ask: set `to`, `paths` (routed via CODEOWNERS or profile ' +
      `areas), or \`role\` to the teammate who owns this topic.\n\n${who}`,
  };
}

/**
 * SPEC-v0.7 §2.3: with presence data available, `bus_ask` fails fast —
 * publishes and returns immediately, without waiting — unless at least one
 * recipient can answer on their own (online, `autoAnswer: true`) and the
 * question doesn't require a human. With no presence data at all (`profiles`
 * is `[]` — no presence issue configured, or it couldn't be read), this
 * always returns `false`: behavior degrades to v0.6 (always wait).
 */
export function shouldFailFast(
  recipients: string[],
  profiles: MemberProfile[],
  needsHuman: boolean | undefined,
  now: number = Date.now(),
): boolean {
  if (profiles.length === 0) return false;
  if (needsHuman) return true;
  const canAutoAnswer = recipients.some((login) => {
    const profile = profiles.find((p) => p.login === login);
    return profile !== undefined && profile.autoAnswer && isOnline(profile, now);
  });
  return !canAutoAnswer;
}

/**
 * The SPEC-v0.7 §2.3 fail-fast notice: who the ask is waiting on and why
 * (offline, auto-answer off, or a human decision required), and how the
 * answer will surface later — `bus_inbox`, and the SessionStart/UserPromptSubmit
 * hook (src/hook.ts) at the recipient's next prompt.
 */
export function formatFailFastNotice(
  askId: string,
  recipients: string[],
  profiles: MemberProfile[],
  needsHuman: boolean | undefined,
  now: number = Date.now(),
): string {
  const statuses = recipients.map((login) => {
    const profile = profiles.find((p) => p.login === login);
    if (needsHuman) return `${login} (needs a human decision)`;
    if (!profile) return `${login} (presence unknown)`;
    if (!isOnline(profile, now)) return `${login} (offline)`;
    if (!profile.autoAnswer) return `${login} (online, but only answers in person)`;
    return login;
  });

  return (
    `Published ask ${askId}. It is waiting in the inbox of ${statuses.join(', ')} — no one who ` +
    'can auto-answer it is online right now. The answer will arrive via `bus_inbox`, and the ' +
    "ai-comms hook will show it at the start of the recipient's next prompt."
  );
}

/**
 * SPEC-v0.7 §2.6: resolves a `bus_ask({ thread })` continuation against the
 * local log — the new ask's `thread` (the given id's root, per `threadOf`, or
 * the id itself when it isn't in the log) and `reply_to` (the thread's most
 * recent `answer`, if any, so a recipient replying to *that* still chains
 * correctly). Returns `{}` for a plain new-thread ask (no `thread` given),
 * unchanged from v0.6.
 */
export function resolveThreadContinuation(
  log: Envelope[],
  threadArg: string | undefined,
): { thread?: string; reply_to?: string } {
  if (!threadArg) return {};
  const found = log.find((e) => e.id === threadArg);
  const root = found ? threadOf(found) : threadArg;

  let latestAnswer: Envelope | null = null;
  for (const env of log) {
    if (env.type !== 'answer' || threadOf(env) !== root) continue;
    if (!latestAnswer || env.ts > latestAnswer.ts) latestAnswer = env;
  }

  return { thread: root, reply_to: latestAnswer?.id };
}

export function buildBusAskEnvelope(
  question: string,
  to: string[],
  from: { dev: string; agent: string; repo: string },
  context?: string,
  extra?: { thread?: string; reply_to?: string; needsHuman?: boolean },
): Envelope {
  const bodyParts = [context, question].filter((part) => part && part.trim().length > 0);
  const body = bodyParts.join('\n\n').slice(0, 4000);
  const subject = question.replace(/\s+/g, ' ').trim().slice(0, 120);

  const input: SendInput = {
    type: 'ask',
    subject: subject || 'question',
    body,
    to,
    ...(extra?.thread !== undefined ? { thread: extra.thread } : {}),
    ...(extra?.reply_to !== undefined ? { reply_to: extra.reply_to } : {}),
    ...(extra?.needsHuman !== undefined ? { needs_human: extra.needsHuman } : {}),
  };

  return createEnvelope(input, from);
}

export function findReplyToAsk(
  log: Envelope[],
  askId: string,
  opts: { threadId?: string; sinceTs?: string } = {},
): Envelope | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const env = log[i]!;
    if (env.id === askId) continue;
    const matchesDirect = env.reply_to === askId;
    // SPEC-v0.7 §2.6: also accept a reply that names the thread rather than
    // this specific ask, as long as it was published after this ask went out
    // (sinceTs) — otherwise a stale earlier answer in the same thread would
    // look like a reply to a brand-new follow-up question.
    const matchesThread =
      opts.threadId !== undefined &&
      threadOf(env) === opts.threadId &&
      (opts.sinceTs === undefined || env.ts > opts.sinceTs);
    if (!matchesDirect && !matchesThread) continue;
    if (env.type === 'answer' || env.type === 'ask' || env.type === 'need') {
      return env;
    }
  }
  return null;
}

/**
 * SPEC-v0.7 §2.5: the display marker for an envelope shown to a human —
 * `null` when nothing needs flagging. An `answer` not explicitly
 * `answered_by: 'human'` is unvalidated (nobody confirmed a person approved
 * it); an `ask`/`need` with `needs_human` must never be treated as answered
 * by an automatic responder.
 */
export function formatDisplayMarker(envelope: Envelope): string | null {
  if (envelope.type === 'answer' && envelope.answered_by !== 'human') {
    return `(automated answer from ${envelope.from.dev}'s AI — not validated by ${envelope.from.dev})`;
  }
  if ((envelope.type === 'ask' || envelope.type === 'need') && envelope.needs_human) {
    return '[needs a human decision]';
  }
  return null;
}

export function formatBusAskReply(envelope: Envelope): string {
  const header = `[${envelope.type} from ${envelope.from.dev}/${envelope.from.agent} · ${envelope.from.repo}]`;
  const marker = formatDisplayMarker(envelope);
  const parts = [header];
  if (marker) parts.push(marker);
  parts.push(envelope.subject);
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
     * it into the local log. Only the reply itself is appended to the local log.
     */
    fetchRemote?: () => Promise<Envelope[]>;
    /**
     * Authors whose remote replies are accepted — the ask's recipients. The
     * daemon filters inbound authors against the collaborators list; this
     * direct poll does not, so it only trusts the people it actually asked.
     */
    acceptReplyFrom?: string[];
    /** SPEC-v0.7 §2.6: also accept a reply that names this ask's thread
     *  rather than the ask itself — see `findReplyToAsk`. */
    threadId?: string;
    /** Only a thread-matched reply published after this timestamp counts (see `findReplyToAsk`). */
    sinceTs?: string;
  } = {},
): Promise<{ kind: 'reply'; envelope: Envelope } | { kind: 'pending' }> {
  const pollMs = options.pollMs ?? BUS_ASK_POLL_MS;
  const loadLogFn = options.loadLogFn ?? loadLog;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const nowFn = options.nowFn ?? (() => Date.now());
  const fetchRemote = options.fetchRemote;
  const threadOpts = { threadId: options.threadId, sinceTs: options.sinceTs };

  const deadline = nowFn() + timeoutMs;

  while (nowFn() < deadline) {
    const reply = findReplyToAsk(loadLogFn(project), askId, threadOpts);
    if (reply) return { kind: 'reply', envelope: reply };

    if (fetchRemote) {
      try {
        // Only the reply is persisted. Writing every fetched envelope into the
        // log would mark them as already seen, and the daemon only notifies
        // and auto-answers envelopes it appends itself — an ask directed at
        // us that arrived while we were waiting would then be dropped silently.
        const remoteEnvelopes = (await fetchRemote()).filter(
          (e) => !options.acceptReplyFrom || options.acceptReplyFrom.includes(e.from.dev),
        );
        const remoteReply = findReplyToAsk(remoteEnvelopes, askId, threadOpts);
        if (remoteReply) {
          appendEnvelope(remoteReply, project);
          return { kind: 'reply', envelope: remoteReply };
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
