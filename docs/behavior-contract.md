# Behavior contract — pi-continue-watchdog

**Authority:** the [main OpenSpec specifications](../openspec/specs/) include the synchronized private-fork requirements. The [archived change](../openspec/changes/archive/2026-10-19-isolate-watchdog-decisions-in-private-fork/) records the replacement of active main-session inquiry/`cw` transport. This document consolidates that transport with still-valid watchdog behavior; verification, post-publication user feedback and the acknowledged historical process gap are distinguished in the [archive ledger](../openspec/changes/archive/2026-10-19-isolate-watchdog-decisions-in-private-fork/verification.md).

**Baseline:** Pi >=1.3.0, Node.js >=22.19.0; development/test Pi SDK/TUI pinned to `1.3.0`. English public documentation, configuration, prompts, labels and diagnostics; BSD-3-Clause license.

## Goal and scope

Keep the agent working until requested work is complete or a genuine boundary requires stopping. Successful ordinary settlement alone must not unlock a locked cycle. After qualified aggregate idle, ask the current model privately whether to continue or unlock; apply only a current terminal outcome without a main-model rewrite.

Preserve observable behavior, not obsolete mechanisms. The current transport must:

- create one private full-fork child per logical decision, using the parent's selected provider/model and thinking;
- accept a decision only from the host-designated JSON file, initialized to `{}` before each response;
- allow one completed model response and its admitted write per attempt, with no automatic post-tool response;
- keep format corrections and at most one review-triggered reconsideration in that same child;
- keep the main session selected and responsive while awaiting a terminal outcome;
- expose no watchdog result function or public subagent/orchestration surface;
- preserve ownership, source currentness, cancellation, durable receipts/rollback, shared callback budget, context isolation and history-only recovery.

The watchdog must not register `cw`, `unlock_continue_watchdog` or another result-function alias. Ordinary tool calls never submit watchdog decisions. Old local-context consumption, main-query dispatch and decision takeover replay are not current authorization rules. Legacy parsers/folds remain read-only compatibility, not a second live transport. There is no fallback to the retired path after private execution failure.

Out of scope: moving ordinary work into the child, durable locks, public orchestration APIs, arbitrary child filesystem access, new retry/poll settings, global Pi upgrades, guaranteed provider cache reuse, an OS sandbox against trusted code or a replacement review service.

## Public surface

| Surface | Required behavior |
| --- | --- |
| `/lock-continue-watchdog` | Full silent cleanup, then fresh cycle; one final `Continue watchdog locked` notification |
| `/unlock-continue-watchdog [reason]` | Human unlock; optional untyped reason, trimmed and truncated to 500 Unicode code points |
| `/status-continue-watchdog` | Read-only explanation of trigger/waiting state |
| `/continue-timeline` | Read-only key events on the active branch, including readable legacy history |
| `unlockShortcut` | `alt+u` by default; `false` disables it |
| Private dependency | Bundled runner; no required public pi-subagents installation or user agent profile |
| Public decision/orchestration tools | None added by the watchdog; independently installed extensions retain their own surfaces |

Human reasonless unlock notifies `Continue watchdog unlocked`. A nonblank human reason adds one muted UI-only `Continue watchdog unlocked · <reason>` entry, without typed AI reason fields. Main terminal error notifies `Continue watchdog unlocked · run ended in error` and records `Continue watchdog unlocked · run ended in error (automatic unlock)` to distinguish it from a manual unlock. No human unlock or abort emits `user-ready`.

## Ownership and aggregate idle

1. Observe every extension-loaded same-process attachment and every authenticated watchdog-loaded child Pi process that joined the inherited domain. Do not claim coverage for sessions without the extension/declaration or before activity registration.
2. Elect one root-process main: prefer UI-bound attachment; otherwise first-bound headless attachment is best-effort main. Other attachments report activity only. Only the exact elected root main owns decisions, config, controller and publication.
3. Query live public `ctx.isIdle()` at relevant events. Event labels never imply busy/idle. Native retries, auto-compaction retries and queued continuations remain busy as Pi defines them.
4. Replace the candidate event-loop timer on every relevant observation/report, including equal idle reports. Each eligible candidate waits a full fixed **10,000 ms**. Cleared/already-queued callbacks are inert by identity.
5. At expiry, recheck current owner, cycle/generation, empty busy-child set, no pending messages, fresh main idle and process-domain confirmation. A failed confirm waits for a later real observation; no self-rearming poll or stale-timeout inference is allowed.
6. Open at most one decision when locked, with budget remaining, not callback-suspended or decision-failed, and no current decision. Private generation/write/settlement is tracked directly, not as external work that cancels itself or qualifies another inquiry.
7. Before any automatic effect commits, repeat current owner/source/cycle/external-activity/publication and idle guards after awaited or re-entrant boundaries. Manual controls and immediate main-abort/error handling retain their explicit paths.

