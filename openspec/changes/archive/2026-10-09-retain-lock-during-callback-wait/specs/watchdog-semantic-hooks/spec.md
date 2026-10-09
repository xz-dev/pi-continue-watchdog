## MODIFIED Requirements

### Requirement: Published hook set
The watchdog SHALL publish only these `pi:semantic-hook:v1` hooks:
- `watchdog-continued`, carrying normalized `REASON_TYPE` and trimmed `REASON`;
- `user-ready`, with `STOP_KIND` equal to `AI_UNLOCK`, `WAIT_CALLBACK`, `ERROR_UNLOCK`, `EXHAUSTED`, or `DECISION_FAILED`.

`AI_UNLOCK` and `WAIT_CALLBACK` SHALL additionally carry normalized `REASON_TYPE` and trimmed `REASON`; the other stop kinds SHALL carry no additional values. `WAIT_CALLBACK` SHALL mean a lock-retaining callback suspension, not an unlock, task completion, or required user intervention. Actual AI unlocks SHALL retain `AI_UNLOCK`. The retired `watchdog-waiting` hook and `WAIT_SECONDS` value SHALL NOT be emitted. Existing best-effort listener delivery and lack of consumer dependency SHALL remain unchanged. Hook payloads SHALL NOT themselves be inserted into model conversation.

#### Scenario: Consumer inventories hooks
- **WHEN** a cycle durably continues once and later accepts callback suspension
- **THEN** one reason-bearing `watchdog-continued` and one eligible `user-ready` with `STOP_KIND=WAIT_CALLBACK` can be emitted
- **AND** no `AI_UNLOCK`, separate waiting hook, or wait duration is emitted for the suspension

#### Scenario: Old wait submission
- **WHEN** an inquiry submits the retired wait action
- **THEN** it produces no callback or waiting hook, even if it includes a duration and reason

#### Scenario: Real completion remains an unlock signal
- **WHEN** a current `JOB_DONE` unlock is accepted and its publication qualifies
- **THEN** `user-ready` carries `STOP_KIND=AI_UNLOCK` and `REASON_TYPE=JOB_DONE`

### Requirement: Terminal signals retain aggregate-idle fencing
AI unlock, callback suspension, terminal-error unlock, exhaustion, and decision failure SHALL emit `user-ready` only while the exact outcome and main claim remain current and all existing local, child, process-domain, and stale-publication guards permit it. AI unlock and callback suspension SHALL require confirmation of their respective human-only status and finalized internal-exchange cleanup rather than a shared model-bound stopping message. Repeated settlement and publication observations SHALL NOT duplicate signals. A final-budget callback suspension SHALL emit only its eligible `WAIT_CALLBACK` signal while suspended; an `EXHAUSTED` signal SHALL become eligible only after resumed ordinary work successfully settles. A callback that resumes work before its waiting signal becomes eligible SHALL retire that old signal, not replay it afterward. No retired wait deadline SHALL defer exhaustion. Manual unlock, shortcuts, abort, ordinary unlocked idle, and stale or cancelled work SHALL remain silent.

#### Scenario: Callback unlock does not bypass native activity guards
- **WHEN** callback suspension is accepted but observable child work remains busy
- **THEN** no `user-ready` is emitted while that work is busy
- **AND** at most one `WAIT_CALLBACK` signal becomes eligible if that suspension is still current when aggregate idle qualifies

#### Scenario: Status publication cannot be confirmed
- **WHEN** the human-only stopping status or exchange cleanup is unconfirmed
- **THEN** no premature stopping hook is published and no model-bound fallback is created

#### Scenario: User takes over
- **WHEN** new user activity replaces a pending old outcome
- **THEN** its old stopping hook cannot be published for the new cycle

#### Scenario: Final waiting allowance is not immediate exhaustion
- **GIVEN** the accepted callback suspension has consumed the final `maxContinue` unit
- **WHEN** its status and cleanup are confirmed while that suspension is current and idle-qualified
- **THEN** only `STOP_KIND=WAIT_CALLBACK` is eligible
- **AND** `STOP_KIND=EXHAUSTED` can occur at most once after actual resumed work successfully settles, without another watchdog work turn

#### Scenario: Callback arrives before waiting notification
- **WHEN** ordinary callback work starts before the old waiting notification qualifies
- **THEN** that old notification is discarded rather than emitted as a delayed or duplicate callback-wait signal
