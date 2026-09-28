import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getProjectDir } from './paths.js';
import { githubFetch } from './transports/github-api.js';
import type { GitHubBusConfig } from './transports/types.js';

/**
 * A team member's presence/directory profile, as published to the presence
 * issue (see docs/SPEC-v0.7.md §1.3 / §2.1).
 *
 * `login` always comes from the GitHub comment author, never from the
 * payload — same identity rule as envelopes (src/transports/github.ts).
 */
export interface MemberProfile {
  login: string;
  role?: string;
  areas: string[];
  repos: string[];
  agent?: string;
  autoAnswer: boolean;
  lastSeen: string | null;
}

/** A member counts as online if their heartbeat is fresher than this. */
export const ONLINE_WINDOW_MS = 15 * 60_000;

export function isOnline(p: MemberProfile, now: number = Date.now()): boolean {
  if (!p.lastSeen) return false;
  const seen = new Date(p.lastSeen).getTime();
  if (Number.isNaN(seen)) return false;
  return now - seen < ONLINE_WINDOW_MS;
}

const ProfilePayloadSchema = z.object({
  kind: z.literal('ai-comms-profile'),
  v: z.number().optional(),
  role: z.string().min(1).optional(),
  areas: z.array(z.string()).optional(),
  repos: z.array(z.string()).optional(),
  agent: z.string().min(1).optional(),
  autoAnswer: z.boolean().optional(),
  lastSeen: z.string().nullable().optional(),
});

type ProfilePayload = z.infer<typeof ProfilePayloadSchema>;

const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)\n```/;

function parseProfilePayload(body: string): ProfilePayload | null {
  const match = body.match(JSON_BLOCK_RE);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1]!) as unknown;
    const parsed = ProfilePayloadSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Renders a profile as a short human line plus a compact ```json block,
 * mirroring how envelopes are rendered (src/envelope.ts renderEnvelope).
 */
function renderProfileComment(profile: Omit<MemberProfile, 'login'>): string {
  const parts = [
    profile.role ? profile.role : '(no role set)',
    profile.areas.length ? profile.areas.join(', ') : '(no areas set)',
    `auto-answer ${profile.autoAnswer ? 'on' : 'off'}`,
  ];
  const line = `ai-comms presence · ${parts.join(' · ')}`;

  const payload: Record<string, unknown> = {
    kind: 'ai-comms-profile',
    v: 1,
    role: profile.role,
    areas: profile.areas,
    repos: profile.repos,
    agent: profile.agent,
    autoAnswer: profile.autoAnswer,
    lastSeen: profile.lastSeen,
  };

  return `${line}\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

interface RawComment {
  id: number;
  body: string;
  user: { login: string };
  updated_at: string;
}

async function listAllComments(
  owner: string,
  repo: string,
  issue: number,
  apiOpts: { token?: string; fetchFn?: typeof fetch },
): Promise<RawComment[]> {
  const all: RawComment[] = [];
  let page = 1;

  for (;;) {
    const params = new URLSearchParams({ per_page: '100', page: String(page) });
    const response = await githubFetch(
      `/repos/${owner}/${repo}/issues/${issue}/comments?${params}`,
      { method: 'GET' },
      apiOpts,
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to read presence comments (${response.status}): ${text.slice(0, 200)}`);
    }
    const batch = (await response.json()) as RawComment[];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return all;
}

/**
 * Reads every member's profile from the presence issue.
 *
 * Each member is expected to keep exactly one profile comment, but if
 * someone has more than one (a leftover from before the comment id was
 * cached, say), the most recently updated one wins. Returns `[]` when the
 * bus has no presence issue configured — everything that depends on
 * presence degrades to v0.6 behavior in that case.
 */
export async function fetchProfiles(
  bus: GitHubBusConfig,
  opts: {
    fetchFn?: typeof fetch;
    token?: string;
    /** Restricts which GitHub logins are read as profiles, same filter the
     *  daemon applies to envelopes when the collaborator list is available. */
    isAllowedAuthor?: (login: string) => boolean;
  } = {},
): Promise<MemberProfile[]> {
  if (bus.presence === undefined) return [];
  const [owner, repo] = bus.repo.split('/');
  if (!owner || !repo) return [];

  const comments = await listAllComments(owner, repo, bus.presence, {
    token: opts.token,
    fetchFn: opts.fetchFn,
  });

  const latest = new Map<string, { updatedAt: string; profile: MemberProfile }>();

  for (const comment of comments) {
    const login = comment.user.login;
    if (opts.isAllowedAuthor && !opts.isAllowedAuthor(login)) continue;

    const payload = parseProfilePayload(comment.body);
    if (!payload) continue;

    const existing = latest.get(login);
    if (existing && existing.updatedAt >= comment.updated_at) continue;

    latest.set(login, {
      updatedAt: comment.updated_at,
      profile: {
        login,
        role: payload.role,
        areas: payload.areas ?? [],
        repos: payload.repos ?? [],
        agent: payload.agent,
        autoAnswer: payload.autoAnswer ?? false,
        lastSeen: payload.lastSeen ?? null,
      },
    });
  }

  return [...latest.values()].map((v) => v.profile);
}

/** Injectable cache for our own profile comment id, so we PATCH the same
 *  comment every heartbeat instead of scanning the whole issue (or worse,
 *  posting a new one) every time. */
