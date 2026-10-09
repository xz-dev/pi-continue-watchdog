## Context

See `proposal.md` for motivation and the two delta specs for behavior. The current runtime stages a valid response in `finalizeActiveDecision`, then qualifies and commits it in `deliverPending`. The optional review belongs before `commitResponse`, not after an unlock has changed controller state or a continuation has started. The existing default path and already archived implementation remain the baseline.

The user selected AI-unlock-only review, one main-model reconsideration on a definite challenge, and original-unlock fallback when review cannot complete. Context design was delegated to the implementer. The recorded TODO-audit research supplies two relevant principles: Jev is a macro reviewer of results and broad process, not an executor; identical context/question pairs should not be paid for repeatedly. Its later context-fidelity repair demonstrates that old classifications and processing frontiers are not substitutes for facts. These are input and control-flow lessons, not measured model-efficacy results.

This design is needed because the change crosses runtime, protocol, configuration, privacy projection, and an optional service boundary. It does not copy the TODO board, task lifecycle, `auditBrief` convention, rolling business ledger, or automatic dependency installation.

## Goals / Non-Goals

**Goals:**

- Keep the review branch small: one macro review operation and, only for a definite challenge, one main-model reconsideration inquiry.
- Make source projection, candidate/reviewer authority, cancellation, and incomplete-review behavior testable at observable request/publication boundaries.
- Reuse existing native-session, qualification, correction, publication and shared-service facilities rather than adding a parallel framework.

**Non-Goals:**

- Auditing `continue`, changing manual/abort/error unlock, independently verifying code or tool-log claims, or certifying that model reasoning is correct.
- New raw-history export, summary/retrieval model, TODO workflow, ordinary work during a decision, provider client, model-selection UI, or unbounded reviewer/main-model negotiation.
- Deployment, installation, live-model trials, main-spec synchronization, or changing product/Lean files during this planning capture.

## Decisions

### D1. One default-on setting at the existing pre-commit seam

Add `unlockReviewEnabled: true` through existing configuration loading/validation; `false` restores the previous path with no lookup. When the service is unavailable or the review cannot complete, show a warning notification and release the original unlock; never interrupt the session. A missing/incompatible service warns once per runtime; other incomplete reviews warn each time. A missing or invalid value retains existing lower-precedence/default behavior. Do not revive `jevWaitCheck`. Check eligibility before service discovery: root-owned current valid initial AI unlock, feature enabled, no prior review/reconsideration for this logical decision, and normal qualification satisfied.

Use call-time `getJudgmentService()` discovery and require `version === 1`, `reviewVersion === 1`, and callable `review`. Do not call a provider availability probe, install/load the service, switch models, or fall back to `judge()`/HTTP. A missing capability is an incomplete review and can be rediscovered at the next normal eligible decision. The shared service owns backend selection/authentication and native acceptance policy; the consumer does not numerically re-gate an LLM answer. Stay on the sealed review-v1 contract (service `b54611d`). No managed-review API exists; this change neither requires nor emulates one.

Hold the immutable pending candidate while the review is in flight. Repeated settlement observes that same pending operation, not another request. All outcome commits remain in the existing guarded publication path. Local association uses the existing claim, generation, session/branch, exchange and attempt identities; service-ledger appends alone are not new user evidence. No new digest-based execution-authorization gate is introduced.

**Alternative rejected:** intercepting after unlock requires relocking/rollback; auditing every outcome expands the chosen scope; a mandatory package dependency would break operation without the service.

### D2. A full permitted macro snapshot, not the primary model's supplement

Build an immutable snapshot from the host-selected `buildContextEntries()` material for the candidate's current attempt. Reuse source association and exact owned-control recognition before the excerpt/selection stage in `src/review-context.ts`; do not reuse its already shortened rows as complete external evidence. The primary model's 8,000-code-point supplement and its native conversation remain unchanged.

The macro snapshot contains, in source order:

