## Why

Continue and Reflect already write their private fork conversations to native session JSONL, but terminal failures do not give users a reliable way to find that evidence. Retaining the failed session and disclosing its real path lets users inspect failures and improve both plugins without dumping private exchanges into the main conversation.

## What Changes

- Establish one joint failure-diagnostics contract, tracked by this Continue change with a matching Reflect companion.
- For final private inquiry execution failures or exhausted invalid-result corrections, preserve the exact child's existing JSONL and show a bounded human-only diagnostic with its verified absolute session path.
- Distinguish an available session from a session that was never created or could not be retained; never advertise a missing file as saved.
- Exclude normal success, intermediate invalid responses that later succeed, expected cancellation, user takeover and stale operations from the new path notification. Preserve existing intermediate correction warnings.
- Keep temporary result-file cleanup, retry/accounting limits, main-session isolation and outcome authority unchanged. Retained JSONL is diagnostic evidence, not a recovery or authorization input.
- Extend the shared private-inquiry result metadata only as needed to carry the actual session locator and its availability; use the existing native fork storage, not a second logging system.

## Capabilities

### New Capabilities

- `watchdog-inquiry-diagnostics`: Canonical joint contract for final-failure session retention, truthful human-only path disclosure, unavailable-evidence handling and cross-plugin acceptance scenarios.

### Modified Capabilities

None. This adds a separate diagnostic capability without changing private decision validity, continuation policy, review behavior or ordinary outcome publication.

## Impact

- Continue: `src/private-decision.ts`, terminal result handling in `src/runtime.ts`, existing private-decision/runtime tests and user documentation during implementation.
- Shared prerequisite: `pi-extension-utils/private-inquiry` result metadata and cleanup tests; its private runtime must preserve any known fork locator across setup failure. Both consumers currently pin the same utils revision and must consume the compatible shared change.
- Reflect companion: [proposal](../../../../pi-reflect-watchdog/openspec/changes/retain-failed-watchdog-sessions/proposal.md), its `src/extension.ts` terminal handling and existing private-reflection tests.
- Joint tracking: [tasks](tasks.md) and [canonical contract](specs/watchdog-inquiry-diagnostics/spec.md). Completion requires shared-layer and both-consumer checks, including an integrated user-visible failure example.
