# watchdog-owned-run-cancellation Specification

## Purpose

Defines how a human unlock immediately stops a currently running watchdog-owned decision or continuation while preserving an uncorrelated current user run and removing cancellation residue.

## Requirements

### Requirement: Manual unlock cancels only the current watchdog-owned run
When a human invokes `/unlock-continue-watchdog` or the configured unlock shortcut while an exact owned private decision/correction is pending, the system SHALL unlock, revoke its file-result authority immediately, and cancel that child through its owned control handle. If the current main run is precisely correlated to an automated continuation, the system SHALL retain the existing unlock-and-abort behavior for that main run. It MUST NOT abort an ordinary user-started or uncorrelated main run merely to stop the private child. Later writes, results, tool completions, review callbacks, or settlement callbacks from the cancelled operation SHALL NOT restart it or affect a later cycle.

#### Scenario: Decision run is cancelled
- **GIVEN** a private watchdog decision is active and correlated to its logical decision
- **WHEN** the human invokes manual unlock
- **THEN** the watchdog unlocks and cancels that child with no replacement model turn
- **AND** its file can no longer submit a verdict

#### Scenario: Automated continuation is cancelled
- **GIVEN** an automated main-session continuation is active and correlated to its accepted continue exchange
- **WHEN** the human invokes manual unlock
- **THEN** the watchdog unlocks and aborts that continuation with no replacement model turn

#### Scenario: Ordinary user run is preserved
- **GIVEN** the current main run was started directly by user work and is not correlated to a watchdog continuation
- **WHEN** the human invokes manual unlock while an old private child is still settling
- **THEN** normal manual-unlock behavior applies without aborting that main run
- **AND** cancellation remains targeted at the old child

#### Scenario: Queued correction is cancelled
- **WHEN** the human unlocks before the private runner starts an authorized correction
- **THEN** that correction is not submitted and cannot cause a late verdict, invalid-response charge, or replacement turn

#### Scenario: Late result after cancellation
- **WHEN** a cancelled child's valid file becomes readable after an ordinary user run has started
- **THEN** it cannot unlock, abort, clean up, or charge attempts to the later run

### Requirement: Cancellation removes watchdog-owned abort residue
After cancellation of a private decision, the system SHALL keep its partial output, internal tool results, correction messages, and abort presentation out of the main visible transcript and future main model-bound context. These records SHALL remain private from the start rather than being inserted into the main session for later removal. After manual unlock aborts a main-session watchdog-owned continuation, the existing exact-owned-run residue cleanup SHALL remain in effect. Cleanup MUST NOT remove unrelated messages or entries and SHALL NOT invoke the model. Legacy internal records SHALL remain eligible only for their existing read-only projections.

#### Scenario: Partial decision output leaves no residue
- **GIVEN** a private decision has generated partial output or started writing its result
- **WHEN** manual unlock cancels it
- **THEN** its partial content and assistant abort notice are absent from the main transcript and later main requests
- **AND** no main cleanup model turn is sent

#### Scenario: Partial continuation output leaves no residue
- **GIVEN** a correlated main-session automated continuation has streamed partial assistant output
- **WHEN** manual unlock aborts that continuation
- **THEN** its existing full owned-residue cleanup removes the partial assistant and abort presentation
- **AND** the partial content is absent from later model-bound context

#### Scenario: Unrelated entries are preserved
- **GIVEN** other plugin or user entries appear while a private child is pending or near a cancelled continuation
- **WHEN** cancellation cleanup completes
- **THEN** only entries proven to belong to the exact owned continuation are eligible for main-session removal
- **AND** unrelated entries remain unchanged

### Requirement: Unlock remains terminal for the cancelled watchdog cycle
Manual cancellation SHALL leave the watchdog unlocked, suppress abort-outcome handling for that exact internal operation, and SHALL NOT let child or main abort lifecycle callbacks produce another unlock notification or rearm the cancelled cycle. Each explicit human unlock invocation SHALL retain its normal command or shortcut output semantics. Cancellation SHALL revoke the operation's retry, reconsideration, result-file, and publication authority before awaiting child shutdown.

