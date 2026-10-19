# Architecture and context isolation

Run decision checks in a private full fork; keep approved work and guarded outcome publication in the main session. For observable requirements, see [behavior-contract.md](behavior-contract.md). The approved source-checkout change `openspec/changes/isolate-watchdog-decisions-in-private-fork/design.md` supersedes the old active main-session inquiry/`cw` transport.

## Execution boundary

Support Pi **>=1.3.0** and Node.js **>=22.19.0**. Development/test SDK and TUI are pinned to `1.3.0`. The private runtime uses native session projection and `context_with_system`; Pi `0.85.1` compatibility is not retained.

One logical decision owns:

- one main ownership claim, source session/leaf, model/thinking selection, cycle and external-activity generation;
- one distinct private child session and cancellation signal;
- one private result directory and `decision.json` file;
- one outer terminal promise, spanning format corrections and optional review/reconsideration.

The watchdog imports only its private runtime entry, not the public pi-subagents extension. It registers no public result functions (`cw` or legacy unlock tools), subagent tools, commands, RPC/delegation listeners or user agent catalog. Human watchdog commands remain. No public subagent installation or configuration is required; an independently installed public extension retains its own runtime and tools.

## Flow

```text
real main user message starts
  → silent cleanup → fresh lock cycle
  → ordinary main work → successful settlement
  → aggregate live idle → replaceable fixed 10-second fence
  → fresh owner / idle / pending-message / process-domain checks
  → capture effective source and open one private operation
       → create full-fork child (same provider/model/thinking)
       → reset decision.json to {}
       → one model response → preflight entire tool batch
       → at most one admitted write → stop before automatic follow-up
       → validate designated file
          ├─ invalid: correct in same child, at most 3 responses per inquiry
          ├─ valid initial unlock: optional shared review
          │    └─ challenged: one reconsideration inquiry in same child,
          │                   with separate 3-response allowance, no second review
          └─ terminal decision / decision-failed / cancellation / execution failure
  → recheck source / claim / cycle / external activity
  → apply existing controller and durable-publication path
       ├─ continue: canonical event → ordinary main work (+1 unit)
       ├─ WAIT_CALLBACK: quiet status → lock-retaining suspension (+1 unit)
       ├─ other unlock: quiet UI-only status → AI_UNLOCK (+0 units)
       └─ third invalid: locked decision-failed → DECISION_FAILED (+0 units)
```

A terminal ordinary main error unlocks immediately; an actual main abort keeps its separate reasonless unlock. Neither starts a decision. A private execution failure is distinct from three invalid responses: report no accepted outcome and abandon/unlock through cleanup, without falling back to main-session inquiries. An exhausted cycle opens no child; it publishes exhaustion only after eligible ordinary work has settled, not while callback-suspended.

## Module map

| Module | Responsibility |
| --- | --- |
| `src/hub.ts` | Same-process attachment registration, main election and aggregate activity |
| `src/process-domain.ts` | Authenticated cross-process activity and generation fences |
| `src/activity-grace.ts` | One replaceable fixed ten-second idle fence |
| `src/controller.ts` | Pure lock, shared continue/callback budget, suspension, invalid-response and exhaustion state |
| `src/runtime.ts` | Source/owner fencing, private operation lifecycle, optional review, terminal finalization, publication receipts, continuation scheduling and hooks |
| `src/private-decision.ts` | Owned temporary file, same-child inquiry/correction loop, one optional reconsideration and terminal cleanup |
| `src/decision-protocol.ts` | Shared payload validation, file-result prompt/correction policy and retained legacy protocol helpers |
| `src/decision-tool.ts` | Retained legacy declarations/helpers; not registered as the current transport |
| `src/review-context.ts` | Bounded source view and ancestry-aware historical associations |
| `src/unlock-review.ts` | Complete effective-conversation review projection and optional service adapter |
| `src/watchdog-event.ts` | Versioned events, immutable bodies and local-offset RFC 3339 timestamps |
| `src/context-fold.ts`, `src/summary-projection.ts` | Read-only legacy exchange isolation for ordinary requests and native summaries |
| `src/abort-outcome.ts`, `src/auto-lock.ts` | Canonical main abort/error handling and genuine main-user cycle reset |
| `src/commands.ts`, `src/semantic-hook.ts` | Human controls, timeline/status and neutral semantic publication |
| `src/config-loader.ts`, `src/config.ts` | Trusted field-wise config merge, defaults and validation |

