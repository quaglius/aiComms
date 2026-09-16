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
  isChannelPubliclyReadable,
  REQUIRED_PERMISSION_BITS,
} from './transports/discord-api.js';
import { REPO_COMMS_FILENAME } from './paths.js';
import { PACKAGE_VERSION } from './version.js';
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
import { createTransport } from './transports/index.js';
import { isDiscordBus, isGitHubBus } from './transports/types.js';
import { getRepoCollaborators } from './collaborators.js';
import { runSetup } from './setup.js';

async function runInit(): Promise<void> {
  console.log('ai-comms initial setup (legacy Discord)\n');

  const dev = await prompt('dev (stable slug, e.g. ana)');
  const agent = await prompt('agent (e.g. claude-code, cursor)');
  const project = await prompt('project (team/project name, e.g. acme)');
  const channelId = await prompt('Discord channel ID for the project');

  const config = ConfigV2Schema.parse({
    version: 2,
    identity: { dev, agent },
    agent,
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

function writeMcpConfig(cwd: string): void {
  const target = path.join(cwd, '.mcp.json');
  if (existsSync(target)) {
    console.log(`${target} already exists — left untouched.`);
    return;
  }
  const config = {
    mcpServers: {
      'ai-comms': {
        command: 'npx',
        args: ['-y', `@quaglius/ai-comms@${PACKAGE_VERSION}`, 'mcp'],
      },
    },
  };
  writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`Created ${target} (pinned to ${PACKAGE_VERSION})`);
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
    discord: { channelId: projectConfig.discord!.channelId },
    team: [],
  });

  writeFileSync(target, JSON.stringify(repoComms, null, 2) + '\n', 'utf8');
  console.log(`Created ${target}`);

  writeMcpConfig(cwd);

  console.log('Commit both files so your team can use them with "ai-comms setup".');

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

    const transport = createTransport(ctx, config);
    const identity = await transport.whoami();

    console.log('ai-comms doctor\n');
    console.log('Identity:');
    console.log(`  dev:     ${identity.dev}${identity.authenticated ? '' : ' (not authenticated)'}`);
    console.log(`  agent:   ${ctx.agent}`);
    console.log(`  project: ${ctx.project}`);
    console.log(`  repo:    ${ctx.repo}`);
    if (ctx.repoCommsPath) {
      console.log(`  .ai-comms.json: ${ctx.repoCommsPath}`);
    }
    console.log(`  transport: ${transport.describe()}`);

    if (identity.warning) {
      console.log(`\n⚠ ${identity.warning}`);
    }

    if (isGitHubBus(ctx.bus)) {
      try {
        const collaborators = await getRepoCollaborators(ctx.bus.repo);
        console.log(`\nCollaborators: ${collaborators.length} (${collaborators.slice(0, 5).join(', ')}${collaborators.length > 5 ? ', …' : ''}) ✓`);
      } catch (err) {
        console.error(`\nCollaborators: could not list (${String(err)})`);
        return 1;
      }

      console.log(`\nBus: GitHub issue #${ctx.bus.issue} on ${ctx.bus.repo} ✓`);
    }

    if (isDiscordBus(ctx.bus)) {
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
      console.log(`  channel: ${ctx.bus.channelId}\n`);

      try {
        const bot = await getBotUser(tokenInfo.token);
        console.log(`Bot: ${bot.username} (${bot.id}) ✓`);
      } catch {
        console.error('Bot: could not authenticate. Check the token.');
        return 1;
      }

      try {
        const channel = await getChannel(ctx.bus.channelId, tokenInfo.token);
        const name = channel.name ?? channel.id;
        console.log(`Channel: #${name} ✓`);
      } catch {
        console.error('Channel: inaccessible. Check channelId and bot permissions.');
        return 1;
      }

      const perms = await checkBotPermissions(ctx.bus.channelId, tokenInfo.token);
      if (!perms.ok) {
        console.error(`Missing permissions: ${perms.missing.join(', ')}`);
        console.error(
          `The bot needs VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY (${REQUIRED_PERMISSION_BITS}).`,
        );
        return 1;
      }

      const privacy = await isChannelPubliclyReadable(ctx.bus.channelId, tokenInfo.token);
      if (privacy.public) {
        console.log(
          `Privacy: everyone on the server can read this channel — ${privacy.reason}.`,
        );
      } else {
        console.log('Privacy: channel is not readable by @everyone ✓');
      }
      console.log('Permissions: VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY ✓');

      if (!identity.authenticated) {
        console.log(
          '\nNote: Discord transport does not authenticate identity. Run "ai-comms setup" to migrate to GitHub.',
        );
      }
    }

    const autoAnswer = resolveAutoAnswer(config.projects[ctx.project]);
    console.log(
      `\nautoAnswer: ${autoAnswer.enabled ? 'enabled' : 'disabled (default)'}` +
        (autoAnswer.enabled
          ? ` (max ${autoAnswer.maxPerRequesterPerHour}/requester/h, timeout ${autoAnswer.timeoutSeconds}s)`
          : ''),
    );

    console.log('\nDiagnostics OK.');
    console.log(
      JSON.stringify(
        {
          ...redactedContext({ ...ctx, dev: identity.dev }),
          authenticated: identity.authenticated,
        },
        null,
        2,
      ),
    );
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
  const transport = createTransport(ctx, config);
  const identity = await transport.whoami();
  const log = loadLog(ctx.project);
  const readState = loadReadState(ctx.project);
  const inbox = materializeInbox(log, identity.dev, {
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
  .version(PACKAGE_VERSION);

program
  .command('setup')
  .description('Configure this repo for GitHub bus (no required prompts)')
  .option('--project <name>', 'Join an existing project instead of using the repo name')
  .option('--bus <owner/repo#issue>', 'Join an existing bus instead of creating one')
  .action(async (opts: { project?: string; bus?: string }) => {
    await runSetup({ project: opts.project, bus: opts.bus });
    const code = await runDoctor();
    process.exitCode = code;
  });

program.command('init').description('Create identity and first project (legacy Discord)').action(async () => {
  await runInit();
});

program
  .command('link')
  .description('Create .ai-comms.json in the current repo (legacy Discord)')
  .option('--no-instructions', 'Skip writing CLAUDE.md / AGENTS.md instructions block')
  .action(async (opts: { noInstructions?: boolean }) => {
    await runLink({ noInstructions: opts.noInstructions });
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
  .description('Listen on bus transports for all projects')
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
