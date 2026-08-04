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
| Unlock command | `/unlock-continue-watchdog [reason]` | Human (TUI); reason optional; **untyped** (no `reasonType`) |
| Continue decision tool | `continue_watchdog` | Main/root only; **decision window only**; empty/minimal args `{}` |
| Unlock decision tool | `unlock_continue_watchdog` | Main/root only; **decision window only**; exact required args `{ reasonType: string, reason: string }` |
| Default `decisionPrompt` | see exact default below | Hidden custom message during decision window |
| Default `continuePrompt` | `Continue until user assistance is required.` | Compact model-visible replacement after valid continue fold |
| Default `reasonTypes` | `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED` | Built-in allowed AI unlock type list; a valid configured list **replaces** this default |
| Lock TUI notify | `Continue watchdog locked` | User-only TUI notify |
| Unlock TUI notify (no reason) | `Continue watchdog unlocked` | User-only TUI notify (human reasonless / abort) |
| Human unlock TUI-only entry (with reason) | `Continue watchdog unlocked · <reason>` | Muted persistent user-only history entry; human path remains untyped |
| AI unlock TUI-only entry | `Continue watchdog unlocked · <TYPE> · <reason>` | Muted persistent user-only history entry; `<TYPE>` is the matched configured value uppercased |
| Decision-failed TUI warning | `Continue watchdog decision failed after 3 attempts: <last error>` | User-only TUI notify/warning |
| Main-run abort unlock | same behavior as reasonless `/unlock-continue-watchdog` | Automatic when Pi reports the main run as aborted |

Correct all accidental `cointinue` spellings; public names use `continue` only.

### Built-in default `reasonTypes` meanings

| Type | Meaning |
|---|---|
| `JOB_DONE` | All work is complete |
| `WAIT_USER` | User input, approval, or action is required |
| `JOB_BLOCKED` | Work remains unfinished and cannot proceed for a non-`WAIT_USER` blocker |

Configured type lists may use ordinary nonblank UTF-8 text. Trust sane user config; do **not** impose identifier-format regexes, artificial length/count caps, or collision hardening beyond the validation rules below.

### Exact default `decisionPrompt`

