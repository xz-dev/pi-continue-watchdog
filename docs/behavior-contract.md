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
| Fold terminal invalid exchanges while retaining exactly one shared automatic result | Keep raw inquiry prompts/XML/re-asks internal; publish one canonical timestamped result body to both human history and model context |

Any acceptance text, test name, README, or implementation that still requires persistent or temporary decision tools is stale.

---

## Story

| | |
|---|---|
| **Actor** | A human driving Pi with a root main agent and watchdog-loaded same-process or authenticated child Pi sessions |
| **Need** | After all observable agents go idle, ask main—without changing ordinary tools—whether work should continue, wait for a bounded period, or unlock, without replaying the raw internal decision exchange and without the human retyping “continue” |
| **Value** | Reduces stalled sessions after subagents finish; lets the agent defer a check for external automation without starting a meaningless continuation turn; makes unlock intentional and reason-visible while preserving the ordinary prompt/tool cache prefix |
| **In scope (v1)** | Runtime lock; auto-lock on actual main user work; manual lock/unlock (optional reason); automatic unlock when the main run is actually aborted as Pi reports; trailing XML continue/wait/unlock decisions; typed AI continue/unlock reasons; bounded wait reason and seconds; decision validation + 3 re-asks; tool-call blocking during decisions; exact internal-exchange folding plus a shared canonical automatic-event timeline; runtime-authored local-offset RFC 3339 timestamps; requested-versus-observed wait timing; one fixed grace per authoritative aggregate all-idle generation; authenticated cross-process child activity, neutral connect/disconnect-as-idle, fixed 1-second reconnect with fresh live reports; legacy session readability; config; packaging/CI/publication |
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
| Default `continuePrompt` | `Continue until user assistance is required.` | Configurable guidance embedded verbatim in the fixed model-visible automated continuation envelope |
| Default `reasonTypes` | `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED` | Built-in allowed AI unlock type list; a valid configured list **replaces** this default |
| Default `continueReasonTypes` | `WORK_REMAINS`, `VERIFYING` | Independent allowed AI continue type list; a valid configured list **replaces** this default |
| Shared continue event heading | `Continue watchdog continued · <TYPE> · <RFC3339 timestamp>` | One persistent canonical body for human history and model context; durable before semantic publication and continuation dispatch |
| Shared wait event heading | `Continue watchdog waiting · <seconds>s · <RFC3339 timestamp>` | One persistent canonical body including model reason, requested seconds, and absolute deadline; durable before the wait is armed |
| Shared wait-completed event heading | `Continue watchdog delay elapsed · requested <seconds>s · elapsed <seconds>s · <RFC3339 timestamp>` | Published at most once at the next qualified wake for the same wait; no external-progress claim |
| Shared AI-unlock event heading | `Continue watchdog unlocked · <TYPE> · <RFC3339 timestamp>` | One persistent canonical body; starts no work turn |
| Shared decision-failed event heading | `Continue watchdog decision failed · <RFC3339 timestamp>` | One canonical body with only the safe validator diagnostic |
| Shared exhausted event heading | `Continue watchdog exhausted · <RFC3339 timestamp>` | One canonical terminal-idle body; starts no work turn |
| Continue semantic hook | `watchdog-continued` with `REASON_TYPE` and `REASON` | Neutral plain-data best-effort hook after durable continue evidence |
| Wait semantic hook | `watchdog-waiting` with `REASON` and decimal `WAIT_SECONDS`; no `REASON_TYPE` | Neutral plain-data best-effort hook after durable wait evidence |
| Lock TUI notify | `Continue watchdog locked` | User-only TUI notify |
| Unlock TUI notify (no reason) | `Continue watchdog unlocked` | User-only TUI notify (human reasonless / abort) |
| Human unlock TUI-only entry (with reason) | `Continue watchdog unlocked · <reason>` | Muted persistent user-only history entry; human path remains untyped |
| Terminal-error auto-unlock TUI notify | `Continue watchdog unlocked · run ended in error` | User-only TUI notify; automatic when the settled main run's terminal assistant reports `stopReason: "error"` |
| Terminal-error auto-unlock TUI-only entry | `Continue watchdog unlocked · run ended in error (automatic unlock)` | Muted persistent user-only history entry; distinguishes the automatic unlock from a manual one |
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

