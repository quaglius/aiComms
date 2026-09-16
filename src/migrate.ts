import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  getConfigPath,
  getProjectDir,
  getV0CursorPath,
  getV0DaemonLogPath,
  getV0DaemonPidPath,
  getV0LogPath,
  getV0ReadPath,
} from './paths.js';
import { setProjectToken } from './secrets.js';

const V0_CONFIG_SCHEMA = z.object({
  dev: z.string().min(1),
  agent: z.string().min(1),
  repo: z.string().min(1),
  discord: z.object({
    token: z.string().min(1),
    channelId: z.string().min(1),
  }),
});

let migrationDone = false;

export function resetMigrationForTests(): void {
  migrationDone = false;
}

export function maybeMigrateV0(): string[] {
  if (migrationDone) return [];
  migrationDone = true;

  const messages: string[] = [];
  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
      const v0 = V0_CONFIG_SCHEMA.safeParse(raw);
      if (v0.success) {
        messages.push(...migrateV0Config(v0.data, configPath));
      }
    } catch {
      // config inválida: loadConfig lo reportará
    }
  }

  messages.push(...migrateV0StateFiles(configPath));

  return messages;
}

function migrateV0Config(
  v0: z.infer<typeof V0_CONFIG_SCHEMA>,
  configPath: string,
): string[] {
  const messages: string[] = [];
  const project = v0.repo;

  setProjectToken(project, v0.discord.token);

  const v2 = {
    version: 2 as const,
    identity: { dev: v0.dev, agent: v0.agent },
    defaultProject: project,
    projects: {
      [project]: {
        discord: { channelId: v0.discord.channelId },
        repos: [],
      },
    },
  };

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(v2, null, 2) + '\n', 'utf8');

  messages.push(
    `Migré config v0 → v2 (proyecto "${project}"). Token movido a secrets.json.`,
  );
  return messages;
}

function migrateV0StateFiles(configPath: string): string[] {
  const v0StateFiles = [
    { from: getV0LogPath(), name: 'log.jsonl' },
    { from: getV0CursorPath(), name: 'cursor.json' },
    { from: getV0ReadPath(), name: 'read.json' },
    { from: getV0DaemonLogPath(), name: 'daemon.log' },
    { from: getV0DaemonPidPath(), name: 'daemon.pid' },
  ];

  const hasV0State = v0StateFiles.some((f) => existsSync(f.from));
  if (!hasV0State) return [];

  let defaultProject = 'default';
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
        defaultProject?: string;
      };
      if (raw.defaultProject) defaultProject = raw.defaultProject;
    } catch {
      // ignore
    }
  }

  const projectDir = getProjectDir(defaultProject);
  mkdirSync(projectDir, { recursive: true });

  const messages: string[] = [];

  for (const file of v0StateFiles) {
    if (!existsSync(file.from)) continue;
    const dest = path.join(projectDir, file.name);
    if (existsSync(dest)) continue;
    renameSync(file.from, dest);
    messages.push(`Moví ${file.from} → ${dest}`);
  }

  if (messages.length > 0) {
    messages.unshift(
      `Migré estado v0 al proyecto "${defaultProject}" en ~/.ai-comms/projects/${defaultProject}/`,
    );
  }

  return messages;
}
