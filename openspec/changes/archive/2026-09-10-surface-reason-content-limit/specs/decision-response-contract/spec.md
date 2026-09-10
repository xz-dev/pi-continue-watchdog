## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Lenient parser acceptance is unchanged

Parser acceptance SHALL remain unchanged: a response whose non-thinking text ends with exactly one valid `<watchdog>` block remains valid even if unrelated text precedes the block, and all existing field validation, reason-type matching, and reask-count behaviors are preserved. The `reason_content` size limit is governed by the reason content hard limit requirement.

#### Scenario: Stray prose before a valid block still parses

- **WHEN** a response contains prose before a valid trailing watchdog XML block
- **THEN** validation succeeds exactly as before this change
