## Purpose

Defines the complete, optional set of `pi:semantic-hook:v1` notifications the continue watchdog publishes so consumers such as pi-notify can react without depending on internal state.

## ADDED Requirements

### Requirement: Published hook set
The watchdog SHALL publish only these semantic hooks:
- `watchdog-continued`, with no values;
- `user-ready`, with `STOP_KIND` set to one of `AI_UNLOCK`, `ERROR_UNLOCK`, or `EXHAUSTED`.

`AI_UNLOCK` SHALL additionally carry `REASON_TYPE` and `REASON`. `ERROR_UNLOCK` and `EXHAUSTED` SHALL carry no other values. The watchdog SHALL NOT publish `watchdog-waiting` or `STOP_KIND=DECISION_FAILED`.

#### Scenario: Consumer inventories hooks
- **WHEN** a consumer listens for a full lock cycle that continues twice and is then unlocked by the agent
- **THEN** it receives two `watchdog-continued` envelopes with empty values
- **AND** one `user-ready` envelope with `STOP_KIND=AI_UNLOCK`, `REASON_TYPE`, and `REASON`
- **AND** no `watchdog-waiting` envelope

### Requirement: Simple continuation signal
The watchdog SHALL publish exactly one `watchdog-continued` hook after each automatic continuation message is durably published for the current main agent, and SHALL NOT publish it for a continuation that was not published or that lost ownership during publication. The hook SHALL carry no reason type, reason, or count.

#### Scenario: Continuation published
- **WHEN** the watchdog durably publishes an automatic continuation
- **THEN** one `watchdog-continued` hook is published with no values

#### Scenario: Continuation not published
- **WHEN** continuation publication fails or the claim is demoted during publication
- **THEN** no `watchdog-continued` hook is published

### Requirement: Silent human and abort paths
Manual unlock, the unlock shortcut, main-agent abort, ordinary unlocked idle, and cancelled or stale work SHALL publish no semantic hook.

#### Scenario: Human unlock
- **WHEN** the user runs `/unlock-continue-watchdog`
- **THEN** no `user-ready` hook is published

### Requirement: Consumers remain optional
Hook publication SHALL be best-effort to current listeners only. The watchdog SHALL NOT depend on, identify, wait for, or import any consumer, and a throwing listener SHALL NOT change watchdog state.

#### Scenario: Listener throws
- **WHEN** a listener throws while receiving `watchdog-continued`
- **THEN** the continuation turn and later watchdog behavior are unchanged
