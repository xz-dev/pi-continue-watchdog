# decision-response-contract Specification

## Purpose

Define the response-shape contract the watchdog decision prompt communicates to the model, so the model outputs a pure XML document whose structured fields carry the reasoning, while parser acceptance remains lenient for partial compliance.

## Requirements

### Requirement: Expired-wait inquiry begins with observed timing facts

The first eligible inquiry associated with a completed current wait SHALL begin with the same runtime-authored completed-wait body shown to the human, before the configured decision prompt and fixed XML suffix. It SHALL state the requested waiting seconds, observed elapsed whole seconds, original start, and qualified wake timestamp, with explicit time-zone offsets. These facts SHALL be captured for that inquiry and reused unchanged for its validation re-asks. A normal idle inquiry not associated with a completed wait SHALL NOT claim that a wait completed.

#### Scenario: A delayed inquiry reports both durations
- **GIVEN** the watchdog accepted a 1500-second wait at `2026-09-19T16:02:16.951+08:00`
- **WHEN** the next eligible inquiry is dispatched at `2026-09-19T16:27:47.951+08:00`
- **THEN** its opening timing body states requested 1500 seconds and observed elapsed 1531 seconds with those start and wake timestamps
- **AND** that body is identical to the human-visible completed-wait event
- **AND** the configured decision prompt and fixed XML-only response rules follow it

#### Scenario: Validation re-ask does not advance wake time
- **WHEN** the response to a wait-completion inquiry is invalid and a validation re-ask follows
- **THEN** the original timing preamble remains unchanged
- **AND** no additional completed-wait event is published
- **AND** the existing re-ask budget applies

#### Scenario: Ordinary idle check has no wait preamble
- **WHEN** an inquiry follows ordinary work without a current completed wait
- **THEN** it includes no synthetic requested duration, elapsed duration, or completed-wait claim

### Requirement: Timing preamble conveys no task outcome

The wait-completion preamble SHALL state that the watchdog delay elapsed, not that the external task completed or remains running. Adding timing facts SHALL NOT change XML parsing, field bounds, configured reason-type matching, tool blocking, completion-first outcome selection, or shared retry accounting. Repeated waits SHALL remain model choices subject to existing rules, not a new enforced verification policy.

#### Scenario: Time elapsed but progress is unknown
- **WHEN** the runtime has observed a wait deadline but has no new external-task result
- **THEN** the preamble reports elapsed time without claiming progress or completion
- **AND** the existing decision rules still require reconciling requested work with actual evidence

#### Scenario: No forced continue after a wait
- **WHEN** the model returns a valid wait decision after receiving a completed-wait preamble
- **THEN** the existing wait validation and retry rules apply
- **AND** elapsed time alone does not replace the decision with continue or unlock

### Requirement: Entire response is the watchdog XML document

The fixed suffix appended to the decision prompt SHALL instruct that the entire assistant response consist of exactly one `<watchdog>` XML document, with no text before or after it. The suffix SHALL NOT invite or permit explaining the decision in text outside the XML block. The suffix SHALL state that the decision's reasoning belongs in the structured fields (for example `reason_content`).

#### Scenario: Prompt forbids prose around the XML

- **WHEN** `buildDecisionPrompt` renders the fixed suffix after any configured decision prompt
- **THEN** the suffix requires the whole response to be the single watchdog XML document
- **AND** it contains no wording that permits explaining before or after the block

#### Scenario: Configured decision prompt cannot weaken the contract

- **WHEN** a user supplies a custom `decisionPrompt`
- **THEN** the fixed suffix still states the same entire-response contract
- **AND** the configured text is not relied upon to enforce the response shape

### Requirement: Reask and block reasons state the same response shape

User-facing strings that correct or constrain the model during a decision window—the invalid-XML reask error, the unsupported-content and malformed-response errors, and the tool-block reason—SHALL state the same entire-response contract: exactly one valid `<watchdog>` XML document and nothing else.

#### Scenario: Reask wording matches the initial contract

- **WHEN** a decision response is invalid and a reask error is produced
- **THEN** the error text demands the full response be the single valid watchdog XML document
- **AND** it does not describe the block as something appended after other text

### Requirement: Lenient parser acceptance is unchanged

Parser acceptance SHALL remain unchanged: a response whose non-thinking text ends with exactly one valid `<watchdog>` block remains valid even if unrelated text precedes the block, and all existing field validation, reason-type matching, and reask-count behaviors are preserved. The `reason_content` size limit is governed by the reason content hard limit requirement.

#### Scenario: Stray prose before a valid block still parses

- **WHEN** a response contains prose before a valid trailing watchdog XML block
- **THEN** validation succeeds exactly as before this change

### Requirement: Prompt declares the reason content limit

The fixed suffix appended to the decision prompt SHALL tell the model that `reason_content` must be non-empty and at most a stated number of Unicode characters (the guidance limit). The guidance limit SHALL be derived in code as exactly half of the enforced hard limit, so the advertised limit and the enforced limit cannot drift apart.

#### Scenario: Decision prompt states the limit up front

- **WHEN** `buildDecisionPrompt` renders the fixed suffix after any configured decision prompt
- **THEN** the suffix states that `reason_content` must be non-empty and at most the guidance number of Unicode characters
- **AND** the stated number equals half of the enforced hard limit

#### Scenario: Guidance and enforcement share one source

- **WHEN** the hard-limit constant is changed in a future edit
- **THEN** the prompt-stated guidance changes with it automatically
- **AND** no second literal needs a matching edit

### Requirement: Reason content hard limit

