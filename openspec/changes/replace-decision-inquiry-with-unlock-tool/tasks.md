## 1. Configuration

- [x] 1.1 In `src/config.ts`, remove `decisionPrompt` and `continueReasonTypes` from the config shape, defaults, `KNOWN_KEYS`, and merge. Add a severity to `ConfigDiagnostic`. Emit a named removed-key `error` diagnostic for each of the two keys, separate from the generic unsupported-key diagnostic. Verify with `test/config.test.ts` cases for each removed key: other valid keys still apply, and the diagnostic text names the key.
- [x] 1.2 Pass the diagnostic severity through the runtime config notify loop (`ctx.ui.notify(message, severity)`). Verify with a runtime test that a removed key surfaces as an `error` notification.

## 2. Controller

- [x] 2.1 In `src/controller.ts`, replace the decision-window transitions (`openDecision`, `recordInvalidDecision`, `recordValidWait`, and decision-id arguments) with two transitions:
  - `recordAutomaticContinue()`: attempt increment and exhaustion;
  - an AI unlock that needs no decision id.

  Lock, unlock, cycle restart, and exhaustion semantics stay unchanged. Verify with an updated `test/controller.test.ts` covering budget counting, exhaustion at `maxRetries`, and unlock clearing pending state.

## 3. Unlock tool

- [x] 3.1 Add the `unlock_continue_watchdog` tool module:
  - a TypeBox schema with `reason_type` (an enum of the effective `reasonTypes`) and `reason` (1 to 1000 code points after trimming);
  - a description stating the call-to-stop obligation and the automatic continuation consequence;
  - a compact call and result renderer.

  Verify with unit tests of schema contents and of description wording.
- [x] 3.2 Register the tool once, in root processes only, when the config is ready. Implement `execute`:
  - invalid arguments throw a named constraint error;
  - a non-main caller or an unlocked watchdog gets an informational result;
  - a locked main agent gets the AI unlock transition, cleared pending continuation, a deferred `user-ready` `AI_UNLOCK` with `REASON_TYPE` and `REASON`, and `terminate: true`.

  Verify with runtime tests for each branch, for child-process non-registration, and for a tool list that stays stable across lock and unlock.

## 4. Direct continuation

- [x] 4.1 Rewrite `formatContinueWatchdogEvent` and the continue event in `src/watchdog-event.ts`:
  - no reason fields, and optional reason fields when parsing old events;
  - the new unlock and wait guidance text.

  Remove the creators and formatters for the wait, completed-wait, unlock, and decision-failed events, but keep old-event parsing and rendering. Verify with `test/context-fold.test.ts` and the event tests: new body text, and old stored events still parse and render.
- [x] 4.2 In `src/runtime.ts`, replace inquiry dispatch with `dispatchContinuation` at the existing post-fence point:
  - budget check, then a visible `pi-continue-watchdog:continuation` message with `triggerTurn`, `watchdogOwnedRun` correlation, and the `watchdog-continued` hook with empty values;
  - rollback on publish failure or ownership loss.

  Update `handleMessageStart` to correlate direct continuation messages. Verify with runtime tests:
  - a continue after idle;
  - no continue after a tool unlock;
  - exhaustion after `maxRetries`;
  - rollback on failure;
  - manual unlock still cancels a watchdog-owned continuation run.
- [x] 4.3 Delete the decision machinery from `src/runtime.ts` and `src/decision-protocol.ts`: prompt building, the XML parser, re-asks, `tool_call` blocking, inquiry markers, neutralization and quarantine, wait timers and deadlines, completed-wait reporting, and the decision-failed path. Drop the `pi-extension-utils/xml` import, and keep the legacy `registerDecisionContextFolding` read-only. Verify that `npm run check` passes with no references to the removed symbols (`rg -n "wait_watchdog|continue_watchdog|DECISION_FAILED|watchdog-waiting" src` is empty).

## 5. Semantic hooks

- [x] 5.1 In `src/semantic-hook.ts`:
  - `watchdog-continued` gets empty values;
  - `watchdog-waiting` and the `DECISION_FAILED` stop kind are removed.

  Verify with `test/semantic-hook.test.ts`: the hook set matches the `watchdog-semantic-hooks` spec, and the human and abort paths stay silent.

## 6. Tests, docs, models

- [x] 6.1 Rewrite `test/decision-protocol.test.ts`, `test/runtime.test.ts`, `test/observer-only-control.test.ts`, and the packed and cross-process E2E suites for the tool and direct-continuation flow. Verify that `npm test` and the packed E2E suite pass.
- [x] 6.2 Update `README.md`, `docs/architecture.md`, and `docs/behavior-contract.md` (including the rule 8 matrix). Update the affected `docs/programming-thinking/*.idea.lean` models and validate them. Verify that `rg -n -i "xml|wait_watchdog|decision inquiry" README.md docs` only returns legacy or compatibility mentions.

## 7. pi-notify repo (`~/Code/ai/pi-notify`)

- [x] 7.1 Update `example/pi-notify-ntfy.mjs` and `example/pi-notify-bark.mjs`:
  - `continue` sends a fixed `▶️ Pi Continue` message with no required fields;
  - the `wait` mode is removed;
  - the `DECISION_FAILED` branch is removed.

  Update `test/ntfy-helper.test.ts` and `test/bark-helper.test.ts` to match. Verify that the pi-notify test suite passes.
- [x] 7.2 Update `example/pi-continue-watchdog.md` (contract table, config snippet, verification steps), `example/pi-notify-ntfy.md`, `example/pi-notify-bark.md`, the README watchdog snippet, and `skills/adapt-pi-notify-skill/SKILL.md`. Update `test/skill.test.ts` to match. Verify that the tests pass and that `rg -n "watchdog-waiting|DECISION_FAILED|WAIT_SECONDS" README.md example skills` returns nothing.

## 8. Local configuration

- [x] 8.1 Back up `~/.pi/agent/pi-notify.json` and `~/.pi/agent/pi-notify-delivery.mjs` to timestamped `.bak` files, then update both:
  - `watchdog-continued` becomes an unconditional bel plus a `▶️ Pi Continue` osc, and the delivery `continue` mode sends a fixed message;
  - the `watchdog-waiting` hook and `wait` mode are removed;
  - the `DECISION_FAILED` branches are removed.

  Verify that `python3 -m json.tool` parses the config and that `node --check` passes on the delivery script.
