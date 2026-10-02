## Why

The agent sometimes calls `unlock_continue_watchdog` with `WAIT_USER` to ask for a go-ahead the user already gave in the current turn ("继续", "不必总是问我", an `ask_user_question` answer that picked "fix and continue"). The tool accepts any well-formed reason, so the watchdog stops and the user has to retype "continue". A retrospective spike collected 17 premature-stop candidates, not independently verified ground truth. In the narrow/v2 experiment, P(contradicted) ≥ 0.8 detected 3/17 candidates and rejected 1/15 correct-stop controls. This supports an exploratory permission review, not a calibrated accuracy claim; `JOB_DONE`, `JOB_BLOCKED`, and the untested `WAIT_CALLBACK` remain out of scope.

## What Changes

- Before a `WAIT_USER` unlock takes effect, the watchdog asks TypeSafe's jev model one Choice question over a small last-turn state: the stop claim, the latest user message plus any `ask_user_question` answers in this turn, the agent's visible replies in this turn, and a one-line-per-call tool trace of this turn.
- A `contradicted` verdict with P(contradicted) ≥ the configured threshold (default 0.8) makes the tool call fail with an ordinary tool error that tells the agent the permission was already given and to continue. The watchdog stays locked and no `user-ready` is published.
- At most 3 rejections per lock cycle; the 4th call of the same cycle is accepted without review. Every other outcome (`supported`, `insufficient_evidence`, low probability, no key, timeout, HTTP error) accepts the unlock exactly as today.
- After a tool-review rejection in a lock cycle, a confident waiting verdict from the old wait gate must pass the same permission review before automatic unlock. Both paths share the three-rejection cap; an automatic rejection dispatches the ordinary continuation instead of unlocking.
- `JOB_DONE`, `JOB_BLOCKED`, `WAIT_CALLBACK`, custom reason types, human unlocks, and abort/terminal-error unlocks are not reviewed and are unchanged.
- Review state is bounded to 24k Unicode characters. Trim oldest traces first, then assistant text, then user text and questionnaire answers with head/tail truncation markers. Missing or invalid contradiction probability fails open; confidence is never substituted.
- The gate reuses the `jevWaitCheck` endpoint, key resolution, model, timeout, and `enabled` switch; it adds one config field, `jevWaitCheck.unlockReviewThreshold` (number in [0, 1], default 0.8).

## Capabilities

### New Capabilities
- `jev-unlock-reason-review`: evidence review of `WAIT_USER` unlock calls, the last-turn state sent to jev, the rejection contract and its per-cycle limit, and the fail-open rules.

### Modified Capabilities
- `ai-unlock-tool`: "Valid call from the locked main agent unlocks" gains the precondition that a reviewed reason type passed or skipped review; the error-result requirement gains the review rejection as a named, state-preserving tool error.
- `jev-wait-user-gate`: "Gate configuration" gains `unlockReviewThreshold`; a confident automatic unlock after a tool rejection must pass the same review, without bypassing the shared cap.

## Impact

- `src/unlock-tool.ts` (async review step before `applyAiUnlock`, rejection error text, per-cycle counter via host), `src/jev-wait-gate.ts` (state builder, second Choice question, shared request helper), `src/runtime.ts` (host wiring, lock-cycle counter reset, in-flight abort), `src/config.ts` (new field).
- Tests: `unlock-tool`, `jev-wait-gate`, `runtime`, `config`.
- `README.md`, `docs/behavior-contract.md`, `docs/architecture.md`, `docs/programming-thinking/official-pi-idle-inquiry.idea.lean`.
- Privacy: the last user message, this turn's assistant text, and tool names/argument summaries (not tool outputs) leave the machine when a key is configured; `jevWaitCheck.enabled: false` disables both gates.
