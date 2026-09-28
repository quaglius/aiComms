import {
  loadConfig,
  saveConfig,
  resolveAutoAnswer,
  type ConfigV2,
} from './config.js';
import { resolveContext } from './context.js';
import { isGitHubBus, type GitHubBusConfig } from './transports/types.js';
import { githubFetch, getGitHubLogin } from './transports/github-api.js';
import {
  detectAgent,
  findBusIssue,
  createBusIssue,
  findPresenceIssue,
  resolveOrCreatePresenceIssue,
  ensureBusRepoIsPrivate,
  lockBusIssue,
  maybeUpdateProfile,
  offerDaemonInstall,
  type DaemonInstallOptions,
} from './setup.js';
import {
  registerMcpForAgents,
  type RegisterMcpOptions,
  type AgentRegistrationResult,
} from './agents-config.js';
import { installClaudeHooks, type HookInstallOptions } from './hook.js';
import { muteIssue } from './github-subscription.js';
import { fetchProfiles, renderDirectory } from './presence.js';
import {
  isDaemonRunning,
  loadLog,
  loadReadState,
  materializeActiveClaims,
  materializeInbox,
} from './store.js';
import { prompt } from './prompt.js';

/**
 * ai-comms v0.7 §3.1 — the "team space" flow: a dedicated, private GitHub
 * repo that exists only to host the bus and presence issues for a team, plus
 * the commands that create/join/invite people to it and check in on it
 * (`space create`, `invite`, `join`, `status`).
 *
 * Unlike `ai-comms setup` (src/setup.ts), none of this requires running
 * inside a git repo: the project is registered straight into
 * `~/.ai-comms/config.json`, and `resolveContext`'s §3.3 fallback (already
 * implemented in src/context.ts) is what lets the MCP/CLI find it again from
 * anywhere once the ai-comms MCP server is registered at the user level.
 */

const BUS_LABEL = 'ai-comms-bus';
const PRESENCE_LABEL = 'ai-comms-presence';

export interface GitHubApiOptions {
  token?: string;
  fetchFn?: typeof fetch;
}

