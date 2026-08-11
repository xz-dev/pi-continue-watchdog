# Architecture and context isolation

This document explains how `pi-continue-watchdog` observes agent activity, decides whether work should continue, and prevents its internal decision exchange from polluting later model requests.

For externally observable requirements, see [`behavior-contract.md`](behavior-contract.md). This document describes the current implementation and its boundaries; it does not replace the behavior contract.

## System overview

The extension has three layers:

1. **Observation** — determine whether the elected main agent and every same-process observable child are idle.
2. **State machine** — decide when to wait, inquire, continue, unlock, re-ask, exhaust, or stop after invalid responses.
3. **Pi adapter** — connect the state machine to Pi lifecycle, session, provider-context, TUI, and semantic-hook APIs.

```text
real main user message starts
          │
          ▼
silent cleanup → fresh watchdog lock
          │
          ▼
observe main and same-process children
          │
          ▼
new authoritative aggregate all-idle generation
          │
          ▼
wait one fixed idleDelaySeconds grace
          │
          ▼
qualify the same generation and re-check ownership/auth
          │
          ▼
open one hidden XML decision check
          │
          ├─ continue ─► fold exchange ─► compact continuation turn
          ├─ unlock  ──► unlock ────────► one muted result entry
          └─ invalid ──► immediate re-ask, at most three responses
```

## Module map

| Module | Responsibility |
|---|---|
| `src/hub.ts` | Process-wide attachment registration, main election, and aggregate busy/idle state |
| `src/activity-grace.ts` | One fixed grace per authoritative aggregate activity generation; stale callbacks are inert |
| `src/controller.ts` | Pure lock, attempt, exhaustion, failure, and decision-window accounting |
| `src/runtime.ts` | Aggregate generation wiring, ownership/auth fencing, XML capture, audit entries, and finalization delivery |
| `src/decision-protocol.ts` | Fixed XML prompt suffix, XML extraction, validation, and three-response re-ask protocol |
| `src/context-fold.ts` | Correlate complete decision exchanges and remove or replace them before provider requests |
| `src/abort-outcome.ts` | Detect canonical main-run `stopReason: "aborted"` outcomes |
| `src/auto-lock.ts` | Start a fresh lock cycle when a real main user message begins processing |
| `src/commands.ts` | Human lock/unlock commands and TUI-only unlock-result rendering |
| `src/semantic-hook.ts` | Publish terminal `user-ready` envelopes without depending on a consumer plugin |
| `src/config-loader.ts` | Merge built-in, global, and trusted-project configuration |

## Observable-agent domain and main election

Every session attachment that loads this extension registers with one process-wide hub and reports:

- session ID;
- whether it has UI;
- one binary AI activity state.

Local activity has only two lifecycle transitions: `agent_start` assigns busy;
a true `agent_settled` assigns idle. Tool execution, model output, and waiting for
Provider output remain inside that busy interval and are not separate states.

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

“Every agent is idle” therefore means every **same-process, extension-loaded, observable** attachment is idle. Out-of-process agents and sessions that did not load the extension are outside this domain.

## Lock cycle and state machine

The controller tracks at least:

```text
locked
attempt
exhausted
decisionFailed
invalidDecisionAttempts
decisionOpen
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

Unlock first assigns `locked = false`, then cancels operational timer and decision work. Ordinary unlock preserves retry/failure accounting; only a fresh lock cycle resets it.

### Aggregate-generation grace

The runtime composes broker activity, main ownership, and binary local AI
activity into one generation. Any busy transition, pending input/spawn,
ownership change, or domain uncertainty invalidates that generation. Each new
authoritative all-idle generation gets exactly one fixed `idleDelaySeconds`
grace. Valid continue decisions consume `maxRetries` only; they do not change
the grace duration. The runtime does not poll host subphases between lifecycle
boundaries to reinterpret tool execution, output, or Provider wait as new states.

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

After the aggregate idle delay expires, the runtime re-checks that all observable attachments are still idle and sends a hidden Pi `CustomMessage`:

```ts
{
  customType: "pi-continue-watchdog:decision",
  display: false,
  content: decisionPromptWithFixedXmlSuffix,
  details: { version, exchangeId, cycleId }
}
```

`display: false` hides the question from normal TUI history. It remains model-visible for this decision request because the model must read it to decide.

The configurable prompt supplies decision intent. Runtime always appends a fixed suffix that:

- identifies the check as extension automation rather than a user request or decision;
- tells the model to use existing conversation context and decide quickly;
- forbids tool use;
- requires exactly one trailing `<watchdog>...</watchdog>` block;
- lists the effective configured reason types;
- gives canonical continue and unlock examples.

## Stable tools and blocked execution

The extension deliberately keeps the ordinary active tool list and tool-dependent system-prompt prefix unchanged during a decision. This avoids a decision-only tool set changing the provider prompt prefix and reducing prompt-cache reuse.

Tool availability in the request does not imply execution is allowed. While a main decision is active, the extension intercepts `tool_call` before execution and returns a blocking reason. The same model run can then finish with XML. A blocked call does not itself consume one invalid-response attempt; the final assistant response is authoritative.

## XML protocol

A continue response ends with:

```xml
<watchdog><function>continue_watchdog</function></watchdog>
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

