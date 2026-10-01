## Context

See `proposal.md` for motivation and the delta specs for observable behavior. Today, manual unlock changes controller state and clears operational decision work, but it does not stop the active Pi run. Decision runs retain correlation through `activeDecision`/inquiry state, while an accepted continuation clears that state immediately after dispatch, so the runtime cannot later prove that the active run is watchdog-owned. Existing user-takeover logic already demonstrates public `ctx.abort()`, uninterruptible assistant neutralization, idempotent fold cleanup, and best-effort session-tree splicing.

Constraints:

- Commands execute immediately even while Pi is streaming.
- `ctx.abort()` is fire-and-forget from extension context and does not clear steering/follow-up queues.
- Abort settlement currently feeds the main abort-unlock observer unless a one-shot internal-abort suppression marker is consumed.
- Operational cleanup currently clears some state needed for post-abort residue cleanup, so cancellation identity must outlive ordinary unlock cleanup.
- Only exact watchdog ownership may authorize cancellation; busy/locked timing heuristics are insufficient.

## Goals / Non-Goals

**Goals:**

- Represent the current watchdog-owned run with enough identity to distinguish decision, continuation, and ordinary work.
- Let command and shortcut share one reasonless manual-unlock path that captures ownership before clearing operational state.
- Abort only an exact current watchdog-owned run, then neutralize and remove its assistant residue without another model request.
- Avoid private queue inspection or replay; queued-message behavior remains governed by Pi's public abort semantics.
- Keep cancellation state one-shot and claim-fenced so it cannot affect a later run or a demoted main attachment.

**Non-Goals:**

- A global stop command for ordinary user runs.
- Model-generated summaries or any post-cancellation model turn.
- Queue clearing, tool-side-effect rollback, or termination guarantees for detached/background execution.
- New configuration, dependencies, or private Pi APIs.

## Decisions

### 1. Track one exact watchdog-owned run instead of inferring ownership

Add a narrow runtime-owned identity with kind (`decision` or `continuation`), main claim, exchange id, cycle id, and lifecycle phase (`pending-start`, `running`, or `cancelling`). Decision ownership derives from the existing inquiry correlation. Continuation ownership is recorded before dispatch and confirmed only when the corresponding public inquiry-fold custom message starts the run with the same inquiry id/attempt, `watchdogOutcome: "continue"`, and continuation replacement. `pi-continue-watchdog:continuation` is the provider-context replacement produced by folding; it is not the public lifecycle message used for ownership.

This identity is cleared on authoritative settle, failed dispatch, ownership loss, shutdown, mismatch, or the start of genuine user/foreign custom work inside the same Pi agent lifecycle. An ordinary `agent_start` or nonmatching `message_start` must not be adopted as watchdog-owned, and later user steering must transfer ownership away from the watchdog before manual unlock can cancel anything.

**Alternative considered:** Abort whenever the watchdog is locked or a continue was recently accepted. Rejected because timing cannot distinguish queued user work, compaction/retry activity, or an unrelated run.

### 2. Separate operational cleanup from cancellation cleanup

Manual unlock captures an immutable cancellation target before controller unlock and normal operational cleanup. Normal cleanup continues to cancel timers, decision/finalization state, and pending publications, but it must not erase the captured cancellation target or its one-shot abort suppression until the owned run settles.

The cancellation target is claim-fenced and consumed exactly once. This avoids broad changes to the controller state model; ownership and residue cleanup remain runtime concerns.

**Alternative considered:** Keep all decision state alive until abort settles. Rejected because unlocked state must become authoritative immediately and stale decision finalization must be disabled before re-entrant effects.

### 3. Reuse inquiry cleanup for decisions; add correlated continuation cleanup

For a cancelled decision, reuse the existing inquiry cancel/remove-fold, uninterruptible assistant neutralization, and best-effort splice mechanisms, with a distinct manual-cancellation path that does not capture or reissue user input.

For a cancelled continuation, tag its aborted assistant with the accepted continue exchange/cycle identity, clear content and abort presentation in uninterruptible `message_end`, exclude that exact correlated residue from future model context, and best-effort splice its session entry after Pi is idle. Unrelated interleaved entries remain untouched.

**Alternative considered:** Rely only on context filtering and leave the empty aborted row in session history. Rejected because the requirement includes removal of visible settled residue, not only provider-context hygiene.

### 4. Abort after authoritative unlock and target capture

The shared manual-unlock flow will:

1. capture the exact current main claim and owned-run target;
2. assign controller unlocked;
3. clear ordinary operational work while preserving the target;
4. install one-shot abort suppression and residue-cleanup state when a target exists;
5. request `ctx.abort()` for that owned run;
6. apply normal unlock effects and command/shortcut output.

No target means no abort call. Claim loss at any fence stops ownership-dependent effects. The explicit human unlock remains the sole user-visible unlock output; aborted settlement must not emit another one.

**Alternative considered:** Abort before unlocking. Rejected because synchronous/re-entrant lifecycle work could observe the old lock and open or finalize more watchdog work.

### 5. Leave queue semantics to Pi

Cancellation uses only public `ctx.abort()` and does not inspect, copy, replay, or explicitly clear Pi's steering/follow-up queues. Packed stock-Pi verification showed that an abort may consume an already queued follow-up without starting another provider request. The extension therefore makes no queue-preservation or exactly-once delivery guarantee; if Pi later starts a genuine user message, existing auto-lock behavior treats it as ordinary user work and begins a fresh cycle.

**Alternatives considered:** Explicitly clear queues was rejected because it would deliberately discard user intent. Private queue access or replay was rejected because it is version-coupled, cannot prove exactly-once delivery, and is outside public extension APIs. A stronger atomic abort-and-resume guarantee belongs in Pi core as a separate upstream capability.

### 6. Keep controller and configuration unchanged

No controller field or config option is added. Controller owns lock/cycle decisions; runtime owns live Pi-run correlation and cancellation cleanup. Command runtime receives the smallest additional seam needed to request ownership-aware cancellation through the runtime.

This keeps the change localized and avoids speculative cancellation policy switches.

## Risks / Trade-offs

- **Run correlation can race with `agent_start`/`message_start` ordering** -> Record continuation as pending before dispatch, confirm only against the exact continuation message, and fail closed on mismatch.
- **Unlock cleanup can erase data required by `message_end`** -> Store cancellation target separately and clear it only after terminal cleanup.
- **Abort settlement can trigger duplicate unlock handling** -> Use an exact, one-shot suppression marker consumed by the abort-outcome observer.
- **A late lifecycle event could affect a newer run** -> Fence every target by claim plus exchange/cycle and clear on settle, ownership loss, or mismatch.
- **Session splicing may be unavailable or fail** -> Uninterruptible neutralization and context filtering remain authoritative; splicing is best-effort presentation cleanup.
- **Already completed or detached work may continue** -> Document bounded cancellation guarantees and avoid rollback claims.
- **Pi may consume queued follow-ups during abort without resuming them** -> Make no queue-delivery guarantee and avoid private queue replay; treat stronger semantics as an upstream Pi concern.

## Migration Plan

1. Add focused ownership/cancellation tests before changing runtime behavior.
2. Introduce owned-run correlation and cancellation target state behind the existing command/shortcut entrypoints.
3. Extend residue neutralization/context folding and abort-outcome suppression.
4. Update behavior/architecture docs and the Lean process model, then run Lean validation.
5. Run unit checks and packed stock-Pi E2E scenarios covering decision and continuation cancellation.

Rollback is a normal source revert: no persisted configuration or data migration is introduced. Existing session entries remain readable; new cleanup metadata is optional runtime correlation data.
