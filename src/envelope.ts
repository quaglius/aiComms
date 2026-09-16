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

export const EnvelopeSchema = z
  .object({
    v: z.literal(1),
    id: z.string().min(1),
    ts: isoDate,
    from: FromSchema,
    to: z.array(z.string().min(1)).min(1),
    type: z.enum(MESSAGE_TYPES),
    subject: z.string().max(120),
    body: z.string().max(600).default(''),
    refs: RefsSchema.default({}),
    reply_to: z.string().nullable().default(null),
    hops: z.number().int().min(0).max(3),
    ttl: isoDate,
  })
  .strict();

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type Refs = z.infer<typeof RefsSchema>;
export type From = z.infer<typeof FromSchema>;

export const SendInputShape = {
  type: z.enum(MESSAGE_TYPES),
  subject: z.string().max(120),
  body: z.string().max(600).optional(),
  to: z.array(z.string().min(1)).optional(),
  refs: RefsSchema.optional(),
  reply_to: z.string().nullable().optional(),
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

const DISCORD_CHAR_LIMIT = 1900;

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
  return EnvelopeSchema.parse({
    v: 1,
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
  });
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

export function renderEnvelope(envelope: Envelope): RenderResult {
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

  let body = envelope.body;
  if (buildContent(body).length <= DISCORD_CHAR_LIMIT) {
    return { content: buildContent(body), truncated: false };
  }

  while (body.length > 0) {
    body = body.slice(0, Math.max(0, body.length - 50));
    if (body.length > 0) body += '…';
    if (buildContent(body).length <= DISCORD_CHAR_LIMIT) {
      return { content: buildContent(body), truncated: true };
    }
  }

  const fallback = buildContent('');
  if (fallback.length <= DISCORD_CHAR_LIMIT) {
    return { content: fallback, truncated: true };
  }

  // Ni con body vacío entra: cortar acá produciría un bloque json corrupto en el
  // canal. Preferimos fallar ruidosamente antes que publicar un sobre ilegible.
  throw new EnvelopeTooLargeError(
    `El sobre no entra en ${DISCORD_CHAR_LIMIT} chars ni con body vacío ` +
      `(${fallback.length}). Reducí refs.paths o acortá el subject.`,
  );
}

const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)\n```/;

export function parseEnvelopeFromMessage(content: string): Envelope | null {
  const match = content.match(JSON_BLOCK_RE);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1]!) as unknown;
    return EnvelopeSchema.parse(raw);
  } catch {
    return null;
  }
}

export function validateClaimInput(input: SendInput): string | null {
  if (input.type !== 'claim') return null;
  if (!input.refs?.paths?.length) {
    return 'claim requiere refs.paths con al menos un glob';
  }
  if (!input.refs.until) {
    return 'claim requiere refs.until';
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
