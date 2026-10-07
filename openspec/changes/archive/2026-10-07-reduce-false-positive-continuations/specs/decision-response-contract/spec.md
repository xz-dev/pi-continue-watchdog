## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Assessment-first guidance preserves the existing result protocol
The fixed inquiry guidance SHALL request a concise delivery assessment in the existing `reason_content` before `reason_type` and `action`, using only the existing single reserved-function response. This SHALL NOT add result arguments, ordinary work tools, a second model, or visible reasoning messages. Both assessment-first and action-first valid objects SHALL remain accepted. The existing configured reason types, 500-code-point guidance target, 1000-code-point acceptance limit, unrelated-extra-field handling, ownership checks, and correction/retry bounds SHALL remain unchanged. Property order, citations, and source identifiers SHALL NOT become new semantic acceptance gates.

#### Scenario: New guidance with an existing client
- **WHEN** a current owned inquiry receives a valid action-first object from an existing client
- **THEN** it is accepted under the unchanged argument rules rather than rejected for property order
- **AND** the same decision in assessment-first order is also accepted

#### Scenario: Assessment is not a separate conversation turn
- **WHEN** the model follows assessment-first guidance
- **THEN** it supplies one reserved-function response with a concise reason and verdict, without an extra model call or ordinary assistant checklist
- **AND** valid syntax is not reported as proof that the assessment is semantically correct
