## MODIFIED Requirements

### Requirement: Active-branch and upgrade compatibility
The watchdog SHALL use Pi's normal active-branch and compaction boundaries without scanning sibling history to reconstruct its own timeline. Reopening retained continuation and UI-only unlock records SHALL preserve their published data without rerunning actions. Legacy wait, elapsed-wait, unlock, and failed-decision records SHALL remain readable without rewriting stored history or restoring timers. Existing summaries created before this change SHALL NOT be claimed to have been retroactively cleaned. New projection logic SHALL retain exact-exchange legacy cleanup without deleting unrelated user or extension messages.

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

### Requirement: Shared continuation and exhaustion event body
New continuation, exhaustion, and decision-failure events SHALL retain one canonical model-bound body shared with human history, apart from styling and wrapping. AI-unlock status SHALL instead be human-only. New wait or elapsed-wait events SHALL NOT be produced. Continuation SHALL contain the accepted next-action reason; terminal diagnostics SHALL not expose raw malformed decision responses.

#### Scenario: Both readers receive a continuation
- **WHEN** a continuation is published
- **THEN** both readers receive the same attributed next-action body once

#### Scenario: Readers differ for unlock
- **WHEN** an AI unlock is durably published
- **THEN** the user receives its concise status
- **AND** no corresponding unlock body is added to model-bound conversation

### Requirement: Immutable event timestamps
Runtime-authored event timestamps SHALL remain immutable RFC 3339 values with explicit numeric UTC offsets. Shared event bodies SHALL retain their publication timestamp, never a redraw timestamp. AI-unlock timestamps SHALL be retained as record metadata for timeline/audit use but SHALL NOT be printed in the default quiet status line. Reopening in another time zone SHALL not re-stamp an event.

#### Scenario: Event reopened in a different time zone
- **WHEN** a stored continuation or unlock status is reopened under another host time zone
- **THEN** its stored timestamp remains unchanged
- **AND** the default unlock line still shows only source/status, reason type, and reason

### Requirement: Events stay in normal conversation order
Each retained shared watchdog event SHALL appear once at its original active-branch position, without a reconstructed watchdog-history preamble. Each successful AI unlock SHALL have one visible status at its outcome position, not a tool receipt plus a duplicate status or notification. UI-only records SHALL NOT be inserted into model conversation to achieve ordering.

#### Scenario: Consecutive continuations
- **WHEN** two continuations are followed by an AI unlock
- **THEN** the transcript shows those two events and one unlock status in order
- **AND** subsequent model input contains the two continuation events but no unlock status or extra history block

### Requirement: Continuation publication respects ownership
A continuation SHALL start work and publish its hook only under the existing current-claim durable-publication contract; failure SHALL preserve guarded retry rollback. AI-unlock status and internal-exchange cleanup SHALL be confirmed for their exact current outcome before terminal notification becomes eligible. Publication retries and repeated settlement observations SHALL not duplicate status or hooks. A status persistence failure SHALL not relock a successful unlock, run work, or substitute a model-bound event as fallback. Exhaustion and decision failure SHALL remain one-shot non-work outcomes with their existing idle and ownership guards.

#### Scenario: Continuation publication fails
- **WHEN** continuation publication cannot be confirmed
- **THEN** no new work turn or continuation hook is created and guarded rollback applies

#### Scenario: Budget is exhausted
- **WHEN** the final permitted continuation is spent and its ordinary work settles under current idle and ownership guards
- **THEN** one exhaustion event is published without starting another inquiry or work turn
- **AND** no retired wait deadline delays terminal eligibility

#### Scenario: Shared event appears during lifecycle observation
- **WHEN** the host reports a shared continuation, exhaustion, or failure event, or a UI-only unlock entry
- **THEN** it is not treated as a new user request
- **AND** it neither resets retry accounting nor acquires ownership of unrelated work

#### Scenario: Unlock persistence fails
- **WHEN** the current AI unlock has stopped automatic work but its human-only record cannot be confirmed
- **THEN** the watchdog remains unlocked and retries only still-current publication work
- **AND** it sends no model-bound fallback or premature `user-ready` hook

#### Scenario: User takes over during publication
- **WHEN** a new user cycle invalidates a pending old unlock publication
- **THEN** the old publication cannot create a status or terminal signal for that new cycle

## REMOVED Requirements

### Requirement: No decision internals in new sessions
**Reason**: Guarded internal inquiries remain necessary, but their UI and later model projections must exclude protocol traffic rather than prohibit the inquiry itself.
**Migration**: Retain exact owned exchanges and apply the explicit presentation and context boundaries below.

