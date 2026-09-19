## Context

See `proposal.md` for motivation and the four delta specs for behavior. The relevant current split is:

- `src/runtime.ts` commits a decision, appends a TUI-only result, emits a semantic hook, and sends a hidden inquiry fold.
- `src/context-fold.ts` replaces a continue exchange with an attributed continuation envelope and removes wait/unlock/failure exchanges. Its exact inquiry identity also supports cancellation and user takeover.
- `src/decision-history.ts` walks the active branch to reconstruct normalized results only for subsequent watchdog checks, with successful-assistant boundaries, retry-recovery exceptions, deduplication, and a separate text budget.
- Pi's documented `CustomEntry` does not enter model context; `CustomMessage` does. The existing inquiry helper requires a replacement fold's content to equal its replacement content. Its generated provider replacement uses `display: false`, which does not prevent model visibility.

The selected design makes accepted results shared messages without making internal decision exchanges public. This is a planning document, not evidence that the new carrier has passed integration tests. Some graph metadata is older than the inspected source; implementation must use current source and the existing packed-Pi harness rather than stale line numbers.

## Goals / Non-Goals

**Goals:**

- Use one immutable text body for each scoped event, not two equivalent-looking formatters.
- Reuse the existing inquiry-fold seam for decision results so continuation run ownership is not moved to a new lifecycle message.
- Keep elapsed-time data local to the accepted wait, with no secondary timeline database or repeated-history reconstruction.
- Verify human rendering and actual provider text, including resume, through the existing test infrastructure.

**Non-Goals:**

- Making all Pi UI text, diagnostic audits, countdowns, or raw XML model-visible.
- Changing manual lock/unlock or abort/error-unlock presentation; their safety and cancellation behavior remains intact.
- Proving that a model will notice a stall or choose VERIFYING, overriding repeated waits, probing remote PIDs, or adding notifications for wait completion.
- Restoring timers across restart, preserving every pre-compaction event verbatim, retroactive session migration, or modifying `pi-extension-utils`/Pi core.
- Writing production source, main specifications, or executable Lean models during this proposal. Synchronizing affected existing models is part of the later implementation slice.

## Decisions

### 1. A visible terminal fold carries the canonical decision result

For accepted continue, wait, AI unlock, and decision failure, construct the canonical event body once and use a replacement fold with that exact body. Publish the fold with `display: true` through the existing public `sendMessage` path. A watchdog-local message type/adapter can widen the helper's literal `display: false` return type without changing the dependency.

A message renderer for the versioned new fold displays its stored `content`, including attribution and continuation guidance. It does not independently format reason fields, regenerate timestamps, or replace the body with a short summary. The context fold emits exactly the same body as its provider-facing replacement. Preserve the existing continuation replacement custom type and correlation details used to recognize watchdog-owned runs.

```text
validated decision
       |
       v
canonical body captured once
       |
       v
visible terminal inquiry fold
       |
       +--> renderer --> same body for human
       |
       +--> context folding --> same body for model
                                  |
                                  +--> continue work, only for continue
```

Remove the new path's separate ContinueEntry/WaitEntry/AI-unlock result append. Keep old entry renderers for old sessions. Diagnostic audit entries remain optional and context-excluded; they are not a second authoritative result stream.

**Alternative:** Keep TUI entries and synthesize model messages from them before each request. Rejected: it keeps two persistence/projection paths and reintroduces branch, compaction, and duplicate-history policy. Sending an independent continue event and a second work-trigger message is also rejected because it changes the lifecycle identity used by the existing cancellation feature.

### 2. Use small, versioned event metadata without a new history schema

New shared records carry an explicit local format marker, event kind, and runtime timestamp alongside existing correlation. Wait records additionally carry their acceptance time, requested seconds, and deadline. Use the body as the durable human/model text; metadata supports scheduling, event identity, and timeline navigation, not a second prompt serializer.

Standalone completed-wait and retry-exhaustion messages use the same canonical formatting and message renderer contract but do not pretend to be inquiry-fold messages. No inquiry result exists to fold in those paths. Send them without triggering a turn and explicitly recognize them as internal lifecycle messages.

The scoped events are:

| Event | Publication boundary | Starts ordinary work? |
| --- | --- | --- |
| Continue | Accepted, current decision at true settle | Yes, existing correlated continuation |
| Wait | Accepted, current decision at true settle | No |
| AI unlock | Accepted decision after authoritative unlock | No |
| Decision failure | Existing invalid-response budget exhausted | No |
| Wait completed | Qualified wake observation after the current deadline | No |
| Retry exhaustion | Existing terminal-idle exhaustion publication point | No |

Checking status, raw invalid answers, parser re-asks, and remove-only cancellation/preemption folds remain internal. A cancelled decision must never become a successful-result event. The accepted result of a continuation remains truthful even if its subsequent work is cancelled; existing cleanup removes only the cancelled assistant residue.

