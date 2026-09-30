## Purpose

Tells the model that `unlock_continue_watchdog` only stops the automatic continuation, so answers, results, and questions are written in the normal reply instead of being hidden in tool arguments.

## ADDED Requirements

### Requirement: Unlock tool is not a delivery channel
The unlock tool description SHALL state that the tool only stops the automatic continuation and is not a way to deliver anything to the user, that every answer, result, question, or report belongs in the normal reply text before the call, and that the agent must not rely on the user seeing the tool's arguments. The session-stable prompt guideline SHALL carry the same statement. The `reason` parameter description SHALL say that the reason is for the watchdog record and notifications, is not the user-facing answer, and may not be seen by the user. None of these texts SHALL claim that the user can never see the arguments.

#### Scenario: Model reads the tool definition
- **WHEN** the provider receives the tool definition and the system prompt
- **THEN** the description and the prompt guideline both say the tool only stops automatic continuation and is not a delivery channel
- **AND** both tell the agent to put everything the user needs in its reply text before calling the tool

#### Scenario: Model fills in reason
- **WHEN** the model reads the `reason` parameter description
- **THEN** it states that the reason is for the watchdog record and notifications, not the user-facing answer, and that the user may not see it