Authenticated process-domain behavior remains unchanged: root owns one loopback listener; business payload is `{agentId, idle}` and sender identity must match. `idle:false` adds a busy peer; `idle:true` or disconnect removes it. Connect alone is activity-neutral. Every accepted report/disconnect replaces the generation; fixed one-second reconnect immediately sends fresh live idle. Heartbeat disconnect counts the peer idle while disconnected, not completed. Initial declaration/authentication/transport failure is sanitized and terminal (exit 78), with bounded shutdown fallback. Never disclose capabilities, proofs or endpoint/declaration details. Final detach clears only resources/declarations still owned.

## Lock cycle, settlement and accounting

### Fresh cycle and unlock

Manual lock and actual genuine main-user **message start**, not queueing, must always:

1. capture the current owner claim;
2. assign unlocked and perform full non-notify cleanup of old timers, private operations, pending continuation/publication and review authority;
3. recheck ownership after cleanup;
4. assign fresh lock, reset attempts/exhaustion/decision state and reconcile idle.

Manual lock emits exactly one final lock notification; user auto-lock emits neither prerequisite-unlock nor lock notification. Same-state commands do not bypass cleanup. Child user messages do not reset main. An ordinary current-main `agent_start` ensures a lock; an already locked cycle preserves its accounting. Watchdog continuation starts do not reset themselves.

Unlock assigns `locked=false` before cleanup and preserves attempt/exhaustion accounting; only a fresh cycle resets it. Actual main abort, as Pi reports via canonical `stopReason: "aborted"`, unlocks reasonlessly once, without guessing keyboard intent or why a child stopped. Terminal ordinary main `stopReason: "error"`, after native retries are exhausted, unlocks immediately with distinct error presentation: no idle fence, inquiry or continuation. Successful ordinary settlement stays locked and enters the normal idle fence.

For exact watchdog-owned main continuation aborts, keep aborted state while suppressing finalized internal abort residue as supported; ordinary user abort presentation remains unchanged. Earlier streaming notices may briefly appear. Quiet display is not successful completion and must not alter unrelated host queues/dispatch. Arbitrary private-child cancellation is not evidence of main abort.

### Shared budget

| Final accepted effect | `maxContinue` charge | Next state |
| --- | --- | --- |
| Durably published `continue` | One unit | Ordinary work runs in main |
| Built-in `unlock` / `WAIT_CALLBACK` suspension | One unit | Locked, callback-suspended |
| Any other `unlock` | None | Unlocked |
| Third invalid response in an inquiry | None | Locked, decision-failed; no automatic requests |
| Correction, review/reconsideration, stale/cancelled result or dispatch deferral | None | No invented accepted effect |

The default shared budget is 10 units. After the final continuation's ordinary work settles successfully, publish one exhaustion event and idle-gated `EXHAUSTED`; open no further inquiry. Fresh user work/manual lock resets it; manual unlock still works. A final-unit callback suspension keeps waiting and signals `WAIT_CALLBACK`, not `EXHAUSTED`, until callback work resumes and settles successfully. Error, abort, manual unlock and new-cycle precedence remain intact.

Keep four counts distinct: consumed format responses (three per inquiry), reconsiderations (at most one), provider/review transport attempts (observations, not format charges), and accepted continue/callback budget units.

## Private full-fork contract

Create one distinct child from the qualified main source leaf. Capture owner, main session/source ancestry, lock/publication cycle, external-activity generation, selected provider/model and thinking. Inherit the **full effective active-branch conversation**, system state and tool declarations, subject to native compaction, exclusions, legacy watchdog folding and provider compatibility. Append decision instructions and source supplement after inherited context.