`continuePrompt` is configurable guidance, not the complete provider-bound message. After a valid continue, runtime embeds it verbatim in the canonical shared event body that identifies the pi-continue-watchdog extension as the source, states that the message is not from the user and is not user approval, confirmation, consent, or authorization, includes the normalized model-generated `reasonType` and `reason` as JSON, and permits only previously requested and authorized work. The event tells the agent to stop and ask when additional user input, approval, or assistance is required. Pi may serialize the custom message with provider-facing user role; the human renderer and provider receive the same immutable stored body.

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
8. **Three-outcome idle recovery.** A settled non-aborted main run resolves by the terminal assistant message's `stopReason` after Pi's automatic retries are exhausted. Normal completion enters the standard inquiry fence and continue/wait/unlock decision. A terminal failure (`stopReason: "error"`) unlocks automatically with a clear notification and a record distinguishable from a manual unlock—there is no healthy trajectory to resume, and no inquiry fence or decision starts. While Pi is still retrying, the run is busy and no outcome is considered. The plugin classifies only the terminal `stopReason`; it never matches error strings or special-cases compaction. Actual user aborts keep rule 7's immediate unlock and never pass through this gate.
9. **Live public AI activity.** Every relevant Pi event queries live `ctx.isIdle()`. Event labels never assign or imply busy/idle. Pi's public value covers active runs, automatic retries, auto-compaction retries, and queued continuations.
10. **One shared automatic-event timeline.** Newly accepted continue, wait, AI-unlock, decision-failure, completed-wait, and retry-exhaustion results each have one immutable canonical body visible to the human and supplied to the model through normal active-branch conversation context. Human styling may wrap or color it but may not omit fields or independently reformat it. New production code does not reconstruct a separate watchdog-only result list.
11. **Runtime-authored timing.** Every new shared event body freezes its creation time as RFC 3339 with milliseconds and an explicit numeric UTC offset. Wait acceptance also records requested seconds and absolute deadline. The next qualified wake for the same wait reports the original requested duration and whole observed wall-clock elapsed seconds; it states that external task progress, health, continued execution, and completion are unknown.
12. **Internal protocol isolation and compatibility.** Raw prompts, XML, malformed answers, validation re-asks, diagnostics, audits, and cleanup/correlation records remain outside ordinary model context. Pre-upgrade TUI-only records and old optional `watchdogResult` metadata remain readable but are not rewritten, backfilled, timestamped, or used to restore timers. Pi's active branch and compaction behavior is authoritative for new shared events.

---

## Defaults and configuration

| Key | Default | Notes |
|---|---|---|
| `idleDelaySeconds` | `10` | Deprecated compatibility key. It remains accepted/preserved, but runtime ignores it; every automatic inquiry fence is exactly 10 seconds. |
| `maxRetries` | `10` | Maximum **valid continue or wait** outcomes per lock cycle (not invalid re-asks); safe integer in `[1, 10]` |
| `decisionPrompt` | exact default above | Automated custom-role body; explicitly identifies extension automation and says it is not a user message/request; nonblank and at most 16,384 Unicode code points |
| `continuePrompt` | exact default above | Guidance embedded verbatim in the fixed automated continuation envelope; nonblank and at most 16,384 Unicode code points |
| `reasonTypes` | `["JOB_DONE","WAIT_USER","JOB_BLOCKED"]` | Allowed AI unlock types. A valid configured list **replaces** the default. |
| `continueReasonTypes` | `["WORK_REMAINS","VERIFYING"]` | Independently allowed AI continue types. Same nonempty trim-nonblank validation and replace semantics as `reasonTypes`. |

