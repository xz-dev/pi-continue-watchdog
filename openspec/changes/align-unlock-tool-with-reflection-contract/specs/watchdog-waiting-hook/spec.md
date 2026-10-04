## Purpose

Defines optional notifications for accepted bounded watchdog waits, preserving their reasons and durations without asserting progress of external work.

## ADDED Requirements

### Requirement: Accepted waits publish a waiting hook
The watchdog SHALL publish exactly one `pi:semantic-hook:v1` envelope named `watchdog-waiting` after a current valid wait verdict has been durably published as a shared human/model wait event. Values SHALL contain the trimmed `REASON` and accepted integer duration as a decimal string in `WAIT_SECONDS`, with no reason type. Optional diagnostic-audit persistence SHALL NOT replace or independently gate the shared event. Failed publication or ownership loss SHALL produce no waiting hook.

#### Scenario: Wait is durably recorded
- **WHEN** a current wait verdict accepts 60 seconds with a valid reason and durably publishes its shared event
- **THEN** exactly one `watchdog-waiting` hook carries that reason and `WAIT_SECONDS=60`
- **AND** the timestamped canonical event is available to human and model

#### Scenario: Wait publication loses ownership
- **WHEN** the claim loses ownership before durable publication completes
- **THEN** no waiting hook is published for that verdict

### Requirement: Waiting and exhaustion remain distinct events
A wait that consumes the final retry attempt SHALL publish its waiting hook at acceptance. It SHALL NOT produce an exhaustion user-ready signal until the deadline has elapsed and existing idle and ownership conditions qualify. Wait completion SHALL NOT publish another waiting hook.

#### Scenario: Final attempt is a wait
- **WHEN** an accepted wait uses the final permitted attempt
- **THEN** its waiting hook is immediate after durable publication
- **AND** exhaustion remains deferred until the deadline and aggregate idle

### Requirement: Notification consumers remain optional
Waiting-hook publication SHALL be best-effort to current listeners only. The watchdog SHALL NOT depend on, identify, acknowledge, wait for, or import a notification consumer. Listener errors SHALL NOT alter accepted wait state or timing.

#### Scenario: No listener or throwing listener
- **WHEN** no consumer listens, or a listener throws
- **THEN** the accepted wait retains the same deadline and subsequent behavior
