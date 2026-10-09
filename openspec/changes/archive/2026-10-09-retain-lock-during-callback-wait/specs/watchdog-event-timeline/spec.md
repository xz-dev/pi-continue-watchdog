## MODIFIED Requirements

### Requirement: Active-branch and upgrade compatibility
The watchdog SHALL use Pi's normal active-branch and compaction boundaries without scanning sibling history to reconstruct its own timeline. Reopening retained continuation, UI-only unlock, and callback-suspension records SHALL preserve their published data without rerunning actions or restoring locks, suspensions, budgets, pending signals, or timers. Legacy wait, elapsed-wait, unlock, and failed-decision records SHALL remain readable without rewriting stored history. A pre-upgrade `WAIT_CALLBACK` unlock record SHALL remain a historical unlock, not be reinterpreted as a new suspension or re-emitted with a new stop kind. Existing summaries created before this change SHALL NOT be claimed to have been retroactively cleaned. New projection logic SHALL retain exact-exchange legacy cleanup without deleting unrelated user or extension messages.

#### Scenario: Resume a new event
- **WHEN** a session containing a continuation and an AI-unlock status is reopened
- **THEN** their retained presentation data is available and neither action runs again
- **AND** the AI-unlock status is absent from subsequent ordinary model requests

#### Scenario: Resume an old session
- **WHEN** history includes an accepted wait or elapsed-wait event from an older version
- **THEN** it remains readable without a restored deadline or newly synthesized timing event

#### Scenario: Compaction or branch navigation removes earlier events
- **WHEN** native compaction summarizes older events or the user selects another branch
- **THEN** the watchdog respects the resulting summary and selected branch boundary
- **AND** it does not restore discarded or sibling events through a private history scan

#### Scenario: Existing summary contains old control text
- **WHEN** a pre-upgrade summary already includes a watchdog reason or protocol text
- **THEN** the watchdog does not rewrite that summary or claim that raw-entry filtering removed its content

#### Scenario: Old callback unlock and new suspension coexist
- **WHEN** retained history contains a legacy `WAIT_CALLBACK` unlock followed by a new callback-suspension status
- **THEN** each keeps its original recorded effect and neither restores execution or publishes another hook on reopen

### Requirement: Shared continuation and exhaustion event body
New continuation, exhaustion, and decision-failure events SHALL retain one canonical model-bound body shared with human history, apart from styling and wrapping. Actual AI-unlock and callback-suspension statuses SHALL instead be human-only. New timed-wait or elapsed-wait events SHALL NOT be produced; a callback-suspension status SHALL NOT be encoded as a legacy duration-based waiting event. Continuation SHALL contain the accepted next-action reason; terminal diagnostics SHALL NOT expose raw malformed decision responses.

#### Scenario: Both readers receive a continuation
- **WHEN** a continuation is published
- **THEN** both readers receive the same attributed next-action body once

#### Scenario: Readers differ for unlock
- **WHEN** an AI unlock is durably published
- **THEN** the user receives its concise status
- **AND** no corresponding unlock body is added to model-bound conversation

#### Scenario: Readers differ for callback suspension
- **WHEN** callback suspension is recorded
- **THEN** the user receives a quiet status that retains the lock
- **AND** no callback-wait reason body is inserted into ordinary or native summary model input

### Requirement: Immutable event timestamps
Runtime-authored event timestamps SHALL remain immutable RFC 3339 values with explicit numeric UTC offsets. Shared event bodies SHALL retain their publication timestamp, never a redraw timestamp. AI-unlock and callback-suspension timestamps SHALL be retained as record metadata for timeline/audit use but SHALL NOT be printed in the default quiet status line. Reopening in another time zone SHALL NOT re-stamp an event.

#### Scenario: Event reopened in a different time zone
- **WHEN** a stored continuation, unlock status, or callback-suspension status is reopened under another host time zone
- **THEN** its stored timestamp remains unchanged
- **AND** the quiet status still shows only source/status, reason type, and reason without a printed timestamp

### Requirement: Events stay in normal conversation order
Each retained shared watchdog event SHALL appear once at its original active-branch position, without a reconstructed watchdog-history preamble. Each accepted actual AI unlock or callback suspension SHALL have one visible status at its outcome position, not a tool receipt plus a duplicate status or notification. UI-only records SHALL NOT be inserted into model conversation to achieve ordering.

#### Scenario: Consecutive continuations
- **WHEN** two continuations are followed by an AI unlock
- **THEN** the transcript shows those two events and one unlock status in order
- **AND** subsequent model input contains the two continuation events but no unlock status or extra history block

#### Scenario: Callback between continuations
- **WHEN** a continuation, callback suspension, actual callback work, and another continuation occur in one cycle
- **THEN** their public history retains that order with only one waiting status
- **AND** ordinary model input preserves actual work and continuation guidance but omits the waiting status and its finalized control exchange

### Requirement: Continuation publication respects ownership
A continuation SHALL start work and publish its hook only under the existing current-claim durable-publication contract; failure SHALL preserve guarded budget rollback. AI-unlock and callback-suspension status and internal-exchange cleanup SHALL be confirmed for their exact current outcome before their stopping notification becomes eligible. Publication retries and repeated settlement observations SHALL NOT duplicate status, signals, or budget charges. A status persistence failure SHALL NOT relock a successful actual unlock, release or resume an accepted callback suspension, refund that committed suspension's unit, run work, or substitute a model-bound event as fallback. Only still-current publication work SHALL be retried; new ordinary work or lifecycle replacement SHALL retire old pending callback notifications. Exhaustion and decision failure SHALL remain one-shot non-work outcomes with existing idle and ownership guards; a final-budget callback suspension SHALL defer exhaustion until actual resumed work successfully settles.

