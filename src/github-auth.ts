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

export function resetGitHubAuthForTests(): void {
  ghTokenProvider = null;
}

export function setGitHubTokenProviderForTests(provider: (() => string | null) | null): void {
  ghTokenProvider = provider;
}

export function getGitHubToken(): string {
  const fromGh = getGitHubTokenFromGh();
  if (fromGh) return fromGh;

  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  throw new GitHubAuthError('gh auth login');
}
