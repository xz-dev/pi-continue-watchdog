## Context

See `proposal.md` for motivation and capability scope. This is a successor to implemented source at `6c346b2` and `align-unlock-tool-with-reflection-contract`, not a reversal of its guarded decision transport. The latter change is complete but not synchronized to main specs; its pending three-outcome and shared-unlock requirements are superseded only where this change says so. Planning files do not alter the currently authoritative shipped-behavior Lean models.

Source observations relevant to the approach:

| Boundary | Current source | Consequence |
| --- | --- | --- |
| Result authority | `src/decision-tool.ts`, `src/decision-protocol.ts`, current-attempt checks in `src/runtime.ts` | Keep stable minimal `cw` declaration, exact ownership, batch preflight, and terminating result dispatch |
| Timed wait | decision parsing/prompt, controller wait transitions, runtime wait publication/deadlines/completion | Removal must cover the lifecycle, not merely remove a prompt option |
| Continue body | `formatContinueWatchdogEvent` in `src/watchdog-event.ts` | Useful reason is serialized as a previous automated result rather than a next step |
| Unlock publication | runtime creates an unlock event, sends an inquiry fold containing a replacement, then completes the inquiry with the same body | Both publication and inquiry completion must stop recreating model-bound unlock content |
| Normal context | `createDecisionFoldMessage` and `foldDecisionContext` in `src/context-fold.ts` | Existing exact-exchange folding is reusable; do not introduce text heuristics |
| UI | tool renderers show decision/receipt text; shared-message renderer prints a boxed complete body | Hide only owned internal tool presentation; route accepted AI unlock to the existing lightweight status style |
| UI-only state | human unlock already uses `appendEntry`; `commands.ts` has unlock formatting, sanitization, wrapping, and an entry renderer | Reuse the record/rendering convention instead of a widget or new notification framework |
| Publication receipt | `observeBranchPublication` currently recognizes newly observed `custom_message` entries only | A successful `appendEntry` return is not a sufficient replacement receipt |

The package's installed development host is `@earendil-works/pi-coding-agent` 0.85.1. Its public `SessionBeforeCompactEvent.preparation` exposes `messagesToSummarize` and `turnPrefixMessages`; `SessionBeforeTreeEvent.preparation` exposes `entriesToSummarize`. Its current native summary code consumes these preparation objects/arrays after the pre-summary event, independently of ordinary `context` filtering. Plain `custom` entries are excluded by session and branch-summary conversion, whereas `custom_message` entries participate. Branch summarization serializes assistant tool arguments even though it skips tool results, so hiding only a receipt cannot isolate the reason.

The running Pi documentation also describes newer projection features absent from the pinned 0.85.1 type surface. Do not design against an unverified newer API or change dependencies merely to make a mock pass. The existing public preparation seams are the candidate integration; actual native request capture is the first implementation gate.

## Goals / Non-Goals

**Goals:**

- Separate three concerns: runtime authority, human presentation, and model projection. A hidden label must never become an authorization mechanism.
- Preserve accepted continuation as actionable context while making accepted unlock a durable human status rather than an extra conversational request.
- Delete the timed-wait branch, preserving native callback semantics and unrelated idle/retry safeguards.
- Keep source, observable acceptance evidence, behavior documentation, and affected process models aligned one implementation slice at a time.

**Non-Goals:**

- No public proactive unlock alias, dynamic tool switching, new scheduler, classifier, extra rephrasing model call, or generalized history framework.
- No deleting raw session history, rewriting pre-existing summaries, filtering text merely because it resembles a watchdog event, or policing arbitrary later extensions that reintroduce private content.
- No changes to native callback/subagent behavior, manual/shortcut/abort/error-unlock presentation, or the substance of exhaustion and decision-failure events beyond necessary wait removal and safe internal-traffic hiding.
- No host patch, dependency upgrade, global settings change, reload, release, Git operations, or main-spec synchronization in this planning workflow.

