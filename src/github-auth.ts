import { execFileSync } from 'node:child_process';

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

let ghTokenProvider: (() => string | null) | null = null;

export function getGitHubTokenFromGh(): string | null {
  if (ghTokenProvider) return ghTokenProvider();
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * In-process token cache.
 *
 * Without it, every API call — the daemon's poll of every project every
 * 15s, plus every MCP tool call — spawns a `gh auth token` child process.
 * That's cheap once but adds up, and it's pure overhead: the token doesn't
 * change minute to minute. Five minutes bounds how long a revoked/rotated
 * token can linger in memory.
 */
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedToken: { token: string; fetchedAt: number } | null = null;

export function resetGitHubAuthForTests(): void {
  ghTokenProvider = null;
  cachedToken = null;
}

export function setGitHubTokenProviderForTests(provider: (() => string | null) | null): void {
  ghTokenProvider = provider;
  // A freshly injected provider should take effect immediately, not be
  // shadowed by whatever the previous provider (or a real `gh`) returned.
  cachedToken = null;
}

export function getGitHubToken(now = Date.now()): string {
  if (cachedToken && now - cachedToken.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return cachedToken.token;
  }

  const fromGh = getGitHubTokenFromGh();
  if (fromGh) {
    cachedToken = { token: fromGh, fetchedAt: now };
    return fromGh;
  }

  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) {
    cachedToken = { token: fromEnv, fetchedAt: now };
    return fromEnv;
  }

  throw new GitHubAuthError('gh auth login');
}
