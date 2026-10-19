# unlock-tool-delivery-boundary Specification

## Purpose

Keeps answers, results, reports, and questions in ordinary assistant replies rather than private watchdog control submissions, with no result-function declaration or call-to-stop obligation during ordinary work.

## Requirements

### Requirement: Unlock tool is not a delivery channel
Authorized private decision instructions SHALL state that the result JSON file submits watchdog control results, not user-facing delivery. Answers, results, reports, and questions SHALL be assessed in the ordinary replies already delivered; a reason field SHALL NOT substitute for a missing deliverable. The instructions SHALL state that the reason is for watchdog records and notifications, may be visible to the user, and must not be relied on as the user's answer. They SHALL NOT request another ordinary answer inside a decision-only response. Ordinary startup context SHALL expose neither a watchdog result function nor a call-to-stop obligation. Required field types, action-specific configured reason types, and reason bounds SHALL remain enforced by the private file-result validator rather than a public tool schema. Assistant prose SHALL not be used as an alternative result transport.

#### Scenario: Model reads the tool definition
- **WHEN** the provider receives ordinary startup context and tool declarations
- **THEN** the watchdog adds no result-tool declaration or guideline teaching a call-to-stop obligation
- **AND** no JSON-result task or temporary-file path is injected into ordinary work

#### Scenario: Model fills in reason
- **WHEN** the model reads an authorized private decision task
- **THEN** it learns that the reason is a control record rather than user-facing delivery and may be visible to the user
- **AND** it checks actual ordinary delivery instead of hiding an answer inside that reason

#### Scenario: Requested answer has not been delivered
- **WHEN** a requested answer exists only in a prospective control reason and an authorized next action can deliver it
- **THEN** the decision must not claim completion on that basis
- **AND** the answer belongs in resumed ordinary main-session work, not an extra private decision-phase message
