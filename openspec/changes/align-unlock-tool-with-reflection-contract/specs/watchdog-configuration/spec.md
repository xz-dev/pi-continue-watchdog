## MODIFIED Requirements

### Requirement: Effective configuration keys
The watchdog SHALL honor these configuration keys with existing per-field validation and precedence of built-ins, global, then trusted project:
- `maxRetries`, the shared budget of accepted continue and bounded-wait verdicts per lock cycle;
- `decisionPrompt`, restored as decision-only guidance before the fixed outcome and function instructions;
- `continuePrompt`;
- `reasonTypes`, allowed unlock reason types, disclosed only in authorized decision instructions;
- `continueReasonTypes`, restored as allowed continuation reason types, defaulting to `WORK_REMAINS` and `VERIFYING`;
- `unlockShortcut`.

`idleDelaySeconds` SHALL remain accepted for compatibility without changing the fixed fence. Restored keys SHALL retain their pre-migration validation: `decisionPrompt` is a non-blank string of at most 16,384 Unicode code points; `continueReasonTypes` is a non-empty list of trimmed non-blank strings using existing normalization. Invalid values SHALL keep the lower-precedence value and report the existing diagnostic style. Custom guidance SHALL NOT remove the fixed function contract or bypass runtime authorization. Effective reason configuration SHALL NOT alter the reserved function's public declaration.

#### Scenario: Custom reason types
- **WHEN** a valid `reasonTypes` list is configured
- **THEN** authorized unlock decisions accept exactly those types and decision instructions list them
- **AND** the public tool schema contains no reason enum

#### Scenario: Restored decision configuration
- **WHEN** valid `decisionPrompt` and `continueReasonTypes` values are loaded
- **THEN** decision prompts include that guidance and the effective continuation types
- **AND** neither key produces a removed-key diagnostic

### Requirement: Removed keys produce an error diagnostic
A configuration layer containing `jevWaitCheck` SHALL produce an error-level diagnostic naming that key and stating it was removed and has no effect. The diagnostic SHALL use the existing configuration surface without printing nested values, credentials, or other secrets. The removed object SHALL NOT activate requests or review behavior. Other valid keys SHALL still apply and extension load SHALL NOT fail. The extension SHALL NOT edit stored credentials, environment variables, or user config files to perform this migration.

#### Scenario: Old config with decisionPrompt
- **GIVEN** global config sets a valid `decisionPrompt` and `maxRetries: 5`
- **WHEN** configuration loads
- **THEN** the restored decision guidance and `maxRetries` 5 both apply
- **AND** `decisionPrompt` produces no removed-key diagnostic

#### Scenario: Old config with jevWaitCheck
- **GIVEN** global config sets `jevWaitCheck` with an API key and `maxRetries: 5`
- **WHEN** configuration loads
- **THEN** an error diagnostic names `jevWaitCheck` as removed without displaying its values
- **AND** `maxRetries` 5 applies, load succeeds, and no jev request occurs

#### Scenario: Removed key is not reported as merely unsupported
- **WHEN** `jevWaitCheck` is present, even with `enabled: false`
- **THEN** its diagnostic identifies it specifically as removed rather than merely unsupported

## ADDED Requirements

### Requirement: Removed integration does not resolve shared credentials
The continue watchdog SHALL NOT resolve TypeSafe or OpenRouter credentials for a jev classifier or review, infer enablement from their availability, or make either kind of jev request. It SHALL NOT remove or modify credentials or integrations used by other providers or extensions.

#### Scenario: Shared key remains available
- **WHEN** Pi or the environment contains TypeSafe or OpenRouter credentials
- **THEN** ordinary settlement and decision processing make no jev classification or review request
- **AND** those credentials remain unchanged for unrelated users of them
