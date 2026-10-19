# pi-continue-watchdog

Keep Pi working until work is complete or a real boundary requires stopping. After a locked cycle settles and remains idle for ten seconds, the watchdog asks the current model for a decision in a private full-fork session. Ordinary continuation work still runs in the main session.

Requires Pi **1.3.0 or later** and Node.js **22.19.0 or later**. Development and verification target Pi SDK/TUI `1.3.0`; Pi `0.85.1` is not supported.

## Private decision transport

The watchdog embeds its own pinned `pi-subagents` runtime. You do **not** need to install the public pi-subagents extension. Loading the watchdog registers no `cw`, legacy unlock function, public subagent tools, delegation bridges, or agent catalog. Independently installed public extensions keep their own surfaces; the watchdog does not take over a foreign `cw`.

Each logical decision owns one distinct child session and one private `/var/tmp/` result directory. The child inherits the main session's **full effective active-branch context**, system state and tool declarations, using the same selected provider/model and thinking setting. Native compaction, exclusions, legacy watchdog folding and provider compatibility still apply. A bounded source supplement assists review; it does not replace the inherited conversation. Missing full-fork input is an execution failure, not permission to start with a suffix, another model or an empty conversation.

Inherited tool declarations are not execution permissions. The child may execute only one guarded stock `write` call to its designated `decision.json` per response. Shell commands, delegation, ordinary work, other paths, duplicate writes and mixed batches are rejected before effects. The host initializes the file to exactly `{}` before every attempt and reads it only after the response and admitted write settle. Only this file supplies a decision; prose, stdout and tool results cannot substitute for it.

One attempt permits one completed model response and its admitted write, with **no automatic post-tool response**. Invalid formats receive at most two corrections in the **same child**: three responses per inquiry. If optional unlock review challenges a valid initial unlock, one reconsideration inquiry uses that same child with its own three-response allowance. The outer operation stays pending throughout and returns only a terminal normalized decision, decision failure, cancellation or execution failure. No main-model confirmation or rewrite occurs. Provider/service transport retries are separate; one response is not a promise of one HTTP request.

Waiting is foreground and cancellable without blocking the event loop or changing the selected main session. User input follows normal Pi handling, without decision takeover replay. Manual unlock cancels the exact private child rather than aborting unrelated main work. Private prompts, corrections, thinking, file paths and tool payloads do not enter the main conversation or native summary input; safe context-excluded audit associations remain permitted.

This is session/API isolation, **not an OS sandbox** against trusted same-process code. Full context inheritance does not guarantee byte-identical provider payloads or cache hits. See [architecture](docs/architecture.md) and the [behavior contract](docs/behavior-contract.md).

## Behavior

