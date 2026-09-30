## Purpose

Defines which configuration keys the continue watchdog honors and how removed keys are reported, so a setting never appears accepted while having no effect.

## ADDED Requirements

### Requirement: Effective configuration keys
The watchdog SHALL honor the following configuration keys with their existing validation and precedence of built-ins, then global, then trusted project:
- `maxRetries`, the budget of automatic continuations per lock cycle;
- `continuePrompt`;
- `reasonTypes`, the allowed `reason_type` values for the unlock tool;
- `unlockShortcut`.

`idleDelaySeconds` SHALL remain accepted for compatibility with no effect on the fixed fence, as before.

#### Scenario: Custom reason types
- **WHEN** a valid `reasonTypes` list is configured
- **THEN** the unlock tool accepts exactly those types and advertises them in its schema

### Requirement: Removed keys produce an error diagnostic
When a configuration layer contains `decisionPrompt` or `continueReasonTypes`, the watchdog SHALL report an error-level diagnostic that names the key and says it was removed and has no effect. The diagnostic SHALL be reported through the existing configuration diagnostic surface. The watchdog SHALL NOT silently accept or store the value. Other valid keys in the same file SHALL still apply, and extension load SHALL NOT fail.

#### Scenario: Old config with decisionPrompt
- **GIVEN** the global config sets `decisionPrompt` and `maxRetries: 5`
- **WHEN** the configuration loads
- **THEN** the user sees an error diagnostic stating that `decisionPrompt` was removed and has no effect
- **AND** `maxRetries` 5 is applied

#### Scenario: Removed key is not reported as merely unsupported
- **WHEN** `continueReasonTypes` is present
- **THEN** its diagnostic names `continueReasonTypes` specifically as a removed key
- **AND** is distinguishable from the generic unsupported-key diagnostic