/** "owner/name" -> "owner--name", the project id used for a space (spec §3.1). */
export function projectNameForSpace(ownerRepo: string): string {
  const parts = ownerRepo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid space "${ownerRepo}", expected owner/name.`);
  }
  return `${parts[0]}--${parts[1]}`;
}

/**
 * Creates the `ai-comms-bus`/`ai-comms-presence` labels on a space repo.
 * Best-effort: a 422 means the label already exists (fine); any other
 * failure (e.g. no write access) is a warning, never fatal — the bus/presence
 * issues themselves don't strictly need the label to work for the person who
 * already found them, only for `findBusIssue`/`findPresenceIssue` to find them
 * again later.
 */
async function ensureLabel(ownerRepo: string, label: string, opts: GitHubApiOptions): Promise<void> {
  const [owner, repo] = ownerRepo.split('/');
  const response = await githubFetch(
    `/repos/${owner}/${repo}/labels`,
    { method: 'POST', body: JSON.stringify({ name: label, color: '5319e7', description: 'ai-comms' }) },
    opts,
  );
  if (response.ok || response.status === 422) return;
  const text = await response.text();
  console.warn(`⚠ Could not create label "${label}" on ${ownerRepo} (${response.status}): ${text.slice(0, 200)}`);
}

interface CreateOrReuseResult {
  ownerRepo: string;
  created: boolean;
}

/**
 * Creates the space's private repo, or — if one by that name already exists
 * (422) — reuses it after checking it is actually private (spec §3.1: "si ya
 * existe (422), lo reusa pero verifica que sea privado salvo --allow-public").
 */
async function createOrReuseSpaceRepo(
  owner: string,
  repoName: string,
  login: string,
  allowPublic: boolean,
  opts: GitHubApiOptions,
): Promise<CreateOrReuseResult> {
  const ownerRepo = `${owner}/${repoName}`;
  const url = owner === login ? '/user/repos' : `/orgs/${owner}/repos`;

  const response = await githubFetch(
    url,
    {
      method: 'POST',
      body: JSON.stringify({
        name: repoName,
        private: true,
        auto_init: true,
        description: 'ai-comms team space',
        has_issues: true,
      }),
    },
    opts,
  );

  if (response.ok) {
    return { ownerRepo, created: true };
  }

  if (response.status === 422) {
    await ensureBusRepoIsPrivate(ownerRepo, allowPublic, opts);
    return { ownerRepo, created: false };
  }

  const text = await response.text();
  throw new Error(`Could not create space repo ${ownerRepo} (${response.status}): ${text.slice(0, 200)}`);
}

/**
 * Registers (or updates) a space's project entry in `~/.ai-comms/config.json`.
 *
 * `confirmDefaultChange` is what tells `create` (never asks — a brand-new
 * space is only made default when there wasn't one yet) apart from `join`
 * (asks, since joining a second team's space should not silently steal the
 * default out from under whatever project the person already uses day to
 * day) — spec §3.1.
 */
async function registerSpaceProject(
  project: string,
  ownerRepo: string,
  issue: number,
  presence: number | undefined,
  opts: { confirmDefaultChange?: boolean; promptFn?: (question: string, defaultValue?: string) => Promise<string> } = {},
): Promise<void> {
  let config: ConfigV2;
  try {
    config = loadConfig();
  } catch {
    config = { version: 2, agent: detectAgent(), defaultProject: '', projects: {} };
  }

  const bus: GitHubBusConfig =
    presence !== undefined ? { kind: 'github', repo: ownerRepo, issue, presence } : { kind: 'github', repo: ownerRepo, issue };

  const existing = config.projects[project] ?? {};
  config.projects[project] = { ...existing, bus };

  if (!config.defaultProject) {
    config.defaultProject = project;
  } else if (config.defaultProject !== project && opts.confirmDefaultChange) {
    const promptFn = opts.promptFn ?? prompt;
    const answer = await promptFn(
      `Set "${project}" as your default ai-comms project (currently "${config.defaultProject}")? [y/N]`,
      'N',
    );
    if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
      config.defaultProject = project;
    }
  }

  saveConfig(config);
}

// --- the shared "join machine" (spec §3.1: create ends by running it too) --

export interface JoinMachineOptions {
  registerMcp?: RegisterMcpOptions;
  hookInstall?: HookInstallOptions;
  daemonInstall?: DaemonInstallOptions;
  profile?: { isTTY?: boolean; promptFn?: (question: string, defaultValue?: string) => Promise<string> };
  /** Same escape hatch runSetup uses so a scripted run never blocks on the daemon prompt. */
  skipDaemonOffer?: boolean;
  /** Overrides agent detection. Tests only — production always uses detectAgent(). */
  detectAgentFn?: () => string;
  /**
   * Runs `ai-comms doctor` for the newly (re)registered project.
   *
   * Deliberately NOT imported from src/cli.ts here: cli.ts's module body ends
   * with `program.parseAsync(process.argv)` as an import side effect (see the
   * comment in src/hook.ts about the same hazard), so importing it from this
   * module — which tests import directly — would parse the test runner's own
   * argv as CLI input. cli.ts instead passes its own `runDoctor` in here when
   * it wires up the `space create`/`join` commands.
   */
  runDoctorFn?: (project: string) => Promise<number>;
}

function printMcpRegistrations(results: AgentRegistrationResult[]): void {
  console.log('\nMCP registration (user level):');
  for (const r of results) {
    console.log(`  ${r.agent}: ${r.status} (${r.detail})`);
  }
}

async function runJoinMachine(project: string, opts: JoinMachineOptions = {}): Promise<void> {
  try {
    await maybeUpdateProfile(opts.profile);
  } catch (err) {
    console.warn(`⚠ Skipping profile questions (${err instanceof Error ? err.message : String(err)}).`);
  }

  printMcpRegistrations(registerMcpForAgents(opts.registerMcp));

  const detect = opts.detectAgentFn ?? detectAgent;
  if (detect() === 'claude-code') {
    try {
      const outcome = installClaudeHooks(opts.hookInstall);
      if (outcome.failed) {
        console.warn(`⚠ ${outcome.settingsPath}: ${outcome.failed}. Run "ai-comms hooks install" after fixing it.`);
      } else if (outcome.installed.length > 0) {
        console.log(`Installed Claude Code hooks (${outcome.installed.join(', ')}) in ${outcome.settingsPath}`);
      } else {
        console.log(`Claude Code hooks already installed in ${outcome.settingsPath}`);
      }
    } catch (err) {
      console.warn(
        `⚠ Could not install Claude Code hooks (${err instanceof Error ? err.message : String(err)}). ` +
          'Run "ai-comms hooks install" later.',
      );
    }
  }

  if (!opts.skipDaemonOffer) {
    try {
      await offerDaemonInstall(opts.daemonInstall);
    } catch (err) {
      console.warn(
        `⚠ Skipping daemon install (${err instanceof Error ? err.message : String(err)}). ` +
          'Run "ai-comms setup" again later to install it.',
      );
    }
  }

  console.log(`\nDone — project "${project}" is ready. Run "ai-comms status" any time to check in.`);

  if (opts.runDoctorFn) {
    await opts.runDoctorFn(project);
  } else {
    console.log('Run "ai-comms doctor" to verify the setup.');
  }
}

// --- ai-comms space create ---------------------------------------------------

export interface SpaceCreateOptions extends GitHubApiOptions {
  org?: string;
  allowPublic?: boolean;
  joinSteps?: JoinMachineOptions;
}

export async function createSpace(nameOrOwnerRepo: string, options: SpaceCreateOptions = {}): Promise<void> {
  const apiOpts: GitHubApiOptions = { token: options.token, fetchFn: options.fetchFn };
  const login = await getGitHubLogin(apiOpts);

  let owner: string;
  let repoName: string;
  if (nameOrOwnerRepo.includes('/')) {
    const [o, r] = nameOrOwnerRepo.split('/');
    if (!o || !r) throw new Error(`Invalid space "${nameOrOwnerRepo}", expected owner/name.`);
    owner = o;
    repoName = r;
    if (options.org && options.org !== owner) {
      console.warn(`⚠ --org "${options.org}" ignored; using owner "${owner}" from "${nameOrOwnerRepo}".`);
    }
  } else {
    owner = options.org ?? login;
    repoName = nameOrOwnerRepo;
  }

  const { ownerRepo, created } = await createOrReuseSpaceRepo(owner, repoName, login, options.allowPublic ?? false, apiOpts);
  console.log(created ? `Created private space repo ${ownerRepo}` : `Reusing existing space repo ${ownerRepo}`);

  await ensureLabel(ownerRepo, BUS_LABEL, apiOpts);
  await ensureLabel(ownerRepo, PRESENCE_LABEL, apiOpts);

  let issue = await findBusIssue(ownerRepo, apiOpts);
  if (!issue) {
    issue = await createBusIssue(ownerRepo, apiOpts);
    console.log(`Created bus issue #${issue}`);
  } else {
    console.log(`Found bus issue #${issue}`);
  }
  await lockBusIssue(ownerRepo, issue, apiOpts);

  const presence = await resolveOrCreatePresenceIssue(ownerRepo, apiOpts);

  for (const n of [issue, presence]) {
    const muted = await muteIssue(ownerRepo, n, apiOpts);
    console.log(muted.ok ? `Muted notifications for ${ownerRepo}#${n}` : `⚠ ${muted.detail}`);
  }

  const project = projectNameForSpace(ownerRepo);
  await registerSpaceProject(project, ownerRepo, issue, presence);
  console.log(`Registered project "${project}" (bus ${ownerRepo}#${issue}).`);

  await runJoinMachine(project, options.joinSteps ?? {});

  console.log(`\nTeammates join with:\n  ai-comms join ${ownerRepo}`);
  console.log(`Invite them first (they must accept the GitHub invitation before that works):\n  ai-comms invite <github-login...> --space ${ownerRepo}`);
}

