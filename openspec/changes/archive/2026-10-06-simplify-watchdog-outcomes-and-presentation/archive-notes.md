# Archive reconciliation — 2026-10-06

The owner confirmed syncing and archiving both completed changes, followed by a signed commit and normal push to `origin/master`:

- `align-unlock-tool-with-reflection-contract` (18/18 tasks)
- `simplify-watchdog-outcomes-and-presentation` (28/28 tasks)

The successor's implemented continue/unlock contract takes precedence over the predecessor's superseded three-outcome and shared-unlock presentation. The archived deltas remain historical records; they must not be blindly reapplied together.

## Effective spec selection

| Predecessor capability | Resolution |
| --- | --- |
| `ai-unlock-tool` | Retain stable registration, minimal declaration and authorized terminal unlock. Reconcile its old shared-unlock paragraph with the successor's human-only status and receipt-confirmed cleanup; remove obsolete waiting-state wording. |
| `unlock-tool-delivery-boundary` | Apply guarded, inquiry-only control submission and ordinary-answer delivery boundaries. Update Purpose to remove the retired proactive function name. |
| `watchdog-owned-run-cancellation` | Apply exact-run cancellation and current-attempt revocation, preserving unrelated runs, bounded cleanup and host-owned queues. Drop the obsolete pending-wait-deadline clause. |
| `watchdog-configuration` | Apply the predecessor's credential non-interference requirement and still-valid scenarios, then the successor's effective-key and continuation-only budget contract. |
| `jev-unlock-reason-review` | Retire the entire main capability, including its Purpose: external permission review is no longer implemented. Authorized by the predecessor's `retire_capabilities: true`. |
| `jev-wait-user-gate` | Retire the entire main capability, including its Purpose: external pre-continuation classification is no longer implemented. Same retirement authorization. |
| `automated-continuation-message` | Superseded delta sync skipped; use the successor's actionable, attributed continuation contract while retaining unaffected main requirements. |
| `decision-response-contract` | Superseded delta sync skipped; introduce the successor's complete guarded two-outcome contract instead of merging duplicate ADDED three-outcome definitions. |
| `terminal-outcome-gate` | Superseded delta sync skipped; use the successor's settlement contract, preserve the true-settlement guard and correct the stale Purpose. |
| `wait-callback-reason-type` | Superseded delta sync skipped; use the successor's callback unlock without polling, watchdog deadlines or retry charges. |
| `watchdog-event-timeline` | Superseded delta sync skipped; use the successor's split shared/UI-only visibility and native projection contract, and correct the old shared-timeline/wait-timing Purpose. |
| `watchdog-semantic-hooks` | Superseded delta sync skipped; use the successor's continued/user-ready set, preserving silent human/abort paths and optional consumers. |
| `watchdog-waiting-hook` | Sync skipped: the old proposed producer has been removed. No main capability is created. |

All seven successor delta paths are applied. Their 38 requirement operations were compared against the effective main specs, including removals. Unmentioned main requirements and still-valid scenarios are retained. The successor's configuration delta explicitly retains the predecessor's `Restored decision configuration` and `Old config with jevWaitCheck` scenarios so later MODIFIED replay cannot remove them. The result updates nine main specs, creates `decision-response-contract`, and removes the two retired Jev specs. No empty Requirements section or new waiting-hook capability is left behind.

Standalone revalidation of the historical predecessor against the already merged successor reports missing newer scenarios, as expected: that old delta is no longer a valid patch to the current main specs. Its superseded portions are not reapplied or rewritten to pretend otherwise. Archive acceptance uses the effective selection and cross-capability overrides above, current main-spec validation, and the reconciled successor validation.

The shared-failure/exhaustion and legacy-read-only contracts remain intact. No runtime, test or executable process-model bytes were changed by this reconciliation; the accepted authoritative Lean SHA256 remains `1df4cd0d8d9a46e6f16b8d0a9f5baa64b2fd60e4a62ac6579befc4d9a5c02629`. This materializes already accepted behavior rather than adding a new behavioral or formal-model change.

## Evidence and recovery

The completed implementation and residual-risk evidence remains in `tasks.md`. Historical A15d uncertainty, unmeasured model efficacy and the disclosed R4 fixture-install deviation are not removed by archiving.

Task-local reconciliation inputs, draft hashes and original main-spec backup are retained under `/var/tmp/watchdog-archive-20261006/`. The retired Jev specs, including their former Purpose sections, can also be recovered from the pre-archive Git baseline if explicitly needed:

```sh
git restore --source=6c346b2 -- "openspec/specs/jev-unlock-reason-review/spec.md" "openspec/specs/jev-wait-user-gate/spec.md"
```

That is recovery guidance, not a recommendation to restore obsolete behavior. No release, tag, dependency upgrade, real-user installation or reload is part of this archive/commit/push operation.