## Decisions

### 1. Keep guarded inquiry; reduce its verdict union

Retain one stable root-only `cw` function and all current run/cycle/attempt/call authorization checks. Narrow accepted decisions to continue and unlock. Remove timed-wait parsing, examples, branch selection, staging/finalization fields, controller transitions, timing state, runtime scheduling/publication, elapsed-wait preambles, and waiting hooks as their last production consumers disappear.

Do not broadly remove timers: the fixed ten-second idle fence, activity grace, host retries, and unrelated task-owned waits serve different purposes. Keep the three-response correction limit separate from the continuation budget. An old wait action is a normal invalid decision, not an unlock alias, silent continue, or accepted compatibility no-op. Existing extra-field acceptance does not change merely because `wait_seconds` becomes inert outside the invalid wait action.

Retain legacy readers only for persisted records that must still render. A small legacy duration validity check may remain in that reader; it must not leave a live wait protocol or exported scheduling contract behind.

**Alternative rejected:** Hiding wait only in prompt text leaves callable behavior and timers intact. Reverting to the old public unlock tool reintroduces exactly the authority problem the user rejected.

### 2. Keep callback waiting native and honest

`WAIT_CALLBACK` remains a typed unlock with no timer or retry charge. It is selected only when another actor is actually expected to wake the session and no independent authorized action remains. Callback-capable work is never converted to forced polling.

For work lacking a callback, use an already available authorized monitoring/blocking operation in ordinary work; do not build watchdog sleeping as a replacement. If no authorized actionable next step exists, report the real user or non-user blocker through configured categories. Custom reason lists still replace defaults and do not gain invented meanings.

**Alternative rejected:** Mapping every wait to `WAIT_CALLBACK` can strand sessions forever because the promised wake-up does not exist. Keeping a compatibility timer recreates the feature being removed.

### 3. Continue uses one immutable, action-oriented body

Keep the existing shared custom-message continuation and exact publication/turn receipt path. Change only its fixed formatting and necessary prompt wording. Surface the accepted reason once under an explicit next-step label, rather than a `Previous automated watchdog result` JSON object. Example shape, not a localization mandate:

```text
Continue watchdog · continue · VERIFYING · <original timestamp>
Suggested next step: Run the requested tests.

Automated guidance from pi-continue-watchdog, not a user message or request.
This is not user approval, confirmation, consent, or authorization.
Existing user permission within the current scope is not revoked by this notice.

<effective configured continuation guidance>
<concise actual-delivery and existing-authorization boundary>
```

The same canonical body reaches the human and ordinary model, apart from styling. Keep original accepted text and publication time immutable; do not regenerate on redraw or config changes. No extra model call rewrites the reason. Labeling it a suggestion preserves its plugin origin and fallibility; it never overrides the real user or converts optional work into an authorized task. Fixed wording stays consistent with the repository's English UI; model-generated reasons retain their language.

**Alternative rejected:** Promoting a reason to unattributed imperative text risks making it look like user authorization. Maintaining separate UI and model summaries of continue recreates divergence without meeting an additional need.

### 4. Unlock uses a quiet status plus empty exchange cleanup

Use the existing custom-entry/entry-renderer convention for the human-only status, with typed outcome metadata where needed. The default rendered shape is:

```text
Continue watchdog unlocked · JOB_DONE · Requested analysis delivered.
```

Use a semantic muted/dim theme foreground, no custom-message background box, and existing terminal sanitization/wrapping. Preserve structured timestamp metadata for `/continue-timeline` and audits, not the default line. Do not hide or truncate the stored reason merely to fit one terminal row; this is one logical status that may wrap. Existing untyped human unlock entries retain their presentation.

