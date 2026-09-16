#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  ConfigError,
  loadConfig,
  saveConfig,
  redactedContext,
  ConfigV2Schema,
  resolveAutoAnswer,
} from './config.js';
import {
  contextResolutionError,
  loadRepoComms,
  resolveContext,
  RepoCommsSchema,
} from './context.js';
import { runDaemon } from './daemon.js';
import { runMcpServer } from './mcp.js';
import {
  checkBotPermissions,
  getBotUser,
  getChannel,
  REQUIRED_PERMISSION_BITS,
} from './discord.js';
import { REPO_COMMS_FILENAME } from './paths.js';
import { prompt, promptSecret } from './prompt.js';
import {
  getEffectiveToken,
  SecretsError,
  setProjectToken,
  tokenSourceLabel,
} from './secrets.js';
import {
  formatActiveClaim,
  formatInboxForDisplay,
  loadLog,
  loadReadState,
  materializeActiveClaims,
  materializeInbox,
  markRead,
} from './store.js';
import { formatBudgetSnapshot, getBudgetSnapshot } from './budget.js';
import { buildInstructionsBlock, writeInstructionsToRepo } from './instructions.js';

async function runInit(): Promise<void> {
  console.log('ai-comms initial setup\n');

  const dev = await prompt('dev (stable slug, e.g. ana)');
  const agent = await prompt('agent (e.g. claude-code, cursor)');
  const project = await prompt('project (team/project name, e.g. acme)');
  const channelId = await prompt('Discord channel ID for the project');

  const config = ConfigV2Schema.parse({
    version: 2,
    identity: { dev, agent },
    defaultProject: project,
    projects: {
      [project]: {
        discord: { channelId },
        repos: [],
      },
    },
  });

  saveConfig(config);
  console.log(`\nConfig saved to ~/.ai-comms/config.json`);
  console.log(`Run "ai-comms secret set ${project}" to store the bot token.`);
  console.log('Then run "ai-comms link" in each repo and "ai-comms doctor" to verify.');
}

async function runLink(options: { noInstructions?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  const cwd = process.cwd();
  const target = path.join(cwd, REPO_COMMS_FILENAME);

  if (existsSync(target)) {
    console.error(`${target} already exists. Edit the file manually if you need to change it.`);
    process.exit(1);
  }

  const defaultProject = config.defaultProject;
  const project = await prompt('project', defaultProject);
  const defaultRepo = path.basename(cwd);
  const repo = await prompt('repo', defaultRepo);

  const projectConfig = config.projects[project];
  if (!projectConfig) {
    console.error(
      `Project "${project}" is not in config. Run "ai-comms init" or add it manually.`,
    );
    process.exit(1);
  }

  const repoComms = RepoCommsSchema.parse({
    project,
    repo,
    discord: { channelId: projectConfig.discord.channelId },
    team: [],
  });

  writeFileSync(target, JSON.stringify(repoComms, null, 2) + '\n', 'utf8');
  console.log(`Created ${target}`);
  console.log('Commit this file so your team can use it with "ai-comms join".');

  if (options.noInstructions) return;

  const writeInstructions = await prompt(
    'Write ai-comms instructions to CLAUDE.md (and AGENTS.md if present)? [Y/n]',
    'Y',
  );
  if (writeInstructions.toLowerCase() === 'n') return;

  const repoNames = [
    repo,
    ...(projectConfig.repos ?? []).map((entry) => entry.name).filter((name) => name !== repo),
  ];
  const block = buildInstructionsBlock({
    project,
    repos: [...new Set(repoNames)],
    team: repoComms.team ?? [],
  });
  const written = writeInstructionsToRepo(cwd, block);
  for (const file of written) {
    console.log(`Updated ${file}`);
  }
}

async function runJoin(repoPath: string): Promise<void> {
  const absPath = path.resolve(repoPath);
  const repoCommsFile = path.join(absPath, REPO_COMMS_FILENAME);

  if (!existsSync(repoCommsFile)) {
    console.error(`Could not find ${repoCommsFile}. Did you clone the correct repo?`);
    process.exit(1);
  }

  const repoComms = loadRepoComms(repoCommsFile);
  let config: ReturnType<typeof loadConfig>;

  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(
        `${err.message}\nRun "ai-comms init" first to configure your identity.`,
      );
      process.exit(1);
    }
    throw err;
  }

  const { project } = repoComms;
  config.projects[project] = {
    discord: { channelId: repoComms.discord.channelId },
    repos: [
      ...(config.projects[project]?.repos ?? []).filter((r) => r.path !== absPath),
      { name: repoComms.repo, path: absPath },
    ],
  };

  if (!config.defaultProject) {
    config.defaultProject = project;
  }

  saveConfig(config);
  console.log(`Project "${project}" registered (repo: ${repoComms.repo}).`);
  console.log(`Run "ai-comms secret set ${project}" then "ai-comms doctor".`);
}

