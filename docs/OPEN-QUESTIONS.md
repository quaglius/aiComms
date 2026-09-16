# Open questions

## v1

### Project with no repos in `projects` and no `.ai-comms.json`

If cwd has no `.ai-comms.json` and `projects[p].repos` is empty, v1 uses the
cwd basename as the repo name and the project's `channelId`. This allows
`doctor` and MCP without `link`, but is less explicit. Prefer always running `link`.

### Daemon with multiple tokens

If two projects use different tokens, the daemon opens one gateway client per
token. If they share a token, a single client listens on all channels.

---

# Open questions (protocol v0)

Conservative interpretations applied. They do not change the envelope schema.

## 1. "Ignore own envelopes" in the daemon

**Protocol/spec:** daemon step 3 — `from.dev === config.dev`.

**Interpretation:** skip desktop notification only. Every valid envelope is
persisted to `log.jsonl` regardless of author — the log reconstructs the full
channel, and filtering by author breaks that invariant (e.g. own claims vanish
after a cold start). MCP `bus_send` also appends locally; the daemon must not
drop duplicates on ingest. Always advance `cursor.json` so the message is not
reprocessed.

## 2. Notification sound

**Spec:** "Broadcast `fyi` notifies without sound; directed `need` and `ask`
notify with sound."

**Interpretation:** sound only if `type ∈ {need, ask}`, `to` includes the local
`dev`, and `to` does not include `*`. A `need`/`ask` with `to: ["*"]` notifies
without sound.

## 3. Truncation when envelope JSON exceeds 1900 chars

**Spec:** truncate `body` until the message fits in 1900 chars.

**Interpretation:** if with an empty `body` the message still exceeds the limit
(e.g. many `refs.paths`), use compact JSON and, as a last resort, cut the
rendered content. That cut may leave an invalid ```json block for reverse
parsing. Extreme case; in normal use truncating `body` is enough.

## 4. Detecting a down daemon (`bus_inbox`)

**Spec:** log with no writes for > 5 min and daemon not running.

**Interpretation:** use `daemon.pid` + `process.kill(pid, 0)` and `log.jsonl`
`mtime`. False positive if the bus is quiet but the daemon is alive; false
negative if the pidfile is stale.
