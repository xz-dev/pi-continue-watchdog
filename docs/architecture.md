# Architecture and context isolation

This document explains how `pi-continue-watchdog` observes agent activity, decides whether work should continue, and prevents its internal decision exchange from polluting later model requests.

For externally observable requirements, see [`behavior-contract.md`](behavior-contract.md). This document describes the current implementation and its boundaries; it does not replace the behavior contract.

## System overview

The extension has three layers:

1. **Observation** — determine whether the elected root main, every same-process attachment, and every authenticated watchdog-loaded child process are idle.
2. **State machine** — decide when to wait, inquire, continue, unlock, re-ask, exhaust, or stop after invalid responses.
3. **Pi adapter** — connect the state machine to Pi lifecycle, session, provider-context, TUI, and semantic-hook APIs.

```text
real main user message starts
          │
          ▼
silent cleanup → fresh watchdog lock
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
          ▼
open one XML decision check
          │
          ├─ continue ─► fold exchange ─► attributed continuation turn
          ├─ wait ─────► fold exchange ─► absolute not-before deadline
          ├─ unlock  ──► unlock ────────► one muted result entry
          └─ invalid ──► immediate re-ask, at most three responses
```

## Module map

| Module | Responsibility |
|---|---|
| `src/hub.ts` | Process-wide attachment registration, main election, and aggregate busy/idle state |
| `src/activity-grace.ts` | One replaceable fixed 10-second fence combined with an optional absolute wait not-before time; every observation replaces it and stale callbacks are inert |
| `src/controller.ts` | Pure lock, shared continue/wait attempt, absolute wait deadline, exhaustion, failure, and decision-window accounting |
| `src/runtime.ts` | Aggregate generation wiring, ownership/auth fencing, XML capture, shared event publication, current-wait timing, scheduling, and finalization delivery |
| `src/watchdog-event.ts` | Versioned event metadata, local-offset RFC 3339 timestamps, parsing, and canonical immutable human/model bodies |
| `src/decision-protocol.ts` | Fixed continue/wait/unlock XML prompt suffix, XML extraction, validation, and three-response re-ask protocol |
| `src/context-fold.ts` | Correlate complete decision exchanges, replace successful result folds with their exact shared bodies, and remove internal/preempted exchanges before provider requests |
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

The controller tracks at least:

```text
locked
attempt
exhausted
decisionFailed
invalidDecisionAttempts
decisionOpen
waitUntilMs
```

### Fresh cycle

A real main user message and `/lock-continue-watchdog` both start a fresh cycle:

```text
silent unlock cleanup
→ cancel timer and pending decision work
→ clear exhausted / decisionFailed / invalid accounting
→ fresh lock
→ reconcile aggregate idle
```

The cleanup happens before locking so stale timers or finalizations from an earlier task cannot act on the new task.

An ordinary non-user `agent_start` only performs `ensureLocked()`:

- unlocked becomes silently locked;
- an existing locked cycle preserves its attempt and decision state.

### Unlock

Unlock first assigns `locked = false` and resets `waitUntilMs = 0`, then cancels operational timer and decision work. Ordinary unlock preserves retry/failure accounting; only a fresh lock cycle resets it.

### Replaceable inquiry fence and wait deadline

Every relevant live-state observation cancels and replaces the current candidate. If the newly observed state is eligible, the root starts one event-loop `setTimeout` targeting the later of (a) a complete 10,000 ms idle fence from that observation and (b) the controller's absolute `waitUntilMs`. Otherwise it remains blocked. Equal old/new observations are still replacements. The callback captures an identity token so cleared or already-queued stale callbacks are inert.

At expiry the root rechecks enabled/locked eligibility, exact timer generation, empty busy-child set, current ownership, pending messages, a fresh public `ctx.isIdle()` value, and `now >= waitUntilMs` before any decision logic. A rejected confirm remains consumed until a later real event/report; runtime code never self-rearms by internally observing the same facts. There is no periodic polling, stale-timeout inference, or business-level uncertain state.

