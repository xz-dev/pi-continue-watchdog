# Private fork decision acceptance map

## Authority and status

The user selected apply for this change after confirming the private dependency/patch boundary, designated JSON result file initialized to `{}`, same-child format correction, and a one-model-response limit per attempt. The change's seven delta specs are the operative acceptance criteria. Existing policy retained by those specs includes three response attempts per inquiry, at most one optional reconsideration with its separate three-response allowance, current reason normalization, continuation/callback accounting, and review behavior.

This map is task 1.1's implementation input, not proof that the new behavior exists or that the user has accepted an implementation. No new production behavior or new acceptance tests were implemented when this map was created. Any product decision that would change those criteria must return to the user rather than becoming a test-only exception.

## Existing verification seams

- `test/runtime.test.ts`: `createHarness`, `FakeClock`, lifecycle events, owned-run cancellation, aggregate activity, staged results, and native publication receipts. Adapt the decision-execution seam while retaining controller/publication assertions.
- `test/e2e/packed.test.ts`: `makePackedFixture`, `startMockServer`, `createSession`, and recorded provider requests using the declared stock Pi package. Extend this existing packed fixture for child identity, file writes, public registration isolation, and the absence of private traffic in the main request.
- `test/fixtures/packed-pi-child.ts` and `test/e2e/cross-process.test.ts`: real process-domain/external-activity behavior, distinct from the owned internal child.
- `test/e2e/native-summary.test.ts`, `test/context-fold.test.ts`, and `test/summary-projection.test.ts`: compaction, branch summaries, and read-only legacy inquiry projection.
- `test/two-outcome-lifecycle.test.ts`, `test/controller.test.ts`, and existing payload/schema tests: unchanged outcome policy and value normalization. Public `cw` registration assertions describe old behavior and must be replaced, not retained as a requirement to expose the tool.
- `test/unlock-review-runtime.test.ts`, `test/unlock-review.test.ts`, and `test/review-context.test.ts`: review eligibility, permitted macro evidence, incomplete fallback, one reconsideration, safe audit associations, and recovery.

## Capability-to-evidence plan

| Capability delta | Observable acceptance examples | Existing fixture to extend | Required evidence during apply |
| --- | --- | --- | --- |
| `watchdog-private-fork-decisions` | Distinct child uses the parent's active model/effective context; selected main session is unchanged; `{}` alone is invalid; one response includes its admitted write but no automatic follow-up; invalid-then-valid uses the same child; third invalid response produces no fourth request. Public subagents co-installation does not alter internal selection or add registrations. | Runtime harness and packed local mock provider; focused private-runner contract probe using the declared Pi SDK. | Child/session identities, provider response trace, admitted filesystem effects, terminal handoff count, and parent transcript/summary absence. No live paid provider is needed. |
| `ai-unlock-tool` | Standalone watchdog registers no `cw` or structured-output result function; a foreign `cw` remains untouched; actual unlock and callback suspension retain their existing distinct effects. | `test/observer-only-control.test.ts`, former tool declaration tests, runtime/packed fixtures. | Before/after tool and command registry snapshots plus ordinary request declarations and final status/hook records. |
| `decision-response-contract` | Current file results retain mixed-case/action-specific reason rules, `ß` identity, extra fields, property-order independence, and 1000-code-point bounds. Mixed ordinary work is prevented. Invalid responses remain local and do not charge `maxContinue`; only final accepted effects do. | `test/two-outcome-lifecycle.test.ts`, payload tests, runtime harness, packed request trace. | Validator boundary cases and actual response/publication counts; no function call or assistant prose can substitute for the file. |
| `unlock-tool-delivery-boundary` | A reason containing an otherwise missing requested answer cannot close delivery; no result-file path or call-to-stop instruction appears in ordinary startup context. | Existing decision-guidance tests and packed request captures. | Private task guidance plus ordinary main request/transcript assertions; resumed ordinary delivery remains the only place that answer is delivered. |
| `watchdog-owned-run-cancellation` | Manual unlock/takeover cancels the exact private child without aborting new user work; late writes/review replies are inert; own child activity does not invalidate itself, but genuine external work does; ordinary continuation abort behavior remains unchanged. | `test/runtime.test.ts`, `test/abort-outcome.test.ts`, unlock shortcut tests, packed and cross-process fixtures. | Deterministic barriers around generation/write/review and ownership transitions; verify no late charge, new inquiry, duplicate notification, unrelated abort, or private presentation residue. |
| `watchdog-review-context` | Parent source evidence and safe audit associations survive restart without a temporary file; no private prompt/correction/path/raw output enters main or summary context; owned audit appends do not invalidate their own source anchor; sibling/compacted/legacy traffic remains excluded correctly. | `test/review-context.test.ts`, context/summary projection tests, packed native-summary fixture. | Parent native branch records and actual model/summary requests; audit readback without restoring locks, child work, result authority, or automatic publication. |
| `watchdog-unlock-review` | Only an initial valid unlock is reviewed; unsupported/incomplete review preserves a current candidate without extra model work; one definite challenge remains in the same child, permits at most three further responses, and is never reviewed again. Private retries are not external macro evidence. | `test/unlock-review-runtime.test.ts`, `test/unlock-review.test.ts`, private-runner trace and packed fixture. | Frozen parent evidence, same child identity through review/reconsideration, review count, at-most-six consumed decision responses, and unchanged final callback/continuation accounting. |

