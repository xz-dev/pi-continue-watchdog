# decision-response-contract Specification

## Purpose

Defines a watchdog-owned continue-or-unlock decision that preserves guarded private-file submission, meaningful next-action guidance, and bounded automatic activity without a timed-wait scheduler.

## Requirements

### Requirement: Watchdog owns decision entry
A locked current main attachment SHALL open one initial private decision inquiry only after eligible ordinary work settles, the fixed 10-second idle fence elapses, and existing local, child, process-domain, ownership, and generation checks qualify. Suspended, exhausted, and decision-failed cycles SHALL open none. The inquiry SHALL execute in a separately identified full-fork child, not as a trigger-turn message in the main session. Creating the child or result file SHALL NOT authorize a result: the exact current child, inquiry, response attempt, source branch/session, cycle, and ownership SHALL qualify before a file result can act. The private child's own activity SHALL not invalidate its inquiry or qualify a second inquiry; genuine external activity SHALL retain the existing invalidation boundary. Context inheritance SHALL not be described as certification of arbitrary later provider transformations. An enabled unlock review SHALL be allowed to request at most one separately owned semantic reconsideration inquiry after a definite challenge to a valid initial `unlock`-action candidate, including `WAIT_CALLBACK`. That inquiry SHALL run in the same private child, retain live qualification and exact-attempt requirements, and SHALL NOT start a new lock cycle, replenish the plugin budget, or introduce a timed-wait scheduler. The initial inquiry and its optional reconsideration SHALL form one bounded logical decision. Callback suspension SHALL begin only when the final current callback result is accepted, not when an initial candidate is awaiting review.

#### Scenario: Eligible ordinary settlement
- **WHEN** locked ordinary work settles with budget remaining, no callback suspension, and all qualification checks pass
- **THEN** one private fork inquiry precedes any ordinary continuation
- **AND** repeated settlement observations do not duplicate it or append an inquiry to the main conversation

#### Scenario: Queued or stale inquiry
- **WHEN** an inquiry has not completed its authorized attempt, or its cycle, branch, session, or ownership has changed
- **THEN** its file result cannot commit an outcome

#### Scenario: One challenge-triggered inquiry
- **WHEN** unlock review definitely challenges a current valid initial `unlock`-action candidate
- **THEN** at most one separately owned reconsideration inquiry is eligible in that same child after current live qualification
- **AND** repeated challenge delivery or a reconsidered result does not open another review/reconsideration round

#### Scenario: Callback wait stays quiet
- **WHEN** a current cycle is suspended awaiting callback and another idle observation occurs
- **THEN** no inquiry or continuation is scheduled even though the lock remains held

### Requirement: Decision-only two-outcome payload
The private task and correction guidance SHALL describe exactly `continue` and `unlock` as accepted JSON actions, case-insensitive after trimming. The designated file SHALL contain one complete JSON object. Both actions SHALL require nonblank string `reason_content` and an effective configured `reason_type`: `continueReasonTypes` for continue, `reasonTypes` for unlock. Accepted types SHALL be normalized to uppercase; accepted reasons SHALL be trimmed and limited to 1000 Unicode code points without coercion or truncation. Prompt guidance SHALL retain its 500-code-point target. These two actions SHALL have three execution effects: continue, actual unlock, or callback suspension for the validated built-in `unlock`/`WAIT_CALLBACK` pair. Authorized guidance SHALL state this compatibility exception rather than falsely promise that the callback pair releases the lock. Matching SHALL retain the configured type's validated identity; an unrelated custom label or reason text SHALL NOT acquire callback semantics merely from an uppercase display representation. The retired `wait` action SHALL be invalid regardless of its fields; `wait_seconds` SHALL NOT create timing behavior under any action. XML, prose, function arguments, and JSON outside the designated file SHALL NOT be result transports. Existing treatment of unrelated extra fields in otherwise valid objects is unchanged; no new general strict-object policy is introduced. Validation SHALL NOT fill missing fields, stringify non-strings, truncate reasons, or replace a reason not allowed for the selected action. Property order SHALL not determine validity.

