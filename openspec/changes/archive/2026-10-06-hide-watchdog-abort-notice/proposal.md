## Why

Esc already cancels watchdog-owned work and unlocks the watchdog as intended. Pi's additional `Operation aborted` notice is the only unwanted behavior; changing cancellation, unlock, or output-cleanup semantics would exceed the request.

## What Changes

- Hide Pi's assistant-level abort notice in the finalized presentation of a natively aborted run precisely correlated to a watchdog decision, correction, or automated continuation. The user accepts a brief streaming notice before finalization; zero-transient visibility is not required.
- Preserve the existing abort outcome and automatic unlock behavior, including its normal notification and terminal handling. Presentation suppression must not turn cancellation into successful completion or another continuation.
- Preserve the current treatment of assistant content: no additional removal of partial continuation output, tool results, or unrelated history. Existing internal-decision hiding remains unchanged.
- Leave Esc handling, double-Esc behavior, Alt+U, `/unlock-continue-watchdog`, ordinary user-run aborts, and terminal errors unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `watchdog-owned-run-cancellation`: Add a narrow native-abort presentation requirement, distinct from the existing manual-unlock path that removes owned-run cancellation residue.

## Impact

- Implementation area: `src/runtime.ts` for exact owned-run recognition and blank finalized abort text. Keep `stopReason: "aborted"` and reuse `src/abort-outcome.ts` unchanged; no shadow abort state or new extension wiring is needed.
- Verification: focused cases in the existing runtime/abort lifecycle tests, plus a host-rendering check proving that the finalized notice is absent while automatic unlock still occurs. Record earlier streaming notices as diagnostics, not failures. No new test framework is needed.
- During implementation, reconcile the affected behavior documentation and existing `docs/programming-thinking/*.idea.lean` claims with the distinction between a real abort and its presentation. This proposal does not change those shipped-behavior documents or claim implementation is complete.
- No new keybinding, configuration option, dependency, Pi fork requirement, private host-queue access, or change to `terminal-outcome-gate` semantics.
