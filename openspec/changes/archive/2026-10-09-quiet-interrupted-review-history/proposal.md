## Why

Before every inquiry the watchdog rereads review history and shows `Continue watchdog · Other error — Review history incomplete: some native records or source associations are unavailable.` Replaying real sessions showed every such card came from an earlier attempt that was preempted by user input or invalidated by activity. Those attempts consumed no model response, so a missing decision audit is expected, not a gap. Each later inquiry repeated the card, usually under the wrong exchange id, which made the check look like it failed before working.

Separately, cross-process subagent activity can invalidate an inquiry after its prompt was submitted. The model's `cw` answer is then discarded silently.

## What Changes

- A preempted or invalidated attempt no longer requires a response audit when history is recovered. Other missing data remains incomplete history.
- An unchanged set of history gaps is reported once per runtime, under the first affected exchange instead of the latest record.
- When subagent activity invalidates an inquiry whose prompt was already submitted, one `Other error` status card says the check was invalidated by subagent activity and its answer discarded. Activity before submission stays silent. Invalidation behavior itself is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `watchdog-review-context`: interrupted attempts owe no audit; history gaps are disclosed once with correct attribution.
- `decision-response-contract`: subagent invalidation of a submitted inquiry is disclosed.

## Impact

- Code: `src/review-context.ts` (`readReviewHistory`), `src/runtime.ts` (`reportReviewHistory`, process-domain subscription).
- Tests: `test/review-context.test.ts`, `test/runtime.test.ts`.
- Docs: `docs/behavior-contract.md`, `docs/programming-thinking/watchdog-review-history.idea.lean`.
- No configuration, dependency, tool-schema, or lock/budget change.
