## 1. Reproduce the handoff

- [x] 1.1 Add a regression in `test/runtime.test.ts` with the existing private driver, widget and fake clock. Defer branch visibility across send, then drive main start, host system bookkeeping and the matching continuation. Keep the main run busy; assert the old stage, timer and attempt have gone before any tool call or settle while ordinary running/enabled controls remain. Run it against the baseline and record the failing assertion; if it does not fail, verify the host's event order in an isolated session before editing the runtime.
- [x] 1.2 Exercise the complementary receipt-first and foreign-takeover sequences in the same harness. Verify expected ownership with the existing manual-unlock path: only the correlated continuation is an abort target; an unrelated user's run and a successor's visible progress are untouched.

## 2. Fix publication progress retirement

- [x] 2.1 Preserve pending continuation correlation across neutral host system bookkeeping without admitting foreign input. Verify the ordered handoff regression recognizes the exact continuation once; a mismatched exchange or cycle cannot claim the run.
- [x] 2.2 End private progress on a matching handoff or positive receipt, and clean up the old row when its pending record is discarded. Verify immediate redraw without waiting for `agent_settled`, repeated callbacks are harmless, and genuine review/cancellation-drain stages still display.
- [x] 2.3 Verify business side effects independently of the widget: one send, one charge and at most one eligible continuation hook; no hook without a confirmed receipt, no replay or refund on an unreadable receipt, and existing rollback on proven failure. Cover a late receipt after the old owner is gone.

## 3. Verify integration

- [x] 3.1 Run `npm run check` and `openspec validate retire-publishing-after-continuation-handoff --strict`; record results, including the handoff, failed-send, callback, cancellation and stale-progress regressions.
- [x] 3.2 In an isolated Pi session, trigger one continuation and keep its main run open. Record the exact continuation in history and the widget state while main work is still running: normal controls, no private progress and no duplicate turn. Do not use the live `cooker` session as a test driver.