## Pinned private runtime and patch

The package bundles `watchdog-subagents-runtime`, an alias pinned to pi-subagents `0.79.0` at `1008e5993e90fcf13b815c97c15a0c54f7f6f116`, with `patches/pi-subagents-0.79.0/` and `scripts/prepare-private-runtime.mjs`.

Preparation verifies package identity/version and expected upstream source hashes before applying replacements. It refuses a linked/shared runtime target. Each changed file is written to a new inode and atomically renamed within the package-local dependency, avoiding mutation of shared package-manager hardlinks. This is per-file atomic replacement, not a claim of a transaction across all files. The prepared dependency exposes only `./watchdog-runtime` and removes its public Pi extension manifest.

The private entry creates an instance-local child factory. It reuses upstream fork/session/provider machinery without public registration, global factory overrides, discovery, fleet state or background orchestration. The child disables ambient extensions, skills and context-file loading; only the private projection and single-response/writer hooks load. Provider registrations are inherited without rerunning their parent extension factories. Rollback is an explicit package-version rollback, not a live fallback transport or file recovery mechanism.

## Full effective context versus executable tools

At qualified idle, `src/runtime.ts` supplies the owning session manager, provider registry, cwd, exact selected `provider/model:thinking` and legacy context projection to the private runtime. The runtime creates a native fork from the active source and uses `buildSessionProjection` plus inherited system state and `context_with_system` projection. The frozen pre-child projection identifies parent system checkpoints even when native compaction and fork creation share a millisecond. Native compaction/exclusion and provider compatibility determine eligible conversation; raw JSONL, sibling history and excluded old traffic do not replace that projection.

Decision instructions and the bounded source supplement are appended after inherited context. A recent-message suffix, pruned fork, alternate model or silent fresh session is not a fallback for unavailable full-fork input. The selected TUI/main session does not change.

Inherited system/tool declarations describe the parent's effective request. They do **not** grant child execution rights. Only a guarded stock writer executes in the child. A compatible inherited writer declaration may be reused; a required new/redeclared writer must be represented honestly by the provider projection/checkpoint. Main tools remain unchanged. This preserves effective context, not a byte-identical wire prefix or guaranteed provider-cache hit. Trusted code and serializers can still alter later provider payloads; neither local projections nor Lean models certify arbitrary final wire requests.

## File-only result and single-response enforcement

`runPrivateDecision` creates an owner-private `/var/tmp/watchdog-decision-*` directory, an agent directory and `decision.json`. Before **every** response attempt it initializes the regular file to exactly `{}` through a no-follow descriptor. A logical decision never reuses another operation's path.

The private runtime preflights the complete assistant batch at `message_end`:

- admit exactly one `write` call with string `path` and `content` targeting the resolved designated path;
- reject unknown/ordinary tools, duplicate writes, mixed batches, wrong paths, malformed arguments and truncated batches before any effects;
- project rejected tool calls away and stop normally, recording a safe format diagnostic;
- retain an admissible call and required thinking until dispatch; the guarded writer checks call authority/path and regular-file/no-symlink constraints, completes the write and returns `terminate: true` on success or failure.

This closes the native post-tool/error follow-up path before it requests another model response. It does not use a racing abort, a prompt promise or deprecated `maxTurns` accounting as the boundary. A normally completed attempt remains distinguishable from actual abort/error. Provider-owned transport recovery is not a format retry or a promise of one HTTP request.

After settlement, the adapter first checks for an **own** completed assistant response, not an inherited reply. Only then may it read the designated regular file and decode one complete JSON object with the existing validator. Assistant prose, stdout, another file and tool success cannot supply or repair the result. Untouched `{}`, malformed JSON and invalid fields count once as invalid; host allocation/reset/read/write failures, provider failures and missing own terminal responses are typed execution failures, not invented format errors. Aborted or stale work supplies no verdict.

## Same-child correction and review

The outer private operation stays pending while `runInquiry` appends corrections to the same child. Each inquiry allows three consumed responses: initial plus at most two corrections. Reset occurs only after prior admitted writes have settled. The correction carries the concrete safe diagnostic and file contract, never raw invalid bodies. Third invalid response returns one decision-failed terminal result without spending continuation budget.

