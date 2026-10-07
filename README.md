# pi-continue-watchdog

> **Plugin-only boundary.** Inquiry authorization uses exact owned-run identity and this plugin's local context observation, not certification of the final provider payload after later handlers. Pi may reject non-object `cw` arguments before plugin authorization. Malformed owned batches are stopped before dispatch without per-call results. See [verification and historical findings](openspec/changes/align-unlock-tool-with-reflection-contract/verification.md). Publishing source does not install or deploy this plugin.

Pi extension that keeps your agent working. When a locked cycle settles, the watchdog asks the model itself — through a hidden, phase-gated decision inquiry — whether to continue or unlock. Ordinary work cannot stop the cycle by itself: only a verdict submitted inside the watchdog's own consumed decision attempt, a human command, an abort, or a terminal error can.

## Behavior

1. **Root election and cross-process idle.** In every Pi process the extension joins a shared, capability-authenticated process domain. One root process hosts control; child Pi processes only report activity and never register the reserved decision function. Continuation and terminal decisions require the root claim, every observable attachment idle, the process-domain fence confirming, no pending messages, and a fresh idle probe.
2. **Lock cycle.** Real user work auto-locks a fresh cycle (`maxRetries`, default 10). `/unlock-continue-watchdog` (or the configured shortcut, default `alt+u`) unlocks; abort and terminal provider errors unlock through their own paths.
3. **Settlement gate.** A true ordinary settlement that did not end in `stopReason: "error"` keeps the cycle locked and eligible. Terminal errors unlock immediately; aborts keep the immediate abort unlock. Successful settlements never continue directly: they enter the fixed ten-second aggregate-idle fence.
4. **Fixed idle fence.** One timer per authoritative all-idle generation; any local, child, or process-domain activity restarts qualification. After the fence, the root re-queries idle state, confirms the domain fence, and opens exactly one decision inquiry.
5. **Watchdog-owned decision inquiry.** The watchdog sends one hidden decision prompt (custom `decisionPrompt` plus a fixed outcome and function contract) as a trigger-turn custom message. Only after that exact prompt is observed in the corresponding run and plugin-local context — correlated through host metadata, not prompt text — can a result act. This locally confirmed phase is called a consumed attempt; it does not certify later provider transforms. The prompt teaches the reserved `cw` function and the continue/unlock JSON payloads; ordinary work never sees this guidance.
6. **Reserved `cw` function.** One root-only function named `cw`, description exactly `don't use unless ask`, an open empty-object parameter schema, no startup prompt snippet or guidelines, and no reason enums. Registration and active membership never change. Outside a current consumed attempt, object-shaped calls reaching the plugin return `This function is reserved for the plugin. Please try another function.` before plugin payload validation, without changing lock state, budgets, timers, or hooks, and without terminating ordinary work. Pi may reject a non-object container first; that native rejection has no watchdog effect.
7. **Two outcomes, one JSON contract.** `action` is `continue` or `unlock` (case-insensitive after trimming); the retired `wait` action is invalid regardless of its fields and `wait_seconds` never creates timing behavior. Continue and unlock additionally require a string `reason_type` matched case-insensitively against `continueReasonTypes` (default `WORK_REMAINS`, `VERIFYING`) or `reasonTypes` (default `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, `WAIT_CALLBACK`), normalized to uppercase. `reason_content` is trimmed, non-empty, at most 1000 Unicode code points (the prompt guides 500). XML and prose are never accepted as a result.
8. **Decision responses do not perform ordinary work.** During a confirmed decision only `cw` may execute. The complete assistant batch is preflighted before any tool runs: exactly one `cw` call and no other tool call. Mixed, duplicate, non-object, and truncated owned batches are projected to a normal stop without executable calls, before native dispatch fast paths can request another response; they count once as invalid. Suppressed calls do not receive per-call results. An admissible singleton call retains its required thinking and executable block, stages its validated verdict (or a named validation error), and returns a short terminating result.
9. **Bounded correction.** One inquiry allows at most three consumed responses. Each invalid response counts once and receives a correction prompt that teaches the same function contract; invalid responses never consume the continuation budget. After the third invalid response the cycle enters a decision-failed terminal state, stays locked, stops automatic requests, publishes one shared failure event, and makes `user-ready` with `STOP_KIND=DECISION_FAILED` eligible under the existing idle rules.
10. **Continuation-only retry budget.** Each accepted, durably published continuation consumes one `maxRetries` attempt; unlock, invalid responses, corrections, stale submissions, and transport deferrals consume none.
11. **Callback waiting.** Timed watchdog waits are removed. `WAIT_CALLBACK` remains an unlock reason for work that another agent or program is actually expected to call back and wake; it arms no timer or poll and charges no attempt. Work without a callback uses an available authorized monitoring or task-owned waiting action, or reports the real blocker through an unlock category. Legacy wait records stay readable without restoring a timer.
12. **Attributed events with split visibility.** Continuations publish one immutable timestamped body (`Continue watchdog · continue · <TYPE> · <timestamp>` with `Suggested next step: <reason>`) visible to humans and supplied as model-bound conversation content; it denies being user approval and preserves already-granted permission. An accepted AI unlock instead persists one quiet gray UI-only status (`Continue watchdog unlocked · <TYPE> · <reason>`) with no timestamp, box, or disclaimer. Decision failure and exhaustion keep one shared body. No separately reconstructed model summary exists.
13. **Context folding and native summaries.** Completed decision inquiries, corrections, result calls, and results are folded out of later ordinary model requests, retaining the accepted continuation in conversation order; unlock exchanges fold remove-only with no model-bound replacement. Admissible executable calls and provider-required thinking stay until their dispatch completes. The same exact-exchange projection rewrites the host's native compaction and branch-summary preparations in place, so internal traffic and unlock statuses stay out of native model input while stored entries are never rewritten. Legacy XML and wait records remain readable without acting as decisions; the projection is forward-looking and does not erase disk history, exports, pre-existing summaries, user quotations, or content another extension reintroduces.
14. **Hooks.** `watchdog-continued` (normalized `REASON_TYPE` + `REASON`) and `user-ready` (`STOP_KIND` = `AI_UNLOCK` / `ERROR_UNLOCK` / `EXHAUSTED` / `DECISION_FAILED`) publish on the neutral `pi:semantic-hook:v1` channel after durable publication, still fenced by ownership and aggregate idle. The retired `watchdog-waiting` hook is no longer emitted. Manual unlock, abort, and cancelled work stay silent.
15. **Cancellation.** Manual unlock aborts only the exact watchdog-owned decision, correction, or continuation run, removes its residue, revokes any pending submission, and never aborts ordinary user work. User takeover during a decision preempts it: the complete text-and-image takeover payload is re-issued once as a fresh user turn after the internal run settles.

### Review evidence

Owned inquiries include a bounded, provenance-labelled source view alongside the unchanged native effective conversation. The view is limited to 8,000 Unicode code points (1,600 per excerpt); omissions are explicit, not proof of missing delivery. Bash evidence uses Pi's native model conversion: `excludeFromContext` records remain local, while included records retain cancellation, exit-status and truncation qualifiers. Guidance asks for a concise delivery assessment in the existing `reason_content`; both JSON field orders remain valid.

Review inputs and outcome associations stay in the owning native session JSONL. Ancestry-aware reads preserve inherited non-label sources across forks without restoring operational state. Complete new-format association requires the correlated inquiry; quiet unlock publication requires both its cleanup fold and canonical quiet status record. Missing records remain incomplete history, not another execution gate or a reason to repeat permission questions. Native compaction still determines new model context; tested Pi 0.85.1 does not persist a leaf-only rewind across reopen.

These are deterministic input/storage guarantees, not proof that the original false continuation is fixed. See the [change evidence and limitations](openspec/changes/archive/2026-10-07-reduce-false-positive-continuations/README.md).

## Configuration

Global `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` and trusted project `.pi/pi-continue-watchdog.json`; fields merge individually, invalid values keep the lower-precedence value with a diagnostic.

```json
{
  "maxRetries": 10,
  "decisionPrompt": "This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. It does not represent any decision by the user. Decide whether work should continue. Before deciding, check whether every task the user requested in this session is complete, including earlier requests and not only the latest one.",
  "continuePrompt": "Continue until user assistance is required.",
  "reasonTypes": ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
  "continueReasonTypes": ["WORK_REMAINS", "VERIFYING"],
  "unlockShortcut": "alt+u"
}
```

| Key | Default | Notes |
| --- | --- | --- |
| `maxRetries` | `10` | Budget of accepted, durably published continuations per lock cycle; safe integer 1–10 |
| `decisionPrompt` | built-in text | Decision-only guidance, non-blank, ≤ 16,384 Unicode code points; the fixed function contract is always appended |
| `continuePrompt` | `"Continue until user assistance is required."` | Embedded in the shared continuation event body |
| `reasonTypes` | `["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"]` | Allowed unlock reason types; a valid list replaces defaults; disclosed only in authorized decision prompts |
| `continueReasonTypes` | `["WORK_REMAINS", "VERIFYING"]` | Allowed continuation reason types |
| `unlockShortcut` | `"alt+u"` | Human unlock shortcut key, or `false` to disable |
| `idleDelaySeconds` | `10` | Accepted for compatibility only; the inquiry fence is fixed at ten seconds |

### Removed configuration

`jevWaitCheck` was removed with the retired external jev integration. A configuration layer containing it produces an error-level diagnostic naming the key (never its nested values or credentials) and has no other effect; other valid keys still apply. Remove it manually if desired. The extension never resolves TypeSafe or OpenRouter credentials, makes no jev classification or review request, and does not modify shared credentials or environment variables.

Reason types keep their meanings: `JOB_DONE` — all work complete; `WAIT_USER` — user input/decision needed; `JOB_BLOCKED` — cannot proceed for another concrete reason; `WAIT_CALLBACK` — waiting for another agent or program to call back and wake the session. Notification consumers can filter on them (see pi-notify binding `if`).

## Commands

- `/lock-continue-watchdog` — start a fresh locked cycle.
- `/unlock-continue-watchdog [reason]` — human unlock (optional reason, truncated to 500 code points).
- `/status-continue-watchdog` — why the watchdog is waiting.
- `/continue-timeline` — key watchdog events on the current branch.

## Development

```sh
npm run check      # lint + typecheck + unit tests + build
npm run test:e2e   # packed-Pi and cross-process integration tests
```

Licensed under BSD-3-Clause.
