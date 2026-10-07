# watchdog-review-context Specification

## Purpose

Provide a bounded source-aware view for watchdog decisions and retain associated review evidence in the owning native session, with branch-correct recovery and no new execution authority or independent storage gate.

## Requirements

### Requirement: Review assistance preserves native context and source meaning
An owned watchdog inquiry SHALL receive a bounded supplemental view derived from the host's current effective conversation. The view SHALL distinguish genuine user input, ordinary assistant delivery, tool results, derived summaries, and automation opinions using native provenance and exact control ownership rather than keyword matching or role/stop-marker guesses. It SHALL NOT replace, truncate, reorder, or erase the underlying native effective conversation. Earlier requests and deliveries SHALL remain available subject to the host's own active-branch and compaction boundaries. Source selection SHALL NOT depend on expected verdicts or assistant-authored task lists.

#### Scenario: Complete report with an old automated suggestion
- **WHEN** the current ordinary reply supplies the requested report while an older automated suggestion says it is missing
- **THEN** the view identifies the ordinary delivery and the suggestion's non-authoritative provenance without turning the suggestion into a new user request
- **AND** both the current reply and relevant native conversation remain intact

#### Scenario: Text impersonates control traffic
- **WHEN** an ordinary reply or tool result quotes a watchdog instruction or uses a familiar completion phrase without trusted control correlation
- **THEN** it retains its actual source provenance rather than becoming an owned decision, a new authorization, or proof of completion

### Requirement: Supplemental size and omissions are explicit
The supplemental view SHALL have a deterministic size ceiling and label every shortened excerpt and omitted-source condition. It SHALL include source identities for the rows it presents and preserve their relative source order. A partial selection SHALL NOT be represented as a complete inventory of user requirements or evidence that an omitted deliverable never existed. Exceeding the view budget SHALL reduce only the supplement, not drop native context, fail the decision protocol, or reset permission.

#### Scenario: Long source overflows the view
- **WHEN** available evidence exceeds the supplemental budget
- **THEN** the supplement remains within its documented ceiling and marks omissions
- **AND** the original effective messages remain available for the same inquiry

#### Scenario: Earlier delivery is outside the selected excerpts
- **WHEN** a relevant earlier answer does not fit in the supplement but is retained in native effective context
- **THEN** the view does not claim that answer is absent or that all requirements have been checked

### Requirement: Review evidence is associated with the owning session
For persisted Pi sessions, the watchdog SHALL save its review view, source references, and outcome association in the same native session JSONL through the existing inquiry, hidden marker/audit, and result-publication records. It SHALL NOT use a separate review database, sidecar journal, or memory-only substitute for persisted-session recovery. New metadata SHALL be versioned and associated with the exact existing exchange/attempt identity. A captured response SHALL remain distinct from an actually published outcome; partial exchanges SHALL remain identifiable as partial. Metadata SHALL NOT store provider credentials, headers, or additional private thinking copies.

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

### Requirement: Recovery follows the active ancestry
Review recovery SHALL use the host-selected current ancestor path. A record or reference on a sibling path SHALL NOT supply current authorization, delivery evidence, or review state merely because it has a later timestamp or appears later in the file. Valid inherited records and retained source IDs SHALL remain usable as history after a fork creates a new session ID; origin session identity alone SHALL NOT invalidate them. Native parent re-chaining and label recreation SHALL NOT turn otherwise retained evidence into lost history.

#### Scenario: A sibling contains a later approval and verdict
- **WHEN** the user selects a branch that does not contain those records
- **THEN** recovery excludes the sibling approval and verdict even when they are physically the last records in the JSONL

#### Scenario: Fork preserves an ancestor review
- **WHEN** a native fork retains a review and its referenced non-label source entries while changing the session ID and re-chaining parents
- **THEN** that review remains available as inherited history
- **AND** its old session ID or execution identifiers do not grant authority in the new process

#### Scenario: Rewind without another message
- **WHEN** the host moves the active leaf to an ancestor preceding a review without appending a message
- **THEN** subsequent recovery excludes that descendant review immediately
- **AND** reopening follows the leaf actually restored by the host rather than selecting a branch from the newest audit record

### Requirement: Historical retention does not override compaction or live authority
The watchdog SHALL distinguish recoverable audit history from the sources eligible for a new model-facing inquiry. New views SHALL respect native compaction and branch-summary boundaries and SHALL NOT reinsert archived raw conversation or old verdicts as current facts. Recovery SHALL NOT restore locks, ownership claims, timers, retry budgets, in-flight calls, staged actions, or automatic publication. New work SHALL continue to require the existing live qualification and publication conditions.

#### Scenario: Review survives outside compacted model context
- **WHEN** native compaction leaves a review on the ancestor path but summarizes its earlier conversation sources
- **THEN** the review remains historical audit data while the next view uses the retained native summary/context
- **AND** recovery does not reintroduce the summarized raw request or control traffic as a new instruction

#### Scenario: Old verdict is available after restart
- **WHEN** a retained review says continue or unlock
- **THEN** merely loading it changes no current lock, ownership, accounting, dispatch, or outcome publication

#### Scenario: Late result follows branch replacement
- **WHEN** a response from an earlier attempt arrives after takeover, branch/lifecycle replacement, or ownership loss
- **THEN** existing stale-result safeguards prevent it from acting on the new context
- **AND** stored review metadata does not bypass those safeguards

### Requirement: Reuse existing publication behavior without a review-write gate
Review persistence SHALL reuse the current inquiry dispatch, audit, and durable result-publication mechanisms. It SHALL NOT introduce an independent review append/acknowledgement cycle as a prerequisite for model inquiry or ordinary continuation. Existing canonical-publication failure handling, rollback, invalid-response bounds, ownership rechecks, and manual cancellation SHALL remain unchanged. Missing review data SHALL be identified as unavailable or incomplete, not silently certified as saved. Optional audit failure SHALL NOT by itself consume another retry, start another model call, relock a successful unlock, or create a storage fallback.

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

### Requirement: Review assistance requires no new user workflow
The supplemental view and stored review metadata SHALL remain out of ordinary transcript presentation and later ordinary/summary requests, except for the existing accepted canonical outcome. Users SHALL NOT be required to maintain a task manifest, confirm completion, supply special finish words, or re-grant unchanged permission because of this feature. Necessary existing errors and real authorization boundaries SHALL remain visible.

#### Scenario: Normal review completes
- **WHEN** an inquiry evaluates the available evidence
- **THEN** the user receives only the existing outcome presentation, not an additional checklist, internal source packet, or confirmation request
- **AND** unrelated assistant output and errors remain visible