#### Scenario: Actionable continuation
- **WHEN** a current private attempt writes `{"action":"continue","reason_type":" verifying ","reason_content":"Run the requested tests."}` to its result file with `VERIFYING` allowed
- **THEN** it accepts continue with normalized type `VERIFYING` and the trimmed next-action reason

#### Scenario: Old wait payload
- **WHEN** a current private attempt writes `{"action":"wait","reason_content":"Wait for CI.","wait_seconds":60}`
- **THEN** it is one invalid response under the existing correction bound
- **AND** no delay, budget charge, waiting event, or waiting hook is created

#### Scenario: Reason limit
- **WHEN** the trimmed reason is longer than 500 but no longer than 1000 Unicode code points
- **THEN** it remains valid
- **AND** a longer or blank reason is rejected rather than truncated, including 1001 non-BMP code points

#### Scenario: Old callback call shape has the new effect
- **WHEN** a current valid `unlock`/`WAIT_CALLBACK` file result is finally accepted
- **THEN** it suspends the current locked cycle without requiring a new action or field
- **AND** an extra `wait_seconds` field cannot schedule a wake-up

#### Scenario: Existing mixed-case values remain valid
- **WHEN** a current attempt writes `{"action":" UNLOCK ","reason_type":" needreview ","reason_content":" Review requested. "}` and `NeedReview` is configured for unlock
- **THEN** validation retains the matched configured identity `NeedReview` and the trimmed content
- **AND** the accepted outcome records `NEEDREVIEW` and `Review requested.`

#### Scenario: Uppercase output is not a new input alias
- **WHEN** the effective unlock reason list is `["ß"]`
- **THEN** the existing matcher accepts input `ß` but rejects input `SS`
- **AND** the uppercase outcome representation `SS` does not create an accepted alias or bypass revalidation

#### Scenario: Validation does not repair invalid decisions
- **WHEN** a file omits `action`, provides numeric `reason_content`, contains a non-object JSON value, or exceeds the trimmed reason bound
- **THEN** no valid replacement is manufactured, stringified, or truncated
- **AND** the attempt remains invalid

#### Scenario: Reason membership is action-specific
- **WHEN** `VERIFYING` is configured only for continue but a current file result selects `unlock` with that type
- **THEN** validation rejects the response
- **AND** membership in another action's configured list does not authorize an unlock

### Requirement: Decision responses cannot perform ordinary work
A private inquiry SHALL allow only its designated result-file write and SHALL NOT perform ordinary work. Forbidden, mixed, duplicate-write, or unknown-tool requests SHALL be rejected as a whole before tool effects run. Missing, untouched, malformed, non-object, invalid-field, or truncated file results SHALL be invalid. Ordinary response prose SHALL supply no result and SHALL not substitute for a file; it SHALL remain private rather than creating a separate delivery. An admitted result-file write SHALL finish before validation; provider-required thinking SHALL not be exported as a result or ordinary delivery.

A completed invalid response SHALL be captured once under the current private attempt and prevented from entering an uncontrolled native tool-error follow-up. Its safe validator diagnostic SHALL be appended to the same child for correction without returning an intermediate result to the main model. Each attempt SHALL admit only one completed model response plus its permitted write and SHALL NOT request a post-tool acknowledgement response. The maximum of three response attempts per inquiry, current-attempt reauthorization for corrections, decision-failed recovery, and no-fourth-attempt rule SHALL remain unchanged. A semantic challenge SHALL NOT be classified as a malformed response. The single optional semantic reconsideration SHALL have its own three-response allowance in the same child; one logical decision SHALL therefore contain at most two inquiries and six consumed decision responses, not counting service-owned transport attempts. Format correction SHALL NOT reset the one-reconsideration limit or authorize ordinary work. Cancellation, stale attempts, setup/host-file failures, and provider failures SHALL remain distinct from consumed invalid model responses.

#### Scenario: Mixed tools
- **WHEN** an owned response requests both the result-file write and a work-tool call
- **THEN** neither effect executes and no decision commits
- **AND** the response counts as one invalid attempt inside the same child

#### Scenario: Repeated retired action
- **WHEN** all three authorized responses write the retired wait action
- **THEN** the cycle remains locked and becomes decision-failed with no fourth response request
- **AND** no ordinary continuation attempt is consumed

