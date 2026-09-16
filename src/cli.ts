#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Command } from 'commander';
import {
  CONFIG_PATH,
  ConfigError,
  loadConfig,
  saveConfig,
  getEffectiveToken,
  redactedConfig,
  ConfigSchema,
} from './config.js';
import { runDaemon } from './daemon.js';
import { runMcpServer } from './mcp.js';
import { getBotUser, getChannel, sendEnvelope } from './discord.js';
import { createEnvelope } from './envelope.js';
import {
  loadLog,
  materializeInbox,
  markRead,
} from './store.js';

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || '';
  } finally {
    rl.close();
  }
}

async function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(`${question}: `)).trim();
  } finally {
    rl.close();
  }
}

async function runInit(): Promise<void> {
  console.log('Configuración inicial de ai-comms\n');

  const dev = await prompt('dev (slug estable, ej. dani)');
  const agent = await prompt('agent (ej. claude-code, cursor)');
  const repo = await prompt('repo (nombre del repo actual)');
  const token = await promptSecret('Discord bot token');
  const channelId = await prompt('Discord channel ID');

  const config = ConfigSchema.parse({
    dev,
    agent,
    repo,
    discord: { token, channelId },
  });

  saveConfig(config);
  console.log(`\nConfig guardada en ${CONFIG_PATH}`);
  console.log('Ejecutá "ai-comms doctor" para verificar la conexión.');
}

async function runDoctor(): Promise<number> {
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

    console.log('ai-comms doctor\n');
    console.log('Identidad:');
    console.log(`  dev:   ${config.dev}`);
    console.log(`  agent: ${config.agent}`);
    console.log(`  repo:  ${config.repo}`);
    console.log(`  token: ${process.env.AI_COMMS_TOKEN ? '[env AI_COMMS_TOKEN]' : '[config file]'}`);
    console.log(`  channel: ${config.discord.channelId}\n`);

    const token = getEffectiveToken(config);

    try {
      const bot = await getBotUser(token);
      console.log(`Bot: ${bot.username} (${bot.id}) ✓`);
    } catch {
      console.error('Bot: no se pudo autenticar. Verificá el token.');
      return 1;
    }

    try {
      const channel = await getChannel(config.discord.channelId, token);
      const name = channel.name ?? channel.id;
      console.log(`Canal: #${name} ✓`);
    } catch {
      console.error('Canal: inaccesible. Verificá channelId y permisos del bot.');
      return 1;
    }

    console.log('\nDiagnóstico OK.');
    console.log(JSON.stringify(redactedConfig(config), null, 2));
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    console.error(`Error inesperado: ${String(err)}`);
    return 1;
  }
}

async function runInbox(all: boolean): Promise<void> {
  const config = loadConfig();
  const log = loadLog();
  const inbox = materializeInbox(log, config.dev, { unreadOnly: !all });

  if (inbox.length === 0) {
    console.log('Inbox vacío.');
    return;
  }

  for (const env of inbox) {
    console.log('---');
    console.log(`${env.type} · ${env.from.dev}/${env.from.agent} · ${env.subject}`);
    console.log(JSON.stringify(env, null, 2));
  }

  markRead(inbox.map((e) => e.id));
  console.log(`\n${inbox.length} mensaje(s) marcado(s) como leído.`);
}

const program = new Command();

program
  .name('ai-comms')
  .description('Canal de coordinación entre agentes de IA')
  .version('0.1.0');

program.command('init').description('Crea ~/.ai-comms/config.json').action(async () => {
  await runInit();
});

program
  .command('doctor')
  .description('Diagnóstico de config y conectividad')
  .action(async () => {
    const code = await runDoctor();
    process.exitCode = code;
  });

program
  .command('daemon')
  .description('Escucha el canal de Discord')
  .option('--verbose', 'Log detallado a stderr')
  .action(async (opts: { verbose?: boolean }) => {
    try {
      await runDaemon({ verbose: opts.verbose });
    } catch (err) {
      if (err instanceof ConfigError) {
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
  .action(async (opts: { all?: boolean }) => {
    await runInbox(opts.all ?? false);
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(String(err));
  process.exit(1);
});
