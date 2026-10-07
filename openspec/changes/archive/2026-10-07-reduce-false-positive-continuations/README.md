# reduce-false-positive-continuations

## Status and priority

The authorized repair and both independent repair reviews are complete. All three reproduced defects are fixed and verified on the frozen repair candidate; the nonblocking bash-qualifier issue is also addressed. `tasks.md` has 13/13 tasks complete. The parent accepts the scoped implementation with the explicitly retained intermittent packed-test uncertainty below. Old findings and red logs remain as history, not current unfixed defects. The separate hide-watchdog-abort-notice work is not reopened. Archived on 2026-10-07 after the user separately authorized archive, unsigned commit and ordinary push. Main specs are synchronized. This closeout does not include installation into the user's runtime or new live-model efficacy experiments.

## Frozen repair candidate — current acceptance evidence

**Disposition: accepted with explicit residual verification risk.** Independent code re-review closed all three blockers, and the fresh Lean semantic round trip passed for the final hash. No further behavior change is planned for this candidate.

Baseline remains `566c9ba18db5cfd209b9a2fe9b6a6b8cd6b8ab15`. Evidence root: `/var/tmp/pi-watchdog-reviews-0ff5aa0b-r1/`. `repair-final-v3-candidate-sha256.json` freezes the tested source, tests, behavior docs and Lean model. All three final integration receipts report `candidateChanged: []`; only this status report and task checkboxes are updated afterward.

| Finding | Repair and closure evidence |
| --- | --- |
| P1 native bash exclusion | `classifyWire` delegates bash rendering to the public native `convertToLlm`: excluded records produce no row, excerpt, selected source ID or source-head reference. Included records retain native cancellation/exit/truncation qualifiers, addressing the nonblocking suggestion without duplicating host formatting. The pure test verifies native exclusion and unchanged stored records; the packed disk-backed case verifies both excluded sentinels absent from actual requests and metadata, included sentinels present, and the local excluded record retained. |
| P2 quiet-unlock publication | Recovery matches the existing quiet status using exact exchange/attempt and active ancestry, records `unlockEntryId`, and requires both status and remove-fold for quiet publication. Legacy replacement unlocks remain readable. The fixture table covers missing, malformed, sibling, wrong-attempt, wrong-exchange, matching, missing-audit and missing-fold cases. The packed fresh-process reader verifies the actual quiet record and its correlation. |
| P2 missing inquiry | New-format association independently requires its correlated inquiry, rather than the optional audit prompt-ID field. Absent, sibling or wrong-attempt prompts yield partial history while retaining the available response and published verdict. Matching input stays complete. No runtime control, retry, relock, publication acknowledgement or storage path was added. |

The three new regression tests first failed on the original candidate (`repair-regressions-red.log`, 26 pass/3 fail). The original standalone counterexamples now pass **3/3**, exit 0. The native-format qualifier assertion also failed before reuse of host conversion (`repair-bash-qualifiers-red.log`), then passed in the final suite. Intermediate formatter/type errors and one Lean record-layout syntax error remain logged; they are superseded by the exact final successful checks, not hidden.

| Frozen-candidate check | Result | Log under evidence root |
| --- | --- | --- |
| `npm run check` | Exit 0; lint/typecheck/build and 355/355 tests | `repair-final-v3-check.log` |
| Original three counterexamples | Exit 0; 3/3 | `repair-final-original-probes.log` |
| Full packed integration | Exit 0; 26/26 on unchanged full rerun | `repair-final-packed-rerun.log` |
| Native-summary integration | Exit 0; 18/18 | `repair-final-native-summary.log` |
| Cross-process integration | Exit 0; 1/1 | `repair-final-cross-process.log` |
| Exact annotated Lean typecheck/run | Both exit 0 | `repair-final-lean-typecheck.log`, `repair-final-lean-run.log` |

Every command has its `.log.exit.json` receipt; integration commands retain outer timeouts and full output. **Residual test uncertainty:** the first full packed run (`repair-final-packed.log`, exit 1) timed out in the correction and continuation native-abort subcases. Without code or timeout changes, the isolated abort suite then passed 6/6 (`repair-abort-repro.log`) and one full rerun passed 26/26. The cause of those initial intermittent timeouts is not established; the failure is not discarded or represented as a pass.