Do not substitute raw JSONL, a recent-message suffix, pruned history, another model or silent fresh-context fallback. Unavailable full-fork input is an execution/setup failure: no fabricated decision, format response or continuation charge. Inherit required provider registrations without rerunning ambient parent extension factories. Disable ambient child extensions, user agent discovery/defaults, public subagent configuration, skills/context-file discovery and nested watchdogs.

Inherited tool declarations must remain distinct from executable child tools. The child executes only its guarded stock file writer; parent shell/edit/delegation declarations grant no authority. Reuse a compatible inherited writer declaration where possible. If the provider needs a new declaration/checkpoint, represent that honestly without discarding inherited conversation or pretending an exact cache prefix. Do not promise byte-identical final provider requests or cache hits across serializers/third-party transformations.

The source leaf anchors ancestry rather than forbidding all later appends. Context-excluded owned audit/usage descendants are allowed; non-owned model-source changes, branch moves, session/lifecycle replacement, model/thinking changes and external-work invalidation revoke authority. Every actionable terminal result must still match the captured operation and current policy.

## File submission and response bounds

### Transient result channel

Allocate one uniquely owned, owner-private `/var/tmp/` directory per logical decision and one designated `decision.json`. Before each response attempt, wait for prior admitted writes to settle and reset the regular file to exactly `{}`. Never share paths between logical decisions or scan old directories for recovery.

Only one complete JSON object safely read from that file after normal settlement may supply a candidate. Prose, stdout, a tool result, another file or a claimed success cannot supply/repair it. No public/specialized result function is accepted. Temporary files are neither durable history nor authorization stores.

Preflight the **entire** assistant tool batch before effects. Admit at most one stock `write` to the exact resolved result path, with string path/content and current call authority. Reject ordinary work tools, delegation, shell, other paths, duplicate writes, mixed/unknown calls, malformed arguments and truncated batches before any effect. Enforce regular-file/no-symlink checks in the writer/read/reset path, not only in prompts. Do not narrow the main tool registry to implement this boundary.

### Single-response attempt

One attempt permits one completed assistant response plus its admitted result write. Let that write finish, then stop **before** the agent loop requests a tool-follow-up, acknowledgement or error-repair response. Rejected batches stop normally without dispatching suppressed calls; no per-call result is required. Admitted writes terminate on success/failure. A counter, prompt instruction, deprecated turn budget or racing abort alone is insufficient enforcement. Normal completion must not be labelled aborted.

Provider transport recovery retains its own policy; one completed model response is not a guarantee of one network request. An inherited assistant reply or absent own terminal response cannot authorize reading an old file.

### Payload validation

Retain existing pure validation and normalization:

- `action`: string `continue` or `unlock`, case-insensitive after trimming. Retired `wait` is invalid regardless of fields; `wait_seconds` creates no timing behavior.
- `reason_type`: string matched case-insensitively against the **action-specific** configured list (`continueReasonTypes` or `reasonTypes`). Preserve the matched configured identity for revalidation; outcome representation is uppercase. Uppercase output does not create extra input aliases: configured `ß` admits `ß`, not `SS`.
- `reason_content`: string, trimmed, nonblank, at most **1000 Unicode code points**. The prompt's 500-code-point guidance is not a stricter acceptance limit.
- Accept either property order and existing extra fields. Do not coerce missing/non-string fields, truncate invalid reasons, impose new object policy, or parse XML/prose as a result. Membership in the other action's type list grants no authority.

Untouched `{}`, missing submission, malformed JSON and invalid decision fields count once as model-format errors. Concrete runner format diagnostics may replace generic missing-field errors. Host allocation/reset/read/write failure, provider error, cancellation, stale ownership and absence of an own completed response are typed failures, not invented format attempts. An unreadable/non-regular file is an execution failure, never repaired by accepting prose or stale data.

### Same-child correction and terminal handoff

An inquiry permits three consumed response attempts: initial plus at most two corrections. On invalid format, append a safe concrete diagnostic and correction instruction to the same child, reset the file after writes settle, then authorize one new response. Do not return to the main model or create another fork for correction. Do not copy raw invalid payloads to parent history.

After the third invalid response, settle once as decision-failed without a fourth response or continuation unit. Stay locked, stop automatic requests for that cycle, publish one canonical failure event and make `DECISION_FAILED` eligible under terminal idle/ownership rules. Manual unlock and fresh-cycle recovery remain available.

