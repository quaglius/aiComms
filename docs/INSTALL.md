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

Requirements: Node ≥ 20, `gh` authenticated for GitHub bus setups.

Full setup: [`SETUP-FOR-AGENTS.md`](SETUP-FOR-AGENTS.md).

---

## Claude Code

Add to the project or global MCP config:

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

`ai-comms setup` writes a pinned `.mcp.json` in the repo:

```json
{
  "mcpServers": {
    "ai-comms": {
      "command": "npx",
      "args": ["-y", "@quaglius/ai-comms@0.5.0", "mcp"]
    }
  }
}
```

---

## Cursor

In **Cursor Settings → MCP**, or in `.cursor/mcp.json`:

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

1. Open a repo with `.ai-comms.json` (run `ai-comms setup` if missing).
2. Run the `bus_whoami` tool.
3. Expect `dev` (GitHub login or legacy configured slug), `project`, `repo`,
   `transport`, and `authenticated` — **no token** in the response.

If it fails, run `npx @quaglius/ai-comms doctor` in the terminal.

---

## Available tools

| Tool | Description |
|---|---|
| `bus_send` | Publish an envelope on the bus |
| `bus_inbox` | Active envelopes addressed to you |
| `bus_claims` | Active team claims |
| `bus_release` | Release a claim |
| `bus_whoami` | Identity and resolved context |
| `bus_ask` | Directed ask with blocking wait |
