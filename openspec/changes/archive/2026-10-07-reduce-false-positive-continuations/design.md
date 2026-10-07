## Context

See `proposal.md` for motivation and `README.md` for the measured evidence and its limits. The pilot supports trying a bounded source view plus a concise delivery assessment before the verdict. It did not reproduce the historical false continuation reliably, and it does not prove general semantic completeness.

Current source already provides the useful boundaries:

- `buildDecisionPrompt` in `src/decision-protocol.ts` appends the fixed three-argument contract. Its examples currently lead with `action`; parsing does not depend on JSON property order.
- `openDecision`, `sendDecisionPrompt`, response capture, and settlement in `src/runtime.ts` already correlate exchange, attempt, run, claim, generation, and process-domain activity.
- `DecisionAuditEntry` already lives in the owning session as a hidden custom entry. Its current version records a normalized response but has no review-input link, and append failures are swallowed.
- `src/context-fold.ts` and `src/summary-projection.ts` already distinguish exactly owned internal exchanges from ordinary content. These rules must be reused, not replaced with text matching or `stopReason` heuristics.
- Public `ReadonlySessionManager` exposes `getBranch`, `getLeafId`, `getEntry`, `getSessionId`, `getSessionFile`, and `buildContextEntries`. It does not expose the concrete manager's `buildSessionContext` method. Native custom entries are not model messages.

There are two different histories: active ancestry for audit recovery, and native compaction-aware context for a new inquiry. Recovering an old audit must not reinsert raw pre-compaction conversation into model input.

## Goals / Non-Goals

**Goals:**

- Make delivery evidence easier for the existing primary model to compare without a new model request or a replacement conversation.
- Preserve meaningful, inspectable review history across restart and fork while keeping execution authority process-local.
- Distinguish an explicit request to report a future command from permission to run that command.
- Keep source selection deterministic and independent of expected verdicts, English keywords, or assistant-authored task lists.

**Non-Goals:**

- A semantic completion oracle, persistent task registry, universal requirement census, or proof that all requests were understood.
- New result arguments, mandatory citation validation, a second reviewer, model/provider changes, a new timer, or a user-maintained checklist.
- Editing Pi, rewriting real sessions, changing normal user work, or reopening the completed abort-notice implementation.
- New live experiments, installation, release, commit, or push. The experimental runner remains outside the product.

## Decisions

### 1. Put a bounded evidence view inside the existing inquiry

Use one small pure projection/record helper (`src/review-context.ts`) with the existing fold/provenance helpers. Keep orchestration in `src/runtime.ts`; do not introduce a service, repository abstraction, or dependency.

Build new model-facing rows from `buildContextEntries()` and the same exact-ownership projection used by normal context folding. Keep the original effective model conversation intact. The view labels each excerpt as a real user message, ordinary assistant output, tool result, native summary, or automation opinion. Known plugin messages represented as user-role transport are not user authorization. Partial or aborted ordinary output stays ordinary evidence of what was actually emitted, not proof that work completed. Owned control responses are excluded by correlation, not by empty text or stop markers.

Each row has its native entry ID, provenance, excerpt, and omission indicator. No task-complete or permission-granted boolean is inferred by the builder. Tool success and quoted approval are not promoted to human permission. Summaries retain their derived provenance; they are not fresh user requests.

Use a fixed initial ceiling of 8,000 Unicode code points for the entire supplemental view, including labels. Bound individual excerpts to 1,600 code points with labelled head/tail omission. Prioritize the latest genuine user message, latest ordinary reply, and two recent tool results; then add earlier user and ordinary-answer rows in recency order while space remains. A short automation-opinion row can be included last, explicitly non-authoritative. Render retained rows in source order. Record omitted row counts and tell the model that omissions are not proof of absence and that earlier requests and deliveries remain in the native context. No configuration knob or keyword selector is needed for this first slice.

The pilot selected all user entries in its small fixed fixtures and threw if its supplemental size limit was exceeded. That is not acceptable production overflow behavior. Deterministic prioritization and graceful omission are therefore an integration change requiring offline coverage; the pilot's semantic results must not be advertised as validation of every overflow case.

**Rejected:** copying the whole long history into another evidence packet, replacing the native conversation with a generated summary, or maintaining a model-authored task ledger. These increase cost or introduce another fallible source of authority.