For unlock:

- `reason_type` is trimmed and matched case-insensitively against effective `reasonTypes`;
- the matched configured value is emitted in uppercase;
- `reason_content` must be nonblank and at most 500 Unicode code points;
- invalid AI reasons are rejected rather than truncated.

The model receives at most three total decision responses. Invalid responses trigger immediate hidden re-asks and do not consume the valid-continue retry budget. The third invalid response enters `decisionFailed` until a fresh cycle.

## Hiding the provider XML

Pi 0.83 exposes a public `message_end` replacement seam. During an active decision, the runtime:

1. reads and normalizes the original finalized assistant response;
2. stores that normalized response only in runtime memory;
3. validates it and appends a structured audit entry;
4. returns a same-role replacement with empty content.

Conceptually:

```ts
pi.on("message_end", event => {
  captureAndAudit(event.message);
  return {
    message: {
      ...event.message,
      content: [],
    },
  };
});
```

Pi applies this replacement before final listeners and `SessionManager.appendMessage()`, and mutates the finalized message object in place. Consequently:

- the final TUI history no longer retains the XML;
- Agent state and later lifecycle events see the empty replacement;
- the persisted assistant entry has empty content;
- the raw XML is not stored as assistant content.

The original response is held only until runtime finalization. `agent_end` uses the captured response rather than trying to parse the empty replacement. Provider `stopReason: "error"` messages remain provisional because Pi may automatically retry within the same run; the first later successful response is captured and finalized normally, while a true final settle with no verifiable response consumes one invalid attempt. Captured data is cleared on terminal delivery, cleanup, ownership loss, restart, abort, and shutdown so it cannot leak into a later cycle.

### Streaming boundary

`message_end` is a finalization seam. While a provider is streaming, Pi may briefly render partial XML through `message_update`; final TUI history is cleared at `message_end`. Preventing even transient streaming display would require an earlier Pi-level hidden-stream facility.

## Context-excluded audit records

Decision audit data is persisted with `pi.appendEntry()` as a plain `CustomEntry`:

```text
pi-continue-watchdog:decision-audit
```

Pi explicitly treats plain custom entries as display/state records that do not participate in context. They are saved in the session and readable by Pi or this extension after `pi -c`, but they are not projected into Agent messages and are never sent to the provider.

Audit shapes are deliberately structured and bounded:

