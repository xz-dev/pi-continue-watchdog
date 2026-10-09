# Architecture and context isolation

This document explains how `pi-continue-watchdog` observes agent activity, decides whether work should continue, and prevents its internal decision exchange from polluting later model requests.

For externally observable requirements, see [`behavior-contract.md`](behavior-contract.md). This document describes the current implementation and its boundaries; it does not replace the behavior contract.

## Current verification boundary

The approved contract is plugin-only: exact owned-run metadata and the plugin's local `context` observation confirm the inquiry phase. A later handler can remove or replace that inquiry before provider dispatch; final payload certification is not supplied by this plugin, stable tool metadata, or Lean proofs. Pi may also reject ordinary non-object `cw` arguments before plugin authorization. These two observed host boundaries are now explicit contract limits, not repaired host behavior. See the [change verification record](../openspec/changes/align-unlock-tool-with-reflection-contract/verification.md) for the earlier strict-contract BLOCK and the revised acceptance evidence.

Owned malformed transports stop at `message_end` without executable calls; admissible singleton calls retain their tool/thinking blocks. Shared publication is acknowledged by a new correlated public branch entry, not by a void send return. This applies to continue, wait, unlock, decision failure, exhaustion, and completed-wait records. Continuation notification waits for a later context/settlement observation. Terminal records and completed-wait bodies retain their original metadata while awaiting confirmation; subsequent eligible lifecycle observations can retry a confirmed missing append. An unreadable receipt is retained without a duplicate send, refund, or terminal signal. Reset, cancellation, or ownership loss invalidates its authority. These safeguards are not a proof of every publication interleaving. “Consumed” below denotes local phase confirmation, not final network-request consumption.

## System overview

The extension has three layers:

1. **Observation** — determine whether the elected root main, every same-process attachment, and every authenticated watchdog-loaded child process are idle.
2. **State machine** — decide when to fence, open a decision inquiry, accept a verdict, wait, exhaust, or decision-fail.
3. **Pi adapter** — connect the state machine to Pi lifecycle, session, provider-context, TUI, and semantic-hook APIs.

```text
real main user message starts
          │
          ▼
silent cleanup → fresh watchdog lock
          │
          ▼
main agent works; ends its ordinary turn
          │
          ▼
observe main, same-process attachments, and authenticated child processes
          │
          ▼
new authoritative aggregate all-idle generation
          │
          ▼
replace timer and wait one fixed 10-second fence
          │
          ▼
qualify the same generation and re-check ownership/auth
          │
          ├─ locked, budget left, not suspended ─► one hidden decision inquiry (continue / unlock)
          │     ├─ prompt consumed → exactly one cw call → continue: one continuation → next turn (1 unit)
          │     ├─ unlock+WAIT_CALLBACK: keep lock, suspend (1 unit) → quiet status → user-ready WAIT_CALLBACK
          │     │     └─ actual ordinary main work starts → resume same cycle (+0 units)
          │     ├─ unlock: quiet unlock status → user-ready AI_UNLOCK
          │     ├─ invalid ×3 → decision-failed terminal state → user-ready DECISION_FAILED
          │     └─ deferred / stale / cancelled ───────────► no accounting, retry at next idle
          ├─ locked, callback-suspended ─► nothing (no inquiry, timer, or poll)
          └─ locked, exhausted, not suspended ───► one exhaustion event → user-ready EXHAUSTED

during a consumed decision attempt only: model submits cw(action, …)
          │
          └─► authorize → preflight the whole batch → stage verdict or error → terminate
                         │
                         └─► accepted: run terminates → user-ready AI_UNLOCK / WAIT_CALLBACK
```

## Module map

