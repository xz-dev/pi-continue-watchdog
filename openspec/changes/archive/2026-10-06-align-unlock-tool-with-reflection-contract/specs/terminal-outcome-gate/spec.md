## MODIFIED Requirements

### Requirement: Terminal error settlement auto-unlocks
When the locked watchdog observes a true settlement whose settled run's final assistant message reports `stopReason: "error"` after Pi's automatic retries are exhausted, it SHALL automatically unlock and SHALL NOT start an idle fence, decision inquiry, or automatic continuation for that settlement. The auto-unlock SHALL produce a clear user-facing notification and a human-unlock-style record distinguishable from manual unlock. Only the tracked terminal `stopReason` SHALL decide; error text, classes, or string heuristics SHALL NOT trigger this gate.

#### Scenario: Final network error while locked
- **GIVEN** a locked run ends with `stopReason: "error"` after Pi's retries are exhausted
- **WHEN** true settlement is observed
- **THEN** the watchdog unlocks automatically with a user notification stating the run ended in error
- **AND** no idle fence, decision inquiry, or ordinary continuation starts

#### Scenario: Gate ignores error text
- **GIVEN** a settled run has `stopReason: "stop"` but its text mentions an error
- **WHEN** true settlement is observed
- **THEN** normal inquiry eligibility applies and no error auto-unlock occurs

### Requirement: Successful settlement keeps the decision stage
A true ordinary settlement whose terminal `stopReason` is not `"error"` SHALL enter the existing idle fence and then the watchdog-owned decision stage while still locked and eligible. A resolved decision's own settlement SHALL NOT recursively open another inquiry; its accepted outcome controls what follows. Abort-triggered settlement SHALL keep the existing immediate unlock path and SHALL NOT pass through this gate.

#### Scenario: Normal completion while locked
- **GIVEN** a locked ordinary run settles with a non-error terminal `stopReason`
- **WHEN** the 10-second fence elapses with all observable children and the process domain idle
- **THEN** exactly one decision inquiry opens, or exhaustion is reached when no attempts remain
- **AND** no direct continuation or jev request precedes the decision

#### Scenario: Abort path unchanged
- **GIVEN** the watchdog is locked and the user aborts the run
- **WHEN** the abort outcome is observed
- **THEN** existing immediate abort unlock applies without consulting the terminal-outcome gate

#### Scenario: Decision settles after an accepted wait
- **WHEN** the decision run settles after accepting a current wait
- **THEN** it does not open a second inquiry or ordinary work turn before the accepted wait becomes eligible

### Requirement: Contract updated before implementation
`docs/behavior-contract.md` SHALL describe the three-outcome settlement matrix before or together with runtime changes: success enters the qualified continue/wait/unlock inquiry; terminal error unlocks automatically; abort unlocks immediately. Rule 8 and its acceptance criteria SHALL describe the decision function's phase gate and SHALL NOT require stop-reason-independent recovery or ordinary-turn proactive unlocking.

#### Scenario: Rule 8 reflects the matrix
- **WHEN** rule 8 and its acceptance criteria are read
- **THEN** they describe successful-settlement inquiry, terminal-error auto-unlock, and abort immediate unlock
- **AND** they do not claim that successful settlement always directly continues
