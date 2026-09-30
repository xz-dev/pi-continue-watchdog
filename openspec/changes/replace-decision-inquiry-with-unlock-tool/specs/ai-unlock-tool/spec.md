## Purpose

Gives the main agent one native tool to signal that its work is complete or that it needs the user, replacing the XML decision answer as the only way the model stops the continue watchdog.

## ADDED Requirements

### Requirement: Stable root-only tool registration
The watchdog SHALL register exactly one model-callable tool named `unlock_continue_watchdog` once per root Pi process session and SHALL keep it in the active tool set for the whole session. The watchdog SHALL NOT add, remove, or swap tools during a lock cycle, so the provider tool list and prompt prefix stay stable. Child Pi processes inside the watchdog process domain SHALL NOT register the tool.

#### Scenario: Root session starts
- **WHEN** a root Pi process starts a session with the extension loaded
- **THEN** `unlock_continue_watchdog` is available to the model
- **AND** the set of active tools does not change when the watchdog locks, continues, or unlocks

#### Scenario: Child process starts
- **WHEN** a child Pi process in the watchdog process domain loads the extension
- **THEN** no `unlock_continue_watchdog` tool is registered in that child

### Requirement: Model-facing tool contract
The tool description SHALL state that it belongs to the pi-continue-watchdog extension and that the agent must call it to signal that the requested work is complete or that user input, approval, or other user action is required. It SHALL also state that ending a turn without calling it causes the agent to be continued automatically. The tool SHALL accept exactly two parameters:
- `reason_type`: a string matching one of the effective configured `reasonTypes`, case-insensitive after trimming.
- `reason`: a string that is non-empty after trimming and at most 1000 Unicode code points.

The schema SHALL enumerate the effective allowed reason types.

#### Scenario: Model reads the tool
- **WHEN** the provider receives the tool definition
- **THEN** the description states the call-to-stop obligation and the automatic continuation consequence
- **AND** the `reason_type` schema lists the configured reason types

### Requirement: Valid call from the locked main agent unlocks
When the current main agent calls the tool with valid arguments while the watchdog is locked, the watchdog SHALL:
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

#### Scenario: Tool is called alongside other tools
- **WHEN** the tool is called in the same batch as another tool that does not request termination
- **THEN** the watchdog is still unlocked
- **AND** Pi's ordinary follow-up for that batch is not suppressed by the watchdog

### Requirement: Invalid arguments fail as ordinary tool errors
Arguments that violate the tool contract SHALL produce a failed tool result that names the violated constraint. They SHALL leave the lock state, retry accounting, and pending continuation unchanged, and SHALL NOT trigger any re-ask, fallback parser, or separate decision-failure state.

#### Scenario: Unknown reason type
- **WHEN** the agent calls the tool with a `reason_type` that is not configured
- **THEN** the tool result is an error listing the allowed reason types
- **AND** the watchdog remains locked

#### Scenario: Reason too long
- **WHEN** the agent supplies a reason longer than 1000 Unicode code points
- **THEN** the tool result is an error stating the limit
- **AND** the reason is not truncated or accepted

### Requirement: Call without an effective lock is harmless
A valid call made while the watchdog is not locked, or by a session that is not the current main agent, SHALL return a successful informational result and SHALL NOT publish a hook, change another session's state, or start work.

#### Scenario: Already unlocked
- **GIVEN** the watchdog is unlocked
- **WHEN** the agent calls the tool with valid arguments
- **THEN** the result reports that the watchdog was already unlocked
- **AND** no `user-ready` hook is published

### Requirement: Tool record is the only unlock event
An AI unlock SHALL NOT publish an additional shared model-bound unlock event. The tool call and its result SHALL be the model-visible record. The human-facing rendering SHALL show the reason type and reason compactly.

#### Scenario: Context after AI unlock
- **WHEN** the agent unlocks through the tool
- **THEN** later model context contains the tool call and its result
- **AND** contains no separate `Continue watchdog unlocked` event body
