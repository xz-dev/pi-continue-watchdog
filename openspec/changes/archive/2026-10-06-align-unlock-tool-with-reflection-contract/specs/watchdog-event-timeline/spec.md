## MODIFIED Requirements

### Requirement: Active-branch and upgrade compatibility
The watchdog SHALL use Pi's normal active-branch and compaction behavior for new shared events without bypassing the current context boundary to restore old events. Reopening an uncompacted event SHALL preserve its canonical text without rerunning its action. Pre-upgrade records, including wait, completed-wait, AI-unlock, and decision-failure events, SHALL remain readable and SHALL NOT be rewritten or backfilled. No persisted wait timer, whether legacy or newly recorded, SHALL be restored on session reopening.

#### Scenario: Resume a new event
- **WHEN** a session containing an uncompacted continuation or wait event is reopened
- **THEN** the event retains the same text for human and model history
- **AND** reopening starts no continuation or wait timer

#### Scenario: Resume an old session
- **WHEN** a session contains pre-upgrade records, including an accepted wait
- **THEN** old records remain readable and legacy exchange cleanup remains compatible
- **AND** no wait timer, completed-wait event, or elapsed time is created by reopening

#### Scenario: Compaction or branch navigation removes earlier events
- **WHEN** Pi compacts earlier events into a summary or selects a sibling branch
- **THEN** the watchdog respects that summary and active branch
- **AND** does not resurrect discarded or sibling events through a special history scan

### Requirement: Shared continuation and exhaustion event body
Each newly published continuation, accepted wait, completed wait, AI unlock, decision failure, and retry exhaustion SHALL have one canonical body visible in human history and supplied as model-bound conversation content. Human rendering SHALL preserve that body apart from presentation such as color and wrapping. The model SHALL NOT receive a separately reconstructed version. Accepted verdict events SHALL carry the validated reason and, when applicable, normalized reason type. A wait event SHALL carry requested seconds, acceptance timestamp, and deadline; it SHALL NOT imply external task progress.

#### Scenario: Both readers receive a continuation
- **WHEN** the watchdog publishes an automatic continuation
- **THEN** human and model receive the same canonical body containing the accepted reason

#### Scenario: Accepted wait is recorded
- **WHEN** a current 60-second wait is accepted and durably published
- **THEN** one shared event records its reason, requested duration, acceptance time, and deadline
- **AND** it asserts no outcome of the external work

### Requirement: Continuation publication respects ownership
A continuation SHALL NOT start its work turn or publish `watchdog-continued` unless durably published for the current main claim; failed publication SHALL roll back its just-committed attempt under existing failure policy. Failed wait publication SHALL likewise not consume an attempt, arm an unrecorded wait, or publish a waiting hook. Exhaustion and decision-failure events SHALL NOT trigger ordinary work, reset a cycle, or consume attempts. Repeated settled observations SHALL NOT duplicate terminal events.

#### Scenario: Continuation publication fails
- **WHEN** a continuation cannot be durably published
- **THEN** its attempt is rolled back
- **AND** no continuation hook or work turn is created

#### Scenario: Budget is exhausted
- **WHEN** the final permitted continue or wait has been used and terminal exhaustion qualifies under existing idle and deadline rules
- **THEN** one exhaustion event is published
- **AND** no ordinary work turn starts and existing user-ready ownership and idle safeguards remain in force

#### Scenario: Shared event appears during lifecycle observation
- **WHEN** the host reports a watchdog outcome event
- **THEN** it is not treated as a new user request
- **AND** it neither resets accounting nor acquires ownership of an unrelated run

## REMOVED Requirements

### Requirement: No decision internals in new sessions
**Reason**: New sessions must again contain watchdog-owned inquiries and corrections, while hiding their protocol traffic from later ordinary model requests.
**Migration**: Preserve legacy read-only folding and add exact-exchange folding for function-based inquiries; do not ban inquiries or restore XML result parsing.

#### Scenario: New lock cycle uses an inquiry
- **WHEN** a new lock cycle obtains a verdict through the reserved function
- **THEN** its completed protocol exchange is folded and its shared outcome event remains

## ADDED Requirements

### Requirement: Decision exchanges fold only after result dispatch
For an admissible singleton response, the current inquiry, correction history, executable result call, matching tool result, and provider-required thinking content SHALL remain intact until current dispatch and validation are complete. Malformed owned batches MAY instead be suppressed before dispatch under `decision-response-contract`. Later ordinary model requests SHALL exclude the completed inquiry's prompts, corrections, result calls, and results, retaining its single shared outcome event in normal conversation order. Folding SHALL use exact exchange ownership and SHALL NOT remove unrelated ordinary work or another extension's messages. Legacy XML inquiry records SHALL remain readable and excluded from later ordinary requests through read-only folding without acting as new decisions.

#### Scenario: Current result can execute
- **WHEN** an active inquiry returns its reserved result call with provider-required thinking content
- **THEN** folding preserves the executable call and required content until dispatch finishes

#### Scenario: Ordinary work follows a continue verdict
- **WHEN** the next ordinary model request is assembled after acceptance
- **THEN** it contains one canonical continuation event rather than raw decision instructions, submissions, or tool results
- **AND** unrelated conversation entries remain unchanged

#### Scenario: Resume a legacy inquiry
- **WHEN** a resumed session contains old XML prompts, answers, and correction records
- **THEN** those records remain readable without being reinterpreted as control submissions
- **AND** legacy folding still excludes their raw protocol traffic from ordinary provider requests

### Requirement: Native history retention is disclosed accurately
Documentation SHALL distinguish ordinary model-request folding from native compaction and branch summarization. Persisted result-call arguments or inquiry records can remain available to those native mechanisms. The watchdog SHALL NOT claim that folding erases such persisted content, rewrites historical records, or guarantees those arguments never enter a native summary. Checking widgets, countdowns, configuration diagnostics, and optional audit records SHALL NOT become shared conversation events.

#### Scenario: User checks retention guarantees
- **WHEN** documentation explains decision folding
- **THEN** it states both the ordinary-request exclusion and the native compaction or branch-summary retention limitation

### Requirement: Wait completion reports elapsed time rather than progress
After a still-current accepted wait reaches its deadline, the watchdog SHALL publish at most one completed-wait event when it next qualifies an inquiry or terminal exhaustion under existing idle and ownership rules. It SHALL state requested seconds, observed elapsed whole seconds between runtime wall-clock observations, original start time, and qualified observation time. Completion of watchdog delay SHALL NOT assert completion, health, or continued execution of an external task.

#### Scenario: Busy activity outlasts the deadline
- **WHEN** observable work remains active at the deadline and qualifies later
- **THEN** no inquiry or completed-wait event is published while it is busy
- **AND** the later event reports elapsed time since original acceptance, not a restarted duration

### Requirement: Wait timing belongs to one current wait
Completed-wait facts SHALL refer only to the wait responsible for that wake. Renewed activity SHALL retain its original start and deadline while deferring eligibility. Unlock, a fresh cycle, ownership loss, shutdown, or session replacement SHALL invalidate pending wake reporting. Validation corrections SHALL reuse the inquiry's initial timing facts and SHALL NOT publish another completed-wait event.

#### Scenario: Correction does not repeat wait completion
- **WHEN** an expired-wait inquiry needs a correction
- **THEN** its original timing preamble is reused unchanged and no second completion event is emitted

#### Scenario: Old wait loses ownership
- **WHEN** ownership changes before an expired wait can publish its completion
- **THEN** it publishes no completion event under the new claim
