## MODIFIED Requirements

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
