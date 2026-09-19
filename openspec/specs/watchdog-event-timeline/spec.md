# watchdog-event-timeline Specification

## Purpose

Give the user and the model the same durable timeline of automatic watchdog results and explicit wait timing, without reconstructing a separate decision-only history or inferring background-task progress.

## Requirements

### Requirement: Shared automatic watchdog event body

Each newly published automatic continue, accepted wait, AI unlock, decision failure, retry exhaustion, and completed-wait event SHALL have one canonical text body visible in human conversation history and supplied as model-bound conversation content. Human rendering SHALL preserve that body, allowing only presentation differences such as color and line wrapping. The model SHALL NOT receive a shorter, longer, or separately reconstructed version of the same event body.

#### Scenario: Both readers receive an accepted wait
- **WHEN** the watchdog durably accepts a 1500-second wait for a background import
- **THEN** the human-visible wait event and the model-bound wait event contain the same canonical text
- **AND** the reason and timing facts do not exist only in hidden metadata

#### Scenario: Ordinary work sees the same results as later decisions
- **WHEN** ordinary authorized work resumes after several watchdog decisions
- **THEN** retained shared events are available in its conversation context as well as in later watchdog inquiries
- **AND** visibility is not conditional on whether an ordinary assistant response previously completed successfully

### Requirement: Immutable runtime-authored timestamps

The watchdog SHALL embed runtime-authored RFC 3339 timestamps with explicit numeric UTC offsets in event text. The acceptance timestamp SHALL identify when an automatic result was committed, not when it was rendered or when the model began answering. Stored event bodies SHALL remain unchanged on redraw, later inquiries, session resume, or changes to the host's local time zone. Wait events SHALL additionally state the requested duration and absolute deadline.

#### Scenario: A wait records its actual start and deadline
- **WHEN** a 1500-second wait is accepted at `2026-09-19T16:02:16.951+08:00`
- **THEN** both readers see that start, the requested 1500 seconds, and deadline `2026-09-19T16:27:16.951+08:00`
- **AND** neither timestamp comes from the model's reason text

#### Scenario: History is reopened in a different time zone
- **WHEN** the same event is reopened on a host with a different time zone
- **THEN** its text and original time-zone offset remain unchanged
- **AND** the event is not stamped with the current time

### Requirement: Wait completion reports elapsed time rather than progress

After a still-current accepted wait reaches its deadline, the watchdog SHALL publish at most one completed-wait event when it next qualifies an inquiry or terminal exhaustion under existing idle and ownership rules. The event SHALL state the original requested seconds, observed elapsed seconds, start timestamp, and observation timestamp. Elapsed seconds SHALL be the whole seconds between the two runtime wall-clock observations, not the configured duration, and SHALL be labeled as elapsed time. Completion of the watchdog delay SHALL NOT assert completion, health, or continued execution of the external task.

#### Scenario: Late eligible wake
- **GIVEN** a 1500-second wait started at `2026-09-19T16:02:16.951+08:00`
- **WHEN** the watchdog next qualifies the wake at `2026-09-19T16:27:47.951+08:00`
- **THEN** both readers receive requested duration 1500 seconds and observed elapsed duration 1531 seconds
- **AND** the event does not claim the background import completed or remains running

#### Scenario: Model response time is not counted as wake time
- **WHEN** an inquiry is dispatched at the qualified wake and the model takes another 120 seconds to answer
- **THEN** the wake event retains its dispatch-time observation
- **AND** the eventual answer does not rewrite the wake duration

### Requirement: Wait timing belongs to one current wait

Completed-wait facts SHALL refer only to the accepted wait responsible for that wake. Renewed activity SHALL retain the original wait start and deadline while deferring eligibility as before. Unlock, a fresh lock cycle, ownership loss, shutdown, or session replacement SHALL invalidate pending wake reporting. Validation re-asks within one inquiry SHALL reuse its initial timing facts and SHALL NOT publish another completed-wait event.

#### Scenario: Busy activity outlasts the deadline
- **WHEN** observable work is still active at the wait deadline and becomes eligible for inquiry later
- **THEN** no inquiry or completed-wait event is published while it is busy
- **AND** the later wake reports elapsed time since the original acceptance rather than restarting the duration

#### Scenario: User cancels the wait
- **WHEN** the user unlocks before the deadline and an old timer callback subsequently runs
- **THEN** that callback publishes no completed-wait event and starts no inquiry

#### Scenario: Two separate waits do not share a start
- **WHEN** a second wait is accepted after the first completed-wait inquiry
- **THEN** the second wait has its own acceptance time and deadline
- **AND** its later elapsed value is not a sum of previous waits

### Requirement: Shared events replace special decision-history replay