A wait that consumes the final attempt sets controller exhaustion immediately but has a separate terminal deadline timer. `user-ready` remains fenced by `waitUntilMs`; only after the deadline can the exhausted idle epoch publish `EXHAUSTED`. Unlock, fresh lock, demotion, and shutdown clear this timer, and callback identity makes a queued stale callback inert.

## Ownership and stale-work fencing

Timers and asynchronous callbacks are not trusted merely because they fired. Runtime work carries or re-checks:

- the exact main ownership claim;
- lifecycle and activity generations;
- aggregate activity generation;
- decision ID;
- exchange ID;
- decision cycle ID.

Before and after re-entrant Pi calls, the runtime verifies that the original claim still owns main. Old timers, demoted attachments, replaced mains, restarted lock cycles, and shutdown runtimes become inert instead of continuing stale work.

## Decision request

After the aggregate idle delay expires, the runtime re-checks that all observable attachments are still idle. Immediately before dispatch it persists a context-excluded inquiry boundary:

```ts
pi.appendEntry("pi-continue-watchdog:inquiry-marker", {
  version: 1,
  exchangeId,
  cycleId,
});
```

Only after that succeeds does it send the Pi `CustomMessage` through a shared per-attempt inquiry handle:

```ts
{
  customType: "pi-continue-watchdog:inquiry",
  display: false,
  content: decisionPromptWithOptionalCurrentWaitPreambleAndFixedXmlSuffix,
  details: {
    version: 1,
    namespace: "pi-continue-watchdog",
    inquiryId: exchangeId,
    attempt: cycleId
  }
},
{
  triggerTurn: true,
  deliverAs: "steer"
}
```

The marker's exchange/cycle identity maps exactly to the inquiry's `inquiryId`/`attempt` correlation. The shared attempt handle owns correlation, pending/sent/completed/cancelled state, first-terminal-wins, capture, neutralization, and idempotent remove-fold cleanup. The Pi adapter owns `ctx.abort()` and original-input pass-through. A failed cleanup send retains the same fold for retry at uninterruptible `message_end` or `agent_settled`.

This is a logical boundary, not a physical-adjacency contract: unrelated plugin custom entries or messages may appear between the marker, decision prompt, fold marker, and finalized assistant.

`display: false` hides the question itself from normal TUI history. The decision assistant may stream in TUI/RPC while the check runs. Ordinary tools stay advertised. The prompt remains model-visible because the model must read it to decide. This package does not request `presentation: "hidden"` and does not depend on a downstream Pi hidden-run seam.

The configurable prompt supplies decision intent. When a still-current accepted wait has reached its deadline, the exact already-published completed-wait body is prefixed as a current-wake timing reference. Runtime always appends a fixed suffix after that:

- identifies the check as extension automation rather than a user request or decision;
- tells the model to use existing conversation context and decide quickly;
- forbids tool use;
- requires exactly one trailing `<watchdog>...</watchdog>` block;
- explicitly prohibits making decisions on the user's behalf;
- reconciles requests with the latest ordinary answer and tool results before classification; completed, cancelled, or superseded work is not revived by stale plans or watchdog reasons;
- presents an ASCII decision tree and completion-first rules: completed work unlocks, incomplete immediately executable authorized work continues, otherwise user-dependent work unlocks, external automation waits, and other blockers unlock;
- states that unfinished work alone is not sufficient reason to continue and that a pending user-gated action does not block continue when independent requested and authorized work remains immediately executable;
- lists the independent effective unlock and continue reason types;
- gives canonical typed continue/unlock examples and an untyped wait example with integer seconds from 1 through 1800.

### Shared automatic event timeline

Accepted continue, wait, AI unlock, and decision-failure results use a visible terminal inquiry fold. Continue projects through the correlated `pi-continue-watchdog:continuation` replacement; the other accepted results project through a `pi-continue-watchdog:event` replacement. Retry exhaustion and completed-wait timing are standalone `pi-continue-watchdog:event` lifecycle messages. All six carry the same versioned watchdog-event metadata and one canonical stored `content` body.