The final annotated Lean SHA-256 is `945b68cf02c3dd6b312b2ad16f52a7becc20e3398147f398c62250d4324e9e80`. The model now explicitly includes inquiry presence and quiet-unlock fold/status publication, with missing-inquiry and missing-status laws in the combined correctness claim. Kernel foundations remain `propext`, plus `Quot.sound` for sibling exclusion. Correct host ancestry, eligible source IDs and decoded native record facts remain inputs; this is not a TypeScript refinement, host-decoder proof, or semantic model-accuracy proof. The prior reader checked a different hash, so its approval was **not** carried forward. A new isolated reader checked this exact final file; the parent confirmed its independent reconstruction of the six-clause correctness claim, publication/association distinction and explicitly unmodelled host/decoder/semantic behavior. Task 4.3 is complete for this hash.

### Final independent repair reviews

The user explicitly authorized one bounded repair-review round. Workflow `58901185-b201-4913-8433-96900f0b7b28` completed two read-only checks:

- **Code re-review:** original reviewer resumed as `533b52ce-dc83-4bf7-8a07-406e01eb218a`; verdict **Approved with explicit residual risk**. Each of the three blockers is closed, the bash-qualifier suggestion is addressed, and no concrete repair-surface regression was found. The original failed packed run and unexplained timeout risk were expressly considered, not hidden.
- **Lean semantics:** fresh reader `15684378-33cb-46e1-8db4-bc1b44c687b7` in a neutral directory, no parent conversation/project/skills/memory input. Transcript shows one successful read of only the designated file, with the actual matching SHA-256. A progress-call attempt was blocked by the exact-file guard and exchanged no information. Its reconstruction matches the parent-only intended transformation and exact proof scope; no compilation claim was inferred from prose.

Reports: `/home/xz/.pi/agent/sessions/--home-xz-Code-ai-pi-continue-watchdog--/subagent-artifacts/outputs/58901185-b201-4913-8433-96900f0b7b28/reviews/repair-code-review.md` and `repair-lean-semantic-review.md`. Parent checked the reports, actual input/tool trajectories and all 200 entries in `repair-review-candidate-sha256.json`: no candidate change during either review. Final closeout changes only this report and task 4.3's checkbox.

The parent accepts the completed implementation and independent gates within their stated scope. The initial packed timeouts remain residual verification uncertainty: no source-backed regression was found, later same-byte checks passed, but the cause is not proved resolved. A redundant post-review Lean typecheck also hit its 45-second outer deadline once; the unchanged file then typechecked in 9 seconds under a 120-second outer limit and executed successfully. Both attempts are retained under `/var/tmp/pi-watchdog-reviews-0ff5aa0b-r2/`; no proof or source was changed to obtain the pass. This acceptance does not establish live-model efficacy, authorize deployment, or resolve historical experiment-budget accounting.

## Pre-repair review checkpoint (superseded)

**Historical disposition: changes required.** The following reports and evidence describe the rejected pre-repair candidate. Its then-green receipts did not cover the three defects. The original interrupted workflow did not perform independent review; the two reports below are the subsequently authorized gates.

Baseline: `566c9ba18db5cfd209b9a2fe9b6a6b8cd6b8ab15`. The pre-repair candidate's production/test hashes are recorded in `/var/tmp/pi-continue-watchdog-parent-acceptance-0ff5aa0b/candidate-code-sha256.json`. All three integration runs verified those bytes unchanged. No Pi or real user session was modified; no runtime installation, archive, commit, push or live-provider experiment was performed. The existing packed tests install the tarball and pinned host only into disposable fixtures under `/var/tmp`; no project dependency/lockfile was changed.

### Independent review findings and parent disposition

Workflow `be791145-d5f3-4e03-9143-964efd6e7fef` completed exactly two fresh-context, read-only children. Reports are under `/home/xz/.pi/agent/sessions/--home-xz-Code-ai-pi-continue-watchdog--/subagent-artifacts/outputs/be791145-d5f3-4e03-9143-964efd6e7fef/reviews/`:

