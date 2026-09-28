import { ulid } from 'ulid';
import { z } from 'zod';

export const MESSAGE_TYPES = [
  'claim',
  'release',
  'contract',
  'need',
  'ask',
  'answer',
  'fyi',
  'done',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

const isoDate = z.string().datetime({ offset: true });

export const FromSchema = z.object({
  dev: z.string().min(1),
  agent: z.string().min(1),
  repo: z.string().min(1),
});

export const RefsSchema = z
  .object({
    branch: z.string().optional(),
    pr: z.string().url().optional(),
    paths: z.array(z.string()).max(20).optional(),
    until: isoDate.optional(),
  })
  .strict();

export const ANSWERED_BY_VALUES = ['agent', 'human'] as const;
export type AnsweredBy = (typeof ANSWERED_BY_VALUES)[number];

export const EnvelopeSchema = z
  .object({
    v: z.union([z.literal(1), z.literal(2)]),
    id: z.string().min(1),
    ts: isoDate,
    from: FromSchema,
    to: z.array(z.string().min(1)).min(1),
    type: z.enum(MESSAGE_TYPES),
    subject: z.string().max(120),
    body: z.string().max(4000).default(''),
    refs: RefsSchema.default({}),
    reply_to: z.string().nullable().default(null),
    hops: z.number().int().min(0).max(3),
    ttl: isoDate,
    /** Id of the root envelope of this conversation. `threadOf` falls back to
     *  `id` when absent, so a message that starts a thread need not set it. */
    thread: z.string().min(1).nullable().optional(),
    /** Only meaningful on `answer`. Absent (or read as absent by an older
     *  client) means the same as `'agent'`: nobody validated it — see
     *  `threadOf` and docs/PROTOCOL.md. */
    answered_by: z.enum(ANSWERED_BY_VALUES).optional(),
    /** On `ask`/`need`: this question needs a human decision and must never
     *  trigger the auto-answerer. */
    needs_human: z.boolean().optional(),
  })
  .strict();

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type Refs = z.infer<typeof RefsSchema>;
export type From = z.infer<typeof FromSchema>;

export const SendInputShape = {
  type: z.enum(MESSAGE_TYPES),
  subject: z.string().max(120),
  body: z.string().max(4000).optional(),
  to: z.array(z.string().min(1)).optional(),
  refs: RefsSchema.optional(),
  reply_to: z.string().nullable().optional(),
  thread: z.string().min(1).nullable().optional(),
  answered_by: z.enum(ANSWERED_BY_VALUES).optional(),
  needs_human: z.boolean().optional(),
} as const;

export const SendInputSchema = z.object(SendInputShape).strict();

export type SendInput = z.infer<typeof SendInputSchema>;

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

export const DISCORD_RENDER_CHAR_LIMIT = 1900;
export const DISCORD_BODY_MAX = 600;
export const GITHUB_RENDER_CHAR_LIMIT = 65536;
export const GITHUB_BODY_MAX = 4000;

export interface RenderOptions {
  charLimit?: number;
  bodyMax?: number;
}

export function defaultTtl(fromTs: string): string {
  const base = new Date(fromTs);
  base.setUTCHours(base.getUTCHours() + 24);
  return base.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function createEnvelope(
  input: SendInput,
  from: From,
  overrides?: Partial<Pick<Envelope, 'id' | 'ts' | 'hops' | 'ttl'>>,
): Envelope {
  const ts = overrides?.ts ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // v:2 is emitted only when one of the new fields is actually present —
  // a v:1 envelope must round-trip byte-for-byte the way a pre-0.7 reader
  // expects, so we must not add the keys at all when they're unset (a zod
  // `.optional()` key present with value `undefined` is still a distinct own
  // key from an absent one, and would break that round-trip and any strict
  // deep-equality check on the parsed envelope).
  const newFields: Partial<Pick<Envelope, 'thread' | 'answered_by' | 'needs_human'>> = {};
  if (input.thread !== undefined) newFields.thread = input.thread;
  if (input.answered_by !== undefined) newFields.answered_by = input.answered_by;
  if (input.needs_human !== undefined) newFields.needs_human = input.needs_human;
  const v = Object.keys(newFields).length > 0 ? 2 : 1;

  return EnvelopeSchema.parse({
    v,
    id: overrides?.id ?? ulid(),
    ts,
    from,
    to: input.to ?? ['*'],
    type: input.type,
    subject: input.subject,
    body: input.body ?? '',
    refs: input.refs ?? {},
    reply_to: input.reply_to ?? null,
    hops: overrides?.hops ?? 0,
    ttl: overrides?.ttl ?? defaultTtl(ts),
    ...newFields,
  });
}

/**
 * The id of the conversation root: `envelope.thread` when set, otherwise the
 * envelope's own id (it *is* the root). Use this — never `envelope.thread`
 * directly — to compare whether two envelopes belong to the same thread.
 */
export function threadOf(envelope: Envelope): string {
  return envelope.thread ?? envelope.id;
}

export function isExpired(envelope: Envelope, now = new Date()): boolean {
  return new Date(envelope.ttl) <= now;
}

export function isHopsBlocked(envelope: Envelope): boolean {
  return envelope.hops >= 3;
}

export function isDirectedTo(envelope: Envelope, dev: string): boolean {
  return envelope.to.includes('*') || envelope.to.includes(dev);
}

function formatRefsLine(refs: Refs): string {
  const parts: string[] = [];
  if (refs.branch) parts.push(`branch: ${refs.branch}`);
  if (refs.pr !== undefined) parts.push(`pr: ${refs.pr}`);
  if (refs.paths?.length) parts.push(`paths: ${refs.paths.join(', ')}`);
  if (refs.until) parts.push(`until: ${refs.until}`);
  return parts.join(' · ');
}

export class EnvelopeTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeTooLargeError';
  }
}

