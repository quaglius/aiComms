import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigError, type ConfigV2, loadConfig } from './config.js';
import type { Envelope } from './envelope.js';
import { REPO_COMMS_FILENAME } from './paths.js';
import type { BusConfig } from './transports/types.js';

const GitHubBusSchema = z
  .object({
    kind: z.literal('github'),
    repo: z.string().min(1),
    issue: z.number().int().positive(),
  })
  .strict();

const DiscordBusSchema = z
  .object({
    kind: z.literal('discord'),
    channelId: z.string().min(1),
  })
  .strict();

const LegacyDiscordSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

const DiscordWebhookNotifierSchema = z
  .object({
    kind: z.literal('discord-webhook'),
    urlRef: z.string().min(1),
  })
  .strict();

export const RepoCommsSchema = z
  .object({
    project: z.string().min(1),
    repo: z.string().min(1),
    bus: z.union([GitHubBusSchema, DiscordBusSchema]).optional(),
    discord: LegacyDiscordSchema.optional(),
    notifiers: z.array(DiscordWebhookNotifierSchema).optional(),
    team: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.bus && !value.discord) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either bus or discord is required',
        path: ['bus'],
      });
    }
  });

export type RepoComms = z.infer<typeof RepoCommsSchema>;

export interface ResolvedContext {
  project: string;
  repo: string;
  dev: string;
  agent: string;
  bus: BusConfig;
  githubRepo: string | null;
  team: string[];
  notifiers: z.infer<typeof DiscordWebhookNotifierSchema>[];
  repoCommsPath: string | null;
  source: 'repo' | 'user-config';
  /** @deprecated use bus.channelId for Discord */
  channelId: string;
}

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

export function resolveBusFromRepoComms(repoComms: RepoComms): BusConfig {
  if (repoComms.bus) return repoComms.bus;
  if (repoComms.discord) {
    return { kind: 'discord', channelId: repoComms.discord.channelId };
  }
  throw new ContextError('Repo comms missing bus configuration');
}

export function findRepoCommsFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (true) {
    const candidate = path.join(dir, REPO_COMMS_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (dir === root) break;
    dir = path.dirname(dir);
  }

  return null;
}

export function loadRepoComms(filePath: string): RepoComms {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    throw new ContextError(
      `${filePath} is not valid JSON. Fix the file or run "ai-comms setup" again.`,
    );
  }

  const parsed = RepoCommsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ContextError(
      `${filePath} is invalid: ${issues}. Run "ai-comms setup" to regenerate it.`,
    );
  }

  return parsed.data;
}

function resolveRepoFromUserConfig(
  cwd: string,
  config: ConfigV2,
  project: string,
): { repo: string; bus: BusConfig; githubRepo: string | null } | null {
  const projectConfig = config.projects?.[project];
  if (!projectConfig) return null;

  const resolvedCwd = path.resolve(cwd);
  const repos = projectConfig.repos ?? [];

  for (const entry of repos) {
    const repoPath = path.resolve(entry.path);
    if (resolvedCwd === repoPath || resolvedCwd.startsWith(repoPath + path.sep)) {
      if (projectConfig.bus) {
        return {
          repo: entry.name,
          bus: projectConfig.bus,
          githubRepo: projectConfig.bus.kind === 'github' ? projectConfig.bus.repo : null,
        };
      }
      if (projectConfig.discord) {
        return {
          repo: entry.name,
          bus: { kind: 'discord', channelId: projectConfig.discord.channelId },
          githubRepo: null,
        };
      }
    }
  }

  return null;
}

export function resolveContext(
  cwd: string,
  config?: ConfigV2,
  options: { projectOverride?: string } = {},
): ResolvedContext {
  const cfg = config ?? loadConfig();
  const repoCommsPath = findRepoCommsFile(cwd);

  if (repoCommsPath && !options.projectOverride) {
    const repoComms = loadRepoComms(repoCommsPath);
    const bus = resolveBusFromRepoComms(repoComms);
    const channelId = bus.kind === 'discord' ? bus.channelId : '';
    return {
      project: repoComms.project,
      repo: repoComms.repo,
      dev: cfg.identity?.dev ?? '',
      agent: cfg.agent ?? cfg.identity?.agent ?? 'claude-code',
      bus,
      githubRepo: bus.kind === 'github' ? bus.repo : null,
      team: repoComms.team ?? [],
      notifiers: repoComms.notifiers ?? [],
      repoCommsPath,
      source: 'repo',
      channelId,
    };
  }

  const project = options.projectOverride ?? cfg.defaultProject;
  if (!project) {
    throw new ContextError(contextResolutionError());
  }

  if (repoCommsPath && options.projectOverride) {
    const repoComms = loadRepoComms(repoCommsPath);
    if (repoComms.project !== options.projectOverride) {
      const fromUser = resolveRepoFromUserConfig(cwd, cfg, options.projectOverride);
      if (fromUser) {
        return buildUserConfigContext(cfg, project, fromUser.repo, fromUser.bus, fromUser.githubRepo, null);
      }
      throw new ContextError(
        `Project "${options.projectOverride}" does not match ${repoCommsPath} ` +
          `(project=${repoComms.project}).`,
      );
    }
    const bus = resolveBusFromRepoComms(repoComms);
    const channelId = bus.kind === 'discord' ? bus.channelId : '';
    return {
      project: repoComms.project,
      repo: repoComms.repo,
      dev: cfg.identity?.dev ?? '',
      agent: cfg.agent ?? cfg.identity?.agent ?? 'claude-code',
      bus,
      githubRepo: bus.kind === 'github' ? bus.repo : null,
      team: repoComms.team ?? [],
      notifiers: repoComms.notifiers ?? [],
      repoCommsPath,
      source: 'repo',
      channelId,
    };
  }

  const fromUser = resolveRepoFromUserConfig(cwd, cfg, project);
  if (fromUser) {
    return buildUserConfigContext(
      cfg,
      project,
      fromUser.repo,
      fromUser.bus,
      fromUser.githubRepo,
      null,
    );
  }

  throw new ContextError(contextResolutionError());
}

function buildUserConfigContext(
  config: ConfigV2,
  project: string,
  repo: string,
  bus: BusConfig,
  githubRepo: string | null,
  repoCommsPath: string | null,
): ResolvedContext {
  const channelId = bus.kind === 'discord' ? bus.channelId : '';
  return {
    project,
    repo,
    dev: config.identity?.dev ?? '',
    agent: config.agent ?? config.identity?.agent ?? 'claude-code',
    bus,
    githubRepo,
    team: [],
    notifiers: [],
    repoCommsPath,
    source: 'user-config',
    channelId,
  };
}

export function contextResolutionError(): string {
  return (
    'Could not resolve project/repo context.\n' +
    '  · Run "ai-comms setup" inside the repo, or\n' +
    '  · Pass --project <name> if it is already configured in ~/.ai-comms/config.json.'
  );
}

export function validateRecipients(
  to: string[],
  team: string[],
  dev: string,
  options: { log?: Envelope[]; replyTo?: string | null } = {},
): string[] {
  const warnings: string[] = [];
  const replyAuthor =
    options.replyTo && options.log
      ? options.log.find((e) => e.id === options.replyTo)?.from.dev
      : undefined;

  for (const recipient of to) {
    if (recipient === '*' || recipient === dev) continue;
    if (replyAuthor && recipient === replyAuthor) continue;
    if (team.length > 0 && !team.includes(recipient)) {
      warnings.push(
        `recipient "${recipient}" is not in team roster (${team.join(', ')}); sending directed anyway`,
      );
    }
  }
  return warnings;
}
