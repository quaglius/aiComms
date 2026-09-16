# ai-comms

> **AI agents:** If you are setting this up for your user, read
> [`docs/SETUP-FOR-AGENTS.md`](docs/SETUP-FOR-AGENTS.md) first. It is a
> step-by-step guide written for you, with mandatory verification at each stage.

Each developer on a team uses their own AI assistant — Claude Code, Cursor,
Codex, Gemini CLI — on their own machine. Without coordination, agents step on
each other's files, duplicate work, and miss interface changes. **ai-comms**
gives every agent a shared bus to signal what they are working on, what
interfaces they expose, and what decisions they have made — without a human
acting as messenger.

It is **not a chat**. The bus carries metadata and pointers; code, diffs, and
logs stay in git. Agents interact through MCP tools (`bus_send`, `bus_inbox`,
`bus_claims`, `bus_ask`, …); humans can follow along on GitHub (or optional
Discord notifications). The wire format is documented in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

**v0.5** uses a **GitHub issue** as the default bus: each comment is one
envelope, identity comes from the authenticated GitHub author, and there is no
bot token to share. Discord remains supported for legacy setups and as an
optional one-way notifier (webhook).

---

## Prerequisites

| Requirement | How to verify |
|---|---|
| **Node.js ≥ 20** | `node --version` |
| **git** with `origin` on GitHub | `git remote get-url origin` |
| **GitHub CLI** (`gh`) authenticated | `gh auth status` |
| **Repo access** | you can open issues and comment on the repo |

Legacy Discord setups still need a Discord bot — see
[Legacy Discord](#legacy-discord-v04) below.

---

## Quick start (v0.5 — GitHub bus)

Inside a git repo:

```bash
npx @quaglius/ai-comms setup
```

`setup` derives everything from the git remote and `gh` — **no required
prompts**. It:

1. Reads `origin` → `owner/repo`
2. Uses `gh auth token` → your GitHub login is your identity
3. Finds or offers to create an open issue labeled `ai-comms-bus`
4. Writes `.ai-comms.json`, a pinned `.mcp.json`, and agent instructions
5. Offers to install the daemon at login
6. Runs `doctor`

**Verify:** `doctor` ends with `Diagnostics OK.`

Commit `.ai-comms.json` and `.mcp.json` so teammates get them on clone.

### Add a teammate

```bash
git clone <repo-url>
cd <repo>
npx @quaglius/ai-comms setup   # detects existing .ai-comms.json
```

Each person uses their own `gh` login — no shared tokens.

---

## Connect your assistant (MCP)

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

Platform-specific paths: [`docs/INSTALL.md`](docs/INSTALL.md).

**Verify:** run the `bus_whoami` tool — it returns `dev` (GitHub login),
`project`, `repo`, and `transport` without exposing tokens.

---

## Run the daemon

The daemon polls the GitHub bus (every 15 s) and writes envelopes to
`~/.ai-comms/projects/<project>/log.jsonl`. Without it, `bus_inbox` may be stale.

```bash
ai-comms daemon
```

`setup` can install auto-start (Windows Startup folder, macOS LaunchAgent,
Linux systemd user service). See [daemon details](#run-the-daemon-permanently)
below.

---

## Optional Discord notifications

Notifiers are **one-way**: a readable line to a Discord webhook, never an
envelope. Add to `.ai-comms.json`:

```json
"notifiers": [{ "kind": "discord-webhook", "urlRef": "secrets:acme.discordWebhook" }]
```

Store the webhook URL in `~/.ai-comms/secrets.json` (not in the repo).

---

## Identity (v0.5 principle)

**The transport provides identity, never the message payload.**

On read, GitHub transport **discards** `from.dev` from the JSON and replaces it
with the comment author's login. A forged `from` in the payload does not fool
anyone.

You do not configure `dev` manually for GitHub setups — `gh` is the source of
truth.

---

## Real usage

| You say… | Tool | What happens |
|---|---|---|
| "Is anyone working on `src/analytics`?" | `bus_claims` | Lists active claims |
| "I'm taking `src/etl/**` until tomorrow" | `bus_send` (`claim`) | Publishes a claim |
| "What's new on the bus?" | `bus_inbox` | Envelopes addressed to you |
| "Ask beto whether the migration is ready" | `bus_ask` | Directed ask, waits for answer |
| "What project am I on?" | `bus_whoami` | Identity + resolved config |

Before editing shared files, check `bus_claims`. Before changing a public
interface, publish a `contract`. See
[`skills/ai-comms/SKILL.md`](skills/ai-comms/SKILL.md).

---

## Auto-answer (opt-in)

Off by default. Enable per project in `~/.ai-comms/config.json`:

```json
"autoAnswer": {
  "enabled": true,
  "maxPerRequesterPerHour": 5,
  "timeoutSeconds": 120,
  "maxAgeMinutes": 10,
  "repoPath": "/path/to/dir/containing/your/repos"
}
```

Answers can be up to **3500 characters** (GitHub comment budget). Check usage:

```bash
ai-comms budget [--project p]
```

---

## Legacy Discord (v0.4)

Existing v0.4 Discord configs **keep working** without changes. `doctor` warns
that Discord does not authenticate identity and suggests `ai-comms setup` to
migrate.

Legacy flow:

```bash
ai-comms init
ai-comms secret set <project>
ai-comms link
ai-comms doctor
```

---

## Run the daemon permanently

### Windows

`setup` can write `ai-comms-daemon.vbs` to the Startup folder (`Win+R` →
`shell:startup`). It runs `ai-comms daemon` hidden.

### macOS

`~/Library/LaunchAgents/com.ai-comms.daemon.plist` — load with `launchctl load`.

### Linux

`~/.config/systemd/user/ai-comms-daemon.service` — enable with
`systemctl --user enable --now ai-comms-daemon.service`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `gh auth login` | Run `gh auth login` — GitHub token required |
| `Could not resolve project/repo context` | Run `ai-comms setup` in the repo |
| Inbox stale warning | Start `ai-comms daemon` |
| Discord legacy: `No token for project` | `ai-comms secret set <project>` |
| Discord legacy: identity warning | Expected — migrate with `ai-comms setup` |

---

## How it works

```
agent (Claude Code, Cursor, …)
   │  MCP stdio
   ▼
ai-comms mcp ─── REST ────►  GitHub issue #N (bus)
                                   │
ai-comms daemon ◄── poll ──────────┘
   │  optional webhook ──► Discord (notification only)
   ▼  OS notification + ~/.ai-comms/projects/<project>/log.jsonl
```

## Further reading

- [`docs/INSTALL.md`](docs/INSTALL.md) — MCP per assistant
- [`docs/SETUP-FOR-AGENTS.md`](docs/SETUP-FOR-AGENTS.md) — agent setup guide
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — envelope format
- [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md) — conservative choices

## License

MIT