export interface PresenceCommentIdCache {
  get(): number | null;
  set(id: number): void;
}

/** The default cache: `~/.ai-comms/projects/<project>/presence.json`. */
export function filePresenceCommentIdCache(project: string): PresenceCommentIdCache {
  const filePath = path.join(getProjectDir(project), 'presence.json');
  return {
    get(): number | null {
      if (!existsSync(filePath)) return null;
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { commentId?: number };
        return typeof raw.commentId === 'number' ? raw.commentId : null;
      } catch {
        return null;
      }
    },
    set(id: number): void {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify({ commentId: id }, null, 2) + '\n', 'utf8');
    },
  };
}

async function patchComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string,
  apiOpts: { token?: string; fetchFn?: typeof fetch },
): Promise<boolean> {
  const response = await githubFetch(
    `/repos/${owner}/${repo}/issues/comments/${commentId}`,
    { method: 'PATCH', body: JSON.stringify({ body }) },
    apiOpts,
  );
  if (response.ok) return true;
  if (response.status === 404) return false;
  const text = await response.text();
  throw new Error(`Failed to update presence comment ${commentId} (${response.status}): ${text.slice(0, 200)}`);
}

async function postComment(
  owner: string,
  repo: string,
  issue: number,
  body: string,
  apiOpts: { token?: string; fetchFn?: typeof fetch },
): Promise<number> {
  const response = await githubFetch(
    `/repos/${owner}/${repo}/issues/${issue}/comments`,
    { method: 'POST', body: JSON.stringify({ body }) },
    apiOpts,
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create presence comment (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as { id: number };
  return data.id;
}

/** Finds our own most-recently-updated profile comment, if any, by scanning
 *  the presence issue for one authored by `login`. Used when the id cache is
 *  empty (first heartbeat on a new machine) or stale. */
async function findOwnCommentId(
  owner: string,
  repo: string,
  presenceIssue: number,
  login: string,
  apiOpts: { token?: string; fetchFn?: typeof fetch },
): Promise<number | null> {
  const comments = await listAllComments(owner, repo, presenceIssue, apiOpts);
  let found: { id: number; updatedAt: string } | null = null;
  for (const comment of comments) {
    if (comment.user.login !== login) continue;
    if (!parseProfilePayload(comment.body)) continue;
    if (!found || comment.updated_at > found.updatedAt) {
      found = { id: comment.id, updatedAt: comment.updated_at };
    }
  }
  return found?.id ?? null;
}

/**
 * Publishes our own profile to the presence issue: PATCHes our existing
 * comment (editing never notifies) or posts a new one.
 *
 * `login` is passed in rather than resolved here because the caller (the
 * daemon) already has an authenticated identity for the binding and this
 * module has no transport of its own.
 */
export async function upsertOwnProfile(
  bus: GitHubBusConfig,
  login: string,
  profile: Omit<MemberProfile, 'login'>,
  opts: {
    fetchFn?: typeof fetch;
    token?: string;
    commentIdCache?: PresenceCommentIdCache;
  } = {},
): Promise<void> {
  if (bus.presence === undefined) {
    throw new Error('bus.presence is not configured; run "ai-comms setup" to create the presence issue');
  }
  const [owner, repo] = bus.repo.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repo "${bus.repo}" (expected owner/repo)`);
  }

  const apiOpts = { token: opts.token, fetchFn: opts.fetchFn };
  const body = renderProfileComment(profile);

  const cachedId = opts.commentIdCache?.get() ?? null;
  if (cachedId !== null) {
    if (await patchComment(owner, repo, cachedId, body, apiOpts)) return;
    // Cached id no longer exists (comment deleted by hand, say) — fall
    // through to rediscovering or recreating it.
  }

  const found = await findOwnCommentId(owner, repo, bus.presence, login, apiOpts);
  if (found !== null) {
    opts.commentIdCache?.set(found);
    if (await patchComment(owner, repo, found, body, apiOpts)) return;
  }

  const created = await postComment(owner, repo, bus.presence, body, apiOpts);
  opts.commentIdCache?.set(created);
}

/** Case-insensitive substring match on role. */
export function membersByRole(profiles: MemberProfile[], role: string): MemberProfile[] {
  const needle = role.trim().toLowerCase();
  if (!needle) return [];
  return profiles.filter((p) => p.role?.toLowerCase().includes(needle));
}

function formatLastSeen(lastSeen: string | null, now: number): string {
  if (!lastSeen) return 'never';
  const seen = new Date(lastSeen).getTime();
  if (Number.isNaN(seen)) return 'never';
  const minutes = Math.max(0, Math.round((now - seen) / 60_000));
  return `${minutes}m ago`;
}

/** One line per member: `login · role · areas · online/offline (last seen
 *  Xm ago) · auto-answer on/off`. */
export function renderDirectory(profiles: MemberProfile[], now: number = Date.now()): string {
  if (profiles.length === 0) return '(no profiles yet)';

  return profiles
    .map((p) => {
      const online = isOnline(p, now);
      const status = `${online ? 'online' : 'offline'} (last seen ${formatLastSeen(p.lastSeen, now)})`;
      return [
        p.login,
        p.role ?? '(no role)',
        p.areas.length ? p.areas.join(', ') : '(no areas)',
        status,
        `auto-answer ${p.autoAnswer ? 'on' : 'off'}`,
      ].join(' · ');
    })
    .join('\n');
}
