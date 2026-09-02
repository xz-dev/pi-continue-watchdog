## Purpose

Expose each durably accepted timed watchdog wait as a precise, optional semantic signal without changing the wait decision contract or timer behavior.

## ADDED Requirements

### Requirement: Accepted waits publish a waiting hook
The watchdog SHALL publish exactly one `pi:semantic-hook:v1` envelope named `watchdog-waiting` after a current valid `wait_watchdog` decision has been durably recorded. Its values SHALL contain the validated trimmed reason in `REASON` and the accepted integer duration rendered as a decimal string in `WAIT_SECONDS`. The envelope SHALL NOT contain or imply a wait reason type.

#### Scenario: Valid wait is recorded
- **WHEN** a current decision accepts and persists a valid wait reason and duration
- **THEN** one `watchdog-waiting` hook is published with the same `REASON` and `WAIT_SECONDS`

#### Scenario: Wait cannot become durable
- **WHEN** a wait is invalid, preempted before persistence, rolled back, or its audit entry cannot be persisted
- **THEN** no `watchdog-waiting` hook is published

#### Scenario: Ownership changes during persistence
- **WHEN** appending the accepted wait re-entrantly demotes or invalidates the current claim
- **THEN** no `watchdog-waiting` hook is published even if the append itself returned

### Requirement: Waiting and exhaustion remain distinct events
An accepted wait that consumes the final retry budget SHALL publish its waiting hook at acceptance while preserving the existing rule that exhaustion cannot become user-ready until the wait deadline has elapsed.

#### Scenario: Final-attempt wait begins
- **WHEN** the final valid attempt records a wait whose deadline is still in the future
- **THEN** `watchdog-waiting` is published immediately and no `user-ready` exhaustion hook is published before the deadline

#### Scenario: Final-attempt wait expires
- **WHEN** the final wait deadline has elapsed and existing terminal-idle conditions still hold
- **THEN** the existing `user-ready` hook may publish `STOP_KIND=EXHAUSTED` independently of the earlier waiting hook

### Requirement: Notification consumers remain optional
Waiting-hook publication SHALL be best-effort to current listeners only and SHALL not make the watchdog depend on, identify, acknowledge, wait for, or import any notification consumer.

#### Scenario: No listener is present
- **WHEN** an accepted wait is recorded without any semantic-hook listener
- **THEN** the wait state, deadline, fold cleanup, and later scheduling proceed normally

#### Scenario: Listener throws
- **WHEN** a semantic-hook listener throws while receiving `watchdog-waiting`
- **THEN** the accepted wait remains active and later watchdog behavior is unchanged
