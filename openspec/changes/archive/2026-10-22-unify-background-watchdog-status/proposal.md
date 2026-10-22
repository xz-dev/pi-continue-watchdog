## Why

Continue and Reflect now execute private inquiries in the background, but their existing below-editor status rows do not explain the current private stage. Continue adds a separate coarse checking panel while Reflect mainly exposes accounting, leaving users unable to tell what a long wait means.

## What Changes

- Establish one joint presentation contract, tracked by this Continue change and implemented by matching changes in both repositories.
- Use each plugin's existing single below-editor row, not terminal/session tabs, a replacement footer, or another panel. Fold Continue's separate checking panel into its row.
- Highlight a row while its own background operation is active; retain text that distinguishes ordinary root/subagent activity from private watchdog work.
- Show observed stages, total operation elapsed time, applicable result-attempt counts, safe helper names, and Continue's optional review/reconsideration. Update stages on events and elapsed time at a one-second cadence under a responsive host.
- Preserve Continue's enabled state and effective unlock hint, and Reflect's existing active/task/root/all counters, cooldown and queued-withdrawal hint. Use the same responsive priority and theme semantics in both rows.
- Keep progress ephemeral and private: no transcript, prompt, thinking, raw response, tool arguments or result-file paths. Preserve execution, accounting, result publication and cancellation policy.

## Capabilities

### New Capabilities

- `watchdog-background-status`: Canonical joint status-row contract plus Continue-specific background decision/review progress, exact-operation fencing, and cross-plugin acceptance scenarios.

### Modified Capabilities

None. Existing outcome timeline, private execution, accounting and cancellation requirements remain unchanged; this capability adds human-only live progress.

## Impact

- Continue: `src/runtime.ts` status projection, below-editor widget, private decision callbacks and optional review; `src/private-decision.ts` observation forwarding if needed; existing runtime/rendering/private-decision tests.
- Reflect companion: `pi-reflect-watchdog`, change `unify-background-watchdog-status`, with its own proposal, design, `watchdog-background-status` delta and tasks.
- Main tracking point: [this change's tasks](tasks.md) and [canonical contract](specs/watchdog-background-status/spec.md). Companion proposal: [Reflect](../../../../pi-reflect-watchdog/openspec/changes/unify-background-watchdog-status/proposal.md).
- Reuse Pi widget/render/theme APIs and available exact-child observations. No new package, configuration, public command, scheduling protocol, or production code is introduced by this planning change. Joint completion requires both repositories and an integrated TUI acceptance check, not Continue tests alone.