#### Scenario: Abort settle does not unlock twice
- **GIVEN** manual unlock has cancelled a private child or aborted an owned main continuation
- **WHEN** that exact operation reaches its aborted terminal lifecycle
- **THEN** the abort is consumed as internal cancellation
- **AND** no additional abort-driven unlock notification is emitted and the watchdog remains unlocked

#### Scenario: Repeated unlock does not retarget a later run
- **GIVEN** cancellation of a watchdog-owned operation is already pending or complete
- **WHEN** manual unlock is invoked again or a later ordinary run starts
- **THEN** the old identity or result-file path is not reused to abort or clean the later run
- **AND** each explicit unlock still produces only its normal manual-unlock output

### Requirement: Queued-message behavior remains host-owned

Manual cancellation SHALL NOT inspect, copy, replay, or clear Pi's private steering or follow-up queues. The extension MUST NOT promise delivery, preservation, or automatic resumption of messages that Pi itself consumes or discards as part of abort processing.

#### Scenario: Cancellation does not implement a private queue replay
- **GIVEN** Pi has queued input while a watchdog-owned run is active
- **WHEN** manual unlock cancels that run
- **THEN** the extension performs no private queue access or message re-send
- **AND** any later queued-message behavior follows Pi's public abort semantics

### Requirement: Cancellation has bounded side-effect guarantees
The system SHALL request cancellation through public Pi session/extension controls and the exact private child's owned handle. It SHALL stop further watchdog-owned progress once cancellation is observed. It MUST NOT claim to roll back completed tool side effects or terminate detached/background work that no longer obeys its cancellation signal. A cancelled child's admitted file write SHALL be drained or permanently quarantined from later attempts before its result path is reused or cleaned; result authority SHALL already be revoked during that wait.

#### Scenario: Completed side effect is not represented as rolled back
- **GIVEN** an owned main continuation completed a tool side effect before manual cancellation
- **WHEN** cancellation settles
- **THEN** the watchdog does not claim that completed side effect was reverted
- **AND** transcript cleanup remains limited to watchdog-owned cancellation residue

#### Scenario: A result write settles after cancellation
- **WHEN** a cancelled private child's already-started write completes late
- **THEN** the write cannot supply a decision to a later attempt or cycle
- **AND** cleanup does not race with a new authorized writer using that path

### Requirement: Native watchdog-owned aborts leave no finalized assistant abort notice
When Pi natively aborts an exact owned main continuation, the extension SHALL suppress the assistant-level abort notice in that run's finalized presentation, including the default `Operation aborted` presentation. A private decision/correction's assistant abort presentation SHALL never be projected into the main transcript. A native foreground cancellation delivered to the exact private operation SHALL cancel that child rather than an unrelated main run. A transient host notice before finalization and residual blank footer spacing remain outside the guarantee and SHALL NOT require host modification. Recognition MUST depend on the actual aborted outcome and current owned identity, not on a particular key sequence or matching error text. This requirement SHALL NOT hide ordinary tool-level cancellation results or non-abort errors.

#### Scenario: Native abort during an internal decision
- **GIVEN** native foreground cancellation is directed to the current private decision or correction
- **WHEN** that child aborts
- **THEN** its assistant abort notice and partial internal output remain absent from the main presentation
- **AND** the cancellation does not call abort on an unrelated main run

#### Scenario: Native abort during automated continuation
- **GIVEN** the current main run is a correlated watchdog continuation
- **WHEN** the user cancels it with Pi's existing Esc behavior
- **THEN** Pi's assistant abort notice is absent from that run's finalized presentation
- **AND** no new double-Esc gesture or alternative keybinding is required

