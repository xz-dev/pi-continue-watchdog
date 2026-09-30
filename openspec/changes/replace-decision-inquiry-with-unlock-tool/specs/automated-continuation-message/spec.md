## ADDED Requirements

### Requirement: Direct continuation without inquiry
When the locked current main agent qualifies at the existing post-idle check and the retry budget allows another attempt, the watchdog SHALL directly publish one automatic continuation message that starts the next turn and SHALL consume one retry attempt. No decision question, model answer, or validation step SHALL precede it. When the budget is already spent, the existing exhaustion behavior SHALL apply instead.

#### Scenario: Agent ends a turn without unlocking
- **GIVEN** the watchdog is locked with retry budget remaining
- **WHEN** the main agent ends its run without calling `unlock_continue_watchdog` and the aggregate-idle fence elapses
- **THEN** one continuation message is published and starts the next turn
- **AND** no hidden decision prompt is sent

#### Scenario: Agent unlocked before settlement
- **WHEN** the agent called `unlock_continue_watchdog` during the run
- **THEN** no continuation message is published at the following idle

### Requirement: Continuation body without model reason
The automatic continuation message SHALL NOT contain a model-generated reason or reason type, because the model does not select continuation. The continuation SHALL be a shared timestamped event whose canonical body is the same text shown in human conversation history and supplied to the model. That body SHALL NOT be duplicated in a separate TUI-only result plus an independently assembled model-only history summary.

#### Scenario: Continuation body content
- **WHEN** an automatic continuation is published
- **THEN** its body contains the runtime timestamp, attribution, unlock and waiting guidance, configured guidance, and authorization boundary
- **AND** contains no model-generated reason text
- **AND** both human and model receive the same canonical body

### Requirement: Unlock and waiting guidance
The continuation message SHALL state that the agent ended its turn without calling `unlock_continue_watchdog`. It SHALL instruct the agent to call that tool now if all requested work is complete or user input, approval, or other user action is required, and otherwise to continue the remaining work. It SHALL instruct that, when the agent needs some work to finish, it block on or monitor that task directly, or sleep for its estimated duration, instead of ending the turn.

#### Scenario: Agent must wait for CI
- **WHEN** the continuation message is delivered while CI is still running
- **THEN** the message directs the agent to monitor CI or sleep for an estimated duration within its turn
- **AND** it offers no separate watchdog wait outcome

### Requirement: Visible extension event block
The continuation SHALL be published as an extension-owned custom message rendered as a distinct watchdog event block in conversation history. It SHALL NOT be sent as a user-authored message. Its heading SHALL include a runtime-authored RFC 3339 timestamp with explicit offset.

#### Scenario: Human views history
- **WHEN** the user scrolls conversation history after an automatic continuation
- **THEN** the continuation appears as a pi-continue-watchdog event block, not as a user message bubble

### Requirement: Watchdog events are not additional authority
New shared continuation and exhaustion bodies SHALL identify the extension as their source and SHALL explicitly deny being a user message, request, approval, confirmation, consent, or authorization.

#### Scenario: Continuation while approval remains pending
- **WHEN** a continuation event appears while existing conversation contains an unresolved approval request
- **THEN** the event explicitly provides no approval or authorization
- **AND** the existing user-boundary rules remain in effect

## MODIFIED Requirements

### Requirement: Bounded resumed work
The system SHALL instruct the agent to resume only work already requested and authorized by the user and to stop, by calling `unlock_continue_watchdog`, when additional user input, approval, or assistance is required.

#### Scenario: Remaining work needs no new approval
- **WHEN** actionable remaining work is already within the user's request and authorization
- **THEN** the continuation message directs the agent to resume that work

#### Scenario: Remaining work reaches user boundary
- **WHEN** resumed work reaches a step requiring new user input, approval, or assistance
- **THEN** the continuation message requires the agent to stop and ask the user, and to call `unlock_continue_watchdog`

### Requirement: Configurable guidance preservation
The system SHALL retain the effective configured continuation guidance inside the fixed automated attribution, unlock and waiting guidance, and authorization-boundary wrapper. This complete body SHALL be available to both the human and the model, and rendering SHALL NOT substitute a summary. An old continuation event SHALL retain the guidance that was effective when it was published.

#### Scenario: Custom continuation guidance is configured
- **WHEN** a valid custom continuation prompt is active and an automatic continuation is published
- **THEN** the continuation includes the custom guidance
- **AND** the fixed source attribution, unlock and waiting guidance, and non-authorization statements remain present
- **AND** the human-visible event contains that same complete text

#### Scenario: Guidance changes after acceptance
- **WHEN** the configured continuation guidance changes after an event has been stored
- **THEN** reopening or rendering the old event does not regenerate its guidance

## REMOVED Requirements

### Requirement: Continue reason propagation
**Reason**: Continuation is no longer selected by the model, so there is no model-generated reason to propagate.
**Migration**: See "Continuation body without model reason". Pre-upgrade continuation events keep their stored reason text.

### Requirement: Shared event is not additional authority
**Reason**: Wait, completed-wait, AI-unlock, and decision-failure events no longer exist.
**Migration**: See "Watchdog events are not additional authority", which covers continuation and exhaustion.
