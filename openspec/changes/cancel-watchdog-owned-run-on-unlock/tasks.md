## 1. Acceptance Coverage

- [x] 1.1 Add failing runtime tests for command-triggered cancellation of an active decision and automated continuation, verifying exact ownership, unlocked terminal state, one unlock output, no replacement model turn, and no abort residue
- [x] 1.2 Add failing command/shortcut tests proving both entrypoints share cancellation behavior while an ordinary user-started run is not aborted
- [x] 1.3 Add failing lifecycle tests for host-owned queued-message behavior, repeated unlock isolation, ownership loss, and one-shot suppression of abort-driven duplicate unlock

## 2. Owned-Run Correlation

- [x] 2.1 Add minimal runtime state for exact watchdog-owned decision/continuation identity and verify pending, running, mismatch, settle, demotion, and shutdown transitions with focused unit tests
- [x] 2.2 Record continuation ownership before dispatch and confirm it from the exact continuation message start, verifying unrelated `agent_start` and `message_start` events fail closed
- [x] 2.3 Expose the smallest ownership-aware manual-cancellation seam through the command runtime and verify command and shortcut invoke the same path

## 3. Cancellation and Residue Cleanup

- [x] 3.1 Update manual unlock ordering to capture the target, unlock authoritatively, preserve cancellation cleanup across operational clearing, and call public `ctx.abort()` only for an exact current watchdog-owned run; verify ordinary runs never receive abort
- [x] 3.2 Reuse decision inquiry cancellation without takeover-message reissue and verify the exact decision assistant is neutralized, folded, and best-effort spliced
- [x] 3.3 Add correlated continuation assistant neutralization, future-context filtering, and best-effort splicing; verify partial content and `Operation aborted` disappear while unrelated entries remain
- [x] 3.4 Integrate exact one-shot abort suppression with main abort-outcome handling and verify cancelled internal runs produce no second unlock notification or user-ready signal
- [x] 3.5 Verify manual cancellation does not inspect, replay, or explicitly clear Pi queues and document that queued-message delivery follows host abort semantics

## 4. Documentation and Process Model

- [x] 4.1 Update `docs/behavior-contract.md`, `docs/architecture.md`, and `README.md` with ownership-aware unlock cancellation and bounded side-effect guarantees, verifying documented scenarios match the delta specs
- [x] 4.2 Update the affected `docs/programming-thinking/*.idea.lean` process model for decision and continuation cancellation, then verify the authoritative files typecheck, run, contain no placeholders, and report only accepted axioms

## 5. Integrated Verification

- [x] 5.1 Run `npm run check` and verify lint, typecheck, unit tests, and build pass
- [x] 5.2 Run packed stock-Pi E2E coverage for active decision cancellation, active continuation cancellation, ordinary-run preservation, host-owned queued-message behavior, and clean settled transcript/context
- [x] 5.3 Run `openspec validate cancel-watchdog-owned-run-on-unlock --strict` and verify every proposal capability has a valid delta and all planning artifacts remain coherent
