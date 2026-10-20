# Design: consume-stateless-judgment-v2

## Context

Watchdog-side lane of the root cross-repository change `simplify-stateless-judgment-ecosystem` (`/home/xz/Code/ai/pi-llm-as-jev/openspec/changes/simplify-stateless-judgment-ecosystem/`). The root proposal, all seven delta specs, `design.md`, `tasks.md` and `execution.md` are authoritative; the design's "Adapt watchdog without changing who can unlock" section and the `judgment-ecosystem-integration` watchdog requirements remain controlling. This file records watchdog-local decisions within that contract, not new product behavior.

Current watchdog source is entirely v1: `src/unlock-review.ts` discovers `version === 1 && reviewVersion === 1` and calls `review()`; `runUnlockReview` requires `unresolved: []`-admissible results and `diagnostics.observationCoverage === "complete"` before accepting a challenge; `src/runtime.ts` persists `attemptCount`/`observationCoverage`/`usage` (v1 knownSum/missing shape) on review records. The canonical v2 client (`52b404eb…`) exposes `judge()` only, with no unresolved, no diagnostics object, no reuse counters and flat optional `usage`.

## Goals / Non-Goals

**Goals**

- Compatibility is `version === 2 && typeof judge === "function"`, checked at each eligible call without probe inference; v1/missing handles keep existing unavailable/incompatible incomplete-review behavior.
- Acceptance uses only the strict final-answer contract: live `stop` + present, correctly typed, legal required choice + no dropped required id + `contextOverflow !== true`.
- No observation-completeness substitute is fabricated; diagnostics keep only backend/model, bounded errorMessage, contextOverflow and optional scoped usage.
- Actual-candidate-service tests execute through `PI_JUDGMENT_SOURCE`, not skip.

**Non-Goals**

- No watchdog-side judgment cache, retry engine, outer timer, local inference fallback, capacity packing loop or cropping.
- No changes to private-inquiry runtime, Escape/`onTerminalInput`, `createWatchdogRuntime` import, dependency pins/`allowScripts`/`trustedDependencies`, CI workflows, `PLAN/`, or the independent `consume-shared-private-inquiry-runtime` change.
- No Git writes, installation/activation, live credentials or paid inference.

## Decisions

### 1. `ReviewServiceLike` becomes the v2 `judge` surface

The test seam and runtime call sites currently type the discovered service as `Pick<ReviewService, "review">`. Rename-free minimal change: `ReviewServiceLike = Pick<JudgmentService, "judge">`. The `options.reviewService` injection point, `discoverUnlockReviewService()` statuses (`available`/`unavailable`/`incompatible`) and the one-pending-review ownership are unchanged; only the capability predicate and call change.

### 2. Acceptance is the strict final-answer contract

`runUnlockReview` keeps its guarded-decode structure and the exact same `UnlockReviewOutcome`/`UnlockReviewIncompleteReason` public shape minus the two removed reasons:

- `signal.aborted` before/after the call → `aborted` (unchanged fences).
- `stopReason === "aborted"` → `aborted`; `stopReason === "error"` or `contextOverflow === true` → `error`; any other non-`stop` → `malformed`.
- Required answer absent, not a plain object, `type !== "choice"`, or an illegal label → `malformed`.
- `dropped` must be an array of strings that does not contain the required question id; containing it → `malformed` (a dropped required answer is a missing answer). A non-array `dropped` → `malformed`.
- `insufficient_evidence` → `insufficient-evidence`; `supported`/`challenged` map to the same outcome kinds.
- Gaps in `state.gaps` still suppress dispatch entirely (`insufficient-evidence`, zero business calls).
- Removed reasons `unresolved` and `unobserved` are dropped from the union; their class of rejection is covered by `malformed`/`error` without reference to observation state.

`UnlockReviewReport` keeps `backend`, `model`, `errorMessage`, `contextOverflow`; `attemptCount`/`observationCoverage` are deleted and `usage` becomes the v2 flat `Usage` (reported verbatim, never synthesized).

### 3. Record shape stays `version: 1` minus dead fields

`UnlockReviewRecord` keeps `version: 1` (the record format did not change semantically: supported/challenged/incomplete + optional context fields). `attemptCount` and `observationCoverage` fields are removed from the interface and both write sites; `usage` becomes `{ input, output, total }`-style passthrough of the v2 `Usage` totals actually reported. Historical records remain readable history; `readReviewHistory` tolerates missing fields already because all are optional.

### 4. Actual-service fixture mirrors audit's seam, watchdog-shaped

`test/actual-service-fixture.ts` imports `createJudgmentService` from `PI_JUDGMENT_SOURCE/src/service.ts` at test time (tsx executes TS directly) with a fake `ServiceRegistry`: a scripted native classifier model (`typesafe/jev-*`) and a scripted `streamSimple` LLM, plus `nativeFetch` assertion that no live transport occurs. Tests cover: supported and challenged through `runUnlockReview`, primary native failure → LLM fallback success, caller abort mid-call, and incomplete on forced error — asserting real candidate code paths, not a handwritten protocol fake.

### 5. Lean model keeps its shape, drops dead inputs

`unlock-review-boundary.idea.lean` removes `requiredUnresolved`, `completeObservation` and `reportedAttempts` from `ServiceResult`, the `.unresolved`/`.unobserved` `IncompleteReason` cases, and the `optional_attempt_count_does_not_authorize` theorem (its field is gone). `AcceptedChallenge` drops the observation conjuncts. `watchdog-review-history.idea.lean` models response attempts (1–3), not service transport attempts — unchanged.

## Risks

- Acceptance now permits a `challenged` result that the old observation gate would have rejected — this is the intended v2 semantics; every remaining gate (source gaps, candidate identity, currentness, publication, single reconsideration) is unchanged.
- Old `incompleteReason` values `unresolved`/`unobserved` still appear in historical records; they remain readable strings, never re-emitted.
