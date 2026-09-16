import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

async function withTempHome(fn: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'ai-comms-test-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await fn(home);
  } finally {
    if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
    else delete process.env.HOME;
    if (ORIGINAL_USERPROFILE) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
    else delete process.env.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  }
}

function writeConfig(home: string, data: unknown): void {
  const configPath = path.join(home, '.ai-comms', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(data) + '\n');
}

describe('resolveContext', () => {
  it('resolves from .ai-comms.json in cwd', async () => {
    await withTempHome(async (home) => {
      const repo = path.join(home, 'repos', 'acme-api');
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        path.join(repo, '.ai-comms.json'),
        JSON.stringify({
          project: 'acme',
          repo: 'acme-api',
          discord: { channelId: '111' },
          team: ['ana', 'beto'],
        }) + '\n',
      );
      writeConfig(home, {
        version: 2,
        identity: { dev: 'ana', agent: 'cursor' },
        defaultProject: 'acme',
        projects: { acme: { discord: { channelId: '999' } } },
      });

      const { resolveContext } = await import('../src/context.js');
      const config = (await import('../src/config.js')).loadConfig();
      const ctx = resolveContext(repo, config);
      assert.equal(ctx.project, 'acme');
      assert.equal(ctx.repo, 'acme-api');
      assert.equal(ctx.dev, 'ana');
      assert.equal(ctx.channelId, '111');
      assert.equal(ctx.source, 'repo');
      assert.deepEqual(ctx.team, ['ana', 'beto']);
    });
  });

  it('resolves from .ai-comms.json in an ancestor', async () => {
    await withTempHome(async (home) => {
      const repo = path.join(home, 'repos', 'acme-api');
      const sub = path.join(repo, 'src', 'deep');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        path.join(repo, '.ai-comms.json'),
        JSON.stringify({
          project: 'acme',
          repo: 'acme-api',
          discord: { channelId: '222' },
        }) + '\n',
      );
      writeConfig(home, {
        version: 2,
        identity: { dev: 'beto', agent: 'claude-code' },
        defaultProject: 'acme',
        projects: {},
      });

      const { resolveContext } = await import('../src/context.js');
      const config = (await import('../src/config.js')).loadConfig();
      const ctx = resolveContext(sub, config);
      assert.equal(ctx.repo, 'acme-api');
      assert.equal(ctx.channelId, '222');
    });
  });

  it('fails with actionable error when there is no context', async () => {
    await withTempHome(async (home) => {
      writeConfig(home, {
        version: 2,
        identity: { dev: 'ana', agent: 'cursor' },
        defaultProject: 'acme',
        projects: {},
      });

      const { resolveContext, ContextError } = await import('../src/context.js');
      const config = (await import('../src/config.js')).loadConfig();
      const orphan = path.join(home, 'nowhere');
      mkdirSync(orphan, { recursive: true });
      assert.throws(() => resolveContext(orphan, config), ContextError);
      try {
        resolveContext(orphan, config);
      } catch (err) {
        assert.match(String(err), /ai-comms setup/);
        assert.match(String(err), /--project/);
      }
    });
  });

  it('distinguishes two repos in the same project', async () => {
    await withTempHome(async (home) => {
      const api = path.join(home, 'acme-api');
      const web = path.join(home, 'acme-web');
      mkdirSync(api, { recursive: true });
      mkdirSync(web, { recursive: true });

      writeFileSync(
        path.join(api, '.ai-comms.json'),
        JSON.stringify({
          project: 'acme',
          repo: 'acme-api',
          discord: { channelId: '333' },
        }) + '\n',
      );
      writeFileSync(
        path.join(web, '.ai-comms.json'),
        JSON.stringify({
          project: 'acme',
          repo: 'acme-web',
          discord: { channelId: '333' },
        }) + '\n',
      );
      writeConfig(home, {
        version: 2,
        identity: { dev: 'ana', agent: 'cursor' },
        defaultProject: 'acme',
        projects: {},
      });

      const { resolveContext } = await import('../src/context.js');
      const config = (await import('../src/config.js')).loadConfig();
      assert.equal(resolveContext(api, config).repo, 'acme-api');
      assert.equal(resolveContext(web, config).repo, 'acme-web');
    });
  });
});

