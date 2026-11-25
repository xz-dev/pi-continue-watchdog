## Context

The `cooker` session on 2026-11-25 recorded, in order (UTC+08:00): an accepted private `continue` at 18:59:52.793, main run start at .918, a host `system` entry at .979, and the matching continuation fold on the branch at .980. The main session produced a tool result at 19:01:25.468. A later read-only Herdr observation still showed `publishing · 1016s` alongside `running`. That elapsed counter starts at private-operation admission; it is not a measurement of send latency. No JEV decision is required for this outcome.

The event log establishes the handoff, not the execution order of extension callbacks. In `src/runtime.ts`, the send path probes a branch receipt immediately after `sendMessage`; that probe can precede persistence. `handleMessageStart` currently discards `pending-start` ownership on a nonmatching, non-presentation message. `confirmContinuationPublication` can later discard the pending record on an ownership mismatch without retiring its visible progress. An exact matching message can also mark the run `running` without clearing the row. These are concrete paths to test, not a claim that the live session executed a particular branch.

## Goals / Non-Goals

**Goals:** Distinguish the end of private progress, recognition of an owned main run, and durable publication. Use observations already supplied by Pi; make the fix observable while the main run is still busy.

**Non-Goals:** No global busy-state reset, new timer, inspection of another plugin's private queues, change to continuation contents, or migration of session history. Do not stop the resumed run, unlock the cycle, or change JEV selection or timing.

## Decisions

1. **Retire display by exact operation, not by global activity.** On either a matching continuation start or an existing positive branch receipt, use the current operation's progress finisher to detach its stage and repaint the ordinary row. Retire obsolete display on discard/ownership loss as well, without reporting success. Keep cleanup identity-guarded and idempotent. Clearing on any `agent_start` would confuse unrelated work with delivery; waiting for `agent_settled` leaves a stale timer for the whole main run.
2. **Treat host system bookkeeping as neutral while awaiting correlation.** It neither proves nor disproves that the expected continuation will start. Preserve the candidate across that event, but only the existing exact fold identity (exchange, cycle, continuation outcome/type and current claim) may establish ownership. Preserve the existing fail-closed treatment of foreign work; do not skip arbitrary custom or user messages. A pending identity alone must not acquire new cancellation authority.
3. **Keep business confirmation separate.** Reuse the current branch receipt, accounting and semantic-hook guards. A matching start is enough to end the UI wait, not to declare durable publication. A temporarily unreadable receipt is not evidence of absence. Neither UI retirement nor a late duplicate callback should send, refund, charge, or emit a hook. Retain existing behavior for a proven send failure and for a cancelled private child that is actually draining.

## Risks / Trade-offs

- **The runtime may observe persistence and message callbacks in a different order than the JSONL entries.** Exercise both receipt-before-start and start-before-receipt, and hold the main run open when asserting the widget. Replay the ordered event shapes, not the live transcript.
- **A UI fix could accidentally change manual unlock or suppress a legitimate hook.** Assert ownership and once-only business effects separately from rendering, including a foreign takeover and a late receipt after a successor becomes visible.

## Migration Plan

No data or configuration migration. Ship as a runtime bug fix; an extension reload or new session can pick it up. Rollback requires only the previous extension version. Do not reload or send input to the live `cooker` session as part of verification.
