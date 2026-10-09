## MODIFIED Requirements

### Requirement: Accepted outcomes remain current and idempotent
Ownership, cycle, run, branch, session, and external-activity guards SHALL be rechecked before committing a staged outcome. Manual unlock, takeover, ownership loss, shutdown, and lifecycle replacement SHALL invalidate old effects. When cross-process subagent activity invalidates an owned inquiry whose prompt was already submitted, one bounded `Other error` status SHALL disclose that the check was invalidated by subagent activity and its answer discarded; activity before submission SHALL remain silent. This disclosure SHALL NOT change invalidation, lock, or budget behavior. Repeated delivery or settlement SHALL NOT duplicate transitions, status records, continuation messages, or semantic hooks. Existing abort and terminal-error unlock behavior SHALL remain independent from model-selected outcomes.

#### Scenario: User takes over after submission
- **WHEN** a user starts new work after a decision is staged but before publication finishes
- **THEN** the old result cannot publish an outcome or charge the new cycle

#### Scenario: Subagent activity invalidates a submitted inquiry
- **WHEN** subagent activity is observed after the inquiry prompt was submitted
- **THEN** the inquiry is invalidated as before and its answer cannot publish
- **AND** exactly one status explains the subagent invalidation, even if further activity follows
