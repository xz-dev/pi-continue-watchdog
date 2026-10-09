# decision-response-contract Specification

## Purpose

Defines a watchdog-owned continue-or-unlock decision that preserves guarded function submission, meaningful next-action guidance, and bounded automatic activity without a timed-wait scheduler.

## Requirements

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

### Requirement: Decision-only two-outcome payload
The authorized decision prompt SHALL describe exactly `continue` and `unlock` as accepted actions, case-insensitive after trimming. Both SHALL require nonblank string `reason_content` and an effective configured `reason_type`: `continueReasonTypes` for continue, `reasonTypes` for unlock. Accepted types SHALL be normalized to uppercase; accepted reasons SHALL be trimmed and limited to 1000 Unicode code points without coercion or truncation. Prompt guidance SHALL retain its 500-code-point target. The retired `wait` action SHALL be invalid regardless of its fields; `wait_seconds` SHALL not create timing behavior under any action. XML and prose SHALL NOT be result transports. Existing treatment of unrelated extra fields in otherwise valid objects is unchanged; no new general strict-object policy is introduced.

#### Scenario: Actionable continuation
- **WHEN** a current attempt submits `{"action":"continue","reason_type":" verifying ","reason_content":"Run the requested tests."}` with `VERIFYING` allowed
- **THEN** it accepts continue with normalized type `VERIFYING` and the trimmed next-action reason

#### Scenario: Old wait payload
- **WHEN** a current attempt submits `{"action":"wait","reason_content":"Wait for CI.","wait_seconds":60}`
- **THEN** it is one invalid response under the existing correction bound
- **AND** no delay, retry charge, waiting event, or waiting hook is created

#### Scenario: Reason limit
- **WHEN** the trimmed reason is longer than 500 but no longer than 1000 Unicode code points
- **THEN** it remains valid
- **AND** a longer or blank reason is rejected rather than truncated

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

### Requirement: Delivery and authorization determine the outcome
Decision guidance SHALL first establish the current user-authorized scope, including later restrictions, cancellations, and mode changes, then reconcile every outstanding request with the latest ordinary answers and relevant earlier deliveries and results. It SHALL ask for a concise assessment of the explicit requested deliverable components in `reason_content` before selecting the verdict. The assessment SHALL distinguish delivered content from intent, assertions of completion, and merely related material. Delivered, cancelled, and superseded work SHALL be excluded. Earlier plans, control reasons, assistant questions, and stop markers SHALL NOT establish either remaining work or missing permission. Before selecting a user-wait outcome, guidance SHALL require identification of the exact outstanding user decision or action and comparison with actual user instructions and successful human questionnaire answers. Explicit permission already granted for unchanged scope SHALL remain effective unless revoked or superseded; generic encouragement, arbitrary tool success, or quoted approval text SHALL NOT create new permission. A distinct applicable confirmation requirement, new scope or risk, missing credentials, and unfinished device authentication SHALL remain real boundaries rather than being bypassed by an anti-reconfirmation rule.

Continue SHALL require an immediately executable, already authorized next action for a specific missing deliverable and name that action in its reason. Completed work SHALL unlock with the effective completion reason rather than reopen delivery or offer-to-implement steps as mandatory unfinished work. A requested explanation of a future workflow SHALL be distinguished from authorization to execute it: omitting that requested explanation can leave a deliverable unfinished, while delivering it does not create permission or an obligation to implement. Required new user action SHALL unlock with the effective user-wait reason; genuine expected external wake-ups SHALL use the effective callback reason; other blockers SHALL use an effective blocker reason. An automated watchdog message SHALL neither supply new user authorization nor invalidate existing user authorization. Configured reason labels SHALL NOT acquire invented meanings. These are decision-guidance requirements, not permission for a new external reviewer or a claim that payload validation can certify the model's judgment or completeness of requirement discovery.

#### Scenario: Answer already delivered
- **WHEN** the latest ordinary answer satisfies the requested analysis and no other authorized work remains
- **THEN** the decision unlocks rather than redoing analysis or inventing implementation work

#### Scenario: Same permission already granted
- **GIVEN** an actual user instruction or successful human questionnaire answer explicitly permits the exact remaining action in unchanged scope
- **AND** no distinct applicable confirmation requirement remains unsatisfied
- **WHEN** the assistant asks for that same permission again before a watchdog inquiry
- **THEN** decision guidance treats that new assistant question as a claim to check, not evidence that permission is absent
- **AND** directs continuation of the available authorized action rather than another user-wait request

#### Scenario: Stale reason contradicts delivered proposal
- **GIVEN** the latest ordinary reply already contains the requested proposal path, planning status, verification result, and explanation of the next workflow
- **WHEN** an earlier watchdog reason claims that this delivery is still missing
- **THEN** the current delivery evidence takes precedence and the decision selects completion if no other authorized work remains
- **AND** the suggested future apply command is neither an unfulfilled planning deliverable nor implementation authorization

