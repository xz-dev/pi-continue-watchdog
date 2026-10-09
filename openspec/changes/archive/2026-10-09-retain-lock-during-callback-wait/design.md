## Context

See `proposal.md` for motivation and the seven delta specs for the behavior contract. This design is necessary because the change crosses protocol compatibility, controller state, native input provenance, publication, optional review, and configuration migration.

Current source has two effects: `commitResponse` sends every validated `unlock` to `recordValidUnlock`, which clears the lock. `aggregateInput` and `isDecisionEligible` treat a locked, non-exhausted cycle without an open decision as eligible after the fixed idle fence. Merely removing the unlock assignment would therefore permit repeated inquiries. An unlocked `agent_start` silently establishes a fresh cycle, while `registerMainUserAutoLock` currently resets on every native user-role `message_start`. The budget is named `maxRetries` in the plugin and already defaults to ten; this proposal changes its meaning/name, not a provider retry setting.

There is concurrent authorized implementation of `add-optional-unlock-review` in the same checkout. That work owns its runtime changes. This proposal writes only its own change directory; its planned integration preserves the optional review's candidate scope and bounded reconsideration. Re-read that change and coordinate a single implementation writer before any future apply.

## Goals / Non-Goals

**Goals:**

- Keep wire compatibility while making the effective outcome explicit inside the watchdog.
- Represent callback suspension as a small state in the existing cycle, not an open inquiry, decision failure, or exhaustion workaround.
- Make one shared budget impossible to replenish through extension-origin callback wakes.
- Reuse native records, exact-attempt currentness, quiet presentation, projection, and existing publication failure behavior.

**Non-Goals:**

- A new action, result field, callback ID registry, producer-specific task API, timer, polling loop, or wait-duration configuration.
- Restoring live suspension/accounting after restart, changing other unlock reasons, blocking externally started callback work, or widening user permission.
- Changing optional-review eligibility, backend selection, timeout policy, correction bounds, or native provider retries.
- Editing Pi, subagent producers, or consumer settings.

## Decisions

### D1. Two wire actions, three final effects

Keep the public `cw` schema and phase guard unchanged. After ordinary action/type validation, derive a callback-suspension effect only from the `unlock` action and the actual matched configured built-in `WAIT_CALLBACK` identity. Use the same case-insensitive matching semantics as existing validation; do not classify from reason text or a custom label's uppercase display value. Keep the accepted raw action/type association available to review/history, and distinguish its applied effect in new outcome records.

Optional review must still see this as an eligible initial `unlock`-action candidate. Do not filter it out by the derived effect. Supported/incomplete dispositions release the same candidate; a definite challenge can still open one reconsideration. Only the final accepted result reaches the effect transition. A final callback pair suspends; a final `continue` continues; a final `JOB_DONE` actually unlocks. Review and reconsideration themselves never charge `maxContinue`.

The prompt must honestly describe the one compatibility exception. No public explanatory schema text, proactive ordinary-call guidance, new action, or restoration of `wait`/`wait_seconds` is required.

**Alternative rejected:** a new callback action has cleaner spelling but the user chose compatible calls. Treating every `unlock` as actual unlock after review would erase the new behavior; skipping review by derived effect would contradict the separate confirmed choice.

### D2. Explicit suspension in the existing lock cycle

Add one callback-suspended phase/flag to the current in-memory controller snapshot. Retain existing `locked`, used-count, exhaustion, decision IDs, and ownership fencing. The callback transition atomically closes the current decision, retains `locked = true`, sets suspension, and spends one unit. It must reject stale/repeated decision identities. Do not leave the decision window open as the suspension marker.

Both controller eligibility and runtime aggregate/status eligibility must recognize suspension. Cancel the inquiry fence when suspension commits; subsequent idle reconciliation must not rearm it. The callback decision's own settlement is not a resume. UI/status should identify waiting for callback with the lock retained rather than display an active countdown or an unlock.