A valid initial `unlock` candidate may enter the existing optional review callback without resolving the outer promise. Freeze review macro evidence from the **owning main conversation**, not child prompts, retries or writer traffic. Review discovery is call-time, review-v1 only; no service installation, direct HTTP, alternate provider or watchdog timeout is introduced. Missing/incomplete review warns and releases only the still-current original candidate as unreviewed. A definite challenge appends opinion-not-evidence feedback to this same child, opens one reconsideration inquiry with its own three-response allowance, and never reviews the replacement. At most six decision responses belong to a logical decision; service/provider transport attempts remain separate observations.

The parent runtime receives only terminal results and safe internal audit/review callbacks. It does not ask the main model to launch corrections, confirm a candidate or reword the final result. Normalized fields feed the existing publication path directly.

## Ownership, source currentness and responsive waiting

Private dispatch is detached from main lifecycle handlers so the event loop, user input and cancellation remain responsive. The active controller decision blocks duplicate inquiries. The private child does not load a nested watchdog or join the ordinary observable-attachment domain; its own generation, write and settlement cannot invalidate its external-activity anchor.

Before/after asynchronous boundaries and before commit, currentness includes:

- exact elected-main claim and controller identity;
- runtime/lifecycle, lock cycle and external-activity generations;
- source session and active source ancestry;
- same selected provider/model and thinking setting;
- correct child/inquiry identifiers and a live cancellation signal;
- aggregate idle, no pending messages and current process-domain confirmation at finalization.

The source leaf is an anchor, not a requirement that JSONL never append. Context-excluded audit/usage descendants do not introduce a new model source. Non-owned source content, branch moves, takeover, model/thinking changes and session/lifecycle replacement invalidate old authority. Old callbacks cannot act merely because they completed successfully.

Manual unlock revokes authority and cancels the exact private child, not `ctx.abort()` on an unrelated main run. Genuine interactive/RPC takeover cancels the private operation and lets Pi handle the complete input normally: no decision queue capture/copy/replay. Lifecycle cleanup and shutdown revoke before awaiting disposal. The adapter drains/cancels and disposes its child before removing owned temporary resources, then rechecks currentness before returning an actionable result. Late files, reviews, cleanup and duplicate terminal callbacks remain inert. Native private cancellation must be correlated to that operation; arbitrary child abort does not imply main abort.

Ordinary continuation cancellation is unchanged: only an exactly correlated watchdog-owned main run may be aborted on manual unlock. Foreign/user work is never adopted by timing or lock-state inference. Cancelled continuation residue is marked/folded and removed best-effort after settlement, without a cleanup model turn. Completed effects cannot be rolled back, and detached work may outlive a run signal.

## Controller, callback and budget semantics

The controller tracks `locked`, accepted `attempt`, `exhausted`, `callbackSuspended`, `decisionOpen`, `invalidDecisionAttempts` and `decisionFailed`. Fresh main user work or manual lock always performs silent unlock cleanup before fresh lock/reset; stale ownership after cleanup cannot relock. Manual lock emits exactly one final lock notification. Any ordinary non-user main start ensures a lock but preserves an existing locked cycle. Ordinary unlock assigns `locked=false` before cleanup and preserves accounting; only a fresh cycle resets it.

Each accepted, durably published continuation and each accepted built-in `WAIT_CALLBACK` suspension spends one shared `maxContinue` unit. Actual unlock, invalid responses, review/reconsideration and deferrals spend none. A callback suspension keeps the lock and arms no timer or poll. Elapsed time, notices and unrelated child activity cannot resume it. Actual ordinary main work calls `resumeFromCallback` in the same cycle (+0 units), retiring any unpublished callback signal. A final callback unit stays suspended and signals `WAIT_CALLBACK`; `EXHAUSTED` becomes eligible after callback work resumes and settles successfully. Error/abort/manual unlock and new user-cycle precedence remain intact.

The fixed exact wake-message list in `src/auto-lock.ts` prevents known pi-subagents/pi-intercom callback wakes from masquerading as genuine user takeover or fresh cycles. Matching is whole-text, case/whitespace-sensitive and excludes extra image/content payloads. Dynamic producer text remains a known coverage gap; neither producer is a required dependency.