export interface RenderResult {
  content: string;
  truncated: boolean;
}

export function renderEnvelope(envelope: Envelope, options: RenderOptions = {}): RenderResult {
  const charLimit = options.charLimit ?? DISCORD_RENDER_CHAR_LIMIT;
  const bodyMax = options.bodyMax ?? DISCORD_BODY_MAX;

  const emoji = TYPE_EMOJI[envelope.type];
  const line1 = `${emoji} **${envelope.type}** ${envelope.from.dev}/${envelope.from.agent} · ${envelope.from.repo}`;
  const line2 = envelope.subject;
  const refsLine = formatRefsLine(envelope.refs);
  const headerLines = refsLine ? [line1, line2, refsLine] : [line1, line2];
  const header = headerLines.join('\n');

  const buildContent = (bodyText: string): string => {
    const payload = { ...envelope, body: bodyText };
    return `${header}\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
  };

  let body = envelope.body.length > bodyMax ? envelope.body.slice(0, bodyMax - 1) + '…' : envelope.body;
  let bodyTruncated = envelope.body.length > bodyMax;

  if (buildContent(body).length <= charLimit) {
    return { content: buildContent(body), truncated: bodyTruncated };
  }

  while (body.length > 0) {
    body = body.slice(0, Math.max(0, body.length - 50));
    if (body.length > 0) body += '…';
    bodyTruncated = true;
    if (buildContent(body).length <= charLimit) {
      return { content: buildContent(body), truncated: true };
    }
  }

  const fallback = buildContent('');
  if (fallback.length <= charLimit) {
    return { content: fallback, truncated: true };
  }

  // Even with an empty body it doesn't fit: cutting here would produce a corrupt
  // json block in the channel. Fail loudly rather than publish an unreadable envelope.
  throw new EnvelopeTooLargeError(
    `Envelope does not fit in ${charLimit} chars even with an empty body ` +
      `(${fallback.length}). Reduce refs.paths or shorten the subject.`,
  );
}

const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)\n```/;

export function parseEnvelopeFromContent(content: string): Envelope | null {
  const match = content.match(JSON_BLOCK_RE);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1]!) as unknown;
    return EnvelopeSchema.parse(raw);
  } catch {
    return null;
  }
}

/** @deprecated use parseEnvelopeFromContent */
export const parseEnvelopeFromMessage = parseEnvelopeFromContent;

export function validateClaimInput(input: SendInput): string | null {
  if (input.type !== 'claim') return null;
  if (!input.refs?.paths?.length) {
    return 'claim requires refs.paths with at least one glob';
  }
  if (!input.refs.until) {
    return 'claim requires refs.until';
  }
  return null;
}

export function globMatches(pattern: string, target: string): boolean {
  const regex = globToRegExp(pattern);
  return regex.test(target);
}

export function globsOverlap(a: string[], b: string[]): boolean {
  for (const ga of a) {
    for (const gb of b) {
      if (globMatches(ga, gb) || globMatches(gb, ga)) return true;
      if (ga === gb) return true;
    }
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '.';
    } else if (/[+^${}()|[\]\\.]/.test(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re);
}
