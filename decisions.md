# Decisions

A running log of design and architectural decisions for claude-pets, plus the reasoning behind them. New decisions go at the top.

---

## 2026-05-12 — Encrypt GitHub tokens at rest with Electron safeStorage

**Context:** The Contribute Pet flow stores a GitHub OAuth token at `~/.claude-pets/github-token` as plaintext with `0o600` permissions. QA flagged this as a medium-severity security issue — any process running as the same user can read the token, and it survives in cloud backups unencrypted.

**Decision:** Use Electron's `safeStorage` API to encrypt tokens before writing and decrypt after reading. The encryption adapter is injected into `github.mjs` via a `setEncryption(encryptFn, decryptFn)` setter called from `main.js`, keeping the module testable in plain Node. If `safeStorage.isEncryptionAvailable()` returns false (some Linux configurations without a keyring daemon), fall back silently to plaintext — the `0o600` permission remains as baseline defense. Existing plaintext tokens are read transparently via a catch fallback in `loadToken()` and re-saved encrypted on next write.

**Why:** `safeStorage` is built into Electron 33 and uses the OS keychain (Keychain on macOS, DPAPI on Windows, Secret Service on Linux) — no new dependencies. The adapter pattern avoids importing `electron` in a module that's also used by the main process's dynamic import, keeping test isolation simple. The transparent migration means no user action is required to upgrade.

**Alternatives considered:**
- `keytar` npm package — adds a native dependency with its own build/compatibility issues; `safeStorage` covers the same ground with zero extra deps.
- Keep plaintext with documentation — acceptable for a local-only app, but `safeStorage` is cheap to add and meaningfully raises the bar.
- Encrypt only on macOS — inconsistent behavior across platforms; better to use the same code path everywhere and let `isEncryptionAvailable()` handle the fallback.

---

## 2026-05-12 — Configurable GitHub OAuth CLIENT_ID via environment variable

**Context:** The Contribute Pet flow hardcoded a placeholder `CLIENT_ID = 'Ov23liYourClientIdHere'` at `lib/github.mjs:7`, making the entire flow non-functional. Since the repo is open source, a real client ID can't be committed — any fork maintainer needs their own GitHub OAuth App.

**Decision:** Read `process.env.CLAUDE_PETS_GITHUB_CLIENT_ID` at module load, falling back to the placeholder. Export `isOAuthConfigured()` so the UI can detect the unconfigured state. When the placeholder is still active, the Contribute Pet button immediately shows an actionable error message ("Set CLAUDE_PETS_GITHUB_CLIENT_ID") instead of silently failing during the Device Flow.

**Why:** The env var name follows the existing `CLAUDE_PETS_*` convention (`CLAUDE_PETS_BASE`, `CLAUDE_PETS_DAEMON`). Surfacing the error in the contribute UI (rather than at startup or in logs) means users only see it when they actually try to contribute, which is the right moment. The placeholder stays in source as a sentinel value so the code always parses — `isOAuthConfigured()` is a simple string comparison, not a try/catch around a missing value.

**Alternatives considered:**
- Config file (`.claude-pets/config.json`) — adds file I/O and a new config format for a single value; env var is simpler and matches existing patterns.
- Prompt for client ID on first contribute attempt — over-engineered for a developer tool; env vars are the expected configuration surface.
- Remove the placeholder entirely and fail on missing env var — would break `import` for anyone who hasn't set the var, even if they never use the contribute flow.

---

## 2026-05-11 — Bubble resize via a visible bottom-right grip, not native window resize

**Context:** The pet bubble window is created with `resizable: false`, `frame: false`, `transparent: true` — so there was no way to resize it. Users tried dragging the corners and nothing happened. We needed a way to make long content (messages, permission summaries) more readable in-place without forcing the expand-window every time.

**Decision:** Added a visible 18×18 resize grip (diagonal-hatch background) absolutely positioned in the bottom-right of `#bubble`. On `mousedown` it captures the mouse using `screenX`/`screenY` deltas and calls the existing `window:resize` IPC (`agent.resizeWindow`). Clamped to a 240×360 minimum. `#msg-text` `max-height` is now `max(90px, calc(100vh - 450px))` so the message area grows with the window. Size is not persisted across launches — ephemeral by design.

**Why:** Native window resize doesn't work well with `transparent: true` + `frame: false` on macOS (edge hit areas are unreliable), and a visible grip gives a more discoverable affordance with a generous hit target. Reuses the same screen-coord delta pattern as the manual drag in `renderer.js` and the existing `window:resize` IPC handler — no new plumbing. Keeping it ephemeral matches the pet's "small and unobtrusive by default" stance; if a user wants a permanent larger size, the expand window is still the right tool.

**Alternatives considered:**
- `resizable: true` on the window — cheap to flip, but transparent edges don't reliably accept resize events on macOS, so the felt behavior would still be "nothing happens".
- Invisible edge hit zones — feels native but fights both the transparent window and the drag-anywhere behavior on `#dog`.
- Auto-fit to content — loses user control, and the pet-editor already uses this pattern for its own panel, so users who want manual control had no escape hatch.

---

