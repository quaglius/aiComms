import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getGitRemote } from './git-remote.js';
import { getGitHubToken } from './github-auth.js';
import { githubFetch } from './transports/github-api.js';
import { getConfigPath, REPO_COMMS_FILENAME } from './paths.js';
import { loadConfig, saveConfig, type ConfigV2 } from './config.js';
import { loadRepoComms, type RepoComms } from './context.js';
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
  // Claude Code exports CLAUDECODE. CLAUDE_CODE is kept as a fallback for
  // anyone who set it by hand or from an older doc.
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return 'claude-code';
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
 * Reject a public bus repo unless the caller explicitly opted in.
 *
 * "Private by default" only holds if setup actually looks: a public repo
 * means a public bus, and anyone on GitHub — not just the team — can comment
 * on the issue and be treated as a teammate by the daemon.
 */
export async function ensureBusRepoIsPrivate(
  ownerRepo: string,
  allowPublic: boolean,
  options: { token?: string; fetchFn?: typeof fetch } = {},
): Promise<void> {
  const [owner, repo] = ownerRepo.split('/');
  const response = await githubFetch(`/repos/${owner}/${repo}`, { method: 'GET' }, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Could not check whether ${ownerRepo} is private (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as { private?: boolean };
  if (data.private === false && !allowPublic) {
    throw new Error(
      `${ownerRepo} is a public repo. Using it as the bus would make every message public, and ` +
        `anyone on GitHub could comment on the bus issue and be treated as a teammate.\n` +
        `  · Use a private repo for the bus, or\n` +
        `  · Re-run with --allow-public if that is what you want.`,
    );
  }
}

/**
 * Lock the bus issue so only people with write access to the repo can
 * comment on it. A locked issue can still be read and polled by anyone who
 * can see the repo; it just stops outsiders from posting.
 *
 * Locking can fail for a teammate who only has read access — that is not
 * fatal, since the repo being private already keeps strangers out.
 */
export async function lockBusIssue(
  ownerRepo: string,
  issue: number,
  options: { token?: string; fetchFn?: typeof fetch } = {},
): Promise<void> {
  const [owner, repo] = ownerRepo.split('/');
  try {
    const response = await githubFetch(
      `/repos/${owner}/${repo}/issues/${issue}/lock`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      options,
    );
    if (!response.ok) {
      const text = await response.text();
      console.warn(
        `⚠ Could not lock bus issue #${issue} (${response.status}): ${text.slice(0, 200)}. ` +
          `Anyone with comment access to ${ownerRepo} can still post to it.`,
      );
    }
  } catch (err) {
    console.warn(
      `⚠ Could not lock bus issue #${issue}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Anyone with comment access to ${ownerRepo} can still post to it.`,
    );
  }
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

/**
 * Write (or merge) `.mcp.json` so the ai-comms MCP server is registered.
 *
 * If the file already exists we parse it and add/replace only the
 * `mcpServers['ai-comms']` entry, so a repo that already wires up other MCP
 * servers keeps them. We do not try to preserve the original file's
 * formatting — just its content — so the output is always pretty-printed
 * JSON. If the file cannot be parsed we leave it untouched and print the
 * snippet to add by hand rather than risk clobbering something hand-edited.
 */
export function writeMcpConfig(cwd: string): void {
  const target = path.join(cwd, '.mcp.json');
  const serverEntry = {
    command: 'npx',
    args: ['-y', `@quaglius/ai-comms@${PACKAGE_VERSION}`, 'mcp'],
  };
  const snippet = JSON.stringify({ mcpServers: { 'ai-comms': serverEntry } }, null, 2);

  if (!existsSync(target)) {
    writeFileSync(target, snippet + '\n', 'utf8');
    console.log(`Created ${target} (pinned to ${PACKAGE_VERSION})`);
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    console.warn(
      `⚠ ${target} exists but is not valid JSON — left untouched. Add this to it by hand:\n${snippet}`,
    );
    return;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(
      `⚠ ${target} exists but is not a JSON object — left untouched. Add this to it by hand:\n${snippet}`,
    );
    return;
  }

  const config = raw as { mcpServers?: Record<string, unknown> };
  const hadEntry = Boolean(config.mcpServers?.['ai-comms']);
  config.mcpServers = { ...(config.mcpServers ?? {}), 'ai-comms': serverEntry };
  writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(
    hadEntry
      ? `Updated ${target} — re-pinned ai-comms to ${PACKAGE_VERSION}.`
      : `Updated ${target} — registered ai-comms (pinned to ${PACKAGE_VERSION}).`,
  );
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

  // The daemon reads the bus straight out of this file, and it only reads it
  // once at startup — a stale bus here (from a teammate who joined a
  // different repo of the same project first) would make it a) poll the
  // wrong issue and b) never see it, since it never gets rewritten. Whoever
  // runs setup last for a project wins, and they're told so.
  const newBus = { kind: 'github' as const, repo: ownerRepo, issue };
  let bus = existing.bus;
  if (!bus) {
    bus = newBus;
  } else if (bus.repo !== newBus.repo || bus.issue !== newBus.issue) {
    console.warn(
      `⚠ Project "${project}" in ${configPath} pointed to bus ${bus.repo}#${bus.issue}; ` +
        `updating it to ${newBus.repo}#${newBus.issue}. Restart the daemon so it picks this up.`,
    );
    bus = newBus;
  }

  config.projects[project] = {
    ...existing,
    bus,
    repos: filtered,
  };

  saveConfig(config, configPath);
  console.log(`Updated ${configPath}`);
}

export interface DaemonInstallOptions {
  /** Answer to the "install at login?" prompt, skipping the interactive prompt. */
  answer?: string;
  platform?: NodeJS.Platform;
  /** Runs an external command synchronously; injectable so tests never shell out. */
  execFn?: (command: string, args: string[]) => void;
  /** Overrides homedir() so tests never touch the real one. */
  home?: string;
}

function defaultExecFn(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'ignore' });
}

/**
 * Absolute node + absolute CLI script, so the service manager can find them
 * without inheriting a shell PATH. Falls back to an absolute `npx` (next to
 * the running node binary) when the resolved script lives inside an npx
 * cache directory, since those get purged and would leave the service
 * pointing at a file that no longer exists.
 */
function resolveDaemonCommand(): { command: string; args: string[] } {
  const nodeExec = process.execPath;
  const binPath = fileURLToPath(new URL('../bin/ai-comms.js', import.meta.url));

  if (!binPath.includes('_npx')) {
    return { command: nodeExec, args: [binPath, 'daemon'] };
  }

  console.log(
    'Tip: the CLI is running from an npx cache, which npm can purge at any time. ' +
      '`npm i -g @quaglius/ai-comms` is a more robust way to keep the daemon running.',
  );
  const npxName = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const npxPath = path.join(path.dirname(nodeExec), npxName);
  return { command: npxPath, args: ['-y', `@quaglius/ai-comms@${PACKAGE_VERSION}`, 'daemon'] };
}

function quoteShellArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A command line, quoted for embedding inside a VBScript double-quoted string literal. */
function vbsCommandLine(command: string, args: string[]): string {
  const quoted = [command, ...args].map(quoteShellArg).join(' ');
  return quoted.replace(/"/g, '""');
}

function installLinuxDaemon(
  home: string,
  command: string,
  args: string[],
  pathEnv: string,
  execFn: (command: string, args: string[]) => void,
): void {
  const serviceDir = path.join(home, '.config', 'systemd', 'user');
  mkdirSync(serviceDir, { recursive: true });
  const servicePath = path.join(serviceDir, 'ai-comms-daemon.service');
  const execStart = [command, ...args].map(quoteShellArg).join(' ');
  const service = `[Unit]
Description=ai-comms daemon
After=network-online.target

[Service]
Environment=PATH=${pathEnv}
ExecStart=${execStart}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
  writeFileSync(servicePath, service, 'utf8');
  console.log(`Created ${servicePath}`);

  try {
    execFn('systemctl', ['--user', 'daemon-reload']);
    execFn('systemctl', ['--user', 'enable', '--now', 'ai-comms-daemon.service']);
    console.log('Daemon installed and started (systemctl --user).');
  } catch (err) {
    console.warn(
      `⚠ Wrote ${servicePath} but could not activate it (${err instanceof Error ? err.message : String(err)}).\n` +
        `  Run manually: systemctl --user daemon-reload && systemctl --user enable --now ai-comms-daemon.service`,
    );
  }
}

function installMacDaemon(
  home: string,
  command: string,
  args: string[],
  pathEnv: string,
  execFn: (command: string, args: string[]) => void,
): void {
  const agentsDir = path.join(home, 'Library', 'LaunchAgents');
  mkdirSync(agentsDir, { recursive: true });
  const logDir = path.join(home, '.ai-comms');
  mkdirSync(logDir, { recursive: true });
  const plistPath = path.join(agentsDir, 'com.ai-comms.daemon.plist');
  const stdoutPath = path.join(logDir, 'daemon.out.log');
  const stderrPath = path.join(logDir, 'daemon.err.log');
  const programArgs = [command, ...args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ai-comms.daemon</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist, 'utf8');
  console.log(`Created ${plistPath}`);

  try {
    try {
      execFn('launchctl', ['unload', plistPath]);
    } catch {
      // Not loaded yet — fine, this is best-effort so `load` below starts clean.
    }
    execFn('launchctl', ['load', '-w', plistPath]);
    console.log('Daemon installed and loaded (launchctl).');
  } catch (err) {
    console.warn(
      `⚠ Wrote ${plistPath} but could not load it (${err instanceof Error ? err.message : String(err)}).\n` +
        `  Run manually: launchctl load -w ${plistPath}`,
    );
  }
}

function installWindowsDaemon(
  home: string,
  command: string,
  args: string[],
  execFn: (command: string, args: string[]) => void,
): void {
  const startup = path.join(
    process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
  mkdirSync(startup, { recursive: true });
  const vbsPath = path.join(startup, 'ai-comms-daemon.vbs');
  const vbs = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${vbsCommandLine(command, args)}", 0, False`,
    '',
  ].join('\r\n');
  writeFileSync(vbsPath, vbs, 'utf8');
  console.log(`Created ${vbsPath}`);

  try {
    execFn('wscript', [vbsPath]);
    console.log('Daemon started.');
  } catch (err) {
    console.warn(
      `⚠ Wrote ${vbsPath} but could not start it now (${err instanceof Error ? err.message : String(err)}).\n` +
        `  It will start at the next login, or run manually: wscript "${vbsPath}"`,
    );
  }
}

export async function offerDaemonInstall(options: DaemonInstallOptions = {}): Promise<void> {
  const answer = options.answer ?? (await prompt('Install ai-comms daemon at login? [Y/n]', 'Y'));
  if (answer.toLowerCase() === 'n') return;

  const os = options.platform ?? platform();
  const home = options.home ?? homedir();
  const execFn = options.execFn ?? defaultExecFn;

  try {
    const { command, args } = resolveDaemonCommand();
    // The daemon shells out to `gh auth token`, so `gh` has to be on PATH —
    // service managers do not inherit the interactive shell's PATH, only
    // node's own directory is guaranteed to be there otherwise.
    const pathEnv = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;

    if (os === 'win32') {
      installWindowsDaemon(home, command, args, execFn);
    } else if (os === 'darwin') {
      installMacDaemon(home, command, args, pathEnv, execFn);
    } else {
      installLinuxDaemon(home, command, args, pathEnv, execFn);
    }
  } catch (err) {
    const { command, args } = resolveDaemonCommand();
    console.warn(
      `⚠ Could not install the daemon automatically (${err instanceof Error ? err.message : String(err)}).\n` +
        `  Run it manually with: ${command} ${args.join(' ')}`,
    );
  }
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
  /** Skip the "private by default" check. Off by default on purpose: a bus on
   *  a public repo is readable and, unless locked, writable by anyone on
   *  GitHub. */
  allowPublic?: boolean;
}

/** Parse "owner/repo#123" into its parts. */
export function parseBusRef(ref: string): { fullName: string; issue: number } {
  const match = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(ref.trim());
  if (!match) {
    throw new Error(`Invalid --bus "${ref}". Expected owner/repo#issue, e.g. acme/api#42.`);
  }
  return { fullName: match[1]!, issue: Number(match[2]) };
}

interface SetupTarget {
  project: string;
  repo: string;
  busFullName: string;
  issue: number;
}

/**
 * Figure out which project/repo/bus this setup run targets.
 *
 * A committed .ai-comms.json, when present and valid, is the source of truth
 * for whoever else on the team runs setup after the first person: it names
 * the project and the bus the whole team already agreed on. Deriving those
 * from the local folder name or `origin` instead — which is what setup used
 * to do — silently forked whoever ran it onto their own project/bus (see
 * ANALISIS-v0.5 B3). Only a missing, invalid, or pre-GitHub file falls
 * through to deriving fresh values from `origin` and creates/joins a bus.
 */
async function resolveSetupTarget(
  cwd: string,
  repoCommsPath: string,
  options: SetupOptions,
): Promise<SetupTarget> {
  if (existsSync(repoCommsPath)) {
    let existing: RepoComms | null = null;
    try {
      existing = loadRepoComms(repoCommsPath);
    } catch (err) {
      console.warn(
        `⚠ ${repoCommsPath} exists but is invalid (${err instanceof Error ? err.message : String(err)}); regenerating it.`,
      );
    }

    if (existing && existing.bus?.kind !== 'github') {
      console.warn(
        `⚠ ${repoCommsPath} does not have a GitHub bus yet (legacy Discord config); regenerating it for GitHub.`,
      );
      existing = null;
    }

    if (existing && existing.bus?.kind === 'github') {
      const existingBus = existing.bus;

      if (options.project && options.project !== existing.project) {
        throw new Error(
          `--project "${options.project}" conflicts with ${repoCommsPath}, which is already project ` +
            `"${existing.project}". Remove --project to keep the committed file, or delete ` +
            `${repoCommsPath} if you really mean to move this repo to a different project.`,
        );
      }

      if (options.bus) {
        const ref = parseBusRef(options.bus);
        if (ref.fullName !== existingBus.repo || ref.issue !== existingBus.issue) {
          throw new Error(
            `--bus "${options.bus}" conflicts with ${repoCommsPath}, which already points at ` +
              `${existingBus.repo}#${existingBus.issue}. Remove --bus to keep the committed file, or ` +
              `delete ${repoCommsPath} if you really mean to switch bus.`,
          );
        }
      }

      console.log(
        `${repoCommsPath} already exists — reusing project "${existing.project}" and bus ` +
          `${existingBus.repo}#${existingBus.issue}.`,
      );
      return {
        project: existing.project,
        repo: existing.repo,
        busFullName: existingBus.repo,
        issue: existingBus.issue,
      };
    }
  }

  const remote = getGitRemote(cwd);
  const repo = remote.repo;
  const project = options.project ?? remote.repo;
  let busFullName = remote.fullName;
  let issue: number | null = null;

  if (options.bus) {
    const ref = parseBusRef(options.bus);
    busFullName = ref.fullName;
    issue = ref.issue;
    console.log(`Joining existing bus: ${busFullName}#${issue}`);
  }

  await ensureBusRepoIsPrivate(busFullName, options.allowPublic ?? false);

  if (!issue) {
    issue = await findBusIssue(busFullName);
    if (!issue) {
      const create = await prompt(`No open issue with label "${BUS_LABEL}" found. Create one? [Y/n]`, 'Y');
      if (create.toLowerCase() !== 'n') {
        issue = await createBusIssue(busFullName);
        console.log(`Created bus issue #${issue}`);
      } else {
        throw new Error(`Cannot continue without a bus issue. Create one labeled "${BUS_LABEL}" and re-run setup.`);
      }
    } else {
      console.log(`Found bus issue #${issue}`);
    }
  }

  await lockBusIssue(busFullName, issue);

  writeRepoComms(cwd, project, repo, busFullName, issue);

  return { project, repo, busFullName, issue };
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const agent = detectAgent();

  getGitHubToken();

  const repoCommsPath = path.join(cwd, REPO_COMMS_FILENAME);
  const { project, repo, busFullName, issue } = await resolveSetupTarget(cwd, repoCommsPath, options);

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
    try {
      await offerDaemonInstall();
    } catch (err) {
      // offerDaemonInstall already catches its own installer errors; this is
      // a last-resort net so a surprise (e.g. the prompt itself failing)
      // still lets doctor run afterwards instead of aborting setup.
      console.warn(
        `⚠ Skipping daemon install (${err instanceof Error ? err.message : String(err)}). ` +
          `You can install it later by running "ai-comms setup" again.`,
      );
    }
  }
}
