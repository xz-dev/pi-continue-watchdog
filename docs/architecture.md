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
          ├─ continue ─► fold exchange ─► compact continuation turn
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
| `src/runtime.ts` | Aggregate generation wiring, ownership/auth fencing, XML capture, audit entries, wait persistence/scheduling, and finalization delivery |
| `src/decision-protocol.ts` | Fixed continue/wait/unlock XML prompt suffix, XML extraction, validation, and three-response re-ask protocol |
| `src/context-fold.ts` | Correlate complete decision exchanges and remove them, or replace continue with its compact prompt, before provider requests |
| `src/abort-outcome.ts` | Detect canonical main-run `stopReason: "aborted"` outcomes |
| `src/auto-lock.ts` | Start a fresh lock cycle when a real main user message begins processing |
| `src/commands.ts` | Human lock/unlock commands plus TUI-only continue, wait, unlock, status, and timeline rendering |
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
  content: decisionPromptWithFixedXmlSuffix,
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

The configurable prompt supplies decision intent. Runtime always appends a fixed suffix that:

- identifies the check as extension automation rather than a user request or decision;
- tells the model to use existing conversation context and decide quickly;
- forbids tool use;
- requires exactly one trailing `<watchdog>...</watchdog>` block;
- explicitly prohibits making decisions on the user's behalf;
- lists the independent effective unlock and continue reason types;
- gives canonical typed continue/unlock examples and an untyped wait example with integer seconds from 1 through 1800.

## Stable tools and blocked execution

The extension deliberately keeps the ordinary active tool list and tool-dependent system-prompt prefix unchanged during a decision. This avoids a decision-only tool set changing the provider prompt prefix and reducing prompt-cache reuse.

Tool availability in the request does not imply execution is allowed. While a main decision is active, the extension intercepts `tool_call` before execution and returns a blocking reason. The same model run can then finish with XML. A blocked call does not itself consume one invalid-response attempt; the final assistant response is authoritative.

## XML protocol

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

- `reason_content` must be nonblank and at most 500 Unicode code points;
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

Pi explicitly treats plain custom entries as display/state records that do not participate in context. They are saved in the session and readable by Pi or this extension after `pi -c`, but they are not projected into Agent messages and are never sent to the provider.

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

The visible muted wait and unlock results are also `CustomEntry` records with registered renderers. Audit and visible-result entries are excluded from model context; the latter remain in TUI history:

```text
Continue watchdog waiting · 300s · Waiting for CI.
Continue watchdog unlocked · WAIT_USER · User approval is required.
```

## Complete exchange folding

The session remains append-only and still contains Pi-recognizable protocol entries such as:

- the decision `CustomMessage`;
- any streamed or finalized assistant metadata;
- blocked tool results, if any;
- re-asks;
- a terminal fold marker, including `preempted` after user takeover.

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
+ configured continuePrompt
```

The compact continuation message triggers the next ordinary work turn.

### Wait, unlock, decision failure, and user preemption

```text
ordinary conversation
+ complete watchdog exchange
```

becomes:

```text
ordinary conversation
```

No decision content remains in the provider request.

Plain audit and visible-result `CustomEntry` records require no folding because SessionManager never projects them into Agent context.

## Resume behavior

On normal `pi -c` recovery:

1. `SessionManager` restores the append-only session;
2. plain custom entries remain readable state records but are not Agent messages;
3. the extension reloads and registers its context transform;
4. before the next provider request, the complete terminal decision exchange is folded again;
5. the provider receives only ordinary conversation, plus the compact continuation message for a continue outcome.

Packed E2E creates a persistent session, triggers a decision, shuts it down, reopens the same file with `SessionManager.open()`, sends another ordinary prompt, and inspects the actual provider payload. It verifies the resumed request contains no watchdog question, XML answer, audit entry, or fold marker.

## Continue, wait, unlock, invalid, and abort outcomes

### Continue

- show a live colored `Continue watchdog checking` widget for the active decision cycle;
- persist a colored TUI-only card for every validation re-ask or other error, preserving the safe parser error or original provider error content;
- record the accepted continue;
- increment the shared continue/wait attempt;
- clear the live checking widget;
- append one TUI-only `Continue watchdog continued` entry so automatic continuation and possible token-consuming loops remain visible;
- if that entry cannot be persisted, fail closed without dispatching continuation;
- append the terminal fold marker;
- fold the exchange into `continuePrompt`;
- trigger the next ordinary turn;
- wait one fixed grace for the next authoritative all-idle generation if still locked.

### Wait

- validate reason and integer seconds in `1..1800` without a reason type;
- record the accepted wait and increment the shared attempt;
- persist one TUI-only `Continue watchdog waiting` entry before scheduling;
- on persistence failure, roll back the attempt/deadline and fail closed without a wait;
- append a wait fold marker so the exchange disappears from later context;
- start no ordinary work turn;
- keep the lock and qualify the next inquiry against the absolute `waitUntilMs`;
- if the wait consumed the final attempt, schedule only terminal deadline publication and do not emit `EXHAUSTED` early.

### AI unlock

- validate type and reason;
- assign unlocked before cleanup;
- cancel timers and pending decision work;
- append context-excluded audit and one muted visible result;
- do not start another work turn;
- publish terminal `user-ready` at aggregate idle.

### Invalid response

- capture the raw response in the extension lifecycle while Pi persists redacted assistant metadata;
- append a structured invalid audit without raw text;
- use the captured response to compute the fixed validator error;
- re-ask after settle;
- after the third invalid response, enter `decisionFailed`, append a terminal fold marker, warn the user, and return to idle.

### Main abort and user preemption

Abort detection uses Pi's persisted canonical assistant outcome `stopReason: "aborted"`, not raw keyboard guesses. A main abort that is not a user-preempted watchdog decision unlocks reasonlessly and cancels watchdog work. Its bounded decision prompt/aborted-assistant pair is removed from later provider context without requiring a persisted fold marker. User input that takes over a submitted watchdog decision is not treated as that abort: the assistant is neutralized, a `preempted` fold marker is persisted, lock remains, and the original user message starts the next cycle. At a true idle boundary, splice lookup requires the exact inquiry marker, matching decision and preempted fold, plus an empty `stopReason: "stop"` assistant carrying `pi-continue-watchdog:preempted`; unrelated plugin entries are skipped rather than treated as ownership. On session start while idle, the same scan recovers marked assistants left by a process exit before splice. Child abort causes are not inspected and do not unlock main.

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

Project configuration is ignored when Pi does not trust the project. Invalid fields fall back to the next lower valid value and produce bounded diagnostics.

Lock state, wait deadline, aggregate grace, ownership, and pending decisions are runtime-only. They are not restored across reload, new session, resume, restart, or shutdown. A later real main user message starts a fresh lock cycle.

## Isolation guarantees and limits

### Guaranteed in normal completed flows

- the decision question is not shown in normal TUI history (`display: false`);
- a completed decision exchange is folded out of later provider context;
- a user-preempted decision leaves no assistant/XML residue in later provider context;
- raw invalid model text is not retained in audits;
- audit and visible-result custom entries never enter Agent/provider context;
- complete terminal decision exchanges are absent from later provider requests;
- normal persistent-session resume re-applies folding before the next provider request;
- decision paths return to idle within bounded E2E deadlines.

### Deliberate limits

The session file is append-only. It may retain the decision question, an empty assistant metadata entry, tool-result metadata, re-ask, and fold marker as Pi-recognizable protocol entries. Live TUI/RPC frames during an in-flight decision are not retroactively retracted, but the finalized TUI component and persisted assistant content are cleared at `message_end`. Context folding removes a complete or preempted exchange before later provider requests, but cannot provide the same guarantee if:

- the extension fails to load during recovery;
- the process dies before the abort-safe terminal assistant replacement or preempted fold marker is persisted;
- correlation metadata is manually damaged.

The folder fails closed in those cases to avoid deleting genuine user conversation. The current design therefore provides normal-run and normal-resume provider-context isolation while keeping the extension bounded and reviewable; it is not destructive session-file erasure.

## Verification

`npm run check` covers lint, type checking, unit tests, and build. Focused unit/runtime coverage includes wait XML bounds, shared attempt accounting, persistence rollback, absolute-deadline requalification after activity, unlock cleanup, stale callbacks, context folding, TUI records, and final-wait-delayed exhaustion. `npm run test:e2e` installs the packed source artifact against stock Pi and verifies:

- multi-loader, same-process aggregate-idle ownership;
- threshold compaction recovery;
- the real default ten-second decision path;
- stable ordinary tools during decision and continuation;
- continue and typed unlock outcomes;
- context-excluded audits and future-context folding;
- three invalid responses and terminal idle;
- canonical abort behavior;
- semantic-hook publication;
- persistent session reopen with clean provider context;
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