- `final-code-review.md`, run `33b4fb2b-f8a4-4303-853a-2e5167e6ae24`: **Request changes**. Parent verified the requirements-first read sequence, actual source/receipt inspection, and absence of mutation/test/provider tools. Three supervisor progress messages received only queue acknowledgements, not parent interpretation.
- `lean-semantic-review.md`, run `8268a5ac-4cfd-4216-8c81-ce2e0c6835e6`: **semantic round trip accepted**. Neutral cwd, no inherited conversation/project/skills/memory input, one successful read of the designated file. A prior supervisor-call attempt was blocked by the exact-file guard and exchanged no information. The successful read supplied the actual matching SHA-256. Parent interpretation was not supplied to the reader.

Parent rehashed all 200 frozen manifest entries after both reviews: no changes. Review setup, manifest and parent dispositions are retained under `/var/tmp/pi-watchdog-reviews-0ff5aa0b-r1/`. The following defects were independently reproduced there by `review-counterexamples.mts`: **0/3 passing assertions, exit 1**, with full `review-counterexamples.log` and `.log.exit.json`. The checks used only in-memory native sessions and local imports; no provider call or user-session access occurred.

| Finding | Parent disposition and evidence | Required closure |
| --- | --- | --- |
| P1: excluded bash content enters the supplement (`src/review-context.ts:171–178`) | Valid blocker. Native `convertToLlm` excludes an `excludeFromContext: true` sentinel, while the view includes both its text and selected source ID. Task 1.2 reopened. | Honor host exclusion before row selection/metadata; add included/excluded source assertions and a packed localhost request-sentinel check. |
| P2: unlock fold alone is treated as complete publication (`src/review-context.ts:670–778`) | Valid blocker. Valid marker/prompt/audit plus remove-fold, without the required `pi-continue-watchdog:ai-unlock` record, yields `publishedOutcome: "unlock"`, `status: "published"`, metadata `ok`, and no diagnostic. Existing runtime requires both artifacts. Tasks 2.2, 2.3 and 3.1 reopened. | Correlate the existing quiet record by exact attempt/active ancestry; keep fold evidence distinct, preserve the committed live unlock, and report missing canonical publication without relock/retry/gating. Test matching, absent, sibling/wrong-attempt and audit-missing cases. |
| P2: missing inquiry is certified as intact association (`src/review-context.ts:838–857`) | Valid blocker. Marker/audit/fold and canonical quiet record without inquiry still yield metadata `ok` and no diagnostic. Tasks 2.2, 2.3 and 3.1 reopened. | Independently require the correlated inquiry for complete new-format association; retain available response/outcome as partial history. Cover absent/sibling inquiry without requiring an optional audit prompt-ID field. |

The reviewer also noted a nonblocking evidence-quality issue: bash excerpts omit native cancellation, exit-status and truncation qualifiers. Recorded for bounded repair consideration, not a new independent feature or gate. Task 4.2 is reopened for regression verification after the required fixes; old green logs are not their closure evidence. No repair or additional agent was launched in this review-only closeout.

### Scenario-to-evidence map

This map preserves the earlier passing evidence; reopened-task exceptions in the table above supersede earlier completeness claims.

