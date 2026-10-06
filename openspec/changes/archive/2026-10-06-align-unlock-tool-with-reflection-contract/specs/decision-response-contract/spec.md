## Purpose

Defines watchdog-owned decision inquiries that assess actual task delivery and return a continue, bounded-wait, or unlock verdict through a reserved function rather than XML.

## ADDED Requirements

### Requirement: Watchdog owns decision entry
A locked current main attachment SHALL open a decision inquiry only after an eligible ordinary run settles, all observable local and process-domain work is idle, and the existing fixed 10-second idle fence qualifies. Repeated settlement observations SHALL NOT open duplicate inquiries. A queued inquiry SHALL NOT authorize submissions until its exact host metadata is observed in the corresponding run and the plugin's local context projection for the current attempt. An exhausted or decision-failed cycle SHALL NOT open another inquiry.

In this change, a confirmed or consumed attempt means that local owned-run/context observation, not proof of the final provider payload. Arbitrary later host or extension transforms are outside the plugin's observation boundary. The plugin SHALL NOT advertise final provider-consumption certification.

#### Scenario: Ordinary turn ends without a control call
- **WHEN** ordinary work settles while locked with retry budget remaining and the aggregate-idle fence qualifies
- **THEN** the watchdog sends one decision inquiry rather than immediately starting ordinary continuation work
- **AND** ordinary work did not need to call a watchdog function before ending

#### Scenario: Inquiry is queued but not consumed
- **WHEN** an inquiry has been scheduled but its exact prompt has not been confirmed in both the corresponding run and the plugin's local context projection
- **THEN** a result-function call is unauthorized and cannot select any outcome

### Requirement: Decision-only function payload
The decision prompt SHALL teach the reserved function name and a JSON object containing `action` and `reason_content`. `action` SHALL select `continue`, `wait`, or `unlock`, case-insensitive after trimming. Continue SHALL additionally require a string `reason_type` matching effective `continueReasonTypes`; unlock SHALL require a string `reason_type` matching effective `reasonTypes`. Reason-type matching SHALL be case-insensitive after trimming, with accepted values normalized to uppercase. Wait SHALL require an integer JSON number `wait_seconds` from 1 through 1800 and SHALL reject a supplied `reason_type`.

`reason_content` SHALL be a string, non-empty after trimming, of at most 1000 Unicode code points; the prompt SHALL give 500 code points as guidance, not a stricter acceptance limit. Missing fields, wrong types, unrecognized actions or reason types, and invalid bounds SHALL be rejected without coercion or truncation. XML or prose SHALL NOT be parsed as a result.

#### Scenario: Valid continue result
- **WHEN** a current authorized attempt submits `{"action":"continue","reason_type":" verifying ","reason_content":"Run the requested verification."}` with `VERIFYING` configured
- **THEN** it selects continue with normalized type `VERIFYING` and the trimmed reason

#### Scenario: Valid wait result
- **WHEN** a current authorized attempt submits `{"action":"wait","reason_content":"The remote job needs time.","wait_seconds":60}`
- **THEN** it selects a 60-second wait with no reason type

#### Scenario: Invalid wait payload
- **WHEN** a wait submission supplies a string duration, a non-integer, a duration outside 1 through 1800, or a `reason_type`
- **THEN** validation rejects that response and applies the bounded correction contract

#### Scenario: Reason bounds use code points
- **WHEN** a reason contains more than 500 but no more than 1000 Unicode code points after trimming
- **THEN** it remains valid
- **AND** a reason exceeding 1000 code points is rejected with an error stating that limit, not truncated

### Requirement: Only the current consumed attempt can act
A submission SHALL be authorized only for the current main attachment, lock cycle, inquiry, and consumed attempt. The watchdog SHALL recheck ownership and current activity before committing an outcome. Authorization SHALL end when that attempt is resolved or invalidated; a later attempt SHALL require its own confirmed prompt. User takeover, manual unlock, branch/session replacement, ownership loss, shutdown, or unrelated activity that invalidates the inquiry SHALL prevent its late results from acting. Calls outside authorization that reach the plugin SHALL return `This function is reserved for the plugin. Please try another function.` before plugin action/reason validation, without changing state, budgets, timers, or hooks or terminating ordinary work. Pi MAY reject non-object argument containers before plugin authorization; that native error SHALL have the same watchdog inertness and SHALL NOT block unrelated ordinary tools.

