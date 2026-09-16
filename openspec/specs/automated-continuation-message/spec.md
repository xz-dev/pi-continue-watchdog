## Purpose

Ensures every automatic continuation is clearly attributed to the watchdog, carries its model-generated reason, and cannot be mistaken for user approval or authorization.

## Requirements

### Requirement: Automated continuation attribution
The system SHALL identify every automatic continuation message as originating from the pi-continue-watchdog extension and SHALL state that the message is not a message or request from the user.

#### Scenario: Provider receives automatic continuation
- **WHEN** the watchdog accepts a continue decision and triggers the next model turn
- **THEN** the continuation content identifies the pi-continue-watchdog extension as its source
- **AND** the continuation content states that it is not a user message or request

### Requirement: Continue reason propagation
The system SHALL include the normalized accepted continue reason type and reason content in the automatic continuation message as a model-generated watchdog result.

#### Scenario: Accepted typed continue result
- **WHEN** a continue decision is accepted with a normalized reason type and non-empty reason content
- **THEN** the next continuation message contains that reason type and reason content
- **AND** labels them as originating from the automated watchdog check rather than the user

### Requirement: No implied user authorization
The system SHALL state that an automatic continuation message is not user approval, confirmation, consent, or authorization and SHALL NOT represent it as permission for an action that requires user approval.

#### Scenario: Prior assistant requested approval
- **WHEN** existing conversation context contains an unresolved request for user approval
- **AND** the watchdog emits an automatic continuation
- **THEN** the continuation message explicitly denies that it supplies the requested approval or authorization
- **AND** instructs the agent to stop and ask the user before performing the approval-gated action

### Requirement: Bounded resumed work
The system SHALL instruct the agent to resume only work already requested and authorized by the user and to stop when additional user input, approval, or assistance is required.

#### Scenario: Remaining work needs no new approval
- **WHEN** the watchdog reason identifies actionable remaining work that is already within the user's request and authorization
- **THEN** the continuation message directs the agent to resume that work

#### Scenario: Remaining work reaches user boundary
- **WHEN** resumed work reaches a step requiring new user input, approval, or assistance
- **THEN** the continuation message requires the agent to stop and ask the user

### Requirement: Configurable guidance preservation
The system SHALL retain the effective configured continuation guidance inside the fixed automated attribution and authorization-boundary wrapper.

#### Scenario: Custom continuation guidance is configured
- **WHEN** a valid custom continuation prompt is active and the watchdog accepts a continue decision
- **THEN** the automatic continuation includes the custom guidance
- **AND** the fixed source attribution, model-generated reason, and non-authorization statements remain present

### Requirement: Provider-facing semantics
The system SHALL preserve the attribution and authorization-boundary text after conversion to the provider-facing message format, regardless of the provider-facing role assigned to extension custom messages.

#### Scenario: Custom message converts to user role
- **WHEN** Pi converts the continuation custom message into a provider-facing user-role message
- **THEN** the message body still unambiguously identifies the extension as the source
- **AND** the message body still denies user approval, confirmation, consent, or authorization
