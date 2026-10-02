# Acceptance contract — pi-continue-watchdog

**Status:** Accepted product contract for the **unlock-tool + direct-continuation** redesign (2026-09-30)
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

This contract supersedes the XML decision-inquiry protocol. The current design uses one always-registered unlock tool plus direct continuation at idle.

| Rejected design | Current design (required) |
|---|---|
| Hidden XML decision question answered with a trailing `<watchdog>` block | One model-visible tool, `unlock_continue_watchdog`, called by the agent to stop |
| Three outcomes (continue/wait/unlock) chosen by the model | The model either calls the unlock tool or is continued automatically |
| Wait outcome with bounded `wait_seconds` and completed-wait timing events | Waiting happens inside the agent's own turn: monitor the task or sleep the estimated duration |
| Invalid-response re-asks (fixed 3) and `DECISION_FAILED` | Invalid tool arguments fail as ordinary tool errors; the model retries naturally |
| Typed continue reasons and `continueReasonTypes` | Continuation carries no model reason; the key is removed |
| Hidden `decisionPrompt` with a fixed XML suffix | The continuation body carries the guidance; the key is removed |

Any acceptance text, test name, README, or implementation that still requires the XML inquiry is stale.

---

## Story

| | |
|---|---|
| **Actor** | A human driving Pi with a root main agent and watchdog-loaded same-process or authenticated child Pi sessions |
| **Need** | The main agent stops the cycle by calling the `unlock_continue_watchdog` tool when work is complete or the user is needed; otherwise, after all observable agents go idle, automatically continue the work without the human retyping “continue” |
| **Value** | Reduces stalled sessions after subagents finish; native tool-call reliability replaces an XML protocol the model produced unreliably; the tool list never changes so the prompt-cache prefix stays stable |
| **In scope (v1)** | Runtime lock; auto-lock on actual main user work; manual lock/unlock (optional reason); automatic unlock when the main run is actually aborted as Pi reports; one always-registered `unlock_continue_watchdog` tool with typed reason and validation; direct automatic continuation at qualified idle with the fixed fence; typed AI unlock reasons; exhaustion after `maxRetries` continuations; one fixed grace per authoritative aggregate all-idle generation; shared canonical continuation and exhaustion event timeline with runtime-authored local-offset RFC 3339 timestamps; authenticated cross-process child activity, neutral connect/disconnect-as-idle, fixed 1-second reconnect with fresh live reports; legacy session readability; config; packaging/CI/publication |
| **Out of scope (v1)** | Durable lock across reload/new/resume/restart; sessions that did not load the watchdog; depending on pi-subagents or any other plugin; replacing Pi footer; wall-clock or loop-count watchdogs (those belong to pi-watchdog); a watchdog-level wait outcome (agents wait inside their own turn) |

---

## Product surface (fixed names)

