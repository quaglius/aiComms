import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigError, type ConfigV2, loadConfig } from './config.js';
import type { Envelope } from './envelope.js';
import { REPO_COMMS_FILENAME } from './paths.js';

export const RepoCommsSchema = z
  .object({
    project: z.string().min(1),
    repo: z.string().min(1),
    discord: z.object({ channelId: z.string().min(1) }).strict(),
    team: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type RepoComms = z.infer<typeof RepoCommsSchema>;

export interface ResolvedContext {
  project: string;
  repo: string;
  dev: string;
  agent: string;
  channelId: string;
  team: string[];
  repoCommsPath: string | null;
  source: 'repo' | 'user-config';
}

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextError';
  }
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
      `${filePath} is not valid JSON. Fix the file or run "ai-comms link" again.`,
    );
  }

  const parsed = RepoCommsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ContextError(
      `${filePath} is invalid: ${issues}. Run "ai-comms link" to regenerate it.`,
    );
  }

  return parsed.data;
}

function resolveRepoFromUserConfig(
  cwd: string,
  config: ConfigV2,
  project: string,
): { repo: string; channelId: string } | null {
  const projectConfig = config.projects?.[project];
  if (!projectConfig) return null;

  const resolvedCwd = path.resolve(cwd);
  const repos = projectConfig.repos ?? [];

  for (const entry of repos) {
    const repoPath = path.resolve(entry.path);
    if (resolvedCwd === repoPath || resolvedCwd.startsWith(repoPath + path.sep)) {
      return {
        repo: entry.name,
        channelId: projectConfig.discord.channelId,
      };
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
    return {
      project: repoComms.project,
      repo: repoComms.repo,
      dev: cfg.identity.dev,
      agent: cfg.identity.agent,
      channelId: repoComms.discord.channelId,
      team: repoComms.team ?? [],
      repoCommsPath,
      source: 'repo',
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
        return buildUserConfigContext(cfg, project, fromUser.repo, fromUser.channelId, null);
      }
      throw new ContextError(
        `Project "${options.projectOverride}" does not match ${repoCommsPath} ` +
          `(project=${repoComms.project}).`,
      );
    }
    return {
      project: repoComms.project,
      repo: repoComms.repo,
      dev: cfg.identity.dev,
      agent: cfg.identity.agent,
      channelId: repoComms.discord.channelId,
      team: repoComms.team ?? [],
      repoCommsPath,
      source: 'repo',
    };
  }

  const fromUser = resolveRepoFromUserConfig(cwd, cfg, project);
  if (fromUser) {
    return buildUserConfigContext(
      cfg,
      project,
      fromUser.repo,
      fromUser.channelId,
      null,
    );
  }

  // Without .ai-comms.json and without a declared repo, don't invent the repo name:
  // a misnamed repo silently breaks claim scoping, which is the tool's core job.
  throw new ContextError(contextResolutionError());
}

function buildUserConfigContext(
  config: ConfigV2,
  project: string,
  repo: string,
  channelId: string,
  repoCommsPath: string | null,
): ResolvedContext {
  return {
    project,
    repo,
    dev: config.identity.dev,
    agent: config.identity.agent,
    channelId,
    team: [],
    repoCommsPath,
    source: 'user-config',
  };
}

export function contextResolutionError(): string {
  return (
    'Could not resolve project/repo context.\n' +
    '  · Run "ai-comms link" inside the repo to create .ai-comms.json, or\n' +
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
