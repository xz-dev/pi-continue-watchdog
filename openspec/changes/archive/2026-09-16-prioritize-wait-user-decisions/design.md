## Context

The watchdog already distinguishes continue, bounded external wait, and typed unlock outcomes, but the fixed prompt describes them independently rather than as an ordered classification. Models can therefore treat “work remains” as sufficient for continue even when all remaining work is gated by user approval. The safe continuation envelope prevents that follow-up from becoming authorization, but it cannot prevent the unnecessary extra turn.

The implementation seam is `buildDecisionPrompt`: configured intent is followed by one fixed parser-critical suffix. Classification guidance belongs in that fixed suffix so custom `decisionPrompt` values cannot weaken it. XML parsing, reason normalization, configured reason lists, and runtime finalization do not need behavior changes.

## Goals / Non-Goals

**Goals:**
- Make outcome categories mutually understandable through an explicit priority order.
- Define continue by immediate executability, not merely unfinished scope.
- Make user-dependent waiting choose `WAIT_USER` on the first decision.
- Preserve custom reason-type lists while using the built-in semantic names as the default examples.
- Cover prompt text and a real provider-facing approval-gated decision request.

**Non-Goals:**
- Infer whether a real-world action is dangerous inside runtime code.
- Override project or user safety policies.
- Change XML parser leniency, validation limits, retries, config shape, or continuation-envelope behavior.
- Force unlock when independent authorized work can still proceed.

## Decisions

### Encode one ordered decision policy in the fixed suffix

Render these rules before outcome examples:

1. If no concrete action can proceed without user input, approval, confirmation, authorization, credentials, or another user action, unlock using the configured `WAIT_USER` type.
2. If progress only requires temporary external automation or elapsed time and no user action, wait.
3. Continue only when a concrete requested and authorized action is executable now; require `reason_content` to name it.
4. If all work is complete, unlock using `JOB_DONE`.
5. Otherwise, if blocked for a non-user, non-temporary-wait reason, unlock using `JOB_BLOCKED`.

Also state directly that unfinished work alone does not justify continue.

Alternative: add a second watchdog decision after every continue. Rejected because it preserves the wasteful loop and still relies on the continuation envelope to correct an avoidable classification error.

Alternative: runtime heuristics over reason text or conversation content. Rejected because string matching cannot reliably classify authorization boundaries and would duplicate model reasoning.

### Resolve semantic reason types from effective configured lists

The prompt should refer to the effective configured values that correspond to built-in defaults when present, while still listing the full effective arrays as today. If a user replaces reason types with domain-specific labels, the ordered semantic prose should describe the category and use the available configured example without adding a new configuration contract.

Implementation should remain minimal: add fixed prose around the existing generated examples and effective JSON lists. Do not add a classifier, schema, or dependency.

### Test contract text and provider-visible behavior

Unit tests should assert the fixed suffix includes:
- WAIT_USER-before-WORK_REMAINS priority;
- “unfinished work alone” prohibition;
- immediate executable action requirement;
- external wait/user wait distinction;
- unchanged XML examples and response-shape requirements.

Packed E2E should inspect the actual decision request for an approval-gated ordinary response and assert the provider receives the ordered guidance before returning a `WAIT_USER` unlock. Existing continuation-envelope approval-boundary coverage remains as defense in depth.

## Risks / Trade-offs

- [Longer decision prompt consumes more tokens] -> Use concise numbered rules and reuse existing examples/lists.
- [Custom reason labels may not literally contain `WAIT_USER`] -> Keep category prose authoritative and continue advertising effective configured lists; avoid hard validation against built-in names.
- [Model may still misclassify despite clearer wording] -> Add provider-facing regression evidence and retain the non-authorization continuation envelope as the safety backstop.
- [Over-prioritizing WAIT_USER could stop despite independent work] -> Explicitly allow continue when another concrete requested and authorized action is executable now.

## Migration Plan

1. Update the fixed decision suffix and focused unit assertions.
2. Add packed approval-gated decision-request coverage.
3. Update behavior-contract, architecture, and affected Lean process documentation.
4. Run full checks and E2E suites.

Rollback is a source revert; no stored data or configuration migration is required.
