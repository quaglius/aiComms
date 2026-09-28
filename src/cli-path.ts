import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION } from './version.js';

/**
 * How to invoke this CLI from something that does not inherit a shell PATH —
 * a service manager, a Claude Code hook.
 *
 * Absolute node + absolute `bin/ai-comms.js`. When the script lives in an npx
 * cache it can be purged at any time, so fall back to the absolute `npx` next
 * to the running node, pinned to this version. Callers append the subcommand.
 */
export function resolveCliInvocation(): { command: string; args: string[]; fromNpxCache: boolean } {
  const nodeExec = process.execPath;
  const binPath = fileURLToPath(new URL('../bin/ai-comms.js', import.meta.url));

  if (!binPath.includes('_npx')) {
    return { command: nodeExec, args: [binPath], fromNpxCache: false };
  }

  const npxName = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const npxPath = path.join(path.dirname(nodeExec), npxName);
  return {
    command: npxPath,
    args: ['-y', `@quaglius/ai-comms@${PACKAGE_VERSION}`],
    fromNpxCache: true,
  };
}

export function quoteShellArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
