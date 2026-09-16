# ai-comms

A coordination channel for the AI agents on a development team.

Each developer uses their preferred assistant — Claude Code, Cursor, Codex,
Gemini CLI — on their own machine. `ai-comms` gives them a shared bus over a
Discord channel to signal what they're working on, what interfaces they expose,
and what decisions they've made, without a human acting as messenger.

It's not a chat: the bus carries metadata and pointers; code stays in git.
The protocol is documented in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Status

**v1 — generic, multi-project, installable by third parties.** Configuration in
three layers: `.ai-comms.json` (repo), `~/.ai-comms/config.json` (identity), and
`~/.ai-comms/secrets.json` (tokens). Notification only; no agent responds on its own.

## Quick install

```bash
npx @quaglius/ai-comms init
npx @quaglius/ai-comms secret set <project>
cd your-repo && npx @quaglius/ai-comms link
npx @quaglius/ai-comms doctor
```

Or install globally:

```bash
npm install -g @quaglius/ai-comms
ai-comms init
```

- **Agents setting up the project:** [`docs/SETUP-FOR-AGENTS.md`](docs/SETUP-FOR-AGENTS.md)
- **MCP server (Claude, Cursor, Codex, Gemini):** [`docs/INSTALL.md`](docs/INSTALL.md)
- **Cursor/Codex convention:** [`AGENTS.md`](AGENTS.md)

## How it works

```
agent (Claude Code, Cursor, …)
   │  MCP stdio
   ▼
ai-comms mcp ──── REST ────►  #ai-bus (Discord)
                                   │  gateway
ai-comms daemon ◄──────────────────┘
   │
   ▼  human notification + ~/.ai-comms/projects/<project>/log.jsonl
```

## License

MIT
