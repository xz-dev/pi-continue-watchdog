## Why

Sometimes the main agent ends its turn with a question for the user but does not call `unlock_continue_watchdog`. The watchdog then sends a continuation anyway. That wastes a turn, and it can push the agent to answer its own question or go ahead without the user's decision. TypeSafe's jev model can do this classification cheaply, and many users already have a TypeSafe or OpenRouter key for pi-jev-todo-audit.

## What Changes

- Add a jev check before an automatic continuation is sent. It runs after the existing 10-second idle fence qualifies and before one continuation would be sent. It looks at the text of the final assistant message and asks jev one Choice question: is this message clearly waiting for a user answer?
- If jev answers `waiting_user` with confidence at or above the threshold (default 0.8), the watchdog unlocks without consuming a retry attempt. It publishes `user-ready` with `STOP_KIND=AI_UNLOCK`, `REASON_TYPE=WAIT_USER`, and a `REASON` that says jev judged the output to be a question for the user and quotes the last paragraph of that output. The existing pi-notify config shows this as `Pi Wait`.
- The check is on by default whenever a TypeSafe or OpenRouter key can be resolved. With no key it makes no request and behavior is unchanged. A new `jevWaitCheck` config section can disable it or tune it.
- The check fails open. Any error, timeout, malformed answer, `unclear` answer, low confidence, or state change during the request leads to the existing continuation path, unchanged.
- No new fixed delay is added. The race with pi-jev-todo-audit, or any other wake-up during the request, is handled by re-checking state after the await.

Non-goals:
- A cross-plugin pre-continue veto protocol.
- A `DECIDED_BY` hook field for suppressing the pi-jev-todo-audit terminal check. jev-todo-audit already handles waiting states.
- Starting the jev request at the beginning of the idle fence, in parallel with it.
- Letting jev choose which paragraph to quote.
- A timeline or `/status` record of jev verdicts.

## Capabilities

### New Capabilities
- `jev-wait-user-gate`: when a jev classification of the final assistant output runs before an automatic continuation; key resolution and default enablement; the fail-open rules; the unlock and `user-ready` values it produces; its configuration.

### Modified Capabilities
<!-- None. The direct-continuation requirement ("no decision question ... SHALL precede it") belongs to the not-yet-archived change `replace-decision-inquiry-with-unlock-tool`. This change states its exception in the new capability. Archive that change first. -->

## Impact

- `src/runtime.ts`: `qualifyReady` awaits the gate before `dispatchContinuation`, re-checks state after the await, and adds a jev-unlock path that reuses `recordAiUnlock` and `pendingUnlock`.
- New `src/jev-wait-gate.ts`: key resolution, one TypeSafe Choice request, response parsing, and excerpt building.
- `src/config.ts`: the new `jevWaitCheck` section. `apiKey` is accepted only at the global layer.
- Network: while the check is enabled, the text of the final assistant message is sent to TypeSafe or OpenRouter. This is documented in the README.
- Docs: `README.md`, `docs/architecture.md`, `docs/behavior-contract.md`, and `docs/programming-thinking/official-pi-idle-inquiry.idea.lean`.
- No new runtime dependency; the request uses global `fetch`. The watchdog does not import pi-jev-todo-audit.
