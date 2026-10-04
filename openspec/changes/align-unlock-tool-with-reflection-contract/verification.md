# Plugin-only verification record

## Approved delivery scope

After the checkpoint below, the user explicitly approved completing the original plugin goals, then committing without GPG signing and normally pushing to `origin/master`. Only three former requirements were revised: final-provider consumption certification becomes exact owned-run plus plugin-local context confirmation; native non-object schema rejection may precede plugin authorization; malformed owned batches may be suppressed to normal stop before dispatch without per-call terminating results. Ordinary-call inertness, bounded correction, no ordinary tool side effects, accounting, publication/ownership, waits, cancellation, and jev removal remain required.

The historical counterexamples below remain accurate; they were not repaired by wording changes. The current proposal/design/deltas and behavior contract define the revised acceptance target. The earlier formal hashes are unchanged and their conditional scope is retained, not promoted to host-wide proof.

## Current terminal-publication repair

**Accepted against the user-approved revised plugin-only contract.** Original final reviewer `48d857df-4f4e-496c-924a-97e4fe5d7726` resumed as `fa6054af-9624-4185-b049-722be02bbf3c` and closed F1 plus the completed-wait seam, approving delivery with the explicit residual limits below. The reviewer verified all 172 paths before and after: candidate digest `09dd6551ed9e13760d8c056f3862db101f522fe8c6f91d843f2d2a7c648d2de2`, runtime SHA-256 `7e6610f058c350e37bb4d5c62630942ba70d2e06ba9bac8ee21b4339d00568c4`, runtime-test SHA-256 `a89c9501836625cc19f617628eff6bf59fc63f7a4b6230edbae46bdca96a0c97`. Subsequent acceptance/checklist updates do not change reviewed executable or formal files.

The original review had accepted the revised boundaries but reproduced F1: unlock, decision-failed, and exhausted notifications could publish after their canonical append failed. It also identified the adjacent completed-wait seam. Its finding is preserved in `/var/tmp/cw-final-review/approved-contract-review-before-repair.md`, not relabeled as an earlier pass. The closure report is `continue/approved-contract-final-review.md` under the original run's retained output directory. No other blocker was found in the bounded original review or affected-interaction follow-up.

The repair in `src/runtime.ts` requires new correlated public branch receipts for all four paths, sharing the receipt observer with existing continue/wait checks. It keeps canonical bodies and current-cycle ownership while receipts are unreadable, retries confirmed missing records on subsequent eligible lifecycle observations, and revokes pending authority on reset/cancellation/demotion. It neither relocks accepted unlock nor charges attempts nor requests an extra model turn. Completed-wait timing cannot advance into a new inquiry or exhaustion until its record is confirmed.

Current evidence in `/var/tmp/cw-final-review/`:

- `terminal-receipt-red.log`: intentionally bypassing the new receipt check made the new regressions fail for a missing record and an unreadable receipt. The guard was restored before final checks.
- `terminal-receipt-check.log`: **286/286** tests, lint, typecheck, and build pass. Cases cover four event kinds with absent/unreadable receipts, recovery with immutable bodies, no duplicate sends for unknown receipts, no extra model work/accounting changes, manual unlock/fresh-cycle/demotion invalidation, non-final completed-wait inquiry gating, and receipt-read re-entry.
- `terminal-sdk-results.json`: **seven actual SDK cases pass their assertions**. Original reviewer faults now suppress terminal hooks: unlock `host-Q3ZP9W`, failure `host-SmMsnB`, exhaustion `host-wY5ZhG`; completed-wait fault `host-6HwAGr` also suppresses exhaustion. Successful controls `host-Ve6No0`, `host-sb6nKe`, and `host-xKyLre` confirm their shared record before the expected terminal hook. Requests remain 2/4/2 respectively, with zero ordinary tool bodies. Logs are `terminal-sdk-<case>.log`; each directory contains `result.json`.
- `terminal-receipt-e2e.log` and `.exit`: current repaired source passes **7/7 packed + 1/1 cross-process**, exit 0.
- The runtime test transport now persists standalone shared events as well as folds, matching the tested host seam. The older permanently unreadable-branch cleanup case now asserts deferred publication followed by recovery without a new model request, instead of assuming publication without observable evidence.

The unchanged Lean files express conditional publication premises rather than this adapter's retry implementation. This repair supplies the existing receipt prerequisite; it does not alter their formal process or extend their proof scope. Existing exact-hash checks/readings remain the formal evidence. Native session append observation is not filesystem-fsync or arbitrary-handler certification. Missing/unreadable terminal or completed-wait receipts progress only on later eligible observations; continued host failure can leave signaling pending. Finite tests do not establish every interleaving or all packed cancellation/resume cases. Native compaction can retain control arguments, and task-completion judgment remains fallible. These disclosed limits do not reinstate the three superseded requirements. Source publication does not install, reload, or deploy the plugin, and this change does not synchronize or archive main specs.

## Historical checkpoint — former strict contract

