## Why

Agents sometimes put their actual answer, report, or question into the `reason` argument of `unlock_continue_watchdog` and leave the reply text empty. That argument is not a reliable way to reach the user: TUI rendering shows it only on one compact line, and whether notifications show it depends on the consumer. Nothing in the tool's model-facing text says that the tool only stops the automatic continuation.

## What Changes

- The tool description, the session-stable prompt guideline, and the `reason` parameter description each state that the tool only stops the automatic continuation and is not a delivery channel. Everything the user needs goes in the normal reply text before the call, and the agent must not rely on the user seeing the tool arguments.
- The wording says "must not rely on", not "cannot see", because `reason` does appear in the TUI result line and in pi-notify's Pi Done/Wait/Blocked notifications.
- No behavior, schema shape, validation, or hook change.

Non-goals: hiding `reason` from the TUI or from notifications; changing reason types or limits.

## Capabilities

### New Capabilities
- `unlock-tool-delivery-boundary`: the model-facing statement that the unlock tool is not a user-delivery channel.

### Modified Capabilities
<!-- None: `ai-unlock-tool` exists only in the unarchived change `replace-decision-inquiry-with-unlock-tool`; this change adds a sibling requirement instead of modifying it. -->

## Impact

- `src/unlock-tool.ts`: `UNLOCK_TOOL_DESCRIPTION`, `UNLOCK_TOOL_PROMPT_GUIDELINES[0]`, `UNLOCK_REASON_DESCRIPTION`.
- `test/unlock-tool.test.ts`: assertions for the new sentences.
- `README.md`: one sentence in the unlock-tool section.
- The tool text changes once per release. The prompt prefix stays stable within a session.