For AI unlock, complete the exact inquiry with no model replacement. Both the persisted fold marker and the live inquiry completion must have removal semantics: changing only `formatUnlockWatchdogEvent` or the final renderer would leave a second insertion path. Do not put reason-bearing unlock text in a hidden `custom_message`, since `display: false` controls UI, not provider inclusion.

Hide owned internal `cw` call/result presentation, including the partial call header and successful receipt. Keep out-of-phase rejections and ordinary tool errors visible. Use current owned-run/call evidence for that distinction, never trust `args.action` as proof of internal ownership. Invalid owned corrections remain internal; a terminal failure exposes one sanitized diagnostic, not raw protocol.

**Alternative rejected:** A transient `notify` loses durable history; a persistent widget conflates history with current status. Globally hiding every `cw` row hides misuse. Merely rendering the long shared event in gray does not solve context pollution.

### 5. Preserve durable publication semantics across two outputs

AI unlock stops the cycle before publishing its human status, as today. Its publication now has two correlated artifacts: an empty inquiry cleanup fold and a UI-only unlock entry. Track both under the existing exact main claim, controller identity, publication generation, exchange, and attempt. Use a small explicit unlock-publication path or a narrowly extended receipt matcher, not a general transaction framework.

Confirm only newly observed active-branch entries of the correct kind with exact correlation. Existing receipts distinguish confirmed presence, confirmed absence, and unreadable/unknown; preserve that tri-state behavior. A void API return, an old matching record, or a render is not persistence evidence. Retry only confirmed absence and only while ownership is current; never resend on an unknown receipt.

Prefer confirming cleanup first, then the visible entry, then enabling the existing idle-gated `user-ready` intent. Keep the watchdog unlocked if either write cannot be confirmed; never restart work, relock, or inject model text to compensate. Reentrant publication or takeover must neither duplicate the status nor attach an old outcome to a new cycle. Optional audit persistence remains non-authoritative.

Continuation/exhaustion/decision-failure keep their existing shared publication where applicable. `watchdog-continued` keeps accepted reason values. Remove `watchdog-waiting` and `WAIT_SECONDS`; preserve terminal kinds including `DECISION_FAILED`. Listener behavior and human/abort silence remain unchanged.

**Alternative rejected:** Treating `appendEntry` as automatically durable weakens the existing failure contract. Publishing a model-bound fallback when status storage fails directly violates the requested isolation.

### 6. Reuse exact-exchange projection at every native model-input seam

Retain `foldDecisionContext`/`pi-inquiry` for ordinary requests, preserving an active admissible submission until dispatch. Extend only enough to distinguish finalized remove-only unlocks, accepted continuation replacements, and known legacy records. Never filter by `cw` name alone: unauthorized ordinary calls and unrelated messages are not an internal exchange.

For native summary input, adapt the same owned-exchange projection to the public pre-summary preparation data, leaving the host's default summarizer, model selection, token settings, file-operation tracking, usage, cancellation, and persistence in charge. Do not run an independent summarization client. On the inspected host, branch summary holds the original `entriesToSummarize` array reference; a transformation must update that supplied preparation array in place with cloned/projected entries rather than replace the property or mutate stored session records. Compaction similarly requires treatment of both message segments, not only `messagesToSummarize`.

Projection needs full available correlation context to recognize an exchange that crosses a summary cut, but output must remain limited to the host-selected region. Build exact identities from the supplied active branch; do not prepend older or sibling events. Preparation custom-message objects may be newly constructed, so object-reference membership is not an entry identity. Match synthetic replacements by exact namespace/inquiry/attempt correlation, not equal body text. For branch summaries, obtain the full old active branch from the public context before limiting output to the selected entries; folding the selected entries alone cannot recognize a call whose prompt lies outside that selection. Preserve the accepted continuation only at its original fold/replacement position. Handle cases where a prompt is summarized while its fold is kept, or where a tool call and cleanup fall in different segments. Summary-specific projection must not erase still-needed executable content from an active ordinary request or alter stored entries.