| Module | Responsibility |
|---|---|
| `src/hub.ts` | Process-wide attachment registration, main election, and aggregate busy/idle state |
| `src/activity-grace.ts` | One replaceable fixed 10-second fence; every observation replaces it and stale callbacks are inert |
| `src/controller.ts` | Pure lock, decision-window, wait-deadline, invalid-attempt, and exhaustion accounting |
| `src/runtime.ts` | Aggregate generation wiring, ownership/auth fencing, reserved-function registration, decision inquiry lifecycle, verdict finalization, scheduling, and hook publication |
| `src/decision-protocol.ts` | Decision/wait JSON payload validation, fixed decision and correction prompts, and the per-inquiry response collector |
| `src/decision-tool.ts` | Reserved `cw` declaration, shared runtime authorization seam, and terminating result staging |
| `src/watchdog-event.ts` | Versioned event metadata, local-offset RFC 3339 timestamps, legacy-tolerant parsing, and canonical immutable human/model bodies |
| `src/context-fold.ts` | Exact-exchange folding of completed function inquiries plus read-only legacy folding and cancelled-run removal |
| `src/abort-outcome.ts` | Detect canonical main-run `stopReason: "aborted"` outcomes |
| `src/auto-lock.ts` | Start a fresh lock cycle when a real main user message begins processing |
| `src/commands.ts` | Human lock/unlock commands plus status and timeline rendering across new shared events and legacy TUI-only entries |
| `src/semantic-hook.ts` | Publish terminal `user-ready` envelopes without depending on a consumer plugin |
| `src/config-loader.ts` | Merge built-in, global, and trusted-project configuration |

## Observable-agent domain and main election

Every session attachment that loads this extension registers with one process-wide hub and reports:

- session ID;
- whether it has UI;
- one binary AI activity state.

Every relevant Pi event queries the public `ctx.isIdle()` value at that event. The runtime never derives busy or idle from an event label. This covers active runs, automatic retry, auto-compaction retry, and queued continuation as defined by Pi's public API.

The election rules are:

1. a UI-bound attachment wins main when one exists;
2. in a purely headless process, the first bound attachment is the best-effort main;
3. every other attachment is observer-only.

Observers contribute to aggregate busy/idle truth, but only the exact current main owns:

- effective watchdog configuration;
- the controller;
- aggregate grace qualification;
- decision checks;
- notifications and TUI-only entries;
- terminal `user-ready` publication.

“Every agent is idle” therefore means every extension-loaded same-process attachment and every authenticated watchdog-loaded child Pi process in the inherited process domain is idle. Sessions that did not load the extension or did not inherit the authenticated declaration remain outside observable coverage.

## Lock cycle and state machine

The controller tracks:

```text
locked
attempt                      accepted continue/wait verdicts this cycle
exhausted                    shared budget spent
decisionOpen / decisionId    the currently open inquiry
invalidDecisionAttempts      invalid responses of the current inquiry (max 3)
decisionFailed               locked terminal state after the third invalid response
waitUntilMs                  earliest absolute time another automatic decision may open
```

### Fresh cycle

A real main user message and `/lock-continue-watchdog` both start a fresh cycle:

```text
silent unlock cleanup
→ cancel timer, pending decision, wait, and continuation work
→ clear exhausted / attempt / decision accounting
→ fresh lock
→ reconcile aggregate idle
```

The cleanup happens before locking so stale timers, verdicts, or finalizations from an earlier task cannot act on the new task.

An ordinary non-user `agent_start` only performs `ensureLocked()`:

- unlocked becomes silently locked;
- an existing locked cycle preserves its attempt state.

### Unlock

Unlock first assigns `locked = false`, then cancels operational timer and continuation work. Ordinary unlock preserves attempt accounting; only a fresh lock cycle resets it.

### Replaceable idle fence

Every relevant live-state observation cancels and replaces the current candidate. If the newly observed state is eligible, the root starts one event-loop `setTimeout` for a complete 10,000 ms idle fence from that observation. Otherwise it remains blocked. Equal old/new observations are still replacements. The callback captures an identity token so cleared or already-queued stale callbacks are inert.

At expiry the root rechecks enabled/locked eligibility, exact timer generation, empty busy-child set, current ownership, pending messages, and a fresh public `ctx.isIdle()` value before opening the decision inquiry. A rejected confirm remains consumed until a later real event/report; runtime code never self-rearms by internally observing the same facts. There is no periodic polling, stale-timeout inference, or business-level uncertain state.

