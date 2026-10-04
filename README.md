# pi-continue-watchdog

> **Plugin-only boundary.** Inquiry authorization uses exact owned-run identity and this plugin's local context observation, not certification of the final provider payload after later handlers. Pi may reject non-object `cw` arguments before plugin authorization. Malformed owned batches are stopped before dispatch without per-call results. See [verification and historical findings](openspec/changes/align-unlock-tool-with-reflection-contract/verification.md). Publishing source does not install or deploy this plugin.

Pi extension that keeps your agent working. When a locked cycle settles, the watchdog asks the model itself — through a hidden, phase-gated decision inquiry — whether to continue, wait, or unlock. Ordinary work cannot stop the cycle by itself: only a verdict submitted inside the watchdog's own consumed decision attempt, a human command, an abort, or a terminal error can.

## Behavior

1. **Root election and cross-process idle.** In every Pi process the extension joins a shared, capability-authenticated process domain. One root process hosts control; child Pi processes only report activity and never register the reserved decision function. Continuation, wait, and terminal decisions require the root claim, every observable attachment idle, the process-domain fence confirming, no pending messages, and a fresh idle probe.
2. **Lock cycle.** Real user work auto-locks a fresh cycle (`maxRetries`, default 10). `/unlock-continue-watchdog` (or the configured shortcut, default `alt+u`) unlocks; abort and terminal provider errors unlock through their own paths.
3. **Settlement gate.** A true ordinary settlement that did not end in `stopReason: "error"` keeps the cycle locked and eligible. Terminal errors unlock immediately; aborts keep the immediate abort unlock. Successful settlements never continue directly: they enter the fixed ten-second aggregate-idle fence.
4. **Fixed idle fence.** One timer per authoritative all-idle generation; any local, child, or process-domain activity restarts qualification. After the fence, the root re-queries idle state, confirms the domain fence, and opens exactly one decision inquiry.
5. **Watchdog-owned decision inquiry.** The watchdog sends one hidden decision prompt (custom `decisionPrompt` plus a fixed outcome and function contract) as a trigger-turn custom message. Only after that exact prompt is observed in the corresponding run and plugin-local context — correlated through host metadata, not prompt text — can a result act. This locally confirmed phase is called a consumed attempt; it does not certify later provider transforms. The prompt teaches the reserved `cw` function and the continue/wait/unlock JSON payloads; ordinary work never sees this guidance.
6. **Reserved `cw` function.** One root-only function named `cw`, description exactly `don't use unless ask`, an open empty-object parameter schema, no startup prompt snippet or guidelines, and no reason enums. Registration and active membership never change. Outside a current consumed attempt, object-shaped calls reaching the plugin return `This function is reserved for the plugin. Please try another function.` before plugin payload validation, without changing lock state, budgets, timers, or hooks, and without terminating ordinary work. Pi may reject a non-object container first; that native rejection has no watchdog effect.
7. **Three outcomes, one JSON contract.** `action` is `continue`, `wait`, or `unlock` (case-insensitive after trimming). Continue and unlock additionally require a string `reason_type` matched case-insensitively against `continueReasonTypes` (default `WORK_REMAINS`, `VERIFYING`) or `reasonTypes` (default `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, `WAIT_CALLBACK`), normalized to uppercase. Wait requires an integer `wait_seconds` from 1 through 1800 and rejects a supplied `reason_type`. `reason_content` is trimmed, non-empty, at most 1000 Unicode code points (the prompt guides 500). XML and prose are never accepted as a result.
8. **Decision responses do not perform ordinary work.** During a confirmed decision only `cw` may execute. The complete assistant batch is preflighted before any tool runs: exactly one `cw` call and no other tool call. Mixed, duplicate, non-object, and truncated owned batches are projected to a normal stop without executable calls, before native dispatch fast paths can request another response; they count once as invalid. Suppressed calls do not receive per-call results. An admissible singleton call retains its required thinking and executable block, stages its validated verdict (or a named validation error), and returns a short terminating result.
9. **Bounded correction.** One inquiry allows at most three consumed responses. Each invalid response counts once and receives a correction prompt that teaches the same function contract; invalid responses never consume the continue/wait budget. After the third invalid response the cycle enters a decision-failed terminal state, stays locked, stops automatic requests, publishes one shared failure event, and makes `user-ready` with `STOP_KIND=DECISION_FAILED` eligible under the existing idle rules.
10. **Shared retry budget.** Each accepted continue or wait consumes one `maxRetries` attempt; unlock, invalid responses, stale submissions, and transport deferrals consume none. A wait that spends the final attempt still defers exhaustion until its deadline plus aggregate-idle qualification.
11. **Bounded waits.** An accepted wait stays locked, records acceptance time and deadline, and starts no ordinary work. Activity defers eligibility without restarting the duration. The first qualified inquiry after the deadline begins with the same completed-wait body visible to the human (requested seconds, observed elapsed, explicit time-zone offsets) followed by the decision guidance; corrections reuse those facts unchanged. Unlock, a fresh cycle, ownership loss, or shutdown invalidates pending wake actions; reopening history never restores a timer. `WAIT_CALLBACK` remains an unlock reason and arms no timer.
12. **Shared canonical events.** Continuation, accepted wait, completed wait, AI unlock, decision failure, and exhaustion each publish one immutable timestamped body visible to humans and supplied as model-bound conversation content; no separately reconstructed model summary. Events explicitly deny being a user message, approval, or authorization.
13. **Context folding.** Completed decision inquiries, corrections, result calls, and results are folded out of later ordinary model requests, retaining the one shared outcome event in conversation order. Admissible executable calls and provider-required thinking stay until their dispatch completes. Legacy XML inquiry records remain readable through the same folding without acting as decisions. Ordinary-request folding does not erase persisted function-call arguments, and native compaction or branch summaries may still retain them; the watchdog does not rewrite history.
14. **Hooks.** `watchdog-continued` (normalized `REASON_TYPE` + `REASON`), `watchdog-waiting` (`REASON` + decimal `WAIT_SECONDS`), and `user-ready` (`STOP_KIND` = `AI_UNLOCK` / `ERROR_UNLOCK` / `EXHAUSTED` / `DECISION_FAILED`) publish on the neutral `pi:semantic-hook:v1` channel after durable publication, still fenced by ownership and aggregate idle. Manual unlock, abort, and cancelled work stay silent.
15. **Cancellation.** Manual unlock aborts only the exact watchdog-owned decision, correction, or continuation run, removes its residue, revokes pending submission and wait authority, and never aborts ordinary user work. User takeover during a decision preempts it: the complete text-and-image takeover payload is re-issued once as a fresh user turn after the internal run settles.

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
| `maxRetries` | `10` | Shared budget of accepted continue/wait verdicts per lock cycle; safe integer 1–10 |
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
