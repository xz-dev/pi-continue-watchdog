## Context

Pi's `convertToLlm` transformation maps custom messages to provider-facing user-role messages. The watchdog intentionally uses custom messages so it can correlate, hide, and fold an inquiry exchange, but a bare continuation imperative loses source semantics at the provider boundary.

The accepted continue result already contains normalized `reasonType` and `reason` values. Runtime persists and publishes them, while the folded continuation currently retains only the configured `continuePrompt`. The implementation must preserve inquiry correlation, append-only session behavior, zero-loop history, and configuration precedence.

## Goals / Non-Goals

**Goals:**
- Build one canonical continuation body from the accepted continue result and effective configured continuation guidance.
- Keep fixed source and authorization-boundary text under extension control.
- Preserve custom-message correlation and existing context-fold replacement behavior.
- Make provider-facing tests assert semantic content after `convertToLlm`.

**Non-Goals:**
- Change Pi's global custom-message-to-user-role conversion.
- Introduce a new message role, provider API, dependency, command, or configuration key.
- Treat the watchdog decision as user authorization.
- Change wait, unlock, invalid-response, retry, or reason-validation behavior.

## Decisions

### Build a canonical envelope around configured guidance

Add one small pure formatter for accepted continuation content. Inputs are effective `continuePrompt`, normalized `reasonType`, and normalized `reason`. Output contains:

1. fixed extension-source attribution;
2. fixed denial of user message/request/approval/confirmation/consent/authorization;
3. a structured model-generated watchdog result containing reason type and reason;
4. configured continuation guidance;
5. a fixed instruction to resume only previously requested and authorized work and stop at any new user-input or approval boundary.

Reason values should use a deterministic escaped representation, such as `JSON.stringify`, rather than interpolation into quoted prose. This keeps multiline or punctuation-heavy configured values unambiguous.

Alternative considered: replace the default `continuePrompt` with a longer static prompt. Rejected because custom configured prompts would remain unsafe and accepted reason data would still be discarded.

Alternative considered: prepend only `"not from the user"`. Rejected because it does not address approval, confirmation, consent, or authorization ambiguity and gives no reason for resumption.

### Keep `continuePrompt` as guidance, not the whole wire message

Retain the existing configuration field and validation rules. Its value becomes the configurable guidance embedded inside the fixed envelope. This avoids a breaking configuration migration while preventing configuration from removing required attribution and safety text.

Alternative considered: add a new prompt-template configuration with placeholders. Rejected as unnecessary configuration and escaping complexity; current requirement needs one fixed format.

### Construct the final body before creating the fold replacement

The runtime should format the final continuation body after validating the accepted continue result, then pass that body through the existing continuation fold path. `createDecisionFoldMessage` remains responsible for inquiry replacement metadata, while the resulting replacement content is exactly what later context conversion sends to the provider.

Alternative considered: reconstruct the reason inside context folding from `watchdogResult`. Rejected because folding should remain a correlation/transformation layer, and the runtime already owns normalized finalization data.

### Test the provider-facing result, not only the custom-message shape

Unit tests should verify formatter output and fold metadata. Context tests must call `convertToLlm` and assert exact role and body semantics. Runtime and E2E tests should verify accepted reason propagation, custom guidance preservation, and absence of raw decision prompt/XML in resumed provider payloads.

Alternative considered: assert only that `convertToLlm` accepts the message. Rejected because the current weak assertion allowed the attribution bug to remain invisible.

## Risks / Trade-offs

- [Longer continuation message consumes more tokens on every accepted continue] -> Keep envelope concise and include only normalized reason fields plus existing guidance.
- [Model-generated reason may contain instruction-like text] -> Label it as model-generated reference, serialize it deterministically, and place fixed authorization rules after it.
- [Existing users may expect `continuePrompt` to be the complete message] -> Preserve its text verbatim as guidance and document the new fixed wrapper as required behavior.
- [Provider models may still overweight the user role] -> Repeat source and non-authorization semantics in the body and test the final provider-facing payload; changing Pi's role mapping remains out of scope.
- [Snapshot-style tests may become brittle] -> Assert exact canonical formatter output once, then use targeted semantic assertions in broader runtime/E2E tests.

## Migration Plan

1. Introduce and test the canonical continuation formatter.
2. Route accepted continue finalization through the formatter before fold dispatch.
3. Update default/config contract documentation without changing config file shape.
4. Update provider-facing and resume E2E assertions.
5. Run full checks and packed/cross-process E2E suites.

Rollback is a source revert: no persisted schema or configuration migration is required. Existing stored fold messages continue to fold using their persisted replacement content.
