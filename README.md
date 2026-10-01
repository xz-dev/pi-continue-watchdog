# pi-continue-watchdog

Pi extension that keeps your agent working. The main agent signals completion by calling the `unlock_continue_watchdog` tool; if a locked cycle goes idle without that call, the watchdog automatically continues the work — so work never stops silently without a reason.

**Status:** live source package, tracks latest `master`. No versioned releases.

**License:** [BSD-3-Clause](./LICENSE)

## Requirements

- Node.js `>= 22.19`
- Current Pi with public extension APIs

## Install

```bash
pi install git:github.com/xz-dev/pi-continue-watchdog
```

Use `pi update --extensions` to update. Reload Pi extensions or start a new session after install.

## How it works

1. **Auto-lock.** When the main agent starts running, the watchdog arms itself. Each new user message starts a fresh cycle.
2. **Idle detection.** The watchdog watches the main session plus all child Pi processes it spawned. When everything appears idle, it waits a fixed **10 seconds** to make sure nothing new starts, then continues the work directly.

   Settlement has exactly three outcomes. A **normally completed** run follows the fence above. A run that ends in a **terminal error** (`stopReason: "error"` after Pi's automatic retries are exhausted) unlocks the watchdog automatically — no fence, no continuation — with `Continue watchdog unlocked · run ended in error` and a history entry marked `(automatic unlock)`; there is no healthy trajectory to resume, so control returns to you. An **aborted** run keeps the existing immediate reasonless unlock. While Pi is still retrying, the run is busy and none of this happens.
3. **The unlock tool.** The model-visible way to stop is one always-registered tool:

   ```json
   { "reason_type": "JOB_DONE", "reason": "All requested work is complete." }
   ```

   `reason_type` matches the configured `reasonTypes` case-insensitively after trimming; `reason` is non-blank and at most 1000 Unicode characters. The tool description tells the agent it must call this tool to signal completion, a user boundary, a non-user blocker, or a wait for a callback, and that ending a turn without calling it gets the work continued automatically. Before calling it, the agent checks every task requested in the session, including earlier requests, against what was delivered, and keeps working while authorized work can still proceed. The `reason_type` schema enumerates the configured values and explains the built-in ones (`JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`); `reason` asks for one sentence on what was delivered, what the user must do, or what blocks the work.

   - A valid call from the locked current main agent unlocks the watchdog, ends the run without a follow-up model request, and publishes the `user-ready` hook with `STOP_KIND=AI_UNLOCK` plus the normalized `REASON_TYPE` and `REASON` (publication waits for busy children and process-domain idle).
   - Invalid arguments fail as an ordinary tool error; the model can simply retry.
   - The tool call and its result are the model-visible record; no separate unlock event message is published.
   - The tool only stops the automatic continuation; it is not a delivery channel. Its text tells the agent to write every answer, result, or question in the normal reply before calling it and not to rely on the user seeing the arguments (the `reason` appears only in the compact TUI line and in notifications).
   - The tool is registered only in root processes; child Pi processes never see it, and the active tool list never changes, so the provider prompt prefix and its cache stay stable.
4. **Automatic continuation.** When the locked main agent goes idle without calling the unlock tool, the watchdog publishes exactly one visible continuation event and starts the next turn with it. Its immutable canonical body states that the agent ended its turn without calling `unlock_continue_watchdog`, embeds the configured `continuePrompt`, instructs the agent to call the tool now if the work is complete or the user is needed, otherwise to continue the remaining work, and — when something must be waited for — to call the tool with `WAIT_CALLBACK` if that work will call back and wake it, or else to block on it directly: monitor that task until it ends, or sleep for the estimated duration. The body is extension-attributed, timestamped, explicitly not a user message or authorization, and keeps the stop-at-user-boundary rule. A `watchdog-continued` hook with no values publishes after each durable continuation.
5. **Manual unlock.** A human `/unlock-continue-watchdog` or unlock shortcut assigns unlocked first, then cancels the current run when it is exactly correlated to a watchdog-owned continuation, removing that run's partial output and abort residue. An ordinary uncorrelated user-started run is preserved, including genuine user steering that starts inside the same Pi agent lifecycle as an earlier continuation. Queued-message behavior remains Pi-owned during abort: the extension neither clears nor privately replays Pi queues and makes no exactly-once delivery guarantee. No cleanup or summary model turn is started, and already-completed or detached/background side effects are not rolled back.
6. **jev wait gate.** Just before an automatic continuation, if a TypeSafe or OpenRouter key is available, the watchdog sends only the final assistant message's visible text (key redacted) to TypeSafe's **jev** model and asks one Choice question: is this message clearly waiting for a user answer? A `waiting_user` answer with confidence ≥ `confidenceThreshold` (default 0.8) unlocks instead of continuing, without consuming an attempt, shows `Continue watchdog unlocked · WAIT_USER (jev: …)`, and publishes `user-ready` with `STOP_KIND=AI_UNLOCK`, `REASON_TYPE=WAIT_USER`, and `REASON` = `jev model judged the final output to be a question for the user: <last paragraph>` (≤ 1000 code points; an overlong paragraph keeps its tail behind `…`). Everything else (no key, text-less final message, error, timeout, `not_waiting`, `unclear`, low confidence) continues exactly as before. Each assistant message is classified at most once per session, and a verdict is dropped when any activity, branch navigation, unlock, or new lock cycle happened during the request. Keys are resolved from Pi's own `typesafe` / `openrouter` credentials, then `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`, then the global `jevWaitCheck.apiKey`; TypeSafe is tried first.
7. **Limits.** Each lock cycle allows up to **10** automatic continuations (`maxRetries`); when the budget is exhausted the watchdog stays locked, publishes one exhaustion event, and stops continuing until a new user message or manual lock. A continuation that cannot be durably published is rolled back and retried later.

There is no hidden decision question, no XML protocol, and no re-ask machinery: the agent either calls the tool or is continued.

## Commands

| Command | Effect |
|---|---|
| `/lock-continue-watchdog` | Start a fresh lock cycle (notifies `Continue watchdog locked`) |
| `/unlock-continue-watchdog [reason]` | Unlock now; cancel an exact current watchdog-owned run and clean its residue; optional reason is kept in TUI history |
| `/status-continue-watchdog` | Show current lock/attempt state and why the next check would (not) fire |

A keyboard shortcut (default `alt+u`, configurable via `unlockShortcut`) performs the same ownership-aware unlock as `/unlock-continue-watchdog` without a reason. It never aborts an uncorrelated ordinary user run. While the watchdog is locked, the `Continue Watchdog | …` state row names the effective gesture (for example `enabled · alt+u unlock`).

## Configuration

Precedence: **built-in defaults < global < trusted project**. Files: `~/.pi/agent/pi-continue-watchdog.json` (global) or `<project>/.pi/pi-continue-watchdog.json` (trusted projects only). Invalid fields fall back to lower-precedence values and print a short diagnostic.

```json
{
  "maxRetries": 10,
  "continuePrompt": "Continue until user assistance is required.",
  "reasonTypes": ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
  "unlockShortcut": "alt+u",
  "jevWaitCheck": { "enabled": true, "confidenceThreshold": 0.8, "timeoutMs": 15000 }
}
```

| Key | Default | Rules |
|---|---|---|
| `maxRetries` | `10` | Integer `1`–`10`; automatic continuations per lock cycle |
| `continuePrompt` | `Continue until user assistance is required.` | Non-blank guidance, ≤ 16384 Unicode code points; embedded verbatim in the fixed extension-attributed continuation body |
| `reasonTypes` | `["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"]` | Allowed unlock-tool types; a valid list replaces defaults |
| `unlockShortcut` | `"alt+u"` | Key id for the unlock shortcut, or `false` to disable (the command stays available). Why not `keybindings.json`: Pi exposes no namespaced keybinding ids for extension shortcuts, so plugin config is the only user-level rebinding surface; Pi's native conflict diagnostics still apply to the registered key |
| `jevWaitCheck.enabled` | `true` | Gate is active only when a key resolves; `false` never sends a request |
| `jevWaitCheck.apiUrl` | automatic | Must be an http(s) URL. `https://api.typesafe.ai/v1/systemone` or `https://openrouter.ai/api/v1/systemone`; unset tries TypeSafe then OpenRouter; a custom URL uses only `apiKey` |
| `jevWaitCheck.model` | `"jev-latest"` | jev model id |
| `jevWaitCheck.confidenceThreshold` | `0.8` | Number in `[0, 1]` |
| `jevWaitCheck.timeoutMs` | `15000` | Integer ≥ `1000`; the request is not retried |
| `jevWaitCheck.apiKey` | none | **Global file only**; a project value is ignored with a diagnostic |
| `idleDelaySeconds` | `10` | **Deprecated**, accepted but ignored; the idle fence is fixed at 10 seconds |

The removed keys `decisionPrompt` and `continueReasonTypes` are **errors**: when present, the extension reports an explicit diagnostic naming the key and it has no effect. Remove them from your configuration.

Built-in type meanings:

- `JOB_DONE` — all work complete; `WAIT_USER` — user input/decision needed; `JOB_BLOCKED` — cannot proceed for another concrete reason; `WAIT_CALLBACK` — waiting for another agent or program to call back and wake the agent. Notification consumers can filter it out (see pi-notify binding `if`).

Reason types are trimmed and matched case-insensitively against the configured list. Configured list entries must be nonblank but have no identifier regex or artificial per-entry length limit. Tool `reason` is trimmed, must be nonblank, and may contain at most 1000 Unicode characters. Human `/unlock-continue-watchdog` stays untyped.

The continuation event is a visible custom message; Pi exposes it to providers with user role, so its immutable body explicitly identifies extension automation, denies that it is a user request, approval, confirmation, consent, or authorization, and requires the agent to stop at any new user-input or approval boundary. Human rendering displays that stored body rather than independently reformatting it.

## Notifications for other extensions

On Pi's public event bus (`pi:semantic-hook:v1`), the watchdog publishes:

- `watchdog-continued` — after each durably published automatic continuation; it carries no values.
- `user-ready` — once when a terminal aggregate-idle state is reached: unlock tool (`AI_UNLOCK`), terminal-error automatic unlock (`ERROR_UNLOCK`), or budget exhausted (`EXHAUSTED`). Only `AI_UNLOCK` includes `REASON_TYPE` and `REASON`; `ERROR_UNLOCK` and `EXHAUSTED` carry only `STOP_KIND`. Publication waits for busy children and process-domain idle confirmation. Manual unlock and user abort remain silent.

Delivery is best-effort; no consumer is required or waited for.

## Scope and limits

- Coverage means all Pi processes that loaded this extension and inherited the root's process domain. Sessions that strip their environment or don't load the watchdog are outside coverage.
- Only the elected main session decides; other attachments only observe. A UI-bound session wins main; otherwise the first-bound attachment is the best-effort main.
- Lock state is runtime-only: it is not restored after a process restart, and a fresh process starts unlocked. New automatic-continue and exhaustion results are persistent shared conversation events, subject to Pi's normal active-branch and compaction behavior. Pre-upgrade records — including wait, completed-wait, AI-unlock, decision-failure events and inquiry exchanges — remain readable and stay folded out of provider context, but are never rewritten, backfilled into model history, assigned invented timestamps, or used to restore timers.
- The unlock tool is registered only in root processes and never unregistered; its execution effect is main-only.
- The only external network connection is the optional jev wait gate (see Privacy). Cross-process coordination uses an authenticated loopback transport local to this machine; continuation turns go through the session's normal Pi provider.

## Development

Behavior contract: [`docs/behavior-contract.md`](docs/behavior-contract.md) · Architecture: [`docs/architecture.md`](docs/architecture.md)

```bash
npm ci
npm run check      # lint, typecheck, unit tests, build
npm run test:e2e   # packed install + stock Pi E2E
```

## Privacy

When a TypeSafe or OpenRouter key is available and `jevWaitCheck.enabled` is not `false`, the visible text of the final assistant message (never tool arguments/results, thinking, system prompt, or earlier messages; the key is redacted) is sent to that provider before an automatic continuation. Otherwise the extension opens no external network connections. Cross-process coordination uses authenticated loopback sockets on this machine only; continuation turns use the session's normal Pi model provider. Automatic result events use one immutable timestamped body for both human history and model context. Raw hidden model output, provider errors, TUI-only legacy entries, and audit records are not promoted into that shared timeline.