```text
This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. Decide whether work should continue. Call unlock_continue_watchdog with an allowed reasonType and a concise reason if you are intentionally waiting for the user, all tasks are complete, or the job cannot continue. Otherwise call continue_watchdog. Call exactly one tool and do not answer with prose.
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
| `reasonTypes` | `["JOB_DONE","WAIT_USER","JOB_BLOCKED"]` | Allowed AI unlock types. A valid configured list **replaces** the default (it does not extend it). Valid = nonempty array of strings, each trim-nonblank. No identifier regex; no artificial length/count/collision hardening. |

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

**Unconditional assignment:** manual lock/unlock **never** no-op on same-state. They always assign the target state. A direct manual unlock emits its corresponding TUI output; a manual lock emits only its final lock notification. The silent prerequisite unlock of a fresh lock cycle never emits unlock output. No “already locked/unlocked” short-circuit may skip either transition.

**Fresh lock-cycle transition (manual lock or actual main user-role message start):**

1. Capture the exact current-main ownership claim.
2. Assign unlocked first.
3. Cancel every timer and clean pending finalization/decision state, restore decision tools, and clear pending AI-unlock publication intent by dispatching the normal **non-notify** unlock cleanup effects.
4. Revalidate the same exact ownership claim after any awaited or re-entrant cleanup effect. A stale/demoted owner stops here without locking or notifying.
5. Assign a fresh lock, resetting attempt to `0` and clearing exhaustion, decision-failed, and invalid/no-result accounting.
6. Dispatch lock effects and reconcile idle.

Manual `/lock-continue-watchdog` emits exactly one final `Continue watchdog locked` notification. Actual main user-role `message_start` suppresses both prerequisite-unlock and final-lock notifications. This sequence runs even when the watchdog was already unlocked or already locked; fresh lock never fakes cleanup by calling lock alone.

**What performs that full silent-unlock-cleanup → fresh-lock sequence:**

- Actual main user-role message **start of processing** (auto-lock)
- Manual `/lock-continue-watchdog`

**What unlocks without resetting cycle accounting:**

- `/unlock-continue-watchdog [reason]` (human; untyped optional reason)
- Valid decision-window `unlock_continue_watchdog({ reasonType, reason })`
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
   - `unlock_continue_watchdog` with exact required args `{ reasonType: string, reason: string }`
     Unlock tool description must list the **effective allowed** `reasonTypes` and say the reason is a **concise single-sentence** reason (validation rules below).
2. Sends a **hidden custom-role** message—not a user-role message—whose model-visible body is the configured `decisionPrompt` (exact default above). Its default explicitly identifies the extension automation and says it is not a user message or request.
3. Does **not** send the rejected direct-continuation “keep working / call unlock while tools remain normal” message as the idle wake path.

The decision model turn **reads existing task context** already present in the session; the decision prompt does not need to restate the full task.

### Validity rules (exactly one valid decision)

A decision response is **valid** only if it contains **exactly one** accepted decision tool call and **no** prose answer requirement is violated as follows:

| Outcome | Requirements |
|---|---|
| Valid **continue** | Exactly one `continue_watchdog` call; no unlock call; no extra/unknown tools; no prose-only answer |
| Valid **unlock** | Exactly one `unlock_continue_watchdog` call with a **valid `reasonType` and valid `reason`**; no continue call; no extra/unknown tools; no prose-only answer |

**Unlock `reasonType` validation (AI tool path only):**

- AI type is trimmed, then compared **case-insensitively** by lowercasing against each trimmed configured type
- On match, emit/display the **uppercase** form of the **matched configured value** (not a free-form re-casing of the AI input beyond that match)
- Missing, blank-after-trim, or unknown types are **invalid** and count under the existing fixed three invalid attempts total (two re-asks, fail on third)
- Human `/unlock-continue-watchdog` has **no** `reasonType` and is unchanged

**Unlock reason validation (AI tool path):**

- After trim, reason must be **non-empty**
- Length ≤ **500 Unicode characters** (count Unicode code points / characters as implemented consistently and tested)
- May technically contain newlines
- Empty/blank or overlong reasons are **invalid** (no truncation on the AI path)
- Existing reason rules remain; they are independent of type matching

**Invalid includes:** no tool call; both/multiple decision tools; extra or unknown tool; prose-only / no accepted tool; missing/blank/unknown `reasonType`; invalid reason.

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
- Append exactly one muted **persisted TUI-only** AI unlock entry, `Continue watchdog unlocked · <TYPE> · <reason>`, where `<TYPE>` is the matched configured type uppercased and `<reason>` is the validated reason (user-visible history, not model-bound as ordinary assistant prose)
- Do **not** also emit a transient reasoned unlock notification
- **No further work turn** is started for that unlock decision
- **Future model-bound context** removes the **entire** decision exchange (decision prompt, model reply, tool call(s), tool result(s)) and **inserts nothing** in its place
- Raw session may still preserve protocol records that contain **both** tool args (`reasonType` and `reason`); folding is model-bound context only

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

Always assigns `locked=false` first, then cancels timers and cleans operational decision state while preserving cycle accounting—even if already unlocked. The human command remains **untyped**: no `reasonType` argument, no type matching, and no AI typed TUI format.

| Human reason input | TUI notify | TUI-only reason entry |
|---|---|---|
| Empty / blank / omitted | exactly `Continue watchdog unlocked` | none (no reason) |
| Nonblank | none | trim; **automatically truncate** to first **500** Unicode characters (may be multiline); append muted `Continue watchdog unlocked · <reason>` |

Human unlock is **not** subject to the AI decision-window invalid re-ask protocol and does **not** publish `user-ready`.

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

- it captures and fences the exact current-main claim
- it first assigns unlocked and dispatches full non-notify unlock cleanup: cancel stale timer/finalization/decision work, restore decision tools, and clear pending AI-unlock publication intent
- after revalidating the exact claim, it assigns a fresh lock; attempt resets to `0`, and exhaustion, decision-failed, and invalid/no-result counts clear
- both prerequisite-unlock and fresh-lock notifications are suppressed
- it reconciles idle after locking
- if ownership becomes stale/demoted during prerequisite cleanup, it stops before fresh lock and emits no notification
- child-session user messages do **not** change main lock or attempts
- merely queued (not yet started) main input does **not** lock or reset

### Example 2 — Manual lock silently cleans up through unlock first, then locks and notifies once

**Given** main is locked or unlocked, including with an open decision, pending timer/finalization, exhausted/decision-failed state, invalid accounting, active decision tools, or pending AI-unlock publication intent
**When** the human runs `/lock-continue-watchdog`
**Then**

- it captures and fences the exact current-main claim
- it first assigns unlocked and dispatches the normal non-notify unlock cleanup effects before any fresh-lock transition or lock effect
- no prerequisite `Continue watchdog unlocked` notification or reason entry is emitted
- after revalidating the same claim, it assigns a fresh lock and dispatches lock effects
- attempts reset to `0`; exhaustion, decision-failed, and invalid/no-result accounting clear; timers and pending operational decision/finalization state are gone; normal tools are restored; pending AI-unlock publication intent is cleared
- TUI notifies exactly once: `Continue watchdog locked`
- idle is reconciled after locking
- already-unlocked and already-locked starting states both execute the full unlock-cleanup → lock sequence
- if ownership becomes stale/demoted during prerequisite cleanup, it stops before lock effects and notification

### Example 3 — Manual unlock with optional reason (untyped regression)

**Given** main is locked or unlocked, with or without a pending idle timer or decision window
**When** the human runs `/unlock-continue-watchdog` with empty/blank reason
**Then**

- `locked=false` is assigned first; timers and pending operational decision work are then cancelled; attempts/failures are preserved
- TUI notifies exactly: `Continue watchdog unlocked`
- no TUI-only reason entry
- no `reasonType` is required or displayed
- no `user-ready` envelope is published

**When** the human runs `/unlock-continue-watchdog` with a nonblank reason e.g. `Taking over manually.`
**Then**

- unlocked as above
- reason is trimmed and truncated to the first 500 Unicode characters if longer
- no transient notification is emitted
- exactly one muted TUI-only reason entry, `Continue watchdog unlocked · Taking over manually.`, is appended
- the AI typed format `Continue watchdog unlocked · <TYPE> · <reason>` is **not** used
- same-state unlock still assigns and still persists the entry

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
- `unlock_continue_watchdog` requires exact args `{ reasonType, reason }`; its description lists the effective allowed `reasonTypes`
- a **hidden custom-role** decision message uses configured `decisionPrompt` (exact default in Product surface), identifies itself as extension automation, states it is not a user message/request, and is never injected with user role
- the rejected direct-continuation default
  `Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.`
  is **not** used as the idle wake message
- the rejected untyped decision default that asked only for a concise reason without an allowed `reasonType` is **not** used

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

### Example 7 — Valid AI unlock: typed muted entry, fold to nothing, no further work turn

**Given** a decision window is open with default `reasonTypes`
**When** the main agent returns a valid `unlock_continue_watchdog` with mixed-case type `job_done` and reason `All requested package bumps are merged.`
**Then**

- normal tools restored; `locked=false`; timers and operational decision state cancelled; attempts/failures preserved
- type matches case-insensitively to configured `JOB_DONE`; display/emit uses uppercased matched configured value `JOB_DONE`
- no transient reasoned unlock notification is emitted
- exactly one muted TUI-only entry is appended: `Continue watchdog unlocked · JOB_DONE · All requested package bumps are merged.`
- **no further work turn** starts from that unlock decision
- future model-bound context removes the entire decision exchange and inserts **nothing**
- raw session may still contain the protocol tool record with both args (`reasonType` and `reason`)

**And when** config sets `reasonTypes: ["NeedReview", "shipped"]` (replacing, not extending, the default list)
**And** the agent unlocks with mixed-case type `needreview` and reason `PR is open for human review.`
**Then**

- type matches configured `NeedReview` case-insensitively
- muted TUI-only entry is exactly: `Continue watchdog unlocked · NEEDREVIEW · PR is open for human review.`
- default types such as `JOB_DONE` are **not** accepted while this custom list is effective

### Example 8 — Invalid or no-result decision re-asks then decision-failed

**Given** a decision window is open
**When** the model responds invalidly (no tool, both tools, unknown tool, prose-only, missing `reasonType`, blank `reasonType`, unknown `reasonType`, empty reason, reason > 500 Unicode characters) **or the decision turn truly settles without any verifiable decision response/result**
**Then**

- immediately re-ask with a hidden prompt that includes the exact previous error and explains invalidity
- temporary decision-only tools remain
- invalid type and invalid reason both count under the same fixed three invalid attempts total
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

1. Valid AI decision unlock with a validated `reasonType` and reason
2. Max valid continue attempts exhausted
3. Third invalid decision becomes decision-failed

**Then** the main attachment publishes exactly one fresh plain-data envelope on Pi's public bus channel `pi:semantic-hook:v1`:

```json
{"version":1,"name":"user-ready","values":{"STOP_KIND":"AI_UNLOCK","REASON_TYPE":"<matched TYPE>","REASON":"<validated reason>"}}
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

