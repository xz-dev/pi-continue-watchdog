# Tasks: pure-xml-decision-response

## 1. Prompt and corrective-string wording

- [x] 1.1 In `src/decision-protocol.ts`, replace the "You may explain your decision first, or output only XML..." sentence in `buildDecisionPrompt` with an entire-response requirement (exactly one `<watchdog>` XML document, no text before or after), naming `reason_content` and the other fields as where the reasoning is expressed — verify: updated suffix assertions in tests match the new sentence.
- [x] 1.2 Reword `INVALID_DECISION_XML_ERROR`, `UNSUPPORTED_DECISION_CONTENT_ERROR`, and `MALFORMED_DECISION_RESPONSE_ERROR` to the same entire-response contract while keeping their diagnostic distinctions — verify: constants contain no "at the very end" prose-first phrasing.
- [x] 1.3 Reword `DECISION_TOOL_BLOCK_REASON` to the same contract while keeping the no-tools instruction — verify: string states the full-response XML requirement.

## 2. Tests

- [x] 2.1 Update tests asserting the current suffix/error strings, and add assertions that the suffix contains no "You may explain" / "at the very end" phrasing — verify: `npm test` in the repo passes.

## 3. Integration verification

- [x] 3.1 Run the full unit test suite and the repo's check/build commands — verify: `npm test` and the repo's typecheck/build steps exit cleanly (`npm run check` exit 0).