1. **Qualify aggregate idle.** One elected root controls the watchdog. Every extension-loaded same-process attachment and authenticated watchdog-loaded child process contributes live activity. Every relevant observation replaces the fixed ten-second fence, including repeated equal idle reports. At expiry, the root rechecks ownership, pending messages, live idle and the process-domain fence. Unobserved sessions are outside coverage. Private decision activity is tracked directly, not as external work that cancels itself.
2. **Start a lock cycle.** Real main user work and `/lock-continue-watchdog` silently clean old operational state before starting a fresh cycle. Any ordinary main `agent_start` ensures a lock without resetting an already locked cycle. Default `maxContinue` is 10. Ordinary successful settlement stays locked; terminal `stopReason: "error"` unlocks immediately after Pi retries end, and actual main abort keeps its immediate reasonless unlock.
3. **Ask privately before continuing.** With budget remaining, qualified idle opens one owned private decision. The result must still match the owner, session/source ancestry, cycle, selected model/thinking and external-activity generation before it can affect the main session. Context-excluded audit appends do not invalidate the decision against itself; non-owned source changes do. Cancelled, stale and setup/provider failures are not format errors or budget charges. Private execution failure reports that no outcome was accepted and unlocks through cleanup; it never falls back to the retired main-session transport.
4. **Validate the JSON contract.** `action` is `continue` or `unlock`, case-insensitive after trimming. `reason_type` matches the action's configured list case-insensitively; accepted outcomes use uppercase. `reason_content` is trimmed, nonblank and at most 1000 Unicode code points (500 is prompt guidance). Property order and extra fields remain tolerated. XML, prose and retired `wait` are invalid; `wait_seconds` creates no timing behavior. After three invalid responses in an inquiry, stay locked as decision-failed, stop automatic requests and make `user-ready` with `STOP_KIND=DECISION_FAILED` eligible at terminal idle.
5. **Share one continuation budget.** Each accepted, durably published continuation and each accepted `WAIT_CALLBACK` suspension consumes one `maxContinue` unit. Actual unlock, corrections, review/reconsideration, stale results and deferrals consume none. Confirmed failed continuation publication can roll back its unit; an unreadable receipt is not evidence of absence and must not cause a duplicate, refund or hook.
6. **Continue in main.** Publish one immutable timestamped body (`Continue watchdog · continue · <TYPE> · <timestamp>`, with `Suggested next step: <reason>`) for both human history and model context, then run ordinary main-session work. It identifies the extension as source, denies being user approval and preserves already-granted permission. Durable publication and fresh ownership/activity checks precede hooks and continuation authority.
7. **Suspend for callbacks without unlocking.** An accepted `unlock` with built-in `WAIT_CALLBACK` (when configured) retains the lock, spends one unit and suspends automatic inquiries. No timer or poll is armed. Elapsed time, notice-only messages and unrelated child activity do not resume it. Actual ordinary main work resumes the same cycle without spending or replenishing units; its settlement uses the ordinary idle fence. A final-unit suspension signals `WAIT_CALLBACK`, not `EXHAUSTED`; exhaustion becomes eligible only after resumed callback work settles successfully. Manual unlock, abort/error unlock, new user work and lifecycle replacement retain precedence. Custom reason types keep their normal unlock meaning.
8. **Publish terminal outcomes, not private traffic.** Actual AI unlock persists one quiet gray UI-only status (`Continue watchdog unlocked · <TYPE> · <reason>`), without timestamp, box or disclaimer. Callback suspension has its own quiet lock-retained status. Decision failure and exhaustion keep shared canonical bodies. Semantic hooks on `pi:semantic-hook:v1` remain ownership- and aggregate-idle-gated: `watchdog-continued` carries `REASON_TYPE` and `REASON`; `user-ready` uses `AI_UNLOCK`, `WAIT_CALLBACK`, `ERROR_UNLOCK`, `EXHAUSTED` or `DECISION_FAILED`. A callback that starts before its pending signal retires that signal. Manual unlock, abort and cancelled work stay silent. The retired `watchdog-waiting` hook is not emitted.
9. **Cancel exact owned work.** Takeover, manual unlock, source/session/branch replacement, ownership loss, external-work invalidation and shutdown revoke private result authority before cleanup. Late files and review replies cannot act on a later cycle. Ordinary continuation cancellation remains main-run-correlated: manual unlock aborts only the exact watchdog-owned continuation, removes its residue and never adopts an unrelated run. Cancellation cannot undo completed effects or guarantee termination of detached work.
10. **Recover history only.** Runtime locks, budgets, suspension, children, retries, timers and temporary-file authority are never restored. Legacy XML/function inquiry records, waits, folds and audits remain readable. Exact-exchange folding still removes old internals from ordinary requests and native compaction/branch-summary input while preserving accepted continuations. Legacy `WAIT_CALLBACK` unlock records keep their historical unlock meaning. Stored sessions are never rewritten; exports, existing summaries, user quotations and traffic reintroduced by other extensions are not erased.

### Decision evidence and history

Private inquiries append a provenance-labelled source view to the full effective conversation: at most 8,000 Unicode code points, with 1,600 per excerpt. Omissions are explicit, not evidence of missing delivery. Native bash conversion honors `excludeFromContext` and keeps cancellation, exit-status and truncation qualifiers for included records. Guidance asks for a concise delivery assessment in `reason_content`; that control reason never replaces an answer, report or question owed in ordinary replies.

