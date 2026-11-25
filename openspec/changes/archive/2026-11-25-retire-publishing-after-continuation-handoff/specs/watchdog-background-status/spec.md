## MODIFIED Requirements

### Requirement: Highlight means owned background work
Each row SHALL use the same theme-aware active foreground/background semantics while its own background operation is pending, including preparation, review and cancellation drain. A non-active row SHALL return to its existing muted presentation. Ordinary root/subagent activity, enabled state, cooldown and a pending manual request SHALL NOT alone activate the private-operation highlight. An explicit stage label SHALL accompany the color so the indication remains understandable without color. The highlight SHALL end when the exact operation settles or loses its visible session/owner scope.

For an accepted Continue decision, observation of either the exact published continuation on the current branch or the matching continuation starting in the owning main session SHALL end the private publication display immediately, without waiting for that main run to settle. The stage, private elapsed time, attempt counter and highlight SHALL disappear together; ordinary activity and unlock controls SHALL remain. Ending the display SHALL NOT itself acknowledge durable publication, spend or refund a unit, emit a hook, authorize an abort, or cause another send.

#### Scenario: Root works without a private inquiry
- **WHEN** the root is running and Continue is enabled but no private Continue decision exists
- **THEN** Continue retains its ordinary activity and unlock information without an active private-operation highlight

#### Scenario: Root is idle during review
- **WHEN** the root is idle and Continue awaits its optional unlock review
- **THEN** Continue's row is highlighted and identifies review rather than implying ordinary root work

#### Scenario: System bookkeeping precedes the matching continuation
- **WHEN** the main run starts, a host system message precedes the matching continuation, and the main run remains busy after accepting that continuation
- **THEN** the row no longer shows `publishing`, its timer or its attempt counter once the matching handoff is observed, before the main run settles or any further tool call is required
- **AND** the watchdog remains enabled, the main run continues, and exactly one continuation is delivered and charged under the existing publication rules

#### Scenario: The continuation starts before the durable receipt is readable
- **WHEN** the owning main session starts the exact continuation but its branch receipt is not yet readable
- **THEN** the row ends the private stage without claiming durable publication or retrying the send
- **AND** a later matching receipt follows the existing confirmation rules at most once, without restoring old progress

#### Scenario: An unrelated user starts instead
- **WHEN** unrelated user work takes over before the expected handoff and the pending publication loses ownership
- **THEN** the obsolete private progress clears, without adopting or aborting the user's run
- **AND** neither busy status nor clearing the row counts as a receipt, triggers a resend or emits a continuation hook
