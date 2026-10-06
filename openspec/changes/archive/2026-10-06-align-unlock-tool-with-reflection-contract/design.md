## Context

See `proposal.md` for motivation and `specs/` for the behavioral contract. This is a targeted restoration, not a repository revert.

Baseline source at `668b02b710bf880b2a3bf542c0550bdc5ee1e340` provides useful boundaries:

- `src/runtime.ts` owns aggregate qualification, process-domain confirmation, main claims, correlated continuation publication, takeover, and cancellation. Its qualified path currently calls jev or directly dispatches continuation.
- `src/controller.ts` owns lock-cycle and retry transitions. Historical `7ae0183^` contains the prior decision, invalid-response, and wait transitions; use those semantics without restoring XML or dynamic tool-list changes.
- `src/unlock-tool.ts` combines public proactive-unlock instructions, argument validation, state changes, and jev review. Its public declaration and ordinary-run authority are the behavior being replaced.
- `src/context-fold.ts` already retains the continue-watchdog inquiry namespace, correlation helpers, legacy folding, and cancellation filtering through `pi-extension-utils/pi-inquiry`. Keep this dependency and its current pin rather than introducing another inquiry abstraction.
- The completed reflect implementation demonstrates an open-object reserved tool, provisional versus confirmed attempts, preserving executable calls during `message_end`, and ending result batches with `terminate: true`. Reuse the pattern, not its ten-lookup allowance or its separate reflection lifecycle.
- The installed Pi extension types expose `ToolCallEventResult.terminate` for blocked calls. Termination requires every finalized result in a batch to request it; this matters for malformed mixed batches.

The existing Lean lifecycle document describes the currently shipped proactive-tool behavior. It is not proof of this proposed design and must be updated with the implementation, as described below.

## Goals / Non-Goals

**Goals:**

- Put result authorization and all lifecycle transitions behind the runtime's current owned attempt, not behind model-supplied identifiers or knowledge of argument syntax.
- Separate pure payload validation from scheduling, durable publication, and notification effects.
- Preserve newer ownership, process-domain, terminal-error, cancellation, and publication safeguards while restoring the old decision branches.

**Non-Goals:**

- No independent model client, new classifier, scheduler service, dependency, private Pi queue access, or generalized inquiry framework.
- No replay of persisted timers, rewriting session history, or automatic editing of shared credentials and notification-consumer configuration.
- No claim that valid transport proves the model's judgment about completion is correct. Actual-delivery guidance improves the inquiry but is not a correctness oracle.

## Approved plugin-only acceptance boundary

The user explicitly selected delivery against the original plugin goals, followed by unsigned commit and normal push to `origin/master`. This supersedes the earlier partial-handoff-only stopping decision. It does not authorize Pi host edits, deployment, force push, global signing configuration changes, or main-spec synchronization/archive.

Three earlier requirements are intentionally revised, not claimed to have been implemented:

1. Authority is a current watchdog-owned inquiry phase, correlated by host run/call metadata and the plugin's local context observation. The plugin does not certify the final provider payload after arbitrary later host/extension transforms.
2. The plugin checks authority before its own action/reason validation. Pi may first reject a non-object argument container against the public object schema; that native rejection must remain inert for watchdog state and must not block unrelated ordinary tools.
3. Malformed owned batches may be stopped before dispatch by projecting no executable calls. Per-call terminating tool results are not required for a batch that never dispatches. Admissible singleton calls retain their executable and required thinking blocks and terminate through their result.

Keep the fixed idle fence, current-main/cycle/run/call identity, ordinary/provisional/stale-call inertness, three-response correction bound, no ordinary side effects in a decision, shared continue/wait accounting, wait/cancellation safeguards, and jev removal. Verification must distinguish these goals from host-wide guarantees and model judgment quality.

## Decisions

### 1. A stable `cw` function with runtime-owned authority

Register one root-only function named `cw`, with label `cw`, description exactly `don't use unless ask`, and `Type.Object({}, { additionalProperties: true })`. Supply no `promptSnippet`, `promptGuidelines`, field descriptions, required fields, or configured enums. Keep registration and active membership stable throughout the session. Do not register the old `unlock_continue_watchdog` name as an alias. Existing human command and shortcut names remain unchanged.