Only AI decision unlock retains a publication intent carrying **both** matched `REASON_TYPE` and validated `REASON` together until the resulting authoritative aggregate-idle settle; type and reason are retained/cleared together. Other stop kinds remain unchanged and do not invent type/reason fields. Existing type matching plus reason validation/trim/length remain authority; decision-failed does not publish last error text. Absence or failure of every consumer must not change watchdog state.

**Delayed publication while a child is still busy:**

**Given** a valid AI unlock already produced matched type `WAIT_USER` and reason `Need deploy approval.`
**And** an observable child is still busy at the unlock moment
**When** the child later settles and the main observes the terminal aggregate-idle epoch for that unlock
**Then** the published envelope is still exactly one `AI_UNLOCK` payload with `REASON_TYPE` = `WAIT_USER` and `REASON` = `Need deploy approval.`
**And** no intermediate/extra `user-ready` is published while the child remains busy

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
**When** valid `idleDelaySeconds`, `maxRetries`, `decisionPrompt`, `continuePrompt`, and/or `reasonTypes` are provided
**Then** effective config uses field-level override (trusted project over global over defaults)
**And** a valid `reasonTypes` list replaces the built-in default list rather than extending it

**When** values are missing, unreadable, or invalid
**Then** retain valid lower-precedence values / defaults and emit bounded diagnostics (no crash, no silent use of nonsense numbers that would fire immediately in an unbounded way)
**And** invalid `reasonTypes` (empty array, non-array, or any blank-after-trim entry) do not erase a valid lower-precedence / default type list

