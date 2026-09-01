# Acceptance contract — pi-continue-watchdog

**Status:** Accepted product contract for the **three-outcome decision-flow** redesign (2026-09-01)
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

This contract supersedes both the rejected direct-continuation design and the temporary decision-tool design. The current protocol keeps ordinary tools stable and asks for one trailing XML decision block.

| Rejected design | Current design (required) |
|---|---|
| Immediately continue after idle while a persistent unlock tool remains active | Ask main to decide after aggregate idle, then continue, wait, or unlock |
| Temporarily replace ordinary tools with two decision tools | Keep ordinary active tools and the system-prompt tool list unchanged |
| Express the decision as a tool call/result | Express it as exactly one trailing `<watchdog>...</watchdog>` XML block |
| Require the whole answer to be prose-free | Allow narration before XML, but require the sole XML block at the trimmed response end |
| Leave terminal invalid exchanges unfolded | Fold valid continue, valid wait, valid unlock, and decision-failed exchanges out of future model context |

Any acceptance text, test name, README, or implementation that still requires persistent or temporary decision tools is stale.

---

## Story

| | |
|---|---|
| **Actor** | A human driving Pi with a root main agent and watchdog-loaded same-process or authenticated child Pi sessions |
| **Need** | After all observable agents go idle, ask main—without changing ordinary tools—whether work should continue, wait for a bounded period, or unlock, without polluting later LLM context and without the human retyping “continue” |
| **Value** | Reduces stalled sessions after subagents finish; lets the agent defer a check for external automation without starting a meaningless continuation turn; makes unlock intentional and reason-visible while preserving the ordinary prompt/tool cache prefix |
| **In scope (v1)** | Runtime lock; auto-lock on actual main user work; manual lock/unlock (optional reason); automatic unlock when the main run is actually aborted as Pi reports; trailing XML continue/wait/unlock decisions; typed AI continue/unlock reasons; bounded wait reason and seconds; decision validation + 3 re-asks; tool-call blocking during decisions; context folding + compact continue prompt; one fixed grace per authoritative aggregate all-idle generation; authenticated cross-process child activity, neutral connect/disconnect-as-idle, fixed 1-second reconnect with fresh live reports; config; packaging/CI/publication |
| **Out of scope (v1)** | Durable lock across reload/new/resume/restart; sessions that did not load the watchdog; depending on pi-subagents or any other plugin; replacing Pi footer; wall-clock or loop-count watchdogs (those belong to pi-watchdog); direct idle continuation without a decision stage |

---

## Product surface (fixed names)

| Surface | Exact name / text | Who / channel |
|---|---|---|
| Lock command | `/lock-continue-watchdog` | Human (TUI) |
| Unlock command | `/unlock-continue-watchdog [reason]` | Human (TUI); reason optional; **untyped** (no `reasonType`) |
| Status command | `/status-continue-watchdog` | Human (TUI); read-only trigger diagnosis |
| Continue XML decision | `function=continue_watchdog` plus `reason_type` and `reason_content` | Main/root decision window only |
| Wait XML decision | `function=wait_watchdog` plus `reason_content` and integer `wait_seconds` in `1..1800`; no `reason_type` | Main/root decision window only |
| Unlock XML decision | `function=unlock_continue_watchdog` plus `reason_type` and `reason_content` | Main/root decision window only |
| Default `decisionPrompt` | see exact default below | Automated semantic prefix; runtime always appends the fixed XML protocol and effective reason types |
| Default `continuePrompt` | `Continue until user assistance is required.` | Compact model-visible replacement after valid continue fold |
| Default `reasonTypes` | `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED` | Built-in allowed AI unlock type list; a valid configured list **replaces** this default |
| Default `continueReasonTypes` | `WORK_REMAINS`, `VERIFYING` | Independent allowed AI continue type list; a valid configured list **replaces** this default |
| Continue TUI-only entry | `Continue watchdog continued · <TYPE> · <reason>` | Persisted before semantic publication and continuation dispatch |
| Wait TUI-only entry | `Continue watchdog waiting · <seconds>s · <reason>` | Persisted before the absolute wait deadline is armed |
| Continue semantic hook | `watchdog-continued` with `REASON_TYPE` and `REASON` | Neutral plain-data best-effort hook after durable continue evidence |
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

### Built-in default `continueReasonTypes` meanings

| Type | Meaning |
|---|---|
| `WORK_REMAINS` | Actionable requested work remains |
| `VERIFYING` | Verification work is actively being performed |

Passive external-automation delay is represented only by untyped `wait_watchdog`; it is not a continue reason type.

Configured type lists may use ordinary nonblank UTF-8 text. Trust sane user config; do **not** impose identifier-format regexes, artificial length/count caps, or collision hardening beyond the validation rules below.

### Exact default `decisionPrompt`

```text
This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. It does not represent any decision by the user. Decide whether work should continue. Before deciding, check whether every task the user requested in this session is complete, including earlier requests and not only the latest one.
```

At runtime the extension always appends a fixed protocol suffix. It says to use existing conversation context, **not make decisions on the user's behalf**, not call tools, output exactly one watchdog XML block at the end, never output multiple watchdog blocks, and use the corresponding independent effective reason type list. It includes canonical typed continue and unlock examples plus an untyped wait example. Parser compatibility with surplus XML keys is intentionally not advertised to the model.