An accepted continue or wait that consumes the final attempt sets controller exhaustion immediately, but a final wait keeps its own deadline: the exhausted idle epoch can publish `EXHAUSTED` only after that deadline plus fresh aggregate-idle qualification, using one terminal deadline timer.

## Ownership and stale-work fencing

Timers and asynchronous callbacks are not trusted merely because they fired. Runtime work carries or re-checks:

- the exact main ownership claim;
- lifecycle and activity generations;
- aggregate activity generation;
- continuation exchange ID.

Before and after re-entrant Pi calls, the runtime verifies that the original claim still owns main. Old timers, demoted attachments, replaced mains, restarted lock cycles, and shutdown runtimes become inert instead of continuing stale work.

## Reserved decision function and watchdog-owned inquiry

The AI-to-extension channel is one reserved root-only function, `cw`:

```json
{ "action": "unlock", "reason_type": "JOB_DONE", "reason_content": "All requested work is complete." }
```

- Registration happens once per root-process session when the effective config is committed (the same `onConfigReady` path as the unlock shortcut). Child Pi processes in the domain never register it, and the declaration and active membership never change across lock, decision, correction, continue, and unlock phases. An existing lifecycle configuration load that commits different effective reason constraints refreshes the same named declaration before the next decision; equal constraints never re-register, and active membership is preserved by the host's tool refresh.
- The public declaration is minimal but structurally constrained: description exactly `don't use unless ask`, a parameter schema declaring the three required strings (`reason_content`, `reason_type`, `action`), `action` enumerated as `continue`/`unlock`, `reason_type` enumerated as the exact-deduplicated union of effective `reasonTypes` and `continueReasonTypes` in configured spellings, `reason_content` bounded to 1–1000 Unicode code points with a nonblank pattern, `additionalProperties: true`, and no parameter descriptions, examples, defaults, prompt snippets, or guidelines. Structural keywords carry the contract; usage and configured values are still taught only in authorized decision and correction prompts. Runtime validation remains the authority: schema membership never grants a decision, and a reason type allowed only for the other action still fails.
- A pure `prepareArguments` compatibility hook normalizes compatible raw inputs before native schema validation: it trims string `reason_content`, lowercases a valid `action`, and rewrites `reason_type` to the matched configured spelling for that action. It never supplies missing fields, coerces non-strings, changes an invalid action, or truncates a reason — raw invalid values stay invalid.
- Authorization lives in the runtime, checked before plugin action/reason validation in both the `tool_call` gate and `execute`: only the exact current main attachment's locally confirmed attempt and recorded submitting call identity may stage a result. Other calls reaching the plugin return `This function is reserved for the plugin. Please try another function.` without state changes or termination. A schema-invalid ordinary call fails natively without changing watchdog accounting or blocking unrelated ordinary tools.
- Payloads: `action` is `continue` or `unlock` (case-insensitive after trimming); `wait` is a retired invalid action. Continue and unlock additionally require a `reason_type` matched case-insensitively against `continueReasonTypes` or `reasonTypes`; the accepted outcome records the uppercase representation while the matched configured spelling is the input identity preserved through revalidation. `reason_content` is trimmed, non-empty, at most 1000 Unicode code points (500 stated as prompt guidance). XML and prose are never parsed as a result.
- The complete owned batch is preflighted at `message_end` before any tool runs. Malformed batches and payload-invalid singleton cw calls are both projected to a normal stop with no executable calls and count once as invalid, so Pi's native schema-error path can never request a fourth reply; suppressed calls need no per-call result. A schema-admissible singleton with a valid plan keeps its call/thinking blocks, stages its validated verdict or named error, and returns a terminating result. Neither path permits work-tool effects or unbudgeted native follow-ups.
- An accepted `unlock` verdict (other than built-in `WAIT_CALLBACK`, which retains the lock as described below) unlocks through the same controller unlock semantics as other unlocks, clears pending work and wait state, ends its decision without an acknowledgement-only model request, and retains the `user-ready` `AI_UNLOCK` intent with normalized `REASON_TYPE` and trimmed `REASON` for deferred aggregate-idle publication. The shared unlock outcome event is the model-visible record; the raw inquiry traffic folds away.
- Invalid responses follow bounded correction: at most three consumed responses per inquiry, corrections re-teach the same function contract, invalid responses never consume the `maxContinue` budget, and the third failure enters a decision-failed terminal state eligible for `STOP_KIND=DECISION_FAILED` at terminal idle.

