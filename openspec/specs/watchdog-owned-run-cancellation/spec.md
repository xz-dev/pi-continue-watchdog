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

### Requirement: Native watchdog-owned aborts leave no finalized assistant abort notice

When Pi natively aborts a current main run precisely correlated to a watchdog decision, correction, or automated continuation, the extension SHALL suppress Pi's assistant-level abort notice in that run's finalized presentation, including the default `Operation aborted` presentation. A transient notice before message finalization and residual blank footer spacing are outside this guarantee and SHALL NOT require host modification. Recognition MUST depend on the actual aborted outcome and current owned-run correlation, not on a particular key sequence or matching error text. This requirement SHALL NOT hide tool-level cancellation results or non-abort errors.

#### Scenario: Native abort during an internal decision
- **GIVEN** the current run is a correlated watchdog decision or correction
- **WHEN** Pi aborts the run through its normal cancellation path
- **THEN** Pi's assistant abort notice is absent from that run's finalized presentation
- **AND** the existing internal-decision content hiding remains unchanged

#### Scenario: Native abort during automated continuation
- **GIVEN** the current run is a correlated automated continuation
- **WHEN** the user cancels it with Pi's existing Esc behavior
- **THEN** Pi's assistant abort notice is absent from that run's finalized presentation
- **AND** no new double-Esc gesture or alternative keybinding is required

### Requirement: Quiet native abort preserves cancellation and output behavior

Suppressing the notice SHALL preserve the real abort outcome used by the existing automatic-unlock lifecycle. The watchdog SHALL unlock with its existing normal notification and SHALL NOT open another inquiry or continuation because the notice was hidden. Suppression SHALL NOT request an additional abort, introduce an additional retry charge, remove additional assistant content or tool results, or alter queued-message handling. It MUST NOT reclassify the cancelled work as a successful completion for host or watchdog control purposes; the host-visible and stored `stopReason` MUST remain `aborted`. Suppression SHALL NOT trigger tool dispatch, queued steering/follow-up consumption, additional provider calls, or post-run compaction that the original abort would skip.

#### Scenario: Continuation output survives without the abort footer
- **GIVEN** an automated continuation has produced partial assistant text and tool results that the current native-abort path preserves
- **WHEN** Pi aborts that continuation
- **THEN** that text and those tool results remain as they would without notice suppression
- **AND** only the assistant abort notice is absent from the finalized presentation
- **AND** the watchdog unlocks with its normal automatic-unlock notification
- **AND** no replacement inquiry or model turn is started by the cancelled cycle

#### Scenario: Hidden decision abort still follows the abort gate
- **GIVEN** a watchdog decision has not submitted a valid verdict
- **WHEN** Pi aborts it and the assistant abort notice is suppressed
- **THEN** the existing abort unlock occurs
- **AND** the absence of a visible abort notice is not interpreted as a missing verdict requiring correction or retry

#### Scenario: A repeated terminal callback does not repeat the outcome
- **GIVEN** a native watchdog-owned abort has already been handled
- **WHEN** the finalized aborted `message_end` is repeated or another terminal callback for that same cancelled run arrives
- **THEN** notice suppression does not produce an additional unlock notification or affect a later cycle

### Requirement: Quiet abort presentation is limited to the exact owned run

The extension SHALL leave native abort presentation and behavior unchanged for ordinary user-started runs, runs that have lost watchdog ownership through user takeover, and uncorrelated or stale runs. Notice suppression for one run MUST NOT affect another run after a new run, ownership change, session replacement, reload, or shutdown. Successful outcomes and terminal error presentation SHALL retain their existing behavior.

#### Scenario: Ordinary user run remains unchanged
- **GIVEN** the current run was started by the user rather than watchdog automation
- **WHEN** the user aborts it
- **THEN** Pi's existing abort notice and the watchdog's existing abort handling remain unchanged

#### Scenario: User takeover revokes suppression eligibility
- **GIVEN** a continuation was initially watchdog-owned
- **AND** user input has taken over so the current work is no longer solely watchdog-owned
- **WHEN** the current work is aborted
- **THEN** the old continuation identity does not suppress its abort notice or remove its output

#### Scenario: Stale cancellation cannot hide a later abort
- **GIVEN** an owned abort was observed before a new run or ownership/session transition
- **WHEN** an ordinary run is later aborted
- **THEN** the previous abort's presentation state does not suppress the later run's notice or trigger an extra unlock

#### Scenario: Error text is not an abort signal
- **WHEN** a successful response mentions cancellation, or a run ends in an actual error rather than an abort
- **THEN** quiet-abort handling does not change that outcome or its presentation

### Requirement: Manual unlock and existing controls remain unchanged

The new native-abort presentation behavior SHALL NOT change Esc dispatch, Pi's double-Esc action, the configured unlock shortcut, or `/unlock-continue-watchdog`. Manual unlock SHALL retain the existing ownership-aware cancellation and full owned-residue cleanup requirements, even though native abort only gains notice suppression.

#### Scenario: Alt+U retains existing manual cleanup
- **GIVEN** a correlated watchdog-owned run is active and the configured unlock shortcut is Alt+U
- **WHEN** the user presses Alt+U
- **THEN** the existing manual unlock, owned-run cancellation, residue cleanup, and notification behavior remains unchanged
- **AND** the native-abort presentation path does not introduce a second unlock notification
