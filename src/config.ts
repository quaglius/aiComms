import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const CONFIG_DIR = path.join(homedir(), '.ai-comms');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DiscordConfigSchema = z.object({
  token: z.string().min(1),
  channelId: z.string().min(1),
});

export const ConfigSchema = z.object({
  dev: z.string().min(1),
  agent: z.string().min(1),
  repo: z.string().min(1),
  discord: DiscordConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function getEffectiveToken(config: Config): string {
  return process.env.AI_COMMS_TOKEN?.trim() || config.discord.token;
}

export function loadConfig(configPath = CONFIG_PATH): Config {
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
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Config inválida en ${configPath}: ${issues}`);
  }
  return parsed.data;
}

export function saveConfig(config: Config, configPath = CONFIG_PATH): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export function redactedConfig(config: Config): Omit<Config, 'discord'> & {
  discord: { channelId: string; token: '[redacted]' };
} {
  return {
    ...config,
    discord: {
      channelId: config.discord.channelId,
      token: '[redacted]',
    },
  };
}
