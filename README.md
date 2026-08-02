# pi-continue-watchdog

Pi extension that notices when all same-process extension-loaded observable agents are idle and asks the main AI to continue or intentionally unlock, so work does not stop without explanation.

**Status:** source package (pre-publication). Not published to npm. GitHub hosting is planned as `xz-dev/pi-continue-watchdog`.

**License:** [BSD-3-Clause](./LICENSE)

## Requirements

- Node.js `>= 22.19`
- Pi coding agent (tested with `@earendil-works/pi-coding-agent` `0.83.0`)
- No other plugin dependencies

## Install

Source entry: `pi.extensions` → `./src/extension.ts`.

```bash
# Local clone / path
pi install /path/to/pi-continue-watchdog

# After the public repository exists
pi install git:github.com/xz-dev/pi-continue-watchdog
```

Reload Pi extensions or start a new session after install.

## How it works

Observable behavior only (implementation details may change):

1. When a **main** user message actually starts processing, the continue watchdog **auto-locks**.
2. While locked, after **all observable** same-process agents stay idle for the current delay, the extension opens a short **decision check** on main.
3. The decision is a **hidden automated** custom message (not a user message). For that check only, the model may call exactly one of:
   - `continue_watchdog` — keep working
   - `unlock_continue_watchdog` with a concise reason — stop automatic checks
4. **Continue** injects the compact prompt `Continue until all jobs are done.` (configurable) and ordinary work resumes without further user input.
5. **Unlock** shows the reason in the TUI and does **not** start another work turn. Future model context drops the decision exchange.
6. A decision gets up to **3 total attempts**. After the third invalid response, the extension stays locked/failed until a new main user message or manual lock.
7. After each valid continue, the next idle delay doubles: default **3s, 6s, 12s, …** up to **10** valid continues per lock cycle.
8. An **aborted** main run unlocks automatically (reasonless), same as manual unlock without a reason.

Design note: the extension does **not** blindly continue. It asks first so completed or intentionally waiting work can unlock cleanly.

## Commands

| Command | Effect |
|---|---|
| `/lock-continue-watchdog` | Lock, reset attempt counters, TUI: `Continue watchdog locked` |
| `/unlock-continue-watchdog [reason]` | Unlock, cancel pending checks, TUI: `Continue watchdog unlocked` or `Continue watchdog unlocked: <reason>` |

Same-state commands still assign and still notify (no silent no-op).

Human unlock reason is optional: trimmed and truncated to 500 Unicode characters; multiline allowed. Nonblank reasons also appear as a TUI-only history entry (not model context).

## Decision tools (main, decision window only)

| Tool | Args | Meaning |
|---|---|---|
| `continue_watchdog` | `{}` | Continue work |
| `unlock_continue_watchdog` | `{ "reason": string }` | Unlock with reason (non-empty, ≤ 500 characters after trim) |

Outside a decision window these tools are not part of the normal active tool set. Definitions may remain registered but are not offered for ordinary turns.

Default decision prompt (configurable):

```text
This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. Decide whether work should continue. Call unlock_continue_watchdog with a concise reason if you are intentionally waiting for the user or all tasks are complete. Otherwise call continue_watchdog. Call exactly one tool and do not answer with prose.
```

Default continue prompt (configurable):

```text
Continue until all jobs are done.
```

Decision-failed TUI warning:

```text
Continue watchdog decision failed after 3 attempts: <last error>
```

## Configuration

Precedence: **built-in defaults < global < trusted project**.

| Path | When |
|---|---|
| `$PI_CODING_AGENT_DIR/pi-continue-watchdog.json` | Global (default agent dir `~/.pi/agent`) |
| `<cwd>/.pi/pi-continue-watchdog.json` | Only when the project is **trusted** by Pi |

Project config is ignored when the project is untrusted. Missing files are silent. Invalid fields fall back to the next lower valid value and emit a short diagnostic; they do not wipe other valid fields.

```json
{
  "idleDelaySeconds": 3,
  "maxRetries": 10,
  "decisionPrompt": "This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. Decide whether work should continue. Call unlock_continue_watchdog with a concise reason if you are intentionally waiting for the user or all tasks are complete. Otherwise call continue_watchdog. Call exactly one tool and do not answer with prose.",
  "continuePrompt": "Continue until all jobs are done."
}
```

| Key | Default | Range / rules |
|---|---|---|
| `idleDelaySeconds` | `3` | Safe integer `1`–`3600` |
| `maxRetries` | `10` | Safe integer `1`–`10` (valid continues per lock cycle) |
| `decisionPrompt` | see above | Non-blank, ≤ **16384** Unicode code points |
| `continuePrompt` | `Continue until all jobs are done.` | Non-blank, ≤ **16384** Unicode code points |

Invalid re-ask budget is fixed at **3** (not configurable).

Delay for continue attempt `N` (1-based, advances only on **valid continue**):

```text
delaySeconds(N) = idleDelaySeconds × 2^(N - 1)
```

## Scope and limitations

- **“All agents”** means same-process sessions that loaded this extension and are known to its process-local hub. Isolated, out-of-process, or non-extension children may be absent.
- **Main election:** UI-bound session wins; pure headless uses first-bound attachment as best-effort main.
- **Lock state is runtime-only.** It resets unlocked on reload, new session, resume, restart, and shutdown. Nothing is written to disk for lock state.
- **No dependence** on pi-subagents, pi-watchdog, pi-notify, or any other plugin.
- Decision tools are main-only controls during the decision window.

## Context cleanliness

After a valid continue or unlock, future **model-bound** context drops the raw decision exchange. Continue replaces it with the compact continue prompt; unlock replaces it with nothing. The raw session file may still keep protocol records for audit. This is a Pi context-hook limitation, not full session erasure.

## Development

```bash
npm ci
npm run check      # lint, typecheck, unit tests, build
npm run test:e2e   # packed isolated install + stock Pi E2E (includes real 3s idle path)
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check`, and `npm run test:e2e` on `master` push and pull requests.

## Privacy

The extension does not open its own network connections. Decision and continue turns use the normal Pi model provider path already configured for the session.
