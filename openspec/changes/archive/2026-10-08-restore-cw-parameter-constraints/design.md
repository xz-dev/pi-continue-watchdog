## Context

See `proposal.md` for motivation. The current root tool is `cw`; its description is already minimal, but `src/decision-tool.ts:77` uses `Type.Object({}, { additionalProperties: true })`. A read-only probe against the actual definition accepted both `{}` and `{ action: "bogus" }`, while `validateDecisionArguments` returned `action must be one of continue or unlock (case-insensitive after trimming).` The original invalid model payload is unavailable, so this establishes the contract gap, not the exact contents of that incident.

Relevant seams:

| Seam | Current responsibility / evidence |
| --- | --- |
| `src/decision-tool.ts` | Root tool declaration, staged result execution, quiet owned rendering. |
| `src/decision-protocol.ts` | Raw payload validation, trim/case normalization, 1000-code-point hard bound, configured reason admission, bounded corrections. |
| `src/runtime.ts:1900–1962` | Current-attempt submission and root registration after configuration becomes ready. |
| `src/runtime.ts:2954–3119` | Owned `message_end` preflight, safe audit, and projection before native tool dispatch. |
| `src/runtime.ts:3490–3570` | Post-schema `tool_call` gate and staged-invalid result handling. |
| `test/e2e/packed.test.ts:1527–1686` | Native packed fixture already covers three invalid replies, retired wait actions, and custom case-insensitive reason types. |
| Pinned Pi `ToolDefinition` declarations | `prepareArguments` is a supported pre-schema compatibility hook; `parameters` remains the model-visible schema. |
| Pinned Pi bundled `prepareToolCall` / `prepareToolCall2` | Preparation precedes schema validation; validation precedes the before-tool gate. Native schema exceptions return immediate errors rather than plugin-owned terminating results. |

The node dependency is pinned to Pi 0.85.1. API behavior was checked against installed declarations and bundle, not inferred only from the newer running Pi documentation. TypeBox's installed string validator was probed: 1000 emoji pass `maxLength: 1000`, 1001 fail, and `pattern: "\\S"` rejects whitespace-only text.

The existing `README.md` edits and `add-optional-unlock-review` change are independent work. This change does not implement or rewrite that proposal. Their later integration must reconcile only overlapping requirements, preserving both deltas rather than archiving one over the other.

## Goals / Non-Goals

**Goals:**
- Make tool metadata carry the structural contract while leaving prose minimal.
- Deliver schema, compatibility preparation, and owned-invalid termination as one vertical slice; an enum-only patch is not independently releasable.
- Preserve behavior of existing authorized clients and all currentness/authorization fences.

**Non-Goals:**
- A new MCP service, model, review mechanism, provider integration, configuration watcher, or tool lifecycle framework.
- Forcing provider-specific strict generation, guaranteeing model obedience, or replacing semantic decision guidance with a schema.
- Tightening extra-field acceptance, rejecting existing case/whitespace variants, changing the 500-character guidance target, or changing the 1000-code-point acceptance limit.
- Updating archived history, applying the change, installing/reloading the extension, or starting live model requests during proposal creation.

## Decisions

### 1. Use one ordinary object schema with structural keywords only

Build `cw.parameters` with the existing TypeBox dependency. Declare properties in the current assessment-first guidance order; ordering is presentation, never an acceptance rule:

| Property | Declaration |
| --- | --- |
| `reason_content` | `type: string`, `minLength: 1`, `maxLength: MAX_REASON_CHARACTERS`, `pattern: "\\S"` |
| `reason_type` | `type: string`, `enum`: exact-deduplicated union of effective continue and unlock types, preserving configured spellings |
| `action` | `type: string`, `enum: ["continue", "unlock"]` |

All three are required. Keep `additionalProperties: true` because the existing result contract explicitly tolerates unrelated extra fields. Do not add parameter `description`, `title`, `examples`, `default`, `promptSnippet`, or `promptGuidelines`. Preserve tool description `don't use unless ask`.

The union enum expresses allowed reason vocabulary. Existing action-specific runtime validation expresses which subset applies to the chosen action. Do not duplicate that relation in a root union/conditional schema: nested discriminated schemas have uneven provider support and do not remove the need for runtime validation. A reason in the wrong action's list must still fail.

