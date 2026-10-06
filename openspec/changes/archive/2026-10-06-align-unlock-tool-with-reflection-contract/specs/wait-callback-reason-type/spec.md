## MODIFIED Requirements

### Requirement: Built-in WAIT_CALLBACK reason type
Default `reasonTypes` SHALL remain `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, and `WAIT_CALLBACK`. Authorized decision guidance SHALL explain `WAIT_CALLBACK` as waiting for another agent or program to call back and wake the session. A valid configured list SHALL still replace the defaults. `WAIT_CALLBACK` SHALL be an unlock reason, not the bounded-wait action; it SHALL be accepted only within the current consumed decision attempt.

#### Scenario: Default unlock with WAIT_CALLBACK
- **GIVEN** default reason types and a confirmed current decision attempt
- **WHEN** it submits a valid unlock verdict with type `wait_callback`
- **THEN** the watchdog unlocks without arming a bounded-wait timer
- **AND** its qualified terminal hook carries `STOP_KIND=AI_UNLOCK` and `REASON_TYPE=WAIT_CALLBACK`

## REMOVED Requirements

### Requirement: Callback wait guidance
**Reason**: Ordinary continuation and startup instructions must no longer teach proactive callback-wait unlock calls.
**Migration**: Supply callback selection guidance only in the authorized decision prompt under the replacement requirement below.

#### Scenario: Old continuation instruction grants no authority
- **WHEN** an ordinary run tries to follow legacy proactive callback-unlock guidance
- **THEN** its out-of-phase call is rejected without changing watchdog state

## ADDED Requirements

### Requirement: Decision-only callback wait guidance
The authorized decision prompt SHALL distinguish expected callbacks from bounded time-based waiting and user-dependent waiting. A callback-wait unlock SHALL not imply user action or promise completion of external work. The public declaration, startup guideline, and fixed ordinary continuation wrapper SHALL NOT teach proactive `WAIT_CALLBACK` calls. Existing native callback-driven workflows SHALL NOT be replaced by forced polling; the bounded-wait outcome remains available for temporary waits needing later reassessment.

#### Scenario: Continuation body does not expose WAIT_CALLBACK usage
- **WHEN** the watchdog publishes an ordinary continuation
- **THEN** its fixed body does not instruct the agent to call an unlock tool with `WAIT_CALLBACK`
- **AND** a later qualified inquiry supplies callback and bounded-wait selection guidance only for that decision

#### Scenario: Callback wait attempted during ordinary work
- **WHEN** an ordinary run calls the reserved function with a callback-wait unlock before a decision is authorized
- **THEN** it receives the reserved-function error without unlocking