The runtime captures wall-clock milliseconds and the local UTC offset when each event is created. The body freezes an RFC 3339 timestamp with milliseconds and an explicit numeric offset; renderers display the stored body and never regenerate time or reason text. Wait acceptance additionally freezes requested seconds and the absolute deadline. At the next eligible wake for the same wait, the runtime samples the clock before dispatch and publishes at most one completed-wait body containing the original acceptance time, requested seconds, observation time, and `floor((observedAtMs - acceptedAtMs) / 1000)` elapsed seconds. The text states that only the watchdog delay elapsed and makes no claim about an external task.

The current wait snapshot belongs to its originating wait identity. Activity may defer eligibility but does not restart acceptance time or deadline. Unlock, fresh lock, ownership loss, session replacement, and shutdown invalidate pending reporting. Validation re-asks reuse the same wake snapshot and timing preamble. A final-attempt wait publishes completed-wait before retry exhaustion at the existing terminal-idle boundary, without starting an inquiry or ordinary work turn.

New events stay in normal active-branch conversation order and are subject to Pi's ordinary compaction. There is no backward branch scan, successful-assistant boundary, dedicated prompt-history budget, or reconstructed `Previous watchdog results` block. Ordinary continuations and later watchdog inquiries receive retained shared events through the same context path. Raw inquiry prompts, XML, malformed answers, validation re-asks, diagnostics, audit entries, and cleanup/correlation records remain outside this timeline.

Pre-upgrade `watchdogResult` metadata may remain in old folds, but new code neither generates nor depends on it. Legacy TUI-only entries and old folds remain readable and foldable; they are not rewritten, backfilled into model history, assigned timestamps, or used to restore runtime waits.

## Stable tools and blocked execution

The extension deliberately keeps the ordinary active tool list and tool-dependent system-prompt prefix unchanged during a decision. This avoids a decision-only tool set changing the provider prompt prefix and reducing prompt-cache reuse.

Tool availability in the request does not imply execution is allowed. While a main decision is active, the extension intercepts `tool_call` before execution and returns a blocking reason. The same model run can then finish with XML. A blocked call does not itself consume one invalid-response attempt; the final assistant response is authoritative.

## XML protocol

Before choosing an XML shape, the model applies the fixed suffix's ordered guards:

```text
Compare requests with actual delivery
|
+-- Complete --> unlock (JOB_DONE)
+-- Incomplete, authorized action executable now --> continue
+-- No executable action, needs user --> unlock (WAIT_USER)
+-- No executable action, waiting for automation --> wait
+-- Other blocker --> unlock (JOB_BLOCKED)
```

These are prompt-level decision semantics, not runtime heuristics. The fixed suffix requires checking the latest ordinary answer before claiming it is missing, while retaining genuine unfinished earlier work. A final response/stop marker alone does not imply completion. The tree substitutes semantic descriptions when configured reason lists omit built-in names. Parser acceptance, configured reason lists, and field validation remain unchanged. Packed mocked-provider coverage checks that a delivered answer precedes this check in the actual request; it cannot prove that a real model will always classify correctly.

A continue response ends with:

```xml
<watchdog>
  <function>continue_watchdog</function>
  <reason_type>WORK_REMAINS</reason_type>
  <reason_content>Implementation work remains.</reason_content>
</watchdog>
```

A wait response ends with:

```xml
<watchdog>
  <function>wait_watchdog</function>
  <reason_content>Waiting for automation.</reason_content>
  <wait_seconds>300</wait_seconds>
</watchdog>
```

An unlock response ends with:

```xml
<watchdog>
  <function>unlock_continue_watchdog</function>
  <reason_type>WAIT_USER</reason_type>
  <reason_content>User approval is required.</reason_content>
</watchdog>
```

The parser:

1. ignores thinking blocks;
2. concatenates final text blocks and trims surrounding whitespace;
3. requires the trimmed text to end with `</watchdog>`;
4. requires exactly one literal opening and one literal closing watchdog tag in the complete answer;
5. extracts from the sole opening tag through the end;
6. decodes normal XML text entities;
7. rejects duplicate required fields.

