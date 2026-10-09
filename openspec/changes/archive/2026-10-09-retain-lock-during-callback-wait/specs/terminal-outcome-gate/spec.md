## MODIFIED Requirements

### Requirement: Successful settlement keeps the decision stage
A successful eligible ordinary settlement SHALL retain the fixed idle fence and guarded internal inquiry. Its two wire actions SHALL remain `continue` and `unlock`; the validated `unlock`/`WAIT_CALLBACK` pair SHALL have a distinct callback-suspension effect. A decision's own settlement SHALL NOT recursively open another inquiry. Accepted continuation SHALL be followed by ordinary work; actual unlock SHALL stop automatic work without a scheduled wake-up; accepted callback suspension SHALL retain the lock and stop automatic inquiry/work until ordinary main work actually resumes. Abort SHALL retain its immediate unlock path. Suspended, exhausted, or decision-failed cycles SHALL start no new inquiry. Consuming the final `maxContinue` unit with callback suspension SHALL NOT prevent the external callback from starting ordinary work and SHALL NOT produce exhaustion until that work successfully settles under current guards.

#### Scenario: Normal completion while locked
- **WHEN** ordinary work settles successfully while locked, not suspended, and the 10-second aggregate-idle fence qualifies with budget remaining
- **THEN** one internal inquiry opens rather than direct ordinary continuation

#### Scenario: Unlock settles
- **WHEN** the internal inquiry accepts an actual unlock and settles
- **THEN** it publishes only its current human-only outcome and no recursive inquiry, work turn, or watchdog wake timer

#### Scenario: Abort path unchanged
- **WHEN** the user aborts a locked run
- **THEN** the existing immediate abort unlock path applies without an inquiry

#### Scenario: Callback decision settles
- **WHEN** the internal inquiry accepts callback suspension and settles
- **THEN** the lock and consumed budget are retained, with no recursive inquiry or ordinary work turn

#### Scenario: Final callback work settles successfully
- **GIVEN** the final allowed unit was spent on callback suspension
- **WHEN** actual resumed ordinary work successfully settles and normal publication checks qualify
- **THEN** exhaustion can be published without another decision inquiry

#### Scenario: Terminal error during resumed work
- **WHEN** actual resumed callback work authoritatively settles in terminal error
- **THEN** the existing error auto-unlock path applies rather than successful-settlement exhaustion or another inquiry

### Requirement: Contract updated before implementation
The implementation's behavior documentation and affected executable process models SHALL describe the settlement matrix before or together with their corresponding runtime slice: successful eligible work enters a guarded two-action inquiry; actual unlock releases the lock; the compatible callback pair suspends while retaining it; terminal error auto-unlocks; abort immediately unlocks. They SHALL describe the plugin-specific `maxContinue` default of ten, removal of `maxRetries`, shared continuation/callback accounting, and final-wait exhaustion only after actual resumed work settles. They SHALL retain event-driven callback waiting without timed watchdog waits, and SHALL NOT require proactive ordinary-turn control calls or claim that UI hiding proves context isolation. These shipped-behavior documents SHALL be updated during implementation, not represented as already changed by a proposal alone.

#### Scenario: Rule 8 reflects the matrix
- **WHEN** the corresponding implementation slice is ready for review
- **THEN** rule 8, acceptance examples, and affected process-model claims agree with the two-action, three-effect lifecycle and shared plugin budget
- **AND** their verification reports distinguish actual source behavior, formal assumptions, and observed host-request evidence
