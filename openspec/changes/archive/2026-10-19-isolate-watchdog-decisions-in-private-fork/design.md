## Context

See `proposal.md` for motivation and scope. The current dispatch in `src/runtime.ts` uses `createInquiryRuntime` and `pi.sendMessage(..., { triggerTurn: true })` in the owning main session. `src/decision-tool.ts` registers `cw`; runtime preflights its response, stages a verdict, and later folds the internal exchange. `src/extension.ts` also projects compaction and branch-summary inputs. The controller, canonical publication receipts, activity fence, and optional unlock review already encode behavior that this change must retain.

The inspected installed `pi-subagents` is `0.79.0` at `1008e599`. Its package exports provide delegation and other extension integrations, but not an unregistered embedded foreground runner. Delegation requires the public extension to be loaded. Its foreground execution does create a separate in-process Pi session, disables ambient extensions, and inherits parent provider registrations. Useful source seams include `src/runs/shared/child-session.ts`, `child-launch.ts`, `subagent-prompt-runtime.ts`, and the fork-session helpers. Its `src/shared/types.ts` explicitly marks turn budgets as historical and unenforced; passing `maxTurns: 1` does not implement the requested bound.

The original development/test baseline was Pi `0.85.1`. Independent inspection confirmed that it lacks `SessionManager.buildSessionProjection` and the `context_with_system` contract needed by the selected fork projection. During apply, the user explicitly chose raising the baseline instead of maintaining a larger legacy adapter. Pin project SDK/TUI dependencies to the registry's stable `1.3.0` release and declare Pi `>=1.3.0` support; retaining `0.85.1` compatibility is out of scope. This authorizes project dependency changes, not upgrading global Pi or modifying a user's installed plugins. Existing untracked `PLAN/provider-retry-accounting.md` remains separate work.

## Goals / Non-Goals

**Goals:**

- Replace the execution/transport seam without replacing decision policy, controller transitions, or canonical publication.
- Make one logical decision an owned resource: one child session, one private result-file location, linked response attempts, one cancellation signal, and one terminal promise.
- Interpret the agreed one-round limit as one completed model response per attempt, including its admitted write; retain the existing initial-plus-two-corrections limit per inquiry.
- Preserve a full effective fork while keeping executable child permissions narrower than inherited tool declarations.
- Make format correction and optional semantic reconsideration local to that one child, with no intermediate main-model round trip.

**Non-Goals:**

- Moving ordinary task execution or the selected TUI session into the child.
- Loading the full public subagent extension and hiding its tools afterward.
- Replaying all ambient extension hooks, providing an OS sandbox, or certifying the final wire payload of arbitrary providers/extensions.
- Replacing the optional shared review service, introducing a new retry setting, changing continuation accounting, or claiming guaranteed cache reuse.
- Rewriting old session files, deleting existing formal models, or implementing code during artifact creation.

## Decisions

### 1. Use a pinned private patch layer, not the public extension API

Add a project-owned patch layer over an exact `pi-subagents` package revision and import only its narrowly exported private-runtime entry. Keep its dependency instance under the watchdog's package boundary, separate from any independently installed public extension. Ship the dependency reference and patch with the packed watchdog artifact; verify their version/content match before applying the patch. Never patch a user's global plugin checkout or a shared dependency instance in place.

The patched entry must create an instance-local child factory and expose only the lifecycle needed here: full-fork creation, one-response execution, cancellation, and disposal. It must not initialize public tools, commands, RPC/delegation listeners, agent discovery, fleet state, process-global active-factory setters, background schedulers, supervisor tools, or a nested watchdog. The watchdog adapter owns the local retry/review loop. Reuse the upstream fork projection and session/provider machinery rather than copying the entire execution engine.

A package-local dependency alias and included patch artifact are acceptable packaging; they must produce a self-contained clean packed install without a developer checkout or network-fetched latest patch. The exact pinned revision is recorded when the compatibility gate is run, before runtime integration. No release, push, or external repository mutation is implied by these tasks.

**Alternatives rejected:** public delegation requires public registration; filtering a proxied `ExtensionAPI` leaves event/global-state side effects; unsupported deep imports couple the plugin to unexported implementation without a maintained patch; reimplementing the fork runtime directly on Pi duplicates the machinery the user chose to reuse.