**Mandatory first gate:** verify this public preparation route with the actual installed supported host and existing packed fixture, capturing manual compaction, automatic/split-turn compaction, and branch-summary provider requests. A handler mock alone cannot prove the transformation reaches the serializer. Verify event ordering, clone/reference behavior, branch identity, no blank/dangling tool records, and no mutation of raw history. If the host does not reliably honor these public preparations, stop and report the exact gap before changing production code. Do not silently patch Pi, upgrade a dependency, cancel all compactions, rewrite session files, wrap provider internals, or downgrade isolation to ordinary requests only.

Raw logs and exports stay inspectable; already generated summaries and user quotations are not retroactively redacted. Another extension deliberately reconstructing history after this projection is outside the guarantee, matching the existing local-observation authority boundary.

**Alternative rejected:** The ordinary `context` hook does not control native summary serialization on the pinned host. `display: false` does not exclude model content. A new summary engine would duplicate host policy. Newer `context_edit` APIs are not assumed available when the pinned types do not expose them.

#### Gate review checkpoint

The native gate worker created `test/e2e/native-summary.test.ts`; its recorder reaches real native ordinary, manual-compaction, automatic-compaction, and tree-summary requests on Pi 0.85.1. Independent review (`86a46fdf-e3ab-4b17-8bf0-3532934699f2`) accepted that recorder evidence for task 1.2 but returned **BLOCKED** for task 1.3. The six original tests passed; two added native counterexamples failed:

- Manual compaction lost unrelated extension content and accepted continuation because the candidate projection compared separately created objects by reference. Its body-text replacement matching also cannot distinguish identical continuation bodies.
- Tree summarization leaked a finalized `cw` call and its reason when the selection omitted the prompt. Required owned-traffic split-prefix cases, exact boundary comparisons, raw-content immutability, and real dispatch preservation also lacked sufficient evidence.

Those defects were repaired without patching Pi or weakening A7/A8. Independent closure review `20676069-c28c-4a8e-91b1-ac560c2e569d` approved task 1.3 on fixture SHA256 `3b0321964153b1cd3d9d077eb9c1664c7bf069c859157f0b769f1674723c41f3`: exact host-selected entry intervals replaced identity guessing, and continuation emission is restricted to selected replace-fold positions. The native suite passed 13/13 alongside unchanged reviewer counterexamples, earlier collision/cut/tree cases, and real packed dispatch. Raw evidence is retained under `/var/tmp/native-summary-parent-review-irrLfG/evidence/`; the current task checkpoint records the review artifact. Production implementation may now proceed under the user's resumed apply request. This is prerequisite seam approval, not delivery of production isolation. Register the native regression suite in integrated test execution during implementation; current standard scripts still do not run it automatically.

### 7. Preserve compatibility without keeping live wait machinery

Old events retain readers and exact-exchange cleanup but are not reinterpreted as new control input. No timers are restored on resume. Recognizable uncompacted legacy AI-unlock content can be excluded from new model projections without rewriting its stored human record; already generated summaries are not scrubbed. Keep unknown or malformed unrelated records unchanged rather than guessing ownership.

Document the breaking removal of timed-wait decisions and waiting hooks. Do not migrate user configuration or external notification settings automatically. Retain existing configured prompts and validation; stale custom guidance cannot override the fixed two-outcome validator.

Main-spec synchronization is a separate operation. Before it is authorized, plan against the union of the predecessor's guarded behavior and this successor's deltas. A future reconciler must not blindly archive both ADDED definitions of `decision-response-contract`, restore predecessor wait requirements after applying this change, or introduce the pending `watchdog-waiting-hook`. Preserve unrelated predecessor changes such as classifier removal and delivery-boundary fixes. The stale Purpose text in `terminal-outcome-gate` can be corrected only in that separately authorized main-spec operation.

### 8. Inherit mature function-era permission checks, not XML-era wording

