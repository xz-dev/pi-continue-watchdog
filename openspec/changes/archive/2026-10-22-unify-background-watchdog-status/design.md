## Context

See [proposal](proposal.md) for motivation and [canonical contract](specs/watchdog-background-status/spec.md) for behavior. This design is required because one presentation contract spans two repositories and asynchronous execution/lifecycle boundaries.

Current source anchors:

- Continue `src/runtime.ts`: `renderStateStatus` renders the existing row entirely dim; `showLiveStatus` creates a second four-line checking widget. `onStarted`/`onResponse` currently record private inquiry observations, and optional review runs separately from the model request.
- Continue `src/private-decision.ts`: adapts the existing shared private-inquiry runtime, with a three-result-attempt policy and one optional reconsideration. Native provider retry is disabled here.
- Reflect `src/widget.ts`: formats the single dim accounting row; `src/extension.ts` owns admission, `forkObservedChild`, refresh and private result callbacks. Its child already exposes official lifecycle observations and uses native retry.
- Pi supports below-editor component factories, `requestRender()`, semantic theme foreground/background tokens, and terminal-column clipping. No new tab or renderer API is needed.

## Goals / Non-Goals

**Goals:** Keep progress attached to existing owned operations, unify visual language and width priorities, and provide real phase changes without leaking private content or touching scheduling.

**Non-Goals:** Shared execution engine redesign, provider/model fallback, new retry/cancel commands, cross-plugin serialization, a shared npm package, a new configuration switch, result protocol changes, raw tool-log streaming, durable progress history, percentages or ETA.

## Decisions

### 1. Continue is the canonical tracking point, not a runtime coordinator

The same change id exists in both repositories. This change owns the common contract, joint acceptance and cross-repository completion checklist. Reflect owns its local requirements and tasks and references the Continue capability. Its companion is [here](../../../../pi-reflect-watchdog/openspec/changes/unify-background-watchdog-status/proposal.md).

Use repository-relative links, never host-specific absolute paths. On archive, retain canonical identity as `pi-continue-watchdog:watchdog-background-status`, resolve it to the promoted main spec, and update planning links where needed. Either plugin can ship and run independently; joint completion remains open until both pass integration verification. This is documentation coordination, not an atomic multi-repository transaction or a new OpenSpec mechanism.

Alternative rejected: copying the entire shared contract into both projects makes later UI policy drift likely.

### 2. Extend the existing row; remove only the duplicate live panel

Keep Continue's existing status key and Reflect's existing widget key and placement. Continue folds live-checking content into its state row, removes the four-line panel rendering and its obsolete registration/cleanup, and preserves any independently useful status/audit records and accepted outcome presentation.

Use existing dim foreground when inactive. While an owned private operation is pending, use the same `accent` foreground and `toolPendingBg` background in both plugins, padding within available columns. Always include an explicit phase label. Theme-default/no-background terminals still receive that text signal. Do not replace footer/editor/header components.

Alternative rejected: continuing a second panel duplicates progress and makes the two plugins look unrelated.

### 3. Keep a small local live projection, separate from ordinary activity

Store only exact operation identity, visible owner/session scope, monotonic admission time, current phase, known inquiry/attempt metadata and safe admitted helper names on the existing active-operation state. Do not build a generic state machine, event bus or persistent progress store.

The existing Continue `running/idle` and actor/countdown projection continues to describe its current ordinary activity semantics. Reflect's accounting projection remains untouched. Private progress is an additional segment placed right after the plugin name, and it controls highlighting; it is not inferred from `anyBusy`, elapsed accounting, enabled state, loop thresholds or the presence of a queued manual request.

Shared phase vocabulary and observation sources:

| Phase | Actual boundary | Applies to |
| --- | --- | --- |
| `preparing` | admission through runtime/fork setup | both |
| `waiting for model` | authorized prompt/request, with no admitted helper currently executing and no streamed output yet in the current response | both |
| `thinking`/`writing`/`tool call` + indicator + count | official `message_update` streaming deltas (`thinking_delta`, `text_delta`, `toolcall_delta`) of the current private response; replaces `waiting for model` until that response ends | both |
| `tools: read` (or other safe names) | official execution start/end for admitted private evidence helpers | Reflect |
| `validating` | completed result enters existing validation | both |
| `correcting` | invalid result and next authorized correction | both |
| `reviewing` | configured unlock review request starts/settles | Continue |
| `reconsidering` | review challenge authorizes the second inquiry; later stages retain that inquiry label | Continue |
| `publishing` | accepted current result enters existing durable outcome/handoff path | both |
| `cancelling` | authority revoked, exact child still draining in the same visible scope | both |

Skip phases that do not occur. Short synchronous transitions can coalesce into one frame; never delay execution to display each one. Native retry/compaction can refine the phase only when official events expose it; Continue's disabled native retry stays disabled.

### 4. Adapt existing callbacks and exact-child subscriptions

Use admission, `onStarted`, `onResponse`, validation, review and terminal boundaries already present. For finer model/helper lifecycle, observe the exact private child through a narrow facade around the existing runtime's fork and forward the child's interface unchanged. Reflect extends its existing facade; Continue uses that same minimal pattern locally if current callback coverage is insufficient. Unsubscribe on every disposal/failure path.

