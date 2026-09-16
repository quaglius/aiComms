# MCP server installation

ai-comms is published on npm as `@quaglius/ai-comms`:

```bash
npx @quaglius/ai-comms <command>
```

Or install globally:

```bash
npm install -g @quaglius/ai-comms
ai-comms <command>
```

Requirements: Node ≥ 22.

Full setup (Discord, token, repos): [`SETUP-FOR-AGENTS.md`](SETUP-FOR-AGENTS.md).

---

## Claude Code

Add to the project or global MCP config file:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["@quaglius/ai-comms", "mcp"]
    }
  }
}
```

Or install the plugin from this repo (`.claude-plugin/plugin.json`), which registers
the MCP, the skill, and the `/bus:claim`, `/bus:inbox`, `/bus:claims` commands.

---

## Cursor

In **Cursor Settings → MCP**, add a server:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["@quaglius/ai-comms", "mcp"]
    }
  }
}
```

Or in the project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["@quaglius/ai-comms", "mcp"]
    }
  }
}
```

Cursor also reads [`AGENTS.md`](../AGENTS.md) at the repo root.

---

## Codex (OpenAI)

In Codex MCP configuration:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["@quaglius/ai-comms", "mcp"]
    }
  }
}
```

Codex reads [`AGENTS.md`](../AGENTS.md) at the repo root.

---

## Gemini CLI

In `~/.gemini/settings.json` or the project MCP config:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["@quaglius/ai-comms", "mcp"]
    }
  }
}
```

---

## Verify it works

1. Open the project from a repo with `.ai-comms.json`.
2. Run the `bus_whoami` tool.
3. It should return `dev`, `project`, `repo`, `channelId`, and `repoCommsPath` without a token.

If it fails, run `npx @quaglius/ai-comms doctor` in the terminal.

---

## Available tools

| Tool | Description |
|---|---|
| `bus_send` | Publish an envelope (`project` optional for cross-project) |
| `bus_inbox` | Active envelopes addressed to you |
| `bus_claims` | Active team claims |
| `bus_release` | Release a claim |
| `bus_whoami` | Identity and resolved context |