**Alternative:** Turn every rendered item into a context message. Rejected because transient status, diagnostics, and protocol internals are not task-state results and would unnecessarily expand context.

### 3. Freeze local-offset RFC 3339 text at event creation

Capture wall-clock milliseconds from the existing injectable runtime clock at result commit. Format them once using the host's local offset at that instant, including milliseconds and an explicit numeric offset, for example `2026-09-19T16:02:16.951+08:00` or `2026-09-19T08:02:16.951+00:00`. Format each instant with its own offset, including when a wait crosses a daylight-saving transition. No new time-zone configuration or date dependency is needed.

Store the resulting body; a later renderer, different host, or changed configuration must not rewrite it. The session entry's own persistence timestamp remains an audit fact, not a substitute for the timestamp in provider-visible text.

Canonical content includes:

```text
Continue watchdog continued · WORK_REMAINS · 2026-09-19T16:39:21.901+08:00
Automated pi-continue-watchdog event; not a user message, request,
approval, confirmation, consent, or authorization.
Model-generated reason: "Verify the remaining authorized work."
Continuation guidance:
<effective configured guidance>
Resume only work already requested and authorized by the user;
stop and ask when further user input, approval, or assistance is needed.
```

Wait uses a `waiting` heading, requested seconds, start and deadline, and the same attribution boundary. JSON-escape model reasons once to distinguish their text from runtime fields and to neutralize control characters identically for both readers. Preserve the full accepted reason limit; do not reuse the old history parser's shorter limit. Human styling may add color or wrap lines, but may not hide body fields from normal expanded history.

**Alternative:** Add a timestamp only in the TUI renderer or only in message metadata. Rejected because neither ensures the model sees it. Reformatting historical timestamps on each render would violate shared immutable text.

### 4. Track only the current wait and one wake snapshot

Reuse the existing absolute deadline for scheduling. Keep a runtime-owned snapshot of the accepted wait's originating identity, start milliseconds, requested seconds, and deadline. Clear it on the same paths that invalidate wait state: unlock, fresh cycle, ownership loss, session replacement, and shutdown. Renewed activity delays eligibility without changing these values.

At the next qualified wake, sample the runtime wall clock immediately before preparing publication/dispatch, not after the model returns. Calculate observed elapsed seconds as `floor((observedAtMs - acceptedAtMs) / 1000)`. The deadline check already requires `observedAtMs >= deadlineMs`. This is explicitly wall-clock elapsed time, not a new monotonic scheduling guarantee; system-clock corrections remain subject to the existing deadline semantics.

Publish one completed-wait body and prefix the associated decision prompt with exactly that text:

```text
Continue watchdog wait completed · 2026-09-19T16:27:47.951+08:00
Automated pi-continue-watchdog event; not a user message, request,
approval, confirmation, consent, or authorization.
Requested: 1500s
Observed elapsed: 1531s
Started: 2026-09-19T16:02:16.951+08:00
Observed at: 2026-09-19T16:27:47.951+08:00
Only the watchdog delay has elapsed; external task status is not established.
```

Cache that wake snapshot for the pending inquiry and its validation re-asks. An ownership/busy race must not relabel a cancelled wait, publish early, or repeatedly append the same completed-wait event. If the completed-wait record was already published before inquiry dispatch was interrupted, it remains a truthful delay observation; a later attempt for the same wait reuses it instead of claiming another completion. New user input invalidates the pending association. A completed-wait publication failure must fail closed rather than dispatch a timing-aware inquiry lacking its shared event.

The same snapshot supplies a final-attempt wait's completion event immediately before exhaustion at the existing terminal-idle boundary; no extra inquiry is created. Internal timing events neither count as real user messages nor reset attempts.

The wake record and the current inquiry's timing preamble intentionally contain the same text. This is a reference to the current completed delay, not two persisted completion events. Once that inquiry is folded, its prompt/preamble disappears and only the one ordinary wake record remains.

**Alternative:** Sum prior requested durations or use the next accepted decision's timestamp. Rejected because busy time and model response latency make both misleading. A cumulative-duration service or wait-count policy is unnecessary.

### 5. Preserve existing control and publication fences

Continue/wait acceptance must become durable through the shared message before starting a continuation, publishing the corresponding accepted-result semantic hook, or arming a wait. Preserve rollback on publication failure, re-entrant ownership checks, idle qualification, cancellation targets, and existing one-shot terminal publication guards. Do not substitute optional diagnostic-audit persistence for this boundary.

Use the existing public host behavior at true settle. The implementation's first integration slice must establish that the visible fold path persists exactly once, produces matching provider text, and retains the current continuation `message_start` identity. `sendMessage` is fire-and-forget: do not invent a durable acknowledgment or exactly-once cross-process guarantee. If the packed host cannot support the required boundary, stop and report that specific blocker rather than silently adding a second storage stream or upgrading a dependency.

