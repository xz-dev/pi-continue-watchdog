## 1. Interrupted attempts owe no audit

- [x] 1.1 Add a failing `readReviewHistory` test for preempted/invalidated attempts with and without a neutralized assistant; confirm it fails on `partial`.
- [x] 1.2 Skip the response-audit requirement for preempted/invalidated folds in `src/review-context.ts`; replay real sessions (23 warnings → 0).
- [x] 1.3 Update `watchdog-review-history.idea.lean` with `interrupted_owes_no_audit`; typecheck and run it.

## 2. Disclose history gaps once with correct attribution

- [x] 2.1 Add a runtime test where a re-ask rereads unchanged history and a later healthy record follows the gap; confirm it fails on duplicate cards and on `records.at(-1)` attribution.
- [x] 2.2 Deduplicate by diagnostic and attribute to the first affected exchange in `reportReviewHistory`.

## 3. Disclose subagent invalidation of a submitted inquiry

- [x] 3.1 Add a runtime test: activity before submission is silent, after submission one card, repeated activity no extra card; confirm the submitted guard is load-bearing.
- [x] 3.2 Append the `Other error` status in the process-domain subscription when a submitted owned inquiry is invalidated.

## 4. Verify

- [x] 4.1 Update `docs/behavior-contract.md`.
- [x] 4.2 Run `npm run check` (476 tests pass) and `openspec validate quiet-interrupted-review-history --strict`.
