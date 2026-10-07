# Acceptance contract — pi-continue-watchdog

**Status:** Accepted product contract for the **inquiry-first cw function** redesign (2026-10-04)
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

This contract supersedes the proactive unlock-tool + direct-continuation design. The current design restores the watchdog-owned decision inquiry, delivered through a reserved function call instead of XML.

| Rejected design | Current design (required) |
|---|---|
| Always-advertised `unlock_continue_watchdog` callable from ordinary work | One reserved root-only function `cw` whose arguments are taught only in authorized decision prompts |
| Lock alone authorizing a model-issued stop | Only the exact consumed current decision attempt can submit a verdict |
| Direct continuation at qualified idle | One hidden decision inquiry precedes any ordinary continuation |
| Waiting inside the agent's own turn only | **Removed**: only `continue` and `unlock` are accepted; `WAIT_CALLBACK` covers expected external wake-ups and arms no timer |
| Invalid arguments as ordinary tool-error follow-ups | Bounded correction (three responses) and a `DECISION_FAILED` terminal state |
| Untyped continuations | The accepted continue reason type and reason appear in the shared continuation body; `continueReasonTypes` is restored |
| jev wait classification and WAIT_USER permission review | Removed entirely; delivery and user boundaries are judged inside the authorized decision inquiry |

Any acceptance text, test name, README, or implementation that still requires the proactive tool or a jev request is stale.

---

## Approved plugin-only boundary

The user revised three earlier strict requirements: confirmation means exact owned-run metadata plus this plugin's local context observation, not proof of the final provider payload after later handlers; authorization precedes plugin action/reason validation, but native non-object container validation may run first; and malformed owned batches may stop before dispatch without per-call results. The earlier host counterexamples remain true. All ordinary-call inertness, correction/accounting, no-work-tool side effects, ownership, publication, wait, cancellation, and jev-removal requirements remain in force.

References to a consumed attempt below mean the locally confirmed phase. Stable metadata avoids tool-list churn but does not guarantee provider cache hits. Historical results and current acceptance evidence are recorded separately in the change's `verification.md`.

## Story

| | |
|---|---|
| **Actor** | A human driving Pi with a root main agent and watchdog-loaded same-process or authenticated child Pi sessions |
| **Need** | After a qualified settlement the watchdog asks the model itself, through a hidden phase-gated decision inquiry, whether to continue or unlock; ordinary work can no longer stop the cycle on its own |
| **Value** | Reduces stalled sessions after subagents finish; native tool-call reliability replaces an XML protocol the model produced unreliably; the tool declaration stays stable without promising provider cache hits |
| **In scope (v1)** | Runtime lock; auto-lock on actual main user work; manual lock/unlock (optional reason); automatic unlock when the main run is actually aborted as Pi reports or settles in terminal error; one root-only reserved `cw` decision-result function with fixed minimal metadata; watchdog-owned continue/unlock inquiries after the fixed ten-second aggregate-idle fence; bounded invalid-response correction (three) and decision-failed terminal state; continuation-only retry budget; exhaustion after `maxRetries` accepted published continuations; shared canonical event timeline with runtime-authored local-offset RFC 3339 timestamps; exact-exchange context folding of completed inquiries; authenticated cross-process child activity, neutral connect/disconnect-as-idle, fixed 1-second reconnect with fresh live reports; legacy session readability; config; packaging/CI/publication |
| **Out of scope (v1)** | Durable lock across reload/new/resume/restart; sessions that did not load the watchdog; depending on pi-subagents or any other plugin; replacing Pi footer; wall-clock or loop-count watchdogs (those belong to pi-watchdog); XML decision transport; any external classifier or permission reviewer (jev removed) |

---

## Review assistance and historical association