The outer private operation remains pending through corrections and optional review. It returns only a terminal normalized decision, decision-failed, cancellation or execution failure. Safe audit/review callbacks are internal, not intermediate decisions returned to main. The parent revalidates currentness and active reason policy before publication; no main-model confirmation/rewrite is allowed. Private execution failure reports no accepted outcome and abandons/unlocks through cleanup without an old-transport fallback or format charge.

## Optional AI-unlock review

`unlockReviewEnabled` defaults to `true`. Discover an already-loaded `pi-llm-as-jev` review-v1 service at call time (`version: 1`, `reviewVersion: 1`, callable `review`). Never install it, invoke direct HTTP, choose a fallback provider or resolve credentials. `false` disables lookup. Review only a valid **initial** AI unlock, including `WAIT_CALLBACK`; do not review continue, invalid results, manual unlock, main abort/error unlock or a replacement candidate.

Freeze the owning main session's complete effective-conversation macro evidence, not private child prompts/retries. Include full public user/assistant/custom text in order, labelled summaries, tool name/call/status only (no arguments/output), and `ask_user_question` question/answer text. Exclude owned controls, thinking and context-excluded bash. This is not the 8,000-code-point source supplement. Known provider secrets are redacted by the service; unsupported content is a known gap. Known gaps skip the service call and yield incomplete review. Do not add a consumer timeout/timer or extra summarizer; service-owned transport limits remain.

| Review result | Required effect |
| --- | --- |
| Supported | Release the still-current original candidate to normal publication |
| Missing/incompatible service, known gap, error/deadline/inactivity, abort, malformed/missing answer, unobserved result, overflow or insufficient evidence | Warn; release only the still-current original candidate as **unreviewed/incomplete**, never approved |
| Definite observed challenge | Keep the outer operation pending; append opinion-not-evidence feedback to the same child and open one reconsideration inquiry |

Missing/incompatible service warns once per runtime; other incomplete reviews warn each time. A reconsideration has its own three-response allowance, uses the same file contract/child and may return either action. Apply its terminal result without another review or reconsideration. Thus at most two inquiries/six consumed decision responses belong to one logical decision, excluding independent service transport attempts. The superseded candidate never commits. Review/reconsideration spends no continuation units.

Manual unlock, takeover, abort, branch/session replacement, shutdown and currentness loss cancel review immediately; late answers cannot publish, relock or charge. Append versioned review outcome/backend/model/attempt/known-usage diagnostics to native JSONL best-effort; optional append failure is bounded diagnostic-only and never changes accepted effects. Reopen reads history and resumes no review. Review is a second opinion, not proof of completion or a fix for false continuations.

## Cancellation and foreground responsiveness

Keep the main session selected and UI/event loop responsive while the private operation waits. Do not block a main lifecycle handler until child completion. The active decision prevents concurrent duplicate inquiries; the private child is not an ordinary watchdog-loaded external attachment.

Revoke result authority before awaiting cancellation/disposal on manual unlock, genuine takeover, ownership loss, source/session/branch or lifecycle replacement, shutdown and external-work invalidation. Cancel only the exact private child handle. User takeover passes complete text/images through normal Pi handling; do not capture/reissue private-decision steering or inspect/copy/replay host-private queues. Parent abort must not cancel an unrelated main run. Drain/cancel admitted writes before resource cleanup or any subsequent attempt can reuse authority. Recheck currentness after cleanup and before an actionable return.

Late writes, reviews, repeated terminal callbacks and cleanup cannot affect a later cycle. Preserve the bounded status when real external subagent activity invalidates an already-submitted check; pre-submission invalidation is silent.

Ordinary continuation cancellation remains separate and main-run-correlated. Manual unlock may abort only the exact watchdog-owned continuation, remove/fold its settled residue and send no replacement cleanup turn. A genuine user/foreign start transfers authority away; timing or lock-state inference never adopts an ordinary run. Cancellation cannot undo completed tool effects or guarantee termination of detached work that no longer honors the run signal.

## Callback suspension

A valid final `unlock` with built-in `WAIT_CALLBACK`, matched case-insensitively when present in effective `reasonTypes`, means another agent/program is expected to wake main and no independent authorized work remains. It must:

