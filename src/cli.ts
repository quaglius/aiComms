#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
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
import { runSetup, writeMcpConfig } from './setup.js';
import {
  AutoAnswerConfigError,
  computeAutoAnswerConfig,
  drainStdin,
  installClaudeHooks,
  resolveAutoAnswerRepoPath,
  runHook,
  uninstallClaudeHooks,
} from './hook.js';
import { fetchProfiles, renderDirectory } from './presence.js';
import { createSpace, inviteToSpace, joinSpace, resolveSpaceRepo, runStatus } from './space.js';

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

export async function runDoctor(projectOverride?: string): Promise<number> {
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
        // Listing collaborators requires write/maintain/admin on the repo
        // (GitHub's API, not ours). A teammate with only read/triage access
        // gets a 403 here — that is not broken, so it must not fail doctor.
        console.log(`\n⚠ Collaborators: could not list (${String(err)})`);
      }

      console.log(`\nBus: GitHub issue #${ctx.bus.issue} on ${ctx.bus.repo} ✓`);

      const mcpDir = ctx.repoCommsPath ? path.dirname(ctx.repoCommsPath) : process.cwd();
      const mcpConfigPath = path.join(mcpDir, '.mcp.json');
      let mcpRegistered = false;
      if (existsSync(mcpConfigPath)) {
        try {
          const raw = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as {
            mcpServers?: Record<string, unknown>;
          };
          mcpRegistered = Boolean(raw.mcpServers?.['ai-comms']);
        } catch {
          mcpRegistered = false;
        }
      }
      if (mcpRegistered) {
        console.log(`MCP: ${mcpConfigPath} registers ai-comms ✓`);
      } else {
        console.log(
          `\n⚠ MCP: ${mcpConfigPath} does not register the ai-comms server. Run "ai-comms setup" ` +
            `again, or add it by hand (see docs/INSTALL.md).`,
        );
      }
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

function printProfile(config: ReturnType<typeof loadConfig>): void {
  const role = config.profile?.role ?? '(not set)';
  const areas = config.profile?.areas?.length ? config.profile.areas.join(', ') : '(not set)';
  console.log(`role:  ${role}`);
  console.log(`areas: ${areas}`);
}

async function runProfileSet(opts: { role?: string; areas?: string }): Promise<void> {
  const config = loadConfig();

  const role = opts.role !== undefined ? opts.role.trim() : config.profile?.role;
  const areas =
    opts.areas !== undefined
      ? opts.areas
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)
      : (config.profile?.areas ?? []);

  config.profile = {
    ...(role ? { role } : {}),
    ...(areas.length ? { areas } : {}),
  };
  saveConfig(config);

  console.log('Profile updated.');
  printProfile(config);
  console.log('The running daemon picks this up within a minute.');
}

async function runProfileShow(): Promise<void> {
  printProfile(loadConfig());
}

