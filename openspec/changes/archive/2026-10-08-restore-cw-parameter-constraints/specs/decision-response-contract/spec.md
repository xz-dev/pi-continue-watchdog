## MODIFIED Requirements

### Requirement: Reserved function remains phase gated
The stable root-only function SHALL remain named `cw`, with description `don't use unless ask` and a structurally constrained parameter schema. Its public declaration SHALL expose fields, required string types, allowed enums, and reason bounds without explanatory parameter text, examples, prompt snippets, or guidelines. Registration and active membership SHALL NOT change across decision phases. A schema-admissible call outside the current authorized attempt SHALL return `This function is reserved for the plugin. Please try another function.` before plugin decision submission, with no state, accounting, notification, timer, or ordinary-run termination effect. Native schema rejection of an inadmissible ordinary call SHALL remain similarly inert for watchdog state and SHALL NOT terminate unrelated ordinary work. Structural validity SHALL never establish current-attempt authority.

#### Scenario: Ordinary work knows the correct arguments
- **WHEN** an ordinary run submits a schema-admissible `cw` unlock copied from history
- **THEN** the reserved-function rejection is returned
- **AND** ordinary work and unrelated tools remain available with no watchdog transition

#### Scenario: Ordinary malformed call fails without watchdog effects
- **WHEN** an ordinary run submits missing, mistyped, or invalid-enum arguments
- **THEN** native schema validation can reject the call before plugin execution
- **AND** no decision attempt, continuation charge, unlock, watchdog hook, or ordinary-run termination is caused by that rejection

### Requirement: Decision responses cannot perform ordinary work
A confirmed inquiry SHALL admit exactly one correlated `cw` call and no ordinary tool calls or visible prose. Mixed, duplicate, unknown-tool, non-object, missing-result, prose, and truncated responses SHALL be invalid as a whole, with ordinary tools prevented from causing side effects. An admissible normalized call and required provider thinking SHALL remain executable until result dispatch.

An owned response that fails argument or response validation SHALL be captured under the current attempt and prevented from entering an uncontrolled native schema-error follow-up. Its safe validator diagnostic SHALL remain available for the existing correction flow without exposing raw invalid model content. Both valid staged results and any authorized validation failure reaching execution SHALL terminate their decision batch. Each finalized invalid response SHALL count once. The existing maximum of three response attempts, current-attempt reauthorization for corrections, decision-failed recovery, and no-fourth-attempt rule SHALL remain unchanged.

#### Scenario: Mixed tools
- **WHEN** an owned response includes both a valid-looking `cw` call and a work-tool call
- **THEN** neither commits its effect and the work tool never executes
- **AND** the response counts as one invalid attempt

#### Scenario: Repeated retired action
- **WHEN** all three authorized responses select the retired wait action
- **THEN** the cycle remains locked and becomes decision-failed with no fourth request
- **AND** no ordinary continuation attempt is consumed

#### Scenario: Missing action is corrected inside the owned flow
- **WHEN** a confirmed attempt receives a singleton `cw` call containing no `action`
- **THEN** the watchdog captures the invalid result before native tool execution can generate an ordinary follow-up request
- **AND** exactly one invalid attempt is counted, with the safe action diagnostic used by the bounded correction flow

#### Scenario: Valid correction remains executable
- **GIVEN** the previous owned response failed the schema contract
- **WHEN** the newly authorized correction supplies a valid normalized `cw` result
- **THEN** it reaches the ordinary staged-result and settlement fences once
- **AND** the prior invalid response creates neither an extra native follow-up nor a retry-budget charge

#### Scenario: Schema cannot bypass takeover fences
- **WHEN** a schema-valid result becomes stale because the user takes over before publication
- **THEN** the result cannot unlock, continue, or charge the replacement cycle