### 2. Keep compatibility and single-response control as early gates

First verify the required APIs on the user-approved, exact stock-Pi `1.3.0` SDK/TUI baseline, then exercise the patched entry and a clean packed installation against it. Verify actual fork projection, provider inheritance, tool completion, cancellation, and a one-response stop. Declare the raised minimum support range; do not suppress peer failures, upgrade a global host, or silently change the selected project baseline again. If `1.3.0` cannot support the contract, stop that implementation slice and report the concrete compatibility decision needed.

The one-response boundary is execution control, not an after-the-fact counter. The child must collect a complete assistant response, preflight its entire tool batch and write arguments, execute at most the designated write, wait for its completion, and stop before the normal agent loop asks the provider again. Pre-dispatch rejection of invalid batches and a terminating admitted write can use supported Pi hooks; the private patch must close all native validation/error-follow-up paths. Use neither a racing post-turn abort nor the deprecated turn-budget field as the only enforcement.

No child-generated acknowledgement, empty-result repair, tool-error repair, or runner-created summary may add another model response within the attempt. A missing write ends the attempt and is handled by the explicit correction loop. Do not use abort to label a normally completed single-response attempt; real aborted/error outcomes remain distinguishable. Provider transport recovery remains provider-owned and is reported honestly rather than advertised as one HTTP request.

**Alternative rejected:** setting a prompt instruction or `maxTurns: 1` cannot prove that the file write completes before a native follow-up is prevented.

### 3. Fork the eligible effective conversation, not raw JSONL alone

At the qualified idle boundary, capture the owner claim, main session identity, active source leaf/ancestry, lock/publication cycle, external activity generation, selected provider/model, thinking setting, and effective conversation/system/tool projection. Reuse the host's compaction and exclusion rules and the watchdog's legacy inquiry projection before sending inherited messages. Apply the existing bounded source supplement only after the inherited conversation.

Do not rerun every parent extension to rebuild the child. Inherit the required provider registrations into a child-local runtime and load only the private fork projection, single-response, cancellation, and result-writer hooks. Do not discover user agents or honor public subagent defaults that select another model, prune history, or silently start fresh. Unavailable full-fork input is an execution/setup failure, not a reason to substitute a different context.

Retain parent system/tool declarations as upstream's compatible projection permits. The child executes only the guarded stock file writer. Reuse a compatible inherited writer declaration when possible; if the writer must be added/redeclared, let the provider adapter represent that change honestly at the fork point or through its required checkpoint. This can reduce cache reuse without reducing inherited conversation. Do not fake an exact wire-prefix guarantee or inherit a foreign extension's executable write handler to preserve one.

The source leaf is an anchor, not a promise that the parent file can never append again. Exact owned audit/publication appends are allowed descendants. A non-owned source change, branch move, takeover, session/lifecycle replacement, or external-work generation change invalidates the operation. Parent audit appends must not make the operation stale against itself.

**Alternatives rejected:** raw branch copying can revive old hidden inquiry traffic; calling every ambient hook recreates plugin coupling; a bounded excerpt cannot replace the agreed full effective fork.

### 4. Treat the JSON file as a transient result channel

Allocate one private, uniquely named directory under `/var/tmp/` for each logical decision, with owner-only access and one `decision.json` result path. Before each response attempt, wait until prior admitted writes are settled and initialize that file to exactly `{}`. Do not reuse the path across logical decisions or process recovery.

Only the child can request its one admitted write; a native write-tool-compatible wrapper checks the exact resolved path and prevents symlink or alternate-path replacement. The private response preflight rejects unknown tools, ordinary work, duplicate writes, and mixed batches before effects run. Do not narrow permissions by changing the main tool registry or rely on prompt instructions as the permission boundary. No shell, delegated process, arbitrary read, or arbitrary write is needed to make a decision from inherited context.

After normal single-response settlement, safely read the designated regular file and decode one complete JSON object. Reuse the pure decision validator from `src/decision-protocol.ts`: three required strings, action-specific reason matching, matched configured identity, existing trim/case normalization, Unicode reason bounds, property-order independence, and existing extra-field acceptance. Do not turn the transport migration into a stricter object policy or a prose parser. A valid object in stdout or an assistant reply is irrelevant; a valid file is not proof of semantic correctness.

