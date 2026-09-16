import { chmodSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { getConfigDir, getSecretsPath } from './paths.js';

export type ProjectSecrets = {
  token?: string;
  discordWebhook?: string;
  [key: string]: string | undefined;
};

export type SecretsFile = Record<string, ProjectSecrets>;

export function projectTokenEnvKey(project: string): string {
  return `AI_COMMS_TOKEN_${project.replace(/-/g, '_').toUpperCase()}`;
}

export function loadSecrets(secretsPath = getSecretsPath()): SecretsFile {
  if (!existsSync(secretsPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(secretsPath, 'utf8')) as SecretsFile;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveSecrets(secrets: SecretsFile, secretsPath = getSecretsPath()): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  // mode only applies on create: force it on pre-existing files too.
  // On Windows this is effectively a no-op; on macOS/Linux it keeps the token
  // from being readable by other users on the machine.
  try {
    chmodSync(secretsPath, 0o600);
  } catch {
    // systems without POSIX permissions
  }
}

export function setProjectToken(
  project: string,
  token: string,
  secretsPath = getSecretsPath(),
): void {
  const secrets = loadSecrets(secretsPath);
  secrets[project] = { token };
  saveSecrets(secrets, secretsPath);
}

export function getEffectiveToken(
  project: string,
  secretsPath = getSecretsPath(),
): { token: string; source: 'env-project' | 'env-global' | 'secrets' } {
  const projectKey = projectTokenEnvKey(project);
  const projectEnv = process.env[projectKey]?.trim();
  if (projectEnv) {
    return { token: projectEnv, source: 'env-project' };
  }

  const globalEnv = process.env.AI_COMMS_TOKEN?.trim();
  if (globalEnv) {
    return { token: globalEnv, source: 'env-global' };
  }

  const secrets = loadSecrets(secretsPath);
  const entry = secrets[project];
  if (entry?.token?.trim()) {
    return { token: entry.token.trim(), source: 'secrets' };
  }

  throw new SecretsError(
    `No token for project "${project}". Run "ai-comms secret set ${project}" ` +
      `or set ${projectKey} / AI_COMMS_TOKEN.`,
  );
}

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

export function tokenSourceLabel(
  source: 'env-project' | 'env-global' | 'secrets',
  project: string,
): string {
  switch (source) {
    case 'env-project':
      return `[env ${projectTokenEnvKey(project)}]`;
    case 'env-global':
      return '[env AI_COMMS_TOKEN]';
    case 'secrets':
      return '[secrets.json]';
  }
}

export function resolveSecretRef(urlRef: string, project: string, secretsPath = getSecretsPath()): string {
  const prefix = 'secrets:';
  if (!urlRef.startsWith(prefix)) {
    throw new SecretsError(`Invalid secret ref "${urlRef}". Expected secrets:<project>.<key>.`);
  }

  const path = urlRef.slice(prefix.length);
  const [refProject, ...rest] = path.split('.');
  const key = rest.join('.');
  if (!refProject || !key) {
    throw new SecretsError(`Invalid secret ref "${urlRef}". Expected secrets:<project>.<key>.`);
  }

  const targetProject = refProject === project ? project : refProject;
  const secrets = loadSecrets(secretsPath);
  const entry = secrets[targetProject];
  const value = entry?.[key]?.trim();
  if (!value) {
    throw new SecretsError(
      `Missing secret "${key}" for project "${targetProject}" (ref ${urlRef}).`,
    );
  }
  return value;
}