### Exact default `continuePrompt`

```text
Continue until user assistance is required.
```

---

## Scope and classification rules

1. **“All agents idle”** means every extension-loaded attachment in the process-local hub and every authenticated watchdog-loaded child Pi process that has joined the inherited process domain is idle. Sessions that did not load the watchdog or did not inherit the declaration may be absent; document this as **observable coverage**, never “all agents in the universe.”
2. **Main/root election** (root-process local, no other plugin):
   - UI-bound session wins main when present.
   - Pure headless: first-bound attachment is documented best-effort main; later attachments are treated as non-main.
3. **Only main** may enter the decision window. Ordinary tools stay advertised, but every tool call from an active main decision is blocked before execution so the model can finish with XML. Non-main attachments remain observer-only.
4. **Zero external-plugin dependencies.** Use only Pi public extension APIs plus this plugin’s own same-process hub and authenticated process-domain coordinator.
5. **Lock state is runtime-only** for the current process/session attachment lifecycle. Not written to disk. Not restored on reload/new/resume/restart/shutdown.
6. **Universal main-run coverage.** Every current-main `agent_start` ensures the watchdog is locked. If already locked, the existing cycle is preserved; watchdog decision and continuation turns do not reset themselves. If unlocked, the start silently begins a fresh lock cycle.
7. **Abort unlock.** When the current main run is **actually aborted as Pi reports** (the same outcome the TUI shows as aborted), unlock reasonlessly and immediately. Ordinary natural settle does **not** unlock. Never inspect or infer why a child stopped. Implementation may inspect Pi’s public session history to detect the main aborted outcome; the detection mechanism is replaceable as long as this behavior holds.
8. **Stop-reason-independent idle recovery.** For any non-aborted main stop—including normal completion, Provider/model failure, extension runtime failure, or auto-compaction failure—the plugin uses only Pi's true idle lifecycle. It does not match error strings or special-case compaction.
9. **Live public AI activity.** Every relevant Pi event queries live `ctx.isIdle()`. Event labels never assign or imply busy/idle. Pi's public value covers active runs, automatic retries, auto-compaction retries, and queued continuations.

---

## Defaults and configuration

| Key | Default | Notes |
|---|---|---|
| `idleDelaySeconds` | `10` | Deprecated compatibility key. It remains accepted/preserved, but runtime ignores it; every automatic inquiry fence is exactly 10 seconds. |
| `maxRetries` | `10` | Maximum **valid continue or wait** outcomes per lock cycle (not invalid re-asks); safe integer in `[1, 10]` |
| `decisionPrompt` | exact default above | Automated custom-role body; explicitly identifies extension automation and says it is not a user message/request; nonblank and at most 16,384 Unicode code points |
| `continuePrompt` | exact default above | Compact fold-in after valid continue; nonblank and at most 16,384 Unicode code points |
| `reasonTypes` | `["JOB_DONE","WAIT_USER","JOB_BLOCKED"]` | Allowed AI unlock types. A valid configured list **replaces** the default. |
| `continueReasonTypes` | `["WORK_REMAINS","VERIFYING"]` | Independently allowed AI continue types. Same nonempty trim-nonblank validation and replace semantics as `reasonTypes`. |

**Config locations and precedence** (same pattern as sibling Pi plugins):

1. Built-in defaults
2. Global: `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` (default `~/.pi/agent/pi-continue-watchdog.json`)
3. Trusted project only: `<cwd>/.pi/pi-continue-watchdog.json` when the project is trusted by Pi

Trusted-project fields override global field-by-field (`builtins < global < trusted project`). Invalid high-precedence values must not erase valid lower-precedence values; emit bounded diagnostics. Missing files are silent. Configured prompt limits count Unicode code points without truncation: exactly 16,384 is valid and longer values are invalid.

**Fence rule:** every candidate automatic inquiry cancels/replaces the previous event-loop timer and waits a full fixed 10 seconds. Every relevant event and every child report replaces it, including repeated equal idle reports. Valid continue and wait outcomes each advance the shared `maxRetries` attempt. A wait additionally records an absolute not-before deadline and prevents automatic inquiry before it; it does not change the fixed fence duration used when renewed activity requires requalification.

**Non-configurable:** invalid decision re-ask budget is fixed at **3** attempts (not a config key).

---

## State model (behavioral)

Per main ownership generation / lock cycle, at least:

| Field / phase | Meaning |
|---|---|
| `locked` | Whether auto decision-after-idle is armed |
| `attempt` | Number of valid continue or wait outcomes consumed in the current cycle (0 after reset) |
| `exhausted` | `locked` and `maxRetries` valid continue/wait outcomes already consumed; no new inquiry until reset, except a final wait must first reach its deadline |
| `waitUntilMs` | Absolute not-before time for the latest valid wait; `0` when no wait is active |
| `decisionFailed` | After 3 invalid decision attempts; locked remains true; no new grace until reset |
| inquiry fence | One replaceable fixed 10-second timer; stale identities are inert |
| decision window | Automated XML decision prompt in flight / re-ask; ordinary tools stay stable but calls are blocked |

**Unconditional assignment:** manual lock/unlock **never** no-op on same-state. They always assign the target state. A direct manual unlock emits its corresponding TUI output; a manual lock emits only its final lock notification. The silent prerequisite unlock of a fresh lock cycle never emits unlock output. No “already locked/unlocked” short-circuit may skip either transition.

