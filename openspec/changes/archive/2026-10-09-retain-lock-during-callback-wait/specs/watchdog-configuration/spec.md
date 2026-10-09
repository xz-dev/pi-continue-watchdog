## MODIFIED Requirements

### Requirement: Effective configuration keys
The watchdog SHALL honor these configuration keys with existing per-field validation and precedence of built-ins, global, then trusted project:
- `maxContinue`, the plugin-specific shared budget for accepted callback suspensions and accepted, durably published continuations per lock cycle, defaulting to `10`;
- `decisionPrompt`, internal guidance before the fixed two-action decision contract;
- `continuePrompt`, configured continuation guidance retained alongside the accepted next-action reason;
- `reasonTypes`, allowed types for the `unlock` wire action, including the configured built-in callback-suspension exception, used by runtime validation, public structural constraints, and authorized decision guidance;
- `continueReasonTypes`, allowed continue types defaulting to `WORK_REMAINS` and `VERIFYING`, used by the same three surfaces;
- `unlockShortcut`;
- `unlockReviewEnabled`, governed by the unlock-review capability, whose existing eligibility includes the callback wire pair.

`maxContinue` SHALL be a safe integer from 1 through 10. Invalid higher-precedence values SHALL preserve valid lower-precedence values, without coercion or clamping. This setting SHALL NOT change Pi/provider transport retries, decision-format allowances, or review/reconsideration limits. Existing prompt length, nonblank reason-list validation, normalization, safe fallback, and diagnostics SHALL remain unchanged. `idleDelaySeconds` SHALL remain accepted for compatibility without altering the fixed fence. No duration setting, callback-specific budget, or template language SHALL replace retired timed waits. Configured prompt text SHALL NOT bypass runtime authorization or restore acceptance of the wait action. Effective reason types SHALL appear using their configured spellings as enum values in the public `cw` schema without explanatory field descriptions. Schema generation, argument preparation, and runtime validation SHALL use the same effective reason configuration; the schema SHALL NOT freeze built-in types while validation accepts a different loaded configuration.

#### Scenario: Default plugin allowance
- **WHEN** no valid `maxContinue` is configured
- **THEN** the effective plugin budget is ten
- **AND** unrelated Pi/provider retry settings remain unchanged

#### Scenario: Custom reason types
- **WHEN** a valid `reasonTypes` list is configured
- **THEN** authorized `unlock`-action calls accept exactly those types and the inquiry explains the configured built-in callback exception when present
- **AND** the public schema includes their configured spellings together with the effective continuation types

#### Scenario: Continuation-only retry accounting
- **WHEN** `maxContinue` is two and a cycle accepts one published continuation and then callback suspension
- **THEN** two units are consumed from that one budget
- **AND** the final callback wait is retained until actual resumed work settles, without a separate waiting budget

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

#### Scenario: Invalid higher-precedence allowance
- **GIVEN** a global `maxContinue` value of four
- **WHEN** trusted project configuration supplies zero, eleven, a fractional value, or a numeric string for `maxContinue`
- **THEN** the invalid value is diagnosed and the effective allowance remains four

### Requirement: Removed keys produce an error diagnostic
A configuration layer containing `maxRetries` or `jevWaitCheck` SHALL produce an error-level diagnostic naming that key as removed and without effect. `maxRetries` SHALL NOT be a compatibility alias for `maxContinue`; its diagnostic SHALL identify `maxContinue` as the replacement without echoing the removed value. Diagnostics SHALL NOT print nested values or credentials. `decisionPrompt` and `continueReasonTypes` SHALL remain active keys rather than removed keys. Other valid values SHALL still apply and extension load SHALL NOT fail. Configuration migration SHALL NOT modify credentials, environment variables, consumer settings, or user configuration files.

#### Scenario: Old config with decisionPrompt
- **WHEN** valid `decisionPrompt`, `continueReasonTypes`, and `maxContinue` settings are present
- **THEN** all apply without removed-key diagnostics

#### Scenario: Removed key is not reported as merely unsupported
- **WHEN** `jevWaitCheck` is present with credentials or `enabled: false`
- **THEN** the diagnostic identifies the removed key without exposing its nested values
- **AND** that key activates no classifier request and valid neighboring values still apply

#### Scenario: Old config with jevWaitCheck
- **GIVEN** global config sets `jevWaitCheck` with an API key and `maxContinue: 5`
- **WHEN** configuration loads
- **THEN** an error diagnostic names `jevWaitCheck` as removed without displaying its values
- **AND** `maxContinue` five applies, load succeeds, and no jev request occurs because of the removed key

#### Scenario: Only the old budget key is present
- **WHEN** config contains `maxRetries: 2` with no valid `maxContinue` in any layer
- **THEN** the removed-key error is reported and the effective `maxContinue` is ten, not two
- **AND** the user configuration file is left unchanged

#### Scenario: Both budget keys are present
- **WHEN** one layer supplies `maxContinue: 3` and `maxRetries: 7`
- **THEN** three is the valid plugin allowance and `maxRetries` still produces its removed-key error
- **AND** the old value neither overrides nor supplements the allowance

#### Scenario: Removed high-precedence key cannot override the new key
- **GIVEN** global config sets `maxContinue: 4`
- **WHEN** project config contains only `maxRetries: 1` for the budget
- **THEN** the effective allowance remains four and the project key is diagnosed as removed

### Requirement: Removed integration does not resolve shared credentials
The continue watchdog SHALL NOT resolve TypeSafe or OpenRouter credentials itself for a jev classifier or review, infer enablement from their availability, or activate the removed `jevWaitCheck` integration. Unlock review SHALL use only its separately specified already-loaded shared service, whose owner handles backend selection and credentials. This callback/configuration change SHALL NOT expand that service integration or introduce direct provider requests. The watchdog SHALL NOT remove or modify credentials or integrations used by other providers or extensions.

#### Scenario: Shared key remains available
- **WHEN** Pi or the environment contains TypeSafe or OpenRouter credentials
- **THEN** ordinary settlement and decision processing make no direct jev classification or review request using those credentials
- **AND** those credentials remain unchanged for unrelated users of them
