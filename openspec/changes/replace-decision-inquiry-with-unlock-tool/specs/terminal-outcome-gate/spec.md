## MODIFIED Requirements

### Requirement: Terminal error settlement auto-unlocks

When the locked watchdog observes a true settlement whose settled run's final assistant message reports `stopReason: "error"` (Pi's automatic retries are exhausted), the watchdog SHALL automatically unlock and SHALL NOT start the idle fence or an automatic continuation for that settlement. The auto-unlock SHALL produce a clear user-facing notification and a human-unlock-style record distinguishable from a manual unlock. The gate SHALL NOT match error text, error classes, or any string heuristic; only the tracked terminal `stopReason` decides.

#### Scenario: Final network error while locked

- **GIVEN** the watchdog is locked and a run ends with `stopReason: "error"` after Pi's retries are exhausted
- **WHEN** true settlement is observed
- **THEN** the watchdog unlocks automatically
- **AND** no idle fence or automatic continuation is started
- **AND** the user is notified that the watchdog unlocked because the run ended in an error

#### Scenario: Gate ignores error text

- **GIVEN** a settled run whose final assistant message has `stopReason: "stop"` but whose text mentions an error
- **WHEN** true settlement is observed
- **THEN** the normal automatic continuation stage runs and no auto-unlock occurs

### Requirement: Successful settlement keeps the decision stage

A true settlement whose terminal `stopReason` is not `"error"` SHALL enter the existing idle fence and then the automatic continuation stage when the watchdog is still locked. Abort-triggered settlement SHALL keep the existing immediate unlock path and SHALL NOT pass through this gate.

#### Scenario: Normal completion while locked

- **GIVEN** the watchdog is locked and a run settles with a non-error terminal `stopReason`
- **WHEN** the 10-second fence elapses with all children idle
- **THEN** exactly one automatic continuation is published, or exhaustion is reached when no attempts remain

#### Scenario: Abort path unchanged

- **GIVEN** the watchdog is locked and the user aborts the run
- **WHEN** the abort outcome is observed
- **THEN** the existing immediate abort unlock applies
- **AND** the terminal-outcome gate is not consulted

### Requirement: Contract updated before implementation

`docs/behavior-contract.md` SHALL be amended to the three-outcome matrix before or together with the runtime change:
- success leads to automatic continuation unless the agent unlocked through the tool;
- terminal error leads to automatic unlock;
- abort leads to immediate unlock.

The amendment SHALL cover rule 8 and its acceptance criteria. Implementations SHALL NOT claim stop-reason-independent recovery.

#### Scenario: Rule 8 reflects the matrix

- **GIVEN** the amended contract
- **WHEN** rule 8 and its acceptance criteria are read
- **THEN** they describe terminal-error auto-unlock, successful-settlement automatic continuation, and abort immediate unlock
- **AND** no remaining contract text references a decision inquiry
