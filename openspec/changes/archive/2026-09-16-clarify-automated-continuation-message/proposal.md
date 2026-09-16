## Why

Pi serializes extension custom messages as provider-facing user-role messages. The current continuation text is a bare imperative, so a model can mistake an automated watchdog continuation for a direct user request, approval, confirmation, or authorization.

## What Changes

- Replace the bare automatic continuation with an explicitly extension-authored continuation message.
- Include the accepted watchdog `reason_type` and `reason_content` in the continuation so the resumed agent knows why work remains.
- State that the continuation is not a user message, request, approval, confirmation, or authorization.
- Restrict resumed work to actions already requested and authorized by the user, and require the agent to stop when further user input or approval is needed.
- Preserve configurable continuation guidance while wrapping it in the fixed attribution and safety contract.
- Add provider-facing tests that assert the exact user-role serialization and non-authorization wording.

## Capabilities

### New Capabilities
- `automated-continuation-message`: Defines attribution, reason propagation, authorization boundaries, and configurable guidance for automatic continuation turns.

### Modified Capabilities

None.

## Impact

- Affects continuation message construction and context folding in `src/runtime.ts` and `src/context-fold.ts`.
- Affects the default and configured `continuePrompt` contract in `src/config.ts` and configuration tests.
- Extends context-fold, runtime, and packed/cross-process provider-payload tests.
- Requires behavior-contract and architecture documentation updates.
- No new dependency or public command is introduced.