The user explicitly requires the prompt optimization to reference the first function-generation and its later anti-reconfirmation improvements. This is part of the current change, not an optional future enhancement. Use the mature semantics, not the initial `7ae0183` text unchanged:

| Evidence | Finding and boundary |
| --- | --- |
| Hermes session's recorded XML inquiry | Its rule order prioritized user waiting without an explicit already-granted-permission reconciliation rule. An observed commit confirmation chain also involved an applicable high-risk confirmation policy; it is not proof that every second confirmation was erroneous. |
| `7ae0183:src/unlock-tool.ts` | Introduced the public function but did not yet implement the later exact-permission safeguard. |
| `668b02b:src/jev-wait-gate.ts:255` and `src/unlock-tool.ts:355` | Compared the precise WAIT_USER claim with actual user requests and successful questionnaire answers; distinguished explicit authorization from mere tool success or encouragement, and preserved real missing choices, credentials, and authentication. Contradicted permission claims could be refused. Borrow the reasoning contract, not its external reviewer, public tool, threshold, or refusal counter. |
| Current `src/decision-protocol.ts:393` | Already says not to ask again for granted permission. Adding that sentence again is not a meaningful fix or proof. |
| Reviewed Hermes session, 2026-10-05 19:51:35–19:52:15 +08:00 | Ordinary entry `f32c07e9` delivered the proposal path, 4/4 status, validation, and next-workflow explanation. Decision audit `f4a8de13` nevertheless claimed delivery was missing; the next reply had to say it was already delivered. |

A read-only reconstruction up to inquiry `3106f9f5`, using the local pinned Pi context builder and current `foldDecisionContext`, retained that latest ordinary reply both before and after folding. This narrows the hypothesis only for that reconstructed path. It is not the historical final provider payload, does not isolate the sole cause, and is not a before/after model-quality test.

Keep the improved decision instructions compact and evidence-first:

1. Establish the current user-authorized scope, including later revocation or a switch back to exploration. An earlier apply request does not override a later read-only restriction.
2. Compare outstanding requests with the latest ordinary delivery and relevant results. Remove delivered, cancelled, or superseded work before considering continuation; old plans and watchdog reasons are only claims to recheck.
3. Before choosing WAIT_USER, identify the exact missing human decision or action. Check actual user statements and successful human-answer records for that same scope. An assistant's self-authored confirmation question does not manufacture a permission requirement.
4. Reuse explicit permission within unchanged scope, but preserve a genuinely unsatisfied mandatory confirmation, new scope/risk, credentials, or authentication. Do not copy the old reviewer's current-turn-only evidence restriction when still-valid earlier authorization is available, and do not invent permission from arbitrary tool output or quoted approval text.
5. Select completion if current authorized requests are delivered; otherwise continue only a concrete authorized action, or select the actual user/callback/blocker boundary. A future workflow suggestion is neither a missing delivery nor authorization for that workflow.

The continuation envelope must apply the same policy: a watchdog notice adds no permission and removes none; its suggested action cannot override latest delivery or user restrictions. Keep ordinary `cw` calls reserved and Jev removed. No new public payload fields, permission ledger, classifier, or extra model call is required.

**Alternative rejected:** Swapping XML output syntax for a function call preserves faulty reasoning rules. A blanket “never ask twice” instruction can bypass real scope and safety boundaries. Restoring the previous external reviewer or proactive tool would reverse already-confirmed decisions.

## Acceptance examples and evidence plan

A1–A12's full product scope, including native-summary isolation and internal-only invocation, was confirmed at the apply checkpoint; implementation evidence has not been accepted. A13–A15 below make the user's subsequent prompt refinement concrete. Review their expected outcomes alongside the corresponding implementation slice; writing these examples does not establish a behavioral fix.