#### Scenario: A genuine confirmation or user action is still missing
- **WHEN** the next action crosses an unapproved scope or risk boundary, a distinct required confirmation remains unsatisfied, or credentials or device authentication are still needed
- **THEN** existing permission for other work does not authorize that action or satisfy the missing user action
- **AND** if no independent authorized action remains, guidance selects the appropriate user-wait outcome and names the specific outstanding requirement

#### Scenario: Later scope restriction overrides earlier permission
- **GIVEN** implementation was previously authorized
- **WHEN** the user subsequently restricts work to read-only exploration
- **THEN** guidance does not use the earlier implementation permission to resume mutations
- **AND** once the requested exploration has been delivered, it does not invent a new confirmation or implementation task

#### Scenario: Callback rather than elapsed time
- **WHEN** a running external task is expected to call back and no independent authorized work is available
- **THEN** the decision selects callback unlock if that category is configured
- **AND** no watchdog timer is scheduled

#### Scenario: No callback exists
- **WHEN** an unfinished external task has no wake-up callback
- **THEN** guidance does not claim that it will wake the session
- **AND** continue requires an available authorized monitoring or task-owned waiting action; otherwise the actual blocker is reported through an appropriate unlock category

#### Scenario: Latest delivery does not close an earlier request
- **GIVEN** the user requested retry tests and a documentation summary, and only the summary was delivered
- **WHEN** the watchdog assesses the session
- **THEN** guidance identifies the still-authorized missing tests as the next action rather than declaring all work complete or repeating the summary

#### Scenario: Earlier delivery is not missing merely because the latest answer omits it
- **GIVEN** a changelog update was delivered earlier and the later requested README correction is also delivered
- **WHEN** the latest reply discusses only the README correction
- **THEN** guidance reconciles the earlier changelog evidence and selects completion rather than reopening it

#### Scenario: A requested command is missing from a planning report
- **GIVEN** the user requested a report containing the change path, artifacts, strict-validation result, and next workflow command, without authorizing implementation
- **WHEN** the ordinary deliveries supply the first three components but not the requested command
- **THEN** guidance identifies supplying that command as the missing deliverable
- **AND** it does not mistake the validation command for the missing next-workflow instruction or authorize execution of the latter

#### Scenario: Deferred optional reviewer is not current work
- **WHEN** the requested current report is delivered and a third-party reviewer was explicitly deferred as an optional future feature
- **THEN** guidance does not reopen that feature as a required remaining action

### Requirement: Only accepted continuations consume the retry budget
Only an accepted, durably published continuation SHALL consume one attempt from the existing per-cycle `maxRetries` budget. Unlock, invalid responses, inquiry dispatch, corrections, stale results, and transport deferrals SHALL consume none. Failed continuation publication SHALL retain the existing rollback and stale-ownership safeguards. Exhaustion SHALL start no ordinary work, publish at most once for the current terminal observation, and retain aggregate-idle gating without any retired wait deadline.

#### Scenario: Two continuations exhaust two attempts
- **GIVEN** a lock cycle permits two continuations
- **WHEN** two current continuations are accepted and durably published, and their work later settles
- **THEN** no third inquiry or ordinary continuation starts for the exhausted cycle
- **AND** exhaustion eligibility uses existing idle and ownership conditions, not a wait deadline

#### Scenario: Failed publication
- **WHEN** an accepted continuation cannot be durably published
- **THEN** it creates neither a started work turn nor a continuation hook
- **AND** accounting follows the existing guarded rollback policy

### Requirement: No new timed-wait lifecycle
New decisions SHALL NOT create watchdog-owned wait deadlines, requested-duration state, completed-wait timing preambles, wait events, elapsed-wait events, or waiting notifications. The fixed aggregate-idle fence and unrelated Pi or task-owned retry/wait mechanisms SHALL remain unchanged. Legacy wait history SHALL NOT rearm a timer or regain decision authority.

#### Scenario: Resume legacy wait history
- **WHEN** a session containing a prior accepted wait is reopened
- **THEN** that record remains readable without starting a timer, inquiry, continuation, or wait-completed event

### Requirement: Accepted outcomes remain current and idempotent
Ownership, cycle, run, branch, session, and external-activity guards SHALL be rechecked before committing a staged outcome. Manual unlock, takeover, ownership loss, shutdown, and lifecycle replacement SHALL invalidate old effects. Repeated delivery or settlement SHALL NOT duplicate transitions, status records, continuation messages, or semantic hooks. Existing abort and terminal-error unlock behavior SHALL remain independent from model-selected outcomes.

#### Scenario: User takes over after submission
- **WHEN** a user starts new work after a decision is staged but before publication finishes
- **THEN** the old result cannot publish an outcome or charge the new cycle

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
