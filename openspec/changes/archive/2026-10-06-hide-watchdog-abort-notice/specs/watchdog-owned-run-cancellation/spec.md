## ADDED Requirements

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
