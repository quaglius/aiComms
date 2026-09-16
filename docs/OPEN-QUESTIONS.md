# Open questions — v0.5 conservative interpretations

## PROTOCOL.md body limit vs GitHub budget

`docs/PROTOCOL.md` still documents `body` ≤ 600 chars (Discord-era limit).
`docs/SPEC-v0.5.md` raises the send budget to 4000 chars for GitHub comments.

**Conservative choice:** implementation allows up to 4000 in the envelope schema and
render path for GitHub transport; Discord legacy keeps the 1900-char render cap and
600-char body truncation. PROTOCOL.md was not modified per spec §9.

## Discord legacy read path and identity

Section 0 requires discarding payload `from` and substituting the transport-authenticated
author. Discord legacy transport cannot authenticate comment authors.

**Conservative choice:** on read, Discord keeps the `from.dev` declared in the JSON
(unchanged v0.4 behaviour). `whoami()` and `doctor` warn that identity is not
authenticated. Only GitHub transport overrides `from.dev` on ingest.

## `team` in `.ai-comms.json`

Spec §5 says the field is accepted but ignored; recipients validate against GitHub
collaborators.

**Conservative choice:** when `bus.kind === 'github'`, `validateRecipients` uses
collaborators from the API (cached 1 h). When `bus.kind === 'discord'`, the legacy
`team` array is still used so existing v0.4 configs behave the same.

## Agent detection in `ai-comms setup`

Setup must not ask required questions; `agent` is not provided by `gh`.

**Conservative choice:** detect from `AI_COMMS_AGENT`, then common CLI environment
signals, then existing config, then default `claude-code`.

## GitHub doctor connectivity

There is no dry-run comment API.

**Conservative choice:** `doctor` checks `whoami()`, collaborator listing, and prints
the configured issue — it does not post a probe comment.
