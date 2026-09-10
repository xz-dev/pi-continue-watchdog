# Tasks: surface-reason-content-limit

## 1. Constants and validation

- [x] 1.1 In `src/decision-protocol.ts`, add exported `MAX_REASON_CHARACTERS = 1000` and derived `REASON_GUIDANCE_CHARACTERS = MAX_REASON_CHARACTERS / 2` with a comment stating the linkage (guidance is always half the hard limit); verify `npm run typecheck` passes.
- [x] 1.2 Change `normalizeDecisionUnlockReason` to reject only above `MAX_REASON_CHARACTERS` (keep non-empty-after-trim rejection); verify via boundary unit test that 1000 code points pass and 1001 fail.
- [x] 1.3 Convert `INVALID_CONTINUE_REASON_ERROR`, `INVALID_WAIT_REASON_ERROR`, `INVALID_UNLOCK_REASON_ERROR` to template literals interpolating `MAX_REASON_CHARACTERS`; verify exported strings quote 1000.

## 2. Prompt disclosure

- [x] 2.1 Append to the fixed suffix in `buildDecisionPrompt`: state that `reason_content` must be non-empty and at most `${REASON_GUIDANCE_CHARACTERS}` Unicode characters; verify a prompt-content unit test finds the guidance sentence with value 500.

## 3. Tests

- [x] 3.1 Update `test/decision-protocol.test.ts` boundary cases (currently `exactly500`/`over500` around line 331) to 1000/1001 and add an acceptance case for a reason between guidance and hard limit (e.g., 700 code points); verify `npm run test` passes.
- [x] 3.2 Verify full suite green: `npm run check` (lint + typecheck + unit + build).

## 4. Documentation

- [x] 4.1 Update `README.md` reason-content wording and `docs/behavior-contract.md` / `docs/architecture.md` limit mentions to the 1000 hard limit plus 500 prompt guidance; verify no stale "at most 500" model-side wording remains (`rg "500" README.md docs/` shows only human-input/display truncations).
- [x] 4.2 Update `docs/programming-thinking/watchdog-user-takeover.idea.lean` bound (`reasonLength ≤ 500` → ≤ 1000) and re-validate the Lean file per the programming-thinking convention.
