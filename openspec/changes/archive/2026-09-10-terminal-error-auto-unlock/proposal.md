## Why

When a run ends in a terminal error (Pi's automatic retries exhausted, e.g. repeated network/provider failure), the locked watchdog still enters the 10-second fence and continue/wait/unlock decision. Auto-continuing after a final failure is wrong: there is no healthy trajectory to resume, and the human should reclaim control. Contract rule 8 currently mandates stop-reason-independent recovery, and its text already diverges from reality for aborts (which unlock immediately today); both the runtime and the contract need alignment.

## What Changes

- Terminal outcome gate at the settled decision point: when the settled run's final assistant message reports `stopReason: "error"`, the locked watchdog SHALL automatically unlock (with a clear notification) instead of starting the inquiry fence and decision stage.
- Normal success settlement keeps today's continue/wait/unlock decision unchanged; actual user abort keeps today's immediate unlock; while Pi is still auto-retrying the run is busy and no decision is considered (unchanged).
- `docs/behavior-contract.md` rule 8 and related acceptance sections are amended to the three-outcome matrix (success → decision; terminal error → auto unlock; abort → immediate unlock) **before** runtime changes, since it is the authoritative ATDD contract.
- Existing abort, wait, decision, folding, and cross-process behaviors are untouched.

## Capabilities

### New Capabilities

- `terminal-outcome-gate`: Settled-run terminal outcome classification that routes terminal errors to automatic unlock and successful settlements to the existing decision stage.

### Modified Capabilities

None at the openspec level. The authoritative behavior change lands in `docs/behavior-contract.md` (rule 8 + acceptance criteria), which is amended as part of this change; `decision-response-contract` and `watchdog-waiting-hook` openspec requirements are unaffected.

## Impact

- `src/runtime.ts`: settled-decision gate on final assistant `stopReason` (existing `hasAssistantStopReason` helper), auto-unlock path reusing the controller unlock flow with a typed/derived reason, notification.
- `docs/behavior-contract.md`: rule 8 rewrite + acceptance criteria updates (contract-first).
- Tests: acceptance tests updated to the new matrix first, then runtime tests for error-settlement auto-unlock, success-settlement decision preserved, retry-in-flight never gated, stale-settlement guards.
- README: behavior matrix documentation.
- No config additions, no protocol/XML changes, no Pi host changes.