Narration may precede the XML, but nothing except whitespace may follow it. Multiple watchdog blocks are invalid.

Continue and unlock use typed reasons:

- `reason_type` is trimmed and matched case-insensitively against the independent effective list (`continueReasonTypes` for continue, `reasonTypes` for unlock);
- the matched configured value is emitted in uppercase.

All three outcomes use the same reason validation:

- `reason_content` must be nonblank and at most 1000 Unicode code points; the decision prompt advises at most 500 (derived as half the hard limit);
- invalid AI reasons are rejected rather than truncated.

Wait rejects any supplied `reason_type`. Its trimmed `wait_seconds` must contain decimal digits representing a safe integer from 1 through 1800; invalid values are rejected rather than clamped.

The model receives at most three total decision responses. Invalid responses trigger immediate re-asks and do not consume the shared valid continue/wait attempt budget. The third invalid response enters `decisionFailed` until a fresh cycle.

## Decision streaming and user takeover

The decision uses ordinary Pi `sendMessage({ triggerTurn: true, deliverAs: "steer" })`. Public subscribers may see the live assistant stream. At `message_end`, the runtime captures the original response for validation/audit and returns a same-role empty-content replacement. Stock Pi updates the current TUI component and persists the replacement, so finalized XML or aborted partial content does not remain in history. Context folding then removes the complete exchange from later provider requests.

Interactive or RPC user input during a submitted decision preempts that check:

1. the original user message stays in Pi's queue and is not re-sent by the watchdog;
2. the runtime persists a foldable `preempted` marker and aborts only the watchdog decision;
3. `message_end` clears the aborted decision assistant and sets `stopReason` to `stop` so TUI does not show `Operation aborted`;
4. abort-unlock is suppressed for that one decision, so lock remains and no `Continue watchdog unlocked` notice appears;
5. the user message starts a fresh lock cycle exactly once.

Manual Esc / ordinary abort of a non-preempted main run still unlocks reasonlessly. If that run is a watchdog decision, `message_end` keeps `stopReason: "aborted"` for abort attribution while clearing partial content. Provider `stopReason: "error"` remains provisional and visible because Pi may automatically retry within the same run.

## Context-excluded audit records

Decision audit data is persisted with `pi.appendEntry()` as a plain `CustomEntry`:

```text
pi-continue-watchdog:decision-audit
```

Pi explicitly treats plain custom entries as display/state records that do not participate in context. They are saved in the session and readable by Pi or this extension after `pi -c`, but they are not projected into Agent messages and are never sent to the provider. Shared automatic events do not derive from audit entries; the runtime publishes their canonical bodies directly through the inquiry-fold or standalone-message seam.

Audit shapes are deliberately structured and bounded:

```json
{
  "version": 1,
  "exchangeId": "…",
  "cycleId": 1,
  "outcome": "continue",
  "reasonType": "VERIFYING",
  "reason": "Tests still need to run."
}
```

```json
{
  "version": 1,
  "exchangeId": "…",
  "cycleId": 1,
  "outcome": "wait",
  "reason": "Waiting for CI.",
  "waitSeconds": 300
}
```

```json
{
  "version": 1,
  "exchangeId": "…",
  "cycleId": 1,
  "outcome": "unlock",
  "reasonType": "WAIT_USER",
  "reason": "User approval is required."
}
```

```json
{
  "version": 1,
  "exchangeId": "…",
  "cycleId": 1,
  "outcome": "invalid",
  "error": "End the response with one valid watchdog XML decision block."
}
```

Invalid audits retain only the fixed validator error, never the raw invalid model text.

Legacy visible result records remain registered as `CustomEntry` renderers for pre-upgrade sessions. New accepted continue, wait, and AI-unlock results are not written as a second TUI-only stream; their visible terminal fold is the shared event.

## Complete exchange folding

The session remains append-only and still contains Pi-recognizable protocol entries such as:

