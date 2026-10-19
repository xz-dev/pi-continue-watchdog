## 1. Freeze existing behavior and shared readiness

- [x] 1.1 Map existing main specs and current private execution tests to the shared Interface and remaining Continue adapter; verify no behavior delta is introduced, `skip_specs: true` stays deliberate and unrelated `PLAN/provider-retry-accounting.md` is unchanged.
  - Evidence: no main spec changed (skip_specs kept). Existing private tests ran unmodified except for import paths and retryPolicy on the direct fork fixture. PLAN/provider-retry-accounting.md sha256 ef26c579… unchanged and excluded from the commit.
- [x] 1.2 Verify a candidate shared entry satisfies full-fork/context/model, own-response/write, three-attempt, helper-denial and cancellation contracts through an installed fixture; record a blocker rather than retaining a second local executor if the shared conformance is incomplete.
  - Evidence: utils 371d47f runs Continue's private-decision suite verbatim (28/28), real Pi 1.3.0 evidence and cancel tests (7/7), and a packed production install (see utils progress.md). No second executor remains here: src/private-decision.ts delegates to runPrivateInquiry.

## 2. Replace only the execution seam

- [x] 2.1 Route private fork and file/correction operations through the shared module while retaining the existing validator/prompt builders; verify normalization, configured identity, extra-field/property-order handling and 500-guidance/1000-code-point acceptance cases remain unchanged.
  - Evidence: src/private-decision.ts keeps validateDecisionArguments and the prompt builders, and passes naming watchdog_result_file/decision.json/watchdog-decision-. npm run check 569/569, including decision-protocol, decision-file-prompt and runtime prompt tests.
- [x] 2.2 Keep optional unlock review and at most one reconsideration in the consumer adapter; verify one child, at most two inquiries/six consumed responses, unchanged fallback and no second review or main-model rewrite.
  - Evidence: unlock-only review gate lives in the adapter. private-decision.test.ts 28/28 covers one child, two inquiries, six responses, no replacement review and no continue review.
- [x] 2.3 Connect exact cancellation/currentness and safe audit observations to existing operation ownership; verify private Escape/slash/shortcut, review cancellation, late writes, source/branch replacement and listener teardown, while ordinary/main continuation abort stays native.
  - Evidence: same operation signal/isCurrent/onStarted/onResponse wiring in runtime.ts (unchanged); runtime and unlock-review lifecycle tests within 569/569, and packed E2E Escape/manual-unlock cases within 43/43.
- [x] 2.4 Preserve final-effect accounting and durable publication outside the shared module; verify continue and WAIT_CALLBACK each charge one final unit, actual unlock/format/review charge none, and receipt failure, rollback, optional audit gaps and stale callbacks retain existing behavior.
  - Evidence: accounting/publication code in runtime.ts untouched; budget, receipt and rollback tests within 569/569.

## 3. Transfer package ownership without duplication

- [x] 3.1 Consume the verified shared revision and remove superseded local pi-subagents dependency, patch assets and preparation hooks; verify no alternate local file executor or runtime transport switch remains and private runtime loading works solely from installed shared assets.
  - Evidence: removed the watchdog-subagents-runtime dependency, bundledDependencies, patches/, scripts/prepare-private-runtime.mjs and the postinstall/prepack hooks. The runtime loads only from the utils-prepared private-inquiry-subagents-runtime.
- [x] 3.2 Update package inputs/lockfile and distribution fixtures without global changes; verify clean production-only Git and packed installs under the current npm policy, the actual Pi loader, SDK identity and no bundled second host or required public subagent installation.
  - Evidence: clean /var/tmp copy with no node_modules, using Pi's own git-install command (npm install --omit=dev --legacy-peer-deps) under allow-git=root. Exact-commit allowScripts approval was required, since a name-only entry does not match a git dependency. Result: utils postinstall prepared the single hoisted runtime (exports ./watchdog-runtime only, no pi manifest), with no EALLOWGIT, no script warning and no nested copy. Packed/cross-process/native-summary E2E fixtures prepare via the utils script after --ignore-scripts.
- [x] 3.3 Preserve read-only legacy folds and native history/summary recovery; verify reopened sessions need no child transcript/file and restore no execution authority, lock, retry or publication.
  - Evidence: native-summary E2E 18/18 and private-history tests pass unchanged.

## 4. Close regression and documentation gates

- [x] 4.1 Update current documentation and only affected Lean process annotations/models during apply; verify each changed exact Lean file typechecks/runs under the prescribed toolchain/proof rules and receives an independent fresh-context semantic read, without changing archived historical evidence.
  - Evidence: README/architecture/behavior-contract describe utils ownership plus the root runtime dependency. No Lean model references the executor location or the packaging, and behavior is unchanged, so no Lean file needed changes or review.
- [x] 4.2 Run the complete existing `npm run check` and `npm run test:e2e` plus relevant intentional-break controls; verify actual fresh counts, no weakened compaction/receipt/cancellation assertions and separate new evidence from the archived 569/62 baseline.
  - Evidence: fresh npm run check passes (569/569). Fresh npm run test:e2e: packed 43/43, cross-process 1/1, native-summary 18/18 = 62/62. No test assertions were weakened; only fixture pins and paths changed.
- [ ] 4.3 Run stock-host PTY controls with `gpt-6-luna` and installed dual-watchdog/public-subagent/foreign-tool cases; verify exact-child aborted outcome, ordinary main controls, selected session, callback/budget semantics and unchanged public registration.
- [ ] 4.4 Record conformance results, dependency identity, remaining risks and rollback instructions for review; verify only separately authorized commits/pushes or publication actions occur and no runtime fallback or old-file authority is introduced.
