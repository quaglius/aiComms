import { spawn } from 'node:child_process';

export interface AgentLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  /**
   * The prompt, delivered over stdin — never as an argv element.
   *
   * The prompt carries text written by another developer's agent and arrives
   * over the network. On Windows we spawn through the shell so that `.cmd`
   * shims resolve, and anything in argv is then subject to shell parsing: a
   * crafted subject or body could break out of its argument and run arbitrary
   * commands, before any read-only restriction ever applies. Keeping argv to
   * flags we control ourselves closes that off. It also sidesteps the ~8 KB
   * Windows command-line limit, which a prompt carrying bus context can exceed.
   */
  stdin: string;
}

export interface ReadOnlyAgentSpec {
  launch: AgentLaunchSpec;
  restriction: string;
}

export interface UnsupportedAgent {
  error: string;
}

export type AgentSpecResult = ReadOnlyAgentSpec | UnsupportedAgent;

/**
 * Paths the answerer must never read.
 *
 * Read-only stops the answerer changing your repo; it does nothing to stop it
 * *disclosing*. Its reply is published to a channel, so anyone who can post an
 * ask — anyone holding the shared bot token — could otherwise ask for your
 * `.env` and read the answer off the bus. Deny rules cover Grep as well as
 * Read, so content cannot be lifted out with a search instead of an open.
 *
 * This list is deliberately broad and deliberately not configurable: a project
 * that needs one of these paths to answer a question is asking the wrong
 * question.
 *
 * `.env.*` is spelled out explicitly rather than denied with one glob: a repo
 * commits `.env.example` / `.env.sample` / `.env.template` / `.env.dist` for
 * teammates to copy, and those files carry no real secrets — denying them too
 * would make the answerer unable to tell a new teammate what env vars a
 * feature needs. Listing only the local/environment-specific variants keeps
 * those templates readable while still denying every file that could hold a
 * real value.
 *
 * SPEC v0.7 §4 verified these flags against the real `claude` 2.1.x CLI: with
 * `--permission-mode dontAsk` and `Read(./**\/)`, a read outside the cwd is
 * denied, `Read(./**\/.env.local)` in `--disallowedTools` is denied, and
 * `.env.example` is readable.
 */
const SECRET_PATH_DENIES = [
  '.env',
  '.env.local',
  '.env.*.local',
  '.env.development',
  '.env.dev',
  '.env.production',
  '.env.prod',
  '.env.staging',
  '.env.test',
  '*.env',
  'secrets*',
  '*secret*',
  '*credential*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.aws/**',
  '.ssh/**',
  '.gnupg/**',
  '.ai-comms/**',
  '*.tfstate*',
  '*.tfvars',
  'appsettings.*.json',
  'serviceAccount*.json',
  '*service-account*.json',
  '.pgpass',
  '.kube/**',
  '.docker/config.json',
  '.vault-token',
  'firebase-adminsdk*.json',
];

/**
 * Every deny, scoped under the cwd with `./**\/` so it holds regardless of
 * where inside the repo the answerer looks, and repeated for each of the
 * three read-shaped tools so a secret can't be lifted out with a search
 * instead of an open.
 */
function secretDenyRules(): string[] {
  const rules: string[] = [];
  for (const glob of SECRET_PATH_DENIES) {
    const scoped = `./**/${glob}`;
    rules.push(`Read(${scoped})`, `Grep(${scoped})`, `Glob(${scoped})`);
  }
  return rules;
}

export function isReadOnlyAgentSupported(agent: string): boolean {
  return agent === 'claude-code';
}

export interface BuildAgentSpecOptions {
  /**
   * A prior `claude` session id for this thread (`~/.ai-comms/projects/<p>/
   * answer-sessions.json`). When set, the launch resumes it with `--resume`
   * so the CLI keeps its own memory of the conversation across separate asks
   * in the same thread, on top of the thread history already in the prompt.
   */
  sessionId?: string;
}