Do not enable `constrainedSampling` as part of this change: provider strict modes have additional schema restrictions and are not needed to transmit or locally enforce the parameter contract. Do not silently change extra-field policy to satisfy a provider. Captured real request serialization, not only the local TypeBox object, must prove the declaration is transmitted.

### 2. Derive all surfaces from effective configuration

Pass the effective reason lists into the tool-definition builder after existing configuration loading. Preserve the configured spellings in the enum and use the existing trim/case matcher to select the matched spelling for prepared arguments. Uppercase is the existing outcome/report representation, not the schema's input vocabulary. Use no copied built-in lists and no new config keys.

Ordinary lock/check/correction/continue/unlock transitions must not change tools. Existing ownership/session configuration loading can already replace the runtime config. On that path, refresh the same named declaration only if its effective constraints changed, before opening another decision. Keep exactly one registered `cw` and preserve its existing active membership; re-registration must not accidentally reactivate a user-disabled tool. Equal effective constraints require no refresh. No new file watcher, per-attempt registration, hidden/public schema swap, or promise of cache hits.

This qualifies the old unconditional once-ever registration rule only for an actual effective-configuration change, avoiding a stale enum while leaving all ordinary phase transitions stable.

### 3. Normalize compatible raw inputs without creating valid decisions

Use the host's existing `prepareArguments` hook rather than a new dispatch layer. Reuse the protocol's trimming and case-insensitive reason matching through a small shared pure normalization seam where needed. Preserve input immutability and unrelated properties.

Preparation can normalize an existing valid action, select the matched configured reason spelling for that action, and trim string content. It must not supply absent fields, stringify numbers, map `wait` to another action, truncate a reason, or stage/commit a verdict. Invalid values remain invalid. Do not derive accepted input aliases from uppercase output: for config `["ß"]`, publish and accept `ß`, not `SS`. Where the current staging path reconstructs arguments from an uppercase verdict, retain/reuse the already validated input identity instead; do not broaden reason admission to make the reconstruction pass. This is a compatibility requirement at the touched seam, not a Unicode normalization project.

Validate the original owned payload before native preparation/coercion. This keeps existing no-coercion semantics even if native validation has conversions. Pure preparation is not an authorization operation; the execution host still checks current attempt and call identity before accepting a submission. Schema-valid ordinary calls keep the existing reserved rejection. Schema-invalid ordinary calls can fail natively, but cannot charge, unlock, or terminate unrelated ordinary work.

### 4. Stop invalid owned payloads before native schema errors

Extend the existing owned `message_end` preflight rather than adding a second error controller. It already has the complete response, authentic run/cycle checks, a parsed `DecisionProtocolPlan`, and safe audit data before any tool executes.

For an owned `plan.outcome === "invalid"`, preserve that plan/diagnostic and project a normal stop with no executable tool calls, including when the batch shape is a singleton `cw` but its arguments fail. The existing settlement path charges one invalid response and issues at most two corrections. Do not attach raw arguments to watchdog diagnostics and do not allow Pi's generic validation-error path to request another ordinary reply.

For valid plans, keep the correlated call and required thinking intact, let preparation and native schema validation run, then use existing `execute`, staged-result, terminate, and settlement fences. Keep duplicate submission handling and the fallback for authorized invalid results reaching execution. No early transition merely because a plan or schema check succeeded.

### 5. Keep prompts about decisions, not the sole type contract

Keep authorization/delivery assessment, action meanings, action-specific configured lists, the existing correction diagnostic, and the 500-code-point guidance target in authorized prompts. Structural repetition there is guidance, not enforcement. Remove or update comments/docs that equate minimal descriptions with absent properties/enums. Do not rewrite unrelated decision policy or introduce a new prompt template system.

## Acceptance and Verification

Use existing `node:test`/`tsx`, runtime harnesses, and packed localhost provider fixtures. No new framework or live credentials. Tests must observe declared/serialized tool parameters or externally visible request/result behavior, not private helper names.

