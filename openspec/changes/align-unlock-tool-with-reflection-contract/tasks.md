## 1. Function protocol and declaration

- [x] 1.1 Implement the pure continue/wait/unlock argument validator and fixed decision/correction prompts; verify focused tests cover configured reason matching, trimmed Unicode bounds, numeric wait bounds, missing/wrong fields, XML rejection, actual-delivery reconciliation, and user-boundary guidance.
- [x] 1.2 Replace the proactive unlock adapter with the root-only `cw` function, fixed minimal metadata, and shared runtime authorization check before plugin payload validation (native non-object container rejection is allowed); verify stable declarations, absence of startup usage guidance and old tool aliases, child exclusion, and unchanged ordinary state after unauthorized calls.

## 2. Owned inquiry lifecycle

- [x] 2.1 Restore controller decision identity, three-response correction limit, continue/wait shared retry accounting, wait deadline, and decision-failed terminal state; verify focused transition tests include invalid/stale no-ops, final-budget wait, and publication rollback.
- [x] 2.2 Replace qualified direct continuation and jev classification with inquiry dispatch using existing idle, ownership, and process-domain fences; verify only an exact prompt confirmed in the corresponding run and plugin-local context authorizes that attempt and that queued/provisional/foreign runs do not gain authority.
- [x] 2.3 Preflight complete response batches, correlate result tool-call IDs, suppress malformed owned batches before dispatch, preserve admissible singleton calls/thinking, and stage validated outcomes; verify no work tool executes in a decision, duplicate callbacks cannot act twice, and invalid responses count once per response rather than once per tool.
- [x] 2.4 Finalize current staged outcomes at authoritative settlement and schedule bounded corrections or one ordinary continuation without acknowledgement-only requests; verify provider-request counts and preserve true-terminal-error, automatic-retry, abort, takeover, branch/session switch, and stale-ownership behavior.

## 3. Waiting, events, folding, and cancellation

- [x] 3.1 Restore bounded waits, immutable acceptance/deadline facts, completed-wait observations, and deadline-gated exhaustion; verify busy children defer rather than restart timing, cancellation invalidates wakeups, resumed history never rearms timers, and `WAIT_CALLBACK` unlocks without a timer.
- [x] 3.2 Restore canonical reason-bearing continue/wait/unlock/failure events and semantic-hook values; verify shared human/model bodies, immutable timestamps, durable-publication-before-hook ordering, aggregate-idle terminal signals, listener independence, and silent manual/abort paths.
- [x] 3.3 Extend exact-exchange folding to native result calls and results while preserving executable calls and required thinking until dispatch; verify completed exchanges are absent from ordinary context, legacy history remains readable, and unrelated messages and branch boundaries remain intact.
- [x] 3.4 Extend exact-owned-run cancellation to inquiry/correction runs and revoke pending submission/wait authority; verify manual unlock aborts only the correlated run, removes owned residue, preserves ordinary user runs and completed side effects, and never inspects or replays private queues.

## 4. Configuration and jev removal

- [x] 4.1 Restore `decisionPrompt` and `continueReasonTypes`, retain current unlock defaults and precedence, and diagnose removed `jevWaitCheck` without nested values; verify config tests preserve valid neighboring settings, reject invalid bounds, and disclose no credentials.
- [x] 4.2 Remove jev classifier/reviewer code, callers, caches, counters, request wiring, and dedicated tests while preserving shared provider support and historical archives; verify no live jev request path remains and available TypeSafe/OpenRouter credentials are neither resolved for jev nor modified.

## 5. Documentation and executable process models

- [x] 5.1 Update current README, behavior contract, package description, and affected examples in English; verify they describe inquiry-first control, minimal `cw` metadata, restored waits/hooks, removed jev settings, and native compaction/branch-summary retention limits without advertising ordinary proactive unlock.
- [x] 5.2 Update the authoritative lifecycle Lean model and any affected takeover/cross-plugin models without weakening unrelated guards; verify exact files typecheck and run, top-level correctness claims have no placeholders or unintended axioms, and record file hashes and proof scope for independent semantic reading.

## Evidence boundary

See `verification.md` for historical findings and the approved three-boundary revision. The earlier BLOCK verdict concerns the former strict contract, not a renewed instruction to stop. Current source has 286 passing unit tests plus lint/typecheck/build, a fresh full 7-case packed suite and 1 cross-process case, and seven terminal-publication SDK fault/control cases. Final review identified one non-waived publication defect; its repair, targeted evidence, and independent closure are recorded in `verification.md`. Original reviewer follow-up `fa6054af-9624-4185-b049-722be02bbf3c` approved the reviewed candidate with explicit residual risks and confirmed these checklist closures. Unchanged exact-hash Lean checks/readings are retained as conditional formal evidence, not host-wide certification.

## 6. Integrated acceptance

- [x] 6.1 Run `npm run check` and resolve regressions against the completed source tree; verify lint, typecheck, unit tests, and build all exit successfully and retain command evidence.
- [x] 6.2 Run `npm run test:e2e` on the final candidate; map packed and cross-process tests plus real-SDK probes and focused runtime tests to ordinary/provisional/stale submissions, malformed batches, bounded corrections, all outcomes, ownership, and cancellation. Label the test layer accurately; do not claim every case is packed or that finite tests prove every interleaving.
- [x] 6.3 Complete a fresh read-only implementation review and independent hash-bound semantic reading of changed Lean models; verify findings against source, resolve accepted in-scope issues, re-run affected checks, and leave no unsupported completion or proof claims.
- [x] 6.4 Run strict OpenSpec validation and final diff/scope checks; verify implementation matches the deltas, task checkboxes reflect actual evidence, and no installed plugin, shared credentials, unrelated repository, Git commit/push, or main-spec archive/sync action was changed without separate authorization.
