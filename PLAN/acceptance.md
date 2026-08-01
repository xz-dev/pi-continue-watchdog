# Acceptance contract — pi-continue-watchdog

**Status:** Accepted product contract for the **two-stage decision-flow** redesign (2026-08-01)
**Project:** public English `xz-dev/pi-continue-watchdog`
**License:** BSD-3-Clause

This document is the human-accepted ATDD contract. Implementation must satisfy these externally observable examples. Passing tests alone do not re-authorize product changes; any behavioral change requires re-agreement here first.

## Supersession notice (authoritative)

This contract **supersedes and rejects** the prior accepted **direct-continuation** design (idle → steer a continue custom message while a persistent always-active `unlock_continue_watchdog` tool remained in the normal tool set).

| Prior design (rejected) | Current design (required) |
|---|---|
| After idle delay, send a model-visible continue custom message and let the main agent keep its normal tools | After idle delay, **temporarily replace** active tools with exactly two decision tools, then send a **hidden** decision custom message |
| Persistent always-active unlock tool in ordinary turns | Decision tools exist **only** during the decision request window |
| Unlock result alone was the durable “stop” signal in ordinary LLM context | Valid unlock/continue **fold out** of future model-bound context via a context hook; raw session may still retain protocol records |
| Default continue prompt told the model to call unlock while continuing work | Default **decision** prompt requires exactly one decision tool and forbids prose; default **continue** prompt is a compact post-fold instruction only |

Any acceptance text, test name, README, or implementation that still requires the rejected direct-continuation path is **stale** and must not be treated as in-scope for v1 under this contract.

---

## Story

| | |
|---|---|
| **Actor** | A human driving Pi with a main (root) agent that may open same-process child/subagent sessions |
| **Need** | After all observable agents go idle, ask the main agent—using a **temporary decision-only tool set**—whether work should continue or unlock, without polluting later LLM context with the decision exchange, and without the human retyping “continue” |
| **Value** | Reduces stalled sessions after subagents finish; makes unlock intentional, reason-visible in TUI, and free of long-lived unlock-tool pollution in ordinary model context |
| **In scope (v1)** | Runtime lock; auto-lock on actual main user work; manual lock/unlock (optional reason); automatic unlock when the main run is observably aborted; temporary decision tools; decision validation + 3 re-asks; context folding + compact continue prompt; exponential idle delays; config; packaging/CI/publication |
| **Out of scope (v1)** | Durable lock across reload/new/resume/restart; cross-process child coverage; depending on pi-subagents or any other plugin; replacing Pi footer; wall-clock or loop-count watchdogs (those belong to pi-watchdog); direct idle continuation without a decision stage |

---

## Product surface (fixed names)

| Surface | Exact name / text | Who / channel |
|---|---|---|
| Lock command | `/lock-continue-watchdog` | Human (TUI) |
| Unlock command | `/unlock-continue-watchdog [reason]` | Human (TUI); reason optional |
| Continue decision tool | `continue_watchdog` | Main/root only; **decision window only**; empty/minimal args `{}` |
| Unlock decision tool | `unlock_continue_watchdog` | Main/root only; **decision window only**; required `{ reason: string }` |
| Default `decisionPrompt` | see exact default below | Hidden custom message during decision window |
| Default `continuePrompt` | `Continue until all jobs are done.` | Compact model-visible replacement after valid continue fold |
| Lock TUI notify | `Continue watchdog locked` | User-only TUI notify |
| Unlock TUI notify (no reason) | `Continue watchdog unlocked` | User-only TUI notify |
| Unlock TUI notify (with reason) | `Continue watchdog unlocked: <reason>` | User-only TUI notify |
| Decision-failed TUI warning | `Continue watchdog decision failed after 3 attempts: <last error>` | User-only TUI notify/warning |
| Main-run abort unlock | same behavior as reasonless `/unlock-continue-watchdog` | Automatic when the terminal assistant message for the settled main run has `stopReason: "aborted"` |

Correct all accidental `cointinue` spellings; public names use `continue` only.

### Exact default `decisionPrompt`