Versioned context-excluded native JSONL entries associate source identities/view, child/inquiry/response identifiers, normalized candidates or safe error categories, optional review diagnostics and published outcomes. Temporary files are not durable history. Ancestry-aware historical reads preserve inherited non-label sources across forks without restoring authority. Missing or unknown associations remain incomplete history, with bounded diagnostics; optional audit failure is not another execution gate. Native branch selection and compaction remain authoritative. These storage/input properties do not prove that natural-language completion judgments are correct.

### Unlock review

Review is on by default (`unlockReviewEnabled: true`). A valid initial AI `unlock`, including a callback candidate, uses an already-loaded [`pi-llm-as-jev`](https://github.com/xz-dev/pi-llm-as-jev) review-v1 service when available. The watchdog does not install it, choose a fallback provider or resolve its credentials. `continue`, invalid results, manual unlock, abort and terminal-error unlock are not reviewed.

- **Input:** freeze the owning main session's complete effective conversation, not the child's private retries. Include full public text, labelled summaries, tool name/call/status only (no arguments/output), and `ask_user_question` question/answer text. Exclude owned controls, thinking and context-excluded bash. Known provider secrets are redacted by the service. This macro evidence is not the bounded 8,000-code-point supplement.
- **Supported:** release the original candidate through normal currentness/publication guards.
- **Incomplete:** missing/incompatible service, known input gaps, error, timeout, overflow, unsupported content or insufficient evidence warn and release the still-current original candidate **unreviewed**, never as approval. Missing/incompatible service warns once per runtime; other skips warn each time. No watchdog review timer is added; service-owned timeouts apply.
- **Challenged:** append opinion-not-evidence feedback to the same child and allow one reconsideration inquiry. Apply its terminal result normally, with no second review. Format corrections and reconsideration spend no continuation units.
- **Escape/history:** takeover, manual unlock, abort and lifecycle/currentness loss cancel review. Append review diagnostics to native JSONL best-effort; reopening reads history and never resumes review.

Review is a second opinion, not proof of completion or a fix for false continuations.

### Callback wake messages

Pi public events cannot distinguish typed user-role messages from extension-injected ones. To avoid resetting the budget for known callback wakes, the watchdog recognizes a fixed, non-configurable exact whole-text list:

- the pi-subagents parent wake (`Inspect subagent updates above. Answer pending supervisor requests …`; full text in `src/auto-lock.ts`);
- the pi-intercom idle wake `New intercom message above.`

Matching performs no trimming, case folding, prefix or fuzzy comparison. Extra content, including images, makes the message genuine user work. Dynamic producer prompts and changed wake texts remain a known gap until this list is updated. Recognizing optional producers does not make their extensions required dependencies.

## Configuration

Merge built-ins, global `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` (normally `~/.pi/agent/pi-continue-watchdog.json`), then trusted project `.pi/pi-continue-watchdog.json`, field by field. Invalid values keep the lower-precedence value with bounded diagnostics; missing files are silent. Untrusted project config is ignored.

```json
{
  "maxContinue": 10,
  "decisionPrompt": "This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. It does not represent any decision by the user. Decide whether work should continue. Before deciding, check whether every task the user requested in this session is complete, including earlier requests and not only the latest one.",
  "continuePrompt": "Continue until user assistance is required.",
  "reasonTypes": ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
  "continueReasonTypes": ["WORK_REMAINS", "VERIFYING"],
  "unlockShortcut": "alt+u",
  "unlockReviewEnabled": true
}
```

| Key | Default | Notes |
| --- | --- | --- |
| `maxContinue` | `10` | Per-cycle shared continue/callback budget; safe integer 1–10, unrelated to provider retries |
| `decisionPrompt` | built-in text above | Nonblank, ≤16,384 Unicode code points; fixed file-result instructions are appended |
| `continuePrompt` | `Continue until user assistance is required.` | Nonblank, ≤16,384 code points; embedded in the shared continuation body |
| `reasonTypes` | `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, `WAIT_CALLBACK` | Allowed unlock types; a valid list replaces defaults |
| `continueReasonTypes` | `WORK_REMAINS`, `VERIFYING` | Allowed continue types; a valid list replaces defaults |
| `unlockShortcut` | `alt+u` | Human unlock shortcut, or `false` to disable |
| `unlockReviewEnabled` | `true` | Optional shared review; unavailable review warns but does not block |
| `idleDelaySeconds` | `10` | Compatibility-only; never changes the fixed ten-second fence |

Reason-list entries are trimmed and nonblank, without identifier regexes or artificial length/count caps. Matching preserves configured input identity: uppercase output does not create extra input aliases (for example, configured `ß` does not admit `SS`). Default unlock meanings: `JOB_DONE` — all work complete; `WAIT_USER` — user input/decision needed; `JOB_BLOCKED` — another concrete blocker; `WAIT_CALLBACK` — an expected external callback with no independent authorized work remaining.

### Removed configuration

`maxRetries` is not an alias. Its diagnostic is `maxRetries was removed and has no effect; use maxContinue instead`; its value never changes effective `maxContinue`. Rename it manually.

`jevWaitCheck` reports an error naming the key, never nested values or credentials, and has no effect; other valid fields still apply. The watchdog never edits config, resolves TypeSafe/OpenRouter credentials or modifies shared credentials/environment. Optional unlock review uses the loaded service's own credentials.

## Commands

- `/lock-continue-watchdog` — clean up and start a fresh locked cycle.
- `/unlock-continue-watchdog [reason]` — human unlock; optional untyped reason, trimmed and truncated to 500 code points.
- `/status-continue-watchdog` — explain the current trigger/waiting state.
- `/continue-timeline` — show key watchdog events on the current branch.

## Packaging and verification

The private fork runtime comes from the shared `pi-extension-utils/private-inquiry` entry (pinned to `371d47f594b21c75fe82eab95078e71165774199`). That package owns the pi-subagents `0.79.0` pin (`1008e5993e90fcf13b815c97c15a0c54f7f6f116`, private name `private-inquiry-subagents-runtime`) and its reviewed patch; its install script verifies the version and source hashes, refuses a linked/shared runtime target and atomically replaces individual package-local files rather than modifying shared hardlink inodes. This package also declares the same runtime spec as a direct dependency, so a Git install under this repository's `allow-git=root` policy fetches it as a root dependency and the shared preparation patches that single hoisted copy. The private export omits public extension registration. It does not patch a globally installed plugin. Rollback means a deliberate package-version rollback, never resuming old private files or switching transports at runtime.

For development in a writable checkout:

```sh
npm run check      # lint + typecheck + unit tests + build
npm run test:e2e   # packed-Pi, cross-process and native-summary integration suites
```

**Automated gates passed on frozen source.** `npm run check` passed lint, typecheck, **569 unit tests** and build. `npm run test:e2e` passed **62 cases**: 43 packed, one cross-process and 18 native-summary cases, with no skips or cancellations. This includes independently installed public pi-subagents, foreign `cw` ownership, and the concurrent empty-message ownership fix preserved from `master`. Four affected Lean files typechecked and ran with Lean `4.35.0`, without warnings or proof placeholders; their claims cover abstract models, not host refinement. Four normal-versus-mutated controls detected broken response bounds, child reuse, stale-file rejection and registration isolation.

Strict independent semantic round trips are confirmed for the four Lean files; the cancellation model's host-routing annotation was rechecked and independently reread. Actual stock-Pi `1.3.0` PTY probes with `openai-api-extension/gpt-6-luna` passed private Escape, slash unlock, Alt+U and subsequent ordinary Escape, preserving actual child aborts and ordinary parent presentation. After live publication and successful CI, the user reported working behavior and approved archiving; this is product-acceptance feedback, not a claim of exhaustive human scenario testing. Historical pre-implementation red chronology remains unproven; a clearly labelled retrospective runtime red/green verifies current correction behavior instead of inventing history. This is a live Git package: publish by updating `master`, without version tags or GitHub Releases. Tests and proofs do not guarantee cache hits, arbitrary final wire payloads or decision accuracy. The [archived verification ledger](openspec/changes/archive/2026-10-19-isolate-watchdog-decisions-in-private-fork/verification.md) records gates, the acknowledged historical process gap and publication state.

Licensed under BSD-3-Clause.