- Full public user text and ordinary assistant reports. Keep earlier effective requests/deliveries; neither the last lock boundary nor the latest reply is a semantic completeness boundary.
- Eligible public custom text with producer/role labels; prior opinions are opinions, not user permission or independent evidence of their own correctness. Owned inquiry/control content is excluded.
- Host-retained compaction/branch summaries labelled derived. Do not append their summarized-away raw bodies, sibling records, private extension state, or hidden thinking.
- Tool/shell activity envelopes: tool name, call/result identity, order and returned/error/cancelled/pending/unknown status. No ordinary arguments, commands, file contents, result bodies or raw logs. A successful envelope proves neither completion nor approval.
- `ask_user_question` reply text as specified in D3, plus an unsupported-content gap for public media that cannot be exported.

Preserve source identities and current chronology. Do not keyword-rank, take a last-N suffix, filter only the final user message, or infer supersession from report age. If relevance is uncertain, retain the permitted public material rather than invent a complete smaller scope. Known provider secrets are redacted by the shared service's existing mechanism; the watchdog adds no sanitizer of its own. Context-excluded/private bodies and identifiers are not exported even as omission metadata. Unsupported public media is a gap; a known gap makes the review incomplete without calling the service.

The candidate `action`, `reason_type`, and `reason_content` are a separate object labelled as the claim being reviewed. Do not turn the reason into a completion fact. The question asks whether stopping automatic work on the stated basis is supported, not whether every task is finished. Configured reason labels do not acquire a new fixed meaning table.

**Alternative rejected:** forwarding the current supplement both loses older facts and exposes ordinary tool payloads that this macro reviewer does not need. Forwarding raw JSONL ignores the host's branch, privacy and compaction boundaries.

### D3. Keep questionnaire answers; ordinary text stays primary

Most user decisions are ordinary text messages, already kept in full by D2. `ask_user_question` is an extension tool, not a Pi-native channel, but its results carry public question/answer text (`details.answers` and `cancelled`). Blanket tool-body reduction would erase those answers.

For a successful `ask_user_question` result, keep its question/answer pairs (or its public result text when structured answers are absent) as a tool row with the existing call/result provenance. Cancelled or error results keep only their status. No origin verification, cross-checking or special gap is added; the host-saved record is taken as-is and stays attributed to the tool rather than rewritten as a user message. Other tools remain envelopes.

**Alternative rejected:** sending every tool body violates the macro/privacy boundary; dropping questionnaire answers loses real user scope. Per-tool trust machinery adds complexity without serving the review's purpose.

### D4. One factual question, shared capacity/reuse, honest limits

Use `ReviewService.review` with one stable Choice question whose accepted choices are `supported`, `challenged`, and `insufficient_evidence`. Its rubric checks the candidate and reason against user scope, delivered reports and the stated stopping basis, treats reports/summaries/opinions according to their provenance, and does not regard absence from a partial input as absence in the session. `challenged` requires an affirmative basis for questioning the candidate, not merely missing detail. Consume only the complete required accepted final answer; unknown/malformed answers, non-stop results, unresolved required work, or unavailable observation capability mean incomplete review. Do not invent a textual critique when the service returned only a classification.

For this first version, supply the complete necessary macro snapshot as named fixed request state alongside the candidate. Serialize each source body once. Do not introduce a rolling `projectStage` consumer, a separate factual ledger, or label-only cross-fragment memory for this single global stopping question. The shared service remains responsible for capacity admission, exact-input cache, provider transport/retries, branch-aware history and accounting. If the indivisible necessary factual state cannot fit, use incomplete-review fallback, not consumer cropping or another summarizer. This deliberately does not promise that every arbitrarily long effective conversation is reviewable.

Pass no `timeoutMs` and run no consumer-owned outer timer: the sealed service (`b54611d`) defines its own bounds per backend — one whole-call deadline for the native classifier (default 60 000 ms), a per-request streaming-inactivity window for LLM emulation (Pi `httpIdleTimeoutMs`, default 300 000 ms) — and documents that consumers should not add their own. These bounds are service-owned, not a whole-review latency promise: under LLM emulation sustained activity can keep the review waiting without a fixed total upper bound. Service deadline/inactivity expiry returns `stopReason: "error"` and is treated as incomplete review. Link an `AbortController` to the existing decision lifecycle so manual unlock, takeover, branch/session replacement and ownership loss abort the request immediately (`stopReason: "aborted"`); the service guarantees late results are never published after abort. The service bound does not restart per logical decision, rearm idle qualification, or schedule another review. No additional user timeout/threshold/model knobs are introduced in this change; the user configures the service's `timeoutMs` override there if a different bound is wanted. The user explicitly accepted no fixed total wait limit (`接受无固定总时限`) with immediate manual unlock/takeover as the guaranteed escape.

