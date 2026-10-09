## MODIFIED Requirements

### Requirement: Watchdog owns decision entry
A locked current main attachment SHALL open one initial decision inquiry only after eligible ordinary work settles, the fixed 10-second idle fence elapses, and existing local, child, process-domain, ownership, and generation checks qualify. Exhausted and decision-failed cycles SHALL open none. Queueing an inquiry SHALL NOT authorize a result: the current owned run and the plugin's local context projection SHALL observe that exact attempt before a correlated call can act. This local observation SHALL NOT be described as certification of arbitrary later provider transformations. An enabled unlock review SHALL be allowed to request at most one separately owned semantic reconsideration inquiry after a definite challenge to a valid initial AI unlock. That inquiry SHALL retain the live qualification and exact-attempt observation requirements without starting a new lock cycle, replenishing continuation budget, or introducing a timed-wait scheduler. The initial inquiry and its optional reconsideration SHALL form one bounded logical decision.

#### Scenario: Eligible ordinary settlement
- **WHEN** locked ordinary work settles with budget remaining and all qualification checks pass
- **THEN** one internal inquiry precedes any ordinary continuation
- **AND** repeated settlement observations do not duplicate it

#### Scenario: Queued or stale inquiry
- **WHEN** an inquiry is queued but not locally confirmed, or its cycle, branch, session, or ownership has changed
- **THEN** its result cannot commit an outcome

#### Scenario: One challenge-triggered inquiry
- **WHEN** unlock review definitely challenges a current valid initial AI unlock
- **THEN** at most one separately owned semantic reconsideration inquiry is eligible after current live qualification
- **AND** repeated challenge delivery or a reconsidered unlock does not open another review/reconsideration round

### Requirement: Decision responses cannot perform ordinary work
A confirmed inquiry SHALL admit exactly one correlated `cw` call and no ordinary tool calls or visible prose. Mixed, duplicate, unknown-tool, non-object, missing-result, prose, and truncated responses SHALL be invalid as a whole, with ordinary tools prevented from causing side effects. An admissible normalized call and required provider thinking SHALL remain executable until result dispatch.

An owned response that fails argument or response validation SHALL be captured under the current attempt and prevented from entering an uncontrolled native schema-error follow-up. Its safe validator diagnostic SHALL remain available for the existing correction flow without exposing raw invalid model content. Both valid staged results and any authorized validation failure reaching execution SHALL terminate their decision batch. Each finalized invalid response SHALL count once. The maximum of three response attempts per inquiry, current-attempt reauthorization for corrections, decision-failed recovery, and no-fourth-attempt rule within an inquiry SHALL remain unchanged. A semantic challenge SHALL NOT be classified as a malformed response. The single optional semantic reconsideration SHALL have its own ordinary inquiry-format allowance; one logical decision SHALL therefore contain at most two inquiries and six consumed decision responses, not counting service-owned transport attempts. Format correction SHALL NOT reset the one-reconsideration limit or authorize ordinary work.

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

#### Scenario: Format correction during semantic reconsideration
- **WHEN** a definite review challenge opens the one reconsideration inquiry and that inquiry receives malformed responses
- **THEN** it uses at most its three format-response attempts and then the existing decision-failed behavior
- **AND** neither malformed responses nor a valid reconsidered unlock cause another semantic review

### Requirement: Assessment-first guidance preserves the existing result protocol
The fixed inquiry guidance SHALL request a concise delivery assessment in the existing `reason_content` before `reason_type` and `action`, using only the existing single reserved-function response. That assessment-first guidance by itself SHALL NOT add result arguments, ordinary work tools, a second model, or visible reasoning messages. The AI-unlock review SHALL be governed by the unlock-review capability and its own setting, not by the assessment wording. Both assessment-first and action-first valid objects SHALL remain accepted. The existing configured reason types, 500-code-point guidance target, 1000-code-point acceptance limit, unrelated-extra-field handling, ownership checks, per-inquiry correction bounds, and continuation retry budget SHALL remain unchanged. Property order, citations, and source identifiers SHALL NOT become new semantic acceptance gates.

#### Scenario: New guidance with an existing client
- **WHEN** a current owned inquiry receives a valid action-first object from an existing client
- **THEN** it is accepted under the unchanged argument rules rather than rejected for property order
- **AND** the same decision in assessment-first order is also accepted

#### Scenario: Assessment is not a separate conversation turn
- **WHEN** the model follows assessment-first guidance
- **THEN** it supplies one reserved-function response with a concise reason and verdict, without an extra model call or ordinary assistant checklist
- **AND** valid syntax is not reported as proof that the assessment is semantically correct

#### Scenario: Review remains a separate setting
- **WHEN** assessment-first guidance is used while unlock review is disabled
- **THEN** the guidance does not discover a reviewer, send a review request, or add a reconsideration inquiry
