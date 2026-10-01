# watchdog-event-timeline Specification

## Purpose

Give the user and the model the same durable timeline of automatic watchdog results and explicit wait timing, without reconstructing a separate decision-only history or inferring background-task progress.

## Requirements

### Requirement: Active-branch and upgrade compatibility

The watchdog SHALL use Pi's normal active-branch and compaction behavior for new shared events without bypassing the current context boundary to restore old events. Reopening an uncompacted event SHALL preserve its canonical text without rerunning its action. Pre-upgrade session records, including wait, completed-wait, AI-unlock, and decision-failure events, SHALL remain readable and SHALL NOT be rewritten or backfilled. No pre-upgrade wait timer SHALL be restored.

#### Scenario: Resume a new event
- **WHEN** a session containing an uncompacted continuation event is reopened
- **THEN** the event retains the same text for human and model history
- **AND** no continuation turn is started by the reopen

#### Scenario: Resume an old session
- **WHEN** a session contains pre-upgrade records, including an accepted wait
- **THEN** the old records remain readable and old exchange cleanup remains compatible
- **AND** no wait timer, completed-wait event, or elapsed time is created

#### Scenario: Compaction or branch navigation removes earlier events
- **WHEN** Pi compacts earlier events into a summary or selects a sibling branch
- **THEN** the watchdog respects that summary and active branch
- **AND** does not resurrect discarded or sibling events through a special history scan

### Requirement: Shared continuation and exhaustion event body

Each newly published automatic continuation and retry-exhaustion event SHALL have one canonical text body that is visible in human conversation history and supplied as model-bound conversation content. Human rendering SHALL preserve that body, allowing only presentation differences such as color and line wrapping. The model SHALL NOT receive a shorter, longer, or separately reconstructed version of the same event body.

#### Scenario: Both readers receive a continuation
- **WHEN** the watchdog publishes an automatic continuation
- **THEN** the human-visible event and the model-bound event contain the same canonical text

### Requirement: Immutable event timestamps

The watchdog SHALL embed runtime-authored RFC 3339 timestamps with explicit numeric UTC offsets in event text. The timestamp SHALL identify when the event was published, not when it was rendered. Stored event bodies SHALL remain unchanged on redraw, session resume, or changes to the host's local time zone.

#### Scenario: Event reopened in a different time zone
- **WHEN** a stored event is reopened on a host with a different time zone
- **THEN** its text and original time-zone offset remain unchanged
- **AND** the event is not stamped with the current time

### Requirement: Events stay in normal conversation order

New watchdog events SHALL remain in normal active-branch conversation order. The watchdog SHALL NOT prepend a reconstructed list of earlier events or repeat them as a watchdog-only history block. Each event SHALL appear once in retained model history.

#### Scenario: Consecutive continuations
- **WHEN** the watchdog publishes three continuations in one lock cycle
- **THEN** retained context contains three continuation events in chronological order
- **AND** no duplicate summary of earlier continuations is added

### Requirement: No decision internals in new sessions

New sessions SHALL NOT produce hidden decision prompts, XML answers, validation re-asks, or inquiry correlation records. Legacy records of that kind in resumed sessions SHALL stay excluded from provider requests through read-only folding. Checking widgets, countdowns, config diagnostics, and optional audit records SHALL NOT become context events. Existing manual lock/unlock and abort/error-unlock presentation is outside this capability.

#### Scenario: Resume a pre-upgrade session with inquiry records
- **WHEN** a session containing completed legacy inquiry exchanges is resumed after upgrade
- **THEN** their raw prompts, XML answers, and re-asks remain excluded from provider context
- **AND** their stored event replacements remain readable

#### Scenario: New lock cycle
- **WHEN** a new lock cycle continues and is then unlocked through the tool
- **THEN** the session contains no inquiry prompt, XML answer, or fold record

### Requirement: Continuation publication respects ownership

A continuation SHALL NOT start its work turn or publish its `watchdog-continued` hook if it cannot be durably published for the current main claim, and the just-committed attempt SHALL be rolled back under the existing failure policy. Exhaustion events SHALL NOT trigger ordinary work, reset a lock cycle, or consume retry attempts. Repeated settled observations SHALL NOT duplicate a terminal event.

#### Scenario: Continuation publication fails
- **WHEN** a continuation cannot be durably published
- **THEN** its attempt is rolled back
- **AND** no `watchdog-continued` hook or work turn is created

#### Scenario: Budget is exhausted
- **WHEN** the final permitted continuation has been used and the agent again settles without unlocking
- **THEN** one exhaustion event is published
- **AND** no ordinary work turn starts
- **AND** existing `user-ready` exhaustion timing is preserved

#### Scenario: Shared event appears during lifecycle observation
- **WHEN** the host reports a continuation or exhaustion event
- **THEN** it is not treated as a new user request
- **AND** it does not reset retry accounting or acquire ownership of an unrelated run
