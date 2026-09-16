## Why

The decision prompt currently lets unfinished work dominate classification, so the model may first choose `WORK_REMAINS` even when no action can proceed without explicit user input or approval. This causes an unnecessary automatic continuation before the next watchdog check correctly returns `WAIT_USER`.

## What Changes

- Define an explicit, ordered decision policy for continue, wait, completed, user-blocked, and other-blocked outcomes.
- Require `WAIT_USER` whenever no concrete next action can run without additional user input, approval, confirmation, authorization, credentials, or another user action.
- State that unfinished work alone is insufficient for `continue_watchdog`.
- Permit `continue_watchdog` only when at least one concrete next action is immediately executable without new user input or approval, and require its reason to identify that action.
- Preserve `wait_watchdog` for temporary external/time-based waiting that requires no user action.
- Preserve parser behavior, reason validation, configured reason-type lists, retry accounting, and continuation-message safety behavior.
- Add prompt-contract and packed provider-facing regression coverage for approval-gated work.

## Capabilities

### New Capabilities

None.

### Modified Capabilities
- `decision-response-contract`: Add mutually exclusive outcome-selection priorities and an immediately-executable-action requirement for continue decisions.

## Impact

- Changes the fixed decision suffix built by `src/decision-protocol.ts`.
- Extends decision-protocol unit tests and packed E2E decision-request assertions.
- Updates behavior-contract and architecture documentation; the authoritative Lean process model must remain synchronized if its decision process is affected.
- No configuration key, command, parser, dependency, or persisted data format changes.