// --- ai-comms join -----------------------------------------------------------

export interface SpaceJoinOptions extends GitHubApiOptions {
  allowPublic?: boolean;
  joinSteps?: JoinMachineOptions;
  /** Answers the "make this my default project?" prompt when joining a second space. */
  promptFn?: (question: string, defaultValue?: string) => Promise<string>;
}

export async function joinSpace(ownerRepo: string, options: SpaceJoinOptions = {}): Promise<void> {
  const apiOpts: GitHubApiOptions = { token: options.token, fetchFn: options.fetchFn };
  const [owner, repo] = ownerRepo.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid space "${ownerRepo}", expected owner/name.`);
  }

  const repoResponse = await githubFetch(`/repos/${owner}/${repo}`, { method: 'GET' }, apiOpts);
  if (repoResponse.status === 404) {
    throw new Error(`${ownerRepo} not found or you have not accepted the invitation yet.`);
  }
  if (!repoResponse.ok) {
    const text = await repoResponse.text();
    throw new Error(`Could not read ${ownerRepo} (${repoResponse.status}): ${text.slice(0, 200)}`);
  }

  await ensureBusRepoIsPrivate(ownerRepo, options.allowPublic ?? false, apiOpts);

  const issue = await findBusIssue(ownerRepo, apiOpts);
  if (!issue) {
    throw new Error(`${ownerRepo} is not an ai-comms space; ask its owner to run "ai-comms space create".`);
  }
  console.log(`Found bus issue #${issue}`);

  const presence = await findPresenceIssue(ownerRepo, apiOpts);
  if (presence) {
    console.log(`Found presence issue #${presence}`);
  } else {
    console.warn(`⚠ No presence issue found on ${ownerRepo}; the team directory will be empty until one exists.`);
  }

  const project = projectNameForSpace(ownerRepo);
  await registerSpaceProject(project, ownerRepo, issue, presence ?? undefined, {
    confirmDefaultChange: true,
    promptFn: options.promptFn,
  });
  console.log(`Registered project "${project}" (bus ${ownerRepo}#${issue}).`);

  for (const n of [issue, presence].filter((x): x is number => x !== undefined && x !== null)) {
    const muted = await muteIssue(ownerRepo, n, apiOpts);
    console.log(muted.ok ? `Muted notifications for ${ownerRepo}#${n}` : `⚠ ${muted.detail}`);
  }

  await runJoinMachine(project, options.joinSteps ?? {});
}