AI unlock remains unlocked even if event publication fails; failure cannot recreate authorization to run. Exhaustion and wake reporting do not alter retry state. Ordinary error/abort gates and manual unlock must still cancel only their existing authorized targets. Keep semantic hook names and values unchanged; completed-wait is not another `watchdog-waiting` acceptance.

**Alternative:** Trigger a new ordinary turn when the wait ends, bypassing decision selection. Rejected because the agreed change supplies information, not a forced polling policy.

### 6. Remove zero-loop reconstruction, not inquiry ownership

Delete `src/decision-history.ts` and its dedicated tests after the shared-event path is proven. Remove its imports, history-prefix assembly, special successful-assistant/retry-recovery boundaries, deduplication, and separate prompt-budget logic.

Stop producing `watchdogResult` solely for reconstruction. Simplify its validator and cleanup plumbing where no other caller needs them. Keep `watchdogOutcome`, exact inquiry id/attempt, the continue replacement identity, and any markers still needed by takeover/cancellation. Parsing old optional metadata must not become a prerequisite for folding the underlying old exchange.

Replace tests of hidden history shape with shared-body/provider-payload examples. Keep tests proving that raw XML, unrelated messages, cancelled assistant residue, and user authorization cannot leak or be misclassified. `continue-timeline` must recognize new shared records while still reading old entries, without counting one fold and its provider projection as two events.

**Alternative:** Retain the old scanner as a legacy fallback. Rejected: it preserves the subsystem being removed and can bypass normal compaction. Legacy compatibility is reading old records and cleaning old exchanges, not reconstructing a new past.

### 7. Let Pi own branch selection and compaction

Do not maintain a second event list. New shared messages participate in ordinary active-branch context, resume, and compaction. Retained events are exact; older compacted events may only exist in Pi's summary. Human scrollback can therefore outlive exact model context just as it does for ordinary conversation. The shared-body contract is not a promise of unbounded history retention.

Pre-upgrade TUI-only records retain their existing renderers. Old continue folds retain their established attributed provider content; old wait/unlock folds still remove their internal exchanges. No upgrade rewrites JSONL, fabricates elapsed time, or restarts a timer. Mixed old/new sessions must be tested.

**Alternative:** Backfill every old result into context. Rejected because it needs migration rules for missing timestamps and compaction, contradicts the simplification goal, and changes old sessions without need.

## Risks / Trade-offs

- **Shared fold display could affect run identity or pending-message behavior** -> Gate the design with the existing packed host, exact correlation checks, and cancellation/steering regressions before deleting the old path.
- **Publishing a result may synchronously change ownership** -> Retain before/after claim fences and prevent later hooks, timers, or work dispatch from the stale owner.
- **Longer visible messages and more ordinary context** -> Reuse one stored body, avoid repeated history blocks, retain current bounds, and rely on normal compaction. Do not add a second short model-only representation.
- **Absolute clock corrections distort physical elapsed time** -> Label the measurement as observed wall-clock elapsed; preserve scheduler semantics and document the assumption rather than claiming monotonic accuracy.
- **Time facts do not guarantee good model judgment** -> Validate transport/timing, not an asserted cognitive outcome. A separate product decision would be required for forced checks or a stall policy.
- **New fold metadata might collide with legacy parsing or cancellation** -> Keep exact correlation stable, mark the new event format locally, and exercise mixed-session resume and preemption cases.
- **A renderer sanitizes content differently from the provider** -> Produce one safe canonical body before publication; render that body instead of formatting metadata again.
- **Documentation/Lean could promise the old context exclusions after implementation** -> Update the behavior contract, architecture, README, and affected existing process models in the corresponding implementation slice. Do not claim Lean proof of actual model reasoning.

## Migration Plan

1. Obtain review of the proposed acceptance examples before the new apply phase. Planning approval does not authorize source edits or final product acceptance.
2. Implement and verify one accepted shared continue/wait event through the existing public packed-Pi seam, retaining legacy readers and cancellation guards.
3. Add wait timing and standalone completion/exhaustion publication with injected-clock and stale-callback examples; extend shared result publication to AI unlock and decision failure.
4. Remove zero-loop production code and replace its internal-shape tests with the observable timeline scenarios. Adapt mixed-session rendering, timeline listing, and resume tests without rewriting old sessions.
5. Synchronize the project contracts and affected `docs/programming-thinking/*.idea.lean`; typecheck/run the exact models and review their stated scope as part of implementation.
6. Run `npm run check` and `npm run test:e2e`, then present scenario evidence to the user. A live installed-plugin trial, deployment, Git commit, or push requires separate scope/authorization and is not part of this proposal.

Rollback is a source/package rollback, not a session data migration. Stored new messages are not erased. Preserve protocol-v1 fold compatibility so an older reader can still clean the underlying inquiry and read replacement text, but do not promise identical rendering on old versions. Reload continues to discard runtime waits as before.