New watchdog results SHALL remain in normal active-branch conversation order. Subsequent inquiries SHALL NOT prepend an additional reconstructed list of those results, repeat them as a watchdog-only history block, or discard them merely because an ordinary assistant turn succeeded. Results SHALL appear once per event in retained model history; the explicit current-wake preamble is a separate timing reference, not a replay of earlier results.

#### Scenario: Consecutive waits without ordinary work
- **WHEN** the watchdog accepts three waits in succession without an intervening ordinary work turn
- **THEN** retained context contains their three shared acceptance events in chronological order
- **AND** the next inquiry adds no duplicate list of prior watchdog reasons

#### Scenario: Transient continuation failure recovers
- **WHEN** Pi retries an ordinary continuation and later settles successfully
- **THEN** retained shared events remain available without an exception for that assistant's stop reason
- **AND** a later inquiry does not receive a separate normalized-history snapshot

### Requirement: Decision internals stay outside the shared timeline

Completed raw inquiry prompts, XML responses, malformed response text, validation re-asks, and internal cleanup/correlation records SHALL remain excluded from subsequent ordinary provider requests. Only the canonical result and timing events SHALL survive as the new shared timeline. Checking widgets, live countdowns, parser diagnostics, and optional audit records SHALL NOT become context events solely because a human can inspect them. Existing manual lock/unlock and abort/error-unlock presentation is outside this capability.

#### Scenario: Invalid answers precede an accepted result
- **WHEN** a decision produces invalid responses before a valid wait
- **THEN** later ordinary context contains the accepted shared wait event
- **AND** contains no raw invalid responses, XML, or repeated inquiry instructions

#### Scenario: Re-ask budget is exhausted
- **WHEN** the existing validation budget is exhausted
- **THEN** both readers receive one timestamped decision-failure event with the safe validator diagnostic
- **AND** raw model response text is not republished as its body

### Requirement: Event publication does not change watchdog control semantics

Shared events SHALL remain subject to current-main ownership and existing stale-work checks. A continue or wait SHALL NOT dispatch its work turn, arm its wait, or publish its accepted-result hook if its shared result cannot be durably published; the just-committed attempt and deadline SHALL be rolled back under the existing failure policy. Auxiliary completed-wait and exhaustion events SHALL NOT trigger ordinary work, reset a lock cycle, or consume retry attempts. Repeated settled observations SHALL NOT duplicate a terminal event.

#### Scenario: Accepted wait publication fails
- **WHEN** the accepted wait cannot be durably published
- **THEN** its attempt and deadline are rolled back
- **AND** no waiting hook or wait timer is created

#### Scenario: Final permitted wait reaches its deadline
- **WHEN** the final permitted wait expires and terminal-idle ownership checks still succeed
- **THEN** one completed-wait event precedes one retry-exhaustion event
- **AND** no new inquiry or ordinary work turn starts
- **AND** existing `user-ready` exhaustion timing is preserved

#### Scenario: Shared event appears during lifecycle observation
- **WHEN** the host reports an internal result or completed-wait event
- **THEN** it is not treated as a new user request
- **AND** it does not reset retry accounting or acquire ownership of an unrelated run

### Requirement: Active-branch and upgrade compatibility

The watchdog SHALL use Pi's normal active-branch and compaction behavior for new shared events without bypassing the current context boundary to restore old events. Reopening an uncompacted new event SHALL preserve its canonical text without rerunning its action. Pre-upgrade session records SHALL remain readable and SHALL NOT be rewritten, backfilled into shared model history, or assigned invented timing facts. Runtime waits SHALL remain non-restorable across reload or restart.

#### Scenario: Resume a new event
- **WHEN** a session containing an uncompacted shared wait event is reopened
- **THEN** the event retains the same text for human and model history
- **AND** its old timer is not rearmed and no wait-completion claim is invented

#### Scenario: Resume an old session
- **WHEN** a session contains only pre-upgrade TUI-only results and old inquiry-fold records
- **THEN** old records remain readable and old exchange cleanup remains compatible
- **AND** no shared event or elapsed time is fabricated from them

#### Scenario: Compaction or branch navigation removes earlier events
- **WHEN** Pi compacts earlier events into a summary or selects a sibling branch
- **THEN** the watchdog respects that summary and active branch
- **AND** does not resurrect discarded or sibling events through a special history scan

### Requirement: Timing transparency does not introduce a progress policy

This capability SHALL provide time and history facts without forcing a continue outcome, querying the external task, adding a repeated-wait threshold, or changing the existing retry budget. Documentation and acceptance evidence SHALL distinguish correct information delivery from the model's discretionary judgment.

#### Scenario: Another wait is selected after a completed delay
- **WHEN** the model receives accurate timing facts and returns another otherwise valid wait
- **THEN** the existing validation and retry accounting apply
- **AND** no new heuristic overrides the decision merely because the previous result was also wait
