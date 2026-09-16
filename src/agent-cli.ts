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

export function isReadOnlyAgentSupported(agent: string): boolean {
  return agent === 'claude-code' || agent === 'cursor';
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
          args: ['-p', '--allowedTools', 'Read,Grep,Glob'],
          cwd,
          stdin: prompt,
        },
        restriction: '--allowedTools Read,Grep,Glob',
      };
    case 'cursor':
      return {
        launch: {
          command: 'cursor-agent',
          args: ['-p', '--mode', 'ask'],
          cwd,
          stdin: prompt,
        },
        restriction: '--mode ask (read-only)',
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