Where needed, add a local optional stage observer in Continue's adapter to bracket its existing validator and authorize-attempt boundaries; do not change the shared package API. Render callbacks must be bounded, non-throwing observations. They must not change the existing `onStarted` failure contract, swallow execution errors, trigger a prompt, or mutate candidate/outcome data. If a precise transport stage is unavailable, retain the last truthful broader stage rather than claiming an unsupported one.

Count result attempts using existing inquiry metadata and invalid-result policy, not every model/helper event. Label reconsideration separately and retain the original logical operation start time across correction, review and reconsideration. Do not print helper parameters or private streaming text; whitelist tool names. Streaming activity (user feedback after first review: show that output is flowing, not its content) reads only `assistantMessageEvent.type` and `delta.length` from the exact child's `message_update`; never `partial`, delta text or tool-call contents. Kind follows the latest delta; the count covers all streamed kinds of the current response and resets on the next assistant `message_start`; `message_end` returns to model waiting. The braille indicator frame is derived from the streamed count, so it moves only when output arrives. Redraw only when the visible label changes (kind or indicator frame, frame step every 24 characters); the existing 1s tick refreshes the count otherwise. Continue's local fork facade adds the same bounded exact-child subscription Reflect already has and removes it on dispose/failure. When admitted helpers overlap, derive the label from the currently active admitted set rather than incorrectly returning to model waiting after the first finishes.

### 5. Event-driven rendering plus an elapsed-time tick

Every visible state transition requests a render immediately. Reuse each plugin's existing refresh scheduling where possible, but keep it alive while private progress exists even if ordinary agents are idle. Read elapsed operation duration from the runtime's monotonic clock/injected test clock, not timer counts; never feed it back into Reflect accounting.

Have at most one local display tick where the existing architecture permits; avoid an additional polling service. Tick at one second while elapsed progress needs refresh, unref handles, and release them when their display purpose ends. Stop only the private-progress purpose when accounting/countdown still legitimately needs its existing timer. UI failures cannot block outcome publication or change control policy.

### 6. Same responsive priorities, existing controls preserved

Full width retains the existing Continue lock/key/actor or countdown text and Reflect's active/task/root/all/cooldown/queue text, placed after the progress segment. Both rows use one order at every width: plugin identity, active phase, elapsed time and attempt, then controls/counters (user acceptance feedback: a progress suffix on one row and a prefix on the other made it unclear where to look). Compact mode keeps that order and drops secondary controls/counters first. At extremely narrow widths, clip safely rather than promising all fields can fit. Use Pi's `visibleWidth` and `truncateToWidth`; theme formatting is applied at render time.

Illustrative full-width output, not exact punctuation to snapshot-lock:

```text
Continue Watchdog | reviewing · 18s · attempt 1/3 | idle (enabled · alt+u unlock) | asking
Reflect Watchdog | tools: read · 12s · 1/3 | active 1m58s/2 loops · task 1m58s/20m · root 2/60 · all 2/300
```

### 7. Scope rendering independently from result authority

Each observation must match the currently displayed exact operation and visible session/owner scope. A revoked but still-draining operation can show `cancelling` in its own still-current visible scope; it cannot validate or publish. Replacement, demotion or shutdown clears old display and handlers immediately. A late `finally`, child event or review result must not clear a successor's phase or timer.

On settlement, restore the ordinary muted row and existing safe completion/failure/cancellation behavior. Do not invent durable terminal banners. Live fields are memory-only, never `appendEntry`, model context, notifications per tick, or semantic completion hooks. Keep existing Reflect RPC plain-text status; no TUI components in RPC/print paths and no new RPC feature surface for Continue.

## Risks / Trade-offs

- Event gaps or provider-specific retry detail -> show the last truthful broader stage; no guessed token counts or transport details.
- Compact status omits counters -> stage and elapsed time take priority, with full values restored on resize; no underlying values are modified.
- Native theme may not render a visible background -> explicit stage text remains mandatory and semantic tokens adapt to available color support.
- Revoked child still drains -> show cancelling only in the same visible scope, fence every late callback and never cancel parent work for UI cleanup.
- Two repositories can drift or release separately -> Continue retains the open joint checklist and both local verification references; no coupling dependency is introduced.

## Migration Plan

1. Add focused acceptance coverage in existing test suites for one row's private stages and unchanged ordinary status, then implement Continue and Reflect independently against this contract.
2. Run local checks and the paired-plugin acceptance matrix. Verify regular/fullscreen TUI, dark/light/no-color behavior, resize, simultaneous operations, review, correction and takeover. Human acceptance remains pending until demonstrated.
3. Remove Continue's redundant live panel, not canonical outcome records or private result isolation. No configuration or data migration is required.
4. Rollback by restoring the previous local rendering/projection without changing stored history, retry budgets, process-domain accounting or accepted outcomes. Archive each local change normally only after its tasks are done; the Continue joint checklist is the completion authority for the combined work.
