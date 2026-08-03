# pi-continue-watchdog

Pi extension that notices when all same-process extension-loaded observable agents are idle and asks the main AI to continue or intentionally unlock, so work does not stop without explanation.

**Status:** live source package. This project has no versioned releases; users track the latest `master` commit.

**License:** [BSD-3-Clause](./LICENSE)

## Requirements

- Node.js `>= 22.19`
- Pi coding agent (tested with `@earendil-works/pi-coding-agent` `0.83.0`)
- No other plugin dependencies

## Install

Source entry: `pi.extensions` → `./src/extension.ts`.

```bash
pi install git:github.com/xz-dev/pi-continue-watchdog
```

This unpinned Git source intentionally tracks the latest repository state. Use `pi update --extensions` to update installed Pi packages. The project does not publish npm versions, tags, or GitHub Releases.

Reload Pi extensions or start a new session after install.

## How it works

Observable behavior only (implementation details may change):

1. Whenever the **main agent starts running**, the continue watchdog ensures it is locked. If already locked, the current cycle is preserved. A real main user message silently starts a fresh lock cycle.
2. While locked, after **all observable** same-process agents stay idle for the current delay, the extension re-checks true idle and opens a short **decision check** on main—regardless of whether Pi stopped normally, after compaction, or because of a Provider/extension error.
3. The decision is a **hidden automated** custom message (not a user message). For that check only, the model may call exactly one of:
   - `continue_watchdog` — keep working
   - `unlock_continue_watchdog` with a concise reason — stop automatic checks
4. **Continue** injects the compact prompt `Continue until user assistance is required.` (configurable) and ordinary work resumes without further user input.
5. **Unlock with a reason** shows one muted persistent TUI line, `Continue watchdog unlocked · <reason>`, with no duplicate transient notification, and does **not** start another work turn. Future model context drops the decision exchange.
6. A decision gets up to **3 total attempts**. A decision turn that settles without a verifiable result counts as invalid. After the third invalid/no-result response, the extension stays locked/failed until a new main user message or manual lock.
7. After each valid continue, the next idle delay doubles: default **3s, 6s, 12s, …** up to **10** valid continues per lock cycle.
8. An **aborted** main run unlocks immediately (reasonless). Child stop reasons are never inspected.

Design note: the extension does **not** blindly continue. It asks first so completed or intentionally waiting work can unlock cleanly.

## Commands

| Command | Effect |
|---|---|
| `/lock-continue-watchdog` | Lock, reset attempt counters, TUI: `Continue watchdog locked` |
| `/unlock-continue-watchdog [reason]` | Set unlocked and cancel pending checks while preserving cycle counters/failure state. Blank reason: notify `Continue watchdog unlocked`; nonblank reason: persist one muted `Continue watchdog unlocked · <reason>` entry |

Same-state commands still assign and still notify (no silent no-op). Only `/lock-continue-watchdog` semantics reset the cycle; a real main user message applies those semantics silently.

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
Continue until user assistance is required.
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
  "continuePrompt": "Continue until user assistance is required."
}
```

| Key | Default | Range / rules |
|---|---|---|
| `idleDelaySeconds` | `3` | Any finite number `≥ 0`; `0` schedules a 0 ms timer and fractions are allowed |
| `maxRetries` | `10` | Safe integer `1`–`10` (valid continues per lock cycle) |
| `decisionPrompt` | see above | Non-blank, ≤ **16384** Unicode code points |
| `continuePrompt` | `Continue until user assistance is required.` | Non-blank, ≤ **16384** Unicode code points |

Invalid re-ask budget is fixed at **3** (not configurable).

Delay for continue attempt `N` (1-based, advances only on **valid continue**):

```text
delaySeconds(N) = idleDelaySeconds × 2^(N - 1)
```


## Neutral `user-ready` semantic hook

When the elected main attachment reaches a **terminal aggregate-idle** epoch where this extension will not start another automatic decision or continue run, it publishes one fresh plain-data envelope on Pi's public bus:

- Channel: `pi:semantic-hook:v1`
- Envelope name: `user-ready`
- Values by stop kind:
  - AI decision unlock: `{ "STOP_KIND": "AI_UNLOCK", "REASON": "<validated reason>" }`
  - Max valid continues exhausted: `{ "STOP_KIND": "EXHAUSTED" }`
  - Third invalid decision: `{ "STOP_KIND": "DECISION_FAILED" }`

Publication is at most once per such terminal idle epoch. It does **not** publish for human `/unlock-continue-watchdog`, abort unlock, valid continue, intermediate decision states, or ordinary unlocked idle. The producer does not import, identify, require, or wait for any consumer (including pi-notify). Delivery is best-effort current-listener-only with no ack, retry, or replay.

## Scope and limitations

- **“All agents”** means same-process sessions that loaded this extension and are known to its process-local hub. Isolated, out-of-process, or non-extension children may be absent.
- **Main election:** UI-bound session wins; pure headless uses first-bound attachment as best-effort main.
- **Lock state is runtime-only.** A new process/session attachment begins unlocked until its current main agent starts. Nothing is written to disk, and shutdown cancels runtime activity.
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
