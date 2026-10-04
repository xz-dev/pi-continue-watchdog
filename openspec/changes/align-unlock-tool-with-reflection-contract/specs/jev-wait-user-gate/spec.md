## REMOVED Requirements

### Requirement: Gate placement before an automatic continuation
**Reason**: The independent watchdog decision inquiry replaces external pre-continuation classification.
**Migration**: Open the qualified decision inquiry; do not request a jev classification before it or before an accepted continuation.

#### Scenario: Eligible settlement no longer invokes the classifier
- **WHEN** a locked ordinary run qualifies after the idle fence
- **THEN** no jev request precedes its watchdog-owned decision

### Requirement: Default enablement follows key availability
**Reason**: Shared credentials must no longer implicitly activate a removed integration.
**Migration**: Stop resolving keys for this gate without changing Pi credentials, environment variables, or other integrations.

#### Scenario: Provider key exists
- **WHEN** TypeSafe or OpenRouter credentials are available
- **THEN** this watchdog makes no jev request and leaves the credentials unchanged

### Requirement: Classified input is the final assistant text only
**Reason**: No conversation content is to be sent to the removed classifier.
**Migration**: Use existing conversation inside the authorized decision inquiry; remove classifier input extraction and per-message classification tracking.

#### Scenario: Assistant asks a question
- **WHEN** an ordinary assistant answer contains a user question
- **THEN** its text is not submitted to jev for classification

### Requirement: Confident waiting verdict unlocks as WAIT_USER
**Reason**: External waiting verdicts must no longer unlock the watchdog or credit jev in notifications.
**Migration**: Only an authorized decision unlock or an existing independent manual/error/abort path can stop the current cycle.

#### Scenario: Old classification cannot stop a cycle
- **WHEN** normal work settles with text asking for user input
- **THEN** no classifier-based unlock or jev-attributed user-ready reason is produced

### Requirement: Gate fails open
**Reason**: There is no classifier request, timeout, or fail-open branch after removal.
**Migration**: Use decision-response correction/failure behavior and existing terminal-error handling instead of classifier fallback.

#### Scenario: Classifier endpoint unavailable
- **WHEN** a previously configured jev endpoint is unreachable
- **THEN** it has no effect on inquiry dispatch, wait timing, or continuation accounting because it is not contacted

### Requirement: Stale verdicts are discarded
**Reason**: Classifier verdicts and in-flight classifier state no longer exist.
**Migration**: Remove jev-specific stale-result handling while retaining ownership and stale-result guards for the actual watchdog decision flow.

#### Scenario: User takes over
- **WHEN** a user starts a new lock cycle
- **THEN** no classifier result can affect it and current decision-ownership safeguards still apply

### Requirement: Gate configuration
**Reason**: jev enablement, endpoint, model, thresholds, timeout, and integration-specific key settings are obsolete.
**Migration**: Report `jevWaitCheck` as removed without echoing its values. Remove it manually from watchdog config if desired; do not delete shared provider credentials.

#### Scenario: Obsolete object is loaded
- **WHEN** configuration contains `jevWaitCheck`
- **THEN** the removed-key diagnostic is reported without exposing secrets or preventing other valid settings from applying