The extension-to-AI control channel is a watchdog-owned inquiry. After the fixed ten-second aggregate-idle fence qualifies and fresh idle, ownership, and process-domain guards pass, the runtime opens one hidden decision inquiry: the configured `decisionPrompt` plus the fixed outcome and function contract, sent as a trigger-turn custom message through the shared inquiry handle. Only after the exact prompt is observed in the corresponding run and plugin-local context — correlated through host metadata, never prompt-text matching — can a result act. The runtime, not Pi's ordinary tool-error follow-up, schedules at most two corrective re-asks; dispatch deferral, cancellation, or stale ownership is not an invalid model answer. Terminal `stopReason: "error"` and human abort keep their separate paths.

Accepted verdicts map to controller transitions: `continue` and an `unlock` whose matched type is the built-in `WAIT_CALLBACK` each consume one shared `maxContinue` unit (`recordValidContinue` / `recordValidCallbackSuspension`); any other `unlock` consumes none (`recordValidUnlock`), and the third invalid response enters `decisionFailed` without charging the budget. The callback transition keeps the lock, closes the decision, and sets `callbackSuspended`, which excludes the cycle from inquiry eligibility in both the controller and the runtime aggregate. The first non-internal `agent_start` on the owning main session calls `resumeFromCallback` (+0 units) and retires any still-pending `WAIT_CALLBACK` publication. Exhaustion is eligible only while not suspended. The timed `wait` action is retired and arms nothing.

## Stable tools and blocked execution

The extension deliberately keeps the ordinary active tool list and tool-dependent system-prompt prefix unchanged at all times. The one reserved function is registered permanently in root processes; no lock, decision, wait, or unlock changes the tool set. This avoids tool-list churn, not all possible provider cache misses. During a confirmed decision only `cw` may execute: malformed batches are suppressed before dispatch so no work tool runs and no unbudgeted native follow-up follows. Outside the decision window ordinary tools run normally.

## Context-excluded records

The extension appends context-excluded decision audit entries recording each response's validated verdict or named error; raw response text is never retained. Legacy session files may contain pre-upgrade inquiry markers, decision prompts, folds, and audits; those remain readable but are never rewritten or consulted.

## Exact-exchange folding and legacy compatibility

`registerDecisionContextFolding` folds complete function-based inquiry exchanges — prompts, corrections, executable result calls, matching tool results, and provider-required thinking — out of later ordinary provider requests through exact exchange ownership, retaining the one shared outcome event in normal conversation order. The same `foldInquiryContext` pass keeps legacy XML inquiry records excluded from provider context, so resumed pre-upgrade sessions remain clean without reinterpreting them as decisions. The cancelled-run filter additionally removes an assistant carrying the `pi-continue-watchdog:cancelled` marker for a manually cancelled watchdog-owned run. Ordinary-request folding does not erase persisted function-call arguments and guarantees nothing about native compaction or branch summaries; the extension never rewrites history.

## Resume behavior

On normal `pi -c` recovery:

1. `SessionManager` restores the append-only session and its active branch;
2. legacy plain custom entries remain readable state records but are not Agent messages;
3. uncompacted continuation, wait, completed-wait, unlock, decision-failure, and exhaustion event messages retain their exact stored body;
4. the extension reloads and registers its context transform;
5. before the next provider request, completed decision exchanges (prompts, corrections, result calls, results) and internal legacy decision protocol entries are folded again while the retained shared outcome events remain ordinary context.

Runtime lock state, timers, and wait deadlines are not restored; reopening history never rearms a timer or fabricates a completed-wait observation. No shared event is fabricated from legacy entries, and legacy XML records are never reinterpreted as control submissions. Pi's normal branch selection and compaction decide which new shared events remain exact context; the extension does not scan discarded or sibling history to resurrect them.

The behavior above is the intended resume contract. The current seven packed cases do not establish persistent-session resume coverage; source folding tests alone cannot certify host resume payloads.