| Surface | Exact name / text | Who / channel |
|---|---|---|
| Lock command | `/lock-continue-watchdog` | Human (TUI) |
| Unlock command | `/unlock-continue-watchdog [reason]` | Human (TUI); reason optional; **untyped** (no `reasonType`) |
| Status command | `/status-continue-watchdog` | Human (TUI); read-only trigger diagnosis |
| Unlock tool | `unlock_continue_watchdog` with `reason_type` and `reason` | Model-visible tool, registered once per root process; never unregistered |
| Default `continuePrompt` | `Continue until user assistance is required.` | Configurable guidance embedded verbatim in the fixed model-visible continuation body |
| Default `reasonTypes` | `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, `WAIT_CALLBACK` | Built-in allowed unlock-tool type list; a valid configured list **replaces** this default |
| Shared continuation event heading | `Continue watchdog continued · <RFC3339 timestamp>` | One persistent canonical body for human history and model context; durable before semantic publication and continuation dispatch |
| Shared exhausted event heading | `Continue watchdog exhausted · <RFC3339 timestamp>` | One canonical terminal-idle body; starts no work turn |
| Continued semantic hook | `watchdog-continued` with no values | Neutral plain-data best-effort hook after durable continuation evidence |
| Lock TUI notify | `Continue watchdog locked` | User-only TUI notify |
| Unlock TUI notify (no reason) | `Continue watchdog unlocked` | User-only TUI notify (human reasonless / abort) |
| Human unlock TUI-only entry (with reason) | `Continue watchdog unlocked · <reason>` | Muted persistent user-only history entry; human path remains untyped |
| Terminal-error auto-unlock TUI notify | `Continue watchdog unlocked · run ended in error` | User-only TUI notify; automatic when the settled main run's terminal assistant reports `stopReason: "error"` |
| Terminal-error auto-unlock TUI-only entry | `Continue watchdog unlocked · run ended in error (automatic unlock)` | Muted persistent user-only history entry; distinguishes the automatic unlock from a manual one |
| Main-run abort unlock | same behavior as reasonless `/unlock-continue-watchdog` | Automatic when Pi reports the main run as aborted |

Correct all accidental `cointinue` spellings; public names use `continue` only.

### Built-in default `reasonTypes` meanings

| Type | Meaning |
|---|---|
| `JOB_DONE` | All work is complete |
| `WAIT_USER` | User input, approval, or action is required |
| `JOB_BLOCKED` | Work remains unfinished and cannot proceed for a non-`WAIT_USER` blocker |
| `WAIT_CALLBACK` | Waiting for another agent or program to call back and wake the agent (for example an async subagent completion) |

Configured type lists may use ordinary nonblank UTF-8 text. Trust sane user config; do **not** impose identifier-format regexes, artificial length/count caps, or collision hardening beyond the validation rules below.

### Exact default `continuePrompt`

```text
Continue until user assistance is required.
```

`continuePrompt` is configurable guidance, not the complete provider-bound message. At continuation time the runtime embeds it verbatim in the canonical shared event body that identifies the pi-continue-watchdog extension as the source, states that the message is not from the user and is not user approval, confirmation, consent, or authorization, notes that the agent ended its turn without calling `unlock_continue_watchdog`, instructs the agent to call the tool now if all work is complete or user input is required, otherwise continue the remaining work, and to wait by blocking on or monitoring the task or sleeping the estimated duration. The event permits only previously requested and authorized work. Pi may serialize the custom message with provider-facing user role; the human renderer and provider receive the same immutable stored body.

---

## Scope and classification rules

1. **“All agents idle”** means every extension-loaded attachment in the process-local hub and every authenticated watchdog-loaded child Pi process that has joined the inherited process domain is idle. Sessions that did not load the watchdog or did not inherit the declaration may be absent; document this as **observable coverage**, never “all agents in the universe.”
2. **Main/root election** (root-process local, no other plugin):
   - UI-bound session wins main when present.
   - Pure headless: first-bound attachment is documented best-effort main; later attachments are treated as non-main.
3. **Only main** gets automatic continuation. The unlock tool is registered in every root process (so the tool list never changes), but its unlock effect applies only to the current main. Non-main attachments remain observer-only.
4. **Zero external-plugin dependencies.** Use only Pi public extension APIs plus this plugin’s own same-process hub and authenticated process-domain coordinator.
5. **Lock state is runtime-only** for the current process/session attachment lifecycle. Not written to disk. Not restored on reload/new/resume/restart/shutdown.
6. **Universal main-run coverage.** Every current-main `agent_start` ensures the watchdog is locked. If already locked, the existing cycle is preserved; watchdog decision and continuation turns do not reset themselves. If unlocked, the start silently begins a fresh lock cycle.
7. **Abort unlock.** When the current main run is **actually aborted as Pi reports** (the same outcome the TUI shows as aborted), unlock reasonlessly and immediately. Ordinary natural settle does **not** unlock. Never inspect or infer why a child stopped. Implementation may inspect Pi’s public session history to detect the main aborted outcome; the detection mechanism is replaceable as long as this behavior holds.
8. **Three-outcome idle recovery.** A settled non-aborted main run resolves by the terminal assistant message's `stopReason` after Pi's automatic retries are exhausted. Normal completion enters the standard idle fence and one direct automatic continuation while the cycle is locked with budget remaining. A terminal failure (`stopReason: "error"`) unlocks automatically with a clear notification and a record distinguishable from a manual unlock—there is no healthy trajectory to resume, and no idle fence or continuation starts. While Pi is still retrying, the run is busy and no outcome is considered. The plugin classifies only the terminal `stopReason`; it never matches error strings or special-cases compaction. Actual user aborts keep rule 7's immediate unlock and never pass through this gate. A run ended by the unlock tool is an ordinary settled run whose cycle is already unlocked, so no continuation follows.
9. **Live public AI activity.** Every relevant Pi event queries live `ctx.isIdle()`. Event labels never assign or imply busy/idle. Pi's public value covers active runs, automatic retries, auto-compaction retries, and queued continuations.
10. **One shared automatic-event timeline.** Each automatic continuation and retry-exhaustion result has one immutable canonical body visible to the human and supplied to the model through normal active-branch conversation context. Human styling may wrap or color it but may not omit fields or independently reformat it. New production code does not reconstruct a separate watchdog-only result list. An unlock-tool stop publishes no event message: the tool call and result are the record.
11. **Runtime-authored timing.** Every new shared event body freezes its creation time as RFC 3339 with milliseconds and an explicit numeric UTC offset.
12. **Internal protocol isolation and compatibility.** New sessions produce no hidden prompts, XML answers, re-asks, or fold markers. Pre-upgrade inquiry records stay excluded from provider context through read-only folding; TUI-only records and old optional `watchdogResult` metadata remain readable but are not rewritten, backfilled, timestamped, or used to restore timers. Pi's active branch and compaction behavior is authoritative for new shared events.

---

## Defaults and configuration

| Key | Default | Notes |
|---|---|---|
| `idleDelaySeconds` | `10` | Deprecated compatibility key. It remains accepted/preserved, but runtime ignores it; the idle fence is exactly 10 seconds. |
| `maxRetries` | `10` | Automatic continuations per lock cycle; safe integer in `[1, 10]` |
| `continuePrompt` | exact default above | Guidance embedded verbatim in the fixed continuation body; nonblank and at most 16,384 Unicode code points |
| `reasonTypes` | `["JOB_DONE","WAIT_USER","JOB_BLOCKED","WAIT_CALLBACK"]` | Allowed unlock-tool types. A valid configured list **replaces** the default. |
| `jevWaitCheck` | `{enabled: true, model: "jev-latest", confidenceThreshold: 0.8, unlockReviewThreshold: 0.8, timeoutMs: 15000}` | jev wait gate (see below). Fields merge individually; `apiUrl` optional and must be an http(s) URL; `apiKey` is global-only and a project value is ignored with a diagnostic. |

The removed keys `decisionPrompt` and `continueReasonTypes` are **errors**: when present, the extension reports a named error diagnostic and the key has no effect.

**Config locations and precedence** (same pattern as sibling Pi plugins):

1. Built-in defaults
2. Global: `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` (default `~/.pi/agent/pi-continue-watchdog.json`)
3. Trusted project only: `<cwd>/.pi/pi-continue-watchdog.json` when the project is trusted by Pi

Trusted-project fields override global field-by-field (`builtins < global < trusted project`). Invalid high-precedence values must not erase valid lower-precedence values; emit bounded diagnostics. Missing files are silent. Configured prompt limits count Unicode code points without truncation: exactly 16,384 is valid and longer values are invalid. Reason-type list entries are only trimmed and required to be nonblank; they have no identifier regex or artificial per-entry length limit.

**Fence rule:** every candidate automatic continuation cancels/replaces the previous event-loop timer and waits a full fixed 10 seconds. Every relevant event and every child report replaces it, including repeated equal idle reports. Each dispatched continuation advances the shared `maxRetries` attempt.

---

## State model (behavioral)

Per main ownership generation / lock cycle, at least:

| Field / phase | Meaning |
|---|---|
| `locked` | Whether automatic continuation-after-idle is armed |
| `attempt` | Number of automatic continuations consumed in the current cycle (0 after reset) |
| `exhausted` | `locked` and `maxRetries` continuations already consumed; no new continuation until reset |
| idle fence | One replaceable fixed 10-second timer; stale identities are inert |

**Unconditional assignment:** manual lock/unlock **never** no-op on same-state. They always assign the target state. A direct manual unlock emits its corresponding TUI output; a manual lock emits only its final lock notification. The silent prerequisite unlock of a fresh lock cycle never emits unlock output. No “already locked/unlocked” short-circuit may skip either transition.

**Fresh lock-cycle transition (manual lock or actual main user-role message start):**

1. Capture the exact current-main ownership claim.
2. Assign unlocked first.
3. Cancel every timer, clean pending continuation state, and clear pending AI-unlock publication intent by dispatching the normal **non-notify** unlock cleanup effects.
4. Revalidate the same exact ownership claim after any awaited or re-entrant cleanup effect. A stale/demoted owner stops here without locking or notifying.
5. Assign a fresh lock, resetting attempt to `0` and clearing exhaustion.
6. Dispatch lock effects and reconcile idle.

Manual `/lock-continue-watchdog` emits exactly one final `Continue watchdog locked` notification. Actual main user-role `message_start` suppresses both prerequisite-unlock and final-lock notifications. This sequence runs even when the watchdog was already unlocked or already locked; fresh lock never fakes cleanup by calling lock alone.

**What performs that full silent-unlock-cleanup → fresh-lock sequence:**

- Actual main user-role message **start of processing** (auto-lock)
- Manual `/lock-continue-watchdog`

**What unlocks without resetting cycle accounting:**

- `/unlock-continue-watchdog [reason]` (human; untyped optional reason)
- A valid `unlock_continue_watchdog` tool call from the locked current main agent
- Main run actually aborted as Pi reports (reasonless)
- Main run settled with terminal `stopReason: "error"` after Pi's automatic retries are exhausted (automatic, distinct record; no idle fence or continuation)

Unlock first makes `locked=false`, then invalidates the current aggregate grace and cleans operational pending continuation state while preserving attempt and exhaustion counters. Only fresh lock semantics reset those preserved fields.

**What auto-locks without resetting an already locked cycle:**

- Any current-main `agent_start`; when unlocked it starts a fresh cycle silently, and when already locked it preserves the cycle

**What does not auto-lock / does not reset the main cycle:**

- Merely queued main input (before processing starts)
- Child/subagent user-role messages
- Watchdog continuation turns while the current cycle is already locked

---

## Unlock tool protocol

### Registration

**Given** a root Pi process starts a session with the watchdog loaded
**When** the effective configuration is committed
**Then** the plugin registers exactly one model tool, `unlock_continue_watchdog`, with:
- `reason_type`: a string matched case-insensitively after trimming against the effective `reasonTypes`; the matched configured value is emitted uppercase
- `reason`: trimmed, non-empty, at most 1000 Unicode code points

The tool description states that the agent must call this tool to signal that all requested work is complete, that user input, approval, or other user action is required, or that work is blocked without a user action, or that it is waiting for another agent or program to call back and wake it, and that ending a turn without calling it causes the work to be continued automatically. It carries the completeness check shared with the continuation body: before calling, compare every task the user requested in the session, including earlier requests and not only the latest one, with what was actually delivered (delivered, cancelled, or superseded work is not remaining), and keep working instead while requested and authorized work can still proceed. The `reason_type` schema enumerates the effective values and its description explains each built-in one (`JOB_DONE` complete, `WAIT_USER` user action required, `JOB_BLOCKED` non-user blocker); custom values are listed by name. The `reason` description asks for one concise sentence on what was delivered, what the user must do, or what blocks the work. The tool is never unregistered, so the active tool list and system-prompt prefix stay stable. Child Pi processes in the watchdog process domain never register it.

### Execution

**Given** the current main agent calls the tool with valid arguments while the cycle is locked
**When** the call passes or skips the WAIT_USER review below
**Then** the plugin:
1. Unlocks through the same controller unlock semantics as other unlocks, clearing any pending continuation.
2. Returns a short successful result and requests run termination without a follow-up model request.
3. Retains a `user-ready` `AI_UNLOCK` intent with the normalized `REASON_TYPE` and trimmed `REASON`, published once at the terminal aggregate-idle state (publication waits for busy children and process-domain idle confirmation).

**Given** invalid arguments, the tool result is a named constraint error; lock state, attempt accounting, and pending continuation are unchanged, and the model may retry naturally. **Given** a call while unlocked or from a non-main session, the result is informational and publishes nothing. **Given** the tool is called in the same batch as other tools, the unlock still applies and Pi's ordinary batch semantics decide the follow-up.

### WAIT_USER permission review (confirmed 2026-10-02)

Only `WAIT_USER` calls with valid arguments from the locked current main are reviewed, when a key resolves, the shared Jev gate is enabled and fewer than three refusals occurred in this cycle. `JOB_DONE`, `JOB_BLOCKED`, `WAIT_CALLBACK`, custom reasons and human/abort/error paths are unchanged.

The review asks whether this turn's user evidence explicitly grants the exact permission the stop claim is waiting for. It sends four bounded evidence sections from the active branch only: claim; latest real user message plus successful questionnaire answers; visible assistant replies of this turn; tool-name/short-argument trace with result received, error or pending status. Ordinary tool outputs, earlier turns, thinking, system prompt and automated continuation entries are excluded. The resolved key is redacted. Hard 24k Unicode characters: oldest trace dropped first, then assistant and user/answer head/tail truncation with markers. State content is evidence, never reviewer instructions.

**Given** the user said “继续，不用再问” and explicitly authorized implementing the change
**When** the agent calls WAIT_USER to request that same permission and Jev returns `contradicted` with P=0.84
**Then** an ordinary tool error reports `Unlock refused (1/3)`, the lock and continuation attempt count stay unchanged, no `user-ready` or termination is requested, and Pi can follow up to execute the authorized work.

**Given** the user has not selected Postgres or SQLite
**When** a WAIT_USER claim asks for that genuine choice and Jev returns `supported`
**Then** the normal unlock and terminal publication apply.

**Given** three shared refusals in this cycle
**When** a subsequent WAIT_USER tool call or guarded automatic stop occurs
**Then** it passes without another review. A new real user message or lock-cycle restart resets the count. Tool refusals do not spend automatic-continuation attempts; a refused automatic stop spends only the ordinary dispatched continuation attempt.

**When** the answer is uncertain, probability is missing/invalid or below threshold, credentials are absent, the service fails or times out
**Then** accept the stop; never substitute confidence for probability and never retry. Lifecycle/tool cancellation, ownership/cycle/branch changes during the request instead discard it without unlocking or refusing.

### Waiting

When the agent needs to wait for work that will call back and wake it (an async subagent, another program), the guideline and continuation body instruct it to call the unlock tool with `WAIT_CALLBACK`. For any other work, they instruct it to block on or monitor that task directly, or sleep for the estimated duration, inside its own turn. There is no watchdog wait outcome, deadline, or completed-wait event.

---

## Direct continuation protocol

**Given** main is locked, not exhausted, every same-process attachment is idle, and the authenticated root busy-child set is empty
**When** the latest eligible observation's fixed 10-second fence expires and every wake-time guard still passes
**Then** the plugin:

1. Consumes one attempt (`recordAutomaticContinue`), setting exhaustion at the budget.
2. Publishes exactly one visible continuation custom message with `triggerTurn`, whose canonical body carries the runtime timestamp, extension attribution, non-authorization warning, the "ended without calling unlock_continue_watchdog" notice, the configured `continuePrompt`, the completeness check over every requested task including earlier ones, the unlock-or-continue guidance (including the non-user blocker case), the wait-by-blocking-or-sleeping instruction, and the user-boundary stop rule.
3. Correlates the watchdog-owned run through the message's exchange identity so manual unlock can cancel exactly that run.
4. Publishes the `watchdog-continued` hook with no values, only after the durable send: Pi's `sendMessage` is fire-and-forget, so the hook fires when the correlated continuation message reaches `message_start` (Pi appends it to the session at that point) while the claim is still owned, and at most once per exchange.
5. Rolls the attempt back when the send throws, when ownership is lost during the send, or when the run settles while the continuation is still pending-start (Pi's asynchronous send failed before `message_start`). No hook is published for a rolled-back attempt, and a later qualified idle retries.

When the budget is already spent, the existing exhaustion behavior applies instead: one shared exhaustion event and one `user-ready` `EXHAUSTED` envelope, no work turn.

### jev wait gate

After the wake-time guards pass and before step 1, when `jevWaitCheck.enabled` is true, the latest branch entry of the settled run is an assistant message with `stopReason: "stop"` and non-blank visible text, and a key resolves (Pi `typesafe`/`openrouter` credentials, then `TYPESAFE_API_KEY`/`OPENROUTER_API_KEY`, then global `jevWaitCheck.apiKey`; TypeSafe first unless `apiUrl` selects one):

1. Only that text, with the key redacted, is sent as one jev Choice question (`waiting_user` / `not_waiting` / `unclear`). Each assistant entry id is classified at most once per session (revisiting it reuses the same request); a qualification with no resolvable key sends nothing and caches nothing, so a key that appears later still enables the gate.
2. The exact qualified generation (ownership, aggregate activity, grace phase, local activity), a fresh idle probe, the lock, and the classified entry being the branch's latest assistant entry must still hold both after the credential lookup (else no request is sent) and after the request. Tree navigation re-arms the fence without probing idle, because Pi emits `session_tree` while its branch-summary state still reads busy. If any check fails, the verdict is discarded and neither unlock nor continuation follows from it.
3. `waiting_user` with confidence ≥ `confidenceThreshold`: proposes AI unlock. If a tool review refused a stop in this cycle and fewer than three total refusals occurred, this proposal must pass the same WAIT_USER permission review and all live qualification guards again; refusal increments the shared count and dispatches the ordinary continuation, not `user-ready`. Acceptance performs AI unlock without consuming an attempt, one TUI notify, and one `user-ready` with `STOP_KIND=AI_UNLOCK`, `REASON_TYPE=WAIT_USER`, `REASON="jev model judged the final output to be a question for the user: " + last paragraph` (≤ 1000 code points, tail kept behind `…`). No model-visible message is added.
4. Anything else (no key, no text, HTTP/network error, timeout, malformed answer, `not_waiting`, `unclear`, low confidence) proceeds to step 1 unchanged. No retry; shutdown aborts the request.

The gate never runs on the exhaustion, terminal-error, abort, or unlocked paths and adds no fixed delay.

### Shared automatic timeline

New continuation and exhaustion events remain once in normal active-branch conversation order. Each event has one canonical body, built at runtime commit time, that is both human-visible and model-bound. Later turns receive retained events through normal context; no special branch scan, deduplication pass, or `Previous watchdog results` block exists. Every event body contains a runtime-authored RFC 3339 timestamp with milliseconds and an explicit numeric UTC offset. The body is immutable after persistence: redraw, resume, later turns, and host time-zone changes do not regenerate it.

## Confirmed acceptance examples

These examples are the accepted product contract. Each is externally observable through public commands, TUI notifies, tool registration, model-bound context, timers, and install/CI artifacts.

### Example 1 — Current-main starts are covered; actual main user messages start fresh cycles

**Given** the main session is unlocked
**When** any current-main run actually starts
**Then**

- the watchdog silently starts a fresh locked cycle
- the main attachment is marked busy

**Given** the watchdog is already locked with any current attempt or exhaustion
**When** another current-main run starts without a new real user message
**Then**

- the watchdog remains locked
- existing cycle accounting is preserved
- the main attachment is marked busy and any idle delay is cancelled

**When** a **user-role** message actually starts processing on main (not mere queueing)
**Then**

- it first assigns unlocked and dispatches full non-notify unlock cleanup, then a fresh lock; attempt resets to `0` and exhaustion clears
- both prerequisite-unlock and fresh-lock notifications are suppressed
- child-session user messages do **not** change main lock or attempts
- merely queued (not yet started) main input does **not** lock or reset

### Example 2 — Manual lock silently cleans up through unlock first, then locks and notifies once

**Given** main is locked or unlocked, including with a pending continuation, exhausted state, or pending AI-unlock publication intent
**When** the human runs `/lock-continue-watchdog`
**Then**

- it captures and fences the exact current-main claim
- it first assigns unlocked and dispatches the normal non-notify unlock cleanup effects before any fresh-lock transition or lock effect
- after revalidating the same claim, it assigns a fresh lock and dispatches lock effects
- attempts reset to `0`; exhaustion clears; pending continuation work is gone; the unlock tool stays registered
- TUI notifies exactly once: `Continue watchdog locked`
- idle is reconciled after locking

### Example 3 — Manual unlock with optional reason (untyped regression)

**Given** main is locked or unlocked, with or without a pending aggregate grace or in-flight continuation
**When** the human runs `/unlock-continue-watchdog` with empty/blank reason
**Then**

- `locked=false` is assigned first; timers and pending operational work are then cancelled; attempts are preserved
- TUI notifies exactly: `Continue watchdog unlocked`
- no TUI-only reason entry; no `reasonType` is required or displayed; no `user-ready` envelope is published

**When** the human runs `/unlock-continue-watchdog` with a nonblank reason, e.g. `Taking over manually.`
**Then**

- unlocked as above; the reason is trimmed and truncated to the first 500 Unicode characters; exactly one muted TUI-only reason entry `Continue watchdog unlocked · Taking over manually.` is appended
- the AI typed format `Continue watchdog unlocked · <TYPE> · <reason>` is **not** used

**Given** a watchdog-owned continuation is the exact current main run
**When** the human uses the unlock command or configured shortcut
**Then**

- the manual unlock output occurs exactly once
- the watchdog-owned run is aborted through public Pi APIs; partial assistant output and `Operation aborted` residue are removed from settled TUI/session presentation and future model context
- no replacement model turn starts; the abort settle does not trigger another unlock notification or `user-ready`
- an ordinary uncorrelated user-started run is never aborted, including genuine user steering inside the same agent lifecycle as an earlier continuation

### Example 4 — An actually aborted main run automatically unlocks

**Given** a main run starts while the continue watchdog is locked or already unlocked
**When** that run ends and Pi reports it as **aborted**
**Then**

- apply the same unconditional state transition as reasonless `/unlock-continue-watchdog`
- TUI notifies exactly `Continue watchdog unlocked`, even when already unlocked
- the aborted run is processed once (no duplicate unlock notification)

**And when** the run ends for any non-aborted reason, or abort cannot be attributed to that run, the plugin does not auto-unlock. Ordinary natural idle settle never counts as abort.

### Example 5 — Locked + authoritative aggregate idle → one direct continuation

**Given** main is locked, not exhausted, every observable attachment is idle, and the root busy-child set is empty
**When** the latest eligible observation's fixed 10-second fence expires and every wake-time guard still passes
**Then**

- exactly one visible continuation message is published with `triggerTurn`; no hidden inquiry is sent and no tools are blocked
- the canonical body carries the RFC 3339 timestamp, extension attribution, non-authorization warning, the ended-without-calling-tool notice, the configured `continuePrompt`, the completeness check over every requested task including earlier ones, the unlock-or-continue guidance, and the wait-by-blocking-or-sleeping instruction
- one shared attempt is consumed; the `watchdog-continued` hook publishes with no values

### Example 6 — The unlock tool stops the cycle

**Given** the cycle is locked and the main agent calls `unlock_continue_watchdog` with `reason_type` `job_done` and reason `All requested package bumps are merged.`
**Then**

- the watchdog unlocks through the same controller path; no further model request starts for that run
- the tool result reads `Continue watchdog unlocked · JOB_DONE` and the run terminates on it
- no separate unlock event message is published; the tool call and result are the model-visible record
- one `user-ready` envelope later publishes `STOP_KIND=AI_UNLOCK`, `REASON_TYPE=JOB_DONE`, `REASON=All requested package bumps are merged.` at aggregate idle, waiting for busy children and process-domain confirmation

**And when** config sets `reasonTypes: ["NeedReview", "shipped"]` and the agent unlocks with `needreview`
**Then**

- the type matches configured `NeedReview` case-insensitively; the normalized value is `NEEDREVIEW`
- default types such as `JOB_DONE` are **not** accepted while this custom list is effective

**And when** the agent supplies an unknown type or an overlong reason
**Then**

- the tool result is an ordinary error naming the constraint; the lock and attempt accounting are unchanged; no hook publishes

### Example 7 — Activity during delay cancels; full delay restarts

**Given** a pending fixed grace for the current authoritative aggregate all-idle generation
**When** any observable session becomes busy before the timer fires
**Then** that timer is cancelled and must not dispatch a continuation

**When** all observable sessions are idle again
**Then** the **full** delay for the **same** current attempt restarts from zero

Stale timer callbacks (wrong generation/epoch/ownership or cleared by busy/unlock/fresh-lock cleanup) must not dispatch a continuation, wake main, or publish terminal state.

### Example 8 — Exhaustion after max continuations

**Given** default `maxRetries = 10` and 10 automatic continuations have already been consumed in this lock cycle
**When** main remains locked and all observable sessions become idle again
**Then**

- no further continuation is dispatched; the state remains **locked and exhausted**
- one timestamped exhaustion event is published and one `user-ready` `EXHAUSTED` envelope fires at the terminal aggregate-idle boundary
- a new actual main user message start or manual `/lock-continue-watchdog` resets attempts and clears exhaustion
- human unlock and the unlock tool still work per Examples 3 and 6

### Example 9 — Publication and continuity

- A continuation whose message cannot be durably published rolls its attempt back and publishes neither the hook nor a work turn.
- A continuation that loses ownership across its send publishes no hook.
- Consecutive continuations remain once each in normal chronological context; no duplicate summary block is prepended.
- Ordinary assistant completion does not trigger special deletion of shared events; Pi's compaction and branch selection are authoritative.

### Example 10 — Terminal automatic stop publishes neutral `user-ready`

**Given** the elected main attachment observes a new aggregate-idle epoch and the watchdog has finished every automatic action it can take
**When** the terminal stop is one of:

1. A valid unlock-tool call with validated `reason_type` and `reason`
2. Automatic continuations exhausted
3. The main run settles with terminal `stopReason: "error"` and the watchdog automatically unlocks

**Then** the main attachment publishes exactly one fresh plain-data envelope on `pi:semantic-hook:v1`:

```json
{"version":1,"name":"user-ready","values":{"STOP_KIND":"AI_UNLOCK","REASON_TYPE":"<matched TYPE>","REASON":"<validated reason>"}}
```

or

```json
{"version":1,"name":"user-ready","values":{"STOP_KIND":"EXHAUSTED"}}
```

or

```json
{"version":1,"name":"user-ready","values":{"STOP_KIND":"ERROR_UNLOCK"}}
```

**And** it does **not** publish for human `/unlock-continue-watchdog`, canonical/manual/user abort unlock, initial ordinary unlocked idle, an in-flight continuation, intermediate/pending states, stale/demoted/reloaded ownership, or repeated settled/reconcile in the same terminal epoch.

### Example 11 — Runtime-only lock; clean unlocked on session lifecycle edges

**When** Pi reloads extensions, starts a new session, resumes, restarts, or shuts the attachment down
**Then**

- lock state is **not** restored from disk; effective state starts **unlocked**
- timers and pending continuations are cleaned
- the unlock tool registration is session-scoped: it is never unregistered mid-session, and a fresh process registers it again at config commit
- no orphaned wakes after demotion/shutdown

### Example 12 — Trusted config overrides with safe fallback

**Given** global and/or trusted-project `pi-continue-watchdog.json`
**When** valid `maxRetries`, `continuePrompt`, `reasonTypes`, and/or `unlockShortcut` are provided
**Then** effective config uses field-level override (trusted project over global over defaults). The deprecated `idleDelaySeconds` key may be parsed/preserved for compatibility but never changes the fixed 10-second runtime fence. A valid `reasonTypes` list replaces its built-in default rather than extending it.

**When** `decisionPrompt` or `continueReasonTypes` is present
**Then** the extension reports an error diagnostic naming the removed key and it has no effect; other valid keys in the same file still apply and load does not fail.

**When** values are missing, unreadable, or invalid
**Then** retain valid lower-precedence values / defaults and emit bounded diagnostics.

### Example 13 — Publication, language, packaging, CI

**Then** the shipped project:

- is public **`xz-dev/pi-continue-watchdog`**
- uses **English** for source, identifiers, default prompts, CLI/help, UI labels, errors, tests, and README
- is licensed **BSD-3-Clause**
- is **source-installable** from `master` (TypeScript entry via Pi extension manifest)
- has **packed, isolated, stock-Pi** CI/E2E covering the real plugin artifact (not only unit mocks)
