# Decisions

A running log of design and architectural decisions for claude-pets, plus the reasoning behind them. New decisions go at the top.

---

## 2026-05-10 — Exit pet via HTTP, not signals

**Context:** "Exit this pet" button needs to tear down the CLI process (which owns the PTY/claude child) in addition to closing the pet window. The original approach sent SIGTERM from the Electron daemon to the CLI's pid, relying on the CLI's signal handler to run async cleanup (`finish()`). This didn't work — the CLI process stayed alive and the terminal kept running even after the pet window closed. Adding a SIGKILL fallback also failed.

**Decision:** Don't use signals. Instead, `session:exit` calls `endSession()` directly, which closes the window and tears down the session (including responding 410 to any pending inbox long-poll). The CLI's inbox loop detects the 404/410 and calls `finish()` itself.

**Why:** Signal delivery to Node processes is unreliable in this context — the CLI is in raw-mode stdin with a PTY child, and async signal handlers that `await` can silently fail to reach `process.exit`. The HTTP channel (inbox long-poll) is already established and proven reliable for CLI ↔ daemon communication. Using it for exit is consistent with the existing architecture.

**Alternatives considered:**
- SIGTERM + SIGKILL fallback timer — still didn't kill the CLI; signals appear to not be delivered reliably in this process configuration.
- Dedicated `/exit` endpoint the daemon POSTs to the CLI — unnecessary; the inbox poll already provides a persistent connection to signal through.

---

## 2026-05-07 — Per-session "allow this tool" approval

**Context:** Approving every Bash/Edit/Write call gets tedious within a single Claude turn that does many similar operations. Users wanted a "yes, and stop asking for this tool" option without granting blanket permission across sessions.

**Decision:** Add a third permission option `allow_session` shown as "2. Yes, for this session". When chosen, the daemon adds the `toolName` to a per-session `Set` (`session.sessionAllowed`); subsequent `/approve` calls for that tool short-circuit to `allow` without prompting the pet. The Set lives only in memory on the session object, so it's wiped when the terminal exits.

**Why:** Session-scoped (not repo-scoped, not global) matches our broader "one pet = one terminal" model — the trust grant doesn't leak to other terminals or persist across restarts. Keying on `toolName` is coarse but sufficient: granular per-argument allowlists would be brittle and surprising (e.g., "Bash for `ls` allowed" doesn't tell you anything about safety of `rm`).

**Caveat:** Coarse `toolName` granularity means approving Bash once allows *any* Bash for the rest of the session. Acceptable for now since pets are a personal-machine UX layer, not a security boundary — but worth revisiting if the daemon ever runs in a less-trusted context.

**Alternatives considered:**
- Persist the allowlist to disk per-cwd — rejected; same reasoning as the per-session icon decision below.
- Argument-level allowlists (e.g., approve `Bash: ls *` vs `Bash: rm *`) — too brittle and noisy to be useful at this scale.

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
