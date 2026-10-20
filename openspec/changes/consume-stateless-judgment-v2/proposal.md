## Why

The shared judgment service (`pi-llm-as-jev`) is breaking to version two: `review()`, review checkpoints, stage/cache callbacks, result caching/in-flight joins, persistent ledgers, learned capacity and transport-attempt observations are removed. `judge()` on a `version: 2` handle is the only inference entry. The watchdog currently requires review v1 (`version === 1`, `reviewVersion === 1`, `review()`), a complete `observationCoverage` gate and `unresolved` tracking before accepting a challenge. It must consume ordinary v2 judgments explicitly rather than fail open as "unavailable" forever or pretend v1 semantics remain. This change is the watchdog-side lane of the root cross-repository change `simplify-stateless-judgment-ecosystem` (`/home/xz/Code/ai/pi-llm-as-jev/openspec/changes/simplify-stateless-judgment-ecosystem/`); its approved scenarios and acceptance matrix control the behavior.

## What Changes

- **BREAKING**: require judgment service `version: 2` and `judge()` at the unlock-review compatibility check (`src/unlock-review.ts`, `src/runtime.ts` test seam). Version-one or missing services keep the existing bounded "unavailable/incompatible" incomplete-review path; no downgrade, direct-provider fallback or fake review adapter.
- Refresh the copied client `src/judgment-client.ts` to the canonical v2 contract: `state`+`questions` request; result with accepted `answers`, `dropped`, terminal `backend`/`model`, `stopReason`, bounded `errorMessage`, `contextOverflow`, optional scoped `usage`, optional terminal `capacity`. Remove `evidence`, `fresh`, `timeoutMs`, `reuse`, `inputDimensions`, all review/checkpoint/stage/cache/observation types. Removed request/option fields are rejected, not ignored.
- Accept a review outcome only from a live `stop` result whose required answer is present, correctly typed (`choice`) and one of `supported`/`challenged`/`insufficient_evidence`; dropped/missing/malformed required answers and `contextOverflow` remain incomplete-review conditions. The `unresolved` and `observationCoverage` gates are removed without fabricating observation evidence.
- Preserve the complete permitted macro-evidence projection, source-gap suppression (no dispatch when gaps exist), one-pending-review ownership, lifecycle/abort cancellation, late-result fencing, incomplete-review still-current-original-unlock release, and the single semantic reconsideration bound. No outer timer, cache, factual cropping, local inference fallback or retry engine is added.
- Remove transport-accounting fields (`attemptCount`, `observationCoverage`) from new review history records and runtime reporting without inventing substitutes; optional backend-reported `usage` keeps its actual scope and absence is never zero. Old history records stay readable history; persistence stays optional and context-excluded.
- Add a minimal actual-candidate-service test fixture at the existing unlock-review seam using `PI_JUDGMENT_SOURCE="/home/xz/Code/ai/pi-llm-as-jev"` with fake registries/endpoints — real candidate code, no copied service engine, no live credentials; success, failure/fallback and cancellation execute rather than skip.
- Update README, the `watchdog-unlock-review` delta requirements (and `watchdog-review-context` history requirement) and the affected process model (`docs/programming-thinking/unlock-review-boundary.idea.lean`) to final-judgment acceptance without observation completeness.

## Capabilities

### New Capabilities

(None — this change modifies existing watchdog capabilities only.)

### Modified Capabilities

- `watchdog-unlock-review`: version-two discovery/compatibility, `judge()` consumption, final-answer acceptance without `unresolved`/observation completeness, unchanged authority/currentness/reconsideration semantics, honest optional usage diagnostics.
- `watchdog-review-context`: review history requirement wording keeps context-excluded optional records while dropping required transport-attempt/observation-completeness fields.

## Impact

- Code: `src/judgment-client.ts` (copied client), `src/unlock-review.ts`, `src/runtime.ts` (review record/report fields only; private-inquiry/Escape/runtime semantics preserved).
- Tests: `test/unlock-review.test.ts`, `test/unlock-review-runtime.test.ts`, `test/runtime.test.ts` (type-only seam), plus a new actual-service fixture/test; no weakening of takeover/abort/late-result/overflow/reconsideration assertions.
- Docs/models: `README.md`, `docs/programming-thinking/unlock-review-boundary.idea.lean`, and this change's delta specs.
- External coordination: depends on root task 1.3 (canonical v2 client) and the root section-2 service candidate for actual-service checks. Audit and service repositories are out of scope here.
- Preserved: `PLAN/` (untracked, excluded), `consume-shared-private-inquiry-runtime`, `src/private-decision.ts`, Escape/private-run parts of `src/runtime.ts` including `onTerminalInput` and the `createWatchdogRuntime` import, exact dependency refs/`allowScripts`/`trustedDependencies`, `test/install-policy.test.ts`, `scripts/pi-install-smoke.sh` and CI workflows.
- No new runtime dependency, no Git writes, no installation/activation, no live/paid inference.
