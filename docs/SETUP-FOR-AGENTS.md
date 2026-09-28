# ai-comms setup — agent guide

This document is written for **you**, the AI agent configuring ai-comms for your
user. Follow the steps in order. Do not advance until you have verified the current one.

---

## v0.7 recommended path: team space (new teams)

If the user is setting ai-comms up **for a team for the first time** — no bus
repo exists yet, or the "bus repo" would otherwise just be whichever product
repo happened to run `setup` first — use the **team space** flow instead of
[Step 1](#step-1--prerequisites) below. A team space is a small, private
GitHub repo whose only job is to host the bus: nothing ties it to any one
product repo, so it works the same whether the team has one repo or twenty,
and every step is scriptable (no required prompts beyond the two optional
profile questions).

**Prerequisites:** same three checks as [Step 1](#step-1--prerequisites)
(`node --version` ≥ 20, `gh auth status` logged in). `git remote get-url
origin` is **not** required — none of these commands need to run inside a
git repo.

1. **Lead creates the space:**

   ```bash
   npx @quaglius/ai-comms space create <name> [--org <org>]
   ```

   Verify: it prints `Created private space repo <owner>/<name>` (or
   `Reusing existing space repo …` if one by that name already existed —
   confirm with the user that reuse is what they wanted), ends with
   `Diagnostics OK.` from the `doctor` run it triggers, and prints the exact
   `invite`/`join` commands to hand to the team.

2. **Lead invites teammates** (GitHub logins, not emails):

   ```bash
   npx @quaglius/ai-comms invite <login> [<login>...] --space <owner>/<name>
   ```

   Verify: each login is reported `invited` or `already a collaborator` —
   any `failed` line needs the reason resolved (e.g. a typo'd login) before
   moving on. Tell the user each invitee must **accept the GitHub
   invitation** (they'll get an email, or see it at
   `https://github.com/<owner>/<name>/invitations`) before `join` will work
   for them.

3. **Each teammate joins:**

   ```bash
   npx @quaglius/ai-comms join <owner>/<name>
   ```

   Verify: it finds the bus and presence issues, registers the project, and
   ends with `Diagnostics OK.` from `doctor`. A `not found or you have not
   accepted the invitation yet` error means step 2 isn't done yet for this
   person — do not try to work around it (e.g. by creating a second space);
   just wait for the invitation to be accepted.

4. **Anyone verifies the whole thing is wired up:**

   ```bash
   npx @quaglius/ai-comms status
   ```

   Verify: it prints the person's GitHub identity, the resolved
   project/bus, daemon state, and a **team directory** with at least the
   people who have run `join` and started their daemon (presence is
   published by the daemon — see [Step 4](#step-4--daemon)). Also verify the
   `bus_team` MCP tool returns the same directory from inside the assistant.

Configure MCP ([Step 3](#step-3--configure-mcp)) is already done for
detected assistants by `space create`/`join` themselves — only do it by hand
for an assistant that wasn't auto-detected. [Step 4](#step-4--daemon) and
[Step 6](#step-6--end-to-end-verification) still apply as written.

If the user instead wants the bus tied to a specific product repo they
already have (the v0.5 default), use the per-repo flow below.

---

## v0.5 default: GitHub bus (per product repo)

Most new setups use **GitHub as the bus** — no Discord bot, no shared token.
Identity comes from `gh auth login`.

If the user already has a **v0.4 Discord** setup, skip to
[Legacy Discord](#legacy-discord-v04) at the end — their config keeps working.

---

## Step 1 — Prerequisites

In the user's terminal, verify:

```bash
node --version          # ≥ 20
git remote get-url origin   # github.com/owner/repo
gh auth status          # logged in
```

**Verify before continuing:** all three succeed.

**If `gh auth status` fails:** run `gh auth login` — do not continue until it passes.

---

## Step 2 — Run setup (no required prompts)

Inside the project repo:

```bash
npx @quaglius/ai-comms setup
```

`setup` automatically:

- reads `origin` and repo name
- uses `gh auth token` for identity
- finds or creates an issue labeled `ai-comms-bus`
- writes `.ai-comms.json`, `.mcp.json`, and instruction blocks
- offers daemon auto-start
- runs `doctor`

Optional prompts (all have defaults): create bus issue if missing, install daemon.

**Verify:**

- `.ai-comms.json` exists with `bus.kind: "github"` — **no tokens**
- `doctor` prints `Diagnostics OK.`
- `dev` in doctor output matches the user's GitHub login

```bash
grep -i token .ai-comms.json && echo "ERROR" || echo "OK"
```

Commit `.ai-comms.json` and `.mcp.json`.

---

## Step 3 — Configure MCP

Follow [`INSTALL.md`](INSTALL.md) for the user's tool.

**Verify:** `bus_whoami` returns `dev`, `project`, `repo`, `transport`, and
`authenticated: true`.

---

## Step 4 — Daemon

Test:

```bash
npx @quaglius/ai-comms daemon
```

Publish a test claim via `bus_send` and confirm
`~/.ai-comms/projects/<project>/log.jsonl` updates.

If the user accepted daemon install during setup, verify it survives a reboot.
Otherwise, delegate OS-specific steps from [`README.md`](../README.md#run-the-daemon-permanently).

---

## Step 5 — Teammate onboarding

Teammate clones the repo and runs:

```bash
npx @quaglius/ai-comms setup
```

No `join` command — setup detects the committed `.ai-comms.json`.

**Verify:** teammate's `doctor` passes with their own GitHub `dev` and the same
bus issue.

---

## Step 6 — End-to-end verification

With two developers and daemons running:

1. **A** publishes a claim via `bus_send`.
2. **B** runs `bus_claims` and sees A's claim with the correct `repo`.
3. **B**'s `from.dev` on the claim matches A's GitHub login (not a forged slug).

---

## Optional: Discord webhook notifier

If the user wants desktop-adjacent alerts in Discord (one-way, no bot):

1. Human creates an **incoming webhook** on a channel (Integrations → Webhooks).
2. Store URL in secrets (never in chat):

```bash
# edit ~/.ai-comms/secrets.json — or use your project's secret tooling
```

3. Add to `.ai-comms.json`:

```json
"notifiers": [{ "kind": "discord-webhook", "urlRef": "secrets:<project>.discordWebhook" }]
```

**Verify:** after `bus_send`, the webhook channel shows a **single readable line**
(no ```json block).

---

## SECRETS RULE

**NEVER** ask the user to paste tokens in chat.

- **GitHub:** uses `gh` — nothing to paste for the bus.
- **Discord legacy bot token:** `ai-comms secret set <project>` (hidden prompt).
- **Discord webhook URL:** goes in `secrets.json`, not `.ai-comms.json`.

---

## Legacy Discord (v0.4)

If `.ai-comms.json` has `discord.channelId` (no `bus`), the v0.4 flow still works:

```bash
npx @quaglius/ai-comms init
npx @quaglius/ai-comms secret set <project>
npx @quaglius/ai-comms link
npx @quaglius/ai-comms doctor
```

`doctor` will warn that Discord does not authenticate identity. Suggest
`ai-comms setup` when the user is ready to migrate.

---

## Quick reference

| Command | Usage |
|---|---|
| `space create <name>` | Create (or reuse) a team space and join it — recommended for new teams |
| `invite <login...>` | Invite GitHub logins as collaborators on a space |
| `join <owner/name>` | Join an existing team space |
| `status` | Identity, project/bus, daemon, directory, unread/claims |
| `setup` | Configure the current repo for GitHub bus (per-repo flow) |
| `doctor` | Diagnostics |
| `daemon` | Poll bus and update local log |
| `mcp` | MCP stdio server |
| `init` / `link` / `secret set` | Legacy Discord only |
