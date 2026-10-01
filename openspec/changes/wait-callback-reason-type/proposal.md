## Why

When the agent launches async work that will wake it later (an async subagent, another program's callback), it must end its turn. Today it can only call the unlock tool with `JOB_DONE`, `WAIT_USER`, or `JOB_BLOCKED`, which are all wrong, and every one of them makes notification consumers alert the user although nobody needs to look. Ending the turn without unlocking makes the watchdog continue the agent instead.

## What Changes

- Add `WAIT_CALLBACK` ("waiting for another agent or program to call back and wake you") to the built-in default `reasonTypes`, with its meaning in the `reason_type` description.
- The tool description, the prompt guideline, and the continuation body tell the agent to call the tool with `WAIT_CALLBACK` when the awaited work will call back; other waits still block, monitor, or sleep inside the turn.
- `user-ready` publication is unchanged: `AI_UNLOCK` carries `REASON_TYPE=WAIT_CALLBACK`, and consumers decide whether to stay silent (pi-notify does so with a binding `if`).

Non-goals: a watchdog-side wait state, deadline, or suppression of the `user-ready` hook.

## Capabilities

### New Capabilities
- `wait-callback-reason-type`: the built-in `WAIT_CALLBACK` reason type and the guidance that routes callback waits to it.

### Modified Capabilities
<!-- None. -->

## Impact

- `src/config.ts` (default list), `src/unlock-tool.ts` (meaning, description, guideline), `src/watchdog-event.ts` (continuation body).
- Tests: config, unlock-tool, runtime, observer-only-control, context-fold.
- `README.md`, `docs/behavior-contract.md`. A configured `reasonTypes` list still replaces the defaults, so users with a custom list must add `WAIT_CALLBACK` themselves.
