# Proposal: surface-reason-content-limit

## Why

The decision prompt never tells the model that `reason_content` must be non-empty and at most 500 Unicode characters. The model only learns the rule from the re-ask error after it has already failed, so verbose models repeatedly burn the 3-attempt re-ask budget and end in `decision-failed`. An enforced constraint the model cannot see is a prompt defect, not a model defect.

## What Changes

- Introduce a single hard-limit constant `MAX_REASON_CHARACTERS = 1000` (Unicode code points) for model-provided `reason_content` in continue/wait/unlock decisions. Validation rejects only above 1000.
- Derive the prompt-stated guidance as exactly half the hard limit (`MAX_REASON_CHARACTERS / 2 = 500`), so the advertised soft cap and the enforced cap can never drift apart in future edits.
- State the guidance in the fixed decision-prompt suffix: `reason_content` must be non-empty and at most 500 Unicode characters. Models aiming at 500 get silent headroom up to 1000; re-ask fires only past 1000.
- Reword the three reason error strings (`INVALID_CONTINUE_REASON_ERROR`, `INVALID_WAIT_REASON_ERROR`, `INVALID_UNLOCK_REASON_ERROR`) from template constants so they always quote the real enforced limit.
- Audit result recorded: every other model-facing decision constraint (reason_type list, wait_seconds 1..1800, single-XML shape, no-tools) is already stated in the prompt; no other hidden constraint exists in this repo. Human `/unlock-continue-watchdog` input truncation (500) and context-fold display truncation (500) are display/storage concerns, not model prompts, and stay unchanged.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `decision-response-contract`: the fixed prompt suffix must declare the `reason_content` guidance limit; the enforced hard limit rises from 500 to 1000 code points with the guidance derived as half of it.

## Impact

- `src/decision-protocol.ts`: new exported constants, prompt suffix sentence, error strings, validation bound.
- `test/decision-protocol.test.ts`: boundary tests move from 500/501 to 1000/1001 plus prompt-content assertions.
- Docs: `README.md` (reason-content wording), `docs/behavior-contract.md`, `docs/architecture.md`, `docs/programming-thinking/watchdog-user-takeover.idea.lean` (500 literal).
- Not affected: `src/commands.ts` human-reason truncation, `src/context-fold.ts` display truncation, config `MAX_PROMPT_CHARACTERS`.
- Behavioral compatibility: previously rejected responses of 501-1000 code points become accepted; nothing that was accepted before becomes rejected. No config or API surface changes.