The approved `reduce-false-positive-continuations` change adds assistance, not a completion oracle. Its hidden inquiry keeps the native effective conversation and adds provenance-labelled excerpts: at most 8,000 Unicode code points including labels/footer, and 1,600 per excerpt including elision. Latest user/reply and two recent tool results lead; earlier requests/deliveries precede derived summaries and automation. Omitted evidence is not absent evidence. Exact native correlation, not quoted text or partial metadata, identifies owned controls. Bash rows use native `convertToLlm`, preserving its exclusion flag and cancellation/exit/truncation qualifiers; excluded commands, output and source IDs do not enter the supplement or its metadata.

The existing three `cw` fields remain unchanged. Guidance asks for a concise deliverable assessment in `reason_content` before the verdict; either property order is valid. Earlier deliveries and unchanged permission remain relevant; reporting a future command does not authorize running it. No new checklist, confirmation click, special word, reviewer request, or semantic acceptance gate is added.

A persisted review uses the owning native JSONL's existing marker, inquiry, optional audit, fold and canonical quiet-unlock record. The inquiry holds the assembled view once; nested versioned metadata records source references and association. A response is not a published outcome. Quiet unlock needs both its remove-fold and same-attempt status record on the active ancestry; `unlockEntryId` preserves the native reason's locator even if the optional audit is absent. Legacy replacement unlocks remain readable. Missing inquiry or audit, incomplete quiet publication, unknown metadata/policy, or unresolved/mismatched ancestry references is incomplete history; optional failure only emits a bounded existing status diagnostic and never retries, relocks an accepted unlock, restores authority or creates fallback storage. A missing inquiry is detected independently of the audit's optional prompt-ID field.

Historical reads follow the host's current ancestor path at startup and before inquiries. Sources must precede that review on the same path. Non-label source identity survives native fork label recreation and parent re-chaining; origin session ID is provenance only. A leaf-only branch move is not persisted by tested Pi 0.85.1: fresh reopen restores its persisted tip. The watchdog never selects another leaf to disguise this host limitation. New views use native compaction-aware entries, not archived raw requests; recovery restores no lock, claim, budget, timer, dispatch or staged action.

`watchdog-review-history.idea.lean` models that read-only association boundary. Existing lifecycle models remain unchanged; the new model assumes a correct host ancestry and already decoded records. Neither its proofs nor fixture verdicts establish natural-language completeness, provider-wire fidelity after later plugins, or repair of the historical false continuation. Independent semantic review remains an explicit verification gate.

## Product surface (fixed names)