The following checkpoint predates the approved scope revision. Its BLOCK verdict and stopping instruction are historical, not the current delivery decision.

## Verdict and scope

**BLOCK — partial source repair, not deployment or full contract acceptance.** The user declined changes to Pi host source. The final-request consumption requirement remains unchanged; no provider wrapper, private queue access, weaker trust rule, or silent feature disablement was substituted.

The independent review was `b1eb8cb5-d0f0-4f28-bb88-f74259bf7d2a`, against Pi 0.85.1. Local evidence is retained under `/var/tmp/cw-final-review/`. Its `host-check.mts` and `takeover-check.mts` use a real SDK session and a local mock HTTP provider, not production credentials. `plugin-host-check.mts` adds a continuation append-failure probe and stops failed-publication observation before a later unrelated retry.

## Finding disposition

| Finding | Current disposition |
| --- | --- |
| Intermediate context observer treated as final consumption | **Unresolved.** A later handler removes the inquiry; a valid-looking `cw` can still unlock. Parent reproduced it in `host-ZMv9XR/result.json`. Moving to another mutable intermediate callback is not a repair. |
| Native batch fast paths bypass correction accounting | **Partially repaired.** Owned mixed/duplicate, unknown-tool, non-object, and truncated responses are projected to an ordinary stop without executable calls. The first captured response cannot be overwritten before settlement. Ordinary non-object `cw` arguments still hit native schema validation before plugin authorization; that subcase remains unresolved. The normal-stop projection also does **not** supply the per-call terminating results required by the unchanged design; task 2.3 remains open. |
| Publication assumed from void `sendMessage` | **Tested subcases repaired, overall finding remains open.** Wait requires a newly persisted correlated branch entry. Continuation notification waits for correlated post-persistence observation. Confirmed failed publication restores its attempt; unreadable receipts are not absence and cannot justify a refund. This does not prove every publication/ownership interleaving or atomic visibility of tentative accounting. |
| Unreadable wait receipt loses recovery state (R1) | **Repaired and locally reverified after independent review.** Pending identity and original timing survive unreadable observations. Recovery retains the charged attempt and deadline; unlock/demotion cancels publication authority. The reviewer's fault probe and control now pass. This latest repair has not received another independent implementation review. |
| Takeover images lost | **Independently confirmed within the forwarding scope.** Capture/reissue retains text and image blocks once, including image-only input. The shared single-slot takeover helper's scope is unchanged. |
| Invalid argument results marked successful | **Independently confirmed within the correlated-result scope.** The current staged invalid call is correlated in `tool_result` and gets `isError: true` without losing batch termination. |
| Fixed continuation completeness guidance missing | **Independently confirmed.** The shared body checks every session request against actual delivery and excludes delivered, cancelled, or superseded work, even with custom guidance. It does not teach proactive `cw` use. |
| Coverage/checklist overclaims | **Claims corrected; coverage gap remains.** Packed provisional/stale submissions, mixed batches, manual cancellation, compaction recovery, and persisted resume are not established by the existing seven packed cases. |

## Targeted evidence

- `plugin-p2-red.log` → `plugin-p2-green.log`: image payload, actual error status projection, and fixed completeness guidance first failed, then passed.
- `plugin-batch-red.log`: native malformed-transport regression failed before repair.
- `host-sSdD6h/result.json`: three invalid decision replies, four total requests including the initial ordinary request, decision-failed state, zero ordinary tool bodies.
- `host-QapekR/result.json`, `host-lISbCA/result.json`, `host-dXATlK/result.json`: mixed schema-invalid work call, unknown tool, and truncated response each consume one correction; zero ordinary tool bodies.
- `host-20O5Yr/result.json`: invalid object-shaped `cw` result has `isError: true`.
- `host-cy34yq/result.json`: image reaches the post-takeover provider request.
- `host-fDQfne/result.json`: continued hook observes the persisted continue fold.
- `host-buUTbq/result.json`: failed wait append leaves locked state, attempt zero, deadline zero, and no waiting hook.
- `host-VwEEMn/result.json`: failed continuation append restores the attempt to zero; the existing native terminal-error path still emits `ERROR_UNLOCK`, not `watchdog-continued`.
- `receipt-uncertainty-red.log`: an unreadable branch previously refunded an already-persisted outcome. The regression now distinguishes confirmed absence from an unavailable read.

These probes are source-checkout evidence, not packed or deployed verification. Their individual results do not supersede the remaining counterexamples. Final-candidate commands and model hashes are recorded separately after freezing; earlier green suites are not final acceptance.

## Latest source evidence: R1 recovery slice

Executable source is frozen after the bounded recovery repair. No further architectural or general edge-case pass is implied.

