## MODIFIED Requirements

### Requirement: Review evidence is associated with the owning session
For persisted Pi sessions, the watchdog SHALL save its review view, source references, and outcome association in the same native session JSONL through the existing inquiry, hidden marker/audit, and result-publication records. It SHALL NOT use a separate review database, sidecar journal, or memory-only substitute for persisted-session recovery. New metadata SHALL be versioned and associated with the exact existing exchange/attempt identity. A captured response SHALL remain distinct from an actually published outcome; partial exchanges SHALL remain identifiable as partial. An attempt preempted or invalidated before its response was consumed SHALL NOT owe a response audit; its absence SHALL NOT by itself make that exchange partial. Metadata SHALL NOT store provider credentials, headers, or additional private thinking copies.

#### Scenario: Reopen a completed review
- **WHEN** a disk-backed native session is reopened in a fresh process
- **THEN** the correlated review input, source references, response, and published outcome can be reconstructed from that session's retained records
- **AND** no external state file or retained process memory is required

#### Scenario: Restart interrupts an inquiry
- **WHEN** restart occurs after the inquiry is recorded but before a response or outcome is available
- **THEN** recovery identifies the recorded input and incomplete outcome without inventing a verdict or automatically resubmitting the old inquiry

#### Scenario: Legacy or unknown metadata
- **WHEN** a retained record lacks new review metadata or has an unsupported version
- **THEN** existing history remains readable, unsupported association is treated as unavailable, and the next review is built from current native context
- **AND** no migration, fabricated source link, or record deletion occurs

#### Scenario: Interrupted attempt has no audit
- **WHEN** an inquiry attempt is folded as preempted or invalidated and no decision audit exists for it
- **THEN** recovery does not report its missing audit as incomplete history
- **AND** no outcome is treated as published for that attempt

### Requirement: Reuse existing publication behavior without a review-write gate
Review persistence SHALL reuse the current inquiry dispatch, audit, and durable result-publication mechanisms. It SHALL NOT introduce an independent review append/acknowledgement cycle as a prerequisite for model inquiry or ordinary continuation. Existing canonical-publication failure handling, rollback, invalid-response bounds, ownership rechecks, and manual cancellation SHALL remain unchanged. Missing review data SHALL be identified as unavailable or incomplete, not silently certified as saved. An unchanged set of history gaps SHALL be disclosed at most once per runtime and attributed to the first affected exchange, not to the latest record. Optional audit failure SHALL NOT by itself consume another retry, start another model call, relock a successful unlock, or create a storage fallback.

#### Scenario: Optional audit fails but the outcome is published
- **WHEN** the optional audit append fails and the existing current canonical-outcome publication succeeds
- **THEN** the existing outcome behavior is preserved and the available published verdict remains recoverable through its native association
- **AND** missing audit detail is reported safely as incomplete rather than blocking work through a new review gate

#### Scenario: Canonical continuation publication fails
- **WHEN** the existing durable continuation publication cannot be confirmed
- **THEN** its current non-start and guarded rollback behavior is preserved
- **AND** review metadata does not authorize bypassing that existing boundary

#### Scenario: Persistence is unavailable
- **WHEN** host storage cannot retain a review or the host explicitly operates without a persistent session file
- **THEN** the watchdog does not claim restart durability or create a private replacement file
- **AND** the host's persistence choice and existing operational error behavior remain unchanged

#### Scenario: Unchanged history gap before repeated inquiries
- **WHEN** a genuine history gap exists and later inquiries reread the same unchanged ancestry
- **THEN** one bounded status diagnostic is shown for that gap
- **AND** it names the affected exchange rather than the newest record