Untouched `{}`, absent/model-damaged results, invalid JSON, and invalid decision fields produce safe format diagnostics. Host allocation/reset/read failures are typed execution failures, not three invented model errors. Do not copy raw invalid bodies into parent audit/history. On cancellation revoke authority immediately, drain or quarantine outstanding writes, and only then dispose/clean owned resources. Never scan old temporary directories for resumable decisions.

**Alternatives rejected:** specialized `cw`/`structured_output` functions violate the chosen transport; serializing a prose response into JSON on the child's behalf would not establish that it actually wrote a result; durable file recovery would create a competing authority store.

### 5. Run the correction and review loop inside one owned operation

The private adapter's one outer promise remains pending across this sequence:

1. Create one child and begin the initial inquiry.
2. Reset the file and authorize one response attempt.
3. Complete the single response/write, then validate.
4. If invalid and fewer than three responses were consumed, append the safe concrete error plus correction guidance to the same child and repeat step 2.
5. If the third response is invalid, settle once as decision-failed without another response or continuation charge.
6. If valid `continue`, proceed to terminal handoff. If valid initial `unlock`, invoke the existing optional review adapter while keeping the child and outer operation alive.
7. Supported/incomplete review releases the still-current candidate. A definite challenge appends the existing opinion-not-evidence feedback to that child, starts the one reconsideration inquiry, resets the file, and uses its separate three-response allowance. Never review the replacement again.
8. Settle once with the final normalized candidate or a typed cancellation/execution failure. The parent still rechecks currentness and publication before applying an effect.

A candidate can be passed to an internal review callback without settling the outer promise or returning it to the main model. Freeze the review service's permitted macro evidence from the owning main conversation, not the child's private prompt, retry history, or file-write traffic. Keep external review availability, service-owned transport retries/timeouts, incomplete-review fallback, and optional audit failures unchanged.

Keep four quantities distinct: consumed format responses (maximum three per inquiry), the optional reconsideration count (maximum one), provider/service transport attempts (observations, not format retries), and `maxContinue` units (accepted final continue/callback effects only). No fourth format response follows a native tool error, and no two-response "write then acknowledgement" is hidden inside a nominal one-response attempt.

**Alternative rejected:** completing a subagent call for every invalid candidate and asking the main session to launch another one loses local ownership and reproduces the old round trip.

### 6. Separate private work from aggregate external activity

The existing ten-second idle fence remains the entry gate. Once an owned private operation begins, the controller's active decision blocks duplicate inquiries. Do not load the watchdog extension into this child and register it as an ordinary observable attachment; track it directly through the owned operation handle. Its own generation/write/settlement must not invalidate its source external-activity generation.

Genuine user input, external agents, and process-domain activity still invalidate at the existing boundary. Route manual unlock to the exact child handle, not `ctx.abort()` on a potentially unrelated main session. On takeover, revoke/cancel the child and let Pi handle the complete new user input normally; do not add queue copying/replay. Reuse existing unlock controls and preserve ordinary main/continuation Esc behavior. If native foreground cancellation is delivered to the private operation, correlate its cause to that operation and preserve actual aborted state; do not infer a main abort from arbitrary child cancellation.

Reset, reload, ownership loss, session/branch replacement, and shutdown revoke the signal and result authority before awaiting disposal. Recheck currentness after each awaited boundary and before publication. Late files, late review answers, repeated terminal callbacks, and owned cleanup must be inert for a later cycle. Preserve the existing bounded status when real external subagent activity invalidates a task already submitted.

**Alternative rejected:** treating private generation as ordinary external activity causes self-cancellation; blocking a main lifecycle callback or event loop until child completion can prevent the very cancellation/input events needed to finish.

### 7. Preserve main-session outcomes, audits, and legacy recovery

The private operation changes where decisions are computed, not where approved work runs. Feed its normalized terminal candidate into existing controller and durable-publication logic. Continue still publishes the existing canonical continuation and runs ordinary work in the main session; actual unlock and callback suspension keep their existing human-only status and semantic-hook behavior. A result file never substitutes for a confirmed parent publication receipt. Do not create a main-model confirmation/rewrite call.