Use a small `src/decision-tool.ts` adapter instead of retaining the proactive tool module. Put pure argument parsing and decision/correction prompt construction in `src/decision-protocol.ts`. Move existing reason normalization where it can serve both continue and unlock validation. Do not retain the old schema normalization hook that reveals configured values before authorization.

One runtime authorization check serves both the pre-execution `tool_call` gate and the function's `execute` handler. Check before plugin action/reason validation. Outside a current confirmed attempt, object-shaped calls reaching the function return the reserved-function error without requesting tool-batch termination. Pi may reject non-object containers before these hooks; such native errors must not change watchdog state or prevent ordinary work from continuing. The plugin does not replace host structural validation.

**Alternative rejected:** Hiding the old description while retaining locked-main unlock authority does not solve proactive stopping. Dynamically changing active tools would restore unnecessary declaration churn. A model-supplied nonce is not needed when the host already owns run and call correlation.

### 2. Restore inquiry lifecycle inside the current runtime

Replace the jev/direct-dispatch branch after existing aggregate qualification with an inquiry dispatch. Retain the fixed idle fence, fresh official idle query, process-domain confirmation, current-main claim, and generation checks. Budget exhaustion remains terminal rather than launching another inquiry.

Represent a pending inquiry with its current main claim, lock/lifecycle generation, active branch/session identity, inquiry handle, response attempt number, and pending result. Use three authorization phases:

| Phase | Evidence | Submission behavior |
| --- | --- | --- |
| Pending/provisional | Prompt scheduled or a run started without matching local inquiry evidence | Reserved rejection for calls reaching the function; no plugin payload validation or accounting |
| Confirmed | Exact owned prompt observed in the corresponding run and in the plugin's local context projection | Only result calls correlated to that attempt can be validated |
| Resolved/invalidated | A result is staged, the run was cancelled, or ownership/cycle/branch changed | No further submission can act |

Use the inquiry handle's `matchesPrompt` correlation at `message_start`, plus the plugin's `context` observation containing that exact current prompt, to confirm the phase. Queueing or persisting a message alone is insufficient. Match host metadata, not prompt-text substrings or arguments supplied by the model. This observation is not a final provider-consumption receipt: a later handler can replace the request. Do not inspect provider-specific HTTP payload layouts or add a provider wrapper.

Record the finalized assistant message's tool-call identity before tool execution. Correlate `execute(toolCallId, ...)` to that message and attempt. Reject replayed identifiers, provisional runs, and submissions from unrelated current work even if another inquiry is queued.

Own inquiry activity necessarily makes the main run busy. Do not invalidate the attempt merely because its own correlated run starts or ends, and do not require global idle inside `execute`. Distinguish those transitions from user takeover and unrelated activity. After the inquiry settles, recheck current ownership and fresh external activity before committing effects; never reuse the pre-inquiry activity generation as if the inquiry itself had not run.

**Alternative rejected:** Treating any `agent_start` while an inquiry is pending as authorization can capture a user's or another extension's run. Applying results immediately inside `execute` would commit before the owned run's terminal and freshness checks.

### 3. Validate one completed response before allowing its tools

Use an owned `message_end` handler to inspect the complete assistant response before tool dispatch. There must be exactly one `cw` call and no other tool call. Capture one invalid-response plan for missing/duplicate/mixed calls, unknown tools, non-object containers, visible prose, or truncation. Project an invalid owned batch to an ordinary stop with no executable calls, before native validation/unknown-tool/truncation fast paths can create unbudgeted follow-ups. Keep that first response plan until authoritative settlement. Outside the confirmed inquiry, leave ordinary responses and tool access unchanged.

For an admissible singleton, preserve its executable call and provider-required thinking until Pi dispatches it. The `tool_call` guard remains a defensive barrier for unrelated calls within the confirmed phase. An invalid owned response counts once, never once per discarded call; no work side effect or valid-looking partial verdict may escape.

For one authorized result call, parse its arguments and stage either a validated verdict or a named validation error. Return a short result with `terminate: true` for both cases, setting the error status for invalid arguments. Do not throw an authorized validation error into an uncontrolled native follow-up loop. At authoritative settlement, finalize the staged result once, or count the missing-result response as invalid. XML and prose are never fallback decision transports.

The runtime, not Pi's ordinary tool-error follow-up, schedules at most two corrections after the initial attempt. Each correction receives a fresh owned attempt and must obtain its own local run/context confirmation before it authorizes a call. Dispatch failure, deferral, cancellation, or stale ownership is not an invalid model answer. Terminal `stopReason: error` and human abort retain their existing separate paths.

