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
  loadLog,
  loadReadState,
  materializeActiveClaims,
  materializeInbox,
  markRead,
} from './store.js';

async function runInit(): Promise<void> {
  console.log('Configuración inicial de ai-comms\n');

  const dev = await prompt('dev (slug estable, ej. ana)');
  const agent = await prompt('agent (ej. claude-code, cursor)');
  const project = await prompt('project (nombre del equipo/proyecto, ej. acme)');
  const channelId = await prompt('Discord channel ID del proyecto');

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
  console.log(`\nConfig guardada en ~/.ai-comms/config.json`);
  console.log(`Ejecutá "ai-comms secret set ${project}" para cargar el token del bot.`);
  console.log('Luego "ai-comms link" en cada repo y "ai-comms doctor" para verificar.');
}

async function runLink(): Promise<void> {
  const config = loadConfig();
  const cwd = process.cwd();
  const target = path.join(cwd, REPO_COMMS_FILENAME);

  if (existsSync(target)) {
    console.error(`${target} ya existe. Editá el archivo manualmente si necesitás cambiarlo.`);
    process.exit(1);
  }

  const defaultProject = config.defaultProject;
  const project = await prompt('project', defaultProject);
  const defaultRepo = path.basename(cwd);
  const repo = await prompt('repo', defaultRepo);

  const projectConfig = config.projects[project];
  if (!projectConfig) {
    console.error(
      `El proyecto "${project}" no está en config. Ejecutá "ai-comms init" o agregalo manualmente.`,
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
  console.log(`Creado ${target}`);
  console.log('Commiteá este archivo para que tu equipo lo use con "ai-comms join".');
}

async function runJoin(repoPath: string): Promise<void> {
  const absPath = path.resolve(repoPath);
  const repoCommsFile = path.join(absPath, REPO_COMMS_FILENAME);

  if (!existsSync(repoCommsFile)) {
    console.error(`No se encontró ${repoCommsFile}. ¿Clonaste el repo correcto?`);
    process.exit(1);
  }

  const repoComms = loadRepoComms(repoCommsFile);
  let config: ReturnType<typeof loadConfig>;

  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(
        `${err.message}\nEjecutá "ai-comms init" primero para configurar tu identidad.`,
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
  console.log(`Proyecto "${project}" registrado (repo: ${repoComms.repo}).`);
  console.log(`Ejecutá "ai-comms secret set ${project}" y luego "ai-comms doctor".`);
}

async function runSecretSet(project: string): Promise<void> {
  if (!project) {
    console.error('Uso: ai-comms secret set <project>');
    process.exit(1);
  }

  const token = await promptSecret('Discord bot token');
  if (!token) {
    console.error('Token vacío, cancelado.');
    process.exit(1);
  }

  setProjectToken(project, token);
  console.log(`Token guardado para "${project}" en ~/.ai-comms/secrets.json`);
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
    console.log('Identidad:');
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
      console.error('Bot: no se pudo autenticar. Verificá el token.');
      return 1;
    }

    try {
      const channel = await getChannel(ctx.channelId, tokenInfo.token);
      const name = channel.name ?? channel.id;
      console.log(`Canal: #${name} ✓`);
    } catch {
      console.error('Canal: inaccesible. Verificá channelId y permisos del bot.');
      return 1;
    }

    const perms = await checkBotPermissions(ctx.channelId, tokenInfo.token);
    if (!perms.ok) {
      console.error(`Permisos faltantes: ${perms.missing.join(', ')}`);
      console.error(
        `El bot necesita VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY (${REQUIRED_PERMISSION_BITS}).`,
      );
      console.error(
        'Reinvitá el bot con permissions=68608 o ajustá los overwrites del canal.',
      );
      return 1;
    }
    console.log('Permisos: VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY ✓');

    console.log('\nDiagnóstico OK.');
    console.log(JSON.stringify(redactedContext(ctx), null, 2));
    return 0;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof SecretsError) {
      console.error(err.message);
      return 1;
    }
    console.error(`Error inesperado: ${String(err)}`);
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
    console.log('Inbox vacío.');
    return;
  }

  for (const env of inbox) {
    console.log('---');
    console.log(`${env.type} · ${env.from.dev}/${env.from.agent} · ${env.subject}`);
    console.log(JSON.stringify(env, null, 2));
  }

  markRead(ctx.project, inbox.map((e) => e.id));
  console.log(`\n${inbox.length} mensaje(s) marcado(s) como leído.`);
}

async function runClaims(projectOverride?: string): Promise<void> {
  const config = loadConfig();
  const ctx = resolveContext(process.cwd(), config, { projectOverride });
  const log = loadLog(ctx.project);
  const claims = materializeActiveClaims(log);

  if (claims.length === 0) {
    console.log('(sin claims activos)');
    return;
  }

  for (const c of claims) {
    console.log(
      `${c.id} · ${c.dev}/${c.agent} · ${c.repo} · until=${c.until} · paths=${c.paths.join(', ')} · ${c.subject}`,
    );
  }
}

const program = new Command();

program
  .name('ai-comms')
  .description('Canal de coordinación entre agentes de IA')
  .version('1.0.0');

program.command('init').description('Crea identidad y primer proyecto').action(async () => {
  await runInit();
});

program
  .command('link')
  .description('Crea .ai-comms.json en el repo actual')
  .action(async () => {
    await runLink();
  });

program
  .command('join')
  .description('Registra un repo con .ai-comms.json existente')
  .argument('<ruta>', 'ruta al repo')
  .action(async (repoPath: string) => {
    await runJoin(repoPath);
  });

const secretCmd = program.command('secret').description('Gestión de secretos');
secretCmd
  .command('set <project>')
  .description('Guarda el token del bot (prompt oculto)')
  .action(async (project: string) => {
    await runSecretSet(project);
  });

program
  .command('doctor')
  .description('Diagnóstico de config y conectividad')
  .option('--project <p>', 'proyecto a diagnosticar')
  .action(async (opts: { project?: string }) => {
    const code = await runDoctor(opts.project);
    process.exitCode = code;
  });

program
  .command('daemon')
  .description('Escucha canales de Discord de todos los proyectos')
  .option('--verbose', 'Log detallado a stderr')
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

program.command('mcp').description('Servidor MCP stdio').action(async () => {
  await runMcpServer();
});

program
  .command('inbox')
  .description('Imprime el inbox y lo marca leído')
  .option('--all', 'Incluir mensajes ya leídos')
  .option('--project <p>', 'proyecto')
  .action(async (opts: { all?: boolean; project?: string }) => {
    await runInbox(opts.all ?? false, opts.project);
  });

program
  .command('claims')
  .description('Lista claims activos del equipo')
  .option('--project <p>', 'proyecto')
  .action(async (opts: { project?: string }) => {
    await runClaims(opts.project);
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof ConfigError || err instanceof SecretsError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(String(err));
  process.exit(1);
});
