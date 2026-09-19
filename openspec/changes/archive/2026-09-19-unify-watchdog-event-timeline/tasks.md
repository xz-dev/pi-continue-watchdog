## 1. Confirm the acceptance slice and prove the shared carrier

- [x] 1.1 At the start of a separately requested apply phase, confirm the proposed examples and scope with the user: shared complete body, fixed-offset event text, requested versus observed wait duration, and no forced polling; verify the agreement is recorded before changing behavior.
- [x] 1.2 Extend the existing renderer/context-fold and packed-Pi harness with one shared-continue example; observe the current mismatch (TUI-only result versus attributed provider message) failing for the expected reason, and record the focused test command/output.
- [x] 1.3 Implement the smallest visible, versioned terminal-fold path for continue in `src/context-fold.ts`, `src/runtime.ts`, and `src/commands.ts`; verify the example turns green, the displayed body equals provider text, one continuation starts, and the current inquiry id/attempt remains its lifecycle identity. Stop for review if the public host cannot provide the required persistence/dispatch seam.
- [x] 1.4 Add runtime-authored local-offset RFC 3339 timestamps and immutable canonical formatting using existing clock/standard-library facilities; verify clock-injected timestamps, offset changes on later rendering, custom guidance, escaped multiline reasons, and accepted 501-to-1000-code-point reasons without introducing a second formatter or a new dependency.

## 2. Deliver accepted wait and remaining automatic results

- [x] 2.1 Drive one accepted-wait example red then green through the shared carrier; verify both readers receive the same reason, acceptance time, requested duration, and deadline, no ordinary work turn starts, and the separate new WaitEntry append is gone.
- [x] 2.2 Preserve the acceptance/publication ordering and rollback fences; verify publication failure, re-entrant demotion, optional audit failure, absent/throwing hook listeners, unchanged `watchdog-waiting` values, and no hook or timer for a non-durable wait using existing runtime/semantic-hook tests.
- [x] 2.3 Publish AI-unlock and decision-failure bodies through the same result path; verify both readers see the same timestamped body, raw invalid response text remains excluded, no work turn starts, and failed publication never relocks an already unlocked controller.
- [x] 2.4 Publish retry exhaustion once at the existing terminal-idle boundary without resetting accounting; verify ordinary exhaustion and final-wait-delayed exhaustion retain their current `user-ready` behavior and start no additional inquiry.

## 3. Deliver accurate wait-completion facts

- [x] 3.1 Capture only the current accepted wait's identity, start, requested duration, and deadline; verify renewed activity preserves that start while unlock, fresh lock, session replacement, demotion, and shutdown invalidate pending timing through injected-clock lifecycle tests.
- [x] 3.2 Drive the 1500-second requested / 1531-second observed wake example red then green; publish one shared completed-wait body and prepend the identical body to the next eligible inquiry, verifying that normal idle checks have no synthetic wait preamble and model response time does not change the captured wake time.
- [x] 3.3 Keep one wake snapshot through validation re-asks and interrupted dispatch; verify busy/stale callbacks cannot publish early or twice, two separate waits use separate starts, publication failure does not dispatch an unmatched timing-aware inquiry, and internal event messages consume no attempts or user auto-lock cycle.
- [x] 3.4 Apply the same completed-wait reporting before terminal exhaustion when the final wait expires; verify its ordering before the exhaustion event, absence of a new inquiry, and no duplicate waiting-acceptance hook.

## 4. Remove special history reconstruction and preserve existing safety

- [x] 4.1 Remove `src/decision-history.ts`, its dedicated tests, history-prefix callers, and solely history-related `watchdogResult` production/validation plumbing; verify consecutive waits and retry-recovered continuations keep their shared events once in normal context without a `Previous watchdog results` block.
- [x] 4.2 Preserve exact inquiry correlation, continue replacement identity, raw-exchange folding, and cancellation cleanup while simplifying metadata; verify existing decision/continuation manual-unlock, real-user/foreign-message takeover, unrelated interleaving, terminal-error, abort, and cross-process ownership regressions remain green.
- [x] 4.3 Adapt the human timeline command and renderers to new shared messages while retaining legacy entry readers; verify one event per result, identical body text after presentation normalization, and no extra new TUI-only continue/wait/AI-unlock result record.

## 5. Verify session boundaries and synchronize contracts

- [x] 5.1 Add or adapt packed persistent-session examples for mixed pre-upgrade and new records; verify old records remain readable, new uncompacted bodies survive resume unchanged, old timers are not rearmed, no legacy history is backfilled, and later ordinary provider requests contain no raw completed XML exchange.
- [x] 5.2 Verify active-branch and compaction scenarios through existing Pi session fixtures; confirm sibling/pre-compaction events are not restored by a plugin history scan and retained event bodies are not rewritten during context processing.
- [x] 5.3 Update `README.md`, `docs/architecture.md`, and `docs/behavior-contract.md` to match the shared timeline and timing limits; verify obsolete zero-loop/TUI-only guarantees are removed for new scoped events while legacy, authorization, cancellation, and non-restored-wait limits remain explicit.
- [x] 5.4 Update affected existing `docs/programming-thinking/*.idea.lean` alongside the behavior documentation; inspect their complete source, typecheck and run the exact affected files with the repository/active Lean toolchain, inspect proof assumptions, and obtain an independent semantic reading. Record any unavailable toolchain/reviewer gate instead of claiming proof of model judgment.

## 6. Integrate and present acceptance evidence

- [x] 6.1 Demonstrate that the critical body-equality and elapsed-time checks detect a deliberately broken path, then restore it and rerun; verify failures concern missing shared text or incorrect time facts rather than only renamed internals.
- [x] 6.2 Run `npm run check` and `npm run test:e2e`; verify all required suites pass and record the commands, results, and any CI gate that cannot be observed without separate publishing authorization.
- [x] 6.3 Obtain independent correctness/simplification review of the completed behavior, especially persistence assumptions, cancellation identity, and legacy parsing; verify material findings are resolved and reviewed again when necessary.
- [x] 6.4 Present requirement-to-scenario-to-test evidence and remaining limitations to the user for product acceptance; verify the report distinguishes implemented information delivery from model judgment and does not claim installation, deployment, commit, or push that was not separately authorized.
