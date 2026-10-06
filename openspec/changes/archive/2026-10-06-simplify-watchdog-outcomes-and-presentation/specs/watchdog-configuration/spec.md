## MODIFIED Requirements

### Requirement: Effective configuration keys
The watchdog SHALL honor these configuration keys with existing per-field validation and precedence of built-ins, global, then trusted project:
- `maxRetries`, the budget of accepted, durably published continuations per lock cycle;
- `decisionPrompt`, internal guidance before the fixed two-outcome decision contract;
- `continuePrompt`, configured continuation guidance retained alongside the accepted next-action reason;
- `reasonTypes`, allowed unlock types disclosed only in authorized decision guidance;
- `continueReasonTypes`, allowed continue types defaulting to `WORK_REMAINS` and `VERIFYING`;
- `unlockShortcut`.

`maxRetries` SHALL remain a safe integer from 1 through 10 with its existing default. Existing prompt length, nonblank reason-list validation, normalization, safe fallback, and diagnostics SHALL remain unchanged. `idleDelaySeconds` SHALL remain accepted for compatibility without altering the fixed fence. No new duration setting or template language SHALL replace retired timed waits. Configured prompt text SHALL not bypass runtime authorization or restore acceptance of the wait action. Effective reason types SHALL not be disclosed in the public `cw` schema.

#### Scenario: Custom reason types
- **WHEN** a valid `reasonTypes` list is configured
- **THEN** authorized unlocks accept exactly those types and the inquiry explains them
- **AND** the public schema remains an open empty object without enums

#### Scenario: Continuation-only retry accounting
- **WHEN** `maxRetries` is 2 and a cycle accepts one continuation and then callback unlock
- **THEN** only one retry attempt is charged and no wait budget exists

#### Scenario: Obsolete instructions in a custom prompt
- **WHEN** custom decision guidance still suggests `action: "wait"`
- **THEN** the fixed contract teaches only continue and unlock and runtime validation rejects wait
- **AND** the plugin does not edit the user's configuration to migrate it

#### Scenario: Restored decision configuration
- **WHEN** valid `decisionPrompt` and `continueReasonTypes` values are loaded
- **THEN** decision prompts include that guidance and the effective continuation types
- **AND** neither key produces a removed-key diagnostic

### Requirement: Removed keys produce an error diagnostic
A configuration layer containing `jevWaitCheck` SHALL produce an error-level diagnostic naming it as removed and without effect. The diagnostic SHALL not print nested values or credentials. `decisionPrompt` and `continueReasonTypes` SHALL remain active keys rather than removed keys. Other valid values SHALL still apply and extension load SHALL not fail. Configuration migration SHALL not modify credentials, environment variables, consumer settings, or user configuration files.

#### Scenario: Old config with decisionPrompt
- **WHEN** valid `decisionPrompt`, `continueReasonTypes`, and `maxRetries` settings are present
- **THEN** all apply without removed-key diagnostics

#### Scenario: Removed key is not reported as merely unsupported
- **WHEN** `jevWaitCheck` is present with credentials or `enabled: false`
- **THEN** the diagnostic identifies the removed key without exposing its nested values
- **AND** it activates no classifier request and valid neighboring values still apply

#### Scenario: Old config with jevWaitCheck
- **GIVEN** global config sets `jevWaitCheck` with an API key and `maxRetries: 5`
- **WHEN** configuration loads
- **THEN** an error diagnostic names `jevWaitCheck` as removed without displaying its values
- **AND** `maxRetries` 5 applies, load succeeds, and no jev request occurs
