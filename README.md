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

ai-comms uses a **GitHub issue** as the default bus: each comment is one
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

## Team space (recommended for new teams)

A **team space** is a small private GitHub repo that exists only to host the
bus — no code, no tie to any one project repo. It works from anywhere (you do
not need to be inside a git repo), because the ai-comms MCP server is
registered at the user level and `ai-comms status`/the MCP resolve your
default project on their own (spec §3.3).

**Lead — create the space once:**

```bash
npx @quaglius/ai-comms space create myteam        # personal account
npx @quaglius/ai-comms space create myteam --org acme   # under an org
```

This:

1. Creates a **private** repo (`myteam`, or `acme/myteam` with `--org`) —
   refuses to reuse a public one unless you pass `--allow-public`.
2. Creates the `ai-comms-bus`/`ai-comms-presence` labels, finds-or-creates and
   locks both issues, and mutes GitHub notifications for them.
3. Registers the project locally (`~/.ai-comms/config.json`) and makes it
   your default project if you don't have one yet.
4. Registers the `ai-comms` MCP server for every assistant it detects
   (Claude Code, Cursor, Codex, Gemini CLI), installs Claude Code hooks, and
   offers to install the daemon — then runs `doctor`.
5. Prints the exact `invite`/`join` commands for your team.

**Lead — invite teammates:**

```bash
npx @quaglius/ai-comms invite ana beto --space <owner>/myteam
```

Each invitee must **accept the GitHub invitation** (check their email or
https://github.com/<owner>/myteam/invitations) before `join` works for them.

**Teammate — join:**

```bash
npx @quaglius/ai-comms join <owner>/myteam
```

This finds the bus/presence issues by label (erroring clearly if the repo
isn't an ai-comms space, or if the invitation hasn't been accepted yet),
registers the project, mutes notifications, asks the optional profile
questions, registers the MCP server and hooks, offers the daemon, and runs
`doctor`.

**Anyone — check in:**

```bash
npx @quaglius/ai-comms status
```

Prints your GitHub identity, the resolved project/bus, whether the daemon is
running, auto-answer state, the team directory, and your unread inbox/active
claim counts.

**Privacy guarantees**, same as `setup`: the space repo is private by
default (refuse with `--allow-public` to opt out), both issues are locked so
only collaborators can post, and your own GitHub notifications for them are
muted — the bus stays a bus, not an inbox flood.

---

## Alternative: a bus inside one product repo

If you would rather keep the bus in an existing **private** product repo,
run this inside it:

```bash
npx @quaglius/ai-comms setup
```

`setup` derives everything from the git remote and `gh` — **no required
prompts**. It:

1. Reads `origin` → `owner/repo`
2. Uses `gh auth token` → your GitHub login is your identity
3. Refuses a public repo (everything on the bus would be public and anyone
   could post to it) unless you pass `--allow-public`
4. Finds or offers to create an open issue labeled `ai-comms-bus`, and locks
   it so only people with write access can post
5. Writes `.ai-comms.json`, registers ai-comms in `.mcp.json` (merged into an
   existing file), and adds agent instructions
6. Offers to install the daemon at login, and starts it
7. Runs `doctor`

**Verify:** `doctor` ends with `Diagnostics OK.`

Commit `.ai-comms.json` and `.mcp.json` so teammates get them on clone.

### Add a teammate

```bash
git clone <repo-url>
cd <repo>
npx @quaglius/ai-comms setup   # reuses the committed .ai-comms.json as is
```

Each person uses their own `gh` login — no shared tokens. A committed
`.ai-comms.json` is never rewritten by `setup`.

### Several repos, one project

The first repo creates the bus. In every other repo, join it instead of
creating a new one:

```bash
npx @quaglius/ai-comms setup --project acme --bus acme/api#42
```

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

The daemon polls the GitHub bus (every 15 s), writes envelopes to
`~/.ai-comms/projects/<project>/log.jsonl`, shows desktop notifications, and
runs auto-answer. Only one daemon runs per machine. `bus_ask` reads replies
straight from GitHub, so asking works without it; without it, `bus_inbox`
may be stale and nobody answers on your behalf while you are away.

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

## Identity

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
| "Who is on the team and who's online?" | `bus_team` | Directory: role, areas, online, auto-answer |
| "Ask beto whether the migration is ready" | `bus_ask` (`to: ["beto"]`) | Directed ask, waits for the answer |
| "Ask whoever owns the auth API how tokens refresh" | `bus_ask` (`paths: ["api/auth/**"]`) | Routed via CODEOWNERS, else profile areas |
| "Ask the architect to validate this approach" | `bus_ask` (`role: "architecture"`, `needs_human: true`) | Goes to the architect as a person, never auto-answered |
| "Follow up on that answer" | `bus_ask` (`thread: <id>`) | Continues the conversation with its history |
| "What project am I on?" | `bus_whoami` | Identity + resolved config |

`bus_ask` never asks the whole team. Without `to`, `paths` or `role` it only
resolves on its own when there is exactly one teammate; otherwise it shows the
directory so the agent can pick. If nobody who can answer is online, it
returns right away instead of blocking: the answer arrives later in
`bus_inbox`, and the Claude Code hook shows it at your next prompt.

Answers written by an agent are always marked **"not validated by <person>"**.
Only an answer the user explicitly approved (`bus_send` with
`human_approved: true`) counts as that person's word.

Before editing shared files, check `bus_claims`. Before changing a public
interface, publish a `contract`. See
[`skills/ai-comms/SKILL.md`](skills/ai-comms/SKILL.md).

---

## Your profile and the team directory

Each daemon keeps a small profile on the bus's presence issue: your role, the
areas you know best, whether auto-answer is on, and when it was last seen.
`setup` / `join` ask for role and areas (Enter skips). Change them any time:

```bash
ai-comms profile set --role architecture --areas "api/**,docs/adr/**"
ai-comms team          # the directory
ai-comms status        # identity, daemon, auto-answer, directory, pending items
```

---

## New answers inside your session (Claude Code hooks)

`setup` / `join` offer to install two Claude Code hooks (`SessionStart`,
`UserPromptSubmit`) in `~/.claude/settings.json`. They read only the local log
(no network) and, when something new arrived for you — an answer to your
question, or a question for you — add a short notice to the agent's context.

```bash
ai-comms hooks install     # or: ai-comms hooks uninstall
```

---

## Auto-answer (opt-in)

Off by default. When on, a directed question that arrives while you are away
is answered by a headless, read-only `claude -p` over your repo:

```bash
ai-comms autoanswer on [--repo-path /dir/with/your/repos]
ai-comms autoanswer off
```

What bounds it:

- It can only read files **inside the repo** (`--permission-mode dontAsk` with
  `Read(./**)`, `Grep(./**)`, `Glob(./**)`), never write, never run commands,
  and it starts with no MCP servers and no project hooks.
- Secret files are denied (`.env`, `.env.local`, keys, credentials,
  `*.tfstate`, …). `.env.example` stays readable so it can say *which*
  variables exist — never their values.
- Its output goes through a secret scanner; anything that looks like a token or
  password is published redacted.
- `needs_human` questions are never auto-answered, and every automatic answer
  is marked as not validated by you.
- A budget per requester (`maxPerRequesterPerHour`, default 5) and a freshness
  window (`maxAgeMinutes`, default 10) protect your quota.
- Follow-ups in the same thread resume the same answerer session, so it keeps
  the context of the conversation.

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
