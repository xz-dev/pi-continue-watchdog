## Purpose

Routes a settled run to the right recovery behavior by its terminal outcome: successful runs keep the continue/wait/unlock decision, runs that ended in a final error unlock the watchdog automatically instead of pretending there is work to resume.

## Requirements

### Requirement: Terminal error settlement auto-unlocks

When the locked watchdog observes a true settlement whose settled run's final assistant message reports `stopReason: "error"` (Pi's automatic retries are exhausted), the watchdog SHALL automatically unlock and SHALL NOT start the inquiry fence or the continue/wait/unlock decision for that settlement. The auto-unlock SHALL produce a clear user-facing notification and a human-unlock-style record distinguishable from a manual unlock. The gate SHALL NOT match error text, error classes, or any string heuristic; only the tracked terminal `stopReason` decides.

#### Scenario: Final network error while locked

- **GIVEN** the watchdog is locked and a run ends with `stopReason: "error"` after Pi's retries are exhausted
- **WHEN** true settlement is observed
- **THEN** the watchdog unlocks automatically
- **AND** no inquiry fence or decision inquiry is started
- **AND** the user is notified that the watchdog unlocked because the run ended in an error

#### Scenario: Gate ignores error text

- **GIVEN** a settled run whose final assistant message has `stopReason: "stop"` but whose text mentions an error
- **WHEN** true settlement is observed
- **THEN** the normal decision stage runs and no auto-unlock occurs

### Requirement: Successful settlement keeps the decision stage

A true settlement whose terminal `stopReason` is not `"error"` SHALL enter the existing inquiry fence and continue/wait/unlock decision exactly as before. Abort-triggered settlement SHALL keep the existing immediate unlock path and SHALL NOT pass through this gate.

#### Scenario: Normal completion while locked

- **GIVEN** the watchdog is locked and a run settles with a non-error terminal `stopReason`
- **WHEN** the 10-second fence elapses with all children idle
- **THEN** exactly one recovery decision inquiry starts, unchanged from prior behavior

#### Scenario: Abort path unchanged

- **GIVEN** the watchdog is locked and the user aborts the run
- **WHEN** the abort outcome is observed
- **THEN** the existing immediate abort unlock applies
- **AND** the terminal-outcome gate is not consulted

### Requirement: Gate only at true settlement

The gate SHALL be evaluated only at the authoritative settled decision point with the plugin's existing stale/settlement guards. While Pi is automatically retrying, the run is busy and no settlement exists; the gate SHALL NOT unlock early during retries, waiting windows, or queued continuations. A settlement observation that is stale under existing guards SHALL NOT auto-unlock.

#### Scenario: During automatic retry

- **GIVEN** a run hit an error and Pi is automatically retrying
- **WHEN** the retry is still in flight
- **THEN** the watchdog remains locked and takes no unlock or decision action

#### Scenario: Stale settlement ignored

- **GIVEN** a new run started after an errored settlement was queued for processing
- **WHEN** the stale settlement observation is evaluated
- **THEN** no auto-unlock occurs

### Requirement: Contract updated before implementation

`docs/behavior-contract.md` SHALL be amended to the three-outcome matrix (success → decision; terminal error → auto unlock; abort → immediate unlock), including rule 8 and its acceptance criteria, before or together with the runtime change. Implementations SHALL NOT claim stop-reason-independent recovery after this change.

#### Scenario: Rule 8 reflects the matrix

- **GIVEN** the amended contract
- **WHEN** rule 8 and its acceptance criteria are read
- **THEN** they describe terminal-error auto-unlock, successful-settlement decision, and abort immediate unlock
- **AND** no remaining contract text requires recovery to be independent of terminal outcome
