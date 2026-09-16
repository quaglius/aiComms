import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { maybeMigrateV0 } from './migrate.js';
import { getConfigDir, getConfigPath } from './paths.js';
import type { BusConfig } from './transports/types.js';

const IdentitySchema = z.object({
  dev: z.string().min(1),
  agent: z.string().min(1),
});

const ProjectDiscordSchema = z.object({
  channelId: z.string().min(1),
});

const GitHubBusSchema = z.object({
  kind: z.literal('github'),
  repo: z.string().min(1),
  issue: z.number().int().positive(),
});

const RepoEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

const AutoAnswerConfigSchema = z
  .object({
    enabled: z.boolean(),
    maxPerRequesterPerHour: z.number().int().positive().default(5),
    timeoutSeconds: z.number().int().positive().max(120).default(120),
    repoPath: z.string().min(1).optional(),
    maxAgeMinutes: z.number().int().positive().default(10),
  })
  .strict();

const ProjectConfigSchema = z.object({
  discord: ProjectDiscordSchema.optional(),
  bus: GitHubBusSchema.optional(),
  repos: z.array(RepoEntrySchema).optional(),
  autoAnswer: AutoAnswerConfigSchema.optional(),
});

export const ConfigV2Schema = z.object({
  version: z.literal(2),
  identity: IdentitySchema.optional(),
  agent: z.string().min(1).optional(),
  defaultProject: z.string().min(1),
  projects: z.record(z.string(), ProjectConfigSchema).default({}),
});

export type ConfigV2 = z.infer<typeof ConfigV2Schema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type AutoAnswerConfig = z.infer<typeof AutoAnswerConfigSchema>;

export interface ResolvedAutoAnswer {
  enabled: boolean;
  maxPerRequesterPerHour: number;
  timeoutSeconds: number;
  repoPath?: string;
  maxAgeMinutes: number;
}

export function resolveAutoAnswer(projectConfig: ProjectConfig | undefined): ResolvedAutoAnswer {
  const aa = projectConfig?.autoAnswer;
  if (!aa?.enabled) {
    return { enabled: false, maxPerRequesterPerHour: 5, timeoutSeconds: 120, maxAgeMinutes: 10 };
  }
  return {
    enabled: true,
    maxPerRequesterPerHour: aa.maxPerRequesterPerHour ?? 5,
    timeoutSeconds: aa.timeoutSeconds ?? 120,
    repoPath: aa.repoPath,
    maxAgeMinutes: aa.maxAgeMinutes ?? 10,
  };
}

/** @deprecated internal compatibility alias */
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
      `No config found at ${configPath}. Run "ai-comms setup" to create one.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new ConfigError(`Invalid config at ${configPath}: malformed JSON.`);
  }

  const parsed = ConfigV2Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Invalid config at ${configPath}: ${issues}`);
  }

  assertNoTokenInConfig(parsed.data, configPath);
  return parsed.data;
}

function assertNoTokenInConfig(config: ConfigV2, configPath: string): void {
  const serialized = JSON.stringify(config);
  if (serialized.includes('"token"')) {
    throw new ConfigError(
      `Config at ${configPath} contains a token. Move the token to ~/.ai-comms/secrets.json ` +
        `with "ai-comms secret set <project>".`,
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
  bus: BusConfig;
  channelId: string;
  repoCommsPath: string | null;
  source: string;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    project: context.project,
    repo: context.repo,
    dev: context.dev,
    agent: context.agent,
    bus: context.bus,
    repoCommsPath: context.repoCommsPath,
    source: context.source,
  };
  if (context.bus.kind === 'discord') {
    base.discord = { channelId: context.bus.channelId };
  }
  return base;
}

export { getConfigDir, getConfigPath } from './paths.js';
