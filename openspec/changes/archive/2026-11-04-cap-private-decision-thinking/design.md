## Context

The private decision fork receives one model string, `provider/id:level`. It is built in `startPrivateDecision` (`src/runtime.ts`) from `ctx.model` and `pi.getThinkingLevel()`. The same function captures `sourceThinking` and invalidates the decision when the main session's level changes. Every inquiry of one logical decision (initial, correction, review reconsideration) runs in that one child, so the fork string is the only place where the level is chosen.

Configuration lives in `src/config.ts`: the `ContinueWatchdogConfig` interface, `BUILT_IN_CONFIG`, `KNOWN_KEYS`, `copyBuiltIn`, per-field validation in the layer parser, and layer merge. `unlockReviewEnabled` is the closest existing pattern.

Pi thinking levels are `off | minimal | low | medium | high | xhigh | max` (`ModelThinkingLevel` in pi-ai).

## Goals / Non-Goals

**Goals:**
- One pure mapping `(parentLevel, cap) -> childLevel`, used only for the fork model string.
- Keep main-session staleness checks on the uncapped main level.

**Non-Goals:**
- Clamping to the model's supported levels. The host already does this when it applies the fork's level.
- Recording the child level in audit records or status rows.

## Decisions

1. **Cap, not a fixed level.** `child = cap === "inherit" || rank(parent) <= rank(cap) ? parent : cap`. A fixed level would raise `off`/`low` parents and add cost. Rejected.
2. **Configurable, default `medium`.** The motivation is cost and latency. On Anthropic, a changed thinking setting invalidates the cached message prefix (Anthropic prompt-caching docs), so in a long session a capped child can cost more than an inheriting one. `inherit` lets the user choose without a code change. The alternative, provider-specific rules, puts provider cache semantics into the plugin and goes stale. Rejected.
3. **Strict string validation.** Values must match exactly; there is no trimming or case folding. Invalid values produce a diagnostic and keep the lower-precedence value, the same as `maxContinue`. This keeps "accepted but has no effect" impossible.
4. **Level order lives next to the mapping.** A local ordered array in the module that owns the mapping. Pi does not export a usable rank helper, so the plugin does not import pi internals for this.
5. **Unknown parent level passes through.** If `getThinkingLevel()` returns a value outside the known order (a future pi level), the child uses the parent level unchanged. Unknown input never makes the watchdog invent a level.

## Risks / Trade-offs

- [Default `medium` misses the Anthropic prompt cache on long sessions and raises cost] → README explains the trade-off and the `inherit` setting. Users measure and choose.
- [Default behavior changes for existing `high`+ users] → It is listed as BREAKING in the proposal and in the README change notes. `inherit` restores the old behavior exactly.
- [Lower reasoning gives worse continue/unlock judgments] → The existing unlock review and format correction still apply. Users who see worse judgments raise the cap or set `inherit`.
- [Contract docs and the Lean model state "same thinking"] → The tasks update the README, the behavior contract and the Lean theorem together with the code.

## Migration Plan

No data migration. Rollback: set `decisionThinkingCap: "inherit"`, or revert the change.
