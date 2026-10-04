## Why

The proactive unlock contract encourages the working agent to stop by calling an always-advertised unlock tool. Hiding its description alone would leave the same premature-stop path. Restore the watchdog-owned decision inquiry used before commit `7ae0183`, but replace XML answers with a minimally disclosed, phase-gated function call. The user also requests removal of the jev integration because it has not been useful in practice.

## What Changes

- **BREAKING**: Remove the ordinary-work proactive unlock contract, including startup instructions to call an unlock tool before ending a turn. Merely being locked will no longer authorize a model-issued unlock.
- Restore the inquiry-first flow: an eligible terminal settlement, aggregate-idle check, and existing idle fence open a separate watchdog decision window. The watchdog then asks whether to continue, wait, or unlock; ending an ordinary turn is not itself an instruction to continue or a valid stop decision.
- Register one reserved result function with a fixed declaration: description exactly `don't use unless ask`, no advertised parameter fields or required arguments, and no startup usage guidelines. Keep the declaration stable instead of dynamically switching the tool list. Use a name distinct from reflect watchdog's `ref` function.
- Accept result submissions only for the current main attachment's active, locally confirmed decision attempt. Outside that window, object-shaped calls reaching plugin authorization return `This function is reserved for the plugin. Please try another function.` without changing lock state or exposing action/reason requirements. Native container validation may reject non-object input first, also without watchdog effects.
- Teach the function's arguments only in the watchdog decision prompt and its correction prompts. Restore the old decision outcomes: continue, bounded wait, and unlock. Preserve the distinction between a bounded wait and an unlock for a callback; retain configured stop reasons, including `WAIT_CALLBACK`, without advertising them during ordinary work.
- Restore bounded invalid-result correction, decision-failure handling, wait deadlines, and the associated result events/hooks. During a decision, permit the result function rather than the old blanket tool prohibition; unrelated work tools remain unavailable in that decision window. Do not restore XML parsing or accept XML as a fallback.
- Fold completed decision inquiries, instructions, submissions, and results out of later ordinary model requests. Preserve legacy session readability without rewriting history. Do not claim that native compaction erases persisted function arguments.
- **BREAKING**: Remove jev automatic wait classification and unlock-reason review, their requests, rejection counters, dedicated configuration, tests, and documentation. Obsolete jev configuration must be diagnosed without echoing secrets. Do not remove shared TypeSafe/OpenRouter credentials or unrelated provider integrations.
- Preserve current main ownership, cross-process activity tracking, idle-fence timing, manual unlock, user-takeover resets, terminal abort/error handling, and continuation retry/exhaustion safeguards. Restore decision machinery rather than reverting newer unrelated fixes. New code, prompts, errors, and documentation will use English.

## Approved acceptance revision

The user approved plugin-only delivery and then a command-level unsigned commit and normal push to `origin/master`. The three revised boundaries are: local owned-run/context confirmation rather than certification of the final provider payload after arbitrary later handlers; authorization before plugin payload validation rather than before native object-container validation; and pre-dispatch normal-stop suppression of malformed owned batches rather than per-call terminating results for calls that never dispatch. These are deliberate requirement revisions, not technical repairs of the earlier host counterexamples.

All other safeguards remain required: ordinary/provisional/stale calls are inert, inquiry responses are bounded, decision tools cannot perform ordinary work, continue/wait share accounting, and ownership, durable publication, wait, cancellation, abort/error, and jev-removal behavior remain intact. No host edits, deployment, global signing changes, force push, or main-spec sync/archive are authorized.

## Capabilities

### New Capabilities

- `decision-response-contract`: Reintroduce watchdog-owned decision windows and the continue/wait/unlock result contract, using a reserved function instead of XML, with bounded correction and context folding.
- `watchdog-waiting-hook`: Restore the signal for an accepted bounded wait and its timing information.

### Modified Capabilities

- `ai-unlock-tool`: Replace proactive ordinary-run unlock authority with a stable minimal declaration and decision-attempt authorization.
- `automated-continuation-message`: Publish ordinary continuation only after a continue verdict; remove the instruction that every ordinary turn must end by calling unlock.
- `terminal-outcome-gate`: Route qualified settlements into decision inquiries instead of direct continuation or jev classification.
- `watchdog-event-timeline`: Restore decision-result, wait, and failure events while keeping inquiry internals out of ordinary context.
- `watchdog-owned-run-cancellation`: Include the restored decision runs in ownership-scoped cancellation without aborting unrelated work.
- `watchdog-semantic-hooks`: Restore decision-derived continuation/wait/failure signals and preserve idle-gated user-ready publication.
- `watchdog-configuration`: Restore decision-specific configuration needed by the inquiry flow and remove `jevWaitCheck` and its obsolete integration settings.
- `unlock-tool-delivery-boundary`: Keep user-facing delivery separate from control results, but apply decision-submission guidance only within the decision phase.
- `wait-callback-reason-type`: Keep callback waiting available as an in-decision stop reason; remove startup and ordinary-turn proactive-unlock guidance.
- `jev-wait-user-gate`: Retire the automatic external classifier capability and all of its requirements.
- `jev-unlock-reason-review`: Retire the external unlock-review capability and all of its requirements.

## Impact

- Rework `src/runtime.ts`, `src/controller.ts`, and `src/unlock-tool.ts`; restore a function-based decision protocol and adapt `src/context-fold.ts`, event/hook handling, configuration, commands, and extension wiring as required by the inquiry lifecycle.
- Remove the jev-specific implementation in `src/jev-wait-gate.ts` and its integration paths; retain shared provider credentials and unrelated dependencies unless source inspection proves they are exclusive to this integration.
- Update unit/runtime tests, packed Pi integration fixtures, user documentation, and affected lifecycle Lean models. Verify ordinary/provisional/stale submissions cannot unlock; only a confirmed current decision can act; continue/wait/unlock and bounded corrections behave as specified; no jev network request remains.
- Fixed declarations avoid tool-list churn, not all possible cache misses. Restoring a separate decision request adds the deliberation step intentionally removed by the proactive-tool migration; this is the intended behavioral trade-off.
- Restored optional wait/failure hooks must be documented for downstream consumers. This change does not automatically edit the pi-notify repository, installed plugin copies, or machine-local notification settings.