#### Scenario: Internal inquiry executes
- **WHEN** a qualified inquiry runs and completes
- **THEN** its decision can act once without exposing a question, raw arguments, or receipt to the user

## ADDED Requirements

### Requirement: Quiet human-only AI unlock status
A newly accepted AI unlock SHALL persist one non-interactive, theme-muted gray status with the extension name, `unlocked`, normalized reason type, and trimmed reason. It SHALL not use a user-message bubble or prominent custom-message box, show the inquiry or tool protocol, print an acknowledgement or timestamp, or repeat the model-facing authorization disclaimer. Long text SHALL wrap safely at terminal width without executing terminal controls. Visual compaction SHALL not change the stored reason or notification payload. Actual user-facing answers and questions SHALL remain ordinary assistant output, not this control reason. Manual, shortcut, abort, and terminal-error presentation is otherwise unchanged.

#### Scenario: Completed work
- **WHEN** the inquiry accepts `JOB_DONE` with reason `Requested analysis delivered.`
- **THEN** one gray status reads `Continue watchdog unlocked · JOB_DONE · Requested analysis delivered.`
- **AND** no separate `Decision received.`, inquiry, parameter block, timestamp, or disclaimer is shown

#### Scenario: Narrow terminal and unusual reason text
- **WHEN** a reason contains wide characters, newlines, or terminal control characters
- **THEN** the quiet status wraps within the current width and renders controls inertly
- **AND** it remains one logical status rather than a second user-facing answer

### Requirement: Inquiry traffic is not user-facing content
Owned inquiry prompts, corrective prompts, response protocol, `cw` call arguments, and acknowledgement results SHALL stay out of normal transcript presentation, including streaming and resumed rendering. Successful inquiries SHALL expose only their accepted outcome. Invalid internal attempts SHALL not dump their raw response; terminal decision failure SHALL retain one safe diagnostic. An unauthorized ordinary `cw` call SHALL retain a visible rejection so hidden internal UI does not conceal ordinary errors or misuse. Unrelated tools and assistant content SHALL not be hidden.

#### Scenario: Corrected inquiry
- **WHEN** an owned invalid response is corrected and then accepted
- **THEN** the user sees the accepted outcome without either internal question, submission, or receipt

#### Scenario: Unauthorized ordinary call
- **WHEN** an ordinary run calls `cw` outside an authorized inquiry
- **THEN** its rejection remains visible and ordinary work remains usable

### Requirement: Finalized control traffic is excluded from later model input
After an owned decision finishes or is invalidated, subsequent ordinary provider requests and newly generated native compaction and branch-summary requests SHALL exclude its raw inquiry/correction prompts, assistant protocol submissions, tool results, and AI-unlock status. Accepted continuation content SHALL remain at its correct position and be available for ordinary work and native summaries. During an active inquiry, the minimum current prompt, correction history, executable call, and required provider thinking SHALL remain available until dispatch; isolation SHALL not disable authorized execution. Projection SHALL be scoped by exact ownership metadata, not text matching or tool name alone. It SHALL preserve unrelated messages, file-operation evidence, native summary settings, cancellation, and active-branch boundaries.

This guarantee covers watchdog-owned raw records in supported native request paths. It SHALL NOT be advertised as erasure of disk history, exports, pre-existing summaries, user quotations, or content independently read and reintroduced by another extension. It SHALL not be claimed to resist arbitrary later transformations by other extensions.

#### Scenario: Ordinary request after AI unlock
- **WHEN** new user work begins after an accepted AI unlock
- **THEN** its actual provider input contains the user work and ordinary prior conversation but none of that finalized inquiry's protocol or unlock reason

#### Scenario: Native manual or automatic compaction
- **WHEN** native compaction summarizes a region containing completed decision records, including a split-turn prefix
- **THEN** its actual summary request omits those internal records and AI-unlock text
- **AND** it preserves ordinary task results and accepted continuation guidance

#### Scenario: Native branch summary
- **WHEN** the user requests a native summary while leaving a branch with completed decisions
- **THEN** the summary request excludes those internal exchanges and unlock statuses
- **AND** navigation, target identity, and unrelated branch evidence remain unchanged

#### Scenario: Active result remains executable
- **WHEN** a confirmed inquiry returns its admissible result call
- **THEN** required dispatch content remains intact until the function executes
- **AND** later projection removes the finalized exchange without reactivating it