- the decision `CustomMessage`;
- any streamed or finalized assistant metadata;
- blocked tool results, if any;
- re-asks;
- a terminal fold marker, including `preempted` after user takeover, with a validated normalized terminal result when written by the current version.

Before every provider request, `src/context-fold.ts` correlates a complete exchange by protocol version, exchange ID, and cycle IDs. Complete exchanges fold normally, and a canonical decision prompt followed by an aborted assistant is removed as a bounded plugin-owned pair. Unrelated custom messages may be interleaved inside a correlated exchange; folding preserves those entries while removing only watchdog-owned messages. An unrelated, incomplete, or malformed exchange fails closed locally for its own correlation ID; it cannot disable folding for later independent exchanges.

Terminal outcomes transform context as follows.

### Continue

```text
ordinary conversation
+ complete watchdog exchange
```

becomes:

```text
ordinary conversation
+ one visible automated continuation event
  - immutable local-offset acceptance timestamp
  - extension source and non-user attribution
  - no approval / confirmation / consent / authorization
  - JSON-serialized model-generated reasonType and reason
  - configured continuePrompt guidance
  - resume-only-authorized-work and stop-at-user-boundary instructions
```

Pi converts this same visible fold to a provider-facing user-role message and uses it to trigger the next ordinary work turn. Human rendering and provider content therefore share the exact stored body; there is no independent summary formatter or duplicate continue entry.

### Wait, AI unlock, and decision failure

Their complete decision exchanges become one visible, provider-visible shared result body. They start no ordinary work turn. Raw prompts, XML answers, re-asks, and tool-result metadata remain removed. A completed-wait preamble inside its associated inquiry repeats the exact current-wake body only as an ephemeral timing reference; it is not a second persisted event.

### User preemption and internal cleanup

These exchanges fold to nothing. No raw decision content remains in the provider request, and no successful-result event is fabricated.

Plain audit and legacy visible-result `CustomEntry` records require no folding because SessionManager never projects them into Agent context.

## Resume behavior

On normal `pi -c` recovery:

1. `SessionManager` restores the append-only session and its active branch;
2. legacy plain custom entries remain readable state records but are not Agent messages;
3. uncompacted new shared event messages retain their exact stored body;
4. the extension reloads and registers its context transform;
5. before the next provider request, internal decision protocol entries are folded again while the retained shared result remains ordinary context.

Runtime lock/wait state and timers are not restored. No completed-wait event, elapsed value, or new shared history is fabricated from legacy entries. Pi's normal branch selection and compaction decide which new shared events remain exact context; the extension does not scan discarded or sibling history to resurrect them.

Packed E2E covers mixed legacy/new persistent sessions, confirming old records stay readable and context-excluded, new bodies survive resume unchanged, old timers are not rearmed, and later provider payloads contain neither raw XML nor a reconstructed watchdog-history block.

## Continue, wait, unlock, invalid, and abort outcomes

### Continue

- show a live colored `Continue watchdog checking` widget for the active decision cycle;
- persist diagnostic cards for validation re-asks or other errors outside model context;
- commit the accepted continue and increment the shared continue/wait attempt;
- clear the live checking widget;
- create one canonical timestamped continue body and publish it as the visible terminal fold;
- if shared publication fails, fail closed without hook or continuation dispatch;
- publish `watchdog-continued` best-effort only after the shared body is durable;
- use that same fold body and correlation identity for the next ordinary turn;
- wait one fixed grace for the next authoritative all-idle generation if still locked.

### Wait

- validate reason and integer seconds in `1..1800` without a reason type;
- commit the accepted wait and increment the shared attempt;
- capture acceptance time, requested seconds, absolute deadline, and a unique current-wait identity;
- publish one canonical timestamped waiting body as the visible terminal fold before hook publication or scheduling;
- on publication failure, roll back the attempt/deadline and fail closed without a wait;
- publish `watchdog-waiting` best-effort, start no ordinary work turn, keep the lock, and qualify the next inquiry against the unchanged absolute deadline;
- at the next eligible wake for that same wait, publish at most one completed-wait body with requested versus observed wall-clock seconds; reuse it across validation re-asks;
- if the wait consumed the final attempt, publish completed-wait immediately before exhaustion at the terminal boundary and start neither inquiry nor work;
- invalidate pending completion reporting on unlock, fresh lock, ownership loss, replacement, or shutdown.