**Config locations and precedence** (same pattern as sibling Pi plugins):

1. Built-in defaults
2. Global: `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` (default `~/.pi/agent/pi-continue-watchdog.json`)
3. Trusted project only: `<cwd>/.pi/pi-continue-watchdog.json` when the project is trusted by Pi

Trusted-project fields override global field-by-field (`builtins < global < trusted project`). Invalid high-precedence values must not erase valid lower-precedence values; emit bounded diagnostics. Missing files are silent. Configured prompt limits count Unicode code points without truncation: exactly 16,384 is valid and longer values are invalid. Reason-type list entries are only trimmed and required to be nonblank; they have no identifier regex or artificial per-entry length limit.

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
- Main run settled with terminal `stopReason: "error"` after Pi's automatic retries are exhausted (automatic, distinct record; no inquiry fence or decision)

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
2. Persists a context-excluded `pi-continue-watchdog:inquiry-marker` with the exact protocol version, unique `exchangeId`, and `cycleId`, then sends a **custom-role** message—not a user-role message—whose body is the optional exact completed-wait preamble for the current wake, followed by the configured `decisionPrompt` and fixed XML suffix, using `{ triggerTurn: true, deliverAs: "steer" }`. If marker persistence fails, the inquiry is not dispatched. The marker is a logical correlation boundary: other plugins may interleave entries between marker, decision prompt, assistant, and fold marker without becoming watchdog-owned. Ordinary tools stay advertised. The live decision assistant may stream in TUI/RPC, but public `message_end` replacement clears its finalized or aborted content from TUI history and persistence. The suffix tells the model to use existing task context, not call tools, put exactly one watchdog block at the response end, never output multiple watchdog blocks, use effective allowed `reason_type` values for continue/unlock, and use an untyped bounded `wait_seconds` for wait. It first reconciles outstanding requests with the latest ordinary answer and relevant tool results, then applies completion-first classification: completed work uses unlock/`JOB_DONE`; incomplete authorized work executable now uses continue; otherwise user-dependent work uses unlock/`WAIT_USER`, temporary external waiting uses wait, and other blockers use unlock/`JOB_BLOCKED`. Unfinished work alone never justifies continue. This package does not request `presentation: "hidden"` and does not require a downstream Pi hidden-run API.
3. Blocks every ordinary tool call before execution while the decision is active and returns a reminder to answer from existing context with XML. A blocked call does not itself consume an invalid attempt; final assistant text is authoritative.
4. Does **not** send the rejected direct-continuation message as the idle wake path.

### Shared automatic timeline and current-wake preamble

New accepted continue, wait, AI-unlock, decision-failure, completed-wait, and retry-exhaustion events remain once in normal active-branch conversation order. Each event has one canonical body, built at runtime commit time, that is both human-visible and model-bound. Later watchdog decisions and ordinary work receive retained events through normal context; no special branch scan, stop-reason boundary, deduplication pass, or `Previous watchdog results` block exists.

Every event body contains a runtime-authored RFC 3339 timestamp with milliseconds and an explicit numeric UTC offset. The body is immutable after persistence: redraw, resume, later decisions, and host time-zone changes do not regenerate it. Wait acceptance additionally states the requested seconds and absolute deadline.

For one still-current accepted wait, the runtime retains only its wait identity, acceptance time, requested seconds, and deadline. At the next wake that passes existing current-main, aggregate-idle, ownership, and deadline checks, it samples the clock before inquiry dispatch and publishes at most one completed-wait event. That body states requested seconds, whole observed wall-clock elapsed seconds, acceptance time, and observation time, and explicitly says external task progress or completion is not established. The associated decision prompt may prefix the exact same body as an ephemeral current-wake timing reference. Validation re-asks reuse that snapshot. It is not a replay of older results and is not persisted twice.