**Fresh lock-cycle transition (manual lock or actual main user-role message start):**

1. Capture the exact current-main ownership claim.
2. Assign unlocked first.
3. Cancel every timer, clean pending finalization/decision state, and clear pending AI-unlock publication intent by dispatching the normal **non-notify** unlock cleanup effects.
4. Revalidate the same exact ownership claim after any awaited or re-entrant cleanup effect. A stale/demoted owner stops here without locking or notifying.
5. Assign a fresh lock, resetting attempt and `waitUntilMs` to `0` and clearing exhaustion, decision-failed, and invalid/no-result accounting.
6. Dispatch lock effects and reconcile idle.

Manual `/lock-continue-watchdog` emits exactly one final `Continue watchdog locked` notification. Actual main user-role `message_start` suppresses both prerequisite-unlock and final-lock notifications. This sequence runs even when the watchdog was already unlocked or already locked; fresh lock never fakes cleanup by calling lock alone.

**What performs that full silent-unlock-cleanup → fresh-lock sequence:**

- Actual main user-role message **start of processing** (auto-lock)
- Manual `/lock-continue-watchdog`

**What unlocks without resetting cycle accounting:**

- `/unlock-continue-watchdog [reason]` (human; untyped optional reason)
- Valid decision-window XML with `function=unlock_continue_watchdog`, `reason_type`, and `reason_content`
- Main run actually aborted as Pi reports (reasonless)

Unlock first makes `locked=false`, resets `waitUntilMs` to `0`, then invalidates the current aggregate grace and cleans operational pending decision state while preserving attempt, exhaustion, decision-failed, and invalid/no-result counters. Only fresh lock semantics reset those preserved fields.

**What auto-locks without resetting an already locked cycle:**

- Any current-main `agent_start`; when unlocked it starts a fresh cycle silently, and when already locked it preserves the cycle

**What does not auto-lock / does not reset the main cycle:**

- Merely queued main input (before processing starts)
- Child/subagent user-role messages
- Watchdog decision or continuation turns while the current cycle is already locked
- Invalid or no-result decision re-asks (they do **not** consume shared valid continue/wait attempts)

---

## Decision window protocol

### Entry

**Given** main is locked, not exhausted, not decision-failed, current time is at or after `waitUntilMs`, every same-process attachment is idle, and the authenticated root busy-child set is empty
**When** the latest eligible observation's fixed 10-second fence expires and every wake-time guard still passes
**Then** the plugin:

1. Keeps ordinary active tools and the system-prompt tool list unchanged.
2. Persists a context-excluded `pi-continue-watchdog:inquiry-marker` with the exact protocol version, unique `exchangeId`, and `cycleId`, then sends a **custom-role** message—not a user-role message—whose body is the configured `decisionPrompt` plus a fixed XML suffix, using `{ triggerTurn: true, deliverAs: "steer" }`. If marker persistence fails, the inquiry is not dispatched. The marker is a logical correlation boundary: other plugins may interleave entries between marker, decision prompt, assistant, and fold marker without becoming watchdog-owned. Ordinary tools stay advertised. The live decision assistant may stream in TUI/RPC, but public `message_end` replacement clears its finalized or aborted content from TUI history and persistence. The suffix tells the model to use existing task context, not call tools, put exactly one watchdog block at the response end, never output multiple watchdog blocks, use effective allowed `reason_type` values for continue/unlock, and use an untyped bounded `wait_seconds` for wait. This package does not request `presentation: "hidden"` and does not require a downstream Pi hidden-run API.
3. Blocks every ordinary tool call before execution while the decision is active and returns a reminder to answer from existing context with XML. A blocked call does not itself consume an invalid attempt; final assistant text is authoritative.
4. Does **not** send the rejected direct-continuation message as the idle wake path.

### Validity rules (exactly one trailing XML decision)

Thinking blocks are ignored. Concatenate final assistant text and trim it. It must end with `</watchdog>`, contain exactly one `<watchdog>` and one `</watchdog>`, and parse from the sole opening tag through the suffix. Narration before the XML is allowed. More than one watchdog block is invalid. Unknown extra simple XML keys are ignored only for parser compatibility and are not advertised in model prompts; a recognized field that violates an outcome contract is rejected (notably, `wait_watchdog` rejects `reason_type`).

| Outcome | Requirements |
|---|---|
| Valid **continue** | Sole block contains `function=continue_watchdog`, a `reason_type` allowed by `continueReasonTypes`, and a valid `reason_content` |
| Valid **wait** | Sole block contains `function=wait_watchdog`, a valid `reason_content`, and integer `wait_seconds` in `1..1800`; `reason_type` must be absent |
| Valid **unlock** | Sole block contains `function=unlock_continue_watchdog`, a `reason_type` allowed by `reasonTypes`, and a valid `reason_content` |

**AI `reason_type` validation:**

- AI type is trimmed, then compared **case-insensitively** by lowercasing against each trimmed configured type
- On match, emit/display the **uppercase** form of the **matched configured value** (not a free-form re-casing of the AI input beyond that match)
- Missing, blank-after-trim, or unknown types are **invalid** and count under the existing fixed three invalid attempts total (two re-asks, fail on third)
- Continue and unlock use independent allowed lists; unlock types never authorize continue
- Human `/unlock-continue-watchdog` has no typed XML field and is unchanged