| Tasks | Contract checked | Actual evidence |
| --- | --- | --- |
| 1.1 | Delivered/missing report components; earlier unfinished/completed work; existing versus distinct missing permission; cancellation/deferred work | `test/review-context.test.ts`: sanitized delivery/scope table preserves exact native user/answer evidence and excludes oracle fields from projection. Expected actions document examples only; these are not model-accuracy tests. |
| 1.2 | Size ceilings including footer/elision; Unicode; leading evidence then earlier human context; source order, provenance and compaction | `test/review-context.test.ts`: astral Unicode bounds, overflow priority, ordinary spoof/incomplete-metadata preservation, compaction, non-label head and unchanged native entries. Exact parsers/key are shared with `src/context-fold.ts`. |
| 1.3 | Assessment-first guidance without protocol change | `test/two-outcome-lifecycle.test.ts`: both field orders and prompt guidance; existing config/protocol tests retain reason limits, reason lists, extras, single-call and correction behavior. |
| 2.1 | View, source metadata, response and outcome remain in the same native JSONL | `test/runtime.test.ts`: prompt/marker/audit linkage; `test/e2e/packed.test.ts` disk-backed scenario compares persisted inquiry content with sent input, then invokes the packed history reader in a separate Node process and checks response/published unlock and valid association. |
| 2.2 | Response is not publication; exact attempt keys; interrupted/invalid/legacy/unknown records | `test/review-context.test.ts`: pending/invalid/canonical cases, missing audit, wrong marker references, unsupported projection version, malformed/missing/sibling source references, collision-free identity; runtime correction and duplicate-callback tests remain green. |
| 2.3 | Optional failure is diagnostic, not a gate; durable continuation remains mandatory | `test/runtime.test.ts`: real `message_end` audit failure keeps one accepted continuation and expected turn count; source-build failure reports unavailability; diagnostic reentrancy defers safely. Existing publication rollback, AI/manual unlock and cancellation checks pass. |
| 3.1 | Disk recovery without old authority | Separate-process reader tests and the packed disk scenario reopen the actual file. The pure reader reconstructs records only; runtime consumes its diagnostic, not old operational state. Unavailable references are not certified `ok`. |
| 3.2 | Active ancestry, native fork/label re-chaining, leaf-only rewind | `test/review-context.test.ts`: sibling exclusion, rewind, real labelled fork with changed parent links and preserved source IDs/origin provenance, separate-process fork read and actual host-restored leaf without reselection. Pi 0.85.1 restores the persisted tip, not a leaf-only in-memory rewind. |
| 3.3 | Historical records do not override native compaction or live fences | Effective-context compaction projection plus existing takeover, stale-domain/claim/generation, late result and cancellation tests. New model input is built from `buildContextEntries()`, never the history reader's records. |
| 4.1 | Packed input serialization, hidden metadata and ordinary/summary isolation | Final packed and native-summary suites against deterministic localhost fixture models. Canonical outcome presentation and owned abort rendering remain covered. |
| 4.2 | Whole-check and integration regression gates | Final commands/table below; includes the previously missing cross-process run. |
| 4.3 | Behavior and formal scope synchronized | `README.md`, `docs/behavior-contract.md`, and `docs/programming-thinking/watchdog-review-history.idea.lean`; exact Lean typecheck/run pass and independent semantic round trip accepted for the unchanged hash. The abstraction does not certify the TypeScript recovery defects above. |

### Pre-repair candidate checks

All listed logs and corresponding `.log.exit.json` receipts are under `/var/tmp/pi-continue-watchdog-parent-acceptance-0ff5aa0b/`. Checks ran with `TMPDIR=/var/tmp`; potentially hanging tests had outer timeouts and captured full output rather than piping away the real exit.

| Check | Result | Log |
| --- | --- | --- |
| `npm run check` | Exit 0; lint/typecheck/build and 352/352 tests | `check-final-v2.log` |
| `timeout --kill-after=15s 1800 ./node_modules/.bin/tsx --test test/e2e/packed.test.ts` | Exit 0; 26/26 | `packed-final.log` |
| `timeout --kill-after=15s 900 ./node_modules/.bin/tsx --test test/e2e/native-summary.test.ts` | Exit 0; 18/18 | `native-summary-final.log` |
| `timeout --kill-after=15s 420 ./node_modules/.bin/tsx --test test/e2e/cross-process.test.ts` | Exit 0; 1/1 OS-child scenario | `cross-process-final.log` |
| `lean docs/programming-thinking/watchdog-review-history.idea.lean` | Exit 0 | `lean-typecheck-final.log` |
| `lean --run docs/programming-thinking/watchdog-review-history.idea.lean` | Exit 0; deterministic examples passed | `lean-run-final.log` |
| `openspec validate reduce-false-positive-continuations --strict --json` | Exit 0; `valid: true`, `issues: []` | `openspec-closeout.log` |

Seven parent counterexamples first failed at real assertions, then passed after repairs; persistent tests now cover those conditions. Preserve `review-counterexamples-v2.log` and `review-counterexamples-fixed.log`, plus the earlier import-error log. The import error was not a product failure. Preserve diagnostic-reentrancy red output and intermediate formatting/test failures too. Earlier worker failures, the interrupted leaking test, and the native-summary dependency-resolution failures remain evidence in `/var/tmp/cw-apply-a8451ef7/` and the prior recovery directory; they are not final passes.