Activity can defer eligibility without restarting the wait. Unlock, fresh lock, ownership loss, session replacement, and shutdown invalidate pending wait-completion reporting. A final permitted wait publishes completed-wait immediately before retry exhaustion at the existing terminal-idle boundary; neither event starts an inquiry or work turn. Pre-upgrade records remain readable but are never backfilled, timestamped, or used to restore waits.

### Ordered outcome selection

The fixed suffix first compares outstanding requests with the latest ordinary assistant response and relevant tool results. Delivered, cancelled, or superseded work is not pending; genuinely unfinished earlier requests remain in scope. Earlier plans and watchdog reasons do not prove unfinished work, and a final response or stop marker alone does not prove completion. Before claiming an answer is missing, check the answer already delivered. Continue reasons identify a specific missing deliverable and an authorized next action, not a duplicate answer or optional follow-up.

An ASCII decision tree and these ordered rules communicate the same policy:

1. If all requested work is complete, choose unlock with the allowed type representing `JOB_DONE`.
2. Continue only for an incomplete deliverable with a concrete requested and authorized action executable now without additional user input or approval; `reason_content` names that action.
3. With no executable action, if user input, approval, confirmation, authorization, credentials, or another user action is required, choose unlock with the allowed type representing `WAIT_USER`.
4. With no executable action, if progress requires temporary external automation or time and no user action, choose wait.
5. Otherwise choose unlock with the allowed type representing `JOB_BLOCKED`.

Built-in labels appear in the tree only when present in the effective configured list. These are prompt contracts, not a deterministic completion detector; mocked provider tests verify transport and handling, not real-model judgment.

A pending approval-gated action does not force unlock when independent requested and authorized work remains executable now. Conversely, unfinished work with no executable action is not `WORK_REMAINS`; when blocked on the user it is `WAIT_USER`.

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
- Length ≤ **1000 Unicode characters** hard limit (count Unicode code points / characters as implemented consistently and tested); the decision prompt advises at most **500**, derived in code as half the hard limit
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
- Publish exactly one timestamped shared AI-unlock event whose heading is `Continue watchdog unlocked · <TYPE> · <RFC3339 timestamp>` and whose body includes the JSON-escaped model-generated reason and non-authorization boundary. The human renderer and later model context receive that same immutable body.
- Do **not** also emit a transient reasoned unlock notification
- **No further work turn** is started for that unlock decision
- Pi's extension `message_end` captures the validated original decision for audit/finalization, then replaces the finalized assistant with empty content. Live TUI/RPC may have streamed the decision before completion. Future model-bound context removes the raw inquiry exchange while retaining the one shared unlock event.
- A context-excluded `pi-continue-watchdog:decision-audit` CustomEntry may preserve only the structured validated outcome; Pi does not project CustomEntry into Agent/provider context

### Valid continue

**When** the decision is a valid continue:

- Requires a type allowed by `continueReasonTypes` and a nonblank reason of at most 1000 Unicode characters
- The matched type and validated reason are retained in context-excluded audit data and in the canonical shared event body
- The decision turn ends, and ordinary work continues automatically without further user input
- extension `message_end` captures the provider XML for validation and replaces the finalized assistant with empty content; context folding then removes internal prompt / assistant / tool-result metadata and retains **one** visible custom message containing the canonical timestamped continue body: extension attribution, explicit non-user/non-authorization language, JSON-serialized normalized type/reason, configured `continuePrompt` guidance, and the stop-at-user-boundary instruction
- show a live colored TUI widget with `Continue watchdog checking` and the current decision cycle while the check is active; clear it on terminal continue, unlock, failure, abort, or cleanup
- persist diagnostic TUI-only cards for watchdog validation re-asks or other errors; they remain outside model context
- durably publish the shared event before `watchdog-continued` and continuation dispatch; if publication fails, fail closed with neither hook nor automatic continuation turn
- semantic listener absence/failure is best-effort and never gates continuation after publication succeeds
- The continued ordinary turn receives exactly the same immutable body shown in human history; no duplicate TUI-only continue entry or reconstructed history block is added
- Consumes **one** valid outcome attempt
- The next authoritative aggregate all-idle generation uses the same fixed grace
- After `maxRetries` combined valid continue/wait outcomes, remain locked/exhausted with no further inquiry until reset