```text
This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. Decide whether work should continue. Call unlock_continue_watchdog with a concise reason if you are intentionally waiting for the user or all tasks are complete. Otherwise call continue_watchdog. Call exactly one tool and do not answer with prose.
```

### Exact default `continuePrompt`

```text
Continue until all jobs are done.
```

---

## Scope and classification rules

1. **“All agents idle”** means every **same-process, extension-loaded, observable** session known to this plugin’s process-local hub is idle. Isolated, out-of-process, or non-extension children may be absent; document this as **observable coverage**, never “all agents in the universe.”
2. **Main/root election** (process-local, no other plugin):
   - UI-bound session wins main when present.
   - Pure headless: first-bound attachment is documented best-effort main; later attachments are treated as non-main.
3. **Only main** may enter the decision window and receive decision tools. Non-main attachments must not expose decision tools as usable main controls.
4. **Zero external-plugin dependencies.** Use only Pi public extension APIs plus this plugin’s own hub.
5. **Lock state is runtime-only** for the current process/session attachment lifecycle. Not written to disk. Not restored on reload/new/resume/restart/shutdown.
6. **Abort provenance.** Pi's `agent_end` / `agent_settled` event payloads do not directly carry an abort flag, but the public read-only `ctx.sessionManager` exposes persisted session entries. Pi synthesizes and persists a terminal assistant message with `stopReason: "aborted"` for an aborted run before `agent_settled`. Capture the main branch boundary at `agent_start`; at `agent_settled`, inspect only assistant messages newly appended for that run. Unlock only when the run's terminal assistant message has `stopReason: "aborted"`. This follows the same canonical state that Pi's TUI renders as `Operation aborted`, covers standard Escape and programmatic aborts, and never infers abort from settle alone.

---

## Defaults and configuration

| Key | Default | Notes |
|---|---|---|
| `idleDelaySeconds` | `3` | Base delay in seconds; safe integer in `[1, 3600]` (timer-safe with maxRetries) |
| `maxRetries` | `10` | Maximum **valid continue** decisions per lock cycle (not invalid re-asks); safe integer in `[1, 10]` |
| `decisionPrompt` | exact default above | Hidden Pi custom-role body; explicitly identifies extension automation and says it is not a user message/request |
| `continuePrompt` | exact default above | Compact fold-in after valid continue |

**Config locations and precedence** (same pattern as sibling Pi plugins):

1. Built-in defaults
2. Global: `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` (default `~/.pi/agent/pi-continue-watchdog.json`)
3. Trusted project only: `<cwd>/.pi/pi-continue-watchdog.json` when `ctx.isProjectTrusted()` is true

Trusted-project fields override global field-by-field (`builtins < global < trusted project`). Invalid high-precedence values must not erase valid lower-precedence values; emit bounded diagnostics. Missing files are silent.

**Retry delay formula** for continue attempt `N` (1-based; advances only on **valid continue**):

```text
delaySeconds(N) = idleDelaySeconds × 2^(N - 1)
```

With defaults: 3s, 6s, 12s, 24s, … for attempts 1…`maxRetries`.

**Non-configurable:** invalid decision re-ask budget is fixed at **3** attempts (not a config key).

---

## State model (behavioral)

Per main ownership generation / lock cycle, at least:

| Field / phase | Meaning |
|---|---|
| `locked` | Whether auto decision-after-idle is armed |
| `attempt` | Next automatic decision cycle index after idle (0 after reset; advances only on **valid continue**) |
| `exhausted` | `locked` and `maxRetries` valid continues already consumed; no idle timer until reset |
| `decisionFailed` | After 3 invalid decision attempts; locked remains true; no timer until reset |
| pending idle timer | One-shot timer for the current attempt; generation-guarded |
| decision window | Temporary tool set + hidden decision prompt in flight / re-ask |

**Unconditional assignment:** manual lock/unlock **never** no-op on same-state. They always assign the target state and always emit the corresponding TUI notification. No “already locked/unlocked” short-circuit that suppresses notify.

**What resets attempt to 0, clears exhaustion and decision-failed, and (re)arms lock:**

- Actual main user-role `message_start` (auto-lock)
- Manual `/lock-continue-watchdog`

**What unlocks (`locked=false`), cancels timers, resets attempts/failures:**

