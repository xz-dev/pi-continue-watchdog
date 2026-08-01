# Acceptance contract — pi-continue-watchdog

**Status:** Accepted by product authority (2026-08-01)  
**Project:** public English `xz-dev/pi-continue-watchdog`  
**License:** BSD-3-Clause  

This document is the human-accepted ATDD contract. Implementation must satisfy these externally observable examples. Passing tests alone do not re-authorize product changes; any behavioral change requires re-agreement here first.

---

## Story

| | |
|---|---|
| **Actor** | A human driving Pi with a main (root) agent that may open same-process child/subagent sessions |
| **Need** | Keep the main agent continuing long multi-step work after all observable agents go idle, without the human retyping “continue”, while still letting the human or AI stop auto-continue when intentionally waiting or done |
| **Value** | Reduces stalled sessions after subagents finish; makes unlock intentional and visible |
| **In scope (v1)** | Runtime lock, auto-lock on actual main user work, manual lock/unlock, main-only AI unlock tool, all-observable-idle exponential continue, config, packaging/CI/publication |
| **Out of scope (v1)** | Durable lock across reload/new/resume/restart; cross-process child coverage; depending on pi-subagents or any other plugin; replacing Pi footer; wall-clock or loop-count watchdogs (those belong to pi-watchdog) |

---

## Product surface (fixed names)

| Surface | Exact name | Who |
|---|---|---|
| Lock command | `/lock-continue-watchdog` | Human (TUI) |
| Unlock command | `/unlock-continue-watchdog` | Human (TUI) |
| Unlock tool | `unlock_continue_watchdog` | Main/root agent only |
| Unlock tool result | `Continue watchdog unlocked` | One-line model-visible result; no state dump |
| Default continue prompt | `Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.` | Model-visible custom message |
| Lock TUI notify | `Continue watchdog locked` | User-only TUI notify |
| Unlock TUI notify | `Continue watchdog unlocked` | User-only TUI notify |

Correct all accidental `cointinue` spellings; public names use `continue` only.

---

## Scope and classification rules

1. **“All agents idle”** means every **same-process, extension-loaded, observable** session known to this plugin’s process-local hub is idle. Isolated, out-of-process, or non-extension children may be absent; document this as **observable coverage**, never “all agents in the universe.”
2. **Main/root election** (process-local, no other plugin):
   - UI-bound session wins main when present.
   - Pure headless: first-bound attachment is documented best-effort main; later attachments are treated as non-main.
3. **Only main** registers and may invoke `unlock_continue_watchdog`. Non-main attachments must not expose the tool as a usable main control.
4. **Zero external-plugin dependencies.** Use only Pi public extension APIs plus this plugin’s own hub.
5. **Lock state is runtime-only** for the current process/session attachment lifecycle. Not written to disk. Not restored on reload/new/resume/restart/shutdown.

---

## Defaults and configuration

| Key | Default | Notes |
|---|---|---|
| `idleDelaySeconds` | `10` | Base delay in seconds; must be a positive finite number accepted by config validation |
| `maxRetries` | `10` | Maximum automatic continue messages per lock cycle |
| `continuePrompt` | exact default above | Configurable string; AI tool description must carry the same unlock guidance |

**Config locations and precedence** (same pattern as sibling Pi plugins):

1. Built-in defaults  
2. Global: `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` (default `~/.pi/agent/pi-continue-watchdog.json`)  
3. Trusted project only: `<cwd>/.pi/pi-continue-watchdog.json` when `ctx.isProjectTrusted()` is true  

Trusted-project fields override global field-by-field. Invalid high-precedence values must not erase valid lower-precedence values; emit bounded diagnostics. Missing files are silent.

**Retry delay formula** for attempt `N` (1-based):

```text
delaySeconds(N) = idleDelaySeconds × 2^(N - 1)
```

With defaults: 10s, 20s, 40s, … for attempts 1…`maxRetries`.

---

## State model (behavioral)

Per main ownership generation / lock cycle, at least:

| Field | Meaning |
|---|---|
| `locked` | Whether auto-continue is armed |
| `attempt` | Next automatic continue attempt index (0 after reset; after send, progress toward `maxRetries`) |
| `exhausted` | `locked && attempt` has already delivered `maxRetries` continues; no timer until reset |
| pending idle timer | One-shot timer for the current attempt; generation-guarded |

**Unconditional assignment:** manual lock/unlock and AI unlock **never** no-op on same-state. They always assign the target state and always emit the corresponding TUI notification. No “already locked/unlocked” short-circuit that suppresses notify.

**What resets attempt to 0 and clears exhaustion:**

- Actual main user-role `message_start` (auto-lock)
- Manual `/lock-continue-watchdog`

**What unlocks (`locked=false`), cancels timers, resets attempts:**

- `/unlock-continue-watchdog`
- Main AI `unlock_continue_watchdog`

**What does not auto-lock / does not reset the main cycle:**

- Merely queued main input (`input` before processing)
- Child/subagent user-role messages
- Threshold-style side effects that are not listed above

---

## Confirmed 11 acceptance examples

These eleven examples are the accepted product contract. Each is externally observable through public commands, TUI notifies, model-visible custom messages, timers, and install/CI artifacts.

### Example 1 — Actual main user message auto-locks

**Given** the main session is unlocked or already locked (any prior attempt count)  
**When** a **user-role** message actually starts processing on main (`message_start` for that user message—not mere queueing via `input`)  
**Then**

- `locked` is set to `true` (unconditionally, no prior-state check)
- attempt counter resets to `0` / cycle rearmed from the start
- child-session user messages do **not** change main lock or attempts
- merely queued (not yet started) main input does **not** lock or reset

### Example 2 — Manual lock always assigns and notifies

**Given** main is locked or unlocked  
**When** the human runs `/lock-continue-watchdog`  
**Then**

- `locked` is set to `true`
- attempts reset (new lock cycle)
- TUI notifies exactly: `Continue watchdog locked`
- same-state lock (already locked) still assigns and still notifies the same text

### Example 3 — Manual unlock and AI unlock always assign and notify

**Given** main is locked or unlocked, with or without a pending idle timer  
**When** the human runs `/unlock-continue-watchdog` **or** the main agent successfully calls `unlock_continue_watchdog`  
**Then**

- `locked` is set to `false`
- pending idle timers are cancelled
- attempts reset
- TUI notifies exactly: `Continue watchdog unlocked`
- same-state unlock (already unlocked) still assigns and still notifies the same text
- unlock notifications are user-only TUI notify, not model-context user messages
- the AI tool returns only the one-line model-visible result `Continue watchdog unlocked`, with no full state/config/details dump
- the AI tool returns Pi's `terminate: true` hint so a final standalone unlock call does not force a redundant follow-up LLM request; Pi only terminates early when every tool result in the same batch opts in

### Example 4 — Locked + all observable idle → exponential delayed continue

**Given** main is locked, not exhausted, and every observable same-process session is idle  
**When** idle remains continuous for `idleDelaySeconds × 2^(N-1)` for the current attempt `N`  
**Then** exactly one automatic continue is delivered for that attempt  

With defaults, delays for successive attempts begin **10s, 20s, 40s, …**

### Example 5 — Continue message content and safe delivery

**When** an automatic continue fires  
**Then**

- the message is a **visible non-user custom** message to **main**
- delivery uses Pi custom-message **steer** with **triggerTurn** so main reflects after the current tool batch, without cancelling in-flight tools
- model-visible text is exactly the configured `continuePrompt`, defaulting to:

  ```text
  Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.
  ```

- the AI tool description for `unlock_continue_watchdog` carries the same guidance: call unlock when intentionally waiting for the user or when all tasks are complete

### Example 6 — Activity during delay cancels and full delay restarts

**Given** a pending idle timer for the current attempt  
**When** any observable session becomes busy (e.g. `agent_start` / non-idle) before the timer fires  
**Then** that timer is cancelled and must not wake main  

**When** all observable sessions are idle again  
**Then** the **full** delay for the **same** current attempt restarts from zero  