### Valid wait

**When** the decision is a valid wait:

- Requires a nonblank `reason_content` of at most 1000 Unicode characters, integer `wait_seconds` in `1..1800`, and no `reason_type`; a supplied `reason_type` is invalid
- Consumes **one** shared `maxRetries` attempt while keeping the watchdog locked
- Captures the acceptance timestamp and local offset, requested seconds, absolute deadline, and unique current-wait identity
- Durably publishes one shared waiting body before hook publication or scheduling. Its heading is `Continue watchdog waiting · <seconds>s · <RFC3339 timestamp>` and its body includes the JSON-escaped model reason, requested duration, deadline, and explicit statement that external task status is not established
- If shared publication fails, roll back the consumed attempt/deadline and stop without scheduling the wait
- After publication succeeds and the same ownership claim remains current, publishes exactly one fresh plain-data envelope on `pi:semantic-hook:v1`: `{"version":1,"name":"watchdog-waiting","values":{"REASON":"<validated trimmed reason>","WAIT_SECONDS":"<accepted decimal seconds>"}}`
- Revalidates ownership after publication before scheduling; invalid, retried, preempted, stale, ownership-lost, publication-failed, and rollback paths publish no waiting hook
- Missing, throwing, or slow synchronous listeners remain optional and cannot change accepted wait state, folding, or scheduling; best-effort publication does not promise zero synchronous listener delay
- Ends the decision without starting an ordinary continuation turn
- Internal decision prompt/XML/re-ask records are removed while the one shared waiting body remains in future model context
- Suppresses automatic inquiry while current time is before `waitUntilMs`; renewed activity cancels stale timer identities and later idle requalifies against both the original absolute deadline and the normal fixed fence
- At the next qualified wake for this current wait, samples wall-clock time before inquiry dispatch and publishes at most one shared completed-wait event with requested seconds, observed whole elapsed seconds, acceptance time, and observation time. It does not claim anything about external task progress or completion
- Validation re-asks reuse the initial completed-wait snapshot; separate waits never share acceptance times or elapsed totals
- Unlock, fresh lock, ownership loss, session replacement, or shutdown invalidates pending wait-completion reporting; cleared/stale callbacks are inert
- If this wait consumes the final attempt, `watchdog-waiting` publishes immediately after durable acceptance, then completed-wait precedes retry exhaustion only after the complete deadline and terminal-idle checks

### Human `/unlock-continue-watchdog [reason]`

Always assigns `locked=false` first, resets `waitUntilMs` to `0`, then cancels timers and cleans operational decision state while preserving cycle accounting—even if already unlocked. The human command remains **untyped**: no `reasonType` argument, no type matching, and no AI typed TUI format.

| Human reason input | TUI notify | TUI-only reason entry |
|---|---|---|
| Empty / blank / omitted | exactly `Continue watchdog unlocked` | none (no reason) |
| Nonblank | none | trim; **automatically truncate** to first **500** Unicode characters (may be multiline); append muted `Continue watchdog unlocked · <reason>` |

Human unlock is **not** subject to the AI decision-window invalid re-ask protocol and does **not** publish `user-ready`.