- retain lock, close decision, spend one shared unit and set callback suspension;
- arm no timer, poll or fabricated wake;
- ignore elapsed time, later idle observations, notice-only messages, status updates and unrelated child activity for resumption;
- persist one quiet human-only `Continue watchdog waiting for callback (lock retained) · WAIT_CALLBACK · <reason>` status;
- publish idle/owner-gated `user-ready` with `STOP_KIND=WAIT_CALLBACK`, normalized `REASON_TYPE`, trimmed `REASON` and no duration.

Actual ordinary main work resumes the **same cycle** without spending/replenishing units; after settlement, the ordinary fence applies. Private control/review/publication traffic cannot resume it. A callback starting before commit retires the stale verdict; starting before signal publication retires the signal. Manual unlock, abort/error unlock, new genuine user work and lifecycle replacement retain precedence. Custom types and all other unlock types still unlock.

Known extension-injected user-role wakes use a fixed, non-configurable exact whole-text list: pi-subagents parent wake (full text in `src/auto-lock.ts`) and pi-intercom `New intercom message above.` They count as callback work, not genuine takeover/fresh-cycle input. No trimming, case folding, fuzzy or prefix matching; extra text/images count as genuine user work. Dynamic/changed producer prompts remain a known gap. Neither optional producer is a required dependency.

Legacy `WAIT_CALLBACK` unlocks keep their historical unlock meaning; wait/completed-wait records remain readable. History restores no suspension, lock, unit, timer, signal or file authority. Retired timed `wait` and `watchdog-waiting` emissions must not return.

## Durable outcomes and semantic hooks

### Continuation

Publish one immutable attributed body for human history and model context:

```text
Continue watchdog · continue · <TYPE> · <RFC3339 timestamp>
...
Suggested next step: <reason>
```

Embed effective `continuePrompt` verbatim, accepted normalized reason fields, the completeness check across all requested tasks (not only latest), and stop-at-user-boundary guidance. Identify extension origin and deny being user request, approval, confirmation, consent or authorization. Permit only previously requested/authorized work; a future command mentioned in a report is not new permission. Reason content is model-generated control reference, not an ordinary deliverable.

Use the same canonical body in history/model context, once in active-branch order, with runtime-authored milliseconds and numeric UTC offset. No separately reconstructed model-only outcome list. Provider-facing custom-message role does not turn it into human approval. Ordinary continuation executes in main only after guarded publication; no acknowledgement-only request is added.

A void send return or `message_start` does not prove persistence. Require a new correlated public branch receipt under current ownership. Confirmed absent/rejected continuation publication can roll back its unit and authorize no hook/work. An unreadable receipt is uncertainty: retain it, do not duplicate-send, refund or publish a hook. Later eligible observations may resolve/retry confirmed absence while preserving frozen metadata. Reset/cancellation/ownership loss retires authority. This contract does not claim every publication interleaving has been verified.

### Unlock, callback and terminal states

AI unlock assigns unlocked before cleanup and persists a remove-only cleanup fold plus one canonical quiet gray UI-only status:

```text
Continue watchdog unlocked · <TYPE> · <reason>
```

No timestamp, box, disclaimer or model-bound unlock replacement. Both publication artifacts must be confirmed before terminal `AI_UNLOCK` becomes eligible. Missing/unreadable receipts leave it unlocked without an acknowledgement turn; optional audit failure cannot relock it. Callback status remains distinct and lock-retaining. Decision-failed and exhaustion use one shared canonical timestamped body each, start no work turn and require confirmed publication before terminal hooks.

Publish best-effort plain-data envelopes on `pi:semantic-hook:v1`, without depending on a notification consumer:

| Name | Values / gate |
| --- | --- |
| `watchdog-continued` | `REASON_TYPE`, `REASON`; after durable continuation receipt and current guards |
| `user-ready` / `AI_UNLOCK` | `STOP_KIND`, typed reason; after quiet unlock/fold receipts and terminal aggregate idle |
| `user-ready` / `WAIT_CALLBACK` | `STOP_KIND`, typed reason, no duration; lock retained, pending signal retired on resumed work |
| `user-ready` / `ERROR_UNLOCK` | `STOP_KIND` only; terminal ordinary main error unlock |
| `user-ready` / `EXHAUSTED` | `STOP_KIND` only; final unit's ordinary work settled, not suspended |
| `user-ready` / `DECISION_FAILED` | `STOP_KIND` only; third invalid response, locked terminal state |

