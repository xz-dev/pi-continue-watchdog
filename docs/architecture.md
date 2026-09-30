# Architecture and context isolation

This document explains how `pi-continue-watchdog` observes agent activity, decides whether work should continue, and prevents its internal decision exchange from polluting later model requests.

For externally observable requirements, see [`behavior-contract.md`](behavior-contract.md). This document describes the current implementation and its boundaries; it does not replace the behavior contract.

## System overview

The extension has three layers:

1. **Observation** — determine whether the elected root main, every same-process attachment, and every authenticated watchdog-loaded child process are idle.
2. **State machine** — decide when to fence, continue, exhaust, or accept an unlock-tool stop.
3. **Pi adapter** — connect the state machine to Pi lifecycle, session, provider-context, TUI, and semantic-hook APIs.

```text
real main user message starts
          │
          ▼
silent cleanup → fresh watchdog lock
          │
          ▼
main agent works; ends turn without calling unlock_continue_watchdog
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
          ├─ locked, budget left ─► one direct continuation message → next turn
          └─ locked, exhausted ───► one exhaustion event → user-ready EXHAUSTED

anytime: main agent calls unlock_continue_watchdog(reason_type, reason)
          │
          └─► controller unlock → run terminates → user-ready AI_UNLOCK
```

## Module map

