## Context

Settlement flows through the `agent_settled` handler (src/runtime.ts:2727) into the eligibility/fence/decision path (handleSettled, src/runtime.ts:2414; eligibility 1298-1319; fence 2727-2764). `AgentSettledEvent` carries no payload, so terminal outcome must come from the plugin-tracked final assistant message; `hasAssistantStopReason` (src/runtime.ts:298) already provides exact `stopReason` matching. Abort already unlocks immediately via src/abort-outcome.ts. Contract rule 8 mandates stop-reason-independent recovery and even claims aborts reach the same settled decision path — already untrue today.

## Goals / Non-Goals

**Goals:**

- Classify terminal outcome at the settled decision point; terminal error → auto unlock through the controller unlock flow.
- Contract-first: rule 8 + acceptance criteria amended before runtime code.

**Non-Goals:**

- No error classification beyond terminal `stopReason` (no message-text or error-type heuristics).
- No behavior change for success settlements, aborts, waits, or the decision protocol.
- No new config (the gate is unconditional product behavior, like the abort unlock).

## Decisions

- **Outcome source: tracked final assistant message `stopReason`, not the settled event.** The event is payload-free; the plugin already tracks assistant messages for redaction identity. The gate reads the same tracked final message the settled decision already correlates with, so no new event subscription or host dependency. Alternative (parse `agent_end.messages`) rejected: adds a second source of truth for the same run.
- **Gate placement: inside the settled decision path, before the fence is scheduled.** If terminal error → auto unlock immediately (no 10s wait); else → existing fence/decision. Placing it before the fence avoids a pointless delay and keeps the decision stage unreachable for errored runs, satisfying "no inquiry fence" structurally rather than by a later cancel.
- **Auto-unlock reuses the controller unlock flow** (same sequencing as abort unlock / command unlock: authoritative unlock → cleanup → effects → notify), with a derived auto reason recorded distinctly from manual unlock so the timeline shows *why* it unlocked. No `reasonType` guessing — the record states it was automatic on terminal error.
- **Contract amendment shape:** rewrite rule 8 as the three-outcome matrix and fix its abort claim; update the matching acceptance criteria in the same commit series, before runtime edits. Tests for the new matrix land with (before) the runtime change per the repo's contract-first ATDD practice.
- **Staleness:** the gate evaluates only the settlement observation that passes the plugin's existing stale/settlement guards; no new guard logic.

## Risks / Trade-offs

- Plugin sees a provider error surface differently across hosts (e.g. error delivered without a final assistant message carrying `stopReason: "error"`) → gate falls through to the normal decision (safe default: no auto-unlock); a test documents the fallback.
- Contract/rule-8 edits touch text asserted by tests → grep for hardcoded rule-8/error-string assertions before editing (known repo hazard), update assertions in the same change.
- Auto-unlock removes the lock the user set → accepted: the user explicitly chose this behavior; the notification + timeline record make it visible and auditable.