| ID | Example / expected observation | Narrowest evidence seam |
| --- | --- | --- |
| S1 | Default and custom configs publish three required strings, both actions, effective reason enums, reason bounds; no explanatory annotations. | Tool definition plus captured provider request |
| S2 | Missing fields, numeric fields, unknown action/type, `wait`, empty/blank reason, and 1001 code points fail schema; canonical valid inputs and 1000 emoji pass. | Actual declared schema validator |
| S3 | ` UNLOCK ` / ` needreview ` / padded valid reason keep current normalized outcome; extra fields and either property order remain accepted. For config `["ß"]`, input `ß` remains admitted and `SS` remains rejected without reinterpreting uppercase output as input. | Preparation + native validation + protocol |
| S4 | A 1000-code-point reason with surrounding whitespace stays valid after trimming; no truncation/coercion fills invalid fields. | Protocol/native path |
| S5 | Reason allowed only for continue fails for unlock even though it belongs to the public union enum; overlapping configured labels remain valid for both. | Owned runtime response |
| S6 | Schema-valid ordinary copied arguments return reserved; ordinary malformed inputs have no watchdog state or batch-termination effect. | Native tool + runtime fences |
| S7 | Three owned missing/invalid actions yield exactly three inquiries, two corrections, safe terminal diagnostic, no fourth native request, no continuation charge. | Packed stock-Pi request capture |
| S8 | A valid response following an invalid one executes once and reaches the existing continue/unlock publication boundary. | Runtime and packed fixture |
| S9 | Mixed/duplicate calls, retired waits, takeover after staging, and stale ownership remain inert or bounded as before. | Existing lifecycle regressions |
| S10 | Declaration and active membership remain unchanged across phases; children register no `cw`; changed effective config refreshes only the same root declaration before use. | Registration/config lifecycle plus provider capture |
| S11 | Schema-valid shape is not reported as proof of provider strict decoding, semantic correctness, or authorization. | Spec/doc review |

Start with S1/S2 as the red criterion: the current empty schema cannot reject missing/invalid arguments. Add S7 before tightening the production schema so native-loop regression is caught in the same slice. Record exact red/green commands and no-fourth-request evidence. Preserve the current packed mixed-case test as a compatibility gate.

During apply, update the affected existing Lean process model to represent structurally invalid owned payload projection, unchanged ordinary-call authority, and bounded correction. Do not claim the current model's transport assumptions already prove the new native integration. Inspect the full file before execution, typecheck/run with the existing Lean toolchain, and perform the required independent semantic check. No new parallel model or competing source of truth is needed for proposal-only artifacts.

## Risks / Trade-offs

- **Native schema rejection bypasses the later gate** → owned invalid plans stop at existing preflight; packed three-response test is release-blocking.
- **Canonical schema narrows legacy raw encodings** → pure pre-schema preparation preserves trim/case behavior; original owned payload is still validated without coercion.
- **Config reload leaves schema stale** → refresh only on changed effective constraints and preserve active membership; test reload rather than only initial registration.
- **Some providers ignore or restrict schema keywords** → verify serialized requests and retain runtime validation; do not claim strict generation or broaden provider support here.
- **Reason-type union admits cross-action combinations structurally** → retain the authoritative action-specific runtime check and test it explicitly.
- **Uppercase output can lose configured input identity** → preserve configured enum spellings and matched input through revalidation; S3 rejects new uppercase-derived aliases.
- **Concurrent optional-review work touches the same runtime/spec** → recheck the working tree before apply, rebase the plan against actual changes, and do not rewrite the sibling proposal or unrelated dirty files.

## Migration Plan

1. Proposal phase writes only this change's artifacts; no existing behavior changes.
2. On a subsequent apply request, implement and verify the one coupled schema/normalization/preflight slice, then update affected behavior docs/process model. Reuse installed dependencies and temporary artifacts under `/var/tmp/`.
3. Run relevant focused checks, `npm run check`, and packed native-request regressions; obtain independent review before calling implementation ready. Report any unavailable CI/Lean/native gate as pending rather than passed.
4. No automatic configuration migration, extension reload, install, deployment, commit, or push. Main-spec synchronization/archive occurs only through a separately requested workflow.
5. If rollback is needed, revert the coupled implementation as a unit. Do not leave a strict schema paired with the old native-error path; no persisted data/config migration needs reversal.