- `npm run check`: exit 0, **282/282 unit tests**, lint/typecheck/build passed (`wait-recovery-check.log`).
- Recovery regression: `wait-recovery-red.log` first failed because no deadline wake survived. The final test covers original-deadline recovery, continued unavailability followed by recovery, unchanged accounting/deadline, no duplicate notice, manual unlock, and ownership loss.
- Reused actual-host fault probe: `host-Ho29IE/result.json` records one unavailable read, one persisted wait, one charged attempt, and both waiting and exhausted hooks. Control `host-wXs9e3/result.json` also passes. Logs: `recovered-receipt-unavailable.log`, `recovered-receipt-control.log`; probe: `followup-receipt-check.mts`.
- Selected packed adapter regression: `TMPDIR=/var/tmp node node_modules/tsx/dist/cli.mjs --test --test-name-pattern="packed bounded wait" test/e2e/packed.test.ts` — **1/1 passed**, exit 0 (`wait-recovery-packed.log` and `.exit`).
- The full seven-case packed suite and cross-process case below were **not rerun after R1**. They remain earlier-candidate evidence, not complete current-source acceptance or coverage.

## Earlier frozen-candidate evidence (before R1)

- `npm run check`: exit 0, lint/typecheck/build successful, **281/281 unit tests** (`plugin-final-check.log`).
- `TMPDIR=/var/tmp npm run test:e2e`: exit 0, **7/7 packed cases and 1/1 cross-process case** (`plugin-final-e2e.log` and `.exit`). These counts do not complete the missing coverage matrix.
- That source-host probe run had **10 repaired/positive scenarios meet their assertions; both known counterexamples were reproduced**. Exact artifacts are indexed in `final-host-results.json`; logs are `final-host-<mode>.log`.
- Strict OpenSpec validation and `git diff --check`: passed. These are consistency checks, not behavioral acceptance.
## Current formal and independent-reading evidence

Both exact annotated Lean files typechecked and ran without warnings or placeholders on Lean 4.34.1 after the recovery/wording changes. Primary theorem foundations: `propext`, `Classical.choice`, `Quot.sound`; takeover theorem: `propext`, `Quot.sound`. Logs are `recovery-<model-name>-check.log` and `recovery-<model-name>-run.log`.

| Authoritative model | Current SHA-256 |
| --- | --- |
| `docs/programming-thinking/official-pi-idle-inquiry.idea.lean` | `3bd5e4a9f3360d6a2b2ab09776d0c3cf9513efc4fb76751243000fc4ad6c8464` |
| `docs/programming-thinking/watchdog-user-takeover.idea.lean` | `2ec8a8f89e8a40696e9eb587bc98382828220660001d7970b1b027ddb6489380` |

## Formal and review gates

The primary lifecycle model remains conditional on authentic final-consumption metadata, parser/dispatcher behavior, scheduling, and durable publication. The takeover model now carries the text/image value through capture, settlement, and one delivery. Native transport projection and three-valued receipt accounting are explicit local model properties. A kernel-accepted theorem is not proof that the SDK satisfies those external premises.

The first reader failed to start because its isolated provider extension was missing; that is historical failed evidence, not a successful gate. After configuration repair, the current exact hashes received fresh isolated readings in workflow `dcc82923-7743-4f27-ae7f-6f4faae8378e`: primary `a568df6d-4de5-4e8e-beb2-3687a34305cc`, takeover `c2e977ee-d086-402f-958e-b7bf6dbe271a`. Parent inspected the transcripts: each read only its named source, hashed its full bytes, and wrote only its configured report. Output-directory creation errors were resolved before report delivery. Both returned hashes still match. Neither final reader ran Lean; kernel checks above were performed by the parent.

The semantic round trips confirm the expressed, limited model meaning: conditional finite inquiry traces, abstract takeover payload preservation, and local receipt recovery/idempotence. They do **not** establish whole-host refinement, actual provider consumption, temporal durable-I/O ordering, fairness, arbitrary interleavings, or task-completion judgment. Receipt recovery remains a separate submodel, not a refinement proof of runtime finalization. Takeover evidence commentary/output was narrowed to snapshot implications rather than a temporal publication guarantee.

Independent implementation follow-up `cad528cf-a10c-4619-b7d9-615026f27345` (workflow `489a91ab-0974-408b-9798-788ca2e7fd97`) confirmed the three original P2 repairs and retained F1/F2/F3/F7 as unresolved/partial. It found R1 and the remaining resume-coverage overclaim; those were repaired afterward with the scoped evidence above. Its review is **not** approval of the later R1 source revision. Reports and exact-hash reader transcripts are in the workflows' retention-managed artifact directories; receipts are under `/home/xz/.cache/pi-agent/pi-subagents-uid-1000/async-subagent-runs/<workflow-id>/workflow-receipt.json`.

## Handoff limits

Full acceptance remains BLOCK for final-request consumption, ordinary malformed-call authorization ordering, and strict malformed-batch transport. Publication/ownership interleavings and the packed coverage matrix remain incomplete. No further recovery chain or host expansion is authorized by this checkpoint.

No host source, installed plugin, shared credentials, commit, push, main-spec synchronization, archive, or deployment is part of this checkpoint.
