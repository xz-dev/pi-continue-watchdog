## 1. Contract first

- [x] 1.1 Grep `test/` and `src/` for hardcoded rule-8 / stop-reason-independence / error-string assertions and list every site that must change with the contract; verify list is complete before editing
- [x] 1.2 Amend `docs/behavior-contract.md` rule 8 to the three-outcome matrix (success → decision; terminal error → auto unlock; abort → immediate unlock), fixing its abort claim; update matching acceptance criteria; verify the contract reads coherently end-to-end
- [x] 1.3 Update acceptance tests to the new matrix (terminal error → auto unlock, no fence; success → decision; abort → immediate unlock; retry-in-flight → no action); verify they fail against the old runtime as expected

## 2. Runtime gate

- [x] 2.1 Implement terminal-outcome classification at the settled decision point using the tracked final assistant message via `hasAssistantStopReason`; verify `npx tsc --noEmit` passes
- [x] 2.2 Route terminal-error settlements to auto unlock through the controller unlock flow (authoritative unlock → cleanup → effects → notify), skipping the fence and decision entirely; verify the new acceptance tests pass
- [x] 2.3 Record the auto unlock with a distinct automatic reason in the timeline/entries; verify the record is distinguishable from manual unlock in tests
- [x] 2.4 Verify non-error settlements and retry-in-flight runs are untouched (existing decision/fence tests still green); add fallback test: error surfaced without a `stopReason: "error"` final message → normal decision, no auto-unlock

## 3. Docs and verification

- [x] 3.1 Update README behavior description with the three-outcome matrix
- [x] 3.2 Run `npm run check` and fix all findings before commit
