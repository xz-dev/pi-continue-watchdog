## MODIFIED Requirements

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

### Requirement: Contract updated before implementation
The implementation's behavior documentation and affected executable process models SHALL describe the settlement matrix before or together with their corresponding runtime slice: success enters a guarded continue-or-unlock inquiry; terminal error auto-unlocks; abort immediately unlocks. They SHALL describe continuation-only retry accounting and native callback waiting without timed watchdog waits. They SHALL not require proactive ordinary-turn control calls or claim that UI hiding proves context isolation. These shipped-behavior documents SHALL be updated during implementation, not represented as already changed by a proposal alone.

#### Scenario: Rule 8 reflects the matrix
- **WHEN** the corresponding implementation slice is ready for review
- **THEN** rule 8, acceptance examples, and affected process-model claims agree with the two-outcome lifecycle
- **AND** their verification reports distinguish actual source behavior, formal assumptions, and observed host-request evidence
