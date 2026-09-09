## Context

See `proposal.md` for motivation and `specs/watchdog-waiting-hook/spec.md` for required behavior.

The watchdog already publishes `watchdog-continued` after durable continue evidence through its local plain-data semantic-hook helper. The accepted-wait path validates controller state, appends a `WaitEntry`, folds the hidden inquiry, and schedules terminal exhaustion when appropriate. The new signal must reuse that established finalization boundary without changing the independent `wait_watchdog` XML contract.

## Goals / Non-Goals

**Goals:**
- Publish one final waiting signal only for a durably accepted current wait.
- Preserve deadline, retry, rollback, folding, ownership, and exhaustion behavior.
- Keep consumer failure irrelevant to producer control flow.

**Non-Goals:**
- Adding a wait reason type, absolute deadline, acknowledgement, replay, or notification-specific dependency.
- Migrating the existing semantic-hook helper to another implementation.
- Publishing timer ticks, wait expiry, manual unlock, or invalid decision events.

## Decisions

### 1. Add a dedicated `watchdog-waiting` envelope builder

Extend the existing semantic-hook module with a name constant, a value type containing `REASON` and `WAIT_SECONDS`, and a builder that returns a fresh frozen version-1 envelope. Convert the already validated integer duration with normal decimal string conversion.

Alternative considered: reuse `watchdog-continued` with a new reason type. Rejected because `wait_watchdog` is intentionally untyped and starts no continuation turn.

### 2. Emit only after the wait audit append and post-append ownership fence succeed

Use the same guarded order as the accepted-continue path:

1. append `WAIT_ENTRY_TYPE`;
2. run the existing `stopIfStale(claim)` fence;
3. emit `watchdog-waiting` inside a listener-failure boundary;
4. run `stopIfStale(claim)` again;
5. continue with fold cleanup, aggregate observation, and any final-wait scheduling.

This makes parser success alone insufficient, keeps a re-entrant ownership change during persistence silent, and ensures later fold cleanup failure does not invalidate the accepted and recorded wait. No emit is added to parser, controller, timer, rollback, or terminal-exhaustion code.

Alternative considered: emit from the timer scheduler. Rejected because scheduling can be repeated and only final-attempt waits schedule terminal exhaustion.

### 3. Isolate synchronous listener failures

Wrap emission in the same local failure boundary as `watchdog-continued`. A listener exception is ignored by producer control flow; the wait remains durable and active.

### 4. Verify behavior at builder, runtime, and packed public seams

Focused tests cover exact envelope values, immutability, ordinary wait, final-attempt ordering, invalid decisions, re-entrant ownership demotion during `appendEntry`, preemption before persistence, append failure rollback, exactly-once emission, no listener, and throwing listener. Packed stock-Pi acceptance extends the existing `NEUTRAL_SEMANTIC_PROBE_SOURCE`: the consumer hardcodes only `pi:semantic-hook:v1` and the plain version/name/values shape and imports neither producer source nor package internals.

## Risks / Trade-offs

- [Publishing too early creates false reminders] -> Emit only after the synchronous audit append returns successfully.
- [Final wait could look exhausted immediately] -> Keep waiting and existing deadline-gated `user-ready` as separate events and assert ordering.
- [Repeated scheduling could duplicate notifications] -> Emit from one accepted-decision finalization, never from timer callbacks.
- [Consumer errors could stop cleanup] -> Catch publication failures locally and test a throwing listener.

## Migration Plan

1. Add RED acceptance coverage for the missing waiting hook.
2. Add the minimal envelope contract and accepted-wait emission.
3. Run focused and full checks plus packed stock-Pi acceptance.
4. Update user/behavior documentation separately.
5. Obtain provisional independent review of the uncommitted candidate and resolve findings.
6. After explicit local-commit authorization, create separate signed functional and documentation commits.
7. Review the exact commit SHAs or prove tree equivalence to the provisionally reviewed candidate.
8. Integrate and publish only after separate explicit push/integration authorization.

Rollback removes the builder and one emit call; existing wait records and older consumers require no data migration.
