## 1. Configuration and review input

- [x] 1.1 Add `unlockReviewEnabled` (default `true`) through existing trusted configuration loading. Verify absent/false/invalid/layered settings, unchanged rejection of `jevWaitCheck`, and zero service lookup when disabled and for continue, invalid calls, manual unlock, abort and terminal-error unlock. When enabled but the service is unavailable, verify a warning notification and normal unlock without interruption.
- [x] 1.2 Build the review input from Pi's effective context: full public user/assistant/custom text in order, labelled summaries, tool name/call/status only; remove owned watchdog control traffic, thinking and context-excluded bash. Verify order, compaction/sibling exclusion and no tool bodies in the captured request.
- [x] 1.3 Keep `ask_user_question` question/answer text on success; cancelled or error results keep only their status. Ordinary text Q&A stays in full.

## 2. Shared-service integration

- [x] 2.1 Discover the sealed review-v1 service (`b54611d`) at call time; absent or incompatible service is an incomplete review. No auto-install, availability probe, direct HTTP or model fallback.
- [x] 2.2 Submit one stable question with the candidate and complete input as fixed state. Overflow, error, malformed or missing answer, unobserved result, insufficient evidence or a known input gap settle incomplete; a known gap skips the service call.
- [x] 2.3 Pass no `timeoutMs` and run no consumer timer; link an `AbortController` to the decision lifecycle; at most one review per logical decision and no consumer retry.

## 3. Decision flow

- [x] 3.1 Supported or incomplete review releases the still-current original unlock through the existing publication path; incomplete is never recorded as approval.
- [x] 3.2 A definite challenge opens at most one reconsideration inquiry with the normal fixed `cw` prompt plus the challenge; its result is applied without another review. At most two inquiries per logical decision, three consumed responses each; only an accepted continuation spends budget.
- [x] 3.3 Append one review record to the owning session JSONL (outcome, backend/model, attempts, known usage). Append failure is a bounded diagnostic; reopen reads history only and resumes nothing.
- [x] 3.4 Manual unlock, user input, abort, branch/session replacement and ownership loss cancel the review immediately; late results cannot publish, relock or charge.

## 4. Wrap-up

- [x] 4.1 Run `npm run check` and the packed e2e suite with bounded timeouts and receipts under `/var/tmp`.
- [x] 4.2 Update README, behavior documentation and the affected Lean model once; check the exact Lean file by typecheck/run.
- [x] 4.3 Run strict OpenSpec validation.