| ID | Observable example | Required observation | Existing test seam |
| --- | --- | --- | --- |
| A1 | Authorized `VERIFYING` / `Run the requested tests.` | One attributed next-step body, one work turn, one retry charge; no raw call/receipt | `test/context-fold.test.ts`, `test/runtime.test.ts`, packed provider capture |
| A2 | Authorized `JOB_DONE` / `Requested analysis delivered.` | One gray wrapping status, no timestamp/box/boilerplate; next request has no control exchange or unlock text | `test/commands.test.ts`, `test/load.test.ts`, packed fixture |
| A3 | Callback task pending, no independent work | `WAIT_CALLBACK` unlock, no watchdog deadline/polling/retry charge; native callback behavior preserved | controller/runtime and cross-process tests |
| A4 | Old `action: wait, wait_seconds: 60` | One invalid response, no waiting effect; three invalid responses stop automatic decisions | protocol/controller/runtime tests and packed fixture |
| A5 | Ordinary run copies correct unlock payload | Visible reserved rejection; no unlock, retry change, or ordinary-tool termination | existing unauthorized packed test |
| A6 | Status append fails or branch receipt is unreadable | Remain unlocked; no duplicate/fallback/hook; retry only confirmed absence while current | runtime publication seams |
| A7 | Manual/automatic compaction, including split exchange | Actual summary request has ordinary work and continuation guidance but no finalized control traffic/status | native host provider capture |
| A8 | `/tree` summary leaves completed exchange | Same exclusion, correct target/branch evidence, no raw-history mutation | native branch-summary fixture |
| A9 | User takeover, stale call, duplicate settlement | No old outcome, late work, duplicate status, or hook in new cycle | runtime/cancellation/cross-process tests |
| A10 | Resume legacy wait/unlock history | Readable history, no replay/deadline; recognized raw unlock/control content not reintroduced | context-fold/commands/packed resume tests |
| A11 | Final network error or human abort | Existing distinct automatic error/abort behavior, no inquiry for that terminal result | abort-outcome, terminal runtime and packed tests |
| A12 | Custom prompts, reason lists, Unicode/control text | Existing limits/precedence; no duration bypass; safe narrow-width rendering and unchanged stored reason | config, load, commands tests |
| A13 | Exact action authorized by user text or a successful questionnaire answer; assistant asks again | Same-scope permission is recognized; no new WAIT_USER solely from the assistant question or plugin disclaimer | sanitized conversation fixture, actual inquiry/continuation input capture, semantic case review |
| A14 | Latest reply already delivers proposal path/status/validation; stale reason says missing | Completion, not another delivery-only continuation or automatic apply | bounded Hermes-derived fixture, projection/input capture, semantic case review |
| A15 | New scope/risk, distinct mandatory confirmation, missing authentication, or later exploration-only restriction | Genuine boundary preserved; prior permission neither bypasses it nor authorizes resumed mutation | paired counterexample fixtures and semantic case review |

Use the existing Node/tsx runner and fake/provider-recording fixtures; no new framework. Prove the chosen failing behavior before each production slice, then its passing evidence, and perform a small targeted negative control so the central isolation/timer test demonstrably detects regression. Do not turn every formatting word or private field into a snapshot assertion. One native test exercising an actual serialized request is stronger than several equivalent handler mocks.

For A13–A15, keep the two evidence layers separate. Offline checks can prove that real prompt assembly and context projection preserve the decisive user answer/latest ordinary reply and the intended fixed guidance. Review the complete constructed decision input against each expected outcome, including the counterexamples; neither checking for `never ask again` nor scripting a fake provider to return the desired verdict proves that a real model reasons correctly. Report model-level efficacy as unmeasured unless actual bounded before/after model-output evidence is obtained under separately authorized test conditions. Do not make live or chargeable calls as an implicit consequence of this planning update, and do not claim a reproduced symptom establishes a single root cause.