#### Scenario: Missing action is corrected inside the owned flow
- **WHEN** a completed private response writes an object containing no `action`
- **THEN** the watchdog captures the invalid result without allowing a native follow-up model response
- **AND** exactly one invalid attempt is counted, with the safe action diagnostic appended to that same child's correction context

#### Scenario: Valid correction remains executable
- **GIVEN** the previous private response failed the file contract
- **WHEN** the next authorized single-response attempt writes a valid normalized object after the host reset the file to `{}`
- **THEN** it reaches the ordinary staged-result and settlement fences once
- **AND** the prior invalid response creates neither a new fork, an extra native follow-up, nor a continuation-budget charge

#### Scenario: Schema cannot bypass takeover fences
- **WHEN** a structurally valid file result becomes stale because the user takes over before publication
- **THEN** the result cannot unlock, continue, or charge the replacement cycle

#### Scenario: Format correction during semantic reconsideration
- **WHEN** a definite review challenge opens the one reconsideration inquiry and that inquiry receives malformed file results
- **THEN** it uses at most its three single-response attempts in the original child and then the existing decision-failed behavior
- **AND** neither malformed responses nor a valid reconsidered unlock cause another semantic review

### Requirement: Delivery and authorization determine the outcome
Decision guidance SHALL first establish the current user-authorized scope, including later restrictions, cancellations, and mode changes, then reconcile every outstanding request with the latest ordinary answers and relevant earlier deliveries and results. It SHALL ask for a concise assessment of the explicit requested deliverable components in `reason_content` before selecting the verdict. The assessment SHALL distinguish delivered content from intent, assertions of completion, and merely related material. Delivered, cancelled, and superseded work SHALL be excluded. Earlier plans, control reasons, assistant questions, and stop markers SHALL NOT establish either remaining work or missing permission. Before selecting a user-wait outcome, guidance SHALL require identification of the exact outstanding user decision or action and comparison with actual user instructions and successful human questionnaire answers. Explicit permission already granted for unchanged scope SHALL remain effective unless revoked or superseded; generic encouragement, arbitrary tool success, or quoted approval text SHALL NOT create new permission. A distinct applicable confirmation requirement, new scope or risk, missing credentials, and unfinished device authentication SHALL remain real boundaries rather than being bypassed by an anti-reconfirmation rule.

Continue SHALL require an immediately executable, already authorized next action for a specific missing deliverable and name that action in its reason. Completed work SHALL actually unlock with the effective completion reason rather than reopen delivery or offer-to-implement steps as mandatory unfinished work. A requested explanation of a future workflow SHALL be distinguished from authorization to execute it: omitting that requested explanation can leave a deliverable unfinished, while delivering it does not create permission or an obligation to implement. Required new user action SHALL unlock with the effective user-wait reason; genuine expected external wake-ups with no independent authorized action SHALL use the configured built-in callback pair to suspend while retaining the lock; other blockers SHALL use an effective blocker reason. An automated watchdog message SHALL neither supply new user authorization nor invalidate existing user authorization. Other configured reason labels SHALL NOT acquire invented meanings. These are decision-guidance requirements, not permission for an implicitly enabled external reviewer or a claim that payload validation can certify the model's judgment or completeness of requirement discovery.

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
- **THEN** the decision selects callback suspension through `unlock`/`WAIT_CALLBACK` if that category is configured
- **AND** the lock is retained and no watchdog wait timer is scheduled

#### Scenario: No callback exists
- **WHEN** an unfinished external task has no wake-up callback
- **THEN** guidance does not claim that it will wake the session
- **AND** continue requires an available authorized monitoring or task-owned waiting action; otherwise the actual blocker is reported through an appropriate actual-unlock category

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

