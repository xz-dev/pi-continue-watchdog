## REMOVED Requirements

### Requirement: Review scope
**Reason**: External unlock permission review is removed for every reason type and path.
**Migration**: Evaluate actual delivery and user boundaries in the authorized watchdog inquiry; validate its result locally without a jev call.

#### Scenario: User-wait unlock
- **WHEN** a current consumed decision submits a valid `WAIT_USER` unlock
- **THEN** no external permission-review request occurs

### Requirement: Reviewed state is the current turn only
**Reason**: The watchdog no longer constructs or sends turn evidence to an external reviewer.
**Migration**: Remove review evidence extraction, truncation, and request preparation; preserve ordinary conversation and tool results for the decision inquiry.

#### Scenario: User choice is already in conversation
- **WHEN** an `ask_user_question` answer grants permission
- **THEN** it remains evidence for the normal decision inquiry and is not exported in a jev review request

### Requirement: Confident contradiction refuses the unlock
**Reason**: There is no external contradiction verdict or review-specific tool-error continuation path.
**Migration**: Reject unauthorized or malformed submissions using the reserved-function and bounded decision contracts, not a reviewer verdict.

#### Scenario: No review rejection text
- **WHEN** a valid authorized unlock is submitted
- **THEN** its result cannot fail with a jev permission contradiction or an `n/3` review rejection counter

### Requirement: Review fails open
**Reason**: No review endpoint, probability response, timeout, or fail-open branch remains.
**Migration**: Apply the local decision contract regardless of former endpoint or credential availability.

#### Scenario: No reviewer response is needed
- **WHEN** a valid current unlock verdict is accepted
- **THEN** it does not wait for or retry any external review

### Requirement: At most three rejections per lock cycle
**Reason**: The jev rejection counter and its forced-pass fourth-call behavior are removed.
**Migration**: Use the separate fixed three-response decision-validation limit; it must never grant authority to an ordinary out-of-phase call.

#### Scenario: Repeated proactive calls stay unauthorized
- **WHEN** ordinary work calls the reserved function four times outside an inquiry
- **THEN** all four calls are rejected without unlocking or consuming decision-response attempts

### Requirement: Stale verdicts are discarded
**Reason**: No external review verdict can be pending after removal.
**Migration**: Remove review-specific in-flight state while retaining current-main, cycle, and consumed-attempt guards for decision submissions.

#### Scenario: Manual unlock invalidates a decision
- **WHEN** a human unlocks during a decision inquiry
- **THEN** its late result cannot act, independently of any removed reviewer

### Requirement: In-flight review aborts on shutdown
**Reason**: Shutdown has no jev review request to abort.
**Migration**: Remove reviewer-specific cancellation wiring while preserving normal owned-run cancellation and session shutdown cleanup.

#### Scenario: Shutdown during an inquiry
- **WHEN** a session shuts down during a watchdog decision
- **THEN** existing owned-run cleanup applies and no external review completion can later change state