```text
                         final callback result, +1
  [LOCKED / ACTIVE] --------------------------------> [LOCKED / SUSPENDED]
       |                                                     |
       | continue, +1                                        | ordinary work starts
       v                                                     | same cycle, +0
  [ORDINARY WORK] <-------------------------------------------+
       |
       | successful settle
       +--> remaining allowance --> existing idle fence --> inquiry
       |
       +--> no allowance --------> guarded EXHAUSTED

  actual unlock / manual unlock / abort / terminal error
       --> existing unlock path; clear suspension
```

Numeric exhaustion and suspension can coexist after the final waiting unit. While suspended, waiting takes presentation/notification precedence over numeric exhaustion. Do not pretend there is remaining allowance: suppress new inquiries through both the numeric bound and suspension. Once real ordinary work resumes, suspension clears but usage/exhaustion do not. Its successful settlement then allows the existing exhausted outcome. Error/abort paths retain priority over successful-work exhaustion.

**Alternative rejected:** keeping only `locked = true` causes a repeated idle inquiry. Using `decisionFailed` as a quiet mode mislabels success and changes recovery. A fresh lock on callback would replenish the very budget intended to bound repeated waiting.

### D3. Resume from native activity, preserve input origin

Resume on real new ordinary work in the owning main session, not wall-clock time, a child becoming idle, a notice append, status redraw, or review/publication traffic. Do not require a callback producer-specific identifier: the watchdog stops suppressing its checks when legitimate non-internal main work actually starts, then checks the resulting work through the existing settlement fences. Human work remains a fresh-cycle boundary; ordinary automation remains in the current cycle.

Source inspection exposed a concrete trap:

- Installed `pi-subagents/src/shared/parent-wake.ts` appends an idle-parent notification with `triggerTurn: false`, then starts work through `sendUserMessage`.
- The project-installed Pi `AgentSession.sendUserMessage` passes `source: "extension"` into prompt admission.
- Public `InputEvent.source` distinguishes `interactive`, `rpc`, and `extension`, but `MessageStartEvent` contains only the message. The source is not automatically carried as a message-start field.
- This repo's `src/auto-lock.ts` currently restarts every main user-role message. Leaving that rule unchanged would reset `maxContinue` on an actual subagent callback.

Implementation gate result: a real-host counterexample (paired handled/transform runs with identical observer histories but opposite true origins) shows the public host API in 0.85.1, official 1.1.0, and fork `1.1.0-xz.272.1.g7be4ece7` cannot associate admission source with the started message. Evidence is kept under `/var/tmp/pi-continue-watchdog-callback-gate/`. The user rejected a Pi change for this and chose a plugin-only rule:

- `src/auto-lock.ts` owns a fixed built-in list of exact callback wake texts. It is not configurable and cannot be disabled.
- A main user-role `message_start` whose whole text exactly equals a list entry is automation: it does not lock a fresh cycle or count as user takeover, but it is ordinary work that ends callback suspension in the same cycle.
- Every other user-role start keeps the existing fresh-cycle behavior.
- Initial entries are copied verbatim from installed producer source: pi-subagents `PARENT_WAKE_TEXT` and pi-intercom `"New intercom message above."`.
- The plugin's own takeover reissue forwards the human's original text, so it does not match and remains a fresh human cycle.

Known limits, accepted by the user: exact text can be spoofed by a human typing it; the rule is coupled to producer wording and needs a plugin update if that wording changes; dynamically composed producer prompts (for example the npm pi-subagents watchdog auto-follow) are not covered and still reset the cycle. No prefix, substring, or fuzzy matching is used, to avoid misclassifying human messages.

Callbacks racing pending review or an uncommitted waiting result invalidate the old decision through currentness guards. Callbacks arriving after accepted suspension clear its live phase and retire its pending waiting signal. Neither path may allow an old asynchronous result to re-pause new work.

**Alternative rejected:** `agent_start` alone loses human-versus-automation semantics; `role=user` alone is demonstrably wrong. A Pi-side `InputOrigin` propagation was designed but not chosen. A broad new task subscription system is unnecessary.

### D4. Plugin allowance is maxContinue, default ten

