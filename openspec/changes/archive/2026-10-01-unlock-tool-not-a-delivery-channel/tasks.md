## 1. Tool text

- [x] 1.1 Append the delivery-boundary sentence to `UNLOCK_TOOL_DESCRIPTION` and to the first `UNLOCK_TOOL_PROMPT_GUIDELINES` entry, and rewrite `UNLOCK_REASON_DESCRIPTION` in `src/unlock-tool.ts`. Verify with new assertions in `test/unlock-tool.test.ts` that match "not a delivery channel" / "may not see" and that none of the texts claims the user cannot see the arguments.
- [x] 1.2 Add one sentence to the unlock-tool section of `README.md`. Verify by reading it against spec.md.

## 2. Verification

- [x] 2.1 Run `npm run check` and confirm it passes.
