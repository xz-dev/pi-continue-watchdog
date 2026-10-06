# watchdog-owned-run-cancellation Specification

## Purpose

Defines how a human unlock immediately stops a currently running watchdog-owned decision or continuation while preserving an uncorrelated current user run and removing cancellation residue.

## Requirements

### Requirement: Manual unlock cancels only the current watchdog-owned run
When a human invokes `/unlock-continue-watchdog` or the configured unlock shortcut while the current main run is precisely correlated to a watchdog decision, correction, or automated continuation, the system SHALL unlock and abort that run. It MUST NOT abort an ordinary user-started or uncorrelated run. Unlock SHALL immediately revoke queued and active result-submission authorization; later calls, tool results, or settlement callbacks from that cancelled exchange SHALL NOT restart it or affect a later cycle.

#### Scenario: Decision run is cancelled
- **GIVEN** a watchdog decision run is active and correlated to its exchange
- **WHEN** the human invokes manual unlock
- **THEN** the watchdog unlocks and aborts that decision with no replacement model turn
- **AND** its result function can no longer submit a verdict

#### Scenario: Automated continuation is cancelled
- **GIVEN** an automated continuation run is active and correlated to its accepted continue exchange
- **WHEN** the human invokes manual unlock
- **THEN** the watchdog unlocks and aborts that continuation with no replacement model turn

#### Scenario: Ordinary user run is preserved
- **GIVEN** the current run was started directly by user work and is not correlated to a watchdog decision or continuation
- **WHEN** the human invokes manual unlock
- **THEN** normal manual-unlock behavior applies without aborting that run

#### Scenario: Queued correction is cancelled
- **WHEN** the human unlocks before a queued correction prompt is consumed
- **THEN** it grants no submission authority and cannot cause a late verdict, retry charge, or replacement turn

#### Scenario: Late result after cancellation
- **WHEN** a cancelled decision's function result arrives after an ordinary user run has started
- **THEN** it cannot unlock, abort, clean up, or charge attempts to the later run

### Requirement: Cancellation removes watchdog-owned abort residue

After manual unlock aborts a watchdog-owned run, the system SHALL remove that run's partial assistant output and abort presentation from the visible transcript and future model-bound context. Cleanup MUST use the exact owned-run correlation and MUST NOT remove unrelated messages or entries. Cleanup SHALL NOT invoke the model.

#### Scenario: Partial decision output leaves no residue
- **GIVEN** a correlated watchdog decision has streamed partial assistant output
- **WHEN** manual unlock aborts that decision
- **THEN** the partial assistant content is absent from the settled transcript
- **AND** `Operation aborted` is not shown for that internal run
- **AND** the partial content is absent from later model-bound context

#### Scenario: Partial continuation output leaves no residue
- **GIVEN** a correlated automated continuation has streamed partial assistant output
- **WHEN** manual unlock aborts that continuation
- **THEN** the partial assistant content is absent from the settled transcript
- **AND** `Operation aborted` is not shown for that internal run
- **AND** the partial content is absent from later model-bound context

#### Scenario: Unrelated entries are preserved
- **GIVEN** other plugin or user entries appear near the cancelled watchdog-owned run
- **WHEN** cancellation cleanup completes
- **THEN** only entries proven to belong to the exact watchdog-owned run are eligible for removal
- **AND** unrelated entries remain unchanged

### Requirement: Unlock remains terminal for the cancelled watchdog cycle

Manual cancellation SHALL leave the watchdog unlocked, SHALL suppress abort-outcome handling for that exact internal run, and SHALL NOT let the abort lifecycle produce another unlock notification or re-arm the cancelled cycle. Each explicit human unlock invocation retains its normal command or shortcut output semantics.

#### Scenario: Abort settle does not unlock twice
- **GIVEN** manual unlock has aborted a watchdog-owned run
- **WHEN** that run reaches its aborted terminal lifecycle
- **THEN** the abort is consumed as internal cancellation
- **AND** no additional abort-driven unlock notification is emitted
- **AND** the watchdog remains unlocked

#### Scenario: Repeated unlock does not retarget a later run
- **GIVEN** cancellation of a watchdog-owned run is already pending or complete
- **WHEN** manual unlock is invoked again or a later ordinary run starts
- **THEN** the old cancellation identity is not reused to abort or clean the later run
- **AND** each explicit unlock still produces only its normal manual-unlock output

### Requirement: Queued-message behavior remains host-owned

Manual cancellation SHALL NOT inspect, copy, replay, or clear Pi's private steering or follow-up queues. The extension MUST NOT promise delivery, preservation, or automatic resumption of messages that Pi itself consumes or discards as part of abort processing.

#### Scenario: Cancellation does not implement a private queue replay
- **GIVEN** Pi has queued input while a watchdog-owned run is active
- **WHEN** manual unlock cancels that run
- **THEN** the extension performs no private queue access or message re-send
- **AND** any later queued-message behavior follows Pi's public abort semantics

### Requirement: Cancellation has bounded side-effect guarantees

The system SHALL request cancellation through public Pi extension APIs and SHALL stop further watchdog-owned agent progress once cancellation is observed. The system MUST NOT claim to roll back already completed tool side effects or to terminate detached or background work that no longer obeys the active run's cancellation signal.

#### Scenario: Completed side effect is not represented as rolled back
- **GIVEN** a watchdog-owned run completed a tool side effect before manual cancellation
- **WHEN** cancellation settles
- **THEN** the watchdog does not claim that completed side effect was reverted
- **AND** transcript cleanup remains limited to watchdog-owned cancellation residue
