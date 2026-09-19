## ADDED Requirements

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