## First vertical slice and ordering

1. Gate private runtime/SDK compatibility and a real one-response-plus-write stop before replacing production dispatch. A peer version range alone is not a conclusive incompatibility probe.
2. Demonstrate the unmet valid-file decision criterion through the existing acceptance fixture, then make that one no-review slice pass with the existing publication path.
3. Add same-child invalid-to-valid correction and three-invalid exhaustion, then cancellation/currentness and file isolation.
4. Add optional review/reconsideration and budget/callback cases, then public surface retirement and legacy recovery.
5. Broaden to clean packed/co-installed scenarios, full checks, affected formal models, and human review.

Automated red must fail for the missing capability, not an unresolved import, uninstalled package, network access, or broken fixture. At the end of each implemented slice, temporarily break its intended guard in an isolated controlled check and prove the acceptance assertion detects the failure; restore the guard before presenting green evidence.

## Baseline evidence

- Command: `npm run check` in the project, before implementation changes, using the original Pi `0.85.1` baseline. This remains historical pre-upgrade evidence, not validation of `1.3.0`.
- Result: exit status 0; lint, typecheck, existing tests, and build passed.
- Existing non-blocking warning: `src/runtime.ts:2690`, Biome `lint/complexity/useOptionalChain`. Not changed by this task and not evidence for or against the new capability.
- Current source still sends inquiry prompts into the main session and registers `cw`; current packed fixtures explicitly assert that old contract. Baseline green is therefore regression/setup evidence only, not new-feature acceptance or an automated red demonstration.
- Future packed/install probes use task-scoped `/var/tmp/` storage, including `TMPDIR=/var/tmp` where existing fixtures call `os.tmpdir()`. They must not contact a production provider, install system packages, or modify globally installed extensions.

## Selected baseline verification

- After the user's compatibility choice, project SDK/TUI dependencies were pinned to `1.3.0` and peer support raised to `>=1.3.0`; no global Pi or installed public plugin was changed.
- A non-mutating ESM probe on the installed `1.3.0` SDK confirmed `buildSessionProjection`, `buildContextEntries`, `createBranchedSession`, the three transcript helpers, and the `context_with_system` declaration.
- The existing private `_checkCompaction` test double needed the new model/projection lookup members; its abort/no-compaction and successful-threshold control assertions were preserved.
- Focused native-abort compatibility cases: 4 passed. Updated `npm run check`: exit 0, all 477 existing tests passed; the pre-existing optional-chain warning remains.
- This validates the new SDK baseline only, not the private runner or one-response file-write behavior.

## Scope protection and remaining gates

- `PLAN/provider-retry-accounting.md` is pre-existing unrelated work and remains untouched.
- The user explicitly selected raising Pi compatibility during apply after inspection found missing fork projection APIs on `0.85.1`. The selected stable project SDK/TUI baseline is `1.3.0`, with minimum Pi support raised to `1.3.0`; no legacy `0.85.1` adapter is required.
- No new test framework, public runner API, transport retry policy, configuration, or upgrade of a user's global Pi installation is authorized. Project-local dependency and support declarations are the approved baseline change.
- Tasks 1.2-1.4 remain incomplete until the private patch, declared SDK compatibility, real single-response control, and clean packed installation are proven.
- Missing host support or a need to change compatibility scope is a pause/decision point, not permission to weaken full-fork inheritance, silently start fresh, bypass peer checks, or return to the old public function transport.