If the current main run is exactly correlated to the watchdog's submitted decision or accepted automated continuation, human unlock additionally records that exact claim/exchange/cycle as a one-shot cancellation target and calls public `ctx.abort()`. Uninterruptible `message_end` clears its partial assistant content, replaces abort presentation with the internal `pi-continue-watchdog:cancelled` marker, excludes that marked assistant from future model context, and best-effort splices the exact settled assistant entry. The cancellation emits no second unlock through the main-abort path and starts no cleanup/summary model turn. An ordinary or uncorrelated user-started run is never aborted. Queued-message behavior remains Pi-owned: the extension does not inspect, copy, replay, or explicitly clear private steering/follow-up queues and does not guarantee delivery or automatic resumption across abort. Cancellation does not roll back completed tool side effects or promise to stop detached/background work outside the active run signal.

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

**Given** a submitted watchdog decision or accepted automated continuation is the exact current main run
**When** the human uses the unlock command or configured shortcut
**Then**

- the explicit manual unlock output occurs exactly once
- the watchdog-owned run is aborted through public Pi APIs
- partial assistant output and `Operation aborted` residue are removed from settled TUI/session presentation and future model context
- no replacement model turn starts
- the abort settle does not trigger another unlock notification or `user-ready`
- unrelated session entries are preserved; queued-message behavior follows Pi's abort semantics without watchdog replay

**And given** the current run is ordinary user work, fails exact correlation, or genuine user/foreign custom work has started inside a previously correlated continuation lifecycle, manual unlock changes watchdog state but does not abort that run.

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
- a **custom-role** decision message uses the optional exact completed-wait body for the current wake followed by the configured `decisionPrompt` and fixed XML suffix, identifies itself as extension automation, states it is not a user message/request, explicitly forbids making decisions on the user's behalf, lists effective `reasonTypes` and `continueReasonTypes`, includes the bounded untyped wait form, and is never injected with user role
- the model may narrate before XML or output only XML, but the trimmed response must end with exactly one watchdog block; multiple watchdog blocks are invalid
- the rejected direct-continuation default
  `Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.`
  is **not** used as the idle wake message
- the rejected untyped decision default that asked only for a concise reason without an allowed `reasonType` is **not** used

With defaults, every eligible all-idle generation waits **10s**.

### Example 5a — Approval-gated work chooses WAIT_USER immediately

**Given** requested production changes remain, but every permitted next action requires explicit user approval
**When** the watchdog decision opens
**Then** the fixed suffix directs unlock with `WAIT_USER`; unfinished production work alone cannot justify `WORK_REMAINS`; no automatic continuation turn starts.

### Example 5b — External automation chooses wait

**Given** CI is running, no useful action can proceed until it completes, and no user response is required
**When** the watchdog decision opens
**Then** the fixed suffix directs `wait_watchdog` with a bounded duration rather than `WAIT_USER` or continue.

### Example 5c — Independent authorized work may continue

**Given** one action awaits user approval but another concrete requested and authorized verification action is executable now
**When** the watchdog decision opens
**Then** continue remains valid only when `reason_content` names that immediately executable verification action rather than the blocked production action.

### Example 5d — Completed and other-blocked work unlock distinctly

**Given** either all requested work is complete or work is blocked for a reason that is neither user action nor a temporary external wait
**When** the watchdog decision opens
**Then** the fixed suffix directs `JOB_DONE` for completion and `JOB_BLOCKED` for the other blocker.

### Example 6 — Valid continue: one shared body, correlated continuation, retry consumption

**Given** a decision window is open with default `continueReasonTypes`
**When** the main agent returns `continue_watchdog` with type `verifying` and reason `Tests still need to run.`
**Then**

- type normalizes to `VERIFYING`; the validated type and reason may be written into context-excluded decision audit data
- one canonical body is durably published first with heading `Continue watchdog continued · VERIFYING · <RFC3339 timestamp>`
- the human renderer and provider receive exactly that stored body, including the JSON-escaped model-generated reason, configured `continuePrompt`, extension attribution, non-authorization warning, and stop-at-user-boundary rule
- then one neutral `watchdog-continued` hook publishes `REASON_TYPE=VERIFYING` and `REASON=Tests still need to run.` best-effort
- only after durable shared evidence does ordinary work continue automatically through the existing correlated fold identity
- the raw decision prompt, XML, re-asks, and tool-result metadata are absent from later context; there is no second TUI-only continue entry
- one shared valid outcome attempt is consumed
- after the continuation settles, if still locked and aggregate idle, the **next generation** waits the same fixed grace
- if shared publication fails, no hook or continuation is dispatched; hook listener failures alone do not gate continuation

