## Why

At idle, the watchdog currently asks the model a hidden decision question and expects exactly one XML answer (`continue_watchdog` / `wait_watchdog` / `unlock_continue_watchdog`). Models produce that XML unreliably. Overlapping vocabulary (STOP/LOCK/WAIT labels, three function names, `WAIT_USER` vs `wait_watchdog`) also leads to wrong decisions. The inquiry, re-asks, folding, and wait timing account for most of the runtime's complexity. A native tool call is a more reliable way for the model to say it is done. If the model has not said so, the extension can simply continue it without asking first.

## What Changes

This change replaces only the two communication channels:
- **AI to extension:** the model calls a tool instead of writing an XML answer.
- **Extension to AI:** the extension sends a single continuation message instead of a question plus a result event.

Main-agent election, cross-process idle aggregation, the fixed 10-second fence, auto-lock, abort and terminal-error unlock, manual unlock and shortcut, the retry budget and exhaustion all behave as before.

- Add one always-registered model tool, `unlock_continue_watchdog`, in root Pi processes only.
  - Parameters: `reason_type` (one of the configured `reasonTypes`) and `reason` (non-empty, at most 1000 Unicode code points).
  - Its description tells the model it must call this tool to signal that work is complete or that user action is required; otherwise it will be continued automatically.
  - A valid call from the current main agent unlocks the watchdog, publishes `user-ready` with `STOP_KIND=AI_UNLOCK`, `REASON_TYPE`, and `REASON`, and ends the run without a follow-up model request.
- When the locked main agent qualifies for the existing post-idle check, the watchdog no longer asks a question. It directly publishes one attributed continuation message that starts the next turn and consumes one retry attempt.
  - The message stays a visible extension event block, never a user-authored message.
  - It tells the model to call `unlock_continue_watchdog` if work is complete or the user is needed, and otherwise to continue remaining work.
  - If the model needs to wait for something, it should block on or monitor that task directly, or sleep for its estimated duration.
- `watchdog-continued` is still published once per continuation, but as a simple signal that carries no values.
- **BREAKING** Remove the XML decision protocol, including:
  - the decision prompt and parser;
  - invalid-response re-asks and `decision-failed`;
  - tool blocking during decisions;
  - continue reason types.
- **BREAKING** Remove the `wait` outcome, together with:
  - wait deadlines and completed-wait timing events;
  - the `watchdog-waiting` hook;
  - the `DECISION_FAILED` `user-ready` kind.
- **BREAKING** `watchdog-continued` no longer carries `REASON_TYPE` or `REASON`.
- **BREAKING** The config keys `decisionPrompt` and `continueReasonTypes` are removed. When either is present, the extension reports an explicit error diagnostic and the key has no effect; it is never silently accepted.
- An AI unlock no longer publishes a separate shared unlock event. The tool call and its result are the only model-visible record.
- New sessions no longer create inquiry prompts, XML answers, or fold records. Old sessions that contain them are still folded read-only, so raw decision internals do not return to context when the session is resumed.

## Capabilities

### New Capabilities
- `ai-unlock-tool`: the model-facing unlock tool contract, covering registration scope, parameters, validation, main-agent effect, run termination, presentation, and the `AI_UNLOCK` hook.
- `watchdog-semantic-hooks`: the complete set of published semantic hooks and their values after this change.
- `watchdog-configuration`: the effective configuration keys, including the error diagnostic for removed keys.

### Modified Capabilities
- `automated-continuation-message`: the continuation is sent directly without an inquiry. It carries no model-generated reason, explains the unlock tool and how to wait, and keeps attribution and the authorization boundary.
- `terminal-outcome-gate`: a successful settlement now enters automatic continuation instead of a decision inquiry.
- `watchdog-event-timeline`: shared events are reduced to the continuation and exhaustion events. Wait timing, AI-unlock, and decision-failure events are removed, and legacy inquiry records stay folded read-only.
- `decision-response-contract`: all requirements are removed.
- `watchdog-waiting-hook`: all requirements are removed.

## Impact

- Code in this repo:
  - `src/runtime.ts`, `src/decision-protocol.ts`, `src/context-fold.ts`, `src/watchdog-event.ts`, `src/semantic-hook.ts`, `src/config.ts`, `src/controller.ts`, `src/commands.ts`, and `src/extension.ts`.
  - The `pi-extension-utils/xml` dependency is removed. `pi-inquiry` is kept only for legacy folding.
- Tests: unit, runtime, and packed E2E suites are rewritten for the tool and direct-continuation flow.
- Docs: `README.md`, `docs/architecture.md`, `docs/behavior-contract.md`, and the affected `docs/programming-thinking/*.idea.lean` models.
- Downstream consumers:
  - The `pi-notify` repo's watchdog example, ntfy/Bark helpers, skill, README, and tests.
  - The user's local `~/.pi/agent/pi-notify.json` and `~/.pi/agent/pi-notify-delivery.mjs`.
  - These drop `wait` and `DECISION_FAILED`, and switch `continue` to a simple notification.
- No new dependency, and no change to the Pi version requirement.
