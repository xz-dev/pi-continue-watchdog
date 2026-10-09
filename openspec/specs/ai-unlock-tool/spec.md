# ai-unlock-tool Specification

## Purpose

Defines a stable root-only result function for authorized watchdog decision inquiries, preserving phase-gated submission and terminal unlock behavior without making control reasons a user-facing delivery channel.

## Requirements

### Requirement: Stable root-only tool registration
The watchdog SHALL expose exactly one reserved decision-result function per root Pi process session. It SHALL use a fixed name distinct from reflect watchdog's `ref`, and SHALL NOT retain `unlock_continue_watchdog` as an additional proactive unlock tool. Locking, checking, correcting, continuing, and unlocking SHALL NOT add, remove, or swap tools or change their declarations. The declaration SHALL remain stable while the effective reason configuration is unchanged. If an existing lifecycle configuration load changes the effective reason constraints, the same named declaration SHALL be refreshed before those constraints are used for a decision; no additional tool, configuration watcher, or phase-specific schema SHALL be introduced. Active tool membership SHALL remain unchanged by this refresh. Child Pi processes inside the watchdog process domain SHALL NOT register this function. Stable registration SHALL NOT be represented as a guarantee of provider cache hits.

#### Scenario: Root session starts
- **WHEN** a root Pi process starts a session with the extension loaded
- **THEN** one reserved result function is registered from the effective configuration
- **AND** its declaration and active membership do not change as watchdog state changes

#### Scenario: Child process starts
- **WHEN** a child Pi process in the watchdog process domain loads the extension
- **THEN** it registers no watchdog decision-result function

#### Scenario: Existing configuration load changes allowed types
- **WHEN** an existing session or ownership lifecycle reload accepts different effective reason types
- **THEN** the same named tool exposes the corresponding constraints before the next decision
- **AND** its active membership and authorization requirements are unchanged

### Requirement: Model-facing tool contract
The public description SHALL be exactly `don't use unless ask`. The public parameter schema SHALL declare the required string properties `reason_content`, `reason_type`, and `action`. `action` SHALL enumerate exactly `continue` and `unlock`. `reason_type` SHALL enumerate the union of effective `continueReasonTypes` and `reasonTypes`, preserving configured spellings and removing exact duplicates; admission for the selected action SHALL still be checked at runtime. `reason_content` SHALL declare a minimum length of one, a maximum length of 1000 Unicode code points, and a nonblank constraint. The schema SHALL retain acceptance of unrelated extra properties rather than introduce a new strict-object policy.

The parameter schema SHALL contain no explanatory descriptions, examples, or default argument values. The extension SHALL supply no startup prompt snippet or guideline teaching its purpose or an obligation to call it before ending ordinary work. Authorized inquiry and correction guidance SHALL explain decision semantics; it SHALL NOT be the sole representation of required fields, types, enums, or the reason bound. The extension SHALL retain runtime authorization and validation, and SHALL NOT claim that a schema alone guarantees valid model output, provider-side strict sampling, or a correct decision.

#### Scenario: Model reads the tool
- **WHEN** a provider receives the declaration during ordinary work
- **THEN** it sees the fixed minimal description and all three required string fields with their enum and text constraints
- **AND** no parameter description, example, default, prompt snippet, or startup guideline advertises how or when to stop work

#### Scenario: Custom reason type
- **WHEN** effective unlock configuration contains `NeedReview` and effective continue configuration contains `verifying`
- **THEN** the schema includes `NeedReview` and `verifying` rather than silently substituting the built-in lists
- **AND** authorized instructions retain the action-specific configured lists without inventing meanings for custom labels

#### Scenario: Invalid fields are not admitted by the declared schema
- **WHEN** a tool argument object omits any required field, uses a non-string field, selects action `wait`, or selects a reason type outside both configured lists
- **THEN** it fails the declared structural contract rather than relying on a prose instruction to reject it

#### Scenario: Native text constraints match the existing hard bound
- **WHEN** a canonical reason contains exactly 1000 non-BMP Unicode code points
- **THEN** it satisfies the length constraint
- **AND** 1001 code points, an empty string, or whitespace-only content fail the structural contract

