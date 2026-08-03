# Acceptance contract — pi-continue-watchdog

**Status:** Accepted product contract for the **two-stage decision-flow** redesign (2026-08-01)
**Project:** public English `xz-dev/pi-continue-watchdog`
**License:** BSD-3-Clause

This document is the human-accepted ATDD contract. Implementation must satisfy these externally **observable** examples. Passing tests alone do not re-authorize product changes; any behavioral change requires re-agreement here first.

## Simplicity policy

- Acceptance specifies **observable behavior** only.
- Implementation mechanisms are **replaceable** as long as behavior stays the same.
- Trust normal stock Pi public shapes; do not require hostile Proxy/global hardening in v1.
- Prefer simple, obvious code the human can modify later.
- Core product goal: the AI should not mysteriously stop. Drop complexity that does not materially serve that goal.

## Supersession notice (authoritative)

This contract **supersedes and rejects** the prior **direct-continuation** design (idle → immediately continue while a persistent always-active unlock tool remained in the normal tool set).

| Prior design (rejected) | Current design (required) |
|---|---|
| After idle delay, send a continue message while normal tools stay active | After idle delay, open a **temporary decision-only** check, then continue or unlock |
| Persistent always-active unlock tool in ordinary turns | Decision tools usable **only** during the decision check |
| Unlock result alone was the durable “stop” signal in ordinary LLM context | Valid unlock/continue **fold out** of future model-bound context; raw session may still retain protocol records |
| Default continue prompt told the model to call unlock while continuing work | Default **decision** prompt requires exactly one decision tool and forbids prose; default **continue** prompt is a compact post-fold instruction only |

Any acceptance text, test name, README, or implementation that still requires the rejected direct-continuation path is **stale** and must not be treated as in-scope for v1 under this contract.

---

## Story

| | |
|---|---|
| **Actor** | A human driving Pi with a main (root) agent that may open same-process child/subagent sessions |
| **Need** | After all observable agents go idle, ask the main agent—using a temporary decision-only tool set—whether work should continue or unlock, without polluting later LLM context with the decision exchange, and without the human retyping “continue” |
| **Value** | Reduces stalled sessions after subagents finish; makes unlock intentional, reason-visible in TUI, and free of long-lived unlock-tool pollution in ordinary model context |
| **In scope (v1)** | Runtime lock; auto-lock on actual main user work; manual lock/unlock (optional reason); automatic unlock when the main run is actually aborted as Pi reports; temporary decision tools; decision validation + 3 re-asks; context folding + compact continue prompt; exponential idle delays; config; packaging/CI/publication |
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
| Default `continuePrompt` | `Continue until user assistance is required.` | Compact model-visible replacement after valid continue fold |
| Lock TUI notify | `Continue watchdog locked` | User-only TUI notify |
| Unlock TUI notify (no reason) | `Continue watchdog unlocked` | User-only TUI notify |
| Unlock TUI notify (with reason) | `Continue watchdog unlocked: <reason>` | User-only TUI notify |
| Decision-failed TUI warning | `Continue watchdog decision failed after 3 attempts: <last error>` | User-only TUI notify/warning |
| Main-run abort unlock | same behavior as reasonless `/unlock-continue-watchdog` | Automatic when Pi reports the main run as aborted |

Correct all accidental `cointinue` spellings; public names use `continue` only.

### Exact default `decisionPrompt`

```text
This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. Decide whether work should continue. Call unlock_continue_watchdog with a concise reason if you are intentionally waiting for the user or all tasks are complete. Otherwise call continue_watchdog. Call exactly one tool and do not answer with prose.
```

### Exact default `continuePrompt`