```json
{ "version": 1, "exchangeId": "…", "cycleId": 1, "outcome": "continue" }
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

The visible muted unlock result is also a `CustomEntry`, but has a registered renderer. Thus both audit and visible result are excluded from model context; only the latter appears in TUI history:

```text
Continue watchdog unlocked · WAIT_USER · User approval is required.
```

## Complete exchange folding

The session remains append-only and still contains Pi-recognizable protocol entries such as:

- the hidden decision `CustomMessage`;
- the empty replacement assistant;
- blocked tool results, if any;
- hidden re-asks;
- a terminal fold marker.

Before every provider request, `src/context-fold.ts` correlates a complete exchange by protocol version, exchange ID, and cycle IDs. Complete exchanges fold normally, and a canonical decision prompt followed by an aborted assistant is removed as a bounded plugin-owned pair. An unrelated, incomplete, or malformed exchange fails closed locally for its own correlation ID; it cannot disable folding for later independent exchanges.

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

### Unlock and decision failure

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

## Continue, unlock, invalid, and abort outcomes

### Continue

- show a live colored `Continue watchdog checking` widget for the active decision cycle;
- persist a colored TUI-only card for every validation re-ask or other error, preserving the safe parser error or original provider error content;
- record the accepted continue;
- increment the continue attempt;
- clear the live checking widget;
- append one TUI-only `Continue watchdog continued` entry so automatic continuation and possible token-consuming loops remain visible;
- if that entry cannot be persisted, fail closed without dispatching continuation;
- append the terminal fold marker;
- fold the exchange into `continuePrompt`;
- trigger the next ordinary turn;
- wait one fixed grace for the next authoritative all-idle generation if still locked.

### AI unlock

- validate type and reason;
- assign unlocked before cleanup;
- cancel timers and pending decision work;
- append context-excluded audit and one muted visible result;
- do not start another work turn;
- publish terminal `user-ready` at aggregate idle.

### Invalid response

- replace the raw response with an empty assistant;
- append a structured invalid audit without raw text;
- use the captured response to compute the fixed validator error;
- re-ask after settle;
- after the third invalid response, enter `decisionFailed`, append a terminal fold marker, warn the user, and return to idle.

### Main abort

Abort detection uses Pi's persisted canonical assistant outcome `stopReason: "aborted"`, not raw keyboard guesses. A main abort unlocks reasonlessly and cancels watchdog work. Its bounded decision prompt/aborted-assistant pair is removed from later provider context without requiring a persisted fold marker. Child abort causes are not inspected and do not unlock main.

## Avoiding a persistent `working` state

The runtime separates finalization from delivery:

- `message_end` captures and hides the response;
- `agent_end` computes and caches the protocol finalization;
- only after Pi reaches true idle and emits `agent_settled` does the extension deliver continue, unlock, re-ask, or failure effects.

It does not start nested agent work from inside an unfinished `agent_end` run. This lets Pi clear its active-run state before the watchdog starts another turn.

Packed E2E uses bounded idle assertions against both `session.isIdle` and `session.waitForIdle()` for continue, unlock, three invalid responses, abort, compaction recovery, multi-attachment coordination, and persisted resume. These checks fail if Pi remains in `working` beyond the accepted deadline.

## Semantic `user-ready` publication

The elected main publishes a plain-data envelope on:

```text
pi:semantic-hook:v1
```

for terminal automatic idle outcomes:

- `AI_UNLOCK`, with validated type and reason;
- `EXHAUSTED`;
- `DECISION_FAILED`.

The producer is unaware of any consumer plugin. Delivery is best-effort, current-listener-only, with no acknowledgement, retry, or replay.

## Configuration

Effective configuration is merged field by field:

```text
built-in defaults
< $PI_CODING_AGENT_DIR/pi-continue-watchdog.json
< trusted <cwd>/.pi/pi-continue-watchdog.json
```

Project configuration is ignored when Pi does not trust the project. Invalid fields fall back to the next lower valid value and produce bounded diagnostics.

Lock state, aggregate grace, ownership, and pending decisions are runtime-only. They are not restored across reload, new session, resume, restart, or shutdown. A later real main user message starts a fresh lock cycle.

## Isolation guarantees and limits

### Guaranteed in normal completed flows

- the hidden question is not shown in normal TUI history;
- the final XML is removed from final TUI history;
- raw XML is not persisted as assistant content;
- raw invalid model text is not retained in audits;
- audit and visible-result custom entries never enter Agent/provider context;
- complete terminal decision exchanges are absent from later provider requests;
- normal persistent-session resume re-applies folding before the next provider request;
- decision paths return to idle within bounded E2E deadlines.

### Deliberate limits

The session file is append-only. It may retain the hidden question, empty assistant replacement, blocked tool result, re-ask, and fold marker as Pi-recognizable protocol entries. Context folding removes a complete terminal exchange before provider requests, but cannot provide the same guarantee if:

- the extension fails to load during recovery;
- the process dies before a terminal fold marker is persisted;
- correlation metadata is manually damaged or interleaved with unrelated messages.

The folder fails closed in those cases to avoid deleting genuine user conversation. The current design therefore provides normal-run and normal-resume provider-context isolation while keeping the extension bounded and reviewable; it is not destructive session-file erasure.

## Verification

`npm run check` covers lint, type checking, unit tests, and build. `npm run test:e2e` installs the packed source artifact against stock Pi and verifies:

- multi-loader, same-process aggregate-idle ownership;
- threshold compaction recovery;
- the real default ten-second decision path;
- stable ordinary tools during decision and continuation;
- continue and typed unlock outcomes;
- final XML replacement and context-excluded audits;
- three invalid responses and terminal idle;
- canonical abort behavior;
- semantic-hook publication;
- persistent session reopen with clean provider context;
- bounded return from `working` to idle across covered paths.

## Authenticated process-domain layer

```text
same-process watchdog attachments
  -> local hub (main election) + exact attachment activity
  -> one watchdog coordinator / one pi-process-domain participant
  -> root-owned embedded per-domain broker on a private endpoint
  <- inherited child/nested Pi observer participants
```

`pi-process-domain` supplies immutable certain/all-idle snapshots and `{brokerEpoch, activityGeneration}` fences. The root captures a fence for each aggregate grace/decision and confirms it before automatic effects. Root's artificial watchdog decision run is suppressed only for that exact local attachment; any other local or remote work invalidates the decision. Stale automated exchanges are folded from later model context.

The domain creator is decision root while its embedded broker is open. `PI_CONTINUE_WATCHDOG_ROOT_PID` marks that creator role and keeps inherited processes observer-only; final root detach clears the marker, closes the broker, and a later attachment creates a fresh domain instead of preserving a closed topology. Authentication remains the domain's 256-bit capability, which is never part of the endpoint path. Attachments await domain open before hub/controller participation and detach the shared participant after the final local shutdown.

Initial declaration/authentication/protocol/runtime-path failures are terminal and sanitized (exit 78), including a startup domain-key mismatch. TUI/RPC request Pi's public graceful shutdown with a bounded nonzero fallback; print/json use the bounded fallback because public shutdown is a no-op there. Runtime lease, reconnect, or broker loss instead makes watchdog decisions uncertain/fail-closed without terminating Pi or reviving a protocol-v2 broker. The extension never prints keys, HMAC values, reservation tokens, raw declarations, or endpoint details.

Coverage begins when inherited watchdog `session_start` completes. Strict spawn-before-registration coverage requires launcher `reserveSpawn()` cooperation. Stripped environments and children without watchdog are not observable.
