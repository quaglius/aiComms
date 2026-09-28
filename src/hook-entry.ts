#!/usr/bin/env node
/**
 * Lightweight entry point for `ai-comms hook <kind>`.
 *
 * bin/ai-comms.js imports this directly instead of the full CLI (dist/cli.js,
 * built from src/cli.ts) whenever the first argument is `hook`, so a Claude
 * Code SessionStart/UserPromptSubmit hook doesn't pay for commander, the
 * daemon, discord.js and the MCP SDK on every single prompt — see
 * docs/SPEC-v0.7.md §2.7 (hook has to run in well under 300ms) and the
 * review finding that measured ~560-630ms through the full CLI vs ~110ms for
 * this file alone.
 *
 * Keep this file's own imports light: `./hook.js` (and, transitively,
 * config/context/store/envelope/paths/preamble/secrets/migrate/git-remote —
 * all `node:*` + `zod` + `ulid`) is fine; anything that pulls in
 * `./daemon.js`, `./mcp.js`, or `./transports/discord-api.js` is not, and
 * defeats the whole point of this file existing.
 *
 * Mirrors the `hook` command's action in src/cli.ts exactly (same
 * `drainStdin`, same "never fails, always exits 0" contract). That command
 * stays defined in cli.ts too — both so `ai-comms --help` still lists
 * `hook`, and as a fallback for anything that invokes dist/cli.js's `hook`
 * subcommand directly instead of going through bin/ai-comms.js.
 */
import { drainStdin, runHook } from './hook.js';

async function main(): Promise<void> {
  const kind = process.argv[3];
  await drainStdin();
  try {
    if (kind === 'session-start' || kind === 'user-prompt') {
      const output = runHook(kind, process.cwd());
      if (output) console.log(output);
    }
  } catch {
    // A hook must never break the user's prompt.
  }
  process.exitCode = 0;
}

void main();