### Example 6a — Shared history survives continuation outcomes without replay

**Given** a valid continue has published one shared event for `WORK_REMAINS` and `Implementation work remains.`
**And** the resulting ordinary continuation attempt ends with `error`, `aborted`, `length`, `toolUse`, `pending`, `deferred`, or a successful terminal `stop`
**When** another eligible watchdog decision or ordinary turn receives retained active-branch context
**Then**

- the original shared event remains once in normal conversation order unless normal Pi compaction or branch selection removed it
- no `Previous watchdog results` block or separately normalized copy is prepended
- raw watchdog narration/XML, partial continuation output, provider errors, diagnostics, and decision-audit data are absent
- successful ordinary assistant completion does not trigger special deletion of the shared event

### Example 6b — Valid wait: shared timing body, no work turn, absolute deadline

**Given** a decision window is open at `2026-09-19T16:02:16.951+08:00`
**When** the main agent returns `wait_watchdog` with reason `Waiting for CI.` and `wait_seconds=1500`
**Then**

- no `reason_type` is accepted, consulted, displayed, or persisted for the wait; supplying one is invalid
- the validated wait audit may record reason `Waiting for CI.` and `waitSeconds=1500`
- one canonical body is durably published with heading `Continue watchdog waiting · 1500s · 2026-09-19T16:02:16.951+08:00`, the JSON-escaped reason, requested 1500 seconds, and deadline `2026-09-19T16:27:16.951+08:00`
- human history and model context receive exactly that body; it states that external task status is not established
- exactly one neutral `watchdog-waiting` hook then publishes `REASON=Waiting for CI.` and `WAIT_SECONDS=1500`, with no `REASON_TYPE`
- no ordinary continuation turn starts
- one shared retry is consumed and the watchdog remains locked
- activity during the wait defers eligibility without changing the original start or deadline
- unlock or fresh lock invalidates pending completion reporting; stale callbacks publish nothing
- if shared publication fails, the retry/deadline commit is rolled back, no wait is scheduled, and no waiting hook is published

**When** the same wait next qualifies a wake at `2026-09-19T16:27:47.951+08:00`
**Then**

- one shared completed-wait event reports requested `1500` seconds and observed wall-clock elapsed `1531` seconds, with both original acceptance and observation timestamps
- the associated inquiry reuses that exact body as its current-wake preamble, including across validation re-asks, without persisting a duplicate
- the event does not claim CI progressed, remained healthy, kept running, or completed
- if this was the final permitted wait, completed-wait precedes one exhaustion event and neither starts an inquiry or ordinary work turn

### Example 7 — Valid AI unlock: shared timestamped body, no further work turn

**Given** a decision window is open with default `reasonTypes`
**When** the main agent returns a valid `unlock_continue_watchdog` with mixed-case type `job_done` and reason `All requested package bumps are merged.`
**Then**

- `locked=false`; timers and operational decision state cancelled; attempts/failures preserved
- type matches case-insensitively to configured `JOB_DONE`; display/emit uses uppercased matched configured value `JOB_DONE`
- no transient reasoned unlock notification is emitted
- exactly one shared event is published with heading `Continue watchdog unlocked · JOB_DONE · <RFC3339 timestamp>` and a body containing the JSON-escaped model-generated reason plus the non-authorization boundary
- **no further work turn** starts from that unlock decision
- future model-bound context removes the internal decision exchange but retains the same canonical body shown in human history
- raw session may contain a context-excluded structured audit CustomEntry with the validated `reason_type` and `reason_content`, but no assistant XML content

