import { getGitHubToken } from './github-auth.js';

const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  collaborators: string[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

export function clearCollaboratorsCacheForTests(): void {
  cache.clear();
}

export async function getRepoCollaborators(
  ownerRepo: string,
  options: { token?: string; fetchFn?: typeof fetch; now?: number } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const cached = cache.get(ownerRepo);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.collaborators;
  }

  const token = options.token ?? getGitHubToken();
  const fetchFn = options.fetchFn ?? fetch;
  const [owner, repo] = ownerRepo.split('/');
  if (!owner || !repo) return [];

  const collaborators: string[] = [];
  let page = 1;

  for (;;) {
    const url = `https://api.github.com/repos/${owner}/${repo}/collaborators?per_page=100&page=${page}`;
    const response = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to list collaborators for ${ownerRepo} (${response.status}): ${text.slice(0, 200)}`,
      );
    }

    const batch = (await response.json()) as Array<{ login: string }>;
    if (batch.length === 0) break;
    collaborators.push(...batch.map((c) => c.login));
    if (batch.length < 100) break;
    page++;
  }

  cache.set(ownerRepo, { collaborators, fetchedAt: now });
  return collaborators;
}