- `/unlock-continue-watchdog [reason]`
- Valid decision-window `unlock_continue_watchdog({ reason })`
- A settled main run whose newly persisted terminal assistant message has `stopReason: "aborted"`; this is reasonless and must be scoped to entries added after that run's captured start boundary

**What does not auto-lock / does not reset the main cycle:**

- Merely queued main input (`input` before processing)
- Child/subagent user-role messages
- Threshold-style side effects that are not listed above
- Invalid decision re-asks (they do **not** consume exponential continue retries)

---

## Decision window protocol

### Entry

**Given** main is locked, not exhausted, not decision-failed, and every observable same-process session is idle
**When** idle remains continuous for `idleDelaySeconds × 2^(N-1)` for the current continue attempt `N`
**Then** the plugin:

1. Temporarily sets the main agent’s **active tools** to **exactly**:
   - `continue_watchdog` with empty/minimal input schema `{}`
   - `unlock_continue_watchdog` with required `reason: string`
     Tool description for unlock must say the reason is a **concise single-sentence** reason (validation rules below).
2. Sends a **hidden Pi custom-role** message—not a user-role message—whose model-visible body is the configured `decisionPrompt` (exact default above). Its default explicitly identifies the extension automation and says it is not a user message or request.
3. Does **not** send the rejected direct-continuation “keep working / call unlock while tools remain normal” message as the idle wake path.

The decision model turn **reads existing task context** already present in the session; the decision prompt does not need to restate the full task.

### Validity rules (exactly one valid decision)

A decision response is **valid** only if it contains **exactly one** accepted decision tool call and **no** prose answer requirement is violated as follows:

| Outcome | Requirements |
|---|---|
| Valid **continue** | Exactly one `continue_watchdog` call; no unlock call; no extra/unknown tools; no prose-only answer |
| Valid **unlock** | Exactly one `unlock_continue_watchdog` call with a **valid reason**; no continue call; no extra/unknown tools; no prose-only answer |

**Unlock reason validation (AI tool path):**

- After trim, reason must be **non-empty**
- Length ≤ **500 Unicode characters** (count Unicode code points / characters as implemented consistently and tested)
- May technically contain newlines
- Empty/blank or overlong reasons are **invalid**

**Invalid includes:** no tool call; both/multiple decision tools; extra or unknown tool; prose-only / no accepted tool; invalid reason.

### Invalid → re-ask (fixed 3)

On invalid decision:

1. Immediately re-ask with another hidden decision prompt.
2. The next hidden prompt includes the **exact previous error** and explains why the response was invalid.
3. Re-asks use the same temporary decision-only tool set.
4. Invalid checks **do not** consume exponential `maxRetries` continue budget.
5. After the **third** invalid attempt:
   - restore **normal** tools
   - remain **locked** and enter **decision-failed** (no idle timer)
   - TUI warning exactly:
     `Continue watchdog decision failed after 3 attempts: <last error>`
   - New actual root user `message_start` or manual `/lock-continue-watchdog` resets failures/attempts and re-arms the cycle

### Valid unlock

**When** the decision is a valid unlock:

- Restore normal tools
- Set unlocked; cancel timers; reset attempts/failures
- TUI notify exactly: `Continue watchdog unlocked: <reason>`
- Append a **persisted TUI-only** reason entry (user-visible history, not model-bound as ordinary assistant prose)
- Tool result uses Pi `terminate: true` so no further model request is required for a final standalone unlock in that batch
- **Future LLM context hook** removes the **entire** decision exchange (decision prompt, model reply, tool call(s), tool result(s)) and **inserts nothing** in its place
- Raw session may still preserve protocol records; folding is model-bound context only

### Valid continue

**When** the decision is a valid continue:

- Reasonless (no reason field required or used)
- Restore normal tools
- Work continues **immediately** (not `terminate`)
- Context hook removes the complete decision prompt / reply / tool call / results and replaces them with **one** compact custom message containing the configured `continuePrompt` (exact default: `Continue until all jobs are done.`)
- Custom tool renderer folds the continue tool call/result into **one compact TUI line** that surfaces the `continuePrompt` text
- Consumes **one** exponential retry (attempt advances)
- Next settle + all-observable-idle uses the next exponential delay
- After `maxRetries` valid continues, remain locked/exhausted with no timer until reset