Runtime verification commands during implementation remain `npm run check` and `npm run test:e2e`. Keep temporary build/pack artifacts under `/var/tmp`, not `/tmp`. Gate native TUI specifics through existing renderer tests plus a narrow manual smoke check when a real TUI is needed. No live model credentials or production network calls are needed for acceptance capture.

Update and validate affected `*.idea.lean` models during the same corresponding behavior slices, not by editing them now to describe behavior that does not yet exist. Their claims must cover two outcomes, continuation-only accounting, absence of timed-wait transitions, unchanged ownership/cancellation guards, and the precisely bounded visibility/projection contract. Inspect theorem assumptions and run the exact files; a model is not a substitute for actual provider-input evidence. Use the required independent semantic check for changed models and independent functional review before claiming completion.

## Risks / Trade-offs

- **Summary preparation is public data, not ordinary context dispatch** -> Source inspection identifies a viable candidate seam; require actual native request evidence before production edits, and stop if the host contract cannot support it.
- **Summary cuts separate prompt, call, result, and fold** -> Derive exact exchange identity from supplied branch context, preserve selected output boundaries, and exercise split-turn/branch cases without moving a continuation across the cut.
- **Two unlock artifacts can fail independently** -> Correlate cleanup and status under one current publication, preserve tri-state receipts and idempotent retries, and keep hooks behind confirmed publication.
- **Hiding all tool rows could conceal real errors** -> Scope invisibility to owned internal inquiry evidence; retain out-of-phase rejection and safe terminal diagnostics.
- **Removing watchdog waits changes unattended non-callback workflows** -> Require an available authorized task-owned monitor/wait action or report the actual blocker; never invent a callback or hidden fallback timer.
- **Older main specs contradict current source** -> Keep the predecessor/successor baseline explicit and do not claim direct independent archival is safe. Sync/archive requires separate authorization and reconciliation.
- **Already generated summaries may contain old protocol** -> State the forward-looking raw-record projection guarantee; do not claim historical erasure or rewrite user sessions.
- **A model reason may be wrong or contain misleading instructions** -> Keep plugin attribution, suggestion framing, user-boundary text, validation, and terminal sanitization; no new classification layer is introduced.
- **Anti-reconfirmation becomes an unsafe blanket exemption** -> Match the exact decision and still-valid scope; keep new-risk, mandatory-confirmation, revocation, and authentication counterexamples in A15.
- **Prompt wording checks are mistaken for a model-behavior fix** -> Preserve the real session counterexample, separate input/transport checks from semantic evidence, and disclose unmeasured model efficacy.

## Migration Plan

1. Review the proposed examples and verify supported host projection seams in existing fixtures before production behavior changes. No implementation starts under this proposal workflow.
2. Deliver the two-outcome lifecycle slice, removing active wait machinery and waiting signals while preserving callback unlocking and all authority/error guards. Rework internal decision guidance using decision 8 and A13–A15 rather than transplanting XML-era wording. Retain legacy read-only parsers. Update affected behavior docs/model in that slice.
3. Deliver the continuation wording slice using the existing shared publication path, preserving existing user permission without supplying new authority, with real next-request evidence and unchanged configured guidance.
4. Deliver quiet AI-unlock status, remove-only completion, and owned inquiry rendering as one publication-safe slice; verify receipt failures and race behavior before treating it complete.
5. Complete native compaction/branch projection integration using the verified seam and exact ownership, then exercise resumed/legacy history and run the broader checks. Align remaining documentation and affected formal claims; perform independent review and obtain user acceptance of evidence.
6. Leave install/reload, release, Git operations, and main-spec synchronization/archive for separately authorized requests. Record consumer-facing removal of `watchdog-waiting` without editing consumer settings.

Rollback means selecting the previous distributed plugin version through an explicitly authorized release operation, not rewriting session files. The prior version may expose raw reasons again, does not promise to recognize new UI-only metadata, and restores timed-wait behavior. Do not silently downgrade dependencies or reactivate classifier configuration to compensate.