export function buildReadOnlyAgentSpec(
  agent: string,
  prompt: string,
  cwd: string,
  options: BuildAgentSpecOptions = {},
): AgentSpecResult {
  switch (agent) {
    case 'claude-code': {
      const args = [
        '-p',
        '--permission-mode',
        'dontAsk',
        '--strict-mcp-config',
        '--setting-sources',
        'user',
        '--output-format',
        'json',
        '--allowedTools',
        'Read(./**)',
        'Grep(./**)',
        'Glob(./**)',
        '--disallowedTools',
        ...secretDenyRules(),
      ];
      if (options.sessionId) {
        args.push('--resume', options.sessionId);
      }
      return {
        launch: { command: 'claude', args, cwd, stdin: prompt },
        restriction:
          `--permission-mode dontAsk --allowedTools Read(./**),Grep(./**),Glob(./**) ` +
          `with ${SECRET_PATH_DENIES.length} secret path denies`,
      };
    }
    case 'cursor':
      // `cursor-agent --mode ask` will not write, but it exposes no way to deny
      // reads of specific paths, so a crafted question could still walk out of
      // the repo with a .env and have the answer published to the channel.
      // Not writing is not enough: the answer is broadcast. Until there is a
      // real path restriction, this agent does not answer automatically.
      return {
        error:
          'cursor-agent cannot restrict which paths are read, and auto-answers are published to ' +
          'the channel. Auto-answer stays off for this agent; asking and reading the bus still work.',
      };
    default:
      return { error: `Unsupported agent "${agent}" for read-only auto-answer` };
  }
}

/**
 * The environment the answerer runs with: ours, minus anything that ties a
 * Claude Code process to a session.
 *
 * A daemon started from a Claude Code terminal inherits that session's
 * `CLAUDE_CODE_*` variables, and `claude -p` then reuses its session id: the
 * answerer's `--resume` would continue the *user's* interactive session and
 * could quote it back onto the bus. A fresh answerer must start from nothing
 * but the repo.
 */
export function answererEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_PID') continue;
    env[key] = value;
  }
  return env;
}

export interface RunHeadlessAgentOptions {
  timeoutMs: number;
  spawnFn?: typeof spawn;
}

export function runHeadlessAgent(
  spec: AgentLaunchSpec,
  options: RunHeadlessAgentOptions,
): Promise<{ stdout: string; exitCode: number | null }> {
  const spawnFn = options.spawnFn ?? spawn;

  return new Promise((resolve, reject) => {
    // shell:true only resolves the `.cmd` shims these CLIs install on Windows.
    // It is safe here *because* argv holds nothing but our own flags — see the
    // note on AgentLaunchSpec.stdin. Never put third-party text in `args`.
    const child = spawnFn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: answererEnv(),
    });

    child.stdin?.on('error', () => {
      // the child may exit before the prompt is fully written
    });
    child.stdin?.end(spec.stdin);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const output = stdout.trim() || stderr.trim();
      resolve({ stdout: output, exitCode: code });
    });
  });
}

export interface ParsedAgentOutput {
  /** The answer text: `result` from the JSON payload, or the raw stdout. */
  text: string;
  /** `session_id` from the JSON payload, so the thread can `--resume` it next time. */
  sessionId: string | null;
  /** `is_error` from the JSON payload, or `true` when the process exited non-zero. */
  isError: boolean;
}

/**
 * `--output-format json` makes `claude -p` print `{"result": "...",
 * "session_id": "...", "is_error": false, ...}` on success. Parse that; if
 * stdout isn't JSON (a crash before the CLI could format output, a version
 * that doesn't support the flag, stderr text captured as a fallback by
 * `runHeadlessAgent`), fall back to using the raw text as the answer.
 */
export function parseAgentOutput(output: { stdout: string; exitCode: number | null }): ParsedAgentOutput {
  const raw = output.stdout.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { result?: unknown; session_id?: unknown; is_error?: unknown };
      if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string') {
        return {
          text: parsed.result,
          sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
          isError: Boolean(parsed.is_error) || output.exitCode !== 0,
        };
      }
    } catch {
      // not JSON: fall through to the raw-text fallback below
    }
  }
  return { text: raw, sessionId: null, isError: output.exitCode !== 0 };
}
