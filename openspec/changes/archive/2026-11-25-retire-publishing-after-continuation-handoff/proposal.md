## Why

Continue can tell the user it is still publishing a decision long after its continuation reached the main session. In a live `cooker` run the widget reached `publishing · 1016s · attempt 1/3` while the main session was already making tool calls. The two indicators make normal work look like a second, stuck model request.

## What Changes

- Retire the private `publishing` stage, elapsed time and attempt counter when the exact continuation handoff is observed, without waiting for the resumed main run to finish. Keep the ordinary watchdog activity, lock state and shortcut visible.
- Clear obsolete progress when a pending publication loses its owner. Do not treat disappearance of the widget, a busy root or a successful send call as proof of delivery.
- Cover the observed ordering (main run starts, a system entry precedes the continuation, then tools run) and the competing case of an unrelated user run. Neither case may resend the continuation or grant authority to abort an unrelated run.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `watchdog-background-status`: define exactly when the private publication indicator ends at the transition to main-session work.

## Impact

The change affects the Continue runtime's publication/ownership callbacks and existing widget and handoff tests. It does not change JEV, Reflect, Herdr, model settings, the continuation payload, persisted history format, or the lock and budget policies. No migration or new dependency is needed.