## Main outcomes, receipts and hooks

Accepted `continue` creates one canonical timestamped body carrying normalized reason type and reason, denying user approval and preserving existing permission. Human history and model context use that same immutable body in conversation order. Actual ordinary work runs in main, not in the child.

A public send's void return or `message_start` is not durability evidence. The runtime confirms a new correlated branch receipt under the original claim, rechecks activity/ownership and then authorizes hooks/work. A confirmed missing/rejected continuation append may roll back its unit; an unreadable receipt is retained without duplicate send, refund or terminal hook. Later eligible observations can resolve/retry confirmed absence without rebuilding immutable metadata. Cancellation/reset/ownership loss invalidates pending authority. This does not prove every publication interleaving.

AI unlock assigns unlocked before cleanup and uses a remove-only cleanup fold plus one canonical quiet UI-only status; both publication artifacts must be confirmed before `AI_UNLOCK`. No model-bound unlock replacement or acknowledgement turn exists. Callback suspension uses its own quiet lock-retained status and idle-gated `WAIT_CALLBACK`. Decision failure and exhaustion retain shared canonical terminal bodies and confirmed receipts; they start no ordinary work. Optional audit failure never replaces required outcome receipts or relocks an accepted unlock.

The elected main publishes best-effort plain-data envelopes on `pi:semantic-hook:v1`:

- `watchdog-continued`: normalized `REASON_TYPE` and trimmed `REASON`, after durable continuation evidence;
- `user-ready`: `AI_UNLOCK`, `WAIT_CALLBACK`, `ERROR_UNLOCK`, `EXHAUSTED` or `DECISION_FAILED`, under existing terminal aggregate-idle/ownership gates.

`WAIT_CALLBACK` includes typed reason, no duration, and keeps the lock. Manual unlock, abort, cancellation and intermediate states emit no terminal hook. The retired `watchdog-waiting` hook is never emitted. Delivery is current-listener-only with no consumer acknowledgement/replay; publication receipt handling is a separate producer safeguard.

## Evidence, legacy projection and recovery

The bounded source supplement keeps at most 8,000 Unicode code points including labels/footer, 1,600 per excerpt. Latest user/reply and recent tool evidence lead; earlier deliveries remain relevant. Omissions are disclosed, not treated as proof of non-delivery. Native bash conversion preserves exclusion, cancellation, exit-status and truncation semantics. Complete review macro evidence is a separate uncropped projection: public text and summaries, tool name/call/status only, and `ask_user_question` question/answer text; controls, thinking and excluded bash stay out. Known input gaps prevent a review call and release the still-current candidate as incomplete, not approved.

Main JSONL stores only versioned context-excluded source associations/view, child/inquiry/response identities, normalized candidates or safe categories, review diagnostics and outcome associations. New private prompts, corrections, file paths, writer payloads, raw invalid output and thinking stay out of main model/transcript/summary input. Optional audit failure is diagnostic-only. A result file never substitutes for durable parent publication.

Retain exact-exchange folding for **historical** main-session XML/function inquiries, corrections, calls, results and required thinking. Native compaction and branch-summary preparations use the same forward-looking projection: remove old owned internals and unlock statuses, retain accepted continuations at their selected positions, preserve unrelated entries and host summarizer/settings/cancellation. Stored session entries are not rewritten. Exports, pre-existing summaries, user quotations and material another extension reintroduces are not erased; missing/damaged correlation fails closed rather than guessing ownership.

Ancestry-aware historical association follows the host-selected branch and preserves inherited non-label sources through native forks/re-chaining. Unknown/missing metadata remains incomplete history with bounded diagnostics, not a reason to restore authority, retry permission questions or create fallback storage. Reopen restores **history only**: no lock, budget, suspension, child, response allowance, review, timer, old publication or temporary-file authority. No temporary directory is scanned for recovery. Native compaction and branch selection remain authoritative; historical Pi `0.85.1` leaf-rewind observations do not establish current `1.3.0` resume coverage.

## Observable-agent domain

Every extension-loaded attachment registers session ID, UI presence and live public `ctx.isIdle()` state with the process-wide hub. UI-bound attachment wins main; first-bound headless attachment is best-effort main. Others are observer-only. The root main owns config, controller, grace, decisions and publication.

