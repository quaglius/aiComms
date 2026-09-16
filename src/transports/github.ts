import type { Envelope } from '../envelope.js';
import {
  EnvelopeTooLargeError,
  parseEnvelopeFromContent,
  renderEnvelope,
  GITHUB_BODY_MAX,
  GITHUB_RENDER_CHAR_LIMIT,
} from '../envelope.js';
import type {
  Transport,
  TransportFetchResult,
  TransportIdentity,
  TransportSendResult,
} from './types.js';
import { githubFetch, getGitHubLogin, type GitHubFetchOptions } from './github-api.js';

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
}

export interface GitHubTransportOptions {
  repo: string;
  issue: number;
  token?: string;
  fetchFn?: typeof fetch;
  onIdentityMismatch?: (declared: string, actual: string, commentId: number) => void;
  getEtag?: () => string | undefined;
  setEtag?: (etag: string | undefined) => void;
}

export class GitHubTransport implements Transport {
  private readonly owner: string;
  private readonly repoName: string;
  private readonly issue: number;
  private readonly token?: string;
  private readonly fetchFn?: typeof fetch;
  private readonly onIdentityMismatch?: GitHubTransportOptions['onIdentityMismatch'];
  private readonly getEtag?: () => string | undefined;
  private readonly setEtag?: (etag: string | undefined) => void;

  constructor(options: GitHubTransportOptions) {
    const [owner, repoName] = options.repo.split('/');
    if (!owner || !repoName) {
      throw new Error(`Invalid GitHub repo "${options.repo}" (expected owner/repo)`);
    }
    this.owner = owner;
    this.repoName = repoName;
    this.issue = options.issue;
    this.token = options.token;
    this.fetchFn = options.fetchFn;
    this.onIdentityMismatch = options.onIdentityMismatch;
    this.getEtag = options.getEtag;
    this.setEtag = options.setEtag;
  }

  private apiOptions(): GitHubFetchOptions {
    return {
      token: this.token,
      fetchFn: this.fetchFn,
      etag: this.getEtag?.(),
    };
  }

  describe(): string {
    return `GitHub issue #${this.issue} on ${this.owner}/${this.repoName}`;
  }

  async whoami(): Promise<TransportIdentity> {
    const dev = await getGitHubLogin({ token: this.token, fetchFn: this.fetchFn });
    return { dev, authenticated: true };
  }

  async send(envelope: Envelope): Promise<TransportSendResult> {
    const { content, truncated } = renderEnvelope(envelope, {
      charLimit: GITHUB_RENDER_CHAR_LIMIT,
      bodyMax: GITHUB_BODY_MAX,
    });

    const path = `/repos/${this.owner}/${this.repoName}/issues/${this.issue}/comments`;
    const response = await githubFetch(
      path,
      { method: 'POST', body: JSON.stringify({ body: content }) },
      this.apiOptions(),
    );

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 422 && text.includes('body')) {
        throw new EnvelopeTooLargeError(
          `Envelope too large for GitHub comment (${response.status}): ${text.slice(0, 200)}`,
        );
      }
      throw new Error(`Failed to post GitHub comment (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as { id: number };
    return { id: String(data.id), truncated };
  }

  async fetchSince(cursor: string | null): Promise<TransportFetchResult> {
    const params = new URLSearchParams({ per_page: '100' });
    if (cursor) {
      params.set('since', cursor);
    }

    const path = `/repos/${this.owner}/${this.repoName}/issues/${this.issue}/comments?${params}`;
    const response = await githubFetch(path, { method: 'GET' }, this.apiOptions());

    const etag = response.headers.get('ETag') ?? undefined;
    if (etag) {
      this.setEtag?.(etag);
    }

    if (response.status === 304) {
      return { envelopes: [], cursor };
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to read GitHub comments (${response.status}): ${text.slice(0, 200)}`);
    }

    const comments = (await response.json()) as GitHubComment[];
    const envelopes: Envelope[] = [];
    let latestCursor = cursor;

    for (const comment of comments) {
      const parsed = this.readComment(comment);
      if (!parsed) continue;

      envelopes.push(parsed);
      if (!latestCursor || comment.created_at > latestCursor) {
        latestCursor = comment.created_at;
      }
    }

    return { envelopes, cursor: latestCursor };
  }

  /**
   * The only place a comment becomes an envelope.
   *
   * Identity comes from the transport and never from the payload: whatever
   * `from.dev` the body claims is discarded and replaced with the GitHub
   * account that actually posted the comment. Every read path must go through
   * here — a second path that parses a comment itself would quietly restore
   * self-declared identity, which is the whole weakness this transport exists
   * to remove.
   */
  private readComment(comment: {
    body: string;
    id: number;
    user: { login: string };
  }): Envelope | null {
    const parsed = parseEnvelopeFromContent(comment.body);
    if (!parsed) return null;

    const declaredDev = parsed.from.dev;
    parsed.from.dev = comment.user.login;
    if (declaredDev !== comment.user.login) {
      this.onIdentityMismatch?.(declaredDev, comment.user.login, comment.id);
    }
    return parsed;
  }

  async backfill(cursor: string | null): Promise<TransportFetchResult> {
    return this.fetchAllSince(cursor);
  }

  /** Paginate through all comments newer than cursor (for cold start / backlog). */
  async fetchAllSince(cursor: string | null): Promise<TransportFetchResult> {
    const all: Envelope[] = [];
    let currentCursor = cursor;
    let page = 1;

    for (;;) {
      const params = new URLSearchParams({ per_page: '100', page: String(page) });
      if (cursor) {
        params.set('since', cursor);
      }

      const path = `/repos/${this.owner}/${this.repoName}/issues/${this.issue}/comments?${params}`;
      const response = await githubFetch(path, { method: 'GET' }, this.apiOptions());

      if (response.status === 304) {
        return { envelopes: all, cursor: currentCursor };
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Failed to read GitHub comments (${response.status}): ${text.slice(0, 200)}`,
        );
      }

      const etag = response.headers.get('ETag') ?? undefined;
      if (etag) {
        this.setEtag?.(etag);
      }

      const comments = (await response.json()) as GitHubComment[];
      if (comments.length === 0) break;

      for (const comment of comments) {
        const parsed = this.readComment(comment);
        if (!parsed) continue;

        all.push(parsed);
        if (!currentCursor || comment.created_at > currentCursor) {
          currentCursor = comment.created_at;
        }
      }

      if (comments.length < 100) break;
      page++;
    }

    return { envelopes: all, cursor: currentCursor };
  }
}