### Requirement: Continuation and callback suspension share the plugin budget
An accepted, durably published continuation and an accepted callback-suspension transition SHALL each consume exactly one unit of the same per-cycle `maxContinue`, whose default is ten. A callback suspension SHALL spend its unit once at the guarded transition that retains the lock and stops automatic inquiries. Its later status/hook publication or a repeated observation SHALL NOT spend another unit or refund the accepted suspension. Actual unlock, invalid responses, inquiry dispatch, corrections, optional review/reconsideration, stale results, and transport deferrals SHALL consume none. Failed continuation publication SHALL retain the existing guarded rollback policy. A staged or invalidated callback candidate that never commits SHALL consume none. Native callback work SHALL neither consume another unit merely by starting nor reset the cycle's usage, including when a known built-in callback wake text is transported as a user-role message. Genuine new user work SHALL retain the existing fresh-cycle behavior.

When usage reaches the limit, no new automatic inquiry or ordinary continuation SHALL start. The last accepted continue SHALL still run its ordinary work; the last accepted callback suspension SHALL still wait and retain its `WAIT_CALLBACK` outcome. Exhaustion SHALL become eligible after that actual resumed work successfully settles, under current aggregate-idle and ownership guards, and at most once for the current terminal observation. No retired wait deadline or fabricated callback SHALL trigger it.

#### Scenario: Two continuations exhaust two attempts
- **GIVEN** a lock cycle permits two units
- **WHEN** two current continuations are accepted and durably published, and their work later settles
- **THEN** no third inquiry or ordinary continuation starts for the exhausted cycle
- **AND** exhaustion eligibility uses existing idle and ownership conditions, not a wait deadline

#### Scenario: Failed publication
- **WHEN** an accepted continuation cannot be durably published
- **THEN** it creates neither a started work turn nor a continuation hook
- **AND** accounting follows the existing guarded rollback policy

#### Scenario: Mixed effects share one allowance
- **GIVEN** `maxContinue` is three
- **WHEN** a published continuation, a committed callback suspension, and another published continuation occur in one cycle with callback work between the latter two decisions
- **THEN** total usage is three rather than separate continue and waiting counters
- **AND** the last work settlement permits exhaustion, not another inquiry

#### Scenario: Callback status write fails after acceptance
- **WHEN** a current callback suspension has committed but its human-only status cannot be confirmed
- **THEN** the session stays locked and suspended with its one unit still consumed
- **AND** publication retries cannot charge another unit, create a model turn, or turn the accepted suspension into a free additional allowance

### Requirement: No new timed-wait lifecycle
New decisions SHALL NOT create watchdog-owned wait deadlines, requested-duration state, completed-wait timing preambles, legacy wait or elapsed-wait events, or duration-bearing waiting hooks. A quiet callback-suspension status and a typed `user-ready` signal SHALL be permitted without introducing timed waiting. While suspended, the fixed aggregate-idle fence SHALL NOT schedule another inquiry; after real ordinary work resumes and settles with budget remaining, the same fixed fence SHALL apply. Unrelated Pi or task-owned retry/wait mechanisms SHALL remain unchanged. Legacy wait history SHALL NOT rearm a timer or regain decision authority.

#### Scenario: Resume legacy wait history
- **WHEN** a session containing a prior accepted timed wait is reopened
- **THEN** that record remains readable without starting a timer, inquiry, continuation, or wait-completed event

#### Scenario: Callback suspension does not reuse the idle fence as a polling loop
- **WHEN** the session stays suspended for longer than the fixed inquiry fence
- **THEN** no new inquiry, wake-up, or elapsed-wait notification is created

### Requirement: Accepted outcomes remain current and idempotent
Ownership, cycle, child/inquiry/response identity, source branch/session, and external-activity guards SHALL be rechecked before committing a staged file result. Manual unlock, takeover, ownership loss, shutdown, and lifecycle replacement SHALL invalidate old effects and revoke access to the current result authority. The internal child's own execution SHALL not be classified as external-work invalidation. When cross-process subagent activity invalidates an owned inquiry whose private task was already submitted, one bounded `Other error` status SHALL disclose that the check was invalidated by subagent activity and its answer discarded; activity before submission SHALL remain silent. This disclosure SHALL NOT change invalidation, lock, or budget behavior. Repeated delivery or settlement SHALL NOT duplicate transitions, status records, continuation messages, or semantic hooks. Existing main-run abort and terminal-error unlock behavior SHALL remain independent from model-selected outcomes; private child cancellation SHALL not be mistaken for an ordinary main abort.