async function runSecretSet(project: string): Promise<void> {
  if (!project) {
    console.error('Usage: ai-comms secret set <project>');
    process.exit(1);
  }

  const token = await promptSecret('Discord bot token');
  if (!token) {
    console.error('Empty token, cancelled.');
    process.exit(1);
  }

  setProjectToken(project, token);
  console.log(`Token saved for "${project}" in ~/.ai-comms/secrets.json`);
}

async function runDoctor(projectOverride?: string): Promise<number> {
  try {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }

    let ctx;
    try {
      ctx = resolveContext(process.cwd(), config, { projectOverride });
    } catch (err) {
      console.error(err instanceof Error ? err.message : contextResolutionError());
      return 1;
    }

    console.log('ai-comms doctor\n');
    console.log('Identity:');
    console.log(`  dev:     ${ctx.dev}`);
    console.log(`  agent:   ${ctx.agent}`);
    console.log(`  project: ${ctx.project}`);
    console.log(`  repo:    ${ctx.repo}`);
    if (ctx.repoCommsPath) {
      console.log(`  .ai-comms.json: ${ctx.repoCommsPath}`);
    }

    let tokenInfo;
    try {
      tokenInfo = getEffectiveToken(ctx.project);
    } catch (err) {
      if (err instanceof SecretsError) {
        console.error(`\n${err.message}`);
        return 1;
      }
      throw err;
    }

    console.log(`  token:   ${tokenSourceLabel(tokenInfo.source, ctx.project)}`);
    console.log(`  channel: ${ctx.channelId}\n`);

    try {
      const bot = await getBotUser(tokenInfo.token);
      console.log(`Bot: ${bot.username} (${bot.id}) ✓`);
    } catch {
      console.error('Bot: could not authenticate. Check the token.');
      return 1;
    }

    try {
      const channel = await getChannel(ctx.channelId, tokenInfo.token);
      const name = channel.name ?? channel.id;
      console.log(`Channel: #${name} ✓`);
    } catch {
      console.error('Channel: inaccessible. Check channelId and bot permissions.');
      return 1;
    }

    const perms = await checkBotPermissions(ctx.channelId, tokenInfo.token);
    if (!perms.ok) {
      console.error(`Missing permissions: ${perms.missing.join(', ')}`);
      console.error(
        `The bot needs VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY (${REQUIRED_PERMISSION_BITS}).`,
      );
      console.error(
        'Re-invite the bot with permissions=68608 or adjust channel overwrites.',
      );
      return 1;
    }
    console.log('Permissions: VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY ✓');

    const autoAnswer = resolveAutoAnswer(config.projects[ctx.project]);
    console.log(
      `\nautoAnswer: ${autoAnswer.enabled ? 'enabled' : 'disabled (default)'}` +
        (autoAnswer.enabled
          ? ` (max ${autoAnswer.maxPerRequesterPerHour}/requester/h, timeout ${autoAnswer.timeoutSeconds}s)`
          : ''),
    );

    console.log('\nDiagnostics OK.');
    console.log(JSON.stringify(redactedContext(ctx), null, 2));
    return 0;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof SecretsError) {
      console.error(err.message);
      return 1;
    }
    console.error(`Unexpected error: ${String(err)}`);
    return 1;
  }
}

