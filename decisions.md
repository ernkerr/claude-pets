# Decisions

A running log of design and architectural decisions for claude-pets, plus the reasoning behind them. New decisions go at the top.

---

## 2026-05-07 — Stop hook waits for transcript size to stabilize

**Context:** The Stop hook reads the last assistant message from Claude Code's transcript JSONL and posts it to the pet's speech bubble. Previous logic polled `extractLastAssistantText` 8 times × 75ms (600ms total) and broke on the first non-empty result. This raced with Claude's flush — long final messages weren't written to disk in time, so the hook would return an *earlier* assistant text snippet from the same turn instead. Reproduced in this repo: a 614-char summary was lost; the pet displayed a 92-char interstitial line.

**Decision:** Wait for the transcript file's byte size to remain unchanged for 250ms (capped at 5s total) before reading. Implemented in `hooks/stop.mjs` via `waitForStableTranscript`.

**Why:** Length-based stability is a more reliable "writer is done" signal than a fixed time budget. It scales naturally with message size without needing to guess an upper bound, and exits quickly when the file is already settled.

**Alternatives considered:**
- Bump `TRANSCRIPT_POLL_ATTEMPTS` to a larger constant — simpler but always pays the worst-case latency, even for tiny messages.
- Compare against last-posted message text and re-poll on equality — needs cross-invocation state and still needs a stop condition.

---

## 2026-05-07 — Pet identity is per-terminal, not per-repo

**Context:** Each `claude-pets` invocation already creates its own session/window, but icon configuration was persisted to disk keyed by `cwd`, so all terminals in the same repo shared an icon. User wants pets to be terminal-scoped (one pet = one terminal).

**Decision:** Store icons on the in-memory session object (`session.icon`), not in a disk-backed `petConfig` map. Color remains hashed from the repo basename so all pets in a repo share a color (intentional — visual cue that they're "from the same repo"). Removed `loadConfig`/`saveConfig` and the on-disk `pets-config.json`.

**Why:** Matches the conceptual model "pet identity = terminal session." Avoids stale disk state piling up as random sessionIds accumulate. Persistence across resume is a stretch goal — better to add it later keyed on Claude's actual resume session ID than to half-implement it now with random IDs that never restore.

**Alternatives considered:**
- Persist by sessionId — sessionIds are random per `claude-pets` invocation, so persistence would never trigger restoration. Pure disk bloat.
- Keep per-repo icon, add per-session color — minimal change, but doesn't solve the underlying "pets aren't terminal-scoped" intent.