| Module | Responsibility |
|---|---|
| `src/hub.ts` | Process-wide attachment registration, main election, and aggregate busy/idle state |
| `src/activity-grace.ts` | One replaceable fixed 10-second fence; every observation replaces it and stale callbacks are inert |
| `src/controller.ts` | Pure lock, continuation-attempt, and exhaustion accounting |
| `src/runtime.ts` | Aggregate generation wiring, ownership/auth fencing, unlock-tool registration, direct continuation publication, scheduling, and hook publication |
| `src/watchdog-event.ts` | Versioned event metadata, local-offset RFC 3339 timestamps, legacy-tolerant parsing, and canonical immutable human/model bodies |
| `src/unlock-tool.ts` | The `unlock_continue_watchdog` tool: schema, argument validation, AI-unlock application, and rendering |
| `src/context-fold.ts` | Read-only legacy decision-exchange folding plus cancelled-continuation removal before provider requests |
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
attempt
exhausted
```

### Fresh cycle

A real main user message and `/lock-continue-watchdog` both start a fresh cycle:

```text
silent unlock cleanup
→ cancel timer and pending continuation work
→ clear exhausted / attempt accounting
→ fresh lock
→ reconcile aggregate idle
```

The cleanup happens before locking so stale timers or finalizations from an earlier task cannot act on the new task.

An ordinary non-user `agent_start` only performs `ensureLocked()`:

- unlocked becomes silently locked;
- an existing locked cycle preserves its attempt state.

### Unlock

Unlock first assigns `locked = false`, then cancels operational timer and continuation work. Ordinary unlock preserves attempt accounting; only a fresh lock cycle resets it.

### Replaceable idle fence

Every relevant live-state observation cancels and replaces the current candidate. If the newly observed state is eligible, the root starts one event-loop `setTimeout` for a complete 10,000 ms idle fence from that observation. Otherwise it remains blocked. Equal old/new observations are still replacements. The callback captures an identity token so cleared or already-queued stale callbacks are inert.

At expiry the root rechecks enabled/locked eligibility, exact timer generation, empty busy-child set, current ownership, pending messages, and a fresh public `ctx.isIdle()` value before dispatching the continuation. A rejected confirm remains consumed until a later real event/report; runtime code never self-rearms by internally observing the same facts. There is no periodic polling, stale-timeout inference, or business-level uncertain state.

A continuation that consumes the final attempt sets controller exhaustion immediately. The exhausted idle epoch then publishes `EXHAUSTED`; there is no separate terminal deadline timer.

## Ownership and stale-work fencing

Timers and asynchronous callbacks are not trusted merely because they fired. Runtime work carries or re-checks:

- the exact main ownership claim;
- lifecycle and activity generations;
- aggregate activity generation;
- continuation exchange ID.

Before and after re-entrant Pi calls, the runtime verifies that the original claim still owns main. Old timers, demoted attachments, replaced mains, restarted lock cycles, and shutdown runtimes become inert instead of continuing stale work.

## Unlock tool and direct continuation

The AI-to-extension channel is one always-registered tool, `unlock_continue_watchdog`:

```json
{ "reason_type": "JOB_DONE", "reason": "All requested work is complete." }
```

- Registration happens once per root-process session when the effective config is committed (the same `onConfigReady` path as the unlock shortcut). Child Pi processes in the domain never register it, and the tool is never deactivated, so the provider tool list and prompt prefix stay stable across every lock, continuation, and unlock.
- `reason_type` is trimmed and matched case-insensitively against the effective configured `reasonTypes`; the matched configured value is used in uppercase. The schema advertises the allowed values in its description and leaves matching to execute time, so a differently-cased configured value is accepted rather than rejected by schema validation.
- `reason` is trimmed, non-blank, and at most 1000 Unicode code points.
- Invalid arguments throw a named constraint error and become an ordinary failed tool result; the model can retry naturally. There is no re-ask protocol and no separate invalid-response accounting.
- A valid call from the locked current main agent unlocks through the same controller unlock semantics as other unlocks, clears any pending continuation, returns a short successful result with `terminate: true` (no follow-up model request), and retains the `user-ready` `AI_UNLOCK` intent with `REASON_TYPE` and `REASON` for deferred aggregate-idle publication.
- A call while unlocked, from a non-main session, or after a lost race returns a harmless informational result and publishes nothing.
- The tool call and its result are the only model-visible record of the unlock; no separate unlock event message is published.

The extension-to-AI channel is a direct continuation. Where an inquiry used to be sent, the runtime consumes one attempt with `recordAutomaticContinue()`, builds the canonical continuation body (a timestamped `continue` event carrying the configured `continuePrompt` and the unlock-and-wait guidance), sends it as a visible `pi-continue-watchdog:continuation` custom message with `triggerTurn`, correlates the watchdog-owned run through the message's exchange identity for manual-unlock cancellation, and publishes the `watchdog-continued` hook with empty values. On a send failure or ownership loss the attempt is rolled back and retried at a later qualified idle; the hook publishes only after the durable send.

## Stable tools and blocked execution

The extension deliberately keeps the ordinary active tool list and tool-dependent system-prompt prefix unchanged at all times. The one watchdog tool is registered permanently in root processes; no lock, continuation, or unlock changes the tool set, so prompt-cache reuse is preserved. Tool execution is never blocked by the watchdog.

## Context-excluded records

The extension appends no decision audit entries in new flows. The unlock tool call/result and the visible continuation message are ordinary context-bearing messages by design. Legacy session files may contain pre-upgrade inquiry markers, decision prompts, folds, and audits; those remain readable but are never rewritten or consulted.

## Legacy exchange folding

`registerDecisionContextFolding` stays registered read-only: `foldInquiryContext` still folds complete legacy inquiry exchanges (prompt, assistant, re-asks, tool-result metadata) out of provider context and keeps their stored replacements, so resumed pre-upgrade sessions remain clean. The cancelled-continuation filter additionally removes an assistant carrying the `pi-continue-watchdog:cancelled` marker for a manually cancelled watchdog-owned continuation run. New code generates no inquiry prompts, markers, folds, or audits.

## Resume behavior

On normal `pi -c` recovery:

1. `SessionManager` restores the append-only session and its active branch;
2. legacy plain custom entries remain readable state records but are not Agent messages;
3. uncompacted continuation and exhaustion event messages retain their exact stored body;
4. the extension reloads and registers its context transform;
5. before the next provider request, internal legacy decision protocol entries are folded again while the retained shared results remain ordinary context.

Runtime lock state and timers are not restored. No shared event is fabricated from legacy entries. Pi's normal branch selection and compaction decide which new shared events remain exact context; the extension does not scan discarded or sibling history to resurrect them.

Packed E2E covers persistent sessions, confirming old records stay readable and context-excluded, new bodies survive resume unchanged, and later provider payloads contain neither raw XML nor a reconstructed watchdog-history block.

## Unlock, tool-unlock, and abort outcomes

### Automatic continuation

- commit one continuation attempt and increment the shared attempt budget;
- create one canonical timestamped continuation body and publish it as the visible continuation message;
- if publication fails, roll the attempt back and fail closed without hook or turn dispatch; this covers a synchronous throw, ownership loss across the send, and an asynchronous Pi send failure, which is detected when the run settles while the continuation is still pending-start;
- publish `watchdog-continued` best-effort, with no values, only after the message is durable, meaning its correlated `message_start` is observed while the claim is still owned, since Pi's `sendMessage` returns before persistence;
- use that same body and correlation identity for the next ordinary turn;
- wait one fixed grace for the next authoritative all-idle generation if still locked.

### Unlock tool call

- validate type and reason;
- assign unlocked before cleanup;
- cancel timers and pending continuation work;
- do not start another work turn (tool result terminates the run);
- remain unlocked even if the deferred `user-ready` publication is delayed;
- publish terminal `user-ready` with `AI_UNLOCK`, `REASON_TYPE`, and `REASON` at aggregate idle.

### Exhaustion

- when the final permitted continuation has been consumed and the agent again settles without unlocking, publish one timestamped exhaustion event and one `user-ready` `EXHAUSTED` envelope;
- start no ordinary work turn; stay locked until a fresh cycle.

### Main abort, manual cancellation, and user takeover

Abort detection uses Pi's persisted canonical assistant outcome `stopReason: "aborted"`, not raw keyboard guesses. A main abort that is not an internally cancelled watchdog run unlocks reasonlessly and cancels watchdog work.

Manual unlock is ownership-aware. Before ordinary unlock cleanup erases operational state, the runtime captures an exact current-main cancellation target only for an accepted continuation whose public `message_start` matched the continuation message's exchange identity. The controller becomes unlocked first; the runtime then calls public `ctx.abort()` only when that target is current. A genuine user or foreign custom `message_start` can occur inside the same Pi agent lifecycle as a continuation; that event transfers ownership away from the watchdog before any later unlock. Uninterruptible `message_end` neutralizes the target assistant with the `pi-continue-watchdog:cancelled` marker and `piContinuation` correlation; context transformation drops the marked assistant; and an idle best-effort splice removes the exact settled entry. No model cleanup turn is sent, the extension does not inspect, copy, replay, or explicitly clear Pi's private steering/follow-up queues, and an ordinary uncorrelated run is never adopted by timing or lock-state inference. User input arriving during a continuation run simply steers Pi normally: the next real user message starts a fresh lock cycle. Child abort causes are not inspected and do not unlock main. Cancellation cannot roll back completed tool effects or guarantee termination of detached/background work that no longer obeys the active run signal.

## Avoiding a persistent `working` state

The runtime never starts nested agent work from inside an unfinished run. The unlock tool's own result terminates the run without a follow-up request, and continuations are dispatched only from the idle-fence callback after aggregate-idle confirmation.

Packed E2E uses bounded idle assertions against both `session.isIdle` and `session.waitForIdle()` for continuations, unlock-tool turns, exhaustion, abort, compaction recovery, multi-attachment coordination, and persisted resume. These checks fail if Pi remains in `working` beyond the accepted deadline.

## Semantic `user-ready` publication

The elected main publishes a plain-data envelope on:

```text
pi:semantic-hook:v1
```

for terminal automatic idle outcomes:

- `AI_UNLOCK`, with the validated tool reason type and reason;
- `ERROR_UNLOCK`, for the terminal-error automatic unlock;
- `EXHAUSTED`.

The producer is unaware of any consumer plugin. Delivery is best-effort, current-listener-only, with no acknowledgement, retry, or replay.

## Configuration

Effective configuration is merged field by field:

```text
built-in defaults
< $PI_CODING_AGENT_DIR/pi-continue-watchdog.json
< trusted <cwd>/.pi/pi-continue-watchdog.json
```

Project configuration is ignored when Pi does not trust the project. Invalid fields fall back to the next lower valid value and produce bounded warnings. The removed keys `decisionPrompt` and `continueReasonTypes` produce error diagnostics naming the key and have no effect. Prompt strings have the 16,384-code-point ceiling. Reason-type list entries are trimmed and required to be nonblank but otherwise retain the existing no-regex, no-artificial-length contract. The unlock tool's `reason` keeps the 1000-code-point limit.

Lock state, aggregate grace, ownership, and pending continuations are runtime-only. They are not restored across reload, new session, resume, restart, or shutdown. A later real main user message starts a fresh lock cycle.

## Isolation guarantees and limits

### Guaranteed in normal completed flows

- there is no hidden decision question at all: continuation messages are visible by design and the unlock tool is a normal tool call;
- new automatic result messages use the same immutable canonical body in human history and Agent/provider context;
- a manually cancelled watchdog-owned continuation assistant is folded out of later provider context;
- legacy decision internals in resumed sessions stay folded out of provider context;
- normal persistent-session resume re-applies folding without restoring timers or fabricating shared events from legacy records;
- all paths return to idle within bounded E2E deadlines.

### Deliberate limits

The session file is append-only. Legacy pre-upgrade entries (inquiry markers, prompts, folds) remain as Pi-recognizable records. Context folding removes complete legacy exchanges before later provider requests, but cannot provide the same guarantee if the extension fails to load during recovery or correlation metadata is manually damaged. The folder fails closed in those cases to avoid deleting genuine user conversation. The current design therefore provides normal-run and normal-resume provider-context isolation while keeping the extension bounded and reviewable; it is not destructive session-file erasure.

## Verification

`npm run check` covers lint, type checking, unit tests, and build. Focused unit/runtime coverage includes unlock-tool argument validation and case-insensitive type normalization, tool registration scope (root-only, once, stable list), attempt accounting and exhaustion, shared-publication rollback, unlock cleanup, manual-unlock cancellation of watchdog-owned continuation runs, stale callbacks, legacy context folding, and shared human/provider body equality. `npm run test:e2e` installs the packed source artifact against stock Pi and verifies:

- the unlock tool is advertised on every provider request;
- the direct continuation path with no hidden inquiry;
- a tool unlock publishing typed `user-ready` exactly once;
- the simple `watchdog-continued` hook with no values;
- exhaustion after `maxRetries` with one `EXHAUSTED` envelope;
- custom reason types matched case-insensitively through the tool;
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