## 2026-05-11 — Permission summary is sent in full; bubble line-clamps and offers expand

**Context:** The pre-tool-use permission hook was hard-truncating Claude's last-assistant-message summary to 117 chars + "..." before sending it to the pet. The bubble showed the resulting fragment with no way to recover the full text — for non-trivial tool calls (e.g. TaskCreate with a multi-sentence rationale), the user had to approve/deny based on a half-sentence.

**Decision:** The hook now sends the full summary. The bubble's `#summary` element line-clamps to 4 lines via `-webkit-line-clamp`, and an "expand" link button appears whenever the rendered summary overflows (detected via `scrollHeight > clientHeight`). Clicking it opens the existing expand BrowserWindow with the full summary text — same window/IPC the message section already uses.

**Why:** Truncating at the hook layer threw away information that the bubble layer can present better. CSS clamping keeps the bubble compact while preserving the full text for users who need it. Reusing the expand window avoids duplicate window infra and gives the same resize/persistence behavior already established for messages. Overflow-based detection (rather than a char-count threshold) handles edge cases where short text happens to wrap onto many lines and long text fits on few.

**Alternatives considered:**
- Keep truncation in hook, raise the limit — kicks the problem down the road; long summaries still get cut.
- Inline expand (e.g. tall scrollable summary in the bubble) — fights the small-bubble design intent already established for messages and diffs.
- Always show the expand button when summary is non-empty — visual clutter for the common case where the summary already fits.

---

## 2026-05-11 — Expand message in a separate resizable window

**Context:** The "expand" button on long messages toggled between 90px and 140px max-height inline — barely useful in the 280px-wide pet bubble. Users wanted to actually read long messages comfortably.

**Decision:** "Expand" now opens a separate framed, resizable BrowserWindow that shows the full message with markdown rendering. The window size is persisted to `~/.claude-pets/expand-window.json` and restored on the next expand. The window receives live updates when new messages arrive and auto-closes when the user starts a new task or the session ends.

**Why:** Same reasoning as the diff viewer popup — the pet bubble is intentionally small and trying to show long content inline is a bad UX tradeoff. A separate window lets the user size it to their preference. Unlike the diff viewer (which uses a fire-and-forget `data:` URL), the expand window needs a real HTML file + preload for live IPC updates as messages change. Size is saved on close only to avoid thrashing the filesystem during drag-resize.

**Alternatives considered:**
- Resize the pet window itself to show more content — fights the "pet should be small and unobtrusive" design intent.
- Use a `data:` URL like the diff viewer — can't use a preload with `data:` URLs under `contextIsolation: true`, so no IPC for live updates.

---

## 2026-05-11 — Diff viewer as a separate popup window

**Context:** The inline diff view inside the permission bubble was tiny (10px monospace, 120px max-height) and required scrolling in a cramped container. Expanding it in-place pushed the bubble past the 540px window, clipping the bottom.

**Decision:** "Show Diff" now opens a standalone Electron BrowserWindow (480x400, framed, always-on-top) positioned beside the pet. The inline diff container and all its CSS were removed.

**Why:** The pet bubble is intentionally small — trying to show meaningful code diffs inside it is a bad UX tradeoff. A separate window gives enough room for 13px monospace text with proper line wrapping, and the user can resize/reposition it independently. Consistent with how Claude Code shows diffs in a separate pane rather than inline.

**Alternatives considered:**
- Expand diff inline and auto-resize the pet window — adds layout complexity (flex containers, overflow management) and fights the "pet should be small and unobtrusive" design intent.
- Show diff in the settings/editor overlay — overloads those panels with unrelated functionality.

---

## 2026-05-11 — Manual drag replaces -webkit-app-region: drag

**Context:** macOS constrains frameless windows to the menu bar during `-webkit-app-region: drag` even with `enableLargerThanScreen: true`. The pet couldn't be dragged past the top of the screen.

**Decision:** Removed `-webkit-app-region: drag` from `#dog` and implemented manual mouse event handling (mousedown/mousemove/mouseup) that computes screen deltas and calls `BrowserWindow.setPosition()` via IPC.

**Why:** `-webkit-app-region: drag` delegates to the OS, which enforces the menu-bar constraint. Manual positioning bypasses this entirely — the app sets coordinates directly, so macOS never gets a chance to clamp them. This is the standard approach used by production Electron apps for unconstrained window dragging.

**Alternatives considered:**
- Keep `-webkit-app-region: drag` and accept the top-edge limit — user explicitly wanted the pet to go anywhere.
- Use Electron's `will-move` event to override — still constrained by the initial OS clamp.

---

## 2026-05-11 — Settings as inline disclosure, not full-page overlay

**Context:** Settings were moved to a full-page overlay (like the pet editor) in commit 9c3fb2c. This was reverted — settings are back as an inline disclosure panel inside the bubble.

**Decision:** Settings stays as a toggle panel inside the bubble, not a separate overlay.

**Why:** User preference. Settings has only 2 toggles and an End Session button — not enough content to justify a full-page takeover. The inline disclosure keeps everything in context without a mode switch.

**Alternatives considered:**
- Full-page overlay (what was reverted) — overkill for the current settings surface area.

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
