import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface GitRemoteInfo {
  owner: string;
  repo: string;
  fullName: string;
}

export class GitRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitRemoteError';
  }
}

function parseGitHubRemote(url: string): GitRemoteInfo | null {
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(url.trim());
  if (ssh) {
    return { owner: ssh[1]!, repo: ssh[2]!, fullName: `${ssh[1]!}/${ssh[2]!}` };
  }

  const https = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (https) {
    return { owner: https[1]!, repo: https[2]!, fullName: `${https[1]!}/${https[2]!}` };
  }

  return null;
}

export function parseRemoteUrl(url: string): GitRemoteInfo {
  const parsed = parseGitHubRemote(url);
  if (!parsed) {
    throw new GitRemoteError(
      `Could not parse GitHub remote "${url}". ai-comms setup requires a github.com remote.`,
    );
  }
  return parsed;
}

export function getGitRemote(cwd = process.cwd()): GitRemoteInfo {
  let url: string;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new GitRemoteError(
      'No git remote "origin" found. Run ai-comms setup inside a git repo with origin pointing at GitHub.',
    );
  }

  return parseRemoteUrl(url);
}

export function repoBasename(cwd = process.cwd()): string {
  return path.basename(path.resolve(cwd));
}