### Human `/unlock-continue-watchdog [reason]`

Always assigns unlocked, cancels timers, resets attempts/failures, and notifies—even if already unlocked.

| Human reason input | TUI notify | TUI-only reason entry |
|---|---|---|
| Empty / blank / omitted | exactly `Continue watchdog unlocked` | none (no reason) |
| Nonblank | trim; **automatically truncate** to first **500** Unicode characters (may be multiline); notify `Continue watchdog unlocked: <reason>` | append TUI-only entry with that reason |

Human unlock is **not** subject to the AI decision-window invalid re-ask protocol.

---

## Confirmed acceptance examples

These examples are the accepted product contract. Each is externally observable through public commands, TUI notifies, tool registration, model-bound context after folding, timers, and install/CI artifacts.

### Example 1 — Actual main user message auto-locks

**Given** the main session is unlocked or already locked (any prior attempt, exhaustion, or decision-failed state)
**When** a **user-role** message actually starts processing on main (`message_start` for that user message—not mere queueing via `input`)
**Then**

- `locked` is set to `true` (unconditionally)
- attempt counter resets to `0`; exhaustion and decision-failed clear; cycle rearmed
- child-session user messages do **not** change main lock or attempts
- merely queued (not yet started) main input does **not** lock or reset

### Example 2 — Manual lock always assigns and notifies

**Given** main is locked or unlocked
**When** the human runs `/lock-continue-watchdog`
**Then**

- `locked` is set to `true`
- attempts reset; exhaustion and decision-failed clear (new lock cycle)
- TUI notifies exactly: `Continue watchdog locked`
- same-state lock (already locked) still assigns and still notifies the same text

### Example 3 — Manual unlock with optional reason

**Given** main is locked or unlocked, with or without a pending idle timer or decision window
**When** the human runs `/unlock-continue-watchdog` with empty/blank reason
**Then**

- unlocked; timers cancelled; attempts/failures reset
- TUI notifies exactly: `Continue watchdog unlocked`
- no TUI-only reason entry

**When** the human runs `/unlock-continue-watchdog` with a nonblank reason
**Then**

- unlocked as above
- reason is trimmed and truncated to the first 500 Unicode characters if longer
- TUI notifies exactly: `Continue watchdog unlocked: <reason>`
- a TUI-only reason entry is appended
- same-state unlock still assigns and still notifies

### Example 4 — An actually aborted main run automatically unlocks

**Given** a main run starts while the continue watchdog is locked or already unlocked, and the plugin records that run's current branch boundary
**When** the run reaches `agent_settled`
**And** the terminal assistant message among entries newly persisted after that boundary has `stopReason: "aborted"`
**Then**

- apply the same unconditional state transition as reasonless `/unlock-continue-watchdog`: unlocked; timers/decision state cancelled; attempts/failures reset; prior normal tools restored
- TUI notifies exactly `Continue watchdog unlocked`, even when already unlocked
- no unlock reason entry is appended
- process that settled run once, so no duplicate unlock notification is emitted for the same aborted message

**And when** the settled run's terminal assistant message has any non-aborted stop reason, or no new terminal assistant message is attributable to that run, the plugin does not auto-unlock.

This uses the canonical persisted `AssistantMessage.stopReason` that Pi's own TUI renders as `Operation aborted`; it does not infer abort from the existence of `agent_settled` alone and does not depend on raw Escape input.

### Example 5 — Locked + all observable idle → exponential delayed **decision entry**

**Given** main is locked, not exhausted, not decision-failed, and every observable same-process session is idle
**When** idle remains continuous for `idleDelaySeconds × 2^(N-1)` for the current attempt `N`
**Then**

- exactly one decision window is opened for that attempt (not a direct continue custom message)
- active tools are temporarily replaced with exactly `continue_watchdog` and `unlock_continue_watchdog`
- a **hidden Pi custom-role** decision message uses configured `decisionPrompt` (exact default in Product surface), identifies itself as extension automation, states it is not a user message/request, and is never injected with user role
- the rejected direct-continuation default
  `Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.`
  is **not** used as the idle wake message