Rename the plugin setting and its live configuration/controller/status plumbing to `maxContinue`, with default `10` and the existing validation interval `[1, 10]`. Follow existing built-in/global/trusted-project per-field fallback; do not clamp invalid values. Remove `maxRetries` from accepted plugin keys and add it to the existing error-level removed-key path with a concise replacement hint. Never echo its value or edit the user's file. A layer containing both keys uses valid `maxContinue` and still diagnoses `maxRetries`. An old key cannot override a valid lower-precedence new key. With only an old key, the effective new budget is ten.

Keep one used counter; do not add a callback-specific quota. Its unit is an accepted control effect that retains automatic-work responsibility:

| Outcome | Usage change | Dispatch |
| --- | --- | --- |
| Accepted, durably published continue | +1 | One ordinary work turn |
| Accepted callback suspension | +1 | None; wait for native work |
| Actual unlock | 0 | None |
| Inquiry/correction/review/reconsideration | 0 | Internal decision activity only |
| Repeated/stale/uncommitted result | 0 | None |
| Callback work starts | 0 | Started by its external source |

For continue, preserve current publication rollback. Callback suspension has no ordinary-work dispatch to roll back: the guarded lock-retaining transition consumes its unit once, and later optional/status publication failure cannot refund that accepted transition, rearm inquiries, or consume it again. This deliberately differs from an unstarted continuation send while preserving the shared upper bound. Persist/history what can be confirmed, without claiming absent receipts are durable.

Illustrative acceptance trace, confirmed by the user:

```text
maxContinue = 2
continue          -> used 1/2, ordinary work
WAIT_CALLBACK     -> used 2/2, locked and suspended, WAIT_CALLBACK signal eligible
actual callback   -> used 2/2, ordinary work still allowed
successful settle -> EXHAUSTED eligible; no further automatic inquiry
```

Only genuine new user work or the existing explicit fresh-lock path starts a new allowance. Callback activity, compaction, review, and control/status observations do not. Preserve stored legacy history and unrelated provider retry names rather than blindly replacing every occurrence of `Retries` in the repository.

**Alternative rejected:** the user rejected the old key as a compatibility alias. Separate budgets permit more repeated controls than the requested shared maximum. Immediate exhaustion on the final wait would replace the waiting outcome before the awaited work could run.

### D5. Same hook, new stop kind, truthful history

Extend `UserReadyStopKind` with `WAIT_CALLBACK`; allow both reason fields for this value as for `AI_UNLOCK`. Do not add a hook name or `WAIT_SECONDS`. `user-ready` already means that the watchdog will not auto-wake; it need not mean human input is required. Retain best-effort, consumer-independent emission.

Use the existing quiet-status mechanism with an explicit recorded callback-suspension kind/version, not an `ai-unlock` record that happens to contain the callback reason. New records must not render `unlocked`; old `ai-unlock` records with that reason must continue to render their actual historical effect. Reuse native session association and remove-only owned inquiry cleanup. Include the new record in exact-ownership context/summary projection and review-context exclusion without hiding ordinary callback evidence or user quotations.

The suspension unit is consumed at its accepted transition. Its signal waits for confirmed quiet status and control cleanup plus the existing current-claim, local/child/domain idle fences. If persistence is absent or uncertain, retain the current quiet operational state, retry only existing still-current publication work, and emit no premature hook or model-bound fallback. A resumed ordinary run retires any old pending wait signal. Do not replay it after the callback's result.

At the final waiting unit, choose the waiting outcome while suspension is current; do not let the generic exhausted branch also emit. After actual resumed work settles successfully, the exhaustion signal uses its own current terminal observation. Repeated observations must not repeat either outcome. A very fast callback can correctly preempt the waiting notification before it was ever eligible.

**Alternative rejected:** suppressing the waiting notification was explicitly corrected by the user. Keeping `AI_UNLOCK` would lie about state. Reusing old duration-wait records would revive a retired contract and confuse recovery.

### D6. Compose with optional review rather than overwrite it