```text
Continue until user assistance is required.
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
6. **Universal main-run coverage.** Every current-main `agent_start` ensures the watchdog is locked. If already locked, the existing cycle is preserved; watchdog decision and continuation turns do not reset themselves. If unlocked, the start silently begins a fresh lock cycle.
7. **Abort unlock.** When the current main run is **actually aborted as Pi reports** (the same outcome the TUI shows as aborted), unlock reasonlessly and immediately. Ordinary natural settle does **not** unlock. Never inspect or infer why a child stopped. Implementation may inspect Pi’s public session history to detect the main aborted outcome; the detection mechanism is replaceable as long as this behavior holds.
8. **Stop-reason-independent idle recovery.** For any non-aborted main stop—including normal completion, Provider/model failure, extension runtime failure, or auto-compaction failure—the plugin uses only Pi's true idle lifecycle. It does not match error strings or special-case compaction.

---

## Defaults and configuration

| Key | Default | Notes |
|---|---|---|
| `idleDelaySeconds` | `3` | Base delay in seconds; any finite number `>= 0`. Zero schedules an asynchronous 0 ms decision and fractions are allowed. |
| `maxRetries` | `10` | Maximum **valid continue** decisions per lock cycle (not invalid re-asks); safe integer in `[1, 10]` |
| `decisionPrompt` | exact default above | Hidden custom-role body; explicitly identifies extension automation and says it is not a user message/request; nonblank and at most 16,384 Unicode code points |
| `continuePrompt` | exact default above | Compact fold-in after valid continue; nonblank and at most 16,384 Unicode code points |

**Config locations and precedence** (same pattern as sibling Pi plugins):

1. Built-in defaults
2. Global: `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` (default `~/.pi/agent/pi-continue-watchdog.json`)
3. Trusted project only: `<cwd>/.pi/pi-continue-watchdog.json` when the project is trusted by Pi

Trusted-project fields override global field-by-field (`builtins < global < trusted project`). Invalid high-precedence values must not erase valid lower-precedence values; emit bounded diagnostics. Missing files are silent. Configured prompt limits count Unicode code points without truncation: exactly 16,384 is valid and longer values are invalid.

**Retry delay formula** for continue attempt `N` (1-based; advances only on **valid continue**):

```text
delaySeconds(N) = idleDelaySeconds × 2^(N - 1)
```

With defaults: 3s, 6s, 12s, 24s, … for attempts 1…`maxRetries`. With a zero base, every attempt schedules through a 0 ms timer.

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
| pending idle timer | One-shot timer for the current attempt |
| decision window | Temporary tool set + hidden decision prompt in flight / re-ask |

**Unconditional assignment:** manual lock/unlock **never** no-op on same-state. They always assign the target state and always emit the corresponding TUI notification. No “already locked/unlocked” short-circuit that suppresses notify.

**What resets attempt to 0, clears exhaustion and decision-failed, and (re)arms lock:**

- Actual main user-role message **start of processing** (auto-lock)
- Manual `/lock-continue-watchdog`

**What unlocks without resetting cycle accounting:**

- `/unlock-continue-watchdog [reason]`
- Valid decision-window `unlock_continue_watchdog({ reason })`
- Main run actually aborted as Pi reports (reasonless)

Unlock first makes `locked=false`, then cancels every watchdog timer and cleans operational pending decision state while preserving attempt/backoff, exhaustion, decision-failed, and invalid/no-result counters. Only fresh lock semantics reset those fields.

**What auto-locks without resetting an already locked cycle:**

- Any current-main `agent_start`; when unlocked it starts a fresh cycle silently, and when already locked it preserves the cycle

**What does not auto-lock / does not reset the main cycle:**

- Merely queued main input (before processing starts)
- Child/subagent user-role messages
- Watchdog decision or continuation turns while the current cycle is already locked
- Invalid or no-result decision re-asks (they do **not** consume exponential continue retries)

---

## Decision window protocol

### Entry

**Given** main is locked, not exhausted, not decision-failed, and every observable same-process session is idle
**When** idle remains continuous for `idleDelaySeconds × 2^(N-1)` for the current continue attempt `N`
**Then** the plugin:

1. Temporarily offers the main agent **exactly**:
   - `continue_watchdog` with empty/minimal input schema `{}`
   - `unlock_continue_watchdog` with required `reason: string`
     Unlock tool text must say the reason is a **concise single-sentence** reason (validation rules below).
2. Sends a **hidden custom-role** message—not a user-role message—whose model-visible body is the configured `decisionPrompt` (exact default above). Its default explicitly identifies the extension automation and says it is not a user message or request.
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
   - New actual root user message start or manual `/lock-continue-watchdog` resets failures/attempts and re-arms the cycle

### Valid unlock

**When** the decision is a valid unlock:

- Restore normal tools
- Set unlocked first; then cancel timers and clean operational decision state while preserving attempts/failures
- TUI notify exactly: `Continue watchdog unlocked: <reason>`
- Append a **persisted TUI-only** reason entry (user-visible history, not model-bound as ordinary assistant prose)
- **No further work turn** is started for that unlock decision
- **Future model-bound context** removes the **entire** decision exchange (decision prompt, model reply, tool call(s), tool result(s)) and **inserts nothing** in its place
- Raw session may still preserve protocol records; folding is model-bound context only

### Valid continue

**When** the decision is a valid continue:

- Reasonless (no reason field required or used)
- Restore normal tools
- The decision-only turn ends, and ordinary work continues automatically without further user input
- Context folding removes the complete decision prompt / reply / tool call / results and replaces them with **one** compact custom message containing the configured `continuePrompt` (exact default: `Continue until user assistance is required.`)
- Custom tool rendering folds the continue tool call/result into **one compact TUI line** that surfaces the `continuePrompt` text
- Consumes **one** exponential retry (attempt advances)
- Next settle + all-observable-idle uses the next exponential delay
- After `maxRetries` valid continues, remain locked/exhausted with no timer until reset

### Human `/unlock-continue-watchdog [reason]`

Always assigns `locked=false` first, then cancels timers and cleans operational decision state while preserving cycle accounting, and notifies—even if already unlocked.

| Human reason input | TUI notify | TUI-only reason entry |
|---|---|---|
| Empty / blank / omitted | exactly `Continue watchdog unlocked` | none (no reason) |
| Nonblank | trim; **automatically truncate** to first **500** Unicode characters (may be multiline); notify `Continue watchdog unlocked: <reason>` | append TUI-only entry with that reason |

Human unlock is **not** subject to the AI decision-window invalid re-ask protocol.

---

## Confirmed acceptance examples

These examples are the accepted product contract. Each is externally observable through public commands, TUI notifies, tool registration, model-bound context after folding, timers, and install/CI artifacts.

### Example 1 — Current-main starts are covered; actual main user messages start fresh cycles

**Given** the main session is unlocked
**When** any current-main run actually starts
**Then**

- the watchdog silently starts a fresh locked cycle
- the main attachment is marked busy

**Given** the watchdog is already locked with any current attempt, exhaustion, decision-failed, timer, or decision window
**When** another current-main run starts without a new real user message
**Then**

- the watchdog remains locked
- existing cycle accounting and decision state are preserved
- the main attachment is marked busy and any idle delay is cancelled

**When** a **user-role** message actually starts processing on main (not mere queueing)
**Then**

- it silently performs the same fresh-cycle reset as `/lock-continue-watchdog`
- attempt resets to `0`; exhaustion, decision-failed, and invalid/no-result counts clear; stale timer/decision work is cleaned
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

- `locked=false` is assigned first; timers and pending operational decision work are then cancelled; attempts/failures are preserved
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

**Given** a main run starts while the continue watchdog is locked or already unlocked
**When** that run ends and Pi reports it as **aborted**
**Then**

- apply the same unconditional state transition as reasonless `/unlock-continue-watchdog`: assign `locked=false` first; then cancel timers/operational decision state and restore prior normal tools; preserve cycle accounting and failures
- TUI notifies exactly `Continue watchdog unlocked`, even when already unlocked
- no unlock reason entry is appended
- process that aborted run once (no duplicate unlock notification for the same abort)

**And when** the run ends for any non-aborted reason, or abort cannot be attributed to that run, the plugin does not auto-unlock.

Ordinary natural idle settle never counts as abort.

### Example 5 — Locked + all observable idle → exponential delayed **decision entry**

**Given** main is locked, not exhausted, not decision-failed, and every observable same-process session is idle
**When** idle remains continuous for `idleDelaySeconds × 2^(N-1)` for the current attempt `N`
**Then**

- exactly one decision window is opened for that attempt (not a direct continue custom message)
- active tools are temporarily replaced with exactly `continue_watchdog` and `unlock_continue_watchdog`
- a **hidden custom-role** decision message uses configured `decisionPrompt` (exact default in Product surface), identifies itself as extension automation, states it is not a user message/request, and is never injected with user role
- the rejected direct-continuation default
  `Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.`
  is **not** used as the idle wake message

With defaults, delays for successive continue attempts begin **3s, 6s, 12s, 24s, …**

### Example 6 — Valid continue: fold, compact prompt, retry consumption

**Given** a decision window is open
**When** the main agent returns a valid `continue_watchdog` decision
**Then**

- normal tools are restored
- the decision-only turn ends and ordinary work continues automatically without further user input
- model-bound context removes the full decision exchange and inserts one compact custom message equal to configured `continuePrompt` (default `Continue until user assistance is required.`)
- TUI shows a compact single-line rendering for the continue tool call/result including that continue prompt
- one exponential retry is consumed
- after settle, if still locked and all observable idle, the **next** exponential delay arms

### Example 7 — Valid unlock: reason notify, fold to nothing, no further work turn

**Given** a decision window is open
**When** the main agent returns a valid `unlock_continue_watchdog` with reason e.g. `Waiting for user confirmation on deploy.`
**Then**

- normal tools restored; `locked=false`; timers and operational decision state cancelled; attempts/failures preserved
- TUI notifies exactly: `Continue watchdog unlocked: Waiting for user confirmation on deploy.`
- TUI-only reason entry appended
- **no further work turn** starts from that unlock decision
- future model-bound context removes the entire decision exchange and inserts **nothing**
- raw session may still contain protocol tool records

### Example 8 — Invalid or no-result decision re-asks then decision-failed

**Given** a decision window is open
**When** the model responds invalidly (no tool, both tools, unknown tool, prose-only, empty reason, reason > 500 Unicode characters) **or the decision turn truly settles without any verifiable decision response/result**
**Then**

- immediately re-ask with a hidden prompt that includes the exact previous error and explains invalidity
- temporary decision-only tools remain
- invalid re-asks do **not** advance exponential continue attempt / do not count toward `maxRetries`

**When** the third consecutive invalid decision occurs
**Then**

- restore normal tools
- remain locked; decision-failed; no idle timer
- TUI warning exactly: `Continue watchdog decision failed after 3 attempts: <last error>`
- only actual main user message start or `/lock-continue-watchdog` clears decision-failed and resets the cycle

### Example 9 — Activity during delay cancels; full delay restarts

**Given** a pending idle timer for the current attempt
**When** any observable session becomes busy before the timer fires
**Then** that timer is cancelled and must not open a decision window

**When** all observable sessions are idle again
**Then** the **full** delay for the **same** current attempt restarts from zero

At each `agent_settled`, only Pi's live `ctx.isIdle()` truth may mark that attachment idle. Every true-idle settle explicitly reconciles aggregate idle even when the hub already considered the attachment idle. A false-idle outer settle caused by an earlier extension starting a nested turn must not arm; the later true settle must arm normally.

Stale timer callbacks (wrong generation/epoch/ownership) must not open a decision window or wake main.

### Example 10 — Exhaustion after max valid continues

**Given** default `maxRetries = 10` and 10 **valid continue** decisions have already been consumed in this lock cycle
**When** main remains locked and all observable sessions become idle again
**Then**

- no further idle timer is scheduled
- state remains **locked and exhausted**
- a new actual main user message start or manual `/lock-continue-watchdog` resets attempts and clears exhaustion
- human unlock and (after a future re-arm) decision unlock still work per Examples 3 and 7

### Example 11 — Terminal automatic stop publishes neutral `user-ready`

**Given** the elected main attachment observes a new aggregate-idle epoch
**And** the watchdog has finished every automatic action it can take for that epoch
**When** the terminal stop is one of:

1. Valid AI decision unlock with a validated reason
2. Max valid continue attempts exhausted
3. Third invalid decision becomes decision-failed

**Then** the main attachment publishes exactly one fresh plain-data envelope on Pi's public bus channel `pi:semantic-hook:v1`:

```json
{"version":1,"name":"user-ready","values":{"STOP_KIND":"AI_UNLOCK","REASON":"<validated reason>"}}
```

or

```json
{"version":1,"name":"user-ready","values":{"STOP_KIND":"EXHAUSTED"}}
```

or

```json
{"version":1,"name":"user-ready","values":{"STOP_KIND":"DECISION_FAILED"}}
```

**And** it does **not** publish for human `/unlock-continue-watchdog` (with or without reason), canonical/manual/user abort unlock, initial ordinary unlocked idle, valid continue or intermediate decision/settled states, locked normal/pending idle timer, stale/demoted/reloaded ownership, or repeated settled/reconcile in the same terminal epoch.

Only AI decision unlock retains a publication intent/reason until the resulting authoritative aggregate-idle settle. Existing reason validation/trim/length remains authority; decision-failed does not publish last error text. Absence or failure of every consumer must not change watchdog state.

### Example 12 — Runtime-only lock; clean unlocked on session lifecycle edges

**When** Pi reloads extensions, starts a new session, resumes, restarts, or shuts the attachment down
**Then**

- lock state is **not** restored from disk
- effective state starts **unlocked**
- timers and decision windows are cleaned
- normal tools are not left permanently replaced by decision tools after demotion/shutdown
- no orphaned wakes after demotion/shutdown


### Example 13 — Trusted config overrides with safe fallback

**Given** global and/or trusted-project `pi-continue-watchdog.json`
**When** valid `idleDelaySeconds`, `maxRetries`, `decisionPrompt`, and/or `continuePrompt` are provided
**Then** effective config uses field-level override (trusted project over global over defaults)

**When** values are missing, unreadable, or invalid
**Then** retain valid lower-precedence values / defaults and emit bounded diagnostics (no crash, no silent use of nonsense numbers that would fire immediately in an unbounded way)

### Example 14 — Publication, language, packaging, CI

**Then** the shipped project:

- is public **`xz-dev/pi-continue-watchdog`**
- uses **English** for source, identifiers, default prompts, CLI/help, UI labels, errors, tests, and README
- is licensed **BSD-3-Clause**
- is **source-installable** from `master` (TypeScript entry via Pi extension manifest)
- has **packed, isolated, stock-Pi** CI/E2E covering the real plugin artifact (not only unit mocks)
- is installed only as the unpinned live Git package `pi install git:github.com/xz-dev/pi-continue-watchdog`
- has no npm publication, version tags, or GitHub Releases; users track the latest `master` commit

---

## Pi limitations (document in README; behavior-level)

These are product constraints, not optional polish. Implementation details are replaceable:

| Limitation | Observable implication |
|---|---|
| Context folding is model-bound | Future model requests drop/replace the decision exchange; raw session may still store protocol records |
| Decision tools are temporary for the next request | Outside the decision window they are not part of the normal always-on active tool set |
| Unlock ends the decision path without starting more work | Valid unlock must not start a further ordinary work turn |
| Raw session retains paired tool call/result records | Even after context folding, protocol history may exist on disk / in session file |
| Decision-only tool set | Prevents other tools from being offered in the decision request; validity still rejects unknown/extra tools if they appear |

---

## Delivery and safety invariants (cross-cutting)

| Invariant | Requirement |
|---|---|
| No tool cancellation | Decision entry / continue delivery must not abort in-flight tools already running when idle is detected |
| No false “all agents” claims | Docs and diagnostics say **observable** same-process coverage |
| Generation-safe timers | Timer callbacks must not fire after unlock/demote/ownership change |
| Command demotion safety | If main demotes, stale command handlers must be inert |
| Notify channel | Lock/unlock/decision-failed notifies are TUI user-only; not injected as user-role conversation turns |
| Abort truthfulness | Unlock on actual Pi-reported main abort only; never on ordinary natural settle |
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
- Silent same-state lock/unlock (no TUI notify)
- Inferring abort from ordinary idle settle
- Configurable invalid re-ask budget (must stay fixed at 3)
- Counting invalid re-asks against `maxRetries`
- Leaving decision tools active after unlock, continue, decision-failed, demote, or shutdown

---

## Acceptance evidence expectations

For each example above, implementation slices must leave evidence that can be re-run:

- **Unit / component:** pure state machine (including decision-failed and attempt advancement rules), config precedence, reason trim/truncate/length, timer cancel/restart, generation guards, decision validity matrix
- **Integration / E2E (stock Pi, packed install):** auto-lock on real main user message start; command lock/unlock notifies and optional reason; temporary tool replacement; at least one real timed path into a decision window; continue fold vs unlock fold; third-invalid decision-failed warning; exhaustion or multi-attempt math (real or injected clock, documented)
- **Human accept:** product authority reviews evidence against this file; AI does not self-accept

**Contract status:** this file remains the accepted **behavior** contract. Implementation progress is tracked in `PLAN/implementation.md`.