`pi-extension-utils` provides authenticated loopback transport, peer liveness and a fixed one-second reconnect, not watchdog policy. Root creates one ephemeral listener; inherited `PI_EXTENSION_UTILS_PROCESS_DOMAIN` carries its capability and `PI_CONTINUE_WATCHDOG_ROOT_PID` marks creator topology. Business payload is exactly `{agentId, idle}`, with authenticated sender ID equal to `agentId`.

Root maintains a busy-child set: `idle:false` adds; `idle:true` and disconnect remove. Connection alone is activity-neutral. Every accepted report/disconnect replaces the domain generation, including equal reports. Reconnect immediately queries/reports live child idle. Root activity is checked locally, not echoed. Heartbeat disconnect counts that peer idle during reconnect; no timeout guesses task completion. No polling loop is added to decision policy.

Initial declaration/authentication/transport failure is terminal and sanitized (exit 78). TUI/RPC use graceful public shutdown with bounded nonzero fallback; print/json use the fallback because public shutdown is a no-op there. Final root detach closes transport and clears only declarations still owned. Never print capabilities, proofs, raw declarations or endpoint details. Coverage begins at watchdog-loaded inherited child registration/reporting; stripped environments and sessions without the watchdog are outside it.

## Configuration and limits

Merge built-ins < global < trusted-project fields. Invalid high-precedence fields retain lower valid values with bounded diagnostics; untrusted project config is ignored. Keep `maxContinue` default 10 (safe integer 1–10), fixed ten-second fence, prompt limit 16,384 Unicode code points, reason limit 1000, existing reason-list trim/case normalization, default-on optional review and `alt+u` shortcut. `idleDelaySeconds` remains compatibility-only. Removed `maxRetries` and `jevWaitCheck` report key-specific errors without applying values or editing config. The watchdog resolves no external jev credentials. See [README configuration](../README.md#configuration) for exact defaults.

This is not an OS sandbox, destructive history erasure, a cache guarantee, a completion oracle or certification of arbitrary later provider transformations. Trusted same-process extensions retain their privileges. Cancellation cannot undo effects. Formal models assume their host/projection/currentness inputs; they do not prove TypeScript refinement, natural-language accuracy or all publication races.

## Verification status

Frozen-source `npm run check` passed lint, type checking, **569 unit tests** and build. Full `npm run test:e2e` passed **62 cases**: 43 packed, one cross-process and 18 native-summary cases, including independent public pi-subagents and foreign `cw` ownership. No tests were skipped or cancelled; the final source/test/package snapshot stayed unchanged during the complete E2E gate. Four affected Lean documents typechecked and ran on Lean `4.35.0`; four intentional-break controls rejected response-cap, same-child, stale-file and registration violations.

Strict independent semantic round trips are confirmed for all four Lean documents, including the rechecked cancellation-routing annotation and the merged presentation-only ownership laws. Fresh provider-only readers used only complete named-file reads and exact hash commands; transcript, unique input and current hashes were checked against declared scope. Earlier failed readers remain historical failures. Stock-Pi `1.3.0` PTY probes using exact `openai-api-extension/gpt-6-luna` passed private Escape, manual slash/Alt+U cancellation and ordinary Escape after private cancellation. The TUI-only input subscription consumes Escape only for exact current owned private work while main is idle; it revokes child authority before notification and unsubscribes on replacement/shutdown. Ordinary/main continuation keys remain host-owned. Human acceptance is post-publication by explicit user choice; the missing historical task 3.1 red sequence is retained as a process gap alongside retrospective behavioral red/green. Delivery updates live `master`, not a tag or GitHub Release. Publication state and exact evidence are in the change's ledger.

Automated evidence covers distinct child/main identities, unchanged selected session, effective fork/provider inheritance, no added public watchdog result/orchestration surface, same-child corrections/reconsideration, no post-write follow-up, guarded cancellation/currentness, public co-installation/foreign `cw`, publication/rollback, callback accounting, and legacy resume/summary isolation. These deterministic gates used local test providers, not live paid decision inference, and required no global Pi upgrade. The explicit manual and historical-evidence gaps above remain separate.
