import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir, platform } from 'node:os';
import { getGitRemote, repoBasename } from './git-remote.js';
import { getGitHubToken } from './github-auth.js';
import { githubFetch } from './transports/github-api.js';
import { getConfigPath, REPO_COMMS_FILENAME } from './paths.js';
import { loadConfig, saveConfig, type ConfigV2 } from './config.js';
import { buildInstructionsBlock, writeInstructionsToRepo } from './instructions.js';
import { PACKAGE_VERSION } from './version.js';
import { prompt } from './prompt.js';

const BUS_LABEL = 'ai-comms-bus';
const BUS_TITLE = 'ai-comms bus';
const BUS_BODY =
  'Coordination bus for AI agents on this project. Each comment carries an ai-comms envelope. ' +
  'Do not close this issue — it is the team bus.';

export function detectAgent(): string {
  if (process.env.AI_COMMS_AGENT?.trim()) return process.env.AI_COMMS_AGENT.trim();
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_SESSION) return 'cursor';
  if (process.env.CLAUDE_CODE) return 'claude-code';
  if (process.env.CODEX_HOME) return 'codex';
  if (process.env.GEMINI_CLI) return 'gemini-cli';

  try {
    const config = loadConfig();
    if (config.agent) return config.agent;
    if (config.identity?.agent) return config.identity.agent;
  } catch {
    // no config yet
  }

  return 'claude-code';
}