With defaults, delays for successive continue attempts begin **3s, 6s, 12s, 24s, …**

### Example 6 — Valid continue: fold, compact prompt, retry consumption

**Given** a decision window is open
**When** the main agent returns a valid `continue_watchdog` decision
**Then**

- normal tools are restored
- model-bound context removes the full decision exchange and inserts one compact custom message equal to configured `continuePrompt` (default `Continue until all jobs are done.`)
- TUI shows a compact single-line rendering for the continue tool call/result including that continue prompt
- one exponential retry is consumed
- the agent continues work without `terminate` on the continue tool
- after settle, if still locked and all observable idle, the **next** exponential delay arms

### Example 7 — Valid unlock: reason notify, fold to nothing, terminate

**Given** a decision window is open
**When** the main agent returns a valid `unlock_continue_watchdog` with reason e.g. `Waiting for user confirmation on deploy.`
**Then**

- normal tools restored; unlocked; timers cancelled; attempts/failures reset
- TUI notifies exactly: `Continue watchdog unlocked: Waiting for user confirmation on deploy.`
- TUI-only reason entry appended
- tool returns with `terminate: true` (no further model request for a final standalone unlock batch)
- future model-bound context removes the entire decision exchange and inserts **nothing**
- raw session may still contain protocol tool records

### Example 8 — Invalid decision re-asks then decision-failed

**Given** a decision window is open
**When** the model responds invalidly (no tool, both tools, unknown tool, prose-only, empty reason, reason > 500 Unicode characters)
**Then**

- immediately re-ask with a hidden prompt that includes the exact previous error and explains invalidity
- temporary decision-only tools remain
- invalid re-asks do **not** advance exponential continue attempt / do not count toward `maxRetries`

**When** the third consecutive invalid decision occurs
**Then**

- restore normal tools
- remain locked; decision-failed; no idle timer
- TUI warning exactly: `Continue watchdog decision failed after 3 attempts: <last error>`
- only actual main user `message_start` or `/lock-continue-watchdog` clears decision-failed and resets the cycle

### Example 9 — Activity during delay cancels; full delay restarts

**Given** a pending idle timer for the current attempt
**When** any observable session becomes busy before the timer fires
**Then** that timer is cancelled and must not open a decision window

**When** all observable sessions are idle again
**Then** the **full** delay for the **same** current attempt restarts from zero

Stale timer callbacks (wrong generation/epoch/ownership) must not open a decision window or wake main.

### Example 10 — Exhaustion after max valid continues

**Given** default `maxRetries = 10` and 10 **valid continue** decisions have already been consumed in this lock cycle
**When** main remains locked and all observable sessions become idle again
**Then**

- no further idle timer is scheduled
- state remains **locked and exhausted**
- a new actual main user `message_start` or manual `/lock-continue-watchdog` resets attempts and clears exhaustion
- human unlock and (after a future re-arm) decision unlock still work per Examples 3 and 7

### Example 11 — Runtime-only lock; clean unlocked on session lifecycle edges

**When** Pi reloads extensions, starts a new session, resumes, restarts, or shuts the attachment down
**Then**

- lock state is **not** restored from disk
- effective state starts **unlocked**
- timers and decision windows are cleaned
- normal tools are not left permanently replaced by decision tools after demotion/shutdown
- no orphaned wakes after demotion/shutdown

### Example 12 — Trusted config overrides with safe fallback

**Given** global and/or trusted-project `pi-continue-watchdog.json`
**When** valid `idleDelaySeconds`, `maxRetries`, `decisionPrompt`, and/or `continuePrompt` are provided
**Then** effective config uses field-level override (trusted project over global over defaults)

**When** values are missing, unreadable, or invalid
**Then** retain valid lower-precedence values / defaults and emit bounded diagnostics (no crash, no silent use of nonsense numbers that would fire immediately in an unbounded way)

### Example 13 — Publication, language, packaging, CI

**Then** the shipped project:

