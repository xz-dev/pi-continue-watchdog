## Why

A syntactically valid AI unlock can still have an unsupported completion, waiting, or blocker reason. Offer a second opinion on that stopping decision, on by default, without making the watchdog depend on another model, auditing `continue`, or claiming to fix false-positive continuations.

## What Changes

- Add `unlockReviewEnabled`, a boolean defaulting to `true`, using the existing trusted configuration layering. When the review service is not installed, not configured or unavailable, show a warning and unlock normally; never interrupt. `false` restores the previous path with no lookup.
- Before committing an eligible AI unlock, discover the already-loaded `pi-llm-as-jev` review service at call time. No automatic installation, direct HTTP fallback, provider configuration, or credential handling is added.
- Review the candidate action/type/reason against a complete permitted macro-level snapshot of the owning native effective conversation. Keep public user decisions, assistant reports, labelled native summaries, and tool activity envelopes; keep `ask_user_question` question/answer text rather than reducing it to tool success. Exclude private/control material and ordinary tool payloads.
- Reuse service-owned exact-input reuse, cancellation, capacity handling, and attempt accounting. Do not substitute the watchdog's 8,000-code-point supplemental view, a recent suffix, old classifications, or processing progress for necessary facts. An unrepresentable or inadmissible necessary snapshot is an incomplete review, not a silently shortened successful one.
- A supported review releases the original candidate to existing commit/publication checks. A clear challenge requests at most one owned main-model reconsideration, not a reviewer-authored replacement verdict or repeated mutual review.
- Missing service, errors, timeout, malformed/missing answers, insufficient evidence, or incomplete context leave the original candidate available to the existing currentness checks. Record that review was not completed; never label this as approval.
- Preserve immediate human takeover/cancellation, native-session association, phase-gated `cw`, configured reasons, format correction bounds, continuation-only retry accounting, and canonical-publication behavior. Review only AI unlocks, including configured non-completion reasons; manual unlock, abort, and terminal-error unlock remain outside it.

## Capabilities

### New Capabilities

- `watchdog-unlock-review`: Default-on AI-unlock review, macro evidence/privacy projection, shared-service integration, incomplete-review fallback, bounded reconsideration, and native-session diagnostics.

### Modified Capabilities

- `decision-response-contract`: Distinguish one semantic reconsideration inquiry from format correction, and qualify the existing no-second-model assessment guidance without changing the reserved function or result fields.

## Impact

- Expected implementation seams: `src/config.ts`, `src/runtime.ts` between pending candidate creation and commit, existing native-source/control projection helpers, and a thin self-contained judgment-service client/projection adapter.
- Expected verification: existing protocol/runtime/context tests and deterministic packed/native-session integration, plus behavior documentation and affected Lean process models during a separately authorized apply phase.
- No Pi changes, TODO-board integration, task manifest, new sidecar/database, additional runtime package requirement, or independent retry/timer engine. Shared-service model selection and authentication stay with their existing owners.
- This change captures planning only. Code changes, live-model experiments, installation/reload, dependency remediation, archival/spec synchronization, commits, and pushes are not part of this planning delivery.