### Pre-repair formal scope and gate disposition

The final annotated recovery model hash is `4a548f2972ccbe7069511f89765a77398cbd67a91475755cd177c3fb577be00c`. Lean 4.34.1 accepts `process_is_correct` using `propext`; sibling exclusion additionally uses `Quot.sound`. It models terminating read-only recovery, incomplete source/audit association, canonical outcome distinct from response, unchanged opaque live state, and independence from the new session ID. It assumes correct host ancestry, eligible pre-review source IDs and already decoded records. It is **not** a refinement proof of TypeScript, the host's storage, text classification, excerpt selection, or natural-language judgment. The three older lifecycle models are unchanged; their earlier runs do not establish these new properties. The independent reader recovered the declared transformation and its limits, including the four-conjunct top-level theorem versus the separately proved properties. Parent accepted this semantic round trip, not a proof of implementation correctness.

At that checkpoint, independent reviews were complete, not waived. Code acceptance was blocked by the three confirmed defects. Task 4.3 covered only the prior hash above; the repair candidate's changed model and outstanding re-review are recorded in the current section.

Model efficacy remains limited to the pilot recorded below. The original false continuation has not been shown fixed; schema validity, correct references, fixture verdicts, storage recovery and Lean proofs do not establish semantic coverage. The historical experiment-budget/authorization discrepancy also remains unresolved. No further model trials or optional third-party reviewer feature were added.

## Observed problem

The watchdog sometimes returns continue because it claims that a final response has not been delivered, although the immediately preceding ordinary assistant reply already delivered it. The next ordinary turn points out the duplicate work, and the following watchdog check unlocks.

## Captured case: 2026-10-06 (+08:00)

- 14:23:31: the complete hide-watchdog-abort-notice planning summary was delivered, including paths, artifacts, strict-validation result, and the next apply command. Session entry: 5777ed43.
- 14:23:41: the watchdog inquiry was appended, roughly 10 seconds later. Inquiry entry: b44c3dba.
- 14:23:54: the decision audit claimed the final planning summary had not been delivered and returned continue / WORK_REMAINS. Audit entry: 280f83fc.
- 14:24:12: the ordinary assistant corrected the stale claim instead of repeating the summary.
- 14:24:30: the next decision returned unlock / JOB_DONE. Audit entry: 3b31e15d.
- Source session: 2026-10-06T06-00-59-362Z_01a10fcd-0ee1-7280-a5bf-078763649e80.jsonl. Keep raw session content private; these entry IDs are local diagnostic references.

## Verified evidence and limits

A read-only replay of the recorded prefix through buildSessionContext, foldDecisionContext, and convertToLlm retained the complete final summary as the last ordinary assistant response. The replay contained 161 messages and no compaction entry. Installed plugin and working-copy runtime, config, decision-protocol, and context-fold sources matched by hash.

The bad decision used the same recorded model as the surrounding turns and reported 160715 input tokens including cache reads. The actual inquiry already contained the rule not to repeat an already-delivered answer.

This rules against an early pre-response check and against loss in the replayed plugin folding path. It does not capture the final provider wire payload, prove a particular attention mechanism, measure the frequency across sessions, or demonstrate efficacy of a proposed fix. The private historical provider request has not been replayed exactly; the live pilot below used reconstructed inputs instead.

## Current design gap

src/decision-protocol.ts validates decision shape, allowed reason types, and reason length, but does not establish whether the claimed missing deliverable is actually absent. Existing input-fidelity tests explicitly do not measure real-model decision accuracy. A syntactically valid false-positive continue is therefore accepted and only corrected during the subsequent ordinary turn.

## Pilot evidence and selected direction

The isolated pilot used `gpt-6-luna` with requested reasoning effort `low`, reconstructed source material, and no execution of returned tools. The raw private session was not uploaded. Treatments and changed fixtures are separate experiments, not one pooled accuracy score.

