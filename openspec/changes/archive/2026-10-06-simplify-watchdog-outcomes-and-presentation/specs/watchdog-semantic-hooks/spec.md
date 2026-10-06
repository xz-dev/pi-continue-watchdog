## MODIFIED Requirements

### Requirement: Published hook set
The watchdog SHALL publish only these `pi:semantic-hook:v1` hooks:
- `watchdog-continued`, carrying normalized `REASON_TYPE` and trimmed `REASON`;
- `user-ready`, with `STOP_KIND` equal to `AI_UNLOCK`, `ERROR_UNLOCK`, `EXHAUSTED`, or `DECISION_FAILED`.

`AI_UNLOCK` SHALL additionally carry normalized `REASON_TYPE` and trimmed `REASON`; other stop kinds SHALL carry no additional values. The retired `watchdog-waiting` hook and `WAIT_SECONDS` value SHALL not be emitted. Existing best-effort listener delivery and lack of consumer dependency SHALL remain unchanged. Hook payloads SHALL not themselves be inserted into model conversation.

#### Scenario: Consumer inventories hooks
- **WHEN** a cycle durably continues once and later accepts `WAIT_CALLBACK` unlock
- **THEN** one reason-bearing `watchdog-continued` and one eligible typed `user-ready` can be emitted
- **AND** no waiting hook or wait duration is emitted

#### Scenario: Old wait submission
- **WHEN** an inquiry submits the retired wait action
- **THEN** it produces no waiting hook, even if it includes a duration and reason

### Requirement: Simple continuation signal
Exactly one `watchdog-continued` hook SHALL follow durable publication of each current accepted continuation. Its values SHALL be the accepted normalized reason type and trimmed next-action reason without a retry count or separately generated explanation. Inquiry dispatch, correction, failed publication, stale ownership, and unlock status SHALL emit no continuation hook.

#### Scenario: Continuation published
- **WHEN** the accepted next-action event is durably published for the current main claim
- **THEN** one hook carries its accepted type and reason

#### Scenario: Continuation not published
- **WHEN** publication fails or current ownership is lost
- **THEN** no continuation hook is emitted

## ADDED Requirements

### Requirement: Terminal signals retain aggregate-idle fencing
AI unlock, terminal-error unlock, exhaustion, and decision failure SHALL emit `user-ready` only while that terminal state and main claim remain current and all existing local, child, process-domain, and stale-publication guards permit it. An AI unlock SHALL require confirmation of its human-only status and finalized internal-exchange cleanup rather than a shared model-bound unlock message. Repeated settlement SHALL not duplicate signals. No retired wait deadline SHALL defer exhaustion. Manual unlock, shortcuts, abort, ordinary unlocked idle, and stale or cancelled work SHALL remain silent.

#### Scenario: Callback unlock does not bypass native activity guards
- **WHEN** a callback unlock is accepted but observable child work remains busy
- **THEN** no `user-ready` is emitted while that work is busy
- **AND** at most one signal becomes eligible if the terminal state is still current when aggregate idle qualifies

#### Scenario: Status publication cannot be confirmed
- **WHEN** the human-only AI-unlock status or exchange cleanup is unconfirmed
- **THEN** no premature terminal hook is published and no model-bound fallback is created

#### Scenario: User takes over
- **WHEN** new user activity replaces a pending terminal cycle
- **THEN** its old terminal hook cannot be published for the new cycle
