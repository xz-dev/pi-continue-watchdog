# wait-callback-reason-type Specification

## Purpose
Gives the agent a typed way to end its turn while it waits for another agent or program to call back, so the watchdog does not continue it and notification consumers can tell this stop apart from one that needs the user.

## Requirements

### Requirement: Built-in WAIT_CALLBACK reason type
The built-in default `reasonTypes` SHALL be `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, `WAIT_CALLBACK`. The `reason_type` description SHALL state `WAIT_CALLBACK = waiting for another agent or program to call back and wake you`. A valid configured `reasonTypes` list SHALL still replace the defaults.

#### Scenario: Default unlock with WAIT_CALLBACK
- **GIVEN** no configured `reasonTypes`
- **WHEN** the locked main agent calls `unlock_continue_watchdog` with `reason_type` `wait_callback`
- **THEN** the watchdog unlocks
- **AND** the terminal `user-ready` hook carries `STOP_KIND=AI_UNLOCK` and `REASON_TYPE=WAIT_CALLBACK`

### Requirement: Callback wait guidance
The tool description SHALL list waiting for another agent or program to call back as a reason to call the tool. The prompt guideline and the continuation body SHALL tell the agent to call the tool with `WAIT_CALLBACK` when the awaited work will call back and wake it, and to block on, monitor, or sleep for any other awaited work inside its turn.

#### Scenario: Continuation body names WAIT_CALLBACK
- **WHEN** the watchdog publishes an automatic continuation
- **THEN** its body tells the agent to call `unlock_continue_watchdog` with `reason_type WAIT_CALLBACK` for work that will call back
- **AND** it still tells the agent to monitor or sleep for other work