**AI `reason_content` validation (continue, wait, and unlock):**

- After trim, reason must be **non-empty**
- Length ≤ **500 Unicode characters** (count Unicode code points / characters as implemented consistently and tested)
- May technically contain newlines
- Empty/blank or overlong reasons are **invalid** (no truncation on the AI path)
- Existing reason rules remain; they are independent of type matching

**Wait `wait_seconds` validation:**

- After trim, the field must contain decimal digits representing a safe integer in `1..1800`
- Missing, blank, fractional, signed, zero, or out-of-range values are invalid
- Invalid values are re-asked; they are never silently clamped
- Wait rejects any supplied `reason_type`; it neither consults nor persists one

**Invalid includes:** a completed decision response with missing/malformed XML; no or multiple watchdog blocks; non-whitespace after the closing block; unknown function; duplicate required keys; missing/blank/unknown required `reason_type`; any `reason_type` supplied to wait; invalid `reason_content`; or invalid/missing wait fields. A provisional Provider error that Pi retries within the same run is not a completed response and does not consume an invalid attempt.

### Invalid → re-ask (fixed 3)

On invalid decision:

1. Immediately re-ask with another decision prompt.
2. The next prompt includes the **exact previous error** and explains why the response was invalid.
3. Re-asks keep ordinary tools unchanged, continue blocking tool execution, and repeat the fixed XML suffix contract.
4. Invalid checks **do not** consume the `maxRetries` valid continue/wait budget.
5. After the **third** invalid attempt:
   - append a terminal fold marker so the complete failed exchange leaves future model context
   - remain **locked** and enter **decision-failed** (no new grace)
   - TUI warning exactly:
     `Continue watchdog decision failed after 3 attempts: <last error>`
   - New actual root user message start or manual `/lock-continue-watchdog` resets failures/attempts and re-arms the cycle

### Valid unlock

**When** the decision is a valid unlock:

- Set unlocked first; then cancel timers and clean operational decision state while preserving attempts/failures
- Append exactly one muted **persisted TUI-only** AI unlock entry, `Continue watchdog unlocked · <TYPE> · <reason>`, where `<TYPE>` is the matched configured type uppercased and `<reason>` is the validated reason (user-visible history, not model-bound as ordinary assistant prose)
- Do **not** also emit a transient reasoned unlock notification
- **No further work turn** is started for that unlock decision
- Pi's extension `message_end` captures the validated original decision for audit/finalization, then replaces the finalized assistant with empty content. Live TUI/RPC may have streamed the decision before completion. Future model-bound context then removes the entire exchange and inserts nothing.
- **Future model-bound context** removes the **entire** decision exchange (prompt, redacted assistant/tool-result metadata, re-asks, and fold marker) and **inserts nothing** in its place
- A context-excluded `pi-continue-watchdog:decision-audit` CustomEntry preserves only the structured validated outcome; Pi does not project CustomEntry into Agent/provider context

### Valid continue

**When** the decision is a valid continue:

- Requires a type allowed by `continueReasonTypes` and a nonblank reason of at most 500 Unicode characters
- The matched type and validated reason are retained in context-excluded audit data
- The decision turn ends, and ordinary work continues automatically without further user input
- extension `message_end` captures the provider XML for validation and replaces the finalized assistant with empty content; context folding then removes the complete prompt / assistant and tool-result metadata and replaces them with **one** compact custom message containing the configured `continuePrompt` (exact default: `Continue until user assistance is required.`)
- show a live colored TUI widget with `Continue watchdog checking` and the current decision cycle while the check is active; clear it on terminal continue, unlock, failure, abort, or cleanup
- persist a colored TUI-only event card for each watchdog validation re-ask with its safe parser error and cycle number; persist non-watchdog failures as `Other error` with the original error content
- append exactly one persistent TUI-only entry with exact text `Continue watchdog continued · <TYPE> · <reason>`, so repeated automatic continuation remains observable without entering model context
- persist that entry before publishing `watchdog-continued`, then dispatch continuation; if persistence fails, fail closed with neither hook nor automatic continuation turn
- semantic listener absence/failure is best-effort and never gates continuation after persistence succeeds
- The continued ordinary turn receives exactly one compact model-bound message containing `continuePrompt`; the XML decision exchange is otherwise removed from later context
- Consumes **one** valid outcome attempt
- The next authoritative aggregate all-idle generation uses the same fixed grace
- After `maxRetries` combined valid continue/wait outcomes, remain locked/exhausted with no further inquiry until reset

### Valid wait

**When** the decision is a valid wait:

- Requires a nonblank `reason_content` of at most 500 Unicode characters, integer `wait_seconds` in `1..1800`, and no `reason_type`; a supplied `reason_type` is invalid
- Consumes **one** shared `maxRetries` attempt while keeping the watchdog locked
- Records the absolute deadline `waitUntilMs = now + wait_seconds * 1000`
- Appends exactly one persistent TUI-only entry, `Continue watchdog waiting · <seconds>s · <reason>`, before arming the deadline; if persistence fails, roll back the consumed attempt/deadline and stop without scheduling the wait
- Ends the decision without starting an ordinary continuation turn
- Folds the complete decision exchange to nothing in future model-bound context
- Suppresses automatic inquiry while current time is before `waitUntilMs`; renewed activity cancels stale timer identities and later idle requalifies against both the absolute deadline and the normal fixed fence
- Unlock or a fresh lock clears `waitUntilMs` to `0`; cleared/stale callbacks are inert
- If this wait consumes the final attempt, the controller may already be exhausted, but terminal `EXHAUSTED` publication waits until the complete deadline expires