## Verdict outcomes and abort

### Accepted continue

- commit one shared continue/wait attempt and increment the budget;
- create one canonical timestamped continuation body carrying the accepted verdict's normalized reason type and reason, and publish it as the visible continuation message;
- confirmed publication failure can refund the current attempt; tested subcases include rejected append and later settlement with no correlated branch entry. An unreadable receipt is not evidence of absence, and the complete ownership/publication matrix remains unverified;
- publish `watchdog-continued` best-effort, with the normalized `REASON_TYPE` and trimmed `REASON`, only after a new correlated public branch entry is observed under the current claim. Neither `message_start` nor the void send return establishes persistence;
- use that same body and correlation identity for the next ordinary turn;
- wait one fixed grace for the next authoritative all-idle generation if still locked.

### Accepted wait

- commit one shared continue/wait attempt and record one acceptance timestamp and deadline; renewed activity defers eligibility without restarting the duration;
- publish one shared wait event (requested seconds, acceptance time, deadline, asserting nothing about external task progress) and one `watchdog-waiting` hook with the trimmed `REASON` and decimal `WAIT_SECONDS`;
- retain an unreadable publication receipt with the original exchange, cycle, acceptance time, and deadline. Later lifecycle/deadline observations retry it (at one-second intervals after an overdue deadline), without refunding on uncertainty or restarting the wait. Unlock or ownership loss invalidates the pending receipt and its wake authority;
- start no ordinary work turn; when the attempt was the final one, exhaustion eligibility waits for the deadline plus aggregate-idle qualification;
- at the first qualified inquiry after the deadline, publish at most one completed-wait event reporting requested seconds, observed elapsed whole seconds, and start/observation times with explicit offsets, then reuse those facts unchanged in corrections.

### Accepted unlock

- for accepted verdicts, assign unlocked before cleanup;
- cancel timers, pending continuation, and wait state;
- do not start another work turn (the staged result terminates the run);
- remain unlocked even if the deferred `user-ready` publication is delayed;
- publish terminal `user-ready` with `AI_UNLOCK`, normalized `REASON_TYPE`, and trimmed `REASON` at aggregate idle only after the correlated shared unlock record is confirmed. Missing or unreadable publication leaves the controller unlocked and requests no acknowledgement turn.

### Invalid responses and decision failure

- each invalid response counts once against the fixed three-response budget and never consumes a continue/wait attempt;
- the runtime schedules at most two corrective re-asks, each with a fresh owned and consumed attempt; dispatch deferral, cancellation, or stale ownership is not an invalid model answer;
- the third invalid response enters the decision-failed terminal state: stay locked, stop automatic requests for the cycle, publish one shared failure event, and make `user-ready` `DECISION_FAILED` eligible under the existing idle rules; manual unlock and a fresh lock cycle retain normal recovery.

### Exhaustion

- when the final permitted continue/wait verdict has been consumed and the agent again settles, publish one timestamped exhaustion event and one `user-ready` `EXHAUSTED` envelope after any accepted wait's deadline;
- start no ordinary work turn; stay locked until a fresh cycle. Mark the exhaustion record published only after its new branch receipt is confirmed, then permit the terminal hook. Completed-wait timing is likewise consumed only after its matching record is confirmed.

### Main abort, manual cancellation, and user takeover

Abort detection uses Pi's persisted canonical assistant outcome `stopReason: "aborted"`, not raw keyboard guesses. A main abort that is not an internally cancelled watchdog run unlocks reasonlessly and cancels watchdog work.

