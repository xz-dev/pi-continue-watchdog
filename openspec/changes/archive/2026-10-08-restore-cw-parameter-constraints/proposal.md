## Why

`cw` currently publishes an empty parameter schema, so missing fields and invalid actions pass the tool contract and fail only after the model responds. The requirement for minimal text was misinterpreted: omit explanatory descriptions, not machine-readable argument constraints.

## What Changes

- Declare the three required string arguments (`reason_content`, `reason_type`, `action`) in the existing Pi tool parameter schema. Constrain actions to `continue` and `unlock`, reason types to the effective configured types, and reasons to nonblank text within the existing 1000-Unicode-code-point bound.
- Keep description exactly `don't use unless ask`; add no parameter descriptions, examples, prompt snippets, or startup guidelines. Structural keywords are not explanatory text.
- Preserve one stable root-only declaration across decision phases. Build it from the effective configuration rather than hard-coded reason lists; do not add an MCP server or phase-specific tool replacement.
- Preserve trim/case normalization, unrelated-extra-field tolerance, action-specific reason admission, authorization, and continuation-only retry accounting. Normalize compatible inputs before native schema validation without manufacturing missing values or granting authority.
- Capture and terminate invalid owned responses before Pi's native schema-error follow-up path, keeping the existing three-attempt correction bound and safe diagnostics.
- Retain inquiry guidance for decision semantics and the existing concise assessment; format requirements must no longer depend exclusively on prose. Keep runtime validation even when a provider honors the schema.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ai-unlock-tool`: A constrained, description-free parameter declaration derived from effective configuration, with stable registration and compatibility preparation.
- `decision-response-contract`: Structural validation without loss of phase gating, input normalization, or bounded owned-response correction.
- `watchdog-configuration`: Effective reason types populate the public schema as well as authorized guidance.
- `unlock-tool-delivery-boundary`: Distinguish public structural constraints from withheld explanatory usage text.

## Impact

- Implementation seams: `src/decision-tool.ts`, `src/decision-protocol.ts`, and `src/runtime.ts`; existing config sources remain authoritative.
- Verification seams: tool/schema checks, protocol/runtime lifecycle checks, and serialized provider requests through the existing packed stock-Pi fixture. Include native schema-validation ordering rather than testing only direct `execute()` calls.
- Apply must reconcile `docs/architecture.md`, `docs/behavior-contract.md`, and the affected `docs/programming-thinking/official-pi-idle-inquiry.idea.lean` process model. Main OpenSpec synchronization remains a separate workflow.
- No dependencies, Pi changes, provider settings, environment changes, reviewer-model feature, live-model requests, installation, commits, or pushes. Preserve the existing README edits and independent `add-optional-unlock-review` change.
- This proposal records the plan only; production code and existing behavior remain unchanged until a subsequent apply request.
