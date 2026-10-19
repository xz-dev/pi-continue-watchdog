## Why

Watchdog decisions currently run inside the user's main session, expose a reserved `cw` tool, and depend on later context and summary projection to remove internal exchanges. A private fork can keep new decision traffic out of that session from the start while retaining its effective conversation and returning the actual validated decision without another main-model rewrite.

## What Changes

- Run each logical decision in one watchdog-owned foreground fork session, using the parent session's current provider/model and full effective active-branch context. Keep the user's selected session unchanged and the UI responsive.
- Embed a pinned, narrowly patched `pi-subagents` runtime through a private adapter, without loading its public extension, tools, commands, delegation/RPC bridges, user agent discovery, or ambient child extensions.
- **BREAKING**: raise the minimum supported Pi baseline to `1.3.0` and pin the project development/test SDK and TUI to `1.3.0`; retaining `0.85.1` compatibility is out of scope, as explicitly selected by the user during apply. Do not upgrade a user's global Pi installation.
- **BREAKING**: stop registering watchdog result functions (`cw` and legacy unlock tools) and stop accepting function calls as decision submissions. The child instead writes a host-created temporary JSON file initialized to `{}`; only that file supplies the result.
- Preserve existing payload fields, normalization, action-specific reason validation, outcome semantics, continuation budget, callback suspension, and optional unlock review.
- Keep format corrections inside the same child session. Each attempt permits one completed model response and its admitted result-file write, with no automatic post-tool model response. Reset the file before each attempt and permit at most three response attempts per inquiry.
- Keep the initial inquiry and any one review-triggered semantic reconsideration in that same child session, with separate existing three-response allowances and no intermediate decision returned to the main model.
- Cancel the exact child on takeover, manual unlock, or lifecycle invalidation; discard stale results. Preserve actual continuation execution in the main session and existing guarded outcome publication.
- Retain read-only compatibility for old inquiry/audit/fold records; do not rewrite historical sessions or rearm recovered work.

## Capabilities

### New Capabilities

- `watchdog-private-fork-decisions`: private embedded execution, effective-context inheritance, temporary-file result submission, single-response attempts, and same-session correction ownership.

### Modified Capabilities

- `ai-unlock-tool`: retire public result-tool registration while preserving validated terminal unlock and callback effects.
- `decision-response-contract`: replace main-session function inquiries with private file-result inquiries while retaining decision policy, bounds, authorization, and accounting.
- `unlock-tool-delivery-boundary`: keep control reasons separate from ordinary user deliverables without a public result function.
- `watchdog-owned-run-cancellation`: cancel private decision sessions without aborting unrelated main work or publishing private abort residue.
- `watchdog-review-context`: retain source-aware decision evidence and branch-correct audit recovery without storing private prompts/corrections in the main conversation or treating temporary files as durable history.
- `watchdog-unlock-review`: route the existing optional semantic reconsideration into the same private child session instead of a new main-session inquiry.

## Impact

- Primary implementation seams: `src/runtime.ts`, `src/extension.ts`, `src/decision-protocol.ts`, `src/decision-tool.ts`, `src/context-fold.ts`, `src/summary-projection.ts`, and review/cancellation adapters; add only the small private runner/file adapter needed at those seams.
- Dependencies: pin a reproducible `pi-subagents` base plus a watchdog-owned patch exposing an unregistered instance-local runner and a real single-response boundary. Use the user-approved Pi `1.3.0` development/test and minimum support baseline, and verify its actual fork/projection APIs; the inspected subagents package declares `pi-ai >=0.86.1`. The private runtime remains pinned to `1008e599`, independent of updates to any globally installed public plugin.
- Verification: adapt existing unit/runtime and packed stock-Pi scenarios, including co-installation with public pi-subagents, same-session invalid-result correction, cancellation, stale-file rejection, publication, callback suspension, and optional review. No new test framework is required.
- Documentation and process models: update behavior/architecture documentation and affected `docs/programming-thinking/*.idea.lean` models during apply, not in this planning-only change creation.
- Out of scope: moving ordinary task execution into the child, a public orchestration API, arbitrary child file access, new polling or retry settings, a replacement external review service, guaranteed cache hits, or a security sandbox against arbitrary trusted extensions in the same process.