**Alternative rejected:** Accepting the first result from a mixed batch can unlock before another tool performs work. Throwing for every in-window error can create extra uncorrelated model requests outside the fixed correction budget.

### 4. A small discriminated JSON contract

The decision prompt, not the public schema, explains these payloads:

```json
{"action":"continue","reason_type":"WORK_REMAINS","reason_content":"Implement the already requested change."}
{"action":"wait","reason_content":"The external job needs more time.","wait_seconds":60}
{"action":"unlock","reason_type":"JOB_DONE","reason_content":"The requested result has been delivered."}
```

Normalize action and configured reason-type values after trimming. Preserve the 1000-code-point hard reason limit and 500-code-point prompt guidance. Require JSON integer numbers for wait durations from 1 through 1800; do not coerce strings. A wait has no reason type. Restore `continueReasonTypes` defaults `WORK_REMAINS` and `VERIFYING`; retain the current unlock defaults, including `WAIT_CALLBACK`.

Use existing small validation helpers and a discriminated verdict union. Do not add an XML adapter, a second result channel, or a configurable parser policy. The fixed decision suffix owns delivery reconciliation, user-boundary priority, and function syntax; configured `decisionPrompt` precedes it and cannot weaken runtime validation.

**Alternative rejected:** Copying the old public unlock schema exposes the payload throughout ordinary work. Copying reflection's five-field result or lookup budget would change the continue domain rather than just its transport.

### 5. Controller transitions and wait accounting

Restore explicit open-decision identity, invalid-response count, decision-failed state, and current wait deadline in the existing controller. Keep operational prompt handles and Pi callbacks in the runtime.

| Accepted result | Accounting | Next effect |
| --- | --- | --- |
| Continue | One shared retry attempt | Publish one reason-bearing continuation and start its ordinary work turn |
| Wait | One shared retry attempt | Publish the accepted wait, stay locked, and arm its deadline without ordinary work |
| Unlock | No retry attempt | Clear pending work/wait state, publish the shared unlock outcome, and retain idle-gated user-ready intent |
| Third invalid response | No continue/wait attempt | Stay locked but decision-failed; publish failure and stop automatic requests for that cycle |

This deliberately restores the historical shared continue/wait budget. A wait consuming the last attempt must still reach its deadline before exhaustion can become user-ready. `WAIT_CALLBACK` remains an unlock reason and creates no watchdog timer.

Keep the current controller rollback policy for failed or demoted publication. Distinguish sending a trigger-turn message from its durable correlated lifecycle publication; synchronous `sendMessage` return is not persistence proof. Emit the continuation hook only after the corresponding publication is confirmed. Failed wait publication must neither consume an attempt nor arm an unrecorded timer.

For a wait, retain one acceptance timestamp and deadline. Use the existing timer/idle coordination to wake no earlier than the deadline and fresh qualification permit. Child activity can delay eligibility, not restart the accepted duration. Capture completed-wait timing once for the next qualified inquiry or exhaustion; corrections reuse those facts. Never reconstruct a timer from a persisted event.

**Alternative rejected:** Separate continue and wait budgets or resetting the wait after every activity burst would change the historical semantics and make total automatic activity harder to bound.

### 6. Reuse exact-exchange folding and shared event records

Keep the existing inquiry namespace and readable legacy records. Extend the current fold boundary to function-call/result pairs instead of replacing the history format or scanning sibling branches. While an attempt is active, preserve what is required to execute its response and provide a valid correction request. After finalization, fold its prompt, correction traffic, result calls, and results into the one canonical shared outcome event.

Keep continuation work correlated to its own visible event so manual cancellation never confuses ordinary work with the preceding inquiry. Preserve unrelated entries and current exact-owned-run residue cleanup. Do not access or replay Pi's private steering/follow-up queues.

Restore accepted-wait, completed-wait, AI-unlock, and decision-failure event formatting alongside continuation and exhaustion. Reuse immutable runtime timestamps and normal active-branch ordering. Restore reason-bearing `watchdog-continued`, `watchdog-waiting`, and `DECISION_FAILED` user-ready values without adding a new notification transport. All terminal hooks remain subject to current aggregate-idle and ownership checks; human/abort paths remain silent.