### Example 14 — Publication, language, packaging, CI

**Then** the shipped project:

- is public **`xz-dev/pi-continue-watchdog`**
- uses **English** for source, identifiers, default prompts, CLI/help, UI labels, errors, tests, and README
- is licensed **BSD-3-Clause**
- is **source-installable** from `master` (TypeScript entry via Pi extension manifest)
- has **packed, isolated, stock-Pi** CI/E2E covering the real plugin artifact (not only unit mocks)
- is installed only as the unpinned live Git package `pi install git:github.com/xz-dev/pi-continue-watchdog`
- has no npm publication, version tags, or GitHub Releases; users track the latest `master` commit

### Example 15 — One realm-wide process domain across independent ResourceLoaders

Pi may load this extension through independent `DefaultResourceLoader` instances and independent module evaluations in the **same process** (for example a UI-bound root and later headless children whose loaders use distinct `cwd` values). Those evaluations must still share **one** process-local observable-agent domain for attachment membership, main election, and all-observable-idle aggregation.

**Given** two or more same-process extension activations whose modules were evaluated independently (including via public Pi `DefaultResourceLoader` loads under distinct `cwd` values)
**When** each activation binds an attachment and reports busy/idle through ordinary Pi lifecycle events
**Then**

- every such attachment is visible in **one** realm-wide process domain (not one hub per module evaluation / ResourceLoader)
- main election spans the whole domain and still follows the existing pure-headless policy: UI-bound wins when present; with no UI-bound attachment, first-bound remains best-effort main and later non-UI attachments do not steal
- only the current main may open a decision inquiry; non-main children never expose or originate inquiry
- intermediate settles while any observable attachment remains busy arm **no** main inquiry; only after the final busy attachment settles (and the configured idle delay elapses with every observable attachment still idle) may the current main open **exactly one** inquiry

**Minimal multi-attachment idle shape:**

**Given** one UI root and two headless children are all initially busy on the shared domain
**When** the root settles, then the first child settles
**Then** the root opens **no** decision inquiry and neither child opens an inquiry

**When** the final child settles and the idle delay elapses with every observable attachment still idle
**Then** the root opens **exactly one** decision inquiry and children still open none

Isolated, out-of-process, or non-extension children remain outside coverage. This example does **not** change pure-headless election or require another plugin.

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

- **Unit / component:** pure state machine (including decision-failed and attempt advancement rules), config precedence including `reasonTypes` replace semantics, AI type case-insensitive match + uppercased matched configured value, reason trim/truncate/length (AI no-truncation vs human truncate), timer cancel/restart, generation guards, decision validity matrix (including missing/blank/unknown type)
- **Integration / E2E (stock Pi, packed install):** auto-lock on real main user message start; command lock/unlock notifies and optional untyped reason; temporary tool replacement with typed unlock args; at least one real timed path into a decision window; continue fold vs typed unlock fold/raw-record retention; delayed `AI_UNLOCK` user-ready while a child is busy; third-invalid decision-failed warning; exhaustion or multi-attempt math (real or injected clock, documented)
- **Human accept:** product authority reviews evidence against this file; AI does not self-accept

**Contract status:** this file remains the accepted **behavior** contract. Implementation progress is tracked in `PLAN/implementation.md`.
