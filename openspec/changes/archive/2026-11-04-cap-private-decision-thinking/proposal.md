## Why

Each private decision runs in a full fork that uses the main session's thinking level. When the main session uses `high`, `xhigh` or `max`, a short continue/unlock judgment pays that reasoning cost and latency again on every decision. A judgment of this kind does not need more than `medium`.

## What Changes

- The private decision child uses the parent's thinking level capped at a configured ceiling. The level can only go down, never up.
- New configuration key `decisionThinkingCap`: `"inherit"` or one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Default is `"medium"`.
- `"inherit"` keeps the current behavior. This is the escape hatch for providers where a thinking change invalidates the prompt cache of the inherited conversation (for example Anthropic).
- **BREAKING** (default behavior): with no configuration, a parent at `high`, `xhigh` or `max` now gets a `medium` child. Before, the child used the parent's level.
- The main session's thinking level does not change. Staleness checks still compare against the main session's level.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `watchdog-private-fork-decisions`: the child uses the parent's provider/model and the parent's thinking level capped by `decisionThinkingCap`, instead of always using the parent's level.
- `watchdog-configuration`: add `decisionThinkingCap` to the effective configuration keys, with its validation and precedence.

## Non-goals

- Provider-specific rules (for example, never capping on Anthropic).
- Showing the effective child level in status rows or audit records.
- Raising a level above the parent's level.
- Changing the external unlock-review service model.

## Impact

- Code: `src/runtime.ts` (private-decision fork model string), `src/config.ts` (new key, validation, built-in default).
- Tests: `test/private-runtime.test.ts` (the parent is at `high`; its fork assertion changes), `test/runtime.test.ts`, `test/config.test.ts`.
- Docs: `README.md`, `docs/behavior-contract.md`, Lean model `docs/programming-thinking/official-pi-idle-inquiry.idea.lean` (fork thinking theorem).
- Cost: on Anthropic, a capped child can miss the parent's prompt cache for the inherited prefix. Users set `inherit` when this costs more than the reasoning it saves.