#### Scenario: Proactive stop during ordinary work
- **WHEN** the locked main agent makes an object-shaped reserved-function call before an authorized decision attempt exists
- **THEN** it receives the reserved-function error
- **AND** the watchdog remains locked with unchanged retry accounting

#### Scenario: Native container rejection during ordinary work
- **WHEN** ordinary work calls `cw` with non-object arguments
- **THEN** Pi may return its native object-schema diagnostic before the plugin hook
- **AND** the watchdog state and both budgets remain unchanged and unrelated ordinary tools remain available

#### Scenario: A later handler changes the provider request
- **WHEN** the current owned run and plugin context observation match but a later handler removes or replaces the inquiry
- **THEN** the plugin does not claim to detect that later transform or certify provider consumption
- **AND** local run, cycle, attempt, and call identity checks still apply

#### Scenario: User takes over a decision
- **WHEN** a user message starts new work before an earlier inquiry result commits
- **THEN** the old result cannot unlock, continue, wait, or consume attempts in the new cycle

#### Scenario: Duplicate result arrives
- **WHEN** another call or repeated lifecycle callback refers to an already resolved attempt
- **THEN** no second transition, event, hook, or retry charge occurs

### Requirement: Decision responses do not perform ordinary work
During a confirmed decision window the watchdog SHALL allow only its reserved result function to execute, without changing the declared or active tool list. The prompt SHALL request one result call with reasoning in its fields. Native thinking content SHALL remain compatible with provider dispatch; it SHALL NOT be interpreted as a decision. A response with no result call, multiple result calls, or an unrelated tool call SHALL be invalid as a whole. Unrelated tools SHALL be blocked before side effects, and a mixed batch SHALL NOT partially commit a valid-looking decision. Ordinary work outside the decision window SHALL retain its normal tool access. The complete owned batch SHALL be inspected before native dispatch. Malformed batches, including mixed, duplicate, unknown-tool, non-object, visible-prose, and truncated responses, MAY be projected to a normal stop with no executable calls; no per-call result is required for suppressed calls. Each invalid response SHALL count once and SHALL NOT trigger an unbudgeted native follow-up. Admissible singleton calls SHALL retain their executable and provider-required thinking blocks until dispatch and return a terminating result for either a staged verdict or a named validation error.

#### Scenario: Mixed result and work tools
- **WHEN** a decision response contains a result call and a shell tool call
- **THEN** the shell command does not execute
- **AND** neither call commits a watchdog outcome; the response consumes at most one invalid attempt

#### Scenario: XML answer is not a fallback
- **WHEN** the decision response contains only an old XML decision or ordinary prose
- **THEN** it is an invalid response rather than an accepted verdict

### Requirement: Bounded decision correction and failure
One inquiry SHALL allow at most three consumed response attempts: the initial response and at most two corrective re-asks. Each invalid response SHALL count once and identify the violated contract within that decision exchange. Corrections SHALL teach the same function-based contract and retain the inquiry's original timing facts. Invalid responses SHALL NOT consume the continue/wait retry budget. Dispatch deferral or stale work SHALL NOT count as a malformed response. After the third invalid response, the watchdog SHALL enter a decision-failed terminal state for that cycle, remain locked without further automatic requests, publish one shared failure event, and make `user-ready` with `STOP_KIND=DECISION_FAILED` eligible under the existing idle rules. A new lock cycle or manual unlock SHALL retain its normal recovery behavior.

#### Scenario: Third invalid response
- **WHEN** the initial response and both corrections are invalid
- **THEN** no fourth response is requested
- **AND** no continue or wait attempt is charged
- **AND** the cycle stops automatic activity as decision-failed, not as an AI unlock

#### Scenario: Valid correction
- **WHEN** the second or third response is a valid current result
- **THEN** its outcome is accepted once and no further correction is requested