No terminal hook for manual unlock, actual abort, cancelled/stale work, initial unlocked idle, an in-flight continuation or intermediate/pending state. Repeated settled/reconcile cannot duplicate a terminal epoch. Hook delivery is current-listener-only, without consumer acknowledgement/retry/replay; producer receipt handling is distinct.

## Context, delivery and read-only history

### Decision assistance and delivery boundary

Append a provenance-labelled source supplement of at most 8,000 Unicode code points including labels/footer, at most 1,600 per excerpt including elision. Latest user/reply and two recent tool results lead; earlier requests/deliveries precede derived summaries/automation. Omissions are explicit, never proof of missing delivery. Native bash conversion preserves context exclusion and cancellation/exit/truncation qualifiers. Excluded commands/output/source IDs do not enter the supplement metadata.

Keep the full native effective context alongside this supplement. Guidance requests a concise delivery assessment in `reason_content`, with either JSON field order valid. Answers, reports, results and questions belong in ordinary replies already delivered; a control reason/file never substitutes for a missing deliverable. Earlier delivery and unchanged permission remain relevant. Add no new confirmation word, checklist, reviewer request or user acceptance gate.

### Parent isolation and associations

New private prompts, corrections, file paths, writer payloads, raw invalid output, thinking and partial child output must not enter main model conversation, visible transcript or native summary input. Only existing accepted outcome presentation and safe **context-excluded** versioned audit associations are permitted in main JSONL: source identities/view, logical decision, child/inquiry/response identifiers, normalized candidate or safe error category, optional review diagnostics and actual published-outcome association.

Audit entries are not public outcomes, execution gates or fallback authority. Optional persistence failure emits bounded diagnostics; it must not repeat model work, relock an accepted unlock, charge budget or substitute another storage system. Temporary files supply no durable evidence after operation cleanup.

### Legacy folding and recovery

Keep old inquiry/audit/fold/XML/function traffic readable without accepting it as a new submission. Apply exact-exchange read-only folding before ordinary requests and inherited child input. Project the host's native compaction preparation (history and split-turn prefix) and branch-summary preparation through the same semantics: remove finalized/invalidated owned internals and quiet unlock statuses, retain accepted continuations at host-selected positions and preserve unrelated entries. Keep host cut identity, file-operation evidence, summarizer/settings/cancellation and stored records untouched. Projection is idempotent and must not guess ownership from text, timestamps or object identity.

Do not rewrite historical session files, backfill shared events or erase exports, pre-existing summaries, user quotations or content another extension reintroduces. Missing/damaged correlation fails closed to avoid deleting genuine conversation. Native branch selection/compaction remains authoritative; do not resurrect discarded or sibling history.

Ancestry-aware association reads follow the host-selected active path. Sources precede their review on that path; inherited non-label identities survive native fork label recreation/re-chaining, with origin session as provenance only. Missing/unknown/incomplete records remain incomplete history, not a reason to restore operational authority or repeat permission questions. Preserve legacy unlock/fold association rules without treating them as the current private transport. Historical Pi `0.85.1` leaf-rewind limitations are not current `1.3.0` verification evidence.

Reload/new/resume/restart/shutdown restores **no** lock, owner claim, accepted budget, callback suspension, child, response allowance, review, timer, dispatch, staged action, old publication or result-file authority. Never scan temporary files for resumable decisions. Read native history and reapply legacy projections only.

## Defaults and trusted configuration

Merge built-ins < global `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` (normally `~/.pi/agent/pi-continue-watchdog.json`) < trusted `<cwd>/.pi/pi-continue-watchdog.json`, field by field. Ignore untrusted project config. Missing files are silent; invalid high-precedence values retain lower valid values with bounded diagnostics. Never rewrite files.