async function runTeam(projectOverride?: string): Promise<void> {
  const config = loadConfig();
  const ctx = resolveContext(process.cwd(), config, { projectOverride });

  if (!isGitHubBus(ctx.bus) || ctx.bus.presence === undefined) {
    console.log(
      'No presence directory configured for this project. Run "ai-comms setup" to create one.',
    );
    return;
  }

  const profiles = await fetchProfiles(ctx.bus);
  console.log(renderDirectory(profiles));
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
  .option('--allow-public', 'Allow a public repo as the bus (private is required by default)')
  .action(async (opts: { project?: string; bus?: string; allowPublic?: boolean }) => {
    await runSetup({ project: opts.project, bus: opts.bus, allowPublic: opts.allowPublic });
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

// --- SPEC-v0.7 §2.7: hook / hooks install / hooks uninstall -----------------
//
// `ai-comms hook <kind>` itself is normally invoked via bin/ai-comms.js's
// lightweight `dist/hook-entry.js` dispatch (see bin/ai-comms.js and
// src/hook-entry.ts), not through this commander action — that's what keeps
// a Claude Code hook from paying for this whole CLI (commander, the daemon,
// discord.js, the MCP SDK) on every prompt. This command definition stays
// here too so `ai-comms --help` still lists `hook`, and as a fallback for
// anything that invokes dist/cli.js's `hook` subcommand directly. It must
// keep matching hook-entry.ts's behavior exactly (same drainStdin, same
// "never fails, always exits 0" contract).

program
  .command('hook <kind>')
  .description(
    'Print unread bus activity for a Claude Code hook (kind: session-start|user-prompt). ' +
      'Never fails the hook: always exits 0.',
  )
  .action(async (kind: string) => {
    await drainStdin();
    try {
      if (kind === 'session-start' || kind === 'user-prompt') {
        const output = runHook(kind, process.cwd());
        if (output) console.log(output);
      }
    } catch {
      // A hook must never break the user's prompt.
    }
    process.exitCode = 0;
  });

const hooksCmd = program
  .command('hooks')
  .description('Manage the local Claude Code hooks that surface new bus activity');

hooksCmd
  .command('install')
  .description('Install SessionStart/UserPromptSubmit hooks into ~/.claude/settings.json (idempotent)')
  .action(() => {
    const result = installClaudeHooks();
    if (result.failed) {
      console.warn(`⚠ ${result.failed}`);
      return;
    }
    for (const event of result.installed) {
      console.log(`Installed ${event} hook in ${result.settingsPath}`);
    }
    for (const event of result.alreadyInstalled) {
      console.log(`${event} hook already installed in ${result.settingsPath}`);
    }
    if (result.installed.length === 0 && result.alreadyInstalled.length === 0) {
      console.log(`No hook events to install in ${result.settingsPath}`);
    }
  });

hooksCmd
  .command('uninstall')
  .description('Remove ai-comms hooks from ~/.claude/settings.json, leaving everything else untouched')
  .action(() => {
    const result = uninstallClaudeHooks();
    if (result.failed) {
      console.warn(`⚠ ${result.failed}`);
      return;
    }
    if (result.removed.length === 0) {
      console.log(`No ai-comms hooks found in ${result.settingsPath}`);
      return;
    }
    for (const event of result.removed) {
      console.log(`Removed ${event} hook from ${result.settingsPath}`);
    }
  });

// --- SPEC-v0.7 §3.1: autoanswer on|off --------------------------------------

async function runAutoAnswerCommand(
  state: 'on' | 'off',
  options: { project?: string; repoPath?: string },
): Promise<void> {
  const config = loadConfig();
  const ctx = resolveContext(process.cwd(), config, { projectOverride: options.project });
  const project = ctx.project;

  // Validate/resolve --repo-path (existence, directory-ness, not $HOME, not
  // a filesystem root) before anything is persisted, whether we're turning
  // auto-answer on or off — see resolveAutoAnswerRepoPath.
  const resolvedRepoPath =
    options.repoPath !== undefined ? resolveAutoAnswerRepoPath(options.repoPath) : undefined;

  const prev = config.projects[project]?.autoAnswer;

  if (state === 'on') {
    const registeredRepos = config.projects[project]?.repos ?? [];
    const effectiveRepoPath = resolvedRepoPath ?? prev?.repoPath;
    // With zero or several repos registered for this project, the
    // auto-answerer has no way to guess which checkout to read from; with
    // exactly one, that one is unambiguous even without --repo-path.
    if (!effectiveRepoPath && registeredRepos.length !== 1) {
      throw new AutoAnswerConfigError(
        `Project "${project}" has ${registeredRepos.length} registered repo${registeredRepos.length === 1 ? '' : 's'}. ` +
          'Pass --repo-path <dir containing the repos> so the auto-answerer knows which checkout to read from.',
      );
    }
  }

  const autoAnswer = computeAutoAnswerConfig(prev, state === 'on', resolvedRepoPath);

  config.projects[project] = { ...(config.projects[project] ?? {}), autoAnswer };
  saveConfig(config);

  console.log(`autoAnswer for "${project}": ${autoAnswer.enabled ? 'ON' : 'OFF'}`);
  console.log(
    `  max ${autoAnswer.maxPerRequesterPerHour}/requester/h, timeout ${autoAnswer.timeoutSeconds}s, ` +
      `maxAge ${autoAnswer.maxAgeMinutes}m` +
      (autoAnswer.repoPath ? `, repoPath=${autoAnswer.repoPath}` : ''),
  );
  console.log('\nNote: the daemon must be running for auto-answer to actually respond on the bus.');
  console.log('The running daemon picks this up within a minute.');
}

program
  .command('autoanswer <state>')
  .description('Turn the auto-answerer on or off for a project (state: on|off)')
  .option('--project <p>', 'project')
  .option(
    '--repo-path <dir>',
    'repo checkout the auto-answerer should read from (required unless the project has exactly one registered repo)',
  )
  .action(async (state: string, opts: { project?: string; repoPath?: string }) => {
    if (state !== 'on' && state !== 'off') {
      console.error('Usage: ai-comms autoanswer on|off [--project p] [--repo-path dir]');
      process.exitCode = 1;
      return;
    }
    try {
      await runAutoAnswerCommand(state, opts);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

const profileCmd = program.command('profile').description('Your ai-comms presence profile');
profileCmd
  .command('set')
  .description('Set your role and/or areas for the team directory')
  .option('--role <role>', 'what you are the go-to person for (e.g. backend, infra)')
  .option('--areas <a,b,...>', 'comma-separated globs you know best (e.g. "src/api/**,docs/adr/**")')
  .action(async (opts: { role?: string; areas?: string }) => {
    await runProfileSet(opts);
  });
profileCmd
  .command('show')
  .description('Show your current profile')
  .action(async () => {
    await runProfileShow();
  });

program
  .command('team')
  .description('Show the presence/team directory for the current project')
  .option('--project <p>', 'project')
  .action(async (opts: { project?: string }) => {
    await runTeam(opts.project);
  });

// --- SPEC-v0.7 §3.1: team space (space create / invite / join / status) ----

const spaceCmd = program
  .command('space')
  .description('Manage an ai-comms team space (a private GitHub repo dedicated to the bus)');

spaceCmd
  .command('create <name>')
  .description(
    'Create a private space repo (or reuse one), its bus/presence issues, register it, and join it. ' +
      '<name> is either "myspace" (uses your login or --org) or "owner/myspace".',
  )
  .option('--org <org>', 'Create the space under a GitHub organization instead of your personal account')
  .option('--allow-public', 'Allow a public repo as the space (private is required by default)')
  .action(async (name: string, opts: { org?: string; allowPublic?: boolean }) => {
    try {
      await createSpace(name, {
        org: opts.org,
        allowPublic: opts.allowPublic,
        joinSteps: { runDoctorFn: (project) => runDoctor(project) },
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('invite <logins...>')
  .description('Invite GitHub logins as collaborators (push) on a team space')
  .option('--space <owner/name>', 'Space to invite into (defaults to the current/default project\'s bus repo)')
  .option('--team <org/slug>', 'Also grant a GitHub team push access to the space')
  .action(async (logins: string[], opts: { space?: string; team?: string }) => {
    const config = loadConfig();
    const space = resolveSpaceRepo(opts.space, config);
    const results = await inviteToSpace(logins, space, { team: opts.team });

    for (const r of results) {
      if (r.status === 'invited') console.log(`✓ ${r.login}: invited`);
      else if (r.status === 'already-collaborator') console.log(`✓ ${r.login}: already a collaborator`);
      else {
        console.log(`⚠ ${r.login}: failed (${r.detail})`);
        process.exitCode = 1;
      }
    }
    console.log('\nInvitees must accept the GitHub invitation before "ai-comms join" will work for them.');
  });

program
  .command('join <owner-repo>')
  .description(
    'Join an existing team space (<owner-repo> = "owner/name"): find its bus/presence issues, ' +
      'register it, and set it up locally',
  )
  .option('--allow-public', 'Allow a public repo as the space (private is required by default)')
  .action(async (ownerRepo: string, opts: { allowPublic?: boolean }) => {
    try {
      await joinSpace(ownerRepo, {
        allowPublic: opts.allowPublic,
        joinSteps: { runDoctorFn: (project) => runDoctor(project) },
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('status')
  .description('Identity, project/bus, daemon, auto-answer, team directory, and pending inbox/claims')
  .option('--project <p>', 'project')
  .action(async (opts: { project?: string }) => {
    await runStatus({ project: opts.project });
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof ConfigError || err instanceof SecretsError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(String(err));
  process.exit(1);
});
