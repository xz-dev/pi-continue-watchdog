# watchdog-review-context Specification Delta

Delta for `openspec/specs/watchdog-review-context/spec.md`.

## MODIFIED Requirements

### Requirement: Review evidence is associated with the owning session
For persisted Pi sessions, the watchdog SHALL save its review view, source references, safe response audit, and outcome association in the owning main session's native JSONL through versioned context-excluded audit records and existing result-publication records. New metadata SHALL associate the exact logical decision, private child, inquiry/response attempt, and captured source identity. Review association records SHALL carry the review disposition, actual service backend/model identity, and optional backend-reported usage fields; they SHALL NOT fabricate transport-attempt counts, observation-completeness markers or billing totals the version-two service does not supply. Absent usage SHALL NOT be recorded as zero. New private task prompts, correction messages, raw invalid outputs, and file-write traffic SHALL remain in the private execution boundary and SHALL NOT be copied into the main conversation. The temporary result file and optional child transcript SHALL NOT replace the main session's recoverable association or become a review database or sidecar journal. A captured candidate SHALL remain distinct from a published outcome; partial operations SHALL remain identifiable as partial. An attempt preempted or invalidated before its response was consumed SHALL NOT owe a response audit; its absence SHALL NOT by itself make that operation partial. Metadata SHALL NOT store provider credentials, headers, or additional private thinking copies.

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

#### Scenario: Review record lacks usage
- **WHEN** a settled version-two judgment reports no backend usage
- **THEN** the review record omits usage fields rather than recording zero or an unmeasured attempt count
