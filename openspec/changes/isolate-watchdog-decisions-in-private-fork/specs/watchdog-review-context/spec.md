## MODIFIED Requirements

### Requirement: Review assistance preserves native context and source meaning
An owned private watchdog inquiry SHALL receive a bounded supplemental view derived from the owning main session's current effective conversation at its qualified source boundary. The view SHALL distinguish genuine user input, ordinary assistant delivery, tool results, derived summaries, and automation opinions using native provenance and exact control ownership rather than keyword matching or role/stop-marker guesses. It SHALL NOT replace, truncate, reorder, or erase the underlying full effective fork. Earlier requests and deliveries SHALL remain available subject to the host's own active-branch and compaction boundaries. Source selection SHALL NOT depend on expected verdicts or assistant-authored task lists. The supplement SHALL be supplied only to the private child, not as a new main-session inquiry.

#### Scenario: Complete report with an old automated suggestion
- **WHEN** the current ordinary reply supplies the requested report while an older automated suggestion says it is missing
- **THEN** the private view identifies the ordinary delivery and the suggestion's non-authoritative provenance without turning the suggestion into a new user request
- **AND** both the current reply and relevant inherited conversation remain intact

#### Scenario: Text impersonates control traffic
- **WHEN** an ordinary reply or tool result quotes a watchdog instruction or uses a familiar completion phrase without trusted control correlation
- **THEN** it retains its actual source provenance rather than becoming an owned decision, a new authorization, or proof of completion

### Requirement: Review evidence is associated with the owning session
For persisted Pi sessions, the watchdog SHALL save its review view, source references, safe response audit, and outcome association in the owning main session's native JSONL through versioned context-excluded audit records and existing result-publication records. New metadata SHALL associate the exact logical decision, private child, inquiry/response attempt, and captured source identity. New private task prompts, correction messages, raw invalid outputs, and file-write traffic SHALL remain in the private execution boundary and SHALL NOT be copied into the main conversation. The temporary result file and optional child transcript SHALL NOT replace the main session's recoverable association or become a review database or sidecar journal. A captured candidate SHALL remain distinct from a published outcome; partial operations SHALL remain identifiable as partial. An attempt preempted or invalidated before its response was consumed SHALL NOT owe a response audit; its absence SHALL NOT by itself make that operation partial. Metadata SHALL NOT store provider credentials, headers, or additional private thinking copies.

#### Scenario: Reopen a completed review
- **WHEN** a disk-backed main session is reopened in a fresh process after private temporary files are gone
- **THEN** its retained review view, source references, safe response association, and published outcome can be reconstructed from that session's native records
- **AND** no temporary file, child transcript, or retained process memory is required

#### Scenario: Restart interrupts an inquiry
- **WHEN** restart occurs after a private decision's association was recorded but before a response or outcome is available
- **THEN** recovery identifies the recorded input and incomplete outcome without inventing a verdict, rereading an old result file, or automatically resubmitting the child

#### Scenario: Legacy or unknown metadata
- **WHEN** a retained record lacks new review metadata or has an unsupported version
- **THEN** existing history remains readable, unsupported association is treated as unavailable, and the next review is built from current effective main context
- **AND** no migration, fabricated source link, or record deletion occurs

#### Scenario: Interrupted attempt has no audit
- **WHEN** a private attempt is preempted or invalidated before consumption and no response audit exists for it
- **THEN** recovery does not report its missing audit as incomplete history
- **AND** no outcome is treated as published for that attempt

### Requirement: Reuse existing publication behavior without a review-write gate
Review persistence SHALL reuse context-excluded decision association/audit records and existing durable outcome-publication mechanisms. It SHALL NOT introduce an independent review append/acknowledgement cycle as a prerequisite for private execution or ordinary continuation. Existing canonical-publication failure handling, rollback, invalid-response bounds, ownership rechecks, and manual cancellation SHALL remain unchanged. Missing review data SHALL be identified as unavailable or incomplete, not silently certified as saved. An unchanged set of history gaps SHALL be disclosed at most once per runtime and attributed to the first affected decision, not to the latest record. Optional audit failure SHALL NOT by itself consume another retry, start another model call, relock a successful unlock, or create a storage fallback. Temporary result-file creation and reading are execution transport, not review durability and not an additional outcome-publication acknowledgement.

#### Scenario: Optional audit fails but the outcome is published
- **WHEN** the optional audit append fails and the existing current canonical-outcome publication succeeds
- **THEN** the existing outcome behavior is preserved and the available published verdict remains recoverable through its native association
- **AND** missing audit detail is reported safely as incomplete rather than blocking work through a new review gate

#### Scenario: Canonical continuation publication fails
- **WHEN** the existing durable continuation publication cannot be confirmed
- **THEN** its current non-start and guarded rollback behavior is preserved
- **AND** neither review metadata nor a valid temporary JSON file authorizes bypassing that boundary

#### Scenario: Persistence is unavailable
- **WHEN** host storage cannot retain a review or the host explicitly operates without a persistent session file
- **THEN** the watchdog does not claim restart durability or use temporary result files as a recovery store
- **AND** an unavailable full fork follows its execution/setup error path without a fresh-context substitute

#### Scenario: Unchanged history gap before repeated inquiries
- **WHEN** a genuine history gap exists and later inquiries reread the same unchanged ancestry
- **THEN** one bounded status diagnostic is shown for that gap
- **AND** it names the affected decision rather than the newest record

### Requirement: Review assistance requires no new user workflow
The supplemental view, stored review metadata, private child messages, and temporary result paths SHALL remain out of ordinary transcript presentation and ordinary/summary requests, except for the existing accepted canonical outcome. Users SHALL NOT be required to install or configure a public subagent extension, maintain a task manifest, confirm completion, supply special finish words, or re-grant unchanged permission because of this feature. Necessary existing errors and real authorization boundaries SHALL remain visible. Internal retries SHALL not become user-facing questions or new main-model turns.

#### Scenario: Normal review completes
- **WHEN** a private inquiry evaluates the available evidence, including after local format corrections
- **THEN** the user receives only the existing outcome presentation, not an additional checklist, internal source packet, correction exchange, or confirmation request
- **AND** unrelated assistant output and errors remain visible