| Surface | Exact name / text | Who / channel |
|---|---|---|
| Lock command | `/lock-continue-watchdog` | Human (TUI) |
| Unlock command | `/unlock-continue-watchdog [reason]` | Human (TUI); reason optional; **untyped** (no `reasonType`) |
| Status command | `/status-continue-watchdog` | Human (TUI); read-only trigger diagnosis |
| Reserved decision function | `cw` with description `don't use unless ask` and an open empty-object schema | Model-visible function, registered once per root process; declaration and active membership never change; children never register it |
| Default `continuePrompt` | `Continue until user assistance is required.` | Configurable guidance embedded verbatim in the fixed model-visible continuation body |
| Default `reasonTypes` | `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, `WAIT_CALLBACK` | Built-in allowed unlock-tool type list; a valid configured list **replaces** this default |
| Shared continuation event heading | `Continue watchdog · continue · <TYPE> · <RFC3339 timestamp>` with `Suggested next step: <reason>` | One persistent canonical attributed next-action body for human history and model context; durable before semantic publication and continuation dispatch |
| Shared exhausted event heading | `Continue watchdog exhausted · <RFC3339 timestamp>` | One canonical terminal-idle body; starts no work turn |
| Continued semantic hook | `watchdog-continued` with normalized `REASON_TYPE` and trimmed `REASON` | Neutral plain-data best-effort hook after durable continuation evidence |
| Quiet AI-unlock status (TUI-only) | `Continue watchdog unlocked · <TYPE> · <reason>` | One muted gray custom entry per accepted AI unlock; excluded from model context by the host's custom-entry design; no timestamp, box, or disclaimer |
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

`continuePrompt` is configurable guidance, not the complete provider-bound message. At continuation time the runtime embeds it verbatim in the canonical shared event body that identifies the pi-continue-watchdog extension as the source, states that the message is not from the user and is not user approval, confirmation, consent, or authorization, records the accepted continue verdict's normalized reason type and reason as model-generated reference, carries the fixed completeness check over every requested task including earlier ones, and keeps the stop-at-user-boundary rule without instructing any ordinary-turn watchdog function call. The event permits only previously requested and authorized work. Pi may serialize the custom message with provider-facing user role; the human renderer and provider receive the same immutable stored body.

---

## Scope and classification rules

1. **“All agents idle”** means every extension-loaded attachment in the process-local hub and every authenticated watchdog-loaded child Pi process that has joined the inherited process domain is idle. Sessions that did not load the watchdog or did not inherit the declaration may be absent; document this as **observable coverage**, never “all agents in the universe.”
2. **Main/root election** (root-process local, no other plugin):
   - UI-bound session wins main when present.
   - Pure headless: first-bound attachment is documented best-effort main; later attachments are treated as non-main.
3. **Only main** gets decision inquiries. The reserved `cw` function is registered in every root process (so the tool list never changes), but its result effect applies only to the current main's current consumed attempt. Non-main attachments remain observer-only.
4. **Zero external-plugin dependencies.** Use only Pi public extension APIs plus this plugin’s own same-process hub and authenticated process-domain coordinator.
5. **Lock state is runtime-only** for the current process/session attachment lifecycle. Not written to disk. Not restored on reload/new/resume/restart/shutdown.
6. **Universal main-run coverage.** Every current-main `agent_start` ensures the watchdog is locked. If already locked, the existing cycle is preserved; watchdog decision and continuation turns do not reset themselves. If unlocked, the start silently begins a fresh lock cycle.
7. **Abort unlock.** When the current main run is **actually aborted as Pi reports**, unlock reasonlessly and immediately. For an exact watchdog-owned decision, correction, or continuation, keep `stopReason: "aborted"` and replace only its finalized abort text with a nonempty blank: no `Operation aborted` text remains, though footer spacing and a brief earlier streaming notice may remain. Ordinary user abort presentation is unchanged. Ordinary natural settle does **not** unlock. Never inspect or infer why a child stopped. Detection uses the existing public session boundary and terminal assistant outcome; quiet display is not successful completion and does not change host tool dispatch, queues or compaction.
8. **Two-outcome idle recovery.** A settled non-aborted main run resolves by the terminal assistant message's `stopReason` after Pi's automatic retries are exhausted. Normal completion enters the standard idle fence and then one watchdog-owned decision inquiry (continue / unlock) while the cycle is locked with budget remaining; no direct continuation or external classification precedes that inquiry. A terminal failure (`stopReason: "error"`) unlocks automatically with a clear notification and a record distinguishable from a manual unlock—there is no healthy trajectory to resume, and no idle fence, inquiry, or continuation starts. While Pi is still retrying, the run is busy and no outcome is considered. The plugin classifies only the terminal `stopReason`; it never matches error strings or special-cases compaction. Actual user aborts keep rule 7's immediate unlock and never pass through this gate. A resolved decision's own settlement never recursively opens another inquiry; its accepted outcome controls what follows.
9. **Live public AI activity.** Every relevant Pi event queries live `ctx.isIdle()`. Event labels never assign or imply busy/idle. Pi's public value covers active runs, automatic retries, auto-compaction retries, and queued continuations.
10. **One automatic-event timeline with split visibility.** Each automatic continuation, decision failure, and retry-exhaustion result has one immutable canonical body visible to the human and supplied to the model. An accepted AI unlock instead persists one quiet UI-only status entry excluded from model-bound conversation. Raw decision inquiry traffic (prompts, corrections, result calls, results, and unlock statuses) is folded out of later ordinary requests and out of the host's native compaction and branch-summary preparations through the same exact-exchange projection; the accepted continuation is the record that survives. Human styling may wrap or color shared bodies but may not omit fields or independently reformat them. New production code does not reconstruct a separate watchdog-only result list.
11. **Runtime-authored timing.** Every new shared event body freezes its creation time as RFC 3339 with milliseconds and an explicit numeric UTC offset.
12. **Internal protocol isolation and compatibility.** New sessions again contain watchdog-owned inquiries and corrections, hidden from later ordinary model requests through exact-exchange folding; their raw result calls and results stay out of ordinary context while executable calls and provider-required thinking survive until dispatch. Pre-upgrade XML inquiry records stay excluded from provider context through read-only folding without being reinterpreted as decisions; TUI-only records and old optional `watchdogResult` metadata remain readable but are not rewritten, backfilled, timestamped, or used to restore timers. Pi's active branch and compaction behavior is authoritative for new shared events. The watchdog projects the host's public compaction and branch-summary preparations in place through the same exact-exchange semantics, so finalized internal traffic and unlock statuses stay out of native model input while stored session entries are never mutated. This forward-looking projection covers watchdog-owned records on supported native request paths; it does not erase disk history, exports, pre-existing summaries, user quotations, or content another extension independently reintroduces.

---

## Defaults and configuration

| Key | Default | Notes |
|---|---|---|
| `idleDelaySeconds` | `10` | Deprecated compatibility key. It remains accepted/preserved, but runtime ignores it; the inquiry fence is exactly 10 seconds. |
| `maxRetries` | `10` | Budget of accepted, durably published continuations per lock cycle; safe integer in `[1, 10]` |
| `decisionPrompt` | exact default above | Decision-only guidance preceding the fixed outcome and function instructions; nonblank and at most 16,384 Unicode code points |
| `continuePrompt` | exact default above | Guidance embedded verbatim in the fixed continuation body; nonblank and at most 16,384 Unicode code points |
| `reasonTypes` | `["JOB_DONE","WAIT_USER","JOB_BLOCKED","WAIT_CALLBACK"]` | Allowed unlock-verdict types, disclosed only in authorized decision prompts. A valid configured list **replaces** the default. |
| `continueReasonTypes` | `["WORK_REMAINS","VERIFYING"]` | Allowed continuation-verdict types. A valid configured list **replaces** the default. |

The removed key `jevWaitCheck` is an **error**: when present, the extension reports an error diagnostic naming the key (never its nested values or credentials) and it has no effect; other valid keys still apply and load succeeds. The extension resolves no TypeSafe or OpenRouter credential for any jev purpose and modifies none.

**Config locations and precedence** (same pattern as sibling Pi plugins):

1. Built-in defaults
2. Global: `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` (default `~/.pi/agent/pi-continue-watchdog.json`)
3. Trusted project only: `<cwd>/.pi/pi-continue-watchdog.json` when the project is trusted by Pi

Trusted-project fields override global field-by-field (`builtins < global < trusted project`). Invalid high-precedence values must not erase valid lower-precedence values; emit bounded diagnostics. Missing files are silent. Configured prompt limits count Unicode code points without truncation: exactly 16,384 is valid and longer values are invalid. Reason-type list entries are only trimmed and required to be nonblank; they have no identifier regex or artificial per-entry length limit.

**Fence rule:** every candidate decision inquiry cancels/replaces the previous event-loop timer and waits a full fixed 10 seconds. Every relevant event and every child report replaces it, including repeated equal idle reports. Each accepted, durably published continuation advances the `maxRetries` attempt; unlock, invalid responses, inquiry dispatch, corrections, stale results, and transport deferrals advance none.

---

## State model (behavioral)

Per main ownership generation / lock cycle, at least:

| Field / phase | Meaning |
|---|---|
| `locked` | Whether automatic decision-after-idle is armed |
| `attempt` | Number of accepted, durably published continuations consumed in the current cycle (0 after reset) |
| `exhausted` | `locked` and `maxRetries` accepted continuations already consumed; no new inquiry until reset |
| `decisionOpen` | A decision inquiry is currently open with its identity |
| `invalidDecisionAttempts` | Invalid responses consumed by the current inquiry (bounded at three) |
| `decisionFailed` | Locked terminal state after the third invalid response; no automatic requests until reset |
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
- An accepted `unlock` verdict from the current consumed watchdog decision attempt
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

## Reserved decision function protocol

### Registration

**Given** a root Pi process starts a session with the watchdog loaded
**When** the effective configuration is committed
**Then** the plugin registers exactly one model function, `cw`, with:

- name and label `cw`, description exactly `don't use unless ask`
- parameter schema `Type.Object({}, { additionalProperties: true })` — no argument properties, required fields, action enum, or reason enum
- no `promptSnippet`, `promptGuidelines`, field descriptions, or configured values anywhere in the declaration

