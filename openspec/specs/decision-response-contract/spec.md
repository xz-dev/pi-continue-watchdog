# decision-response-contract Specification

## Purpose

Define the response-shape contract the watchdog decision prompt communicates to the model, so the model outputs a pure XML document whose structured fields carry the reasoning, while parser acceptance remains lenient for partial compliance.

## Requirements

### Requirement: Entire response is the watchdog XML document

The fixed suffix appended to the decision prompt SHALL instruct that the entire assistant response consist of exactly one `<watchdog>` XML document, with no text before or after it. The suffix SHALL NOT invite or permit explaining the decision in text outside the XML block. The suffix SHALL state that the decision's reasoning belongs in the structured fields (for example `reason_content`).

#### Scenario: Prompt forbids prose around the XML

- **WHEN** `buildDecisionPrompt` renders the fixed suffix after any configured decision prompt
- **THEN** the suffix requires the whole response to be the single watchdog XML document
- **AND** it contains no wording that permits explaining before or after the block

#### Scenario: Configured decision prompt cannot weaken the contract

- **WHEN** a user supplies a custom `decisionPrompt`
- **THEN** the fixed suffix still states the same entire-response contract
- **AND** the configured text is not relied upon to enforce the response shape

### Requirement: Reask and block reasons state the same response shape

User-facing strings that correct or constrain the model during a decision window—the invalid-XML reask error, the unsupported-content and malformed-response errors, and the tool-block reason—SHALL state the same entire-response contract: exactly one valid `<watchdog>` XML document and nothing else.

#### Scenario: Reask wording matches the initial contract

- **WHEN** a decision response is invalid and a reask error is produced
- **THEN** the error text demands the full response be the single valid watchdog XML document
- **AND** it does not describe the block as something appended after other text

### Requirement: Lenient parser acceptance is unchanged

Parser acceptance SHALL remain unchanged: a response whose non-thinking text ends with exactly one valid `<watchdog>` block remains valid even if unrelated text precedes the block, and all existing field validation, reason-type matching, size limits, and reask-count behaviors are preserved.

#### Scenario: Stray prose before a valid block still parses

- **WHEN** a response contains prose before a valid trailing watchdog XML block
- **THEN** validation succeeds exactly as before this change