- is public **`xz-dev/pi-continue-watchdog`**
- uses **English** for source, identifiers, default prompts, CLI/help, UI labels, errors, tests, and README
- is licensed **BSD-3-Clause**
- is **source-installable** from `master` (TypeScript entry via Pi extension manifest)
- has **packed, isolated, stock-Pi** CI/E2E covering the real plugin artifact (not only unit mocks)
- does **not** require npm publication, tags, or GitHub Releases for v1 (users track latest commits), unless product authority later expands distribution

---

## Pi API facts and limitations (must document)

These are product/engineering constraints, not optional polish:

| Fact | Implication for this plugin |
|---|---|
| Context hooks can change **model-bound** context non-destructively | Decision folding removes/replaces what the next LLM request sees; raw session may still store protocol records |
| `setActiveTools` controls the **next** request’s tool set | Decision tools must be set before the decision turn; normal tools restored before continued work or after failure/unlock |
| `terminate: true` only ends early if **every** tool result in the same batch opts in | Unlock path documents this limitation; mixed batches may still trigger a model turn |
| Raw session retains paired tool call/result records | Even after context folding, protocol history may exist on disk / in session file |
| Decision-only tool set | Prevents other tools from being offered in the decision request; validity still rejects unknown/extra tools if they appear |

---

## Delivery and safety invariants (cross-cutting)

| Invariant | Requirement |
|---|---|
| No tool cancellation | Decision entry / continue delivery must not abort in-flight tools already running when idle is detected (steer waits for current batch where Pi requires it) |
| No false “all agents” claims | Docs and diagnostics say **observable** same-process coverage |
| Generation-safe timers | `clearTimeout` alone is insufficient; callbacks check ownership/generation |
| Command demotion safety | If main demotes, stale command handlers must be inert |
| Notify channel | Lock/unlock/decision-failed notifies are TUI user-only; not injected as user-role conversation turns |
| Abort truthfulness | Capture a per-run branch boundary, then inspect only newly persisted assistant entries at `agent_settled`; unlock only when the terminal assistant has `stopReason: "aborted"`. Never reuse an older aborted entry or infer abort from settle alone. |
| No context pollution from decisions | Future model-bound context never keeps the raw decision exchange after valid unlock/continue handling |
| No persistent unlock tool | Outside the decision window, `unlock_continue_watchdog` / `continue_watchdog` are not part of the normal always-on tool set |
| No other-plugin coupling | No imports or runtime detection of pi-subagents / pi-watchdog / pi-notify |

---

## Explicit non-examples (do not implement as v1)

- **Rejected prior design:** idle → visible continue custom message while normal tools remain and unlock stays always registered
- Auto-unlock when the model says “done” in prose without a valid unlock tool call
- Inferring main from package names or foreign plugin state
- Persisting lock in session JSON / disk
- Counting only root idle and ignoring observable children (or the reverse)
- Using `followUp` delivery that waits until the entire active tool flow stops if steer+triggerTurn is the accepted safe wake
- Silent same-state lock/unlock (no TUI notify)
- Watching raw Escape and unlocking before knowing whether Pi produced an aborted run
- Scanning the whole session without a run boundary, so an old aborted assistant message unlocks a later natural run
- Treating every ordinary `agent_settled` as aborted instead of checking the newly persisted terminal assistant `stopReason`
- Configurable invalid re-ask budget (must stay fixed at 3)
- Counting invalid re-asks against `maxRetries`
- Leaving decision tools active after unlock, continue, decision-failed, demote, or shutdown

---

## Acceptance evidence expectations

For each example above, implementation slices must leave evidence that can be re-run:

- **Unit / component:** pure state machine (including decision-failed and attempt advancement rules), config precedence, reason trim/truncate/length, timer cancel/restart, generation guards, decision validity matrix
- **Integration / E2E (stock Pi, packed install):** auto-lock on real user `message_start`; command lock/unlock notifies and optional reason; temporary tool replacement; at least one real timed path into a decision window; continue fold vs unlock fold; third-invalid decision-failed warning; exhaustion or multi-attempt math (real or injected clock, documented)
- **Human accept:** product authority reviews evidence against this file; AI does not self-accept

**Implementation status:** this contract does **not** claim any production implementation is complete.