Registration happens once per process and the declaration and active tool membership never change through locking, waiting, checking, correcting, continuing, or unlocking. The old `unlock_continue_watchdog` name is not retained as an alias; human commands and the shortcut keep their names. Child Pi processes in the watchdog process domain never register the function.

### Authorization

A result submission is authorized only for the current main attachment's active decision attempt whose exact prompt metadata was observed in the corresponding run and plugin-local context and whose finalized assistant batch recorded the submitting tool-call identity. Outside that window — unlocked, non-main, provisional, queued, stale, resolved, or invalidated — object-shaped calls reaching the plugin return `This function is reserved for the plugin. Please try another function.` before plugin payload validation, without revealing action/reason requirements or changing lock state, budgets, timers, or hooks. Pi may reject non-object containers before these hooks; the native diagnostic must also leave watchdog state and unrelated ordinary tools unchanged. An unauthorized call does not request tool-batch termination: ordinary work keeps running.

User takeover, manual unlock, branch or session replacement, ownership loss, shutdown, and unrelated invalidating activity end authorization for that attempt; a later attempt requires its own confirmed prompt.

### Payload contract

The decision prompt (not the public schema) teaches the function's JSON payloads:

- `action`: `continue` or `unlock`, matched case-insensitively after trimming. The retired `wait` action is invalid regardless of its fields; `wait_seconds` never creates timing behavior.
- `continue` additionally requires `reason_type` matched case-insensitively against effective `continueReasonTypes` (default `WORK_REMAINS`, `VERIFYING`), normalized uppercase.
- `unlock` additionally requires `reason_type` matched case-insensitively against effective `reasonTypes` (default `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, `WAIT_CALLBACK`), normalized uppercase.
- `reason_content` is a string, non-empty after trimming, at most 1000 Unicode code points; the prompt gives 500 as guidance, never as a stricter acceptance limit.

Missing fields, wrong types, unrecognized actions or reason types, and invalid bounds are rejected without coercion or truncation. XML and prose are never parsed as a result.

### Batch preflight and staging

During a confirmed decision the watchdog allows only `cw` to execute, without changing the declared or active tool list. The complete assistant batch is inspected at the owned `message_end` before any of its tools run: it must contain exactly one `cw` call and no other tool call. The batch's tool-call identities are recorded so `execute(toolCallId, ...)` correlates to that message and attempt; replayed identifiers and provisional or foreign runs never authorize.

A response with no result call, duplicate result calls, an unrelated/unknown tool call, visible prose, a non-object container, or truncation is invalid as a whole. Project it to a normal stop with no executable calls before native dispatch; neither work side effects nor a valid-looking partial verdict may escape. No per-call result is required for suppressed calls. The response counts once and does not cause an unbudgeted native follow-up. For an admissible singleton, preserve the executable call and required thinking until dispatch.

For one authorized call, `execute` stages either a validated verdict or a named validation error and returns a short result with `terminate: true` for both cases; an authorized validation error is never thrown into an uncontrolled native follow-up loop. At authoritative settlement the staged outcome is finalized once, with fresh ownership and activity checks; a valid-looking response whose call never executed counts as an invalid missing-result response.

### Delivery boundary

Authorized decision instructions state that `cw` submits watchdog control results, not user-facing delivery. Answers, results, reports, and questions belong in the ordinary replies already delivered; `reason_content` never substitutes for a missing deliverable, may be visible to the user, and is a control record. The public function description, schema, and startup context disclose none of this.

---

## Decision inquiry protocol

### Opening

**Given** main is locked, not exhausted, not decision-failed, no decision is open, every observable attachment is idle, the root busy-child set is empty, and the fixed ten-second fence for the authoritative all-idle generation has expired
**When** a fresh idle probe and process-domain fence confirmation still pass
**Then** the watchdog opens exactly one decision inquiry: a hidden trigger-turn custom message whose body is the configured `decisionPrompt` followed by the fixed outcome and function-call contract. Repeated settlement observations never open duplicate inquiries; an exhausted or decision-failed cycle opens none.

The prompt is locally confirmed only when its exact correlated message appears in the corresponding run and the plugin's context observation; queueing or persisting the message alone grants no authority. A later handler can still change the final provider request; the plugin does not certify that downstream boundary.

### Outcomes and accounting

| Accepted verdict | Accounting | Next effect |
|---|---|---|
| `continue` | One retry attempt | Publish one reason-bearing continuation and start its ordinary work turn |
| `unlock` | No attempt | Clear pending work, publish the unlock outcome, retain idle-gated user-ready intent |
| Third invalid response | No continuation attempt | Stay locked but decision-failed; publish the failure event and stop automatic requests for that cycle |

Corrections are scheduled by the runtime, not by Pi's ordinary tool-error follow-up: at most two corrective re-asks follow the initial response, each with a fresh owned and consumed attempt. Dispatch failure, deferral, cancellation, or stale ownership is not an invalid model answer and consumes nothing. Terminal `stopReason: "error"` and human abort keep their existing separate paths.

### Callback waiting

Timed watchdog waits are removed. `WAIT_CALLBACK` remains an unlock reason: it is selected when another agent or program is actually expected to call back and wake the session and no independent authorized action remains; it arms no timer, poll, or fabricated callback and charges no retry attempt. Work lacking a callback uses an available authorized monitoring or task-owned waiting action in ordinary work, or reports the real blocker through an unlock category. Legacy wait and completed-wait records remain readable without restoring a timer or regaining decision authority.

### Finalization fence

Every automatic outcome commits only while the root claim remains current, the latest root fence confirms, the busy-child set is empty, pending messages are absent, and a fresh main idle probe is true — rechecked after the inquiry itself ran, without treating the inquiry's own activity as user takeover. Manual commands and immediate main-abort unlock retain their explicit semantics.

### Context folding

Completed decision inquiries, correction history, result calls, matching tool results, and provider-required thinking are folded out of later ordinary model requests through exact exchange ownership, retaining the accepted continuation in normal conversation order. An accepted unlock folds remove-only: no model-bound replacement body exists, and its human outcome is the quiet UI-only status. Unrelated ordinary work and other extensions' messages are never removed. Legacy XML and wait records stay readable through the same folding without acting as new decisions or restoring timers.

**Native summaries:** the same projection rewrites the host's public `session_before_compact` preparation (both history and split-turn prefix regions) and `session_before_tree` preparation in place, using the exact host-selected entry intervals and fold correlation. Finalized and invalidated owned exchanges, recognizable legacy control replacements, and quiet unlock statuses are excluded from the summarized model input; accepted continuations survive at their selected fold positions; unrelated user/assistant/other-extension records pass through unchanged; the host's summarizer, cut identity, file-operation evidence, settings, cancellation, and stored entries are untouched. The projection is idempotent and never guesses identity from timestamps, content, or object references.

### Shared automatic timeline

New continuation and decision-failure and exhaustion events remain once in normal active-branch conversation order, each with one canonical immutable body built at runtime commit time that is both human-visible and model-bound. Every body carries a runtime-authored RFC 3339 timestamp with milliseconds and an explicit numeric UTC offset and explicitly denies being a user message, request, approval, confirmation, consent, or authorization.

AI unlock is not one of these shared bodies. An accepted AI unlock finalizes as a remove-only fold (no model-bound replacement body) plus one quiet UI-only status custom entry (`pi-continue-watchdog:ai-unlock`, excluded from model input by host custom-entry design), whose metadata records only the typed reason, exchange id, and cycle. Persisted legacy unlock bodies from older versions remain readable on disk and in the timeline for historical compatibility but never reenter ordinary or native model input.

---

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
- attempts reset to `0`; exhaustion clears; pending decision and continuation work is gone; the reserved decision function stays registered
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
- for a current watchdog-owned decision, correction, or continuation, its finalized assistant has no visible abort text; `stopReason` remains `aborted`, driving the same unlock without a missing-verdict retry, extra host turn, queue consumption or compaction
- unlike manual unlock, native abort does not remove additional partial continuation text or tool results; internal decision hiding remains unchanged
- an earlier `message_update` may briefly render the notice before `message_end` normalization; zero-transient visibility is not promised and no Pi host patch is required
- ordinary user-run aborts and tool-level cancellation results retain their existing presentation

**And when** the run ends for any non-aborted reason, or abort cannot be attributed to that run, the plugin does not auto-unlock. Ordinary natural idle settle never counts as abort.

### Example 5 — Locked + authoritative aggregate idle → one decision inquiry before any continuation

**Given** main is locked, not exhausted, not decision-failed, every observable attachment is idle, and the root busy-child set is empty
**When** the latest eligible observation's fixed 10-second fence expires and every wake-time guard still passes
**Then**

- exactly one hidden decision inquiry opens; no direct continuation and no external classification precedes it
- the inquiry body is the configured `decisionPrompt` plus the fixed outcome and `cw` function contract; no other tool may execute while it is confirmed
- an accepted `continue` verdict publishes one attributed next-action continuation (`Continue watchdog · continue · <TYPE> · <timestamp>` with `Suggested next step: <reason>`) with `triggerTurn`, consumes one shared attempt, and starts exactly one ordinary work turn; the `watchdog-continued` hook carries the normalized `REASON_TYPE` and trimmed `REASON` only after the durable publication receipt
- an accepted `unlock` verdict consumes no attempt and takes Example 6's path

### Example 6 — A decision unlock stops the cycle

**Given** a confirmed current decision attempt submits `{"action":"unlock","reason_type":"job_done","reason_content":"All requested package bumps are merged."}`
**Then**

- the watchdog unlocks through the normal authoritative semantics; no acknowledgement-only model request starts
- the persisted fold is remove-only: no model-bound unlock body exists, and the raw inquiry, result call, and result are folded out of later ordinary context and native summaries
- one quiet UI-only status `Continue watchdog unlocked · JOB_DONE · All requested package bumps are merged.` is persisted as the human-visible record, confirmed before the terminal envelope becomes eligible
- one `user-ready` envelope later publishes `STOP_KIND=AI_UNLOCK`, `REASON_TYPE=JOB_DONE`, `REASON=All requested package bumps are merged.` at aggregate idle, waiting for busy children, process-domain confirmation, and both publication artifacts

**And when** config sets `reasonTypes: ["NeedReview", "shipped"]` and the verdict submits `needreview`
**Then**

- the type matches configured `NeedReview` case-insensitively; the normalized value is `NEEDREVIEW`
- default types such as `JOB_DONE` are **not** accepted while this custom list is effective

**And when** the attempt submits an unknown type, an overlong `reason_content`, a retired `wait` action, or pure XML/prose
**Then**

- the response is invalid: it counts once against the three-response budget, a correction prompt re-teaches the contract, and no continuation attempt is charged

**And when** ordinary work calls `cw` before any decision attempt exists
**Then**

- an object-shaped call receives `This function is reserved for the plugin. Please try another function.`; a non-object container may receive Pi's native schema diagnostic instead. In either case, lock state, both budgets, and hooks are unchanged, unrelated tools remain available, and the run is not terminated.

**And when** a decision response mixes `cw` with another tool call
**Then**

- neither tool executes; the owned batch is projected to a normal stop without executable calls; the response counts once as invalid and no native follow-up bypasses the correction budget

### Example 7 — Activity during delay cancels; full delay restarts

**Given** a pending fixed grace for the current authoritative aggregate all-idle generation
**When** any observable session becomes busy before the timer fires
**Then** that timer is cancelled and must not dispatch a continuation

**When** all observable sessions are idle again
**Then** the **full** delay for the **same** current attempt restarts from zero

Stale timer callbacks (wrong generation/epoch/ownership or cleared by busy/unlock/fresh-lock cleanup) must not dispatch a continuation, wake main, or publish terminal state.

### Example 8 — Exhaustion after max accepted continuations

**Given** default `maxRetries = 10` and 10 accepted, durably published continuations have already been consumed in this lock cycle
**When** main remains locked and all observable sessions become idle again
**Then**

- no further inquiry or continuation is dispatched; the state remains **locked and exhausted**
- one timestamped exhaustion event is published and one `user-ready` `EXHAUSTED` envelope fires at the terminal aggregate-idle boundary
- a new actual main user message start or manual `/lock-continue-watchdog` resets attempts and clears exhaustion
- human unlock still works per Example 3, and a later authorized decision can still unlock per Example 6

**Given** the third response of one inquiry is invalid
**When** the correction budget is spent
**Then** no fourth response is requested; the cycle stays locked as decision-failed, one shared failure event publishes, and one `user-ready` `DECISION_FAILED` envelope becomes eligible only under the existing aggregate-idle and ownership rules; manual unlock and a fresh lock cycle retain their normal recovery behavior

### Example 9 — Publication and continuity

- A continuation whose message cannot be durably published rolls its attempt back and publishes neither the hook nor a work turn.
- A continuation that loses ownership across its send publishes no hook.
- Consecutive continuations remain once each in normal chronological context; no duplicate summary block is prepended.
- Ordinary assistant completion does not trigger special deletion of shared events; Pi's compaction and branch selection are authoritative.

### Example 10 — Terminal automatic stop publishes neutral `user-ready`

**Given** the elected main attachment observes a new aggregate-idle epoch and the watchdog has finished every automatic action it can take
**When** the terminal stop is one of:

1. An accepted `unlock` verdict with validated `reason_type` and `reason_content`
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
- the reserved decision function registration is session-scoped: it is never unregistered mid-session, and a fresh root process registers it again at config commit
- no orphaned wakes after demotion/shutdown

### Example 12 — Trusted config overrides with safe fallback

**Given** global and/or trusted-project `pi-continue-watchdog.json`
**When** valid `maxRetries`, `decisionPrompt`, `continuePrompt`, `reasonTypes`, `continueReasonTypes`, and/or `unlockShortcut` are provided
**Then** effective config uses field-level override (trusted project over global over defaults). The deprecated `idleDelaySeconds` key may be parsed/preserved for compatibility but never changes the fixed 10-second runtime fence. A valid `reasonTypes` list replaces its built-in default rather than extending it.

**When** valid `decisionPrompt` and `continueReasonTypes` values are provided
**Then** decision prompts include that guidance and the effective continuation types, and neither key produces a removed-key diagnostic.

**When** `jevWaitCheck` is present
**Then** the extension reports an error diagnostic naming `jevWaitCheck` as removed without displaying its values; other valid keys in the same file still apply and load does not fail, and no jev request occurs.

**When** values are missing, unreadable, or invalid
**Then** retain valid lower-precedence values / defaults and emit bounded diagnostics.

### Example 13 — Publication, language, packaging, CI

**Then** the shipped project:

- is public **`xz-dev/pi-continue-watchdog`**
- uses **English** for source, identifiers, default prompts, CLI/help, UI labels, errors, tests, and README
- is licensed **BSD-3-Clause**
- is **source-installable** from `master` (TypeScript entry via Pi extension manifest)
- has **packed, isolated, stock-Pi** CI/E2E covering the real plugin artifact (not only unit mocks)
