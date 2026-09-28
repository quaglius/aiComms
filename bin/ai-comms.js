#!/usr/bin/env node
// `ai-comms hook <kind>` runs on every Claude Code prompt and has to stay
// well under Claude Code's hook timeout (docs/SPEC-v0.7.md §2.7: < 300ms).
// The full CLI (../dist/cli.js) eagerly imports commander, the daemon,
// discord.js and the MCP SDK — far more than a hook run ever touches — so
// route straight to the small dedicated entry point instead. Everything
// else, including `ai-comms hook --help`/`-h` (so commander's own help text
// keeps listing `hook`), still goes through the full CLI.
const isHookInvocation =
  process.argv[2] === 'hook' && process.argv[3] !== '--help' && process.argv[3] !== '-h';

if (isHookInvocation) {
  await import('../dist/hook-entry.js');
} else {
  await import('../dist/cli.js');
}
