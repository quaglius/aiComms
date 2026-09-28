import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PACKAGE_VERSION } from './version.js';

/**
 * Registers the `ai-comms` MCP server at the user level for every agent
 * detected on this machine (SPEC-v0.7 §3.2), merging into each agent's own
 * config without touching other servers already registered there.
 */
export type AgentName = 'claude-code' | 'cursor' | 'codex' | 'gemini-cli';
export type AgentRegistrationStatus = 'registered' | 'updated' | 'skipped' | 'failed';

export interface AgentRegistrationResult {
  agent: AgentName;
  status: AgentRegistrationStatus;
  detail: string;
}

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RegisterMcpOptions {
  /** Overrides `homedir()`. Tests only. */
  home?: string;
  /** Runs an external command without throwing; injectable so tests never shell out. */
  execFn?: (command: string, args: string[]) => ExecResult;
  /** Checks whether `command` is on PATH; injectable so tests never shell out. */
  which?: (command: string) => boolean;
  /** Overrides `PACKAGE_VERSION`. Tests only. */
  version?: string;
}

function defaultWhich(command: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(probe, [command], { encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function defaultExecFn(command: string, args: string[]): ExecResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    return { status: 1, stdout: result.stdout ?? '', stderr: result.stderr || String(result.error.message) };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function npxMcpEntry(version: string): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', `@quaglius/ai-comms@${version}`, 'mcp'] };
}

/**
 * Merges `{"mcpServers": {"ai-comms": ...}}` into a JSON file, preserving
 * every other key and every other registered server. Shared by Cursor's
 * `~/.cursor/mcp.json` and Gemini CLI's `~/.gemini/settings.json`, which use
 * the same shape.
 */
function mergeMcpJsonFile(
  filePath: string,
  version: string,
): { status: AgentRegistrationStatus; detail: string } {
  const entry = npxMcpEntry(version);
  let raw: unknown = {};

  if (existsSync(filePath)) {
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      return { status: 'failed', detail: `${filePath} is not valid JSON — left untouched.` };
    }
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'failed', detail: `${filePath} is not a JSON object — left untouched.` };
  }

  const obj = raw as { mcpServers?: Record<string, unknown> };
  const existing = obj.mcpServers?.['ai-comms'];
  const had = existing !== undefined;
  const already = had && JSON.stringify(existing) === JSON.stringify(entry);

  obj.mcpServers = { ...(obj.mcpServers ?? {}), 'ai-comms': entry };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');

  return { status: already ? 'skipped' : had ? 'updated' : 'registered', detail: filePath };
}

function registerClaudeCode(
  which: (command: string) => boolean,
  execFn: (command: string, args: string[]) => ExecResult,
  version: string,
): AgentRegistrationResult {
  if (!which('claude')) {
    return { agent: 'claude-code', status: 'skipped', detail: '`claude` not found on PATH' };
  }

  const manualCommand = `claude mcp add --scope user ai-comms -- npx -y @quaglius/ai-comms@${version} mcp`;
  const addArgs = ['mcp', 'add', '--scope', 'user', 'ai-comms', '--', 'npx', '-y', `@quaglius/ai-comms@${version}`, 'mcp'];

  const first = execFn('claude', addArgs);
  if (first.status === 0) {
    return { agent: 'claude-code', status: 'registered', detail: 'claude mcp add --scope user ai-comms' };
  }

  const combined = `${first.stdout}\n${first.stderr}`.toLowerCase();
  const alreadyExists =
    combined.includes('already exists') ||
    combined.includes('already configured') ||
    combined.includes('already added') ||
    combined.includes('already registered');

  if (!alreadyExists) {
    return {
      agent: 'claude-code',
      status: 'failed',
      detail: `claude mcp add failed (${(first.stderr || first.stdout).trim() || `exit ${first.status}`}). Run manually: ${manualCommand}`,
    };
  }

  const removed = execFn('claude', ['mcp', 'remove', '--scope', 'user', 'ai-comms']);
  if (removed.status !== 0) {
    return {
      agent: 'claude-code',
      status: 'failed',
      detail: `Could not replace the existing "ai-comms" MCP entry (${(removed.stderr || removed.stdout).trim()}). Run manually: ${manualCommand}`,
    };
  }

  const second = execFn('claude', addArgs);
  if (second.status === 0) {
    return { agent: 'claude-code', status: 'updated', detail: 'claude mcp remove + add --scope user ai-comms' };
  }

  return {
    agent: 'claude-code',
    status: 'failed',
    detail: `claude mcp add failed after removing the old entry (${(second.stderr || second.stdout).trim()}). Run manually: ${manualCommand}`,
  };
}