Document that ordinary-request folding does not erase stored arguments or guarantee their absence from native compaction/branch summaries. Shared outcome reasons are control records, not substitutes for user-facing delivery.

**Alternative rejected:** Removing an admissible call before dispatch prevents it from executing. Invalid owned batches, by contrast, must not dispatch at all. Retaining raw completed calls in normal work context repeatedly teaches the reserved protocol. Rebuilding a private event history would bypass Pi's branch and compaction boundaries.

### 7. Remove jev paths, not shared provider infrastructure

Delete the dedicated jev implementation and tests after removing callers. Remove classification caches, endpoint/key resolution, review evidence extraction, rejection counters, review abort wiring, config types/defaults, runtime injection seams, and jev-only documentation or fixture cases. Replace those tests with no-request and preserved-credential acceptance checks where appropriate. Historical archived change records remain historical records, not active integration instructions.

The remaining configuration loader reports `jevWaitCheck` as removed, naming only the key and never its nested contents. Valid neighboring settings still apply. Restore `decisionPrompt` and `continueReasonTypes` as active keys. Do not migrate configuration by writing user files, deleting environment variables, or changing provider credentials. Remove a dependency only if it has no unrelated consumers; this design requires no new dependency.

**Alternative rejected:** Keeping a disabled classifier behind a flag retains unused network and review branches and leaves room for credential-driven reactivation.

## Risks / Trade-offs

- **Extra inquiry requests and model misjudgment** -> The extra decision turn is intentional. Ground decisions in actual delivery, keep corrections bounded, and test transport authority separately from model reasoning quality.
- **Queued or foreign work mistaken for the owned inquiry** -> Require exact run/call identity and matching local context evidence; test queued inquiries, foreign starts, cancellation before confirmation, and forged/replayed calls. Do not claim this certifies later provider transforms.
- **Mixed batches bypass bounded correction** -> Inspect the complete response and suppress invalid batches before native dispatch; verify provider-request counts and absence of work-tool effects with real Pi.
- **Own inquiry activity mistaken for external takeover** -> Preserve run correlation and distinguish internal lifecycle from external generation changes. Requalify effects at settlement instead of weakening global idle checks.
- **Old configuration or consumers expect proactive behavior** -> Document the breaking tool/config changes and restored hook values; preserve shared credentials and optional consumers.
- **Draft specs mistaken for shipped behavior or a proof** -> Keep source implementation and formal-model validation as explicit later gates. The current successful OpenSpec validation establishes artifact structure, not runtime correctness.

## Migration Plan

1. Implement from current source, using `7ae0183^` only as the behavioral reference for decision/wait transitions. Do not revert the repository or its shared dependency pin.
2. Replace the proactive adapter and qualified dispatch path, then wire the function protocol, owned response batches, controller transitions, wait timing, shared events, and cancellation/folding boundaries. Remove jev integration paths and obsolete configuration handling in the same change.
3. Update README, behavior contract, config examples, and affected current instructions in English. Make source documentation describe the new function and the native-history limitation without teaching proactive use through startup metadata.
4. Reconcile the authoritative `docs/programming-thinking/official-pi-idle-inquiry.idea.lean` model with the restored guarded lifecycle and remove its jev/proactive-transition proofs. Update the takeover and cross-plugin models only where their modeled transitions change. Typecheck and run affected models and inspect their actual proof assumptions; do not treat the current shipped-behavior model as proof of the new process.
5. Verify payload boundaries and all three outcomes with focused tests; verify ordinary/provisional/non-main/stale/duplicate calls, mixed batches, correction exhaustion, publication rollback, final-budget waits, user takeover, cancellation, and terminal errors. Exercise packed Pi and cross-process tests, not only tool-definition fakes. Run `npm run check` and `npm run test:e2e`; document actual results.
6. Review source, specs, models, and tests together before syncing main specifications or distributing the source change. This change does not install or reload plugins or change pi-notify settings. The user separately authorized an unsigned commit and normal push after the revised plugin-only acceptance gates pass; main-spec synchronization/archive remains separate.

For rollback, return the distributed extension to the prior revision through the normal release mechanism rather than rewriting sessions. Existing event readers and unmodified shared credentials remain usable. Configuration incompatibilities must be explained: the prior version does not honor the restored decision keys and could reactivate its jev behavior from existing credentials. Never silently switch behavior by editing machine-local secrets or settings.
