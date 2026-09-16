# ai-comms setup — agent guide

This document is written for **you**, the AI agent configuring ai-comms for your
user. Follow the steps in order. Do not advance until you have verified the current one.

---

## v0.5 default: GitHub bus

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
| `setup` | Configure repo for GitHub bus (default) |
| `doctor` | Diagnostics |
| `daemon` | Poll bus and update local log |
| `mcp` | MCP stdio server |
| `init` / `link` / `secret set` | Legacy Discord only |
