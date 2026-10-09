## Why

Waiting for a genuine callback should end the current turn without releasing the watchdog lock or resetting its cycle when the callback starts work. Today `unlock` with `WAIT_CALLBACK` really unlocks and reports `AI_UNLOCK`; distinguish callback suspension from completed work while bounding repeated suspensions with the existing continuation budget.

## What Changes

- **BREAKING behavior, compatible call shape:** retain `cw({ action: "unlock", reason_type: "WAIT_CALLBACK", reason_content: "..." })`, but interpret this validated built-in pair as callback suspension: keep the lock, finish the inquiry, and suppress automatic inquiries until new ordinary main-session work begins. Other unlock reasons, including `JOB_DONE`, still unlock. Add no action or result field.
- **BREAKING configuration:** replace the plugin-specific `maxRetries` key with `maxContinue`, default `10`, retaining the existing safe-integer range of 1 through 10 and trusted configuration layering. `maxRetries` is removed, not an alias: report an error-level removed-key diagnostic without applying its value or modifying user configuration. Valid remaining settings and normal fallback remain available. This plugin budget is independent of Pi/provider transport retries and decision-format/review allowances.
- **BREAKING accounting:** accepted callback suspensions and durably published continuations each consume one unit of the same per-cycle `maxContinue`. Callback work does not replenish that budget. The final permitted suspension still waits and reports `WAIT_CALLBACK`; exhaustion becomes publishable only after resumed ordinary work settles successfully. Existing abort/error/manual and stale-outcome rules remain controlling.
- **BREAKING notification classification:** retain the `user-ready` hook and add `STOP_KIND=WAIT_CALLBACK`, with normalized `REASON_TYPE` and trimmed `REASON`, instead of reporting callback suspension as `AI_UNLOCK`. Retain existing idle/currentness/publication guards and one signal per accepted outcome.
- Show one quiet human-only callback-wait status that says the lock is retained, not `unlocked`. Keep the control exchange and status out of subsequent ordinary and native summary requests; retain history without restoring execution on reopen.
- Keep callback waiting event-driven: no duration, watchdog sleep, polling, synthetic callback, new dependency, or task subscription API. Manual unlock and new genuine user work remain escape/replacement paths.
- Preserve the separately approved optional-review scope: when enabled, `unlock`/`WAIT_CALLBACK` remains eligible for review and at most one reconsideration before its final effect. Review is about the stopping basis, not whether the effect releases the lock. Review, corrections and reconsideration do not spend the shared budget.

## Capabilities

### New Capabilities

None. Extend the existing callback capability rather than introducing a parallel waiting subsystem.

### Modified Capabilities

- `wait-callback-reason-type`: Keep the compatible callback payload, suspend within the lock cycle, resume on ordinary work, and preserve human/lifecycle overrides.
- `decision-response-contract`: Separate two wire actions from three execution effects; suppress suspended decision entry and account for callback suspension in the shared budget.
- `watchdog-semantic-hooks`: Add callback suspension to `user-ready` with its own stop kind and deferred final-budget exhaustion.
- `watchdog-configuration`: Replace the removed `maxRetries` key with plugin-specific `maxContinue`, default 10, and define shared continuation/callback accounting and safe diagnostics.
- `ai-unlock-tool`: Preserve the stable public function while exempting the callback pair from actual unlock semantics and preserving optional review.
- `watchdog-event-timeline`: Add quiet callback-suspension history and projection, truthful publication failure handling, and callback-aware exhaustion presentation.
- `terminal-outcome-gate`: Distinguish callback suspension from unlock and defer exhaustion until the resumed work settles, without changing abort or terminal-error handling.

## Impact

- Expected implementation seams: `src/config.ts`, `src/config-loader.ts`, `src/controller.ts`, `src/decision-protocol.ts`, `src/runtime.ts`, `src/auto-lock.ts`, `src/extension.ts`, `src/semantic-hook.ts`, `src/commands.ts`, and the existing control-fold/context/summary projection surfaces. Rename plugin budget interfaces, status labels and fixtures coherently without renaming unrelated host retry fields. Preserve native extension-input provenance so callback wake-ups transported as user-role messages do not reset the cycle. Preserve existing activity, ownership, native-session, and publication infrastructure.
- Existing consumers filtering specifically on `STOP_KIND=AI_UNLOCK` will no longer receive callback suspensions under that filter. Unfiltered `user-ready` consumers still receive an eligible event; consumer configuration is not automatically migrated.
- Reuse current controller/protocol/runtime/hook tests and deterministic packed/native-session tests. During a separately authorized implementation, update README and affected `docs/programming-thinking/*.idea.lean` models and validate them. No new framework or provider experiment is required.
- Integrates with `add-optional-unlock-review` without reducing its candidate scope. Its in-progress `decision-response-contract` deltas must be composed requirement-by-requirement before implementation/archive so neither full-block replacement erases the other's scenarios. Do not edit or archive that change as part of this proposal.
- This delivery writes only planning artifacts under this change. Product code, main specs, Lean files, deployment, package installation, commits and implementation remain outside this authorization.
