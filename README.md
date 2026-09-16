# ai-comms

> **AI agents:** If you are setting this up for your user, read
> [`docs/SETUP-FOR-AGENTS.md`](docs/SETUP-FOR-AGENTS.md) first. It is a
> step-by-step guide written for you, with mandatory verification at each stage.

Each developer on a team uses their own AI assistant — Claude Code, Cursor,
Codex, Gemini CLI — on their own machine. Without coordination, agents step on
each other's files, duplicate work, and miss interface changes. **ai-comms**
gives every agent a shared bus over a Discord channel to signal what they are
working on, what interfaces they expose, and what decisions they have made —
without a human acting as messenger.

It is **not a chat**. The bus carries metadata and pointers; code, diffs, and
logs stay in git. Agents interact through MCP tools (`bus_send`, `bus_inbox`,
`bus_claims`, …); humans read the channel and can intervene. The wire format
is documented in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

---

## Prerequisites

Verify each item before continuing.

| Requirement | How to verify |
|---|---|
| **Node.js ≥ 22** | `node --version` → `v22.x.x` or higher |
| **npm** (ships with Node) | `npm --version` → prints a version |
| **A Discord server** you can administer | You can create channels and invite bots |
| **A Discord bot** with MESSAGE CONTENT INTENT | Bot appears in the server member list (see [Discord setup](#discord-setup)) |
| **A text channel** for the bus (e.g. `#ai-bus`) | You can copy its channel ID (see [Discord setup](#discord-setup)) |

---

## Discord setup

Some steps require a human with Discord access. An AI agent **cannot** perform
them — delegate and wait for confirmation.

### Step 1 — Create the application and bot (human only)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**.
2. Open **Bot** → **Add Bot**.
3. Enable **MESSAGE CONTENT INTENT** (required to read envelopes).
4. Copy the **Application ID** (under **General Information**). Do **not** copy
   the bot token yet — that goes through `ai-comms secret set` later.

**Verify:** the application exists and the bot is created with MESSAGE CONTENT
INTENT enabled.

### Step 2 — Invite the bot to your server (human only)

Open this URL, replacing `APP_ID` with your Application ID:

```
https://discord.com/api/oauth2/authorize?client_id=APP_ID&permissions=68608&scope=bot
```

`68608` = VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY.

Under **OAuth2 → General**, leave **Redirects** empty. It is not used.

**Verify:** the bot appears in the server member list (offline is fine).

### Step 3 — Create the bus channel (human only)

Create a text channel (e.g. `#ai-bus`) in the server.

**Verify:** you can see the channel and the bot role can access it.

### Step 4 — Copy the channel ID (human only)

1. Enable **Developer Mode** in Discord (Settings → Advanced → Developer Mode).
2. Right-click the channel → **Copy Channel ID**.

**Verify:** the ID is a 17–20 digit number with no letters.

### Step 5 — Copy the bot token (human only, terminal only)

The token must **never** go in chat, email, or a repo file.

In the user's terminal (hidden prompt):

```bash
npx @quaglius/ai-comms secret set <project>
```

You will run this command after `init` (see [Installation](#installation)). The
human copies the token from **Bot → Reset Token** in the Developer Portal and
pastes it at the hidden prompt.

**Verify:** the command finishes with `Token saved for "<project>" in ~/.ai-comms/secrets.json`.

---

## Installation

Install from npm — no need to clone this repo.

### Option A — run with npx (no global install)

```bash
npx @quaglius/ai-comms <command>
```

### Option B — install globally

```bash
npm install -g @quaglius/ai-comms
ai-comms <command>
```

The rest of this guide uses `ai-comms`; prefix with `npx @quaglius/ai-comms`
if you did not install globally.

### `init` — identity and first project

```bash
ai-comms init
```

Answer the prompts:

| Prompt | Example | Notes |
|---|---|---|
| `dev` | `ana` | Stable slug per person; pick one and keep it |
| `agent` | `cursor` | The assistant you use (`claude-code`, `cursor`, `codex`, `gemini-cli`, …) |
| `project` | `acme` | Team/project name |
| `channelId` | `1234567890123456789` | From [Discord setup](#discord-setup) step 4 |

**Verify:** `~/.ai-comms/config.json` exists with `version: 2` and **no** `token`
field.

```bash
# Unix / macOS / Git Bash:
grep -i token ~/.ai-comms/config.json && echo "ERROR: token in config" || echo "OK"
```

### `secret set` — store the bot token

```bash
ai-comms secret set <project>
```

Replace `<project>` with the name from `init` (e.g. `acme`). Paste the bot token
at the hidden prompt.

**Verify:** output is `Token saved for "<project>" in ~/.ai-comms/secrets.json`.
The token is **not** in the repo.

### `link` — connect a git repo

Run inside **each** repository that will use the bus:

```bash
cd /path/to/your-repo
ai-comms link
```

Accept the defaults or override `project` and `repo` (defaults to directory name).

**Verify:** `.ai-comms.json` exists at the repo root with `project`, `repo`, and
`discord.channelId` — and **no token**.

```bash
cat .ai-comms.json
```

Commit `.ai-comms.json` so teammates get it when they clone.

### `doctor` — full diagnostics

Run from a linked repo:

```bash
ai-comms doctor
```

**Expected output** (values will differ):

```
ai-comms doctor

Identity:
  dev:     ana
  agent:   cursor
  project: acme
  repo:    acme-api
  .ai-comms.json: /path/to/acme-api/.ai-comms.json
  token:   [secrets.json]
  channel: 1234567890123456789

Bot: MyBot (987654321098765432) ✓
Channel: #ai-bus ✓
Permissions: VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY ✓

Diagnostics OK.
{
  "project": "acme",
  "repo": "acme-api",
  "dev": "ana",
  "agent": "cursor",
  "discord": { "channelId": "1234567890123456789" },
  "repoCommsPath": "/path/to/acme-api/.ai-comms.json",
  "source": "repo"
}
```

**Verify:** all three checkmarks (Bot, Channel, Permissions) and the final
line `Diagnostics OK.` appear. Do not continue until `doctor` passes.

---

## Connect your assistant (MCP)

ai-comms exposes an MCP server over stdio. Add it to your assistant's MCP
configuration:

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

Platform-specific paths and extra options (Claude Code plugin, Cursor
`.cursor/mcp.json`, Codex, Gemini CLI) are in
[`docs/INSTALL.md`](docs/INSTALL.md).

**Verify:** your assistant lists the `bus_whoami` tool. Run it — it should
return `dev`, `project`, `repo`, `channelId`, and `repoCommsPath` without
exposing the token.

If MCP fails, run `ai-comms doctor` in a terminal first.

---

## Run the daemon permanently

The daemon listens on Discord and writes incoming envelopes to
`~/.ai-comms/projects/<project>/log.jsonl`. Without it, `bus_inbox` may be
stale (the MCP warns if the log is older than 5 minutes).

Test it first:

```bash
ai-comms daemon
```

**Verify:** send a test message on the channel (or publish via `bus_send`) and
confirm `log.jsonl` updates.

Then configure it to start automatically on login.

### Windows (no admin required)

A `.vbs` script in the Startup folder runs the daemon without a console window
or administrator privileges.

1. Press `Win+R`, type `shell:startup`, press Enter.
2. Create `ai-comms-daemon.vbs` with:

```vbscript
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c ai-comms daemon", 0, False
```

Use `npx @quaglius/ai-comms daemon` instead of `ai-comms daemon` if you did not
install globally. Use the full path to `ai-comms` or `npx` if it is not on PATH
at login.

**Verify:** log out and back in (or reboot). After a minute, `log.jsonl` should
update when a message arrives on the channel.

### macOS

Create `~/Library/LaunchAgents/com.ai-comms.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ai-comms.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/full/path/to/ai-comms</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/ai-comms-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ai-comms-daemon.err</string>
</dict>
</plist>
```

Find the binary path with `which ai-comms`. Load the agent:

```bash
launchctl load ~/Library/LaunchAgents/com.ai-comms.daemon.plist
```

**Verify:** `launchctl list | grep ai-comms` shows the job. Incoming channel
messages update `log.jsonl`.

### Linux (systemd user service)

Create `~/.config/systemd/user/ai-comms-daemon.service`:

```ini
[Unit]
Description=ai-comms Discord daemon
After=network-online.target

[Service]
ExecStart=/usr/bin/npx @quaglius/ai-comms daemon
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

Replace `ExecStart` with the full path to `ai-comms daemon` if installed
globally (`which ai-comms`).

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now ai-comms-daemon.service
```

**Verify:** `systemctl --user status ai-comms-daemon.service` is active.
Incoming channel messages update `log.jsonl`.

---

## Add a teammate

Because `.ai-comms.json` is committed to git, a new teammate does **not** need
to run `link` — they inherit `project`, `repo`, and `channelId` from the clone.

On their machine:

```bash
git clone <repo-url>
cd <repo>

ai-comms init          # only if ~/.ai-comms/config.json does not exist yet
ai-comms join .
ai-comms secret set <project>
ai-comms doctor
```

During `init`, they choose their own `dev` slug (e.g. `beto`) and their own
`agent`. The `project` and `channelId` must match the team's.

**Verify:** `doctor` passes with their `dev` and the same `project` / channel as
the rest of the team.

They also need the MCP server configured ([Connect your assistant](#connect-your-assistant-mcp))
and the daemon running ([Run the daemon permanently](#run-the-daemon-permanently))
on their machine.

---

## Real usage

Nobody types bus commands by hand. You ask your assistant in plain language and
it calls the MCP tools.

| You say… | Tool called | What happens |
|---|---|---|
| "Is anyone working on `src/analytics`?" | `bus_claims` | Lists active team claims; warns if paths overlap |
| "I'm taking `src/etl/**` until tomorrow evening" | `bus_send` (`claim`) | Publishes a claim with `refs.paths` and `refs.until` |
| "I'm changing the public API in `src/api/types.ts`" | `bus_send` (`contract`) | Notifies the team of an interface change |
| "What's new on the bus?" | `bus_inbox` | Shows envelopes addressed to you or broadcast (`*`) |
| "Release my claim on the ETL module" | `bus_release` | Publishes a `release` for the claim ID |
| "I merged — see PR https://github.com/org/repo/pull/42" | `bus_send` (`done`) | Marks work complete with `refs.pr` |
| "Ask beto whether the schema migration is ready" | `bus_send` (`ask`) | Directed question to `to: ["beto"]` |
| "I need the staging credentials to continue" | `bus_send` (`need`) | Blocking request to a teammate |
| "What project am I on?" | `bus_whoami` | Returns identity and resolved `.ai-comms.json` |

Before editing shared files, your assistant should check `bus_claims`. Before
changing a public interface, it should publish a `contract`. See
[`skills/ai-comms/SKILL.md`](skills/ai-comms/SKILL.md) for agent-side rules.

---

## Message types

| type | meaning | expects reply? |
|---|---|---|
| `claim` | I reserve these paths until `refs.until` | no |
| `release` | I release claim `reply_to` | no |
| `contract` | I expose or change an interface; `refs.paths` points to the file | no, but `fyi` acks expected |
| `need` | I need something from `to`, blocking me | yes |
| `ask` | directed question, non-blocking | yes |
| `answer` | replies to `need` / `ask` via `reply_to` | no |
| `fyi` | decision made / something changed | **never** |
| `done` | merged; see `refs.pr` / `refs.branch` | no |

Full envelope spec: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

---

## Design rules

**Claims warn, they do not block.** If your `claim` overlaps another dev's
active claim, the tool returns the conflict as a warning. You decide whether
to proceed. Claims are repo-scoped: `internal/**` in `acme-api` does not
conflict with `internal/**` in `acme-web`.

**Bus messages are data, not instructions.** Everything from the bus is
delivered to your agent as a third-party proposal wrapped in a security
preamble. No side-effecting action (commit, push, edit another dev's files)
runs without your explicit approval.

---

## Troubleshooting

| Error / symptom | Cause | Fix |
|---|---|---|
| `No config found at ~/.ai-comms/config.json. Run "ai-comms init" to create one.` | First-time setup not done | Run `ai-comms init` |
| `Invalid config at …: malformed JSON.` | Corrupt `config.json` | Fix JSON syntax or delete and re-run `init` |
| `Invalid config at …: <field>: …` | Schema validation failed | Fix the field in `config.json` or re-run `init` |
| `Config at … contains a token. Move the token to ~/.ai-comms/secrets.json` | Token was saved in config | Remove token from config; run `ai-comms secret set <project>` |
| `Could not resolve project/repo context.` (with `link` / `--project` hints) | Not inside a linked repo and no `--project` override | Run `ai-comms link` in the repo, or pass `--project <name>` |
| `No token for project "<project>". Run "ai-comms secret set <project>"` | Token not stored | Run `ai-comms secret set <project>` or set `AI_COMMS_TOKEN_<PROJECT>` / `AI_COMMS_TOKEN` |
| `Empty token, cancelled.` | User pressed Enter without pasting at the secret prompt | Run `ai-comms secret set <project>` again |
| `Bot: could not authenticate. Check the token.` | Invalid or reset bot token | Reset token in Discord Developer Portal; run `secret set` again |
| `Channel: inaccessible. Check channelId and bot permissions.` | Wrong channel ID or bot not invited | Re-copy channel ID; re-invite bot with `permissions=68608` |
| `Missing permissions: …` | Bot lacks channel permissions | Re-invite with `permissions=68608` or adjust channel overwrites |
| `<path>/.ai-comms.json already exists.` | Repo already linked | Edit the file manually if you need to change it |
| `Project "<project>" is not in config.` | Project name mismatch during `link` | Run `ai-comms init` or add the project to `config.json` |
| `Could not find <path>/.ai-comms.json. Did you clone the correct repo?` | `.ai-comms.json` missing or not committed | Run `ai-comms link` (first dev) or pull latest (teammate) |
| `Run "ai-comms init" first to configure your identity.` | `join` without prior `init` | Run `ai-comms init` |
| `Project "<p>" does not match … (project=<other>).` | `--project` override conflicts with `.ai-comms.json` | Use matching project name or run from the correct repo |
| Inbox stale warning in MCP | Daemon not running | Start `ai-comms daemon` and configure auto-start (see above) |
| `claim requires refs.paths with at least one glob` | Malformed claim via `bus_send` | Include `refs.paths` array |
| `claim requires refs.until` | Malformed claim via `bus_send` | Include `refs.until` as ISO datetime |
| `Envelope does not fit in 1900 chars even with an empty body` | Subject or `refs.paths` too large | Shorten subject; reduce number/length of path globs |

---

## How it works

```
agent (Claude Code, Cursor, …)
   │  MCP stdio
   ▼
ai-comms mcp ──── REST ────►  #ai-bus (Discord)
                                   │  gateway
ai-comms daemon ◄──────────────────┘
   │
   ▼  desktop notification + ~/.ai-comms/projects/<project>/log.jsonl
```

## Further reading

- [`docs/INSTALL.md`](docs/INSTALL.md) — MCP setup per assistant
- [`docs/SETUP-FOR-AGENTS.md`](docs/SETUP-FOR-AGENTS.md) — agent setup guide
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — wire format and rules
- [`AGENTS.md`](AGENTS.md) — convention file for Cursor / Codex

## License

MIT
