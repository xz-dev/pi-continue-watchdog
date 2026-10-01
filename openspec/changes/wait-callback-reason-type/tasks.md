## 1. Implementation

- [x] 1.1 Add `WAIT_CALLBACK` to `DEFAULT_REASON_TYPES` in `src/config.ts` and its meaning to `KNOWN_REASON_TYPE_MEANINGS` in `src/unlock-tool.ts`. Verify with the config and unlock-tool default-list tests.
- [x] 1.2 Mention callback waits in `UNLOCK_TOOL_DESCRIPTION`, the wait guideline, and `formatContinueWatchdogEvent`. Verify with the unlock-tool guideline test, the runtime continuation-body test, and the exact context-fold body test.
- [x] 1.3 Update `README.md` and `docs/behavior-contract.md` (defaults, meanings, tool description, waiting). The Lean models do not enumerate reason types, so they need no change.

## 2. Verification

- [x] 2.1 `npm run check` passes.
