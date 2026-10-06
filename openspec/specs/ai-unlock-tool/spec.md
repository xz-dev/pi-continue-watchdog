# ai-unlock-tool Specification

## Purpose

Defines a stable root-only result function for authorized watchdog decision inquiries, preserving phase-gated submission and terminal unlock behavior without making control reasons a user-facing delivery channel.

## Requirements

### Requirement: Stable root-only tool registration
The watchdog SHALL register exactly one reserved decision-result function once per root Pi process session and SHALL retain the same declaration and active tool membership throughout the session. It SHALL use a fixed name distinct from reflect watchdog's `ref`, and SHALL NOT retain `unlock_continue_watchdog` as an additional proactive unlock tool. Locking, checking, correcting, continuing, and unlocking SHALL NOT add, remove, or swap tools. Child Pi processes inside the watchdog process domain SHALL NOT register this function. Stable registration SHALL NOT be represented as a guarantee of provider cache hits.

#### Scenario: Root session starts
- **WHEN** a root Pi process starts a session with the extension loaded
- **THEN** one reserved result function is registered
- **AND** its declaration and active membership do not change as watchdog state changes

#### Scenario: Child process starts
- **WHEN** a child Pi process in the watchdog process domain loads the extension
- **THEN** it registers no watchdog decision-result function

### Requirement: Model-facing tool contract
The public description SHALL be exactly `don't use unless ask`. The public parameter schema SHALL be an open object declaring no argument properties, required fields, action enum, or reason enum. The extension SHALL supply no startup prompt snippet or guideline teaching its purpose, arguments, or an obligation to call it before ending ordinary work. Full usage and configured allowed values SHALL be supplied only in authorized decision and correction prompts; runtime validation SHALL enforce that contract despite the minimal schema.

#### Scenario: Model reads the tool
- **WHEN** a provider receives the declaration during ordinary work
- **THEN** it sees only the fixed minimal description and open object schema
- **AND** no extension-supplied startup guidance advertises how to unlock or submit a verdict

#### Scenario: Custom reason type
- **WHEN** effective reason configuration includes a custom type
- **THEN** authorized decision instructions list it by name without inventing a meaning
- **AND** the public function declaration remains unchanged

### Requirement: Authorized unlock is terminal for its decision
An accepted current unlock verdict SHALL unlock through normal authoritative semantics, clear pending automated work, publish one human-only outcome status with remove-only internal-exchange cleanup, and end its decision without an acknowledgement-only model request. It SHALL publish one eligible `user-ready` hook with `STOP_KIND=AI_UNLOCK`, normalized `REASON_TYPE`, and trimmed `REASON` only after that exact status and cleanup are confirmed, preserving current main ownership and aggregate/process-domain idle fences. No jev classification or review SHALL occur. Unrelated tools in the same response SHALL invalidate the decision rather than bypass decision-only tool restrictions.

#### Scenario: Work complete
- **WHEN** a confirmed current attempt accepts an unlock with type `job_done` and a valid reason
- **THEN** the watchdog unlocks and starts no acknowledgement-only model turn
- **AND** its human-only status records the outcome without a model-bound unlock body, and the eligible hook carries `REASON_TYPE=JOB_DONE`

#### Scenario: User wait needs no external review
- **WHEN** a confirmed current attempt accepts a valid `WAIT_USER` unlock
- **THEN** it applies without a classifier request or review rejection counter
- **AND** hook publication still waits for busy children and the process domain to become idle