| Key | Default | Validation/meaning |
| --- | --- | --- |
| `maxContinue` | `10` | Safe integer 1–10; shared accepted continue/callback units, not format/provider retries |
| `decisionPrompt` | Text below | Nonblank, ≤16,384 Unicode code points; fixed file-result instructions appended |
| `continuePrompt` | `Continue until user assistance is required.` | Nonblank, ≤16,384 code points; embedded verbatim in continuation body |
| `reasonTypes` | `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, `WAIT_CALLBACK` | Valid configured list replaces defaults |
| `continueReasonTypes` | `WORK_REMAINS`, `VERIFYING` | Valid configured list replaces defaults |
| `unlockShortcut` | `alt+u` | Valid shortcut or `false` |
| `unlockReviewEnabled` | `true` | Optional loaded-service review, warning/unreviewed fallback |
| `idleDelaySeconds` | `10` | Accepted compatibility key; runtime fence always ten seconds |

Exact default `decisionPrompt`:

```text
This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. It does not represent any decision by the user. Decide whether work should continue. Before deciding, check whether every task the user requested in this session is complete, including earlier requests and not only the latest one.
```

Reason-list entries are trimmed and nonblank without identifier regexes or artificial entry length/count caps. `JOB_DONE` means all work complete; `WAIT_USER` needs user input/approval/action; `JOB_BLOCKED` means another concrete blocker; built-in `WAIT_CALLBACK` means expected external callback with lock retained. Custom reason types retain ordinary action-specific semantics.

`maxRetries` is removed, **not an alias**: report `maxRetries was removed and has no effect; use maxContinue instead`; never apply its value. `jevWaitCheck` reports a removed-key error without nested values/credentials and has no effect; other valid fields still load. The watchdog resolves no TypeSafe/OpenRouter credentials or shared environment changes; optional unlock review uses only the loaded service's credentials.

## Packaging boundary and verification status

Bundle the exact private dependency alias `watchdog-subagents-runtime` at pi-subagents `0.79.0` / `1008e5993e90fcf13b815c97c15a0c54f7f6f116` and its project-owned patch. Verify version and expected source hashes before patching. Refuse linked/shared runtime targets; atomically replace individual package-local files on new inodes, never patch a global public plugin or shared hardlink in place. Export only the unregistered instance-local runner; do not initialize public extension state. Packed artifacts must not require a developer checkout or a latest-network patch. Rollback is deliberate package-version rollback, never resumption of old private files or a runtime mode switch.

**Measured evidence remains separate from this contract.** Frozen-source `npm run check` passed lint, typecheck, **569 unit tests** and build. Full `npm run test:e2e` passed **62 cases** (43 packed, one cross-process, 18 native-summary), with no skips or cancellations and no change to the final source/test/package snapshot during the complete E2E gate. Real co-installation with public pi-subagents and foreign `cw` ownership passed. Four affected Lean files typechecked and ran on Lean `4.35.0`, with only accepted standard foundations. Four green controls became red under isolated violations of response bounds, same-child correction, stale-file rejection and registration isolation.

Strict independent semantic round trips are confirmed for the four Lean files, with the cancellation model's host-routing annotation and the merged presentation-only ownership laws rechecked and reread. Provider-only fresh readers performed only named-file reads and exact hash commands; transcripts, inputs, hashes and declared scope were independently checked. This confirms document meaning, not production refinement. Real stock-Pi `1.3.0` PTY probes with exact `openai-api-extension/gpt-6-luna` passed private Escape, slash unlock, Alt+U and ordinary parent Escape after private cancellation. Only current owned private waiting with an idle main consumes Escape; ordinary/main continuation cancellation remains native. Post-publication user feedback accepted the live behavior and requested archive, without claiming an exhaustive human scenario matrix. Task 3.1's original historical chronology is not claimed; retrospective correction-disabled red/current green proves current behavior. This live Git package updates `master` without tag/Release creation.

Automated gates cover real fork/context/provider inheritance, child/main identities and unchanged selection, registration isolation and public co-installation, the response/write boundary, same-child correction/reconsideration, guarded cancellation, stale-source/file rejection, callback/budget effects, receipts and legacy resume/summary isolation. They use deterministic local test providers. Human acceptance comes from the subsequent user feedback, not automated passes; the historical chronology gap remains an acknowledged archive exception.

Session/API isolation is not an OS sandbox. Full effective context does not certify arbitrary final provider transformations or cache hits. Review/tests/formal models do not prove natural-language completion, TypeScript refinement or every publication race. Cancellation cannot undo completed effects. These limits do not weaken the required source/currentness, execution, receipt, recovery or context-isolation behavior above.