Manual unlock is ownership-aware. Before ordinary unlock cleanup erases operational state, the runtime captures an exact current-main cancellation target only for an accepted decision, correction, or continuation whose public `message_start` matched the correlated exchange identity. The controller becomes unlocked first; the runtime then calls public `ctx.abort()` only when that target is current. A genuine user or foreign custom `message_start` can occur inside the same Pi agent lifecycle as a watchdog-owned run; that event transfers ownership away from the watchdog before any later unlock. Uninterruptible `message_end` neutralizes the target assistant with the `pi-continue-watchdog:cancelled` marker and correlation; context transformation drops the marked assistant; and an idle best-effort splice removes the exact settled entry. Unlock immediately revokes queued and active result-submission authority and invalidates any pending wait deadline: later calls, tool results, or settlement callbacks from the cancelled exchange cannot restart it or affect a later cycle. No model cleanup turn is sent, the extension does not inspect, copy, replay, or explicitly clear Pi's private steering/follow-up queues, and an ordinary uncorrelated run is never adopted by timing or lock-state inference. User input arriving during a watchdog decision preempts it: the complete text and image payload is captured and re-issued once as a fresh user turn after the internal run settles. Child abort causes are not inspected and do not unlock main. Cancellation cannot roll back completed tool effects or guarantee termination of detached/background work that no longer obeys the active run signal.

## Avoiding a persistent `working` state

The runtime never starts nested agent work from inside an unfinished run. Authorized decision results and malformed decision batches terminate the run; unauthorized out-of-phase calls return the reserved-function error without terminating ordinary work. Decision inquiries and automatic continuations are dispatched only from the idle-fence callback after aggregate-idle confirmation, and corrections are scheduled by the runtime within the fixed three-response budget.

The seven packed cases cover declaration stability, ordinary object-shaped rejection, continue, wait, unlock, invalid-object corrections, and custom reasons, with bounded idle checks. The cross-process case covers child coordination and authentication. Separate source-checkout probes exercise image takeover, native malformed-batch paths, and publication ordering/failure. Packed provisional/stale submissions, mixed batches, manual owned-run cancellation, compaction recovery, and persisted resume are not established by those seven cases; the coverage ledger must identify their actual runtime/SDK test layer rather than label them packed coverage.

## Semantic `user-ready` publication

The elected main publishes a plain-data envelope on:

```text
pi:semantic-hook:v1
```

for terminal automatic idle outcomes:

- `AI_UNLOCK`, with the accepted decision verdict's normalized reason type and trimmed reason;
- `WAIT_CALLBACK`, for an accepted lock-retaining callback suspension, with normalized `REASON_TYPE` and trimmed `REASON` (no duration);
- `ERROR_UNLOCK`, for the terminal-error automatic unlock;
- `EXHAUSTED`, after the final unit's work settles (for a final callback suspension, after the resumed callback work settles);
- `DECISION_FAILED`, after the third invalid response of one inquiry.

The producer is unaware of any consumer plugin. Delivery is best-effort, current-listener-only, with no acknowledgement, retry, or replay.

## Configuration

Effective configuration is merged field by field:

```text
built-in defaults
< $PI_CODING_AGENT_DIR/pi-continue-watchdog.json
< trusted <cwd>/.pi/pi-continue-watchdog.json
```

Project configuration is ignored when Pi does not trust the project. Invalid fields fall back to the next lower valid value and produce bounded warnings. The removed key `jevWaitCheck` produces an error diagnostic naming the key only and has no effect. Prompt strings have the 16,384-code-point ceiling. Reason-type list entries are trimmed and required to be nonblank but otherwise retain the existing no-regex, no-artificial-length contract. Decision `reason_content` keeps the 1000-code-point limit.

Lock state, aggregate grace, ownership, and pending continuations are runtime-only. They are not restored across reload, new session, resume, restart, or shutdown. A later real main user message starts a fresh lock cycle.

## Isolation guarantees and limits

### Guaranteed in normal completed flows

- completed decision inquiries, corrections, result calls, and results are folded out of later ordinary provider requests while their one shared outcome event remains ordinary context; executable calls and provider-required thinking survive until dispatch;
- new automatic result messages use the same immutable canonical body in human history and Agent/provider context;
- a manually cancelled watchdog-owned decision or continuation assistant is folded out of later provider context;
- legacy decision internals in resumed sessions stay folded out of provider context;
- normal persistent-session resume re-applies folding without restoring timers or fabricating shared events from legacy records;
- all paths return to idle within bounded E2E deadlines.

### Deliberate limits

