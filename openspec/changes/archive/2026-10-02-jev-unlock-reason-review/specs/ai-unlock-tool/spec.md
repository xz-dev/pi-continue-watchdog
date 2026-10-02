## MODIFIED Requirements

### Requirement: Valid call from the locked main agent unlocks
When the current main agent calls the tool with valid arguments while the watchdog is locked, and the call is either not subject to reason review or has passed it (see `jev-unlock-reason-review`), the watchdog SHALL:
- unlock authoritatively through the same controller unlock semantics as other unlocks, clearing pending automatic continuation;
- return a short successful tool result;
- request that the run end without a follow-up model request;
- publish exactly one `user-ready` hook with `STOP_KIND=AI_UNLOCK`, the normalized uppercase `REASON_TYPE`, and the trimmed `REASON`.

The existing rule that publication waits until busy children and the process domain are idle SHALL be preserved.

#### Scenario: Work complete
- **GIVEN** the watchdog is locked for the current main agent
- **WHEN** the agent calls `unlock_continue_watchdog` with `reason_type` `job_done` and a valid reason
- **THEN** the watchdog becomes unlocked
- **AND** no further model request is started for this run
- **AND** one `user-ready` hook carries `STOP_KIND=AI_UNLOCK`, `REASON_TYPE=JOB_DONE`, and the reason

#### Scenario: Reviewed wait passes
- **GIVEN** the watchdog is locked and the reason review returns `supported`
- **WHEN** the agent calls `unlock_continue_watchdog` with `reason_type` `WAIT_USER`
- **THEN** the watchdog unlocks exactly as for an unreviewed call

#### Scenario: Tool is called alongside other tools
- **WHEN** the tool is called in the same batch as another tool that does not request termination
- **THEN** the watchdog is still unlocked
- **AND** Pi's ordinary follow-up for that batch is not suppressed by the watchdog

### Requirement: Invalid arguments fail as ordinary tool errors
Arguments that violate the tool contract SHALL produce a failed tool result that names the violated constraint. A reason review rejection (see `jev-unlock-reason-review`) SHALL also be a failed tool result naming the rejection and its count. Both SHALL leave the lock state, retry accounting, and pending continuation unchanged, and SHALL NOT trigger any re-ask, fallback parser, or separate decision-failure state.

#### Scenario: Unknown reason type
- **WHEN** the agent calls the tool with a `reason_type` that is not configured
- **THEN** the tool result is an error listing the allowed reason types
- **AND** the watchdog remains locked

#### Scenario: Reason too long
- **WHEN** the agent supplies a reason longer than 1000 Unicode code points
- **THEN** the tool result is an error stating the limit
- **AND** the reason is not truncated or accepted

#### Scenario: Review rejection
- **WHEN** the reason review confidently contradicts a `WAIT_USER` call
- **THEN** the tool result is an error stating the permission was already given and showing `n/3`
- **AND** the watchdog remains locked with its attempt count unchanged