### Requirement: Authorized unlock is terminal for its decision
An accepted current `unlock`-action verdict SHALL end its decision, clear its pending automatic decision work, and publish one human-only outcome status with remove-only internal-exchange cleanup, without an acknowledgement-only model request. Except for the validated built-in `WAIT_CALLBACK` pair, it SHALL unlock through normal authoritative semantics and retain one eligible `user-ready` hook with `STOP_KIND=AI_UNLOCK`, normalized `REASON_TYPE`, and trimmed `REASON`. The callback pair SHALL instead retain the lock, enter callback suspension, consume one shared `maxContinue` unit, and use `STOP_KIND=WAIT_CALLBACK`. Both signals SHALL require confirmation of their exact status and cleanup and preserve current main ownership and aggregate/process-domain idle fences. An enabled unlock review SHALL retain its existing eligibility for all initial configured `unlock`-action candidates, including the callback pair, before the final effect commits; disabled review SHALL add no discovery or request. Unrelated tools in the same response SHALL invalidate the decision rather than bypass decision-only tool restrictions. Public registration, field names, two-action enum, argument preparation, reason validation, and ordinary-turn rejection SHALL remain unchanged.

#### Scenario: Work complete
- **WHEN** a confirmed current attempt finally accepts an unlock with type `job_done` and a valid reason
- **THEN** the watchdog unlocks and starts no acknowledgement-only model turn
- **AND** its human-only status records the outcome without a model-bound unlock body, and the eligible hook carries `REASON_TYPE=JOB_DONE`

#### Scenario: User wait needs no external review
- **WHEN** a confirmed current attempt accepts a valid `WAIT_USER` unlock while unlock review is disabled
- **THEN** it applies without a classifier request or review rejection counter
- **AND** hook publication still waits for busy children and the process domain to become idle

#### Scenario: Callback stops the decision but retains its cycle
- **WHEN** a confirmed current attempt finally accepts the configured built-in callback pair
- **THEN** it finishes the decision with the lock retained, callback suspension active, and one budget unit consumed
- **AND** the human status and eligible hook describe callback waiting rather than an unlock

#### Scenario: Enabled review still covers callback waiting
- **WHEN** unlock review is enabled and a current initial callback candidate reaches its pre-commit review boundary
- **THEN** it receives the existing review and bounded reconsideration policy before any suspension or budget charge
- **AND** a final accepted callback result retains the lock rather than following actual-unlock side effects

### Requirement: Compatible arguments remain normalized before schema validation
Argument preparation SHALL preserve the existing trim and case-insensitive acceptance of actions and configured reason types and trim accepted reasons before native schema validation. It SHALL preserve unrelated extra properties and SHALL NOT fill missing arguments, truncate reasons, coerce non-string values, change an invalid action into a valid one, or grant watchdog authority. Both assessment-first and action-first objects SHALL remain admissible. Runtime validation SHALL continue rejecting reason types not allowed for the selected action even when that type occurs in the other action's schema enum.

#### Scenario: Existing mixed-case client remains valid
- **WHEN** an authorized attempt supplies `{"action":" UNLOCK ","reason_type":" needreview ","reason_content":" Review requested. "}` and `NeedReview` is configured for unlock
- **THEN** schema validation receives the compatible lowercase action, matched configured reason spelling `NeedReview`, and trimmed content
- **AND** the accepted outcome records `NEEDREVIEW` with `Review requested.`

#### Scenario: Uppercase output is not a new input alias
- **WHEN** the effective unlock reason list is `["ß"]`
- **THEN** the public enum contains `ß`, and the existing reason matcher accepts input `ß` but rejects input `SS`
- **AND** the uppercase outcome representation `SS` does not replace the matched input identity during revalidation or create an accepted alias

#### Scenario: Preparation does not repair invalid decisions
- **WHEN** a response omits `action`, provides numeric `reason_content`, or exceeds the trimmed reason bound
- **THEN** preparation does not manufacture, stringify, or truncate a valid replacement
- **AND** the response remains invalid

#### Scenario: Structural type membership is not action-specific approval
- **WHEN** `VERIFYING` is configured only for continue but an owned response selects `unlock` with that type
- **THEN** runtime validation rejects the response
- **AND** membership in the public reason-type union does not authorize an unlock
