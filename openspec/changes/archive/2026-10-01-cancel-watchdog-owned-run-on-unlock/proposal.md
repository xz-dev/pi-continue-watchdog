## Why

Manual unlock currently disables future watchdog decisions but leaves an already-running watchdog decision or automated continuation alive. By the time the UI reports the watchdog as unlocked, that owned run can still stream output, execute more work, and leave an abort residue, so unlock does not reliably return control to the user.

## What Changes

- Make manual unlock and the configured unlock shortcut an ownership-aware cancellation boundary.
- Abort the current run only when it is precisely identified as a watchdog-owned decision or automated continuation.
- Preserve the currently running ordinary user-started run when it is not watchdog-owned; queued-message behavior remains governed by Pi's abort semantics.
- Remove partial assistant output, `Operation aborted` presentation, and future-context residue from the cancelled watchdog-owned run without starting another model turn.
- Suppress duplicate abort-driven unlock handling and keep the final watchdog state unlocked.
- Document that cancellation does not roll back completed tool side effects or guarantee termination of detached/background work.

## Capabilities

### New Capabilities
- `watchdog-owned-run-cancellation`: Defines ownership-aware cancellation and residue cleanup when a human unlocks during a watchdog-owned run.

### Modified Capabilities
- `unlock-shortcut`: Requires the shortcut to retain command-equivalent cancellation behavior while remaining inert toward ordinary user-started runs.

## Impact

- Affects manual command and shortcut handling in `src/commands.ts` and `src/extension.ts`.
- Extends runtime ownership tracking and terminal cleanup in `src/runtime.ts`, `src/context-fold.ts`, and abort outcome coordination.
- Adds focused unit/integration coverage for decision cancellation, continuation cancellation, ordinary-run preservation, duplicate unlock suppression, and residue removal.
- Requires updates to the behavior contract, architecture documentation, and the authoritative Lean process model under `docs/programming-thinking/` during implementation.
- Uses existing public Pi extension APIs; no new dependency or configuration key is expected.
