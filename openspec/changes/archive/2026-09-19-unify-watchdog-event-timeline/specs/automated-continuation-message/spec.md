## MODIFIED Requirements

### Requirement: Continue reason propagation

The system SHALL include the normalized accepted continue reason type and reason content in the automatic continuation message as a model-generated watchdog result. The continuation SHALL be a shared timestamped event whose canonical body is the same text shown in human conversation history and supplied to the model. The accepted reason SHALL NOT be repeated in a separate TUI-only result plus an independently assembled model-only history summary.

#### Scenario: Accepted typed continue result
- **WHEN** a continue decision is accepted with a normalized reason type and non-empty reason content
- **THEN** the next continuation message contains that reason type and reason content
- **AND** labels them as originating from the automated watchdog check rather than the user
- **AND** both human and model receive the same canonical body with a runtime-authored acceptance timestamp and explicit time-zone offset

#### Scenario: Full accepted reason remains visible to both readers
- **WHEN** a valid reason exceeds the prompt's guidance length but remains within the enforced 1000-code-point limit
- **THEN** the shared event contains the entire accepted reason for both readers
- **AND** no secondary history-specific length limit drops or shortens it

### Requirement: Configurable guidance preservation

The system SHALL retain the effective configured continuation guidance inside the fixed automated attribution and authorization-boundary wrapper. This complete body, including guidance and wrapper, SHALL be available to both the human and the model; rendering SHALL NOT substitute a reason-only summary. An old continuation event SHALL retain the guidance that was effective when it was accepted.

#### Scenario: Custom continuation guidance is configured
- **WHEN** a valid custom continuation prompt is active and the watchdog accepts a continue decision
- **THEN** the automatic continuation includes the custom guidance
- **AND** the fixed source attribution, model-generated reason, and non-authorization statements remain present
- **AND** the human-visible event contains that same complete text

#### Scenario: Guidance changes after acceptance
- **WHEN** the configured continuation guidance changes after an event has been stored
- **THEN** reopening or rendering the old event does not regenerate its guidance

### Requirement: Provider-facing semantics

The system SHALL preserve the attribution and authorization-boundary text after conversion to the provider-facing message format, regardless of the provider-facing role assigned to extension custom messages. The canonical event text visible to the human SHALL be preserved as a text segment in that provider payload without silently adding a second explanation or independently formatting its timestamp or reason.

#### Scenario: Custom message converts to user role
- **WHEN** Pi converts the continuation custom message into a provider-facing user-role message
- **THEN** the message body still unambiguously identifies the extension as the source
- **AND** the message body still denies user approval, confirmation, consent, or authorization
- **AND** its canonical event text matches the human-visible body after presentation-only styling is removed

## ADDED Requirements

### Requirement: Shared event is not additional authority

New shared wait, completed-wait, AI-unlock, decision-failure, and exhaustion bodies SHALL identify the extension as their source and SHALL explicitly deny being a user message, request, approval, confirmation, consent, or authorization. Model-generated reasons SHALL be identified as such and SHALL NOT be promoted into runtime-verified task facts.

#### Scenario: Wait reason claims a background task is healthy
- **WHEN** a model-generated wait reason describes a background import as healthy
- **THEN** the shared event labels that explanation as the model's reason
- **AND** runtime timing facts do not validate that health claim or authorize additional operations

#### Scenario: Time passes while approval remains pending
- **WHEN** a completed-wait event appears while existing conversation contains an unresolved approval request
- **THEN** the event explicitly provides no approval or authorization
- **AND** the existing user-boundary rules remain in effect