async function runInbox(all: boolean, projectOverride?: string): Promise<void> {
  const config = loadConfig();
  const ctx = resolveContext(process.cwd(), config, { projectOverride });
  const log = loadLog(ctx.project);
  const readState = loadReadState(ctx.project);
  const inbox = materializeInbox(log, ctx.dev, {
    unreadOnly: !all,
    readState,
  });

  if (inbox.length === 0) {
    console.log('Inbox empty.');
    return;
  }

  const formatted = formatInboxForDisplay(inbox, log);
  for (const block of formatted.split('\n\n')) {
    console.log('---');
    console.log(block);
  }

  markRead(ctx.project, inbox.map((e) => e.id));
  console.log(`\n${inbox.length} message(s) marked as read.`);
}

async function runBudget(projectOverride?: string): Promise<void> {
  const config = loadConfig();
  const ctx = resolveContext(process.cwd(), config, { projectOverride });
  const autoAnswer = resolveAutoAnswer(config.projects[ctx.project]);
  const snapshot = getBudgetSnapshot(ctx.project, autoAnswer.maxPerRequesterPerHour);
  console.log(formatBudgetSnapshot(snapshot));
}

async function runClaims(projectOverride?: string): Promise<void> {
  const config = loadConfig();
  const ctx = resolveContext(process.cwd(), config, { projectOverride });
  const log = loadLog(ctx.project);
  const claims = materializeActiveClaims(log);

  if (claims.length === 0) {
    console.log('(no active claims)');
    return;
  }

  for (const c of claims) {
    console.log(formatActiveClaim(c));
  }
}

const program = new Command();

program
  .name('ai-comms')
  .description('Coordination channel for AI agents')
  .version('1.0.0');

program.command('init').description('Create identity and first project').action(async () => {
  await runInit();
});

program
  .command('link')
  .description('Create .ai-comms.json in the current repo')
  .option('--no-instructions', 'Skip writing CLAUDE.md / AGENTS.md instructions block')
  .action(async (opts: { noInstructions?: boolean }) => {
    await runLink({ noInstructions: opts.noInstructions });
  });

program
  .command('join')
  .description('Register a repo with an existing .ai-comms.json')
  .argument('<path>', 'path to repo')
  .action(async (repoPath: string) => {
    await runJoin(repoPath);
  });

const secretCmd = program.command('secret').description('Secret management');
secretCmd
  .command('set <project>')
  .description('Save the bot token (hidden prompt)')
  .action(async (project: string) => {
    await runSecretSet(project);
  });

program
  .command('doctor')
  .description('Config and connectivity diagnostics')
  .option('--project <p>', 'project to diagnose')
  .action(async (opts: { project?: string }) => {
    const code = await runDoctor(opts.project);
    process.exitCode = code;
  });

program
  .command('daemon')
  .description('Listen on Discord channels for all projects')
  .option('--verbose', 'Verbose log to stderr')
  .action(async (opts: { verbose?: boolean }) => {
    try {
      await runDaemon({ verbose: opts.verbose });
    } catch (err) {
      if (err instanceof ConfigError || err instanceof SecretsError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  });

program.command('mcp').description('MCP stdio server').action(async () => {
  await runMcpServer();
});

program
  .command('inbox')
  .description('Print the inbox and mark it read')
  .option('--all', 'Include already-read messages')
  .option('--project <p>', 'project')
  .action(async (opts: { all?: boolean; project?: string }) => {
    await runInbox(opts.all ?? false, opts.project);
  });

program
  .command('claims')
  .description('List active team claims')
  .option('--project <p>', 'project')
  .action(async (opts: { project?: string }) => {
    await runClaims(opts.project);
  });

program
  .command('budget')
  .description('Show auto-answer budget usage for the current window')
  .option('--project <p>', 'project')
  .action(async (opts: { project?: string }) => {
    await runBudget(opts.project);
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof ConfigError || err instanceof SecretsError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(String(err));
  process.exit(1);
});
