## MODIFIED Requirements

### Requirement: Effective configuration keys
The watchdog SHALL honor these configuration keys with existing per-field validation and precedence of built-ins, global, then trusted project:
- `maxContinue`, the plugin-specific shared budget for accepted callback suspensions and accepted, durably published continuations per lock cycle, defaulting to `10`;
- `decisionPrompt`, internal guidance before the fixed two-action decision contract;
- `continuePrompt`, configured continuation guidance retained alongside the accepted next-action reason;
- `reasonTypes`, allowed types for the `unlock` wire action, including the configured built-in callback-suspension exception, used by runtime validation, public structural constraints, and authorized decision guidance;
- `continueReasonTypes`, allowed continue types defaulting to `WORK_REMAINS` and `VERIFYING`, used by the same three surfaces;
- `unlockShortcut`;
- `unlockReviewEnabled`, governed by the unlock-review capability, whose existing eligibility includes the callback wire pair;
- `decisionThinkingCap`, the highest thinking level of the private decision child, governed by the private-fork-decisions capability, defaulting to `medium`.

`maxContinue` SHALL be a safe integer from 1 through 10. Invalid higher-precedence values SHALL preserve valid lower-precedence values, without coercion or clamping. This setting SHALL NOT change Pi/provider transport retries, decision-format allowances, or review/reconsideration limits. `decisionThinkingCap` SHALL be exactly one of the strings `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; any other value, including other letter case or surrounding whitespace, SHALL be diagnosed and SHALL preserve the valid lower-precedence value. `decisionThinkingCap` SHALL NOT change the main session's thinking level. Existing prompt length, nonblank reason-list validation, normalization, safe fallback, and diagnostics SHALL remain unchanged. `idleDelaySeconds` SHALL remain accepted for compatibility without altering the fixed fence. No duration setting, callback-specific budget, or template language SHALL replace retired timed waits. Configured prompt text SHALL NOT bypass runtime authorization or restore acceptance of the wait action. Effective reason types SHALL appear using their configured spellings as enum values in the public `cw` schema without explanatory field descriptions. Schema generation, argument preparation, and runtime validation SHALL use the same effective reason configuration; the schema SHALL NOT freeze built-in types while validation accepts a different loaded configuration.

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

#### Scenario: Default decision thinking cap
- **WHEN** no valid `decisionThinkingCap` is configured
- **THEN** the effective cap is `medium`

#### Scenario: Valid decision thinking cap override
- **GIVEN** a global `decisionThinkingCap` value of `low`
- **WHEN** trusted project configuration supplies `inherit`
- **THEN** the effective cap is `inherit`

#### Scenario: Invalid decision thinking cap
- **GIVEN** a global `decisionThinkingCap` value of `inherit`
- **WHEN** trusted project configuration supplies `High`, `" medium"`, `none`, `true` or a number
- **THEN** the invalid value is diagnosed and the effective cap remains `inherit`
