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
 */
const SECRET_PATH_DENIES = [
  '**/.env',
  '**/.env.*',
  '**/*.env',
  '**/secrets*',
  '**/*secret*',
  '**/*credential*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.netrc',
  '**/.git-credentials',
  '**/.aws/**',
  '**/.ssh/**',
  '**/.gnupg/**',
  '**/.ai-comms/**',
];

function secretDenyRules(): string[] {
  const rules: string[] = [];
  for (const glob of SECRET_PATH_DENIES) {
    rules.push(`Read(${glob})`, `Grep(${glob})`, `Glob(${glob})`);
  }
  return rules;
}

export function isReadOnlyAgentSupported(agent: string): boolean {
  return agent === 'claude-code';
}

export function buildReadOnlyAgentSpec(
  agent: string,
  prompt: string,
  cwd: string,
): AgentSpecResult {
  switch (agent) {
    case 'claude-code':
      return {
        launch: {
          command: 'claude',
          args: ['-p', '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', ...secretDenyRules()],
          cwd,
          stdin: prompt,
        },
        restriction: `--allowedTools Read,Grep,Glob with ${SECRET_PATH_DENIES.length} secret path denies`,
      };
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
      env: { ...process.env },
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