Do not add timestamps or local exchange/attempt counters to the semantic request merely for correlation; keep those in local/native association. Candidate text, actual source content/order/roles, meaningful source identities, gaps and a stable projection/rubric revision define the factual input. Leave exact reuse to the service; do not force `fresh` on every observation or relabel changed facts as the same request. One API review can involve multiple transport attempts: use `diagnostics.attempts`, observation coverage, and presence-aware usage rather than interpreting `reuse.sent` as request count or missing usage as zero.

**Alternative rejected:** reproducing TODO audit's multi-task rolling/projection machinery adds business state this consumer does not need. Default sequential labels/checkpoints alone cannot guarantee preservation of a global unlock condition. Reusing the complete necessary input or declaring it inadmissible is simpler and truthful.

### D5. Separate one semantic reconsideration from format correction

Use this bounded flow:

```text
valid initial continue --------------------------------> existing publication
valid initial unlock -- disabled ----------------------> existing publication
                     -- supported ---------------------> existing publication
                     -- incomplete --------------------> existing publication
                     -- challenged --> one reconsideration inquiry
                                                  |
                                                  +--> valid result --> existing publication
                                                  +--> format failure --> existing decision-failed path
any stale/takeover/cancel edge -------------------------> existing invalidation
```

A definite challenge supersedes the initial candidate without committing or publishing it. Feed the candidate and the service's discrete objection back through a separately owned decision inquiry. State that the reviewer may be wrong and that the main model must recheck source evidence, preserve user permission boundaries, and use the same single `cw` result contract. Do not ask for ordinary work or an extra visible checklist. Correlate the replacement inquiry to the same logical decision, retain the consumed-reconsideration flag across its format corrections and deferrals, and make old callbacks incapable of dispatching another round.

The reconsidered model can keep unlock or choose an authorized continue. Neither is reviewed again in that logical decision. There is no new `cw` field or user finish/confirmation step.

**Bound chosen for this plan:** one initial inquiry plus at most one semantic reconsideration inquiry. Each retains the existing three consumed protocol-response limit and no fourth format response; the combined ceiling is therefore six consumed main-model decision responses, not six guaranteed provider requests. This separates a business recheck from malformed-response correction without falsifying either count. Review transport attempts are accounted separately. Neither inquiry nor review spends continuation budget; only the eventual accepted durable continuation does.

An unavailable reviewer never opens the reconsideration inquiry. Once a genuine challenge has superseded the initial candidate, failure of the replacement inquiry uses the existing decision-failed behavior; it is not retrospectively relabelled as reviewer unavailability to release the old candidate. An invalidated lifecycle creates no reconsideration or fallback unlock.

**Alternative rejected:** treating disagreement as malformed JSON mixes business judgment with protocol errors. Repeated review of the replacement creates a negotiation loop. Directly flipping unlock to continue gives the reviewer execution authority it was not granted.

### D6. Preserve cancellation, publication and native-session history

Recheck the existing live fences before and after awaited service work and before replacement inquiry dispatch or outcome commit. Manual unlock/abort/takeover remains immediate and aborts or invalidates the review; late support, failure, deadline, progress or diagnostic callbacks cannot affect replacement work. Optional status/history operations must also tolerate synchronous reentrant cancellation. Keep canonical continuation/unlock receipts and guarded rollback as the outcome authority.

Append one versioned `pi-continue-watchdog:unlock-review` custom entry per review to the owning session: exchange/cycle linkage, projection version, supported/challenged/incomplete outcome with reason, service backend/model, attempts and available usage (missing values stay missing), and the replacement exchange when a challenge opens one. Do not duplicate service cache/checkpoint machinery or store private thinking. Append failure is a bounded diagnostic, not a prerequisite, relock, provider call, budget charge or fallback file.

