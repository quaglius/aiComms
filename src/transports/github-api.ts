import { getGitHubToken } from '../github-auth.js';

const GITHUB_API = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export interface GitHubFetchOptions {
  token?: string;
  fetchFn?: typeof fetch;
  etag?: string;
}

export async function githubFetch(
  path: string,
  init: RequestInit = {},
  options: GitHubFetchOptions = {},
): Promise<Response> {
  const token = options.token ?? getGitHubToken();
  const fetchFn = options.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (options.etag) {
    headers['If-None-Match'] = options.etag;
  }

  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  return fetchFn(url, { ...init, headers });
}

export async function getGitHubLogin(
  options: { token?: string; fetchFn?: typeof fetch } = {},
): Promise<string> {
  const response = await githubFetch('/user', { method: 'GET' }, options);
  if (!response.ok) {
    throw new GitHubApiError('GitHub authentication failed', response.status);
  }
  const data = (await response.json()) as { login: string };
  return data.login;
}
