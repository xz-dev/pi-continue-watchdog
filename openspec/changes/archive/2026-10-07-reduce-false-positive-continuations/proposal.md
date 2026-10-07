## Why

The watchdog can claim that an already-delivered answer is missing, while syntactically valid decisions can also overlook a genuinely missing deliverable. Existing guidance and input-preservation tests do not establish semantic accuracy; a bounded pilot supports a more explicit delivery comparison, not a claim that the historical false continuation is fixed.

## What Changes

- Add a bounded, provenance-labelled review view to the existing owned inquiry without replacing or shortening Pi's effective conversation. Keep genuine earlier requests in scope; distinguish user instructions, ordinary delivery, tool evidence, native summaries, and automation opinions.
- Ask for a concise component-by-component delivery assessment in the existing `reason_content` before selecting `reason_type` and `action`. Preserve the three-field protocol, configured reason types, reason limits, and acceptance of either JSON property order.
- Bind the source view and outcome through the existing inquiry, hidden marker/audit, and published result records in the owning native session JSONL. Reconstruct review history from the active ancestry, while respecting native compaction for new model-facing views; do not create a separate review journal.
- Preserve valid inherited fork history without restoring old locks, run ownership, pending calls, timers, or permission from a saved verdict. Reuse existing live ownership, current-attempt, and publication safeguards; recorded review metadata does not grant execution authority.
- Report incomplete persistence honestly while retaining the current publication/error behavior. Add no independent review-write gate, permission question, or provider retry path.
- Keep the pilot results, costs, failure cases, and limits separate from deterministic implementation acceptance. No additional experimental/provider calls are authorized by this proposal.

## Capabilities

### New Capabilities

- `watchdog-review-context`: Bounded source-aware review context, association with existing session-native records, and branch-aware historical recovery without new execution gates.

### Modified Capabilities

- `decision-response-contract`: Assessment-before-verdict guidance and explicit reconciliation of required delivery components, including earlier deliveries and the difference between reporting a future command and executing it.

## Impact

- Production work is expected around `src/decision-protocol.ts`, `src/context-fold.ts`, and `src/runtime.ts`; a small pure `src/review-context.ts` helper can isolate projection and record parsing without further enlarging runtime orchestration.
- Reuse public Pi session APIs, existing inquiry correlation, decision audits, lifecycle fences, and the current test stack. No Pi changes, new dependency, separate store, extra model, or task registry.
- Acceptance covers delivered/undelivered answers, existing versus missing permission, context bounds, restart/fork/rewind/compaction isolation, and stale or failed publication. Model-quality conclusions remain narrower than those lifecycle guarantees.
- Preserve the completed abort-notice behavior and existing event presentation. `pi-llm-as-jev` remains a separate deferred, optional, default-off enhancement.
- This change is planning-only until its artifacts are presented and a subsequent apply request is received. No installation, commit, push, or release is included.
