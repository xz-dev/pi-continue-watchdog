## Why

An accepted `wait_watchdog` decision changes the watchdog into a timed waiting state, but the producer exposes no authoritative semantic event for notification consumers. Local configuration therefore cannot report the wait without inferring private state or confusing it with typed automatic continuation.

## What Changes

- Publish a `watchdog-waiting` semantic hook exactly once after a valid wait decision is durably recorded.
- Include the validated wait reason as `REASON` and the accepted duration as decimal-string `WAIT_SECONDS`.
- Keep invalid, stale, preempted, rolled-back, and persistence-failed waits silent.
- Preserve final-attempt deadline semantics: waiting is reported immediately, while `user-ready / EXHAUSTED` remains delayed until the full wait expires.
- Keep listener absence and failure isolated from wait state, folding, timers, and later scheduling.

## Capabilities

### New Capabilities
- `watchdog-waiting-hook`: Publishes an authoritative best-effort semantic signal for each durably accepted timed wait.

### Modified Capabilities

None.

## Impact

- Affects `src/semantic-hook.ts`, the accepted-wait finalization seam in `src/runtime.ts`, focused semantic-hook/runtime tests, packed acceptance coverage, and notification documentation.
- Uses the existing `pi:semantic-hook:v1` channel and current producer helper; no new dependency, command, configuration field, or XML field is introduced.
- Remains consumer-neutral and does not import or identify pi-notify.