describe('malformed .ai-comms.json', () => {
  it('returns actionable error, not stack trace', async () => {
    await withTempHome(async (home) => {
      const repo = path.join(home, 'bad-repo');
      mkdirSync(repo, { recursive: true });
      writeFileSync(path.join(repo, '.ai-comms.json'), '{ not json');

      const { loadRepoComms, ContextError } = await import('../src/context.js');
      assert.throws(() => loadRepoComms(path.join(repo, '.ai-comms.json')), ContextError);
      try {
        loadRepoComms(path.join(repo, '.ai-comms.json'));
      } catch (err) {
        assert.ok(!String(err).includes('at '));
        assert.match(String(err), /valid JSON|invalid/);
      }
    });
  });
});

describe('token precedence', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.AI_COMMS_TOKEN = process.env.AI_COMMS_TOKEN;
    savedEnv.AI_COMMS_TOKEN_ACME = process.env.AI_COMMS_TOKEN_ACME;
    savedEnv.AI_COMMS_TOKEN_MY_PROJECT = process.env.AI_COMMS_TOKEN_MY_PROJECT;
    delete process.env.AI_COMMS_TOKEN;
    delete process.env.AI_COMMS_TOKEN_ACME;
    delete process.env.AI_COMMS_TOKEN_MY_PROJECT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    }
  });

  it('prefers AI_COMMS_TOKEN_<PROJECT> over global and secrets', async () => {
    await withTempHome(async (home) => {
      const secretsPath = path.join(home, '.ai-comms', 'secrets.json');
      mkdirSync(path.dirname(secretsPath), { recursive: true });
      writeFileSync(
        secretsPath,
        JSON.stringify({ acme: { token: 'from-secrets' } }) + '\n',
      );

      process.env.AI_COMMS_TOKEN = 'from-global';
      process.env.AI_COMMS_TOKEN_ACME = 'from-project-env';

      const { getEffectiveToken } = await import('../src/secrets.js');
      const result = getEffectiveToken('acme', secretsPath);
      assert.equal(result.token, 'from-project-env');
      assert.equal(result.source, 'env-project');
    });
  });

  it('prefers AI_COMMS_TOKEN over secrets.json', async () => {
    await withTempHome(async (home) => {
      const secretsPath = path.join(home, '.ai-comms', 'secrets.json');
      mkdirSync(path.dirname(secretsPath), { recursive: true });
      writeFileSync(
        secretsPath,
        JSON.stringify({ acme: { token: 'from-secrets' } }) + '\n',
      );

      process.env.AI_COMMS_TOKEN = 'from-global';

      const { getEffectiveToken } = await import('../src/secrets.js');
      const result = getEffectiveToken('acme', secretsPath);
      assert.equal(result.token, 'from-global');
      assert.equal(result.source, 'env-global');
    });
  });

  it('uses secrets.json when no env vars are set', async () => {
    await withTempHome(async (home) => {
      const secretsPath = path.join(home, '.ai-comms', 'secrets.json');
      mkdirSync(path.dirname(secretsPath), { recursive: true });
      writeFileSync(
        secretsPath,
        JSON.stringify({ acme: { token: 'from-secrets' } }) + '\n',
      );

      const { getEffectiveToken } = await import('../src/secrets.js');
      const result = getEffectiveToken('acme', secretsPath);
      assert.equal(result.token, 'from-secrets');
      assert.equal(result.source, 'secrets');
    });
  });

  it('converts project hyphens to underscores in env var name', async () => {
    process.env.AI_COMMS_TOKEN_MY_PROJECT = 'dash-token';
    const { projectTokenEnvKey, getEffectiveToken } = await import('../src/secrets.js');
    assert.equal(projectTokenEnvKey('my-project'), 'AI_COMMS_TOKEN_MY_PROJECT');
    const result = getEffectiveToken('my-project', path.join(tmpdir(), 'nope.json'));
    assert.equal(result.token, 'dash-token');
  });
});

