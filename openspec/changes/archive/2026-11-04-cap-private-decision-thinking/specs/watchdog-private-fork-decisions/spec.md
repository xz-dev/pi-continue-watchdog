## MODIFIED Requirements

### Requirement: One logical decision inherits a full effective fork
Each logical decision SHALL create one distinct child session from the owning main session's qualified active leaf. The child SHALL use the parent's current provider/model and SHALL use the parent's current thinking level capped by the effective `decisionThinkingCap`: when the cap is `inherit`, or the parent's level is at or below the cap in the order `off` < `minimal` < `low` < `medium` < `high` < `xhigh` < `max`, the child SHALL use the parent's level; otherwise the child SHALL use the cap. The cap SHALL NOT raise the child's level above the parent's level. The cap SHALL NOT change the main session's thinking level, and source-currency checks SHALL continue to compare the main session's selected thinking level. Format correction, unlock-review reconsideration and every other inquiry in the same child SHALL use that same capped level. A model that does not support the selected level SHALL be handled by the host's existing thinking-level handling; the watchdog SHALL NOT add its own provider-specific mapping. The child SHALL inherit the full effective active-branch conversation, system prompt state, and tool declarations, subject only to the host's existing compaction, exclusion, and provider-compatibility rules. Decision instructions and source supplements SHALL be appended after the inherited conversation rather than replacing it. Legacy watchdog folding SHALL apply before inherited decision input is sent. No pruned fork, recent-message suffix, alternate-model fallback, or silent fresh-context fallback SHALL substitute for an unavailable full fork. Inherited tool declarations SHALL NOT grant execution permission. The system SHALL NOT claim byte-identical final provider payloads or guaranteed cache hits across arbitrary provider serializers or third-party transformations, and SHALL NOT claim cache reuse when the capped level differs from the parent's level.

#### Scenario: The main model differs from the configured default
- **WHEN** an eligible main session uses a model other than the user's default
- **THEN** the private child uses that active model and a different session identity
- **AND** the user's selected session and main conversation remain unchanged during the decision

#### Scenario: A high parent level is capped by default
- **WHEN** no `decisionThinkingCap` is configured and the main session's thinking level is `high`, `xhigh` or `max`
- **THEN** the private child uses the parent's provider/model with thinking level `medium`
- **AND** the main session's thinking level remains unchanged

#### Scenario: A parent level at or below the cap is kept
- **WHEN** the effective cap is `medium` and the main session's thinking level is `off`, `minimal`, `low` or `medium`
- **THEN** the private child uses the parent's level unchanged

#### Scenario: Inherit keeps the parent level
- **WHEN** the effective cap is `inherit` and the main session's thinking level is `xhigh`
- **THEN** the private child uses thinking level `xhigh`

#### Scenario: Correction keeps the capped level
- **WHEN** a capped child needs a format correction or a review-triggered reconsideration
- **THEN** that inquiry runs in the same child with the same capped thinking level

#### Scenario: The main thinking level changes during a decision
- **WHEN** the user changes the main session's thinking level while a capped decision is in progress
- **THEN** the decision is no longer current, as with any other model or thinking change of the source

#### Scenario: Effective history excludes old internal exchanges
- **WHEN** the source branch contains old watchdog inquiry records, a retained native summary, and excluded or sibling material
- **THEN** the child receives the same eligible retained conversation and summary boundary without resurrecting old internal exchanges or sibling history
- **AND** new private decision messages are appended only to the child

#### Scenario: A full fork cannot be established
- **WHEN** the required source session, active leaf, or full-fork projection is unavailable
- **THEN** the operation reports an execution/setup failure without launching a fresh substitute
- **AND** no valid decision, invalid-format charge, or continuation charge is invented