### Human `/unlock-continue-watchdog [reason]`

Always assigns `locked=false` first, resets `waitUntilMs` to `0`, then cancels timers and cleans operational decision state while preserving cycle accounting—even if already unlocked. The human command remains **untyped**: no `reasonType` argument, no type matching, and no AI typed TUI format.

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
- it first assigns unlocked and dispatches full non-notify unlock cleanup: cancel stale timer/finalization/decision work and clear pending AI-unlock publication intent
- after revalidating the exact claim, it assigns a fresh lock; attempt and `waitUntilMs` reset to `0`, and exhaustion, decision-failed, and invalid/no-result counts clear
- both prerequisite-unlock and fresh-lock notifications are suppressed
- it reconciles idle after locking
- if ownership becomes stale/demoted during prerequisite cleanup, it stops before fresh lock and emits no notification
- child-session user messages do **not** change main lock or attempts
- merely queued (not yet started) main input does **not** lock or reset

### Example 2 — Manual lock silently cleans up through unlock first, then locks and notifies once

**Given** main is locked or unlocked, including with an open decision, pending timer/finalization, exhausted/decision-failed state, invalid accounting, or pending AI-unlock publication intent
**When** the human runs `/lock-continue-watchdog`
**Then**

- it captures and fences the exact current-main claim
- it first assigns unlocked and dispatches the normal non-notify unlock cleanup effects before any fresh-lock transition or lock effect
- no prerequisite `Continue watchdog unlocked` notification or reason entry is emitted
- after revalidating the same claim, it assigns a fresh lock and dispatches lock effects
- attempts and `waitUntilMs` reset to `0`; exhaustion, decision-failed, and invalid/no-result accounting clear; timers and pending operational decision/finalization state are gone; normal tools are restored; pending AI-unlock publication intent is cleared
- TUI notifies exactly once: `Continue watchdog locked`
- idle is reconciled after locking
- already-unlocked and already-locked starting states both execute the full unlock-cleanup → lock sequence
- if ownership becomes stale/demoted during prerequisite cleanup, it stops before lock effects and notification

### Example 3 — Manual unlock with optional reason (untyped regression)

**Given** main is locked or unlocked, with or without a pending aggregate grace, wait deadline, or decision window
**When** the human runs `/unlock-continue-watchdog` with empty/blank reason
**Then**

- `locked=false` is assigned first and `waitUntilMs=0`; timers and pending operational decision work are then cancelled; attempts/failures are preserved
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

- apply the same unconditional state transition as reasonless `/unlock-continue-watchdog`: assign `locked=false` and `waitUntilMs=0` first; then cancel timers/operational decision state; preserve cycle accounting and failures
- TUI notifies exactly `Continue watchdog unlocked`, even when already unlocked
- no unlock reason entry is appended
- process that aborted run once (no duplicate unlock notification for the same abort)

**And when** the run ends for any non-aborted reason, or abort cannot be attributed to that run, the plugin does not auto-unlock.

Ordinary natural idle settle never counts as abort.

### Example 4b — Interactive or RPC input preempts a submitted watchdog decision

**Given** a submitted watchdog decision is running
**When** interactive or RPC user input arrives
**Then**

- the original user message is admitted exactly once and is not re-sent by the watchdog
- the watchdog decision is aborted and folded as `preempted` using the inquiry marker's exact exchange/cycle identity
- the aborted decision assistant is cleared and does not remain in later model context; unrelated interleaved plugin entries are preserved
- TUI/session show neither `Operation aborted` nor `Continue watchdog unlocked` for that preemption
- lock remains; the user message start begins a fresh lock cycle
- at true idle, only an empty `stop` assistant carrying the exact `pi-continue-watchdog:preempted` marker inside that inquiry boundary may be spliced; session startup while idle retries the same exact cleanup after a prior process exit
- a later ordinary Esc/abort of the user-owned run still unlocks reasonlessly

### Example 5 — Locked + authoritative aggregate idle → fixed-grace **decision entry**

**Given** main is locked, not exhausted, not decision-failed, current time is at or after `waitUntilMs`, every observable attachment is idle, and the root busy-child set is empty
**When** the latest eligible observation's fixed 10-second fence expires and every wake-time guard still passes
**Then**

- exactly one decision window is opened for that attempt (not a direct continue custom message)
- ordinary active tools and the system-prompt tool list stay unchanged; attempted tool calls are blocked before execution with an XML reminder
- a **custom-role** decision message uses configured `decisionPrompt` plus the fixed XML suffix, identifies itself as extension automation, states it is not a user message/request, explicitly forbids making decisions on the user's behalf, lists effective `reasonTypes` and `continueReasonTypes`, includes the bounded untyped wait form, and is never injected with user role
- the model may narrate before XML or output only XML, but the trimmed response must end with exactly one watchdog block; multiple watchdog blocks are invalid
- the rejected direct-continuation default
  `Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.`
  is **not** used as the idle wake message
