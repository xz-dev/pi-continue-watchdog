# ai-unlock-tool Specification

## Purpose

Defines terminal handling of authorized watchdog unlock decisions without exposing a decision-result function or using control reasons as user-facing delivery.

## Requirements

### Requirement: Authorized unlock is terminal for its decision
An accepted current `unlock`-action verdict from the private file-result operation SHALL end its decision, clear pending automatic decision work, and publish one human-only outcome status without an acknowledgement-only model request. New private inquiry traffic SHALL require no main-conversation removal because it was never appended there; read-only legacy cleanup SHALL remain available. Except for the validated built-in `WAIT_CALLBACK` pair, the verdict SHALL unlock through normal authoritative semantics and retain one eligible `user-ready` hook with `STOP_KIND=AI_UNLOCK`, normalized `REASON_TYPE`, and trimmed `REASON`. The callback pair SHALL instead retain the lock, enter callback suspension, consume one shared `maxContinue` unit, and use `STOP_KIND=WAIT_CALLBACK`. Both signals SHALL require confirmation of their exact status and preserve current main ownership and aggregate/process-domain idle fences. An enabled unlock review SHALL retain its existing eligibility for all initial configured `unlock`-action candidates, including the callback pair, before the final effect commits; disabled review SHALL add no discovery or request. A response requesting unrelated tool effects SHALL invalidate the attempt before those effects run. Existing field names, two-action enum, compatible value normalization, and action-specific reason validation SHALL remain unchanged; public registration and ordinary-turn function rejection are retired.

#### Scenario: Work complete
- **WHEN** a current private attempt finally accepts an unlock with type `job_done` and a valid reason
- **THEN** the watchdog unlocks and starts no acknowledgement-only model turn
- **AND** its human-only status records the outcome without a model-bound unlock body, and the eligible hook carries `REASON_TYPE=JOB_DONE`

#### Scenario: User wait needs no external review
- **WHEN** a current private attempt accepts a valid `WAIT_USER` unlock while unlock review is disabled
- **THEN** it applies without a classifier request or review rejection counter
- **AND** hook publication still waits for busy children and the process domain to become idle

#### Scenario: Callback stops the decision but retains its cycle
- **WHEN** a current private attempt finally accepts the configured built-in callback pair
- **THEN** it finishes the decision with the lock retained, callback suspension active, and one budget unit consumed
- **AND** the human status and eligible hook describe callback waiting rather than an unlock

#### Scenario: Enabled review still covers callback waiting
- **WHEN** unlock review is enabled and a current initial callback candidate reaches its pre-commit review boundary
- **THEN** it receives the existing review and bounded reconsideration policy before any suspension or budget charge
- **AND** a final accepted callback result retains the lock rather than following actual-unlock side effects

### Requirement: Watchdog does not register a decision-result function
The watchdog SHALL register no public or private specialized function for submitting a decision, including `cw`, `unlock_continue_watchdog`, or a replacement structured-output function. Ordinary startup prompts and tool lists SHALL contain no watchdog result-function declaration or instruction to call one. Only the current private result file can submit a candidate. Other extensions' same-named tools SHALL remain untouched and SHALL not acquire watchdog authority. Existing read-only handling of historical result calls SHALL not re-register a callable tool.

#### Scenario: Ordinary model request after loading watchdog
- **WHEN** a root session starts ordinary work with the watchdog loaded
- **THEN** the watchdog has added no decision-result function to its tool list
- **AND** locking, checking, correcting, continuing, and unlocking do not add one

#### Scenario: Another extension owns cw
- **WHEN** another installed extension independently registers a tool named `cw`
- **THEN** the watchdog neither replaces that tool nor treats its calls as decision submissions