Store only versioned context-excluded associations and safe diagnostics in the main native session: captured source identities/view, logical decision, child/inquiry/response identifiers, normalized candidate or error category, optional review diagnostics, and association with an actually published outcome. Do not copy private prompts, corrections, file paths, tool payloads, raw invalid output, or thinking into the main model context. Optional metadata failure retains existing non-gating behavior.

Keep legacy `context-fold.ts` and native-summary projection support for old persisted inquiry/function traffic. Remove only the new-dispatch path and public decision-tool registration after the new path passes its vertical slice. Reopening a session restores history, never an active child, lock, retry allowance, temporary-file authority, or old publication. The existing `ai-unlock-tool` and `unlock-tool-delivery-boundary` capability paths remain as historical spec organization; rename/purpose cleanup is not part of this planning-only change.

**Alternative rejected:** deleting legacy folds when new traffic moves out of the main session would leak old internals on resume or into summaries.

### 8. Verify observable behavior at existing test seams

Use the current Node/tsx unit/runtime tests and packed stock-Pi fixtures, not a new framework. The packed provider trace and session records must prove distinct child/main session identities, unchanged selected session, no watchdog public tool/command additions, no private exchanges in main/summary inputs, and no post-write model follow-up. Test co-installation with public pi-subagents and a foreign `cw` owner separately from a standalone install.

The first vertical slice is a valid no-review file decision with one response and one guarded publication. Then add same-child invalid-to-valid correction and three-invalid exhaustion; cancellation during generation/write/review; external-activity versus self-activity; callback/budget and review/reconsideration; and legacy resume/summary cases. Use deterministic local providers and private temporary directories, not live paid inference. Demonstrate the relevant unmet criterion and intentional-break sensitivity when implementing each slice; green evidence is not human product acceptance.

Update affected `docs/programming-thinking/*.idea.lean` process models during apply and check the exact edited models with the project's Lean policy. Their proof scope must distinguish modeled safety from host/provider observations; formal proofs and mocked tests cannot certify final provider payloads or every publication interleaving.

## Risks / Trade-offs

- [No supported embedded API in the inspected upstream] → Keep the patch small and version-pinned; the private import must never initialize the public extension or use global factory overrides.
- [Host SDK/dependency mismatch] → Prove the selected `1.3.0` baseline and clean packed install before integration, declare the raised support range, and stop on any further incompatibility rather than silently changing versions, bypassing peer requirements, or switching execution modes.
- [Persisted history differs from effective context] → Exercise legacy folding, native compaction, inherited system/tool state, source anchoring, and owned audit appends at the real child-request seam.
- [A tool result normally triggers another response] → Enforce and test the stop before the agent loop can schedule that response, including native argument rejection and writer failures.
- [Same process shares providers and trusted-code privileges] → Isolate runner state/registrations and ambient hooks; explicitly do not promise an OS sandbox or immunity to arbitrary trusted code.
- [Writing via a new/redeclared tool changes cache prefix] → Preserve compatible inherited declarations and report actual cache usage; do not make cache hits a correctness or acceptance gate.
- [Cancellation races with file writes or review] → Revoke result authority first, drain/quarantine writes, retain exact operation identity, and recheck currentness before effects.
- [Legacy and new paths diverge during migration] → Keep legacy handling read-only, cut over new dispatch once, and cover both source and packed runtime recovery paths.

## Migration Plan

1. Confirm the listed acceptance examples during apply and prepare the version-pinned private runtime patch within the project boundary. Prove baseline compatibility, clean packaging, and the single-response primitive before replacing dispatch.
2. Deliver the valid-result vertical slice using the existing controller/publication path. Keep the new adapter private; no public install/configuration step is required.
3. Complete local corrections, one optional same-child reconsideration, cancellation/currentness, and audit recovery. Preserve existing configuration, continuation budgets, callback semantics, and external review behavior.
4. Remove new `cw` registration and main-session inquiry dispatch. Retain old session projections and parsers without granting new authority to legacy records. Do not run old and new decision transports in parallel or fall back to old dispatch after a private-run failure.
5. Update user/architecture docs and affected formal process models, then run focused, packed, broader, and Lean verification with requirement-to-evidence mapping. Leave product acceptance to the user.
6. Rollback is a deliberate package-version rollback, not a runtime mode switch. It cannot resume old private operations or temporary files. Keep retained audit records versioned so old/unknown metadata remains safely historical.
