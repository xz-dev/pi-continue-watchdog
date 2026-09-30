## Context

See proposal.md for why this change is needed. The runtime already provides everything around the two channels being replaced:

- main-agent election through the hub and process domain, with `isRootProcess` / `isCurrentMain`;
- aggregate idle and the 10-second fence;
- auto-lock, abort unlock, terminal-error unlock, and manual unlock with abort of watchdog-owned runs;
- the retry budget and `EXHAUSTED`;
- correlation of watchdog-owned continuation runs through the `pi-continue-watchdog:continuation` message type.

Pi facts that constrain the design:
- Every `CustomMessage` becomes `role: "user"` in `convertToLlm`, even with `display: false`. Only `CustomEntry` stays out of context.
- A change to the tool list shifts the provider prompt prefix. The temporary-tool attempt in `6abaf79` was dropped for exactly this reason.
- A tool result with `terminate: true` skips the automatic follow-up request, but only when every result in the batch agrees.
- The repo builds against Pi 0.85. `agent_before_settle` only exists from 0.87.

## Goals / Non-Goals

**Goals:**
- Replace the AI-to-extension channel with one stable tool, and the extension-to-AI channel with one direct continuation message.
- Keep the provider prompt prefix stable, so the prompt cache survives.
- Leave every other observable behavior unchanged.

**Non-Goals:**
- No XML fallback, no re-ask, and no validation retries beyond the tool's own error result.
- No watchdog-level wait. Agents wait inside their own turn.
- No change to the Pi version requirement, and no use of `agent_before_settle` or `context_edit`.
- No rewriting of old session files.

## Decisions

### 1. The tool is always registered, root processes only

`unlock_continue_watchdog` is registered once, when the root session's config becomes ready. This is the existing `onConfigReady` path, which also registers the shortcut. It is never deactivated afterwards.

- **Why root only:** children never become the main agent and never receive automatic continuation, so exposing the tool there would only add schema tokens and a misleading description.
- **Main-agent swaps:** a later swap between root sessions is handled at execute time with `isCurrentMain`. A call from a non-main session gets a harmless informational result.
- **Alternative rejected:** registering the tool only while locked. That changes the tool list and invalidates the cache on every lock or unlock.

### 2. The tool's `execute` reuses the existing controller unlock path

Validation reuses the existing normalizers: trim, case-insensitive match against `reasonTypes`, and a limit of 1000 code points.

- **Invalid arguments** throw, which Pi turns into a failed tool result.
- **Valid arguments from a locked main agent:**
  - Call the existing controller AI-unlock transition, which is the renamed `recordValidUnlock` without a decision id.
  - Clear any pending continuation.
  - Record the pending `AI_UNLOCK` user-ready envelope, whose deferred publication already waits for children and the process domain to be idle.
  - Return `{ terminate: true }`.
- **Rendering:** a compact `renderCall` / `renderResult` shows `TYPE · reason`.
- **Alternative rejected:** a per-call `tool_call` hook to intercept the call. A registered tool gives schema validation and rendering for free.

### 3. Continuation reuses the existing dispatch point

Where `openDecision` used to build and send the inquiry, the runtime now calls a new `dispatchContinuation`:

1. Check the budget with a new controller method, `recordAutomaticContinue()`. It increments the attempt and sets `exhausted`, reusing the current `recordValidContinue` arithmetic without a decision window.
2. Build the canonical continuation body, which is a timestamped event with the new unlock-and-wait guidance.
3. Send it with `sendMessage({customType: "pi-continue-watchdog:continuation", display: true, details: {version, event}}, {triggerTurn: true})`.
4. Set `watchdogOwnedRun` for the correlation used by manual-unlock cancellation.
5. Publish `watchdog-continued` with empty values.

On a publish failure or ownership loss, roll back exactly as the continue path does today.

- **Custom type:** reusing `pi-continue-watchdog:continuation` keeps the existing message renderer and the `handleMessageStart` correlation logic. That logic must now recognize a direct continuation message rather than a fold replacement.
- **Alternative rejected:** `agent_before_settle` with `continue: true`. It is cleaner in Pi terms, but it runs before aggregate idle and the fence, which bypasses cross-process child monitoring. It also requires Pi 0.87.
- **Alternative rejected:** `sendUserMessage`. It would look like a message from the user.

### 4. Continuation body