Keep the other change independent and finish/coordinate its implementation before touching shared runtime/config files. Before applying or synchronizing this change, re-read the then-current main specs and its latest deltas. This proposal's `Watchdog owns decision entry` and assessment-first blocks include the known review/reconsideration additions. Leave the other change's `Decision responses cannot perform ordinary work` additions intact, especially the per-inquiry three-response bound and one-reconsideration ceiling. Our callback accounting must not recreate a fresh format allowance on ordinary busy defer or release a superseded result.

The current main `ai-unlock-tool` and configuration text still contain blanket no-review wording, whereas the other change introduces an explicit opt-in. The deltas here narrow those blanket statements to preserve the already approved integration, not to create another reviewer or expand eligibility. Interpret the companion review spec's candidate `unlock` as the wire decision: releasing the callback candidate now commits suspension, while releasing other valid unlock candidates still unlocks. Its limits and privacy/service contract remain unchanged.

Archive/sync ordering is an explicit coordination gate: land/reconcile the optional-review specifications first, then rebase these full `MODIFIED` blocks against that exact baseline before archive. Do not automatically archive either change during implementation, silently remove scenarios to make validation pass, or copy an older whole requirement over newer ones. Some original scenario titles are retained even where their body now describes changed behavior, because the CLI protects whole-block scenario preservation.

**Alternative rejected:** silently editing the other active change violates ownership and makes two independent writers compete. Ignoring full-block replacement semantics can erase a correctly implemented review contract at archive time.

## Risks / Trade-offs

- **Compatible call spelling says unlock while the effect retains the lock** -> keep the one explicit built-in exception in authorized guidance, outcome history, tests, and documentation; no heuristic aliases.
- **A removed low maxRetries value falls back to ten** -> error-level diagnostic naming `maxContinue`, prominent migration note, no silent alias or config rewrite. Users must migrate before expecting their old bound.
- **Native extension wake uses a user-role message** -> built-in exact wake-text list; unknown or dynamic wake texts still reset the cycle, and a human typing an exact wake text is treated as automation.
- **Final wait reaches the numeric limit before callback work** -> suspended-state precedence for signal/eligibility, then successful-work exhaustion; external work is never blocked by plugin allowance.
- **Callback or takeover races a verdict/publication** -> retain exact ownership/run/generation fences before and after awaited work; discard late effects/signals without charging replacement work.
- **No callback ever arrives** -> no silent timeout or polling fallback; remain visibly suspended, with manual unlock and genuine new user work as explicit exits. No liveness claim without an external wake.
- **Quiet status persistence fails after accepted suspension** -> keep its consumed unit and live phase, report missing persistence honestly, and do not emit an unconfirmed hook or add a storage fallback.
- **Consumers use exhaustive stop-kind lists** -> document the added value; do not modify external consumer configuration. Generic `user-ready` consumers can still notify during callback waits.
- **Concurrent review work changes shared seams** -> one writer at implementation time and repeat combined requirement/scenario validation before integration and archive.

## Migration Plan

1. Deliver only this proposal, delta specs, design, and tasks. Product acceptance of implementation requires a later explicit apply request; no runtime behavior has changed here.
2. Under that authorization, coordinate the current optional-review writer and baseline. The native-origin gate found no public association; use the user-selected built-in wake-text list instead.
3. Migrate plugin configuration and all consumers to `maxContinue: 10` by default. Keep removed-key diagnostics safe and per-layer. Document manual user-config migration without performing it.
4. Implement one accepted behavior slice at a time using existing tests: shared accounting/suspension, ordinary wake and final-budget behavior, then publication/projection and review integration. Keep mandatory validation and cancellation boundaries throughout.
5. Update README and affected Lean process models only in that separately authorized implementation. Validate the exact models and applicable package/integration checks; distinguish model proof assumptions from real-host evidence.
6. Before release or archive, rebase overlapping full-block deltas and verify consumer/config migration notes. Installation, activation, release, archive, commits and pushes require their own authorization.

Rollback, if separately requested, restores the previous implementation and requires users to restore the old configuration key manually; do not promise that an older version understands `maxContinue` or new suspension records. Preserve native history without replaying it. A disable/rollback must not silently start pending work or recover live suspended state from history.
