## MODIFIED Requirements

### Requirement: Published hook set
The watchdog SHALL publish only these `pi:semantic-hook:v1` hooks:
- `watchdog-continued`, with the accepted `REASON_TYPE` and `REASON`;
- `watchdog-waiting`, with `REASON` and decimal-string `WAIT_SECONDS`, without a reason type;
- `user-ready`, with `STOP_KIND` equal to `AI_UNLOCK`, `ERROR_UNLOCK`, `EXHAUSTED`, or `DECISION_FAILED`.

`AI_UNLOCK` SHALL additionally carry normalized uppercase `REASON_TYPE` and trimmed `REASON`. Other stop kinds SHALL carry no additional values. The watchdog SHALL NOT add a jev-specific event or verdict annotation.

#### Scenario: Consumer inventories hooks
- **WHEN** a cycle continues twice, accepts a bounded wait, and later accepts an unlock
- **THEN** each durably published continuation produces one reason-bearing `watchdog-continued`
- **AND** the wait produces one `watchdog-waiting` with its reason and duration
- **AND** the qualified unlock produces one `user-ready` with `STOP_KIND=AI_UNLOCK`, `REASON_TYPE`, and `REASON`

### Requirement: Simple continuation signal
The watchdog SHALL publish exactly one `watchdog-continued` hook after each automatic continuation is durably published for the current main agent. It SHALL NOT publish the hook for a failed publication or ownership loss during publication. Values SHALL contain the accepted normalized `REASON_TYPE` and trimmed `REASON`, with no count. Decision inquiries and correction prompts SHALL NOT publish continuation hooks.

#### Scenario: Continuation published
- **WHEN** the watchdog durably publishes an accepted current continuation
- **THEN** one `watchdog-continued` hook carries that verdict's reason type and reason

#### Scenario: Continuation not published
- **WHEN** continuation publication fails or the claim is demoted during publication
- **THEN** no `watchdog-continued` hook is published

## ADDED Requirements

### Requirement: Terminal signals retain aggregate-idle fencing
AI unlock, terminal-error unlock, exhaustion, and decision failure SHALL publish `user-ready` only when the corresponding terminal state is still current and all existing local, child, process-domain, ownership, and stale-publication guards permit it. A final accepted wait SHALL defer exhaustion eligibility until its deadline. Repeated settlement observations SHALL NOT duplicate the terminal signal. Manual unlock, abort, ordinary unlocked idle, and cancelled or stale work SHALL remain silent.

#### Scenario: Failed decision while children are busy
- **WHEN** a decision exhausts its three response attempts but observable child activity remains
- **THEN** no `user-ready` hook is published while that activity is busy
- **AND** one `STOP_KIND=DECISION_FAILED` signal becomes eligible only if the failed state is still current when aggregate idle qualifies

#### Scenario: User takes over before publication
- **WHEN** user activity resets the cycle while terminal-hook publication is pending
- **THEN** the old terminal state publishes no hook for the new cycle
