## MODIFIED Requirements

### Requirement: Built-in WAIT_CALLBACK reason type
Default `reasonTypes` SHALL remain `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, and `WAIT_CALLBACK`; a valid configured list SHALL replace those defaults. Only authorized decision guidance SHALL explain `WAIT_CALLBACK` as waiting for another agent or program to call back and wake the session. It SHALL remain an unlock reason accepted only in the current confirmed inquiry, not a timed wait or an ordinary-turn stopping function. Accepting it SHALL not create a watchdog timer, poll, fabricated callback, or retry charge.

#### Scenario: Default unlock with WAIT_CALLBACK
- **GIVEN** a confirmed current inquiry and an expected callback from an external task
- **WHEN** it submits a valid unlock with `wait_callback` under default configuration
- **THEN** the watchdog unlocks, displays one quiet `WAIT_CALLBACK` status, and starts no timer
- **AND** its current idle-qualified hook carries `STOP_KIND=AI_UNLOCK` and `REASON_TYPE=WAIT_CALLBACK`

#### Scenario: Custom list excludes callback reason
- **WHEN** a configured reason list omits `WAIT_CALLBACK`
- **THEN** a submission using that value is rejected under normal decision validation
- **AND** the plugin does not silently restore default enums or invent the meaning of a custom label

## REMOVED Requirements

### Requirement: Callback wait guidance
**Reason**: Ordinary continuation must not advertise proactive callback-unlock calls, and timed watchdog waiting is retired.
**Migration**: Teach callback outcome selection only inside the authorized inquiry under the replacement requirement below.

#### Scenario: Old proactive callback guidance
- **WHEN** an ordinary run follows previously stored proactive callback-unlock instructions
- **THEN** the current phase guard rejects the call without changing watchdog state

## ADDED Requirements

### Requirement: Decision-only callback wait guidance
Callback selection guidance SHALL exist only inside the authorized inquiry. The public declaration, startup guidance, and fixed ordinary continuation body SHALL NOT teach proactive callback-unlock calls. Native callback-driven workflows SHALL not be converted to polling or watchdog sleeps. A callback unlock SHALL neither demand user action nor assert external-task completion. For non-callback work, decision guidance SHALL require an available authorized ordinary monitoring/task-owned waiting action for continue, or an appropriate actual blocker for unlock; it SHALL not offer a `wait_seconds` alternative.

#### Scenario: Native callback workflow
- **WHEN** no independent work remains and an external agent is expected to wake the session
- **THEN** the inquiry can select callback unlock without polling, sleeping, or assigning a deadline

#### Scenario: Ordinary run copies the callback payload
- **WHEN** ordinary work calls `cw` using a previously seen `WAIT_CALLBACK` payload
- **THEN** the phase guard rejects it with no watchdog effect

#### Scenario: Job lacks a callback
- **WHEN** a remote job can only be monitored through a task tool
- **THEN** guidance does not describe it as a future callback
- **AND** any continuation names an available authorized monitoring action, not a watchdog delay