export async function findBusIssue(
  ownerRepo: string,
  options: { token?: string; fetchFn?: typeof fetch } = {},
): Promise<number | null> {
  const [owner, repo] = ownerRepo.split('/');
  const url = `/repos/${owner}/${repo}/issues?labels=${BUS_LABEL}&state=open&per_page=10`;
  const response = await githubFetch(url, { method: 'GET' }, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to search bus issue (${response.status}): ${text.slice(0, 200)}`);
  }

  const issues = (await response.json()) as Array<{ number: number; pull_request?: unknown }>;
  const issue = issues.find((i) => !i.pull_request);
  return issue?.number ?? null;
}

export async function createBusIssue(
  ownerRepo: string,
  options: { token?: string; fetchFn?: typeof fetch } = {},
): Promise<number> {
  const [owner, repo] = ownerRepo.split('/');
  const response = await githubFetch(
    `/repos/${owner}/${repo}/issues`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: BUS_TITLE,
        body: BUS_BODY,
        labels: [BUS_LABEL],
      }),
    },
    options,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create bus issue (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as { number: number };
  return data.number;
}

/**
 * Compare two filesystem paths for identity.
 *
 * Raw string comparison duplicated entries whenever the same directory was
 * written once with forward slashes and once with backslashes — which is what
 * happens when a config is hand-edited on Windows and later rewritten by
 * path.resolve. Windows is also case-insensitive.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p).replace(/[\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
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

function writeRepoComms(
  cwd: string,
  project: string,
  repo: string,
  ownerRepo: string,
  issue: number,
): void {
  const target = path.join(cwd, REPO_COMMS_FILENAME);
  const repoComms = {
    project,
    repo,
    bus: { kind: 'github', repo: ownerRepo, issue },
  };
  writeFileSync(target, JSON.stringify(repoComms, null, 2) + '\n', 'utf8');
  console.log(`Created ${target}`);
}

function ensureUserConfig(
  cwd: string,
  project: string,
  repo: string,
  agent: string,
  issue: number,
  ownerRepo: string,
): void {
  const configPath = getConfigPath();
  let config: ConfigV2;

  try {
    config = loadConfig(configPath);
  } catch {
    config = {
      version: 2,
      agent,
      defaultProject: project,
      projects: {},
    };
  }

  config.agent = agent;
  if (!config.defaultProject) config.defaultProject = project;

  const absPath = path.resolve(cwd);
  const existing = config.projects[project] ?? {};
  const repos = existing.repos ?? [];
  const filtered = repos.filter((r) => !samePath(r.path, absPath));
  filtered.push({ name: repo, path: absPath });

  config.projects[project] = {
    ...existing,
    bus: existing.bus ?? {
      kind: 'github',
      repo: ownerRepo,
      issue,
    },
    repos: filtered,
  };

  saveConfig(config, configPath);
  console.log(`Updated ${configPath}`);
}

export async function offerDaemonInstall(): Promise<void> {
  const answer = await prompt('Install ai-comms daemon at login? [Y/n]', 'Y');
  if (answer.toLowerCase() === 'n') return;

  const os = platform();
  if (os === 'win32') {
    const startup = path.join(
      process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
    );
    const vbsPath = path.join(startup, 'ai-comms-daemon.vbs');
    const vbs = [
      'Set WshShell = CreateObject("WScript.Shell")',
      'WshShell.Run "cmd /c ai-comms daemon", 0, False',
      '',
    ].join('\n');
    writeFileSync(vbsPath, vbs, 'utf8');
    console.log(`Created ${vbsPath}`);
    return;
  }

  if (os === 'darwin') {
    const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', 'com.ai-comms.daemon.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ai-comms.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>ai-comms</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
    writeFileSync(plistPath, plist, 'utf8');
    console.log(`Created ${plistPath} — run: launchctl load ${plistPath}`);
    return;
  }

  const serviceDir = path.join(homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'ai-comms-daemon.service');
  const service = `[Unit]
Description=ai-comms daemon
After=network-online.target

[Service]
ExecStart=/usr/bin/npx @quaglius/ai-comms daemon
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
  writeFileSync(servicePath, service, 'utf8');
  console.log(`Created ${servicePath} — run: systemctl --user enable --now ai-comms-daemon.service`);
}

/** Every repo already registered for this project, so the instructions block
 *  can name the ones the agent might need to ask about. */
function projectRepoNames(project: string, currentRepo: string): string[] {
  try {
    const config = loadConfig();
    const names = (config.projects[project]?.repos ?? []).map((r) => r.name);
    return [...new Set([currentRepo, ...names])];
  } catch {
    return [currentRepo];
  }
}

/** The team is whoever can reach the bus repo — never a list kept by hand. */
async function teamForBus(ownerRepo: string): Promise<string[]> {
  try {
    const [owner, repo] = ownerRepo.split('/');
    const response = await githubFetch(
      `/repos/${owner}/${repo}/collaborators?per_page=100`,
      { method: 'GET' },
    );
    if (!response.ok) return [];
    const users = (await response.json()) as Array<{ login: string }>;
    return users.map((u) => u.login);
  } catch {
    return [];
  }
}

export interface SetupOptions {
  skipDaemonOffer?: boolean;
  /** Join an existing project instead of deriving one from the repo name. */
  project?: string;
  /** Join an existing bus, as "owner/repo#issue". Required for the second and
   *  later repos of a project: without it each repo would create its own bus
   *  and the team would end up talking past each other on separate channels. */
  bus?: string;
}

/** Parse "owner/repo#123" into its parts. */
export function parseBusRef(ref: string): { fullName: string; issue: number } {
  const match = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(ref.trim());
  if (!match) {
    throw new Error(`Invalid --bus "${ref}". Expected owner/repo#issue, e.g. acme/api#42.`);
  }
  return { fullName: match[1]!, issue: Number(match[2]) };
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const remote = getGitRemote(cwd);
  const repo = repoBasename(cwd);
  const project = options.project ?? repo;
  const agent = detectAgent();

  getGitHubToken();

  const repoCommsPath = path.join(cwd, REPO_COMMS_FILENAME);
  let issue: number | null = null;
  let busFullName = remote.fullName;

  if (options.bus) {
    const ref = parseBusRef(options.bus);
    busFullName = ref.fullName;
    issue = ref.issue;
    console.log(`Joining existing bus: ${busFullName}#${issue}`);
  }

  if (existsSync(repoCommsPath)) {
    try {
      const existing = JSON.parse(readFileSync(repoCommsPath, 'utf8')) as {
        bus?: { kind: string; issue?: number };
      };
      if (existing.bus?.kind === 'github' && existing.bus.issue) {
        issue = existing.bus.issue;
        console.log(`.ai-comms.json already exists — using issue #${issue}`);
      }
    } catch {
      // regenerate below
    }
  }

  if (!issue) {
    issue = await findBusIssue(remote.fullName);
    if (!issue) {
      const create = await prompt(`No open issue with label "${BUS_LABEL}" found. Create one? [Y/n]`, 'Y');
      if (create.toLowerCase() !== 'n') {
        issue = await createBusIssue(remote.fullName);
        console.log(`Created bus issue #${issue}`);
      } else {
        throw new Error(`Cannot continue without a bus issue. Create one labeled "${BUS_LABEL}" and re-run setup.`);
      }
    } else {
      console.log(`Found bus issue #${issue}`);
    }
  }

  writeRepoComms(cwd, project, repo, busFullName, issue);
  ensureUserConfig(cwd, project, repo, agent, issue, busFullName);
  writeMcpConfig(cwd);

  const block = buildInstructionsBlock({
    project,
    repo,
    repos: projectRepoNames(project, repo),
    team: await teamForBus(busFullName),
  });
  const written = writeInstructionsToRepo(cwd, block);
  for (const file of written) {
    console.log(`Updated ${file}`);
  }

  if (!options.skipDaemonOffer) {
    await offerDaemonInstall();
  }
}