#### Scenario: Continuation publication fails
- **WHEN** continuation publication cannot be confirmed
- **THEN** no new work turn or continuation hook is created and guarded rollback applies

#### Scenario: Budget is exhausted
- **WHEN** the final permitted continuation is spent and its ordinary work settles under current idle and ownership guards
- **THEN** one exhaustion event is published without starting another inquiry or work turn
- **AND** no retired wait deadline delays terminal eligibility

#### Scenario: Shared event appears during lifecycle observation
- **WHEN** the host reports a shared continuation, exhaustion, or failure event, or a UI-only unlock or suspension entry
- **THEN** it is not treated as a new user request
- **AND** it neither resets budget accounting nor acquires ownership of unrelated work

#### Scenario: Unlock persistence fails
- **WHEN** the current AI unlock has stopped automatic work but its human-only record cannot be confirmed
- **THEN** the watchdog remains unlocked and retries only still-current publication work
- **AND** it sends no model-bound fallback or premature `user-ready` hook

#### Scenario: User takes over during publication
- **WHEN** a new user cycle invalidates a pending old stopping publication
- **THEN** the old publication cannot create a status or stopping signal for that new cycle

#### Scenario: Callback status cannot be confirmed
- **WHEN** a current accepted suspension's human-only status write fails or cannot be confirmed
- **THEN** the watchdog retains its lock, suspension, and one consumed unit without claiming durable history or emitting the hook
- **AND** a later confirmed publication under the same current outcome can emit at most one signal without another charge

#### Scenario: Last waiting unit has no ordinary callback yet
- **WHEN** the last shared budget unit is spent on callback suspension but no ordinary work has resumed
- **THEN** no exhaustion event is published solely because the numeric limit is reached

### Requirement: Finalized control traffic is excluded from later model input
After an owned decision finishes or is invalidated, subsequent ordinary provider requests and newly generated native compaction and branch-summary requests SHALL exclude its raw inquiry/correction prompts, assistant protocol submissions, tool results, and human-only AI-unlock or callback-suspension status. Accepted continuation content SHALL remain at its correct position and be available for ordinary work and native summaries. During an active inquiry, the minimum current prompt, correction history, executable call, and required provider thinking SHALL remain available until dispatch; isolation SHALL NOT disable authorized execution. Projection SHALL be scoped by exact ownership metadata, not text matching or tool name alone. It SHALL preserve unrelated messages, file-operation evidence, native summary settings, cancellation, and active-branch boundaries.

This guarantee covers watchdog-owned raw records in supported native request paths. It SHALL NOT be advertised as erasure of disk history, exports, pre-existing summaries, user quotations, or content independently read and reintroduced by another extension. It SHALL NOT be claimed to resist arbitrary later transformations by other extensions.

#### Scenario: Ordinary request after AI unlock
- **WHEN** new user work begins after an accepted AI unlock
- **THEN** its actual provider input contains the user work and ordinary prior conversation but none of that finalized inquiry's protocol or unlock reason

#### Scenario: Native manual or automatic compaction
- **WHEN** native compaction summarizes a region containing completed decision records, including a split-turn prefix
- **THEN** its actual summary request omits those internal records and human-only stopping text
- **AND** it preserves ordinary task results and accepted continuation guidance

#### Scenario: Native branch summary
- **WHEN** the user requests a native summary while leaving a branch with completed decisions
- **THEN** the summary request excludes those internal exchanges and human-only stopping statuses
- **AND** navigation, target identity, and unrelated branch evidence remain unchanged

#### Scenario: Active result remains executable
- **WHEN** a confirmed inquiry returns its admissible result call
- **THEN** required dispatch content remains intact until the function executes
- **AND** later projection removes the finalized exchange without reactivating it

#### Scenario: Callback result remains evidence but stopping reason does not
- **WHEN** real callback work starts after suspension
- **THEN** its provider input can contain the external task's actual result
- **AND** that external result is not hidden along with the watchdog-owned wait status or protocol

## ADDED Requirements

### Requirement: Quiet human-only callback suspension status
A newly accepted callback suspension SHALL persist one non-interactive, theme-muted quiet status identifying Continue watchdog, waiting for callback, the retained lock, normalized `WAIT_CALLBACK`, and the trimmed reason. It SHALL NOT say `unlocked` or assert task completion. It SHALL reuse the existing quiet-status safety and presentation constraints: no user-message bubble, prominent control box, protocol, acknowledgement-only turn, printed timestamp, or repeated authorization disclaimer; safe wrapping and inert terminal controls; unchanged stored reason and notification values despite visual compaction. Actual answers, callback results, and user questions SHALL remain ordinary conversation, not the control reason. Its recorded outcome kind SHALL distinguish new suspension from pre-upgrade callback unlock history.

#### Scenario: User sees an accepted waiting result
- **WHEN** callback suspension is accepted with reason `Waiting for the build result.`
- **THEN** one quiet status identifies waiting for callback with the lock retained and that reason
- **AND** no unlock wording, raw control call, or additional acknowledgement is displayed

#### Scenario: Unsafe reason text remains inert
- **WHEN** a callback reason contains wide characters, newlines, or terminal controls
- **THEN** it wraps safely without executing controls or creating another user-facing answer
- **AND** stored and notified reason values retain the accepted content
