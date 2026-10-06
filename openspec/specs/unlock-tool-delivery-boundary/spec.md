# unlock-tool-delivery-boundary Specification

## Purpose

Keeps answers, results, reports, and questions in ordinary assistant replies rather than reserved watchdog control submissions, without disclosing the result function's usage contract during ordinary work.

## Requirements

### Requirement: Unlock tool is not a delivery channel
Authorized decision instructions SHALL state that the reserved function submits watchdog control results, not user-facing delivery. Answers, results, reports, and questions SHALL be assessed in the ordinary replies already delivered; a reason field SHALL NOT substitute for a missing deliverable. The instructions SHALL state that the reason is for watchdog records and notifications, may be visible to the user, and must not be relied on as the user's answer. They SHALL NOT request another ordinary answer inside a decision-only response. The public function description, schema, and startup guidelines SHALL NOT disclose these usage instructions.

#### Scenario: Model reads the tool definition
- **WHEN** the provider receives the declaration and ordinary startup context
- **THEN** the description remains exactly `don't use unless ask`
- **AND** no argument description or startup guideline teaches a call-to-stop obligation

#### Scenario: Model fills in reason
- **WHEN** the model reads an authorized decision prompt
- **THEN** it learns that the reason is a control record rather than user-facing delivery and may be visible to the user
- **AND** it checks actual ordinary delivery instead of hiding an answer inside that reason

#### Scenario: Requested answer has not been delivered
- **WHEN** a requested answer exists only in a prospective control reason and an authorized next action can deliver it
- **THEN** the decision must not claim completion on that basis
- **AND** the answer belongs in resumed ordinary work, not an extra decision-phase message