Stale timer callbacks (wrong generation/epoch/ownership) must not wake main.

### Example 7 — Still locked after continue → next exponential attempt

**Given** an automatic continue was delivered (attempt counted)  
**When** the continued main run settles and main is still locked, and all observable sessions are idle again  
**Then** arm the next exponential attempt  

Default `maxRetries = 10` means **at most 10** automatic continue messages per lock cycle.

### Example 8 — Exhaustion after max retries

**Given** default `maxRetries = 10` and 10 automatic continues have already been delivered in this lock cycle  
**When** main remains locked and all observable sessions become idle again  
**Then**

- no further idle timer is scheduled
- state remains **locked and exhausted**
- a new **actual main user** `message_start` **or** manual `/lock-continue-watchdog` resets attempts and clears exhaustion (and keeps/sets locked as those operations require)
- unlock still works and notifies as in Example 3

### Example 9 — Runtime-only lock; clean unlocked on session lifecycle edges

**When** Pi reloads extensions, starts a new session, resumes, restarts, or shuts the attachment down  
**Then**

- lock state is **not** restored from disk
- effective state starts **unlocked**
- timers are cleaned
- no orphaned wakes after demotion/shutdown

### Example 10 — Trusted config overrides with safe fallback

**Given** global and/or trusted-project `pi-continue-watchdog.json`  
**When** valid `idleDelaySeconds`, `maxRetries`, and/or `continuePrompt` are provided  
**Then** effective config uses field-level override (trusted project over global over defaults)  

**When** values are missing, unreadable, or invalid  
**Then** retain valid lower-precedence values / defaults and emit bounded diagnostics (no crash, no silent use of nonsense numbers that would fire immediately in an unbounded way)

### Example 11 — Publication, language, packaging, CI

**Then** the shipped project:

- is public **`xz-dev/pi-continue-watchdog`**
- uses **English** for source, identifiers, default prompts, CLI/help, UI labels, errors, tests, and README
- is licensed **BSD-3-Clause**
- is **source-installable** from `master` (TypeScript entry via Pi extension manifest)
- has **packed, isolated, stock-Pi** CI/E2E covering the real plugin artifact (not only unit mocks)
- does **not** require npm publication, tags, or GitHub Releases for v1 (users track latest commits), unless product authority later expands distribution

---

## Delivery and safety invariants (cross-cutting)

| Invariant | Requirement |
|---|---|
| No tool cancellation | Continue delivery must not abort in-flight tools |
| No false “all agents” claims | Docs and diagnostics say **observable** same-process coverage |
| Generation-safe timers | `clearTimeout` alone is insufficient; callbacks check ownership/generation |
| Command demotion safety | If main demotes, stale command handlers must be inert; no reliance on command unregistration |
| Notify channel | Lock/unlock notifies are TUI user-only; they must not be injected as user-role conversation turns |
| Minimal tool context | Unlock returns only `Continue watchdog unlocked`; omit state/config/details and request `terminate: true`. The paired tool call/result remains in session history and may appear in later model context, as required by Pi/provider tool protocols. |
| No other-plugin coupling | No imports or runtime detection of pi-subagents / pi-watchdog / pi-notify |

---

## Explicit non-examples (do not implement as v1)

- Auto-unlock when the model says “done” without calling the tool  
- Inferring main from package names or foreign plugin state  
- Persisting lock in session JSON / disk  
- Counting only root idle and ignoring observable children (or the reverse)  
- Using `followUp` delivery that waits until the entire active tool flow stops if steer+triggerTurn is the accepted safe wake  
- Silent same-state lock/unlock (no TUI notify)

---

## Acceptance evidence expectations

For each example above, implementation slices must leave evidence that can be re-run:

- **Unit / component:** pure state machine, config precedence, timer cancel/restart, generation guards  
- **Integration / E2E (stock Pi, packed install):** auto-lock on real user `message_start`, command/tool notifies, at least one real timed continue path, exhaustion or multi-attempt math covered by tests (real clock or injected clock as appropriate and documented)  
- **Human accept:** product authority reviews evidence against this file; AI does not self-accept