Model-provided `reason_content` for continue, wait, and unlock decisions SHALL be trimmed and accepted when it is non-empty and contains at most 1000 Unicode code points. Responses above 1000 code points SHALL be rejected and re-asked. The three reason error strings SHALL quote the enforced limit from the same shared constant rather than a literal.

#### Scenario: Reason within headroom is accepted

- **WHEN** a decision response carries a `reason_content` of more than the stated guidance but at most 1000 Unicode code points
- **THEN** validation accepts it without a re-ask

#### Scenario: Reason above the hard limit is re-asked

- **WHEN** a decision response carries a `reason_content` of more than 1000 Unicode code points
- **THEN** validation rejects it with an error quoting 1000 as the limit
- **AND** the ordinary re-ask budget applies

#### Scenario: Blank reason is still rejected

- **WHEN** a decision response carries a `reason_content` that is empty or whitespace-only after trimming
- **THEN** validation rejects it with the same limit error as before

### Requirement: Reconcile actual delivery before outcome selection

The fixed decision prompt SHALL compare outstanding user requests with the latest ordinary assistant answer and relevant tool results before selecting an outcome. It SHALL exclude delivered, cancelled, or superseded work while retaining genuinely unfinished earlier requests. Earlier plans and watchdog reasons SHALL NOT be treated as proof of remaining work; a final response or stop marker alone SHALL NOT be treated as proof of completion. Before claiming the user has not been answered, the prompt SHALL require checking the latest delivered answer and naming a specific missing deliverable.

#### Scenario: Answer already delivered

- **WHEN** the latest ordinary assistant response answers the requested question but an earlier plan says the answer is pending
- **THEN** the prompt directs the model to reconcile that plan with the delivered answer and unlock for completed work rather than repeat the answer

#### Scenario: Final response reports progress only

- **WHEN** an assistant response ends normally but only reports progress toward an unfinished requested deliverable
- **THEN** the prompt does not equate normal completion with task completion
- **AND** an authorized immediately executable action for that missing deliverable remains eligible for continue

#### Scenario: Completion-first decision tree

- **WHEN** the fixed suffix is rendered
- **THEN** it includes a plain ASCII decision tree ordered as completed work, unfinished executable authorized work, user-dependent work, external wait, and other blocker
- **AND** its prose rules use the same order
- **AND** names absent from the effective reason-type lists are replaced by semantic descriptions, not advertised as available values

### Requirement: Outcome selection follows user-boundary priority

After reconciling delivery and ruling out completed work, the fixed decision prompt SHALL define an ordered outcome policy in which the need for additional user input, approval, confirmation, authorization, credentials, or another user action takes priority over the mere existence of unfinished work. When no concrete next action can proceed without that user action, the model SHALL select `unlock_continue_watchdog` with the configured reason type corresponding to `WAIT_USER`.

#### Scenario: Production action requires explicit approval

- **WHEN** requested work remains but the next permitted action is a production modification or reload requiring explicit user approval
- **THEN** the prompt directs the model to choose unlock with `WAIT_USER`
- **AND** it does not permit `WORK_REMAINS` merely because the production work is unfinished

#### Scenario: User information is required

- **WHEN** every remaining path requires additional user input, credentials, confirmation, authorization, or another user action
- **THEN** the prompt directs the model to choose unlock with `WAIT_USER`

### Requirement: Continue requires an immediately executable action

The fixed decision prompt SHALL permit `continue_watchdog` only when a specific requested deliverable remains incomplete and at least one concrete next action can be performed immediately using existing authorization and conversation context, without additional user input or approval. Its `reason_content` SHALL identify that immediately executable action. Unfinished work by itself SHALL NOT be sufficient grounds for continue.

#### Scenario: Unfinished work is fully blocked on the user

- **WHEN** tasks remain unfinished but none can proceed before the user responds
- **THEN** the prompt prohibits `continue_watchdog`
- **AND** directs the model to select `WAIT_USER`

#### Scenario: Independent authorized work remains

- **WHEN** a user-gated action is pending but another concrete requested and authorized action can be performed now
- **THEN** the prompt permits `continue_watchdog`
- **AND** requires `reason_content` to name the immediately executable action rather than the blocked action

### Requirement: External waiting remains distinct from user waiting

The fixed decision prompt SHALL reserve `wait_watchdog` for temporary external automation or time-based waiting when no user action is required. User-dependent waiting SHALL use unlock with `WAIT_USER`, not `wait_watchdog`.

#### Scenario: CI is still running

- **WHEN** no action can proceed until CI completes and no user response is required
- **THEN** the prompt directs the model to choose `wait_watchdog` with a bounded duration

#### Scenario: User approval is pending

- **WHEN** no action can proceed until the user approves
- **THEN** the prompt directs the model to choose unlock with `WAIT_USER`
- **AND** does not classify the state as an external wait

### Requirement: Terminal outcome categories remain explicit

The fixed decision prompt SHALL distinguish completed work (`JOB_DONE`), user-dependent work (`WAIT_USER`), non-user blockers (`JOB_BLOCKED`), temporary external waits (`wait_watchdog`), and immediately actionable work (`continue_watchdog`) without changing configured reason-type matching or XML response shape.

#### Scenario: All requested work is complete

- **WHEN** every requested task is complete
- **THEN** the prompt directs unlock with `JOB_DONE`

#### Scenario: Work is blocked for a non-user reason

- **WHEN** work remains but cannot proceed for a blocker that is neither user action nor a temporary external wait
- **THEN** the prompt directs unlock with `JOB_BLOCKED`

#### Scenario: Existing protocol compatibility

- **WHEN** the ordered classification guidance is added
- **THEN** the response remains exactly one watchdog XML document
- **AND** parser behavior, configured type lists, field validation, and retry accounting remain unchanged
