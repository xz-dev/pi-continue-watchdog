# terminal-outcome-gate Specification

## Purpose

Routes successful settlements into guarded continue-or-unlock inquiries, terminal errors into automatic unlock, and human aborts into immediate unlock while preserving current-ownership and aggregate-idle safeguards.

## Requirements

### Requirement: Terminal error settlement auto-unlocks
A locked watchdog observing authoritative settlement with the tracked final `stopReason: "error"` after Pi retries are exhausted SHALL unlock automatically without opening an idle fence, inquiry, or ordinary continuation for that settlement. Its existing user notification and human-unlock-style error record SHALL remain distinguishable from manual unlock. Error text, classes, and string heuristics SHALL not decide this gate.

#### Scenario: Final network error while locked
- **WHEN** a locked run truly settles with terminal `stopReason: "error"` after host retries
- **THEN** it unlocks with the existing error notification and record
- **AND** no decision inquiry or continuation starts

#### Scenario: Gate ignores error text
- **WHEN** a settled run reports `stopReason: "stop"` but mentions an error in its text
- **THEN** normal guarded decision eligibility applies rather than error auto-unlock

### Requirement: Successful settlement keeps the decision stage
A successful eligible ordinary settlement SHALL retain the fixed idle fence and guarded internal inquiry, whose accepted outcomes SHALL now be only continue or unlock. A decision's own settlement SHALL not recursively open another inquiry. Accepted continuation SHALL be followed by ordinary work; accepted unlock SHALL stop automatic work without a scheduled wake-up. Abort SHALL retain its immediate unlock path. Exhausted or decision-failed cycles SHALL start no new inquiry.

#### Scenario: Normal completion while locked
- **WHEN** ordinary work settles successfully while locked and the 10-second aggregate-idle fence qualifies with budget remaining
- **THEN** one internal inquiry opens rather than direct ordinary continuation

#### Scenario: Unlock settles
- **WHEN** the internal inquiry accepts unlock and settles
- **THEN** it publishes only its current human-only outcome and no recursive inquiry, work turn, or watchdog wake timer

#### Scenario: Abort path unchanged
- **WHEN** the user aborts a locked run
- **THEN** the existing immediate abort unlock path applies without an inquiry

### Requirement: Gate only at true settlement

The gate SHALL be evaluated only at the authoritative settled decision point with the plugin's existing stale/settlement guards. While Pi is automatically retrying, the run is busy and no settlement exists; the gate SHALL NOT unlock early during host retries or queued continuations. A settlement observation that is stale under existing guards SHALL NOT auto-unlock.

#### Scenario: During automatic retry

- **GIVEN** a run hit an error and Pi is automatically retrying
- **WHEN** the retry is still in flight
- **THEN** the watchdog remains locked and takes no unlock or decision action
- **AND** provider failures do not consume correction or continuation attempts and do not append `Other error` status entries
- **AND** Pi retains the original error for native retry handling

#### Scenario: Decision request recovers or exhausts native retries

- **GIVEN** a consumed decision inquiry encounters repeated provider failures
- **WHEN** a native retry succeeds
- **THEN** its result is handled in the same decision attempt without charging the failures
- **WHEN** native retries instead exhaust and the run authoritatively settles in error
- **THEN** the existing terminal-error unlock occurs once without a correction request, continuation, or added loop

#### Scenario: Stale settlement ignored

- **GIVEN** a new run started after an errored settlement was queued for processing
- **WHEN** the stale settlement observation is evaluated
- **THEN** no auto-unlock occurs

### Requirement: Contract updated before implementation
The implementation's behavior documentation and affected executable process models SHALL describe the settlement matrix before or together with their corresponding runtime slice: success enters a guarded continue-or-unlock inquiry; terminal error auto-unlocks; abort immediately unlocks. They SHALL describe continuation-only retry accounting and native callback waiting without timed watchdog waits. They SHALL not require proactive ordinary-turn control calls or claim that UI hiding proves context isolation. These shipped-behavior documents SHALL be updated during implementation, not represented as already changed by a proposal alone.

#### Scenario: Rule 8 reflects the matrix
- **WHEN** the corresponding implementation slice is ready for review
- **THEN** rule 8, acceptance examples, and affected process-model claims agree with the two-outcome lifecycle
- **AND** their verification reports distinguish actual source behavior, formal assumptions, and observed host-request evidence