- the rejected untyped decision default that asked only for a concise reason without an allowed `reasonType` is **not** used

With defaults, every eligible all-idle generation waits **10s**.

### Example 6 — Valid continue: fold, compact prompt, retry consumption

**Given** a decision window is open with default `continueReasonTypes`
**When** the main agent returns `continue_watchdog` with type `verifying` and reason `Tests still need to run.`
**Then**

- type normalizes to `VERIFYING`; the validated type and reason are written into decision audit
- one muted TUI-only entry is durably appended first: `Continue watchdog continued · VERIFYING · Tests still need to run.`
- then one neutral `watchdog-continued` hook publishes `REASON_TYPE=VERIFYING` and `REASON=Tests still need to run.` best-effort
- only after durable evidence does the decision turn end and ordinary work continue automatically without further user input
- model-bound context removes the full decision exchange and inserts one compact custom message equal to configured `continuePrompt` (default `Continue until user assistance is required.`)
- one shared valid outcome attempt is consumed
- after the continuation settles, if still locked and aggregate idle, the **next generation** waits the same fixed grace
- if durable continue entry persistence fails, no hook or continuation is dispatched; hook listener failures alone do not gate continuation

### Example 6b — Valid wait: no work turn, absolute deadline, shared retry consumption

**Given** a decision window is open and the current clock is `10_000`
**When** the main agent returns `wait_watchdog` with reason `Waiting for CI.` and `wait_seconds=300`
**Then**

- no `reason_type` is accepted, consulted, displayed, or persisted for the wait; supplying one is invalid
- the validated wait audit records reason `Waiting for CI.` and `waitSeconds=300`
- one muted TUI-only entry is durably appended first: `Continue watchdog waiting · 300s · Waiting for CI.`
- no ordinary continuation turn starts
- model-bound context removes the full decision exchange and inserts nothing
- one shared retry is consumed, the watchdog remains locked, and the absolute deadline is `waitUntilMs=310_000`
- no automatic inquiry starts before that deadline
- activity during the wait cancels its current timer identity; after activity returns idle, scheduling still honors the same absolute deadline and the fixed idle fence
- unlock or fresh lock clears the deadline, and a cleared callback cannot open a decision or publish `EXHAUSTED`
- if the wait entry cannot be persisted, the retry/deadline commit is rolled back and no wait is scheduled
- if this wait consumes the final retry, `EXHAUSTED` is published only after the complete wait expires

### Example 7 — Valid AI unlock: typed muted entry, fold to nothing, no further work turn

**Given** a decision window is open with default `reasonTypes`
**When** the main agent returns a valid `unlock_continue_watchdog` with mixed-case type `job_done` and reason `All requested package bumps are merged.`
**Then**

- `locked=false`; timers and operational decision state cancelled; attempts/failures preserved
- type matches case-insensitively to configured `JOB_DONE`; display/emit uses uppercased matched configured value `JOB_DONE`
- no transient reasoned unlock notification is emitted
- exactly one muted TUI-only entry is appended: `Continue watchdog unlocked · JOB_DONE · All requested package bumps are merged.`
- **no further work turn** starts from that unlock decision
- future model-bound context removes the entire decision exchange and inserts **nothing**
- raw session contains a context-excluded structured audit CustomEntry with the validated `reason_type` and `reason_content`, but no assistant XML content

**And when** config sets `reasonTypes: ["NeedReview", "shipped"]` (replacing, not extending, the default list)
**And** the agent unlocks with mixed-case type `needreview` and reason `PR is open for human review.`
**Then**

- type matches configured `NeedReview` case-insensitively
- muted TUI-only entry is exactly: `Continue watchdog unlocked · NEEDREVIEW · PR is open for human review.`
- default types such as `JOB_DONE` are **not** accepted while this custom list is effective

### Example 8 — Invalid or no-result decision re-asks then decision-failed

**Given** a decision window is open
**When** the model responds invalidly (missing or malformed watchdog XML, multiple watchdog blocks, trailing text after the block, unknown function, missing/blank/unknown required `reason_type`, a `reason_type` supplied to wait, empty/overlong `reason_content`, or missing/non-integer/out-of-range `wait_seconds`) **or the decision turn truly settles without any verifiable response**
**Then**

- immediately re-ask with a prompt that includes the exact previous error and explains invalidity
- ordinary tools remain unchanged and execution stays blocked during the re-ask
- invalid type and invalid reason both count under the same fixed three invalid attempts total
- invalid re-asks **do not** advance the shared valid continue/wait attempt and do not count toward `maxRetries`

**When instead** a Provider error occurs and Pi successfully retries the same decision run
**Then** accept the successful retry response without recording an invalid decision or opening a duplicate re-ask

**When** the third consecutive invalid decision occurs
**Then**

- append a terminal fold marker that removes the complete failed exchange from future model context
- remain locked; decision-failed; no new grace
- TUI warning exactly: `Continue watchdog decision failed after 3 attempts: <last error>`
- only actual main user message start or `/lock-continue-watchdog` clears decision-failed and resets the cycle

### Example 9 — Activity during delay cancels; full delay restarts

**Given** a pending fixed grace for the current authoritative aggregate all-idle generation
**When** any observable session becomes busy before the timer fires
**Then** that timer is cancelled and must not open a decision window

