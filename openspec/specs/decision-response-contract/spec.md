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

Parser acceptance SHALL remain unchanged: a response whose non-thinking text ends with exactly one valid `<watchdog>` block remains valid even if unrelated text precedes the block, and all existing field validation, reason-type matching, and reask-count behaviors are preserved. The `reason_content` size limit is governed by the reason content hard limit requirement.

#### Scenario: Stray prose before a valid block still parses

- **WHEN** a response contains prose before a valid trailing watchdog XML block
- **THEN** validation succeeds exactly as before this change

### Requirement: Prompt declares the reason content limit

The fixed suffix appended to the decision prompt SHALL tell the model that `reason_content` must be non-empty and at most a stated number of Unicode characters (the guidance limit). The guidance limit SHALL be derived in code as exactly half of the enforced hard limit, so the advertised limit and the enforced limit cannot drift apart.

#### Scenario: Decision prompt states the limit up front

- **WHEN** `buildDecisionPrompt` renders the fixed suffix after any configured decision prompt
- **THEN** the suffix states that `reason_content` must be non-empty and at most the guidance number of Unicode characters
- **AND** the stated number equals half of the enforced hard limit

#### Scenario: Guidance and enforcement share one source

- **WHEN** the hard-limit constant is changed in a future edit
- **THEN** the prompt-stated guidance changes with it automatically
- **AND** no second literal needs a matching edit

### Requirement: Reason content hard limit

Model-provided `reason_content` for continue, wait, and unlock decisions SHALL be trimmed and accepted when it is non-empty and contains at most 1000 Unicode code points. Responses above 1000 code points SHALL be rejected and re-asked. The three reason error strings SHALL quote the enforced limit from the same shared constant rather than a literal.

#### Scenario: Reason within headroom is accepted

- **WHEN** a decision response carries a `reason_content` of more than the stated guidance but at most 1000 Unicode code points
- **THEN** validation accepts it without a re-ask

#### Scenario: Reason above the hard limit is re-asked

- **WHEN** a decision response carries a `reason_content` of more than 1000 Unicode code points
- **THEN** validation rejects it with an error quoting 1000 as the limit
- **AND** the ordinary re-ask budget applies

#### Scenario: Blank reason is still rejected

- **WHEN** a decision response carries a `reason_content` that is empty or whitespace-only after trimming
- **THEN** validation rejects it with the same limit error as before