**And when** config sets `reasonTypes: ["NeedReview", "shipped"]` (replacing, not extending, the default list)
**And** the agent unlocks with mixed-case type `needreview` and reason `PR is open for human review.`
**Then**

- type matches configured `NeedReview` case-insensitively
- shared event heading is `Continue watchdog unlocked · NEEDREVIEW · <RFC3339 timestamp>` and its body carries `"PR is open for human review."`
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

- publish one timestamped shared decision-failure event containing the safe `<last error>` diagnostic but not the raw invalid response
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
4. The main run settles with terminal `stopReason: "error"` after Pi's retries and the watchdog automatically unlocks

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

or

```json
{"version":1,"name":"user-ready","values":{"STOP_KIND":"ERROR_UNLOCK"}}
```

**And** it does **not** publish for human `/unlock-continue-watchdog` (with or without reason), canonical/manual/user abort unlock, initial ordinary unlocked idle, valid continue, a valid wait before its deadline, intermediate decision/settled states, locked normal/pending grace, stale/demoted/reloaded ownership, or repeated settled/reconcile in the same terminal epoch.

Only AI decision unlock retains a publication intent carrying **both** matched `REASON_TYPE` and validated `REASON` together until the resulting authoritative aggregate-idle settle; type and reason are retained/cleared together. Terminal-error automatic unlock retains an `ERROR_UNLOCK` intent after authoritative unlock and operational cleanup; it publishes only at aggregate idle, after process-domain confirmation when configured. Busy children delay publication; duplicate settles cannot repeat it. Manual unlock, a fresh lock cycle, stale ownership, and shutdown clear the pending intent. Pi retry errors before final settlement do not publish. Non-AI stop kinds do not invent type/reason fields. Existing type matching plus reason validation/trim/length remain authority; decision-failed does not publish last error text. Absence or failure of every consumer must not change watchdog state.

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
| Context folding is model-bound | Future model requests drop raw inquiry prompts, XML, re-asks, and protocol metadata while retaining the one shared canonical result body; persisted structured audits and legacy TUI-only entries remain CustomEntry records excluded from Agent/provider context |
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
| No context pollution from decisions | Future model-bound context never keeps raw decision prompts, XML responses, malformed answers, re-asks, or cleanup records; it retains only the canonical shared result/timing events that the human also sees |
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

- **Unit / component:** pure state machine (including decision-failed, continue/wait attempt advancement, wait deadline reset, and rollback rules), config precedence including `reasonTypes` replace semantics, XML suffix extraction and exactly-one-block validation, AI type case-insensitive match + uppercased matched configured value, wait seconds `1..1800` strict validation, reason trim/truncate/length (AI no-truncation vs human truncate), aggregate-grace cancel/restart with absolute not-before deadlines, stale timer guards, local-offset RFC 3339 formatting, immutable shared bodies, requested-versus-observed elapsed timing, current-wait identity/invalidation, validation re-ask snapshot reuse, completed-wait-before-exhaustion ordering, legacy metadata tolerance, timeline compatibility, and prompt privacy
- **Integration / E2E (stock Pi, packed install):** auto-lock on real main user message start; command lock/unlock notifies and optional untyped reason; ordinary-tool stability with XML decision prompts; at least one real fixed-grace path into a decision window; structured CustomEntry audit excluded from context; continue/wait/unlock/three-invalid/error/abort/user-takeover paths return to idle within bounded time; exact human/provider shared-body equality through the visible fold; consecutive waits in normal context without reconstructed history; wait publication failure rollback; unlock clears wait deadlines; persistent mixed legacy/new resume preserves canonical text without timer restoration or invented events; delayed `AI_UNLOCK` user-ready while a child is busy; final-wait completed-before-exhaustion ordering; cross-process ownership and stale-work fencing
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
