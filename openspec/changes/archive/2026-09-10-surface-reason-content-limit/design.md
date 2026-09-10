# Design: surface-reason-content-limit

## Context

`src/decision-protocol.ts` enforces a hard 500-code-point cap on model `reason_content` (`normalizeDecisionUnlockReason`, shared by continue/wait/unlock paths), but `buildDecisionPrompt`'s fixed suffix never mentions the cap. The user hits the re-ask error regularly. Sister-project audit (pi-reflect-watchdog, pi-continuity) confirmed: no other hidden model-facing constraint exists in this repo — reason_type lists, wait_seconds range, single-XML shape, and the no-tools rule are all already stated in the prompt.

## Goals / Non-Goals

**Goals:**
- Every enforced decision constraint is visible to the model before its first attempt.
- One source of truth for the limit: prompt guidance and rejection bound derive from a single constant.
- Lower the false-rejection rate for verbose-but-reasonable model output.

**Non-Goals:**
- No dynamic, context-window-relative limit (pi-continuity's pattern solves input-budget fitting; this limit is a display/storage constraint — reasons render in one-line TUI rows, timelines, and folded context).
- No truncation of model output (the "invalid model output must be re-asked" contract stays; human input truncation in `commands.ts` and display truncation in `context-fold.ts` are untouched).
- No new config option (YAGNI — the constant is code-owned like `MAX_WAIT_SECONDS`).

## Decisions

**D1: Hard limit 1000, prompt-stated guidance 500, linked by division.**
`MAX_REASON_CHARACTERS = 1000` is the single exported constant; the prompt text renders its guidance as `MAX_REASON_CHARACTERS / 2`. The model aims at 500, enforcement tolerates 1000 — silent headroom absorbs overshoot without a re-ask, and a future bump of the constant updates both sides automatically (user's explicit requirement: avoid the two values drifting when someone edits one).

Alternatives considered:
- *Keep 500, only add prompt sentence*: still rejects legitimate 501-800 char reasons; the user judges the cap itself too tight.
- *Truncate over-long model reasons instead of rejecting*: violates the deliberate "never truncate model output" contract noted on `normalizeDecisionUnlockReason`; silent data loss hides prompt-noncompliance signals.
- *pi-continuity-style dynamic limit from `contextWindow`*: mismatched constraint class (display/storage, not input budget); a 1M-context model would produce multi-KB reasons that every display consumer truncates anyway.

**D2: Error strings become template constants quoting the shared limit.**
`INVALID_CONTINUE_REASON_ERROR`, `INVALID_WAIT_REASON_ERROR`, `INVALID_UNLOCK_REASON_ERROR` interpolate `MAX_REASON_CHARACTERS` so re-ask text always quotes the true enforced limit. (They will quote 1000, the enforced bound — the prompt's 500 is guidance, the error's 1000 is the contract.)

**D3: Where the guidance sentence lives.**
Append to the existing fixed-suffix contract paragraph in `buildDecisionPrompt` (next to the single-XML and field-reasoning instructions), not to the configurable `decisionPrompt` — a custom prompt cannot accidentally drop the limit disclosure, matching the "fixed suffix owns the parser contract" pattern already in place.

## Risks / Trade-offs

- [Models now learn the true limit is 1000 from re-ask errors and may start targeting it] → Acceptable: 1000-code-point reasons are still bounded, and display consumers already truncate for presentation.
- [Docs/Lean model literals (500) drift from code] → tasks.md includes updating `README.md`, `docs/behavior-contract.md`, `docs/architecture.md`, and the `watchdog-user-takeover.idea.lean` bound; the programming-thinking convention requires re-validating the Lean file.
- [Boundary tests keyed to 500/501 must move to 1000/1001] → Mechanical test update, plus new assertions that the prompt quotes the guidance value.