**When** all observable sessions are idle again
**Then** the **full** delay for the **same** current attempt restarts from zero

At every relevant event, only that event's live public `ctx.isIdle()` query may update attachment state. Equal observations still replace the timer. There is no periodic polling; the only query without a new event is the mandatory wake-time recheck. A false-idle settle caused by a nested turn must not arm; a later live-idle event may arm normally.

Stale timer callbacks (wrong generation/epoch/ownership or cleared by busy/unlock/fresh-lock cleanup) must not open a decision window, wake main, or publish terminal state.

For a valid wait, renewed activity cancels the current wait-qualified grace. When all observable sessions become idle again, the replacement timer targets the later of the existing absolute `waitUntilMs` and a complete fresh 10-second fence; activity does not create a new wait duration.

### Example 10 — Exhaustion after max valid continue/wait outcomes

**Given** default `maxRetries = 10` and 10 combined **valid continue or wait** outcomes have already been consumed in this lock cycle
**When** main remains locked and all observable sessions become idle again
**Then**

- no further aggregate grace is scheduled after any active final-wait deadline
- state remains **locked and exhausted**
- when the tenth outcome is a wait, the full wait remains active and terminal `EXHAUSTED` is not published before its deadline
- a new actual main user message start or manual `/lock-continue-watchdog` resets attempts and clears exhaustion
- human unlock and (after a future re-arm) decision unlock still work per Examples 3 and 7

### Example 11 — Terminal automatic stop publishes neutral `user-ready`

**Given** the elected main attachment observes a new aggregate-idle epoch
**And** the watchdog has finished every automatic action it can take for that epoch
**When** the terminal stop is one of:

1. Valid AI decision unlock with validated `reason_type` and `reason_content`
2. Max valid continue/wait attempts exhausted, with any final wait deadline reached
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

**And** it does **not** publish for human `/unlock-continue-watchdog` (with or without reason), canonical/manual/user abort unlock, initial ordinary unlocked idle, valid continue, a valid wait before its deadline, intermediate decision/settled states, locked normal/pending grace, stale/demoted/reloaded ownership, or repeated settled/reconcile in the same terminal epoch.

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
- ordinary active tools remain unchanged across decision, demotion, and shutdown
- no orphaned wakes after demotion/shutdown


### Example 13 — Trusted config overrides with safe fallback

**Given** global and/or trusted-project `pi-continue-watchdog.json`
**When** valid `maxRetries`, `decisionPrompt`, `continuePrompt`, `reasonTypes`, and/or `continueReasonTypes` are provided
**Then** effective config uses field-level override (trusted project over global over defaults). The deprecated `idleDelaySeconds` key may be parsed/preserved for compatibility but never changes the fixed 10-second runtime fence.
**And** each valid reason-type list independently replaces its built-in default rather than extending it

**When** values are missing, unreadable, or invalid
**Then** retain valid lower-precedence values / defaults and emit bounded diagnostics (no crash, no silent use of nonsense numbers that would fire immediately in an unbounded way)
**And** invalid `reasonTypes` or `continueReasonTypes` (empty array, non-array, or any blank-after-trim entry) do not erase the corresponding valid lower-precedence/default list

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
- intermediate settles while any observable attachment remains busy arm **no** main inquiry; only after the final busy attachment settles and the fixed 10-second fence expires with every observable attachment still idle may the current main open **exactly one** inquiry

**Minimal multi-attachment idle shape:**

**Given** one UI root and two headless children are all initially busy on the shared domain
**When** the root settles, then the first child settles
**Then** the root opens **no** decision inquiry and neither child opens an inquiry

**When** the final child settles and the fixed 10-second fence expires with every observable attachment still idle
**Then** the root opens **exactly one** decision inquiry and children still open none

This example covers same-realm module-evaluation sharing only. Authenticated watchdog-loaded child processes are covered by the authoritative process-domain acceptance below; children that do not load the watchdog or do not inherit the declaration remain outside observable coverage. This example does **not** change pure-headless election or require another plugin.

---

## Pi limitations (document in README; behavior-level)

These are product constraints, not optional polish. Implementation details are replaceable:

| Limitation | Observable implication |
|---|---|
| Context folding is model-bound | Future model requests drop/replace the decision exchange; persisted structured audits are CustomEntry records excluded from Agent/provider context |
| Ordinary tools remain advertised during decisions | Prompt/tool prefixes stay stable; the extension blocks execution until the final XML decision arrives |
| Unlock and wait end the decision path without starting more work | Valid unlock must not start a further ordinary work turn; valid wait must remain locked and only arm its deadline |
| Raw session is append-only | Automated prompt, assistant/tool-result metadata, and fold-marker records may remain on disk, but complete terminal exchanges are folded before provider requests; raw assistant XML and invalid answer text are not retained |
| XML extraction is suffix-based | Narration may precede the sole watchdog block; multiple watchdog blocks or trailing non-whitespace are invalid |

---

## Delivery and safety invariants (cross-cutting)