### AI unlock

- validate type and reason;
- assign unlocked before cleanup;
- cancel timers and pending decision work;
- append optional context-excluded audit data and publish one canonical timestamped unlock body as the visible terminal fold;
- do not start another work turn;
- remain unlocked even if event publication fails;
- publish terminal `user-ready` at aggregate idle.

### Invalid response

- capture the raw response in the extension lifecycle while Pi persists redacted assistant metadata;
- append a structured invalid audit without raw text;
- use the captured response to compute the fixed validator error;
- re-ask after settle;
- after the third invalid response, enter `decisionFailed`, publish one canonical timestamped failure fold containing only the safe validator diagnostic, warn the user, and return to idle.

### Main abort, manual cancellation, and user preemption

Abort detection uses Pi's persisted canonical assistant outcome `stopReason: "aborted"`, not raw keyboard guesses. A main abort that is not an internally cancelled watchdog run unlocks reasonlessly and cancels watchdog work. Its bounded decision prompt/aborted-assistant pair is removed from later provider context without requiring a persisted fold marker.

Manual unlock is ownership-aware. Before ordinary unlock cleanup erases operational state, the runtime captures an exact current-main cancellation target only for a submitted decision or an accepted continuation whose public `message_start` matches the continue inquiry-fold's inquiry id/attempt and replacement metadata. The controller becomes unlocked first; the runtime then calls public `ctx.abort()` only when that target is current. A genuine user or foreign custom `message_start` can occur inside the same Pi agent lifecycle as a continuation; that event transfers ownership away from the watchdog before any later unlock. Uninterruptible `message_end` neutralizes the target assistant with `pi-continue-watchdog:cancelled`; context transformation drops the marked assistant; and an idle best-effort splice removes the exact settled entry. The one-shot abort suppression prevents the ordinary main-abort observer from notifying or unlocking again. No model cleanup turn is sent, the extension does not inspect, copy, replay, or explicitly clear Pi's private steering/follow-up queues, and an ordinary uncorrelated run is never adopted by timing or lock-state inference. Pi may consume queued follow-ups during abort without automatically resuming them; the watchdog makes no stronger queue-delivery guarantee because public extension APIs expose neither atomic abort-and-preserve nor safe queue replay.

User input that takes over a submitted watchdog decision remains distinct: the assistant is neutralized, a `preempted` fold marker is persisted, lock remains, and the original user message starts the next cycle. At a true idle boundary, splice lookup requires the exact inquiry marker, matching decision and preempted/cancelled fold, plus an empty `stopReason: "stop"` assistant carrying the matching internal marker; unrelated plugin entries are skipped rather than treated as ownership. On session start while idle, the preempted scan recovers marked takeover assistants left by a process exit before splice. Child abort causes are not inspected and do not unlock main. Cancellation cannot roll back completed tool effects or guarantee termination of detached/background work that no longer obeys the active run signal.

## Avoiding a persistent `working` state

The runtime separates finalization from delivery:

- `message_end` captures and hides the response;
- `agent_end` computes and caches the protocol finalization;
- only after Pi reaches true idle and emits `agent_settled` does the extension deliver continue, wait, unlock, re-ask, or failure effects.

It does not start nested agent work from inside an unfinished `agent_end` run. This lets Pi clear its active-run state before the watchdog starts another turn.

Packed E2E uses bounded idle assertions against both `session.isIdle` and `session.waitForIdle()` for continue, unlock, three invalid responses, abort, compaction recovery, multi-attachment coordination, and persisted resume. Focused runtime tests cover wait delivery and deadline behavior without real-time sleeps. These checks fail if Pi remains in `working` beyond the accepted deadline.

