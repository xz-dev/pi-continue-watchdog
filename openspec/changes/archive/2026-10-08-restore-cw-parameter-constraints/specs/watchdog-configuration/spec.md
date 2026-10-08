## MODIFIED Requirements

### Requirement: Effective configuration keys
The watchdog SHALL honor these configuration keys with existing per-field validation and precedence of built-ins, global, then trusted project:
- `maxRetries`, the budget of accepted, durably published continuations per lock cycle;
- `decisionPrompt`, internal guidance before the fixed two-outcome decision contract;
- `continuePrompt`, configured continuation guidance retained alongside the accepted next-action reason;
- `reasonTypes`, allowed unlock types used by runtime validation, public structural constraints, and authorized decision guidance;
- `continueReasonTypes`, allowed continue types defaulting to `WORK_REMAINS` and `VERIFYING`, used by the same three surfaces;
- `unlockShortcut`.

`maxRetries` SHALL remain a safe integer from 1 through 10 with its existing default. Existing prompt length, nonblank reason-list validation, normalization, safe fallback, and diagnostics SHALL remain unchanged. `idleDelaySeconds` SHALL remain accepted for compatibility without altering the fixed fence. No new duration setting or template language SHALL replace retired timed waits. Configured prompt text SHALL not bypass runtime authorization or restore acceptance of the wait action. Effective reason types SHALL appear using their configured spellings as enum values in the public `cw` schema without explanatory field descriptions. Schema generation, argument preparation, and runtime validation SHALL use the same effective reason configuration; the schema SHALL NOT freeze built-in types while validation accepts a different loaded configuration.

#### Scenario: Custom reason types
- **WHEN** a valid `reasonTypes` list is configured
- **THEN** authorized unlocks accept exactly those types and the inquiry explains them
- **AND** the public schema includes their configured spellings together with the effective continuation types

#### Scenario: Continuation-only retry accounting
- **WHEN** `maxRetries` is 2 and a cycle accepts one continuation and then callback unlock
- **THEN** only one retry attempt is charged and no wait budget exists

#### Scenario: Obsolete instructions in a custom prompt
- **WHEN** custom decision guidance still suggests `action: "wait"`
- **THEN** the public action enum, fixed contract, and runtime validation retain only continue and unlock
- **AND** the plugin does not edit the user's configuration to migrate it

#### Scenario: Restored decision configuration
- **WHEN** valid `decisionPrompt` and `continueReasonTypes` values are loaded
- **THEN** decision prompts include that guidance and the effective continuation types
- **AND** the public reason-type enum reflects the effective types without either key producing a removed-key diagnostic

#### Scenario: Invalid higher-precedence reason configuration
- **WHEN** a higher-precedence configuration supplies an invalid reason list
- **THEN** schema generation and runtime validation use the same existing valid fallback
- **AND** no empty enum or contradictory declaration is published
