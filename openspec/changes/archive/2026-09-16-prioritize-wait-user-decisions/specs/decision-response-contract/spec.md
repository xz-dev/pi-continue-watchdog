## ADDED Requirements

### Requirement: Outcome selection follows user-boundary priority
The fixed decision prompt SHALL define an ordered outcome policy in which the need for additional user input, approval, confirmation, authorization, credentials, or another user action takes priority over the existence of unfinished work. When no concrete next action can proceed without that user action, the model SHALL select `unlock_continue_watchdog` with the configured reason type corresponding to `WAIT_USER`.

#### Scenario: Production action requires explicit approval
- **WHEN** requested work remains but the next permitted action is a production modification or reload requiring explicit user approval
- **THEN** the prompt directs the model to choose unlock with `WAIT_USER`
- **AND** it does not permit `WORK_REMAINS` merely because the production work is unfinished

#### Scenario: User information is required
- **WHEN** every remaining path requires additional user input, credentials, confirmation, authorization, or another user action
- **THEN** the prompt directs the model to choose unlock with `WAIT_USER`

### Requirement: Continue requires an immediately executable action
The fixed decision prompt SHALL permit `continue_watchdog` only when at least one concrete next action can be performed immediately using existing authorization and conversation context, without additional user input or approval. Its `reason_content` SHALL identify that immediately executable action. Unfinished work by itself SHALL NOT be sufficient grounds for continue.

#### Scenario: Unfinished work is fully blocked on the user
- **WHEN** tasks remain unfinished but none can proceed before the user responds
- **THEN** the prompt prohibits `continue_watchdog`
- **AND** directs the model to select `WAIT_USER`

#### Scenario: Independent authorized work remains
- **WHEN** a user-gated action is pending but another concrete requested and authorized action can be performed now
- **THEN** the prompt permits `continue_watchdog`
- **AND** requires `reason_content` to name the immediately executable action rather than the blocked action

### Requirement: External waiting remains distinct from user waiting
The fixed decision prompt SHALL reserve `wait_watchdog` for temporary external automation or time-based waiting when no user action is required. User-dependent waiting SHALL use unlock with `WAIT_USER`, not `wait_watchdog`.

#### Scenario: CI is still running
- **WHEN** no action can proceed until CI completes and no user response is required
- **THEN** the prompt directs the model to choose `wait_watchdog` with a bounded duration

#### Scenario: User approval is pending
- **WHEN** no action can proceed until the user approves
- **THEN** the prompt directs the model to choose unlock with `WAIT_USER`
- **AND** does not classify the state as an external wait

### Requirement: Terminal outcome categories remain explicit
The fixed decision prompt SHALL distinguish completed work (`JOB_DONE`), user-dependent work (`WAIT_USER`), non-user blockers (`JOB_BLOCKED`), temporary external waits (`wait_watchdog`), and immediately actionable work (`continue_watchdog`) without changing configured reason-type matching or XML response shape.

#### Scenario: All requested work is complete
- **WHEN** every requested task is complete
- **THEN** the prompt directs unlock with `JOB_DONE`

#### Scenario: Work is blocked for a non-user reason
- **WHEN** work remains but cannot proceed for a blocker that is neither user action nor a temporary external wait
- **THEN** the prompt directs unlock with `JOB_BLOCKED`

#### Scenario: Existing protocol compatibility
- **WHEN** the ordered classification guidance is added
- **THEN** the response remains exactly one watchdog XML document
- **AND** parser behavior, configured type lists, field validation, and retry accounting remain unchanged