function registerCursor(home: string, version: string): AgentRegistrationResult {
  const dir = path.join(home, '.cursor');
  if (!existsSync(dir)) {
    return { agent: 'cursor', status: 'skipped', detail: `${dir} not found` };
  }
  const result = mergeMcpJsonFile(path.join(dir, 'mcp.json'), version);
  return { agent: 'cursor', ...result };
}

function registerGemini(home: string, version: string): AgentRegistrationResult {
  const dir = path.join(home, '.gemini');
  if (!existsSync(dir)) {
    return { agent: 'gemini-cli', status: 'skipped', detail: `${dir} not found` };
  }
  // Gemini CLI keys its MCP servers the same way as Cursor: {"mcpServers": {...}}.
  const result = mergeMcpJsonFile(path.join(dir, 'settings.json'), version);
  return { agent: 'gemini-cli', ...result };
}

function codexBlock(version: string): string {
  return `[mcp_servers.ai-comms]\ncommand = "npx"\nargs = ["-y", "@quaglius/ai-comms@${version}", "mcp"]\n`;
}

/**
 * Replaces (or appends) the `[mcp_servers.ai-comms]` table in a Codex
 * `config.toml`, textually — never touching any other table. Any nested
 * subtable under it (e.g. a hand-added `[mcp_servers.ai-comms.env]`) is
 * considered ours too and gets replaced along with it; the scan stops at
 * the first `[...]` header that is *not* `mcp_servers.ai-comms` itself or a
 * dotted child of it.
 */
export function upsertCodexMcpBlock(existing: string, version: string): string {
  const block = codexBlock(version);
  if (!existing) return block;

  const headerRe = /^\[mcp_servers\.ai-comms\]$/;
  const ownedRe = /^\[mcp_servers\.ai-comms[.\]]/;

  const lines = existing.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i]!.trim())) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    const needsBlankLine = existing.length > 0 && !existing.endsWith('\n\n');
    const sep = existing.endsWith('\n') ? (needsBlankLine ? '\n' : '') : '\n\n';
    return existing + sep + block;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith('[')) {
      if (ownedRe.test(trimmed)) continue;
      end = i;
      break;
    }
  }

  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const blockLines = block.replace(/\n$/, '').split('\n');
  const result = [...before, ...blockLines, ...after].join('\n');
  return result.endsWith('\n') ? result : result + '\n';
}

function registerCodex(home: string, version: string): AgentRegistrationResult {
  const dir = path.join(home, '.codex');
  if (!existsSync(dir)) {
    return { agent: 'codex', status: 'skipped', detail: `${dir} not found` };
  }

  const filePath = path.join(dir, 'config.toml');
  let existingContent = '';
  let had = false;
  if (existsSync(filePath)) {
    had = true;
    try {
      existingContent = readFileSync(filePath, 'utf8');
    } catch (err) {
      return { agent: 'codex', status: 'failed', detail: `Could not read ${filePath}: ${String(err)}` };
    }
  }

  if (existingContent.includes(codexBlock(version).trimEnd())) {
    return { agent: 'codex', status: 'skipped', detail: filePath };
  }

  const next = upsertCodexMcpBlock(existingContent, version);
  writeFileSync(filePath, next, 'utf8');
  return { agent: 'codex', status: had ? 'updated' : 'registered', detail: filePath };
}

export function registerMcpForAgents(opts: RegisterMcpOptions = {}): AgentRegistrationResult[] {
  const home = opts.home ?? homedir();
  const version = opts.version ?? PACKAGE_VERSION;
  const which = opts.which ?? defaultWhich;
  const execFn = opts.execFn ?? defaultExecFn;

  return [
    registerClaudeCode(which, execFn, version),
    registerCursor(home, version),
    registerCodex(home, version),
    registerGemini(home, version),
  ];
}