### 2. Reuse `reason_content` for assessment before verdict

Revise the fixed guidance and examples to request `reason_content`, then `reason_type`, then `action`. The concise reason compares the effective explicit deliverable components with actual delivered content/results, identifies any missing component, and names one immediately executable authorized action when continuing. It is an observable evidence summary, not a hidden chain-of-thought request.

Keep the 500-code-point guidance target and existing 1,000-code-point acceptance limit. Keep configurable reason labels, the open `cw` declaration, both accepted actions, correction limits, and extra-field treatment unchanged. Old action-first calls remain valid; key ordering is guidance, never a new rejection rule.

The comparison must consider relevant earlier ordinary answers, not only the latest reply. A missing requested command in a planning report calls for reporting it, not executing it. A command already supplied for a future workflow does not create implementation work. Cancelled, superseded, deferred, and never-requested work stays excluded.

**Rejected:** the pilot's extra structured-reference contract as a default. It added protocol surface without demonstrated incremental benefit in the short tests; quote matching cannot prove semantic completeness.

### 3. Attach review data to records already written by the inquiry

Reuse the native records the runtime already produces. Do not introduce a `review-context` entry type, a separate review journal, or another append/acknowledgement cycle.

| Existing record | Review responsibility |
| --- | --- |
| Hidden inquiry marker, appended before dispatch | Add nested versioned review metadata: projection-policy version, non-label source-head ID, effective compaction boundary, selected source IDs/provenance, source digest, and omission counts. Retain its existing exchange/attempt correlation. |
| Native owned inquiry message | Contains the exact bounded view and fixed guidance actually assembled for this attempt. Its existing correlation links it to the marker; do not duplicate the full prompt in another record. |
| Hidden decision audit | Retain the normalized response/reason or safe validation error. Add review association using the existing exchange/attempt identity and available native record IDs; preserve legacy entries without review metadata. |
| Canonical continuation or quiet unlock record | Remains the evidence of published outcome, distinct from an observed response. Reuse the established association/publication path rather than creating a second commit receipt. |

Nested metadata is optional when reading old records, never fabricated during recovery. New normal-path reviews populate it. A response audit is not proof that work started. An interrupted inquiry may have a marker and prompt but no response; recovery reports that partial history and does not resubmit it. If a redundant audit is absent but the correlated canonical outcome exists, it can supply the published verdict without inventing an invalid-attempt history.

Capture origin session ID only as provenance, not inherited authority. Use immutable existing entry timestamps and exact correlation; avoid copying the whole conversation, provider credentials, headers, or private provider thinking. Data stays in the same native session JSONL and travels with its branch. No rewrite, backfill, sidecar, or task registry is needed.

**Rejected:** treating an old reason as a trusted completion cache, or making a separately persisted review bundle a new prerequisite for work. The former reintroduces stale opinions; the latter adds an unmeasured storage failure mode without being required for same-session persistence.

### 4. Recover history by ancestry, not by file chronology

Read hidden review records from `getBranch()` for the host-selected leaf. `getEntry` can resolve a reference only after membership in that ancestor path is established; a globally resolvable sibling entry is not eligible evidence. Choose recent records by their position on that path, not timestamps or the physical last JSONL record.

Reopen and fork preserve historical inputs/results when their records and referenced sources are retained on the selected path. A fork's new session ID does not invalidate a valid inherited record by itself. Native fork creation can remove/recreate labels and re-chain parents, so label IDs and a byte-for-byte parent-chain hash are unsuitable as the durable source identity. Use retained non-label IDs plus source content/projection identity.

Historical validity is separate from eligibility for a new inquiry. Later user work or compaction can make an old review unsuitable for reuse while leaving it valid audit history. Rebuild the current view rather than replaying its verdict or injecting archived excerpts. Compaction-aware new views respect the native retained entries/summary; raw pre-compaction audit material remains available only as history.

At startup and before each review, resolve against the actual current host path. Never select a branch to make a stored review current. In particular, a leaf-only rewind may not survive native reopening; the plugin follows the leaf Pi actually reopens and must not pretend to restore a different one. Tests must distinguish that host behavior from sibling isolation and verify fresh-process behavior without silently preselecting the expected leaf.