## Semantic `user-ready` publication

The elected main publishes a plain-data envelope on:

```text
pi:semantic-hook:v1
```

for terminal automatic idle outcomes:

- `AI_UNLOCK`, with validated type and reason;
- `EXHAUSTED`;
- `DECISION_FAILED`.

`EXHAUSTED` is withheld while an accepted final wait still has `waitUntilMs` in the future. The producer is unaware of any consumer plugin. Delivery is best-effort, current-listener-only, with no acknowledgement, retry, or replay.

## Configuration

Effective configuration is merged field by field:

```text
built-in defaults
< $PI_CODING_AGENT_DIR/pi-continue-watchdog.json
< trusted <cwd>/.pi/pi-continue-watchdog.json
```

Project configuration is ignored when Pi does not trust the project. Invalid fields fall back to the next lower valid value and produce bounded diagnostics. Prompt strings alone have the 16,384-code-point ceiling. Reason-type list entries are trimmed and required to be nonblank but otherwise retain the existing no-regex, no-artificial-length contract. Canonical event bodies preserve the validated reason under its existing 1000-code-point limit; there is no separate history formatter or prompt-history budget.

Lock state, wait deadline, aggregate grace, ownership, and pending decisions are runtime-only. They are not restored across reload, new session, resume, restart, or shutdown. A later real main user message starts a fresh lock cycle.

## Isolation guarantees and limits

### Guaranteed in normal completed flows

- the decision question is not shown in normal TUI history (`display: false`);
- a completed decision exchange is folded out of later provider context;
- a user-preempted decision leaves no assistant/XML residue in later provider context;
- raw invalid model text is not retained in audits or shared events;
- new automatic result messages use the same immutable canonical body in human history and Agent/provider context;
- complete terminal decision protocol internals are absent from later provider requests while their one shared result remains;
- completed-wait text distinguishes requested duration from observed wall-clock elapsed time and does not claim external progress;
- normal persistent-session resume re-applies folding without restoring timers or fabricating shared events from legacy records;
- decision paths return to idle within bounded E2E deadlines.

### Deliberate limits

The session file is append-only. It may retain the decision question, an empty assistant metadata entry, tool-result metadata, re-ask, and fold marker as Pi-recognizable protocol entries. Live TUI/RPC frames during an in-flight decision are not retroactively retracted, but the finalized TUI component and persisted assistant content are cleared at `message_end`. Context folding removes a complete or preempted exchange before later provider requests, but cannot provide the same guarantee if:

- the extension fails to load during recovery;
- the process dies before the abort-safe terminal assistant replacement or preempted fold marker is persisted;
- correlation metadata is manually damaged.

The folder fails closed in those cases to avoid deleting genuine user conversation. The current design therefore provides normal-run and normal-resume provider-context isolation while keeping the extension bounded and reviewable; it is not destructive session-file erasure.

## Verification

`npm run check` covers lint, type checking, unit tests, and build. Focused unit/runtime coverage includes wait XML bounds, shared attempt accounting, shared-publication rollback, absolute-deadline requalification after activity, requested-versus-observed elapsed timing, current-wait invalidation, unlock cleanup, stale callbacks, context folding, shared human/provider body equality, legacy metadata tolerance, prompt privacy, timeline compatibility, and final-wait completed-before-exhaustion ordering. `npm run test:e2e` installs the packed source artifact against stock Pi and verifies:

- multi-loader, same-process aggregate-idle ownership;
- threshold compaction recovery;
- the real default ten-second decision path;
- stable ordinary tools during decision and continuation;
- continue and typed unlock outcomes;
- context-excluded audits and future-context folding;
- three invalid responses and terminal idle;
- canonical abort behavior;
- semantic-hook publication;
- persistent session reopen with clean ordinary provider context;
- one visible shared continue body is the exact provider continuation body;
- consecutive waits remain in normal chronological context without a reconstructed history block;
- mixed legacy/new persistent sessions stay readable without backfill, invented timestamps, or timer restoration;
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