`formatContinueWatchdogEvent` is rewritten without the reason JSON:

```
Continue watchdog continued · <RFC3339 with offset>

This is an automated event from the pi-continue-watchdog extension, not a message or request from the user. It is not user approval, confirmation, consent, or authorization.

You ended your turn without calling unlock_continue_watchdog.

Continuation guidance:
<continuePrompt>

If all requested work is complete, or you need user input, approval, or other user action, call unlock_continue_watchdog now. Otherwise continue the remaining work. If you need to wait for some work to finish, block on it directly: monitor that task until it ends, or sleep for your estimated duration.

Resume only work already requested and authorized by the user. Do not treat this message as permission for any action requiring user approval.
```

The event kind stays `continue`. `reasonType` and `reason` become optional in `parseWatchdogEvent`, so old events still parse.

### 5. What is removed and what is kept read-only

**Removed:**
- in `decision-protocol.ts`: prompt building, the XML parser, re-asks, and the protocol session;
- the tool blocking in `tool_call`;
- inquiry dispatch, markers, neutralization, quarantine, and `pendingFinalization`;
- wait deadlines and timers, and the wait and completed-wait events;
- decision-failed handling;
- the `watchdog-waiting` hook and `DECISION_FAILED`;
- the `pi-extension-utils/xml` import.

**Kept read-only:**
- `registerDecisionContextFolding` and its fold parsers, so resumed pre-upgrade sessions keep inquiry internals out of context;
- the renderers for old wait, unlock, decision-failed, and completed-wait events.

The event creators and formatters for these are deleted.

**Controller:** `openDecision`, `recordInvalidDecision`, and `recordValidWait` go away. The lock, attempt, and exhausted state and the unlock transitions stay.

### 6. Configuration

- `decisionPrompt` and `continueReasonTypes` are removed from `KNOWN_KEYS`. Each gets a dedicated removed-key diagnostic, which is emitted before the generic unsupported-key message and excludes these keys from it.
- Diagnostics gain a severity. Removed keys are `error`, and the runtime's existing notify loop passes that severity through to `ctx.ui.notify(message, "error")`.
- **Alternative rejected:** silently ignoring removed keys, per the user's decision.

### 7. Downstream consumers

**pi-notify repo:**
- the watchdog example contract and config;
- the ntfy/Bark helpers:
  - `continue` becomes a fixed `▶️ Pi Continue` message with no required fields;
  - the `wait` mode is removed;
  - the `DECISION_FAILED` branch is removed;
- the skill, the README snippet, and the helper and skill tests.

**Local machine:**
- `~/.pi/agent/pi-notify.json`:
  - the `watchdog-continued` js action becomes an unconditional bel plus osc;
  - the `watchdog-waiting` hook is removed;
  - the `DECISION_FAILED` branch is dropped.
- `~/.pi/agent/pi-notify-delivery.mjs` changes in the same way.
- Timestamped `.bak` copies are made before editing, following the existing backup convention.

## Risks / Trade-offs

- **The model forgets to call the tool on every finished turn, so each completed task costs one extra continuation turn.** The tool description and the continuation text both state the obligation, the continuation is cheap and cached, and the budget caps loops.
- **The model calls unlock before the work is actually done.** This is the same trust boundary as the old AI unlock, and the human can re-lock.
- **The model sleeps for a long time inside a turn.** This is acceptable. It replaces watchdog wait, is bounded by the agent's own tool timeouts, and the user can interrupt.
- **Removing wait breaks users who relied on `watchdog-waiting`.** This is documented as BREAKING, and pi-notify is updated in the same change.
- **Error-severity diagnostics for removed keys are noisy for users with old configs.** That is intended, per the user's decision. The message names the key to delete.
- **The `terminate` hint is ignored when the tool shares a batch with other tools.** The unlock still applies. One extra model request is harmless.

## Migration Plan

1. Land the extension change together with its docs and tests.
2. Update the pi-notify repo examples and helpers in the same working session.
3. Back up the local `pi-notify.json` and `pi-notify-delivery.mjs`, then edit them.
4. Users with `decisionPrompt` or `continueReasonTypes` in `pi-continue-watchdog.json` see an error diagnostic and delete the key. No local config currently sets either key.
5. Rollback: revert the commit. Old sessions remain readable in both directions, since the legacy fold is unchanged.