The session file is append-only. Persisted decision result-call arguments and legacy pre-upgrade entries (inquiry markers, prompts, folds) remain as Pi-recognizable records. Context folding removes complete exchanges — both function-based and legacy XML — before later ordinary provider requests, but cannot provide the same guarantee if the extension fails to load during recovery or correlation metadata is manually damaged; it also does not erase persisted arguments from native compaction summaries or branch summaries, and it never rewrites history. The folder fails closed in those cases to avoid deleting genuine user conversation. The current design therefore provides normal-run and normal-resume ordinary-request isolation while keeping the extension bounded and reviewable; it is not destructive session-file erasure.

## Verification

`npm run check` covers lint, type checking, unit tests, and build. Focused unit/runtime coverage includes decision argument validation and case-insensitive type normalization, decision prompt construction, reserved-function registration scope (root-only, once, stable declaration and active list), authorization phases (ordinary/provisional/stale/duplicate/mixed batches), attempt accounting and exhaustion, shared `maxContinue` budget across continuations and callback suspensions, callback suspension/resume and exact wake texts, bounded correction and decision-failed, wait deadlines and completed-wait facts, shared-publication rollback, unlock cleanup, manual-unlock cancellation of watchdog-owned decision and continuation runs, stale callbacks, legacy and function-based context folding, and shared human/provider body equality. `npm run test:e2e` installs the packed source artifact against stock Pi and verifies:

- the reserved `cw` function is advertised on every provider request with its minimal declaration and no usage guidance;
- one hidden decision inquiry precedes any ordinary continuation, and completed inquiry internals are folded out of later provider requests;
- an out-of-phase proactive call returns the reserved-function error while the run continues;
- a decision unlock publishing typed `user-ready` exactly once with no acknowledgement-only request;
- a bounded final wait publishing `watchdog-waiting` and deferring `EXHAUSTED` until its deadline;
- three invalid responses ending in `DECISION_FAILED` with exact provider-request counts;
- custom reason types matched case-insensitively in the decision;
- cross-process busy-child coordination across disconnect, reconnect, and child-idle fences;
- canonical abort behavior;
- bounded return from `working` to idle across covered paths.

## Authenticated process-domain layer

```text
same-process watchdog attachments
  -> local hub (main election) + exact attachment activity
  -> one watchdog-owned coordinator / one pi-extension-utils transport node
  -> root-created loopback TCP listener + one framed connection per peer
  <- inherited child/nested Pi observer nodes
```

`pi-extension-utils` supplies authenticated transport, peer status, heartbeat liveness, directed/broadcast JSON data, and a fixed 1-second client reconnect retry. It does not own watchdog counters or decisions. The watchdog business payload is exactly `{agentId, idle}`; authenticated `senderId` must equal `agentId`.

The root maintains a deduplicated busy-child `Set`: `idle:false` adds; `idle:true` and disconnect delete. Connection alone does not change activity. Every accepted report and disconnect creates a fresh `{domainEpoch, activityGeneration}` fence, including equal reports. A child queries live `ctx.isIdle()` immediately after every reconnect and reports it. Root's own activity is checked locally through the hub and live wake-time query, not echoed through the child payload.

The root is the only endpoint creator and decision authority. It binds one ephemeral loopback TCP listener; each authenticated node owns one framed connection, so disconnect maps to one exact peer. `PI_CONTINUE_WATCHDOG_ROOT_PID` marks creator topology; the inherited `PI_EXTENSION_UTILS_PROCESS_DOMAIN` declaration carries the listener endpoint and capability. Final root detach closes the transport and clears only declarations it still owns.

Initial declaration/authentication/transport failures are terminal and sanitized (exit 78). TUI/RPC request Pi's public graceful shutdown with a bounded nonzero fallback; print/json use the bounded fallback because public shutdown is a no-op there. Heartbeat-detected disconnect removes that child from the busy set and therefore counts it idle while transport reconnects. Reconnection itself is activity-neutral; only the immediate fresh live report changes the set and replaces the fence. The extension never prints capabilities, HMAC proofs, raw declarations, or endpoint details.

Coverage begins when an inherited watchdog completes `session_start` and reports activity. Stripped environments and children without watchdog are not observable. Coverage starts only after activity registration; no earlier guarantee is claimed.
