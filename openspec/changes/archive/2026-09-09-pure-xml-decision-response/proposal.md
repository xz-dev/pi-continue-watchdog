# Proposal: pure-xml-decision-response

## Why

The fixed decision-prompt suffix says "You may explain your decision first, or output only XML. In either case, output exactly one `<watchdog>` XML block at the very end of your response"—an explicit license for free prose that is immediately cleared (`neutralizeDecisionAssistant`), never stored, and never shown. The prose only burns tokens on a high-frequency path (every decision window) and invites invalid-XML reasks when the model puts its reasoning in the preamble instead of the fields, or overruns the shared code-point cap.

## What Changes

- The fixed suffix in `buildDecisionPrompt` now requires the **entire response to be exactly one `<watchdog>` XML document, with no text before or after it**, and explicitly names `reason_content` (and the other fields) as the reasoning space.
- The user-facing error constants that feed reask prompts (`INVALID_DECISION_XML_ERROR`, `UNSUPPORTED_DECISION_CONTENT_ERROR`, `MALFORMED_DECISION_RESPONSE_ERROR`) and the tool-block reason are reworded to the same entire-response contract.
- The parser stays lenient (trailing-XML extraction unchanged): stray prose before a valid trailing block still parses. Strict wording teaches; lenient parsing catches.
- No parser, controller, reask-count, or budget behavior changes.

## Capabilities

### New Capabilities

- `decision-response-contract`: requirements for the wording of the watchdog decision response prompt—the pure-XML response shape, field-level reasoning framing, and unchanged lenient parser acceptance.

## Impact

- `src/decision-protocol.ts`: `buildDecisionPrompt` suffix wording; three error constants; `DECISION_TOOL_BLOCK_REASON`.
- Tests asserting the current suffix/error strings updated in the same change.
