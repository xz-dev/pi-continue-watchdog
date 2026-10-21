## Context

See `proposal.md` for motivation. Live commit `72e9d10` established private decisions; documentation archive `42387d7` did not alter implementation. Final local evidence was 569 check tests and 62 E2E cases, with both commits' CI successful. These are baseline observations, not evidence for this future refactor.

The shared Interface is owned by `pi-extension-utils/openspec/changes/share-private-inquiry-runtime/specs/private-inquiry-runtime/spec.md`. Continue's existing main specifications remain authoritative; this pure refactor deliberately skips delta specs.

## Goals / Non-Goals

**Goals:**
- Delete duplicated runtime/transport ownership while preserving every current user-visible decision and cancellation behavior.
- Exercise shared execution through the installed consumer, not just a linked checkout.

**Non-Goals:**
- Change payload normalization, prompts, reason types, review eligibility, callback meaning, budgets, receipt guards or history recovery.
- Add public tools, a user runtime switch, another scheduler or a new fallback implementation.
- Reopen the archived historical red chronology exception or modify unrelated `PLAN/` material.

## Decisions

### Keep a thin policy adapter around the shared owned session

Move only generic full-fork, file, attempt and cleanup machinery. The Continue adapter supplies its existing `validateDecisionArguments`, prompt/correction builders, source/currentness checks and safe audit observations. It creates one shared session, runs the initial inquiry, invokes existing unlock review for a qualifying candidate, and permits at most one reconsideration inquiry in that same child. A final value then enters the unchanged controller/publication path.

Retain configured reason identity through normalization, including the non-ASCII alias guard and validated built-in WAIT_CALLBACK semantics. No shared code may decide that an uppercase display string has callback authority. Keep the existing three-attempt allowance separately for each inquiry and no main-model confirmation/rewrite.

Alternative: retain the complete local adapter as a second runtime or wrap the old implementation beneath a new import. Rejected: duplication remains and fixes can diverge. Keeping consumer policy is not permission to keep another file executor or pi-subagents patch.

### Keep cancellation and final-effect ownership in the consumer

Continue retains the operation's AbortController, source/generation/owner checks, public terminal-input subscription and cause-specific controller transitions. Feed exact cancellation/currentness into the shared session and keep callbacks inert once stale. Shared cleanup drains its own child; it never aborts an unrelated main run.

Preserve native ordinary/continuation Escape handling, private idle Escape routing, one reasonless manual unlock and listener teardown. Do not turn child activity into external invalidation or treat another watchdog's child as this operation. Review callbacks and pending publication still require the original operation identity.

### Transfer package ownership only after installed conformance

Pin a verified immutable utils revision that contains the new subpath. Remove Continue's direct `watchdog-subagents-runtime` dependency/bundling, patch assets and preparation hooks only when utils alone owns and delivers those mechanisms. Test production-only Git and packed installations, native Pi loader entry, public pi-subagents co-installation and foreign `cw`; a link to the utils checkout is not distribution proof.

Do not upgrade the current Pi1.3.0 project baseline or global host. Existing main entry points, package policy and installed tests must still work under the supported npm policy. Preserve third-party notices when ownership moves.

## Risks / Trade-offs

- [Shared Interface drops response-range or reset guarantees] -> Port the existing stale-file/own-response tests and intentional-break controls across the shared seam.
- [Review becomes a new child or gets a fresh business allowance] -> Assert one child, at most two inquiries/six consumed responses, existing final-effect charges and terminal-only handoff.
- [Nested packaging regresses while checkout tests pass] -> Gate removal on a clean installed consumer running the real private entry.
- [Refactor breaks cancellation/publication races] -> Keep existing source/receipt/rollback and actual TUI checks; optional audit failure must still warn without gating work.

## Migration Plan

1. Freeze current observable assertions and identify which move to utils conformance versus remain consumer policy tests.
2. After Reflect's shared-layer adaptation passes its required gates, use the verified shared entry behind the Continue policy adapter; run focused, installed and dual-watchdog cases. Existing Continue baseline fixtures may inform shared conformance earlier, but production adaptation follows Reflect under the user's confirmed order.
3. Remove superseded local transport/patch ownership, update dependencies and documentation, and synchronize affected Lean annotations/process models during apply if needed.
4. Run complete check/E2E and exact changed-model gates. Report new evidence separately from the archived 569/62 baseline.
5. Revert the consumer change to the prior verified dependency/adapter for rollback. Do not add a runtime transport switch, resurrect old files or edit archived task3.1 evidence. The user has now separately authorized verification followed by coordinated pushes of all three repositories and command-scoped unsigned commits for this round; retain global signing policy and normal fast-forward history.