| Experiment | Baseline | Evidence view | Additional treatment |
| --- | --- | --- | --- |
| Six short cases, one return per arm | 5/6 expected actions | 6/6 | Structured-reference contract: 6/6 |
| Repeated authorization case, two returns per baseline/view arm | 1/2 incorrectly waited for permission | 0/2 incorrectly waited | Assessment-first later passed one short probe |
| Long complete report, two returns per arm | 2/2 correctly unlocked | Bounded view: 2/2 | Assessment-first: 2/2 |
| Same long context with requested next command missing | 0/2 correctly continued | Bounded view: 0/2 | Assessment-first: 2/2 |

The final treatment requested a concise component-by-component delivery assessment in existing `reason_content`, then `reason_type` and `action`. It also passed three single-return short probes: permission already granted, an earlier request still unfinished, and an earlier delivery already complete. Its correct missing-command reasons called for supplying the command, not executing unapproved implementation.

This is a promising signal for missing-deliverable recognition, not proof that the original already-delivered false continuation is fixed: the reconstructed complete-report controls did not reproduce that failure. The treatment was adjusted after inspecting failures and was not independently held out. Assessment wording and output order changed together; their separate causal effects were not established. Valid protocol output, source references, mock responses, and storage tests do not prove semantic correctness.

Use the bounded view and assessment-first guidance as the implementation candidate. Do not adopt the extra structured-reference contract, another model, or a task ledger. Attach source metadata to existing inquiry/marker/audit/outcome records rather than introducing another review journal or a review-write prerequisite for work. See `design.md` for the source-budget policy; production overflow handling differs from the fixed pilot and requires its own deterministic coverage without a claim of measured model efficacy.

### Costs and accounting

The currently available journals contain 36 unique reservations, 35 completed returns, one local pre-evaluation failure (`totalTokens` metadata access), and no pending reservation. The local failure remains charged conservatively. The recorded totals are 254,341 non-cached input tokens, 1,018,880 cached-input tokens, and 3,017 output tokens (1,276,238 total). The SDK cost fields are zero without a reliable billing rate; this is not a claim that the calls were free.

Across the four long returns per arm, baseline incoming tokens averaged about 102,499 versus 103,661 for assessment-first; outputs averaged about 82 versus 109. Recorded mean latency was about 4.25 versus 5.60 seconds. Cache state, execution order, and sample size prevent treating that difference as a production performance guarantee.

The evaluation closeout reported that 17 calls had been made after the read-only synthesis boundary, despite an earlier summary reporting budget exhaustion. The current directory count does not reconcile that history or establish authorization compliance. Recording the findings and approving this plan do not retroactively authorize those calls. No further experiment or provider call is authorized here.

### Local evidence and remaining limits

- Journals: `/var/tmp/pi-continue-watchdog-eval/sessions/*.jsonl`; retained as local evidence, not a product store.
- Runner: `/var/tmp/pi-continue-watchdog-eval/runner.ts`, SHA-256 `d188faa29fc4282cd8501f6e013a998a918a83151e1893a25b120c418dd46b05` at reconciliation. Do not rerun it or reset its reservations.
- Six earlier offline checks established feasibility of hidden ancestor records, sibling exclusion, rewind, inherited fork IDs, compaction ancestry, and a fresh-process reopen. They do not establish production integration or autonomous survival of a leaf-only navigation across native reopen.
- No exact historical-wire replay, installed-plugin live-quality result, comprehensive long-context robustness, or semantic coverage guarantee is available.
- Native integration and the three review repairs have the frozen-candidate offline evidence and independent approval above, with the packed-timeout uncertainty explicitly retained. Existing raw evidence must remain preserved; any future semantic study needs separate authorization and a new explicitly scoped budget.

## Boundaries

Do not add another generic do-not-repeat sentence as the sole fix; that instruction already existed. Do not automatically unlock merely because a response says done or because a final reply exists. Do not resurrect completed, cancelled, or superseded requests, but continue to detect genuinely unfinished authorized work. Keep review data in the owning native session JSONL and follow its tree; restore history, not old execution authority. Preserve Esc, abort, manual unlock, existing publication behavior, and the completed abort-notice work. `pi-llm-as-jev` remains deferred, optional, and default off; it is not a prerequisite or a fallback for these results.
