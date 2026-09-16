# ai-comms setup — agent guide

This document is written for **you**, the AI agent configuring ai-comms for your
user. Follow the steps in order. Do not advance until you have verified the current one.

---

## SECRETS RULE (read this first)

**NEVER** ask the user to paste the Discord bot token in chat,
in this thread, or in any message.

The token is loaded like this, in the user's terminal (hidden prompt):

```bash
npx @quaglius/ai-comms secret set <project>
```

Or, if installed globally:

```bash
npm install -g @quaglius/ai-comms
ai-comms secret set <project>
```

If the user pasted the token in chat anyway:

1. Tell them that token is now **compromised**.
2. Direct them to the [Discord Developer Portal](https://discord.com/developers/applications), reset the bot token, and generate a new one.
3. Load the new token with `ai-comms secret set <project>` — never via command-line argument or chat.

**Verify:** confirm you did not write the token to any repo file or in the conversation.

---

## Step 1 — Create the Discord application (delegate to human)

**You cannot do this yourself.** Ask the user to:

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Under **Bot**, create a bot and enable **MESSAGE CONTENT INTENT**.
3. Copy the **Application ID** (not the token yet).
4. Invite the bot with this URL (replace `APP_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=APP_ID&permissions=68608&scope=bot
```

`68608` = VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY.

5. Under **OAuth2 → General**, leave **Redirects** empty. It is not used.

**Verify before continuing:** the bot appears in the server member list (offline is fine).

**If it fails:** without the bot on the server, `doctor` will report "guild membership" or an inaccessible channel.

---

## Step 2 — Get the channel ID (delegate to human)

Ask the user to:

1. Enable **Developer Mode** in Discord (Settings → Advanced → Developer Mode).
2. Right-click the `#ai-bus` channel (or chosen channel) → **Copy Channel ID**.

**Verify:** the ID is a 17–20 digit number.

**If it fails:** a short ID or one with letters will make `doctor` report "Channel inaccessible".

---

## Step 3 — Install ai-comms and create identity

In the user's terminal:

```bash
npx @quaglius/ai-comms init
```

Answer the prompts:

- `dev`: user's stable slug (e.g. `ana`)
- `agent`: tool you're using (e.g. `claude-code`, `cursor`, `codex`, `gemini-cli`)
- `project`: team/project name (e.g. `acme`)
- `channelId`: the ID copied in step 2

**Verify:** `~/.ai-comms/config.json` exists with `version: 2` and **no** `token` field.

```bash
# On Unix/macOS/Git Bash:
grep -i token ~/.ai-comms/config.json && echo "ERROR: token in config" || echo "OK"
```

**If it fails:** if `init` aborts, check that Node is ≥ 22 (`node --version`).

---

## Step 4 — Load the token (hidden prompt)

```bash
npx @quaglius/ai-comms secret set <project>
```

Replace `<project>` with the name chosen in `init` (e.g. `acme`).

**Verify:** the command finishes without error. The token is in `~/.ai-comms/secrets.json`, not in the repo.

**If it fails:** "Empty token" → the user cancelled; run the command again.

---

## Step 5 — Link each repo (`link`)

In **each** project repo:

```bash
cd /path/to/repo
npx @quaglius/ai-comms link
```

- `project`: from step 3 (default: `defaultProject`)
- `repo`: repo name (default: directory basename)

**Verify:** `.ai-comms.json` was created at the repo root with `project`, `repo`, and `discord.channelId`. **No token.**

```bash
cat .ai-comms.json
```

**If it fails:** ".ai-comms.json already exists" → the repo is already linked; do not overwrite it.

Commit `.ai-comms.json` so the team can use it.

---

## Step 6 — Diagnostics (`doctor`)

From any linked repo:

```bash
npx @quaglius/ai-comms doctor
```

**Verify:** output includes:

- `Bot: <username> ✓`
- `Channel: #<name> ✓`
- `Permissions: VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY ✓`
- `Diagnostics OK.`

**If it fails:**

| Error | Action |
|---|---|
| Bot not authenticating | Invalid or reset token → run `secret set` again |
| Channel inaccessible | Wrong channelId or bot not invited |
| Missing permissions | Re-invite with `permissions=68608` or adjust channel overwrites |

---

## Step 7 — Configure the MCP server in the agent

Follow [`INSTALL.md`](INSTALL.md) for the user's tool (Claude Code, Cursor, Codex, or Gemini CLI).

**Verify:** the agent lists the `bus_whoami` tool. Run it and confirm it returns `dev`, `project`, `repo`, and `repoCommsPath`.

**If it fails:** MCP not connecting → check that `npx @quaglius/ai-comms mcp` runs without error in the terminal.

---

## Step 8 — Start the daemon

```bash
npx @quaglius/ai-comms daemon
```

Leave it running in the background (tmux, systemd, or a dedicated terminal).

**Verify:** when a test message is sent on the channel, `~/.ai-comms/projects/<project>/log.jsonl` updates.

**If it fails:** without the daemon, the inbox may be stale (the MCP warns if the log is >5 min old).

---

## Step 9 — Onboard a teammate

The teammate clones the repo (it already has `.ai-comms.json`):

```bash
npx @quaglius/ai-comms init          # identity only if no config yet
npx @quaglius/ai-comms join /path/to/repo
npx @quaglius/ai-comms secret set <project>
npx @quaglius/ai-comms doctor
```

**Verify:** `doctor` passes with their own `dev` and the same `project`/`channelId`.

**If it fails:** "Could not find .ai-comms.json" → wrong directory cloned or file not committed.

---

## Step 10 — End-to-end verification

With two devs (A and B) and the daemon running on both machines:

1. **A** publishes a claim from their repo:

   ```
   bus_send({ type: "claim", subject: "test claim", refs: { paths: ["src/test/**"], until: "<ISO+24h>" } })
   ```

2. **B** runs `bus_claims` and sees A's claim with the correct `repo`.

3. **A** runs `bus_claims` from **another repo** in the same project and sees the same thing.

**Verify:**

- The claim appears on both sides with the same `id`.
- A's `bus_send` reports `repo=<repo-name-from-cwd>`.
- Each side's `bus_whoami` shows the correct `.ai-comms.json`.

**If it fails:**

- B doesn't see the claim → B's daemon is down or token/channel is wrong.
- Wrong `repo` → missing `link` in that repo or wrong cwd.

---

## Quick reference commands

| Command | Usage |
|---|---|
| `init` | First-time setup (identity + project) |
| `link` | Create `.ai-comms.json` in the current repo |
| `join <path>` | Register a cloned repo |
| `secret set <project>` | Save token (hidden prompt) |
| `doctor [--project p]` | Full diagnostics |
| `daemon [--verbose]` | Listen on all projects |
| `mcp` | MCP stdio server |
| `inbox [--all] [--project p]` | Inbox in terminal |
| `claims [--project p]` | Active claims in terminal |