// --- ai-comms invite ----------------------------------------------------------

export type InviteStatus = 'invited' | 'already-collaborator' | 'failed';

export interface InviteResult {
  login: string;
  status: InviteStatus;
  detail?: string;
}

export interface InviteOptions extends GitHubApiOptions {
  team?: string;
}

/**
 * Resolves the repo `--space` defaults to when not given: the current
 * project's bus (via `resolveContext`, which works with or without a local
 * `.ai-comms.json` — spec §3.3), falling back to `defaultProject`'s bus
 * directly for a cwd `resolveContext` can't place at all.
 */
export function resolveSpaceRepo(explicit: string | undefined, config: ConfigV2, cwd: string = process.cwd()): string {
  if (explicit) return explicit;

  try {
    const ctx = resolveContext(cwd, config);
    if (isGitHubBus(ctx.bus)) return ctx.bus.repo;
  } catch {
    // fall through to defaultProject below
  }

  const dp = config.defaultProject;
  const bus = dp ? config.projects[dp]?.bus : undefined;
  if (bus?.kind === 'github') return bus.repo;

  throw new Error('Could not determine --space (no current/default project with a GitHub bus). Pass --space owner/name.');
}

/** `PUT /repos/{o}/{r}/collaborators/{login}`, one per login (spec §3.1). */
export async function inviteToSpace(logins: string[], space: string, options: InviteOptions = {}): Promise<InviteResult[]> {
  const apiOpts: GitHubApiOptions = { token: options.token, fetchFn: options.fetchFn };
  const [owner, repo] = space.split('/');
  if (!owner || !repo) throw new Error(`Invalid --space "${space}", expected owner/name.`);

  const results: InviteResult[] = [];
  for (const login of logins) {
    try {
      const response = await githubFetch(
        `/repos/${owner}/${repo}/collaborators/${login}`,
        { method: 'PUT', body: JSON.stringify({ permission: 'push' }) },
        apiOpts,
      );
      if (response.status === 201) {
        results.push({ login, status: 'invited' });
      } else if (response.status === 204) {
        results.push({ login, status: 'already-collaborator' });
      } else {
        const text = await response.text();
        results.push({ login, status: 'failed', detail: `${response.status}: ${text.slice(0, 200)}` });
      }
    } catch (err) {
      results.push({ login, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  if (options.team) {
    const [org, slug] = options.team.split('/');
    if (!org || !slug) {
      console.warn(`⚠ Invalid --team "${options.team}", expected org/slug — skipped.`);
    } else {
      try {
        const response = await githubFetch(
          `/orgs/${org}/teams/${slug}/repos/${owner}/${repo}`,
          { method: 'PUT', body: JSON.stringify({ permission: 'push' }) },
          apiOpts,
        );
        if (response.ok) {
          console.log(`Granted team ${options.team} push access to ${space}`);
        } else {
          const text = await response.text();
          console.warn(`⚠ Could not grant team ${options.team} access to ${space} (${response.status}): ${text.slice(0, 200)}`);
        }
      } catch (err) {
        console.warn(`⚠ Could not grant team ${options.team} access to ${space}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return results;
}

// --- ai-comms status -----------------------------------------------------------

export interface StatusOptions extends GitHubApiOptions {
  project?: string;
  now?: Date;
}

/** Prints identity, project/bus, daemon state, auto-answer, the team
 *  directory, and local inbox/claims counts (spec §3.1). */
export async function runStatus(options: StatusOptions = {}): Promise<void> {
  const config = loadConfig();
  const apiOpts: GitHubApiOptions = { token: options.token, fetchFn: options.fetchFn };
  const login = await getGitHubLogin(apiOpts);

  console.log('ai-comms status\n');
  console.log(`Identity: ${login}`);

  let ctx: ReturnType<typeof resolveContext>;
  try {
    ctx = resolveContext(process.cwd(), config, { projectOverride: options.project });
  } catch (err) {
    console.log(`Project: (unresolved — ${err instanceof Error ? err.message : String(err)})`);
    return;
  }

  console.log(`Project: ${ctx.project}`);

  if (isGitHubBus(ctx.bus)) {
    const presenceSuffix = ctx.bus.presence !== undefined ? `, presence #${ctx.bus.presence}` : '';
    console.log(`Bus: ${ctx.bus.repo}#${ctx.bus.issue}${presenceSuffix}`);
  } else {
    console.log(`Bus: Discord channel ${ctx.bus.channelId}`);
  }

  console.log(`Daemon: ${isDaemonRunning(ctx.project) ? 'running' : 'not running'}`);

  const autoAnswer = resolveAutoAnswer(config.projects[ctx.project]);
  console.log(`Auto-answer: ${autoAnswer.enabled ? 'on' : 'off'}`);

  console.log('\nTeam directory:');
  if (isGitHubBus(ctx.bus) && ctx.bus.presence !== undefined) {
    const profiles = await fetchProfiles(ctx.bus, apiOpts);
    console.log(renderDirectory(profiles, options.now?.getTime()));
  } else {
    console.log('(no presence issue)');
  }

  const log = loadLog(ctx.project);
  const readState = loadReadState(ctx.project);
  const unread = materializeInbox(log, login, { unreadOnly: true, readState, now: options.now }).length;
  const claims = materializeActiveClaims(log, options.now).length;
  console.log(`\nInbox: ${unread} unread`);
  console.log(`Claims: ${claims} active`);
}