describe('v0 migration', () => {
  it('moves loose state to defaultProject', async () => {
    await withTempHome(async (home) => {
      const commsDir = path.join(home, '.ai-comms');
      mkdirSync(commsDir, { recursive: true });
      writeFileSync(path.join(commsDir, 'log.jsonl'), '{"v":1}\n');
      writeFileSync(path.join(commsDir, 'cursor.json'), '{"lastMessageId":"1"}\n');
      writeConfig(home, {
        version: 2,
        identity: { dev: 'ana', agent: 'cursor' },
        defaultProject: 'acme',
        projects: { acme: { discord: { channelId: '1' } } },
      });

      const { maybeMigrateV0, resetMigrationForTests } = await import('../src/migrate.js');
      resetMigrationForTests();
      const messages = maybeMigrateV0();
      assert.ok(messages.some((m) => m.includes('Migrated v0 state')));

      const projectLog = path.join(commsDir, 'projects', 'acme', 'log.jsonl');
      assert.ok(existsSync(projectLog));
      assert.ok(!existsSync(path.join(commsDir, 'log.jsonl')));
      assert.equal(readFileSync(projectLog, 'utf8'), '{"v":1}\n');
    });
  });

  it('migrates v0 config to v2 and moves token to secrets.json', async () => {
    await withTempHome(async (home) => {
      const commsDir = path.join(home, '.ai-comms');
      mkdirSync(commsDir, { recursive: true });
      writeFileSync(
        path.join(commsDir, 'config.json'),
        JSON.stringify({
          dev: 'ana',
          agent: 'claude-code',
          repo: 'acme',
          discord: { token: 'secret-token-123', channelId: 'chan1' },
        }) + '\n',
      );

      const { maybeMigrateV0, resetMigrationForTests } = await import('../src/migrate.js');
      resetMigrationForTests();
      maybeMigrateV0();

      const config = JSON.parse(readFileSync(path.join(commsDir, 'config.json'), 'utf8'));
      assert.equal(config.version, 2);
      assert.equal(config.defaultProject, 'acme');
      assert.ok(!JSON.stringify(config).includes('token'));

      const secrets = JSON.parse(readFileSync(path.join(commsDir, 'secrets.json'), 'utf8'));
      assert.equal(secrets.acme.token, 'secret-token-123');
    });
  });
});

describe('Discord permissions', () => {
  it('computeEffectivePermissions resolves channel overwrites', async () => {
    const { computeEffectivePermissions, REQUIRED_PERMISSION_BITS } = await import(
      '../src/discord.js'
    );
    const guildId = '100';
    const roleId = '200';
    const botId = '300';

    const perms = computeEffectivePermissions(
      guildId,
      0n,
      [roleId],
      [
        { id: guildId, permissions: '0', position: 0 },
        { id: roleId, permissions: String(REQUIRED_PERMISSION_BITS), position: 1 },
      ],
      [
        { id: guildId, type: 0, allow: '0', deny: String(1n << 10n) },
        { id: roleId, type: 0, allow: String(REQUIRED_PERMISSION_BITS), deny: '0' },
      ],
      botId,
    );

    assert.equal((perms & REQUIRED_PERMISSION_BITS) === REQUIRED_PERMISSION_BITS, true);
  });
});

describe('tokens not in versioned files', () => {
  it('rejects saving token in config.json', async () => {
    await withTempHome(async (home) => {
      const { saveConfig } = await import('../src/config.js');
      const configPath = path.join(home, '.ai-comms', 'config.json');
      assert.throws(
        () =>
          saveConfig(
            {
              version: 2,
              identity: { dev: 'a', agent: 'b' },
              defaultProject: 'p',
              projects: {
                p: { discord: { channelId: '1', token: 'nope' } },
              },
            } as never,
            configPath,
          ),
        /token/,
      );
    });
  });

  it('.ai-comms.json schema does not accept token', async () => {
    const { RepoCommsSchema } = await import('../src/context.js');
    const result = RepoCommsSchema.safeParse({
      project: 'acme',
      repo: 'api',
      discord: { channelId: '1', token: 'nope' },
    });
    assert.equal(result.success, false);
  });
});