On reopen, read records as history only. Do not restore pending review/reconsideration execution or locks; Pi's session tree decides which records are on the current branch. The existing quiet-unlock presentation remains the outcome; review unavailability uses the D1 warning without a new user questionnaire.

**Alternative rejected:** a sidecar or separate mandatory review-write receipt duplicates storage/authority. Trusting a saved reviewer verdict after restart would restore an action without current qualification.

## Risks / Trade-offs

- **Both models can be wrong** -> describe this as a macro consistency review, not execution verification or proof of semantic completeness. No claim that unlock-only review fixes false continues.
- **An authored report can misstate a tool result** -> label it reported. Tool envelopes are not independent result verification; necessary unavailable detail yields incomplete review.
- **Questionnaire answers are tool output** -> keep them attributed to the tool; the reviewer still weighs them against ordinary user messages, which remain the primary source.
- **Large necessary macro state can exceed the reviewer window** -> retain the factual contract, report incomplete, and release only a still-current original candidate. Do not claim splitting or caching removes the required factual floor.
- **Default-on review adds latency/cost and can induce an unnecessary recheck** -> one business review, at most one semantic reconsideration, service-owned timeout bounds (native: whole-call deadline; LLM: per-request inactivity window, no whole-review total bound), exact reuse and observed attempts. Manual unlock/takeover aborts immediately. No paid experiment or savings claim is part of implementation acceptance.
- **Awaited work or diagnostics reenter cancellation** -> exercise existing generation/ownership/publication guards around every external boundary and ensure no stale fallback effect.
- **Default-on integration becomes a hidden dependency** -> an absent service only warns and unlocks normally; test no lookup when disabled/continuing, the absent-service warning, and no auto-install/provider fallback.

## Migration Plan

1. Keep this change as planning artifacts for user review. A later explicit apply request is required before product or formal-document edits.
2. Implement configuration/projection and the narrow service adapter against existing seams with offline capturing fakes; then integrate the bounded pre-commit branch and reconsideration lifecycle.
3. Run `npm run check` and the packed e2e suite once; update README, behavior documentation and the affected Lean model once and check the exact Lean file.
4. Run strict OpenSpec validation. Retain failing receipts rather than converting retries into claimed passes.
5. Installation, activation, publication, archival and real-model efficacy studies remain separately authorized. A future rollback sets the flag to `false` or restores the prior code while leaving native historical records intact; neither is executed by this plan.

## Source Notes

- Watchdog: `src/runtime.ts` (`finalizeActiveDecision`, `deliverPending`), `src/review-context.ts`, `src/decision-protocol.ts`, and current decision/context specifications. Plugin-local observation is not certification of later provider transformations.
- TODO audit: sibling `pi-jev-todo-audit/context.ts`, `rolling.ts`, `shared-review.ts`; `openspec/changes/improve-audit-context-fidelity/{design,evidence}.md`; and `openspec/changes/use-shared-judgment-service/design.md`. Its verified packet mechanics do not establish this candidate's model quality.
- Shared service: sibling `pi-llm-as-jev/client/judgment-client.ts` and README review/capacity/accounting contracts, checked against current `src/service.ts` stage handling.
- Coordination checkpoint, 2026-10-08 (sealed): service HEAD `b54611d` on `origin/master`, installed copy at the same revision, canonical client SHA-256 `6be4470b…cca737`. Public contract is `version: 1` + `reviewVersion: 1` + `review()`; `managedReviewVersion`/`reviewManaged` does not exist and is not planned for consumption. `projectStage`/`checkpoint`/`onProgress`/`cache` are deprecated and unused here. `capacityVersion: 1` / `describeSelection()` is available read-only. The service's `manage-review-context-and-runtime` change is archived. Earlier checkpoint (`d34cd611`, 29 pending tasks) is superseded.
- Original macro-review/caching discussion: TODO-audit session entries `77b1e04c` and `bce67ecf`. Current watchdog choices supersede the earlier deferral for planning only; raw private sessions are not copied into these artifacts.