### Requirement: Quiet native abort preserves cancellation and output behavior
Notice suppression SHALL preserve the actual aborted outcome and its existing cause-specific control behavior. An intentional native human abort of owned watchdog work SHALL retain its normal unlock behavior; cancellation due to user takeover, external work, or lifecycle replacement SHALL follow that cause's existing invalidation behavior rather than impersonating an ordinary main abort. The watchdog SHALL NOT open another inquiry or continuation because a private abort notice was hidden. Suppression SHALL NOT request an additional abort, introduce a retry charge, remove additional continuation content or tool results, or alter queued-message handling. It MUST NOT reclassify cancelled work as successful; host-visible and stored `stopReason` SHALL remain `aborted` where the host records that outcome. Suppression SHALL NOT trigger tool dispatch, queued input consumption, additional provider calls, or post-run compaction that the original abort would skip.

#### Scenario: Continuation output survives without the abort footer
- **GIVEN** an automated main continuation has produced partial assistant text and tool results that the current native-abort path preserves
- **WHEN** Pi aborts that continuation
- **THEN** that text and those tool results remain as they would without notice suppression
- **AND** only the assistant abort notice is absent, the normal unlock notification is retained, and no replacement turn is started

#### Scenario: Hidden decision abort still follows the abort gate
- **GIVEN** a private decision has not produced a valid file result
- **WHEN** an intentional native human abort cancels it
- **THEN** normal human-abort unlock behavior occurs without another response attempt
- **AND** the hidden output is not interpreted as a missing result requiring correction

#### Scenario: A repeated terminal callback does not repeat the outcome
- **GIVEN** an owned abort has already been handled
- **WHEN** that same cancelled operation reports another terminal callback
- **THEN** no additional unlock notification is produced and no later cycle is affected

### Requirement: Quiet abort presentation is limited to the exact owned run
The extension SHALL leave native abort presentation and behavior unchanged for ordinary user-started main runs, continuations that have lost ownership through user takeover, and uncorrelated or stale main runs. Private-child suppression SHALL not grant ownership over a main run. Notice suppression for one operation MUST NOT affect another after a new run, ownership change, session replacement, reload, or shutdown. Successful outcomes and terminal error presentation SHALL retain their existing behavior.

#### Scenario: Ordinary user run remains unchanged
- **GIVEN** the current main run was started by the user rather than watchdog automation
- **WHEN** the user aborts it
- **THEN** Pi's existing abort notice and the watchdog's existing abort handling remain unchanged

#### Scenario: User takeover revokes suppression eligibility
- **GIVEN** a main continuation was initially watchdog-owned
- **AND** user input has taken over so the current work is no longer solely watchdog-owned
- **WHEN** that main work is aborted
- **THEN** its old continuation identity does not suppress its abort notice or remove its output

#### Scenario: Stale cancellation cannot hide a later abort
- **GIVEN** a private decision or owned continuation was cancelled before a new run or ownership/session transition
- **WHEN** an ordinary main run is later aborted
- **THEN** the earlier cancellation state does not suppress the later notice or trigger an extra unlock

#### Scenario: Error text is not an abort signal
- **WHEN** a successful response mentions cancellation, or an operation ends in an actual error rather than an abort
- **THEN** quiet-abort handling does not change that outcome or its presentation

### Requirement: Manual unlock and existing controls remain unchanged

The new native-abort presentation behavior SHALL NOT change Esc dispatch, Pi's double-Esc action, the configured unlock shortcut, or `/unlock-continue-watchdog`. Manual unlock SHALL retain the existing ownership-aware cancellation and full owned-residue cleanup requirements, even though native abort only gains notice suppression.

#### Scenario: Alt+U retains existing manual cleanup
- **GIVEN** a correlated watchdog-owned run is active and the configured unlock shortcut is Alt+U
- **WHEN** the user presses Alt+U
- **THEN** the existing manual unlock, owned-run cancellation, residue cleanup, and notification behavior remains unchanged
- **AND** the native-abort presentation path does not introduce a second unlock notification