| Invariant | Requirement |
|---|---|
| No tool cancellation | Decision entry / continue delivery must not abort in-flight tools already running when idle is detected |
| No false “all agents” claims | Docs and diagnostics say **observable** same-process plus authenticated watchdog child-process coverage |
| Generation-safe timers | Timer callbacks must not fire after unlock/demote/ownership change |
| Command demotion safety | If main demotes, stale command handlers must be inert |
| Notify channel | Lock/unlock/decision-failed notifies are TUI user-only; not injected as user-role conversation turns |
| Abort truthfulness | Unlock on actual Pi-reported main abort only; never on ordinary natural settle |
| No context pollution from decisions | Future model-bound context never keeps the raw decision exchange after valid unlock/continue/wait handling |
| No persistent decision tool | Outside the decision window, `unlock_continue_watchdog`, `continue_watchdog`, and `wait_watchdog` are not part of the normal always-on tool set |
| No other-plugin coupling | No imports or runtime detection of pi-subagents / pi-watchdog / pi-notify |

---

## Explicit non-examples (do not implement as v1)

- **Rejected prior design:** idle → visible continue custom message while normal tools remain and unlock stays always registered
- Auto-unlock when the model says “done” in prose without a valid trailing unlock XML block
- Inferring main from package names or foreign plugin state
- Persisting lock in session JSON / disk
- Counting only root idle and ignoring observable children (or the reverse)
- Silent same-state lock/unlock (no TUI notify)
- Inferring abort from ordinary idle settle
- Configurable invalid re-ask budget (must stay fixed at 3)
- Counting invalid re-asks against the shared continue/wait `maxRetries` budget
- Failing to remove the active XML decision gate after unlock, continue, wait, decision-failed, demote, or shutdown

---

## Acceptance evidence expectations

For each example above, implementation slices must leave evidence that can be re-run:

- **Unit / component:** pure state machine (including decision-failed, continue/wait attempt advancement, wait deadline reset, and rollback rules), config precedence including `reasonTypes` replace semantics, XML suffix extraction and exactly-one-block validation, AI type case-insensitive match + uppercased matched configured value, wait seconds `1..1800` strict validation, reason trim/truncate/length (AI no-truncation vs human truncate), aggregate-grace cancel/restart with absolute not-before deadlines, stale timer guards, and decision validity matrix
- **Integration / E2E (stock Pi, packed install):** auto-lock on real main user message start; command lock/unlock notifies and optional untyped reason; ordinary-tool stability with XML decision prompts; at least one real fixed-grace path into a decision window; structured CustomEntry audit excluded from context; continue/wait/unlock/three-invalid/error/abort/user-takeover paths return to idle within bounded time; wait persistence failure rolls back; unlock clears wait deadlines; persisted session resume sends no watchdog question, answer, audit, or fold marker to the provider; delayed `AI_UNLOCK` user-ready while a child is busy; final-wait-delayed exhaustion or multi-attempt accounting (real or injected clock, documented)
- **Human accept:** product authority reviews evidence against this file; AI does not self-accept

**Contract status:** this file remains the accepted **behavior** contract. Implementation history is preserved in Git.

## Authenticated cross-process acceptance (authoritative)

1. A Pi with no `PI_EXTENSION_UTILS_PROCESS_DOMAIN` declaration creates the root transport during awaited `session_start`, records its PID in `PI_CONTINUE_WATCHDOG_ROOT_PID`, and is the sole decision owner while that domain is open.
2. A child Pi inheriting the declaration connects as an observer. It reports its watchdog-owned busy/idle state but never loads root watchdog config, locks, inquires, continues, unlocks, or publishes `user-ready`.
3. Same-realm watchdog attachments aggregate into one transport node. Local hub election chooses the root-process main attachment. Final root detach closes the transport and clears only the declaration/root marker values it still owns.
4. `pi-extension-utils` owns authenticated framed loopback TCP transport, peer status, heartbeat liveness, and fixed 1-second reconnect retries. Watchdog business payload contains exactly `agentId` and `idle`; authenticated sender identity must match `agentId`.
5. Root maintains a deduplicated busy-child ID set. `idle:false` adds; `idle:true` and disconnect delete. Connection alone is neutral. Every accepted report and disconnect creates a new fence even when the resulting state is unchanged.
6. Every relevant child lifecycle event queries that child's live `ctx.isIdle()` before reporting. After reconnect the child immediately queries and reports live state; stale state is never replayed.
7. Fence/epoch change during a decision cancels its shared inquiry handle without consuming retry accounting. The result cannot continue, unlock, exhaust, decision-fail, persist continue evidence, or publish `user-ready`; the retryable remove-fold cleans its exchange.
8. Every automatic outcome commits only while the root claim remains current, the latest root fence confirms, the busy-child set is empty, pending messages are absent, and a fresh main `ctx.isIdle()` is true. Manual commands and immediate main-abort unlock retain their explicit semantics.
9. Initial malformed declarations, wrong capabilities, unavailable transport, incompatible protocol, and unsafe endpoints fail closed with sanitized output and status 78. Runtime heartbeat disconnect counts the child idle while transport reconnects; it never creates a business-level uncertain state. No capability, proof, raw declaration, or endpoint is rendered.
10. Coverage begins after an inherited child loads watchdog, completes `session_start`, and reports activity. Deliberately stripped/replaced declarations and children without watchdog remain outside observable coverage.
11. User input or renewed external activity terminally cancels the current shared attempt. Interactive/RPC input calls public `ctx.abort()` and returns `{action:"continue"}` so Pi delivers the original input exactly once. Uninterruptible `message_end` neutralizes the exact correlated assistant, and failed remove-fold sends are retried idempotently until accepted.