#### Scenario: User takes over after submission
- **WHEN** a user starts new work after a file decision is staged but before publication finishes
- **THEN** the old result cannot publish an outcome or charge the new cycle

#### Scenario: Subagent activity invalidates a submitted inquiry
- **WHEN** genuine external subagent activity is observed after the private inquiry task was submitted
- **THEN** the inquiry is cancelled as before and its answer cannot publish
- **AND** exactly one status explains the external invalidation, even if further activity follows

#### Scenario: Private activity is not external invalidation
- **WHEN** the decision child starts generating or writes its result
- **THEN** that owned activity does not discard its own answer or open another decision

### Requirement: Assessment-first guidance preserves the existing result protocol
The fixed private inquiry guidance SHALL request a concise delivery assessment in the existing `reason_content` before `reason_type` and `action`, using only the designated JSON file. That assessment-first guidance by itself SHALL NOT add result properties, ordinary work permissions, a different decision model, or visible reasoning messages. The AI-unlock review SHALL be governed by the unlock-review capability and its own setting, not by the assessment wording. Both assessment-first and action-first valid objects SHALL remain accepted. The existing configured reason types, 500-code-point guidance target, 1000-code-point acceptance limit, unrelated-extra-field handling, ownership checks, and per-inquiry correction bounds SHALL remain unchanged. Shared `maxContinue` charging SHALL be governed by the accepted final effect, not property order, review count, or assessment wording. Property order, citations, and source identifiers SHALL NOT become new semantic acceptance gates. Accepted fields SHALL not undergo a main-model confirmation or rewrite.

#### Scenario: New guidance with an existing client
- **WHEN** a current private inquiry receives a valid action-first object in its result file
- **THEN** it is accepted under the unchanged value rules rather than rejected for property order
- **AND** the same decision in assessment-first order is also accepted

#### Scenario: Assessment is not a separate conversation turn
- **WHEN** the model follows assessment-first guidance
- **THEN** it writes one file result with a concise reason and verdict, without an extra acknowledgement model call or ordinary assistant checklist
- **AND** valid syntax is not reported as proof that the assessment is semantically correct

#### Scenario: Review remains a separate setting
- **WHEN** assessment-first guidance is used while unlock review is disabled
- **THEN** the guidance does not discover a reviewer, send a review request, or add a reconsideration inquiry

### Requirement: Unlock review retains callback candidates
When unlock review is enabled, a current initial valid `unlock`/`WAIT_CALLBACK` candidate SHALL remain eligible for the same pre-commit review as the other configured `unlock` reasons. Selecting a lock-retaining final effect SHALL NOT bypass that review. Existing support, incomplete-review fallback, definite challenge, at-most-one reconsideration, per-inquiry format bounds, and cancellation rules SHALL remain in force. No lock transition or budget charge SHALL occur merely for proposing or reviewing the candidate. The finally accepted result SHALL determine the effect: `continue` starts budgeted ordinary work, the callback pair commits budgeted suspension, and another valid unlock reason actually unlocks without a budget charge. The reviewer SHALL NOT supply new user authority or directly choose the final action.

#### Scenario: Review supports callback waiting
- **WHEN** review supports a still-current callback candidate
- **THEN** the final publication path commits one charged callback suspension, not an actual unlock

#### Scenario: Review is unavailable
- **WHEN** the existing incomplete-review fallback releases a still-current callback candidate
- **THEN** the candidate retains its original callback meaning and commits one suspension, without another model request merely because review failed

#### Scenario: Main model changes its verdict
- **WHEN** one permitted reconsideration replaces a callback candidate with a valid `JOB_DONE` unlock
- **THEN** the final effect unlocks without spending a callback unit or reviewing the replacement again

#### Scenario: Reconsidered callback remains bounded
- **WHEN** one permitted reconsideration returns the callback pair again
- **THEN** it commits only one suspension and one unit, without a second semantic review

#### Scenario: Cancelled review cannot suspend new work
- **WHEN** genuine user takeover, ordinary callback work, or another currentness change invalidates the candidate during review
- **THEN** its late response cannot suspend or charge the replacement work or publish the old outcome