Recovery restores no lock, owner claim, domain fence, retry counter, timer, dispatch handle, or staged action. Fresh automatic activity still requires all existing live qualification checks.

### 5. Reuse live qualification and publication behavior

Assemble the view for the current attempt and attach metadata to the existing marker append and inquiry dispatch. Do not cache it across a lifecycle replacement. Each correction remains tied to its current attempt under the existing three-response bound. Existing ownership, run, generation, source-context observation, and publication checks remain authoritative; a review digest is diagnostic/recovery metadata, not a second permission or execution gate.

Keep reentrant-append and stale-callback protections at the existing effect/publication boundaries. Recovery never stages an old action or declares an old review current solely because its digest matches. These records document a local assembled/observed input, not arbitrary later provider transformations.

Retain the existing failure semantics of marker/inquiry dispatch and canonical outcome publication, including guarded continuation rollback and no relocking of a successful unlock. A missing or failed optional audit does not independently block an inquiry or continuation, consume another retry, or cause a new provider call. Report unavailable review history through a safe existing diagnostic surface and mark recovery incomplete; do not silently claim the missing record was saved, repair file permissions, or write to a fallback store.

Normal persistence and restart acceptance must be demonstrated with a disk-backed native session JSONL, not just an in-memory mock. If the host explicitly uses a memory-only session, no JSONL durability can be claimed and no private file is created to simulate it. This does not relax the disk-backed acceptance criteria or change the host's persistence policy.

### 6. Keep human interaction and validation scope small

The new source view and audit records are hidden. Continue/unlock presentation still uses the current canonical outcome and safe rendering; do not add a second checklist, evidence panel, completion click, or permission prompt. Keep accepted reasons concise because the existing outcome UI can show them.

Use the existing TypeScript/node-test and packed-Pi harnesses. Separate three kinds of evidence:

1. **Deterministic behavior:** projection fidelity, size/omission behavior, ownership and freshness, durable record association, recovery/isolation, error handling, unchanged protocol/UI.
2. **Empirical model behavior:** already collected trial responses and manually checked action/target/reason/authorization correctness. Mocked verdicts are not model-quality evidence.
3. **Formal process documentation:** affected Lean models remain authoritative for their explicitly modelled lifecycle properties. Review projection does not make their existing parser/ownership proofs prove natural-language completeness. During apply, update affected process models, typecheck and run them; report any unavailable independent semantic review rather than claiming it happened. No Lean file is changed in this six-document planning scope.

## Risks / Trade-offs

- **A smaller evidence view can bias attention or omit useful old evidence** → Preserve the full native effective conversation, label omissions, retain older-delivery acceptance examples, and avoid treating the view as a task census.
- **The pilot was adaptive and used a reconstructed corpus** → Report it as directional evidence. Do not claim historical false-continuation repair or general reliability; no new paid/live evaluation without explicit authorization and a separate budget.
- **A requested field can still be hallucinated as delivered** → Require an evidence assessment but make no semantic-validation guarantee. Citation syntax or matching strings is not a substitute.
- **Native compaction removes detailed model context** → Keep audit history distinct from new model input; use native summaries rather than resurrecting discarded source text.
- **Persistent I/O failure can leave incomplete review history** → Reuse the current dispatch/publication behavior, distinguish missing audit from missing canonical publication, and expose the limitation safely; do not add an independent review-write gate.
- **An old snapshot survives a fork but the old process cannot** → Accept inherited source identity only for history; require fresh live control qualification for every new action.
- **Extra tokens and latency** → Start with the bounded single-call view. The four long trials per arm observed roughly +1.1% incoming tokens and +1.35 seconds mean latency for the chosen treatment, not a production performance guarantee.

## Migration Plan

1. Implement and verify the projection/guidance slice, then native record/recovery/freshness integration, under a subsequent apply request. Reuse the existing dependencies and test seams.
2. Preserve old audit/event records without backfill. Treat unknown versions or unresolved source references as unusable for recovery, not as authority; build new review context from current native entries.
3. Run deterministic checks and targeted packed-host lifecycle tests without real provider calls. Keep the historical-case efficacy limitation explicit in the acceptance report.
4. No installation is part of apply by implication. Deployment or additional model evaluation needs its own authorization. Rollback to the prior extension must leave added nested metadata inert; it must not migrate, delete, replay, or move native records.