### Requirement: Delivery and authorization determine the outcome
The fixed decision guidance SHALL compare every user request in the session, including earlier requests, against actual delivered answers and relevant tool results. Delivered, cancelled, and superseded work SHALL be excluded. Earlier plans, watchdog reasons, and stop markers SHALL NOT prove either remaining work or completion. Before claiming an unanswered request, the model SHALL check the latest delivered answer and identify a specific missing deliverable.

Completed work SHALL select unlock with the effective completion reason. If work remains but no action can proceed without user input, approval, credentials, or other user action, the decision SHALL select the effective user-wait unlock reason. Existing permission SHALL NOT be treated as missing permission. Continue SHALL require a concrete immediately executable action within existing authorization, named in its reason. Bounded wait SHALL be reserved for temporary external or time-based waiting that requires no user action. Callback waiting and non-user blockers SHALL remain distinct unlock categories when their effective reason types are available. Custom reason names SHALL NOT be assigned invented meanings.

#### Scenario: Earlier requested work can still proceed
- **WHEN** the latest deliverable is complete but an earlier authorized request still has an immediately executable next action
- **THEN** the decision selects continue and identifies that action

#### Scenario: Prior permission already exists
- **WHEN** the user already authorized the remaining concrete action
- **THEN** decision guidance does not ask for that same permission again
- **AND** no external classifier or permission-review service is consulted

#### Scenario: Work needs fresh approval
- **WHEN** no remaining action can proceed without new user approval
- **THEN** the decision selects a user-wait unlock rather than continue or bounded wait

### Requirement: Accepted continue and wait share the retry budget
Each accepted continue or bounded-wait verdict SHALL consume exactly one attempt from the existing per-cycle `maxRetries` budget, restoring the pre-migration shared accounting. Unlock, invalid responses, stale submissions, and transport deferrals SHALL consume none. Failed durable publication SHALL use the existing rollback and stale-ownership safeguards rather than silently consuming an attempt or starting unrecorded work. A terminal exhaustion SHALL start no ordinary work and SHALL be published only once for the qualified terminal observation.

#### Scenario: Continue followed by wait
- **GIVEN** a cycle has a budget of two attempts
- **WHEN** one continue and then one wait are accepted and durably published
- **THEN** both attempts are spent
- **AND** exhaustion cannot become user-ready before that wait's deadline and aggregate-idle qualification

### Requirement: Bounded wait retains its original deadline
An accepted wait SHALL remain locked, record its acceptance time and deadline, and start no ordinary work immediately. At or after the deadline, the watchdog SHALL re-enter its existing idle and ownership qualification before a new inquiry, or exhaustion if the budget is spent. Observable activity SHALL defer eligibility without restarting the accepted duration. Unlock, a new lock cycle, ownership loss, session replacement, or shutdown SHALL invalidate pending wake actions. Reopening persisted history SHALL NOT restore a timer.

#### Scenario: Work remains busy beyond the deadline
- **WHEN** children are still busy at the accepted wait deadline
- **THEN** no inquiry, continuation, or user-ready signal occurs until the existing aggregate-idle conditions qualify
- **AND** the original acceptance time and deadline remain unchanged

#### Scenario: Cancelled wait cannot wake later
- **WHEN** the user unlocks or takes over before a wait expires
- **THEN** the old deadline cannot start work or publish completion for the new state

### Requirement: Expired-wait inquiry receives observed timing facts
The first eligible inquiry after a current wait expires SHALL begin with the same completed-wait body visible to the human, followed by configured decision guidance and fixed function instructions. It SHALL report requested seconds, observed elapsed whole seconds, start time, and qualified wake time with explicit time-zone offsets. Corrections SHALL reuse these facts unchanged. The preamble SHALL describe elapsed watchdog delay, not infer completion, progress, health, or continued execution of external work. Normal inquiries SHALL NOT claim that a wait completed.

#### Scenario: Correcting a result does not advance the wake time
- **WHEN** an expired-wait inquiry receives an invalid result and asks for correction
- **THEN** the correction uses the original completed-wait facts and publishes no second completed-wait event
