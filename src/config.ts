import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { maybeMigrateV0 } from './migrate.js';
import { getConfigDir, getConfigPath } from './paths.js';

const IdentitySchema = z.object({
  dev: z.string().min(1),
  agent: z.string().min(1),
});

const ProjectDiscordSchema = z.object({
  channelId: z.string().min(1),
});

const RepoEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

const ProjectConfigSchema = z.object({
  discord: ProjectDiscordSchema,
  repos: z.array(RepoEntrySchema).optional(),
});

export const ConfigV2Schema = z.object({
  version: z.literal(2),
  identity: IdentitySchema,
  defaultProject: z.string().min(1),
  projects: z.record(z.string(), ProjectConfigSchema).default({}),
});

export type ConfigV2 = z.infer<typeof ConfigV2Schema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** @deprecated alias de compatibilidad interna */
export type Config = ConfigV2;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(configPath = getConfigPath()): ConfigV2 {
  const migrationMessages = maybeMigrateV0();
  for (const msg of migrationMessages) {
    console.log(msg);
  }

  if (!existsSync(configPath)) {
    throw new ConfigError(
      `No se encontró config en ${configPath}. Ejecutá "ai-comms init" para crearla.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new ConfigError(`Config inválida en ${configPath}: JSON mal formado.`);
  }

  const parsed = ConfigV2Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Config inválida en ${configPath}: ${issues}`);
  }

  assertNoTokenInConfig(parsed.data, configPath);
  return parsed.data;
}

function assertNoTokenInConfig(config: ConfigV2, configPath: string): void {
  const serialized = JSON.stringify(config);
  if (serialized.includes('"token"')) {
    throw new ConfigError(
      `Config en ${configPath} contiene un token. Mové el token a ~/.ai-comms/secrets.json ` +
        `con "ai-comms secret set <project>".`,
    );
  }
}

export function saveConfig(config: ConfigV2, configPath = getConfigPath()): void {
  assertNoTokenInConfig(config, configPath);
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export function redactedContext(context: {
  project: string;
  repo: string;
  dev: string;
  agent: string;
  channelId: string;
  repoCommsPath: string | null;
  source: string;
}): Record<string, unknown> {
  return {
    project: context.project,
    repo: context.repo,
    dev: context.dev,
    agent: context.agent,
    discord: { channelId: context.channelId },
    repoCommsPath: context.repoCommsPath,
    source: context.source,
  };
}

export { getConfigDir, getConfigPath } from './paths.js';
