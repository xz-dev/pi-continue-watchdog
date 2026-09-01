# pi-continue-watchdog

Pi extension that keeps your agent working. When all agent sessions go idle, it briefly asks the main agent whether to **continue**, **wait**, or **unlock** — so work never stops silently without a reason.

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
2. **Idle detection.** The watchdog watches the main session plus all child Pi processes it spawned. When everything appears idle, it waits a fixed **10 seconds** to make sure nothing new starts, then opens a short **decision check**.
3. **The decision check** is an automated question to the main agent — not a user message. It may briefly stream in the TUI; when it ends, the exchange is removed from both TUI history and future model context, so conversations stay clean. The agent answers from existing context (no tool calls) with exactly one XML block:
   - **Continue** — work remains, keep going:

     ```xml
     <watchdog><function>continue_watchdog</function><reason_type>WORK_REMAINS</reason_type><reason_content>Implementation work remains.</reason_content></watchdog>
     ```

   - **Wait** — external automation (CI, subagent, timer) hasn't finished; pause without a work turn:

     ```xml
     <watchdog><function>wait_watchdog</function><reason_content>Waiting for CI.</reason_content><wait_seconds>300</wait_seconds></watchdog>
     ```

   - **Unlock** — work is done or blocked; hand control back to the user:

     ```xml
     <watchdog><function>unlock_continue_watchdog</function><reason_type>JOB_DONE</reason_type><reason_content>All requested work is complete.</reason_content></watchdog>
     ```

   Typing a message during the check preempts it immediately; your message runs and the check is discarded.

   If another decision check opens before an ordinary agent turn finishes successfully, the new check receives a bounded, chronological list of normalized prior watchdog results as **model-generated reference only**. Errored, aborted, length-limited, and intermediate tool-use attempts do not clear that list; a successful ordinary turn does. Raw hidden answers, XML, partial output, provider errors, TUI text, and audit records are never replayed. If the list is too large, the oldest complete summaries are omitted and their count is reported.
4. **Continue.** The decision folds into the compact prompt `Continue until user assistance is required.` and work resumes without user input. Every accepted continue is recorded in TUI history (`Continue watchdog continued · <TYPE> · <reason>`) so repeated continuations stay visible.
5. **Wait.** Has no reason type. It requires a reason and an integer `wait_seconds` from 1 to 1800 (no clamping — invalid values are rejected). It consumes one shared attempt, keeps the lock, folds the exchange to nothing, and suppresses further checks until the deadline passes. If the agent stays active, the wait is not restarted. Unlock or a new user message cancels it.
6. **Unlock.** Records one muted TUI line (`Continue watchdog unlocked · <TYPE> · <reason>`) and stops automatic continuation. No extra work turn is started.
7. **Limits.** Invalid XML gets re-asked up to **3 attempts**, then the watchdog stops asking until a new user message or manual lock. Each lock cycle allows up to **10** valid continue/wait outcomes. If the final outcome is a wait, the stop signal fires only after that wait fully expires.

The extension never blindly continues: it asks first, so finished work can unlock cleanly and external automation can be awaited without a wasted turn.

## Commands

| Command | Effect |
|---|---|
| `/lock-continue-watchdog` | Start a fresh lock cycle (notifies `Continue watchdog locked`) |
| `/unlock-continue-watchdog [reason]` | Unlock now; optional reason is kept in TUI history |
| `/status-continue-watchdog` | Show current lock/attempt state and why the next check would (not) fire |

## Configuration

Precedence: **built-in defaults < global < trusted project**. Files: `~/.pi/agent/pi-continue-watchdog.json` (global) or `<project>/.pi/pi-continue-watchdog.json` (trusted projects only). Invalid fields fall back to lower-precedence values and print a short diagnostic.

```json
{
  "maxRetries": 10,
  "decisionPrompt": "…default shown below…",
  "continuePrompt": "Continue until user assistance is required.",
  "reasonTypes": ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"],
  "continueReasonTypes": ["WORK_REMAINS", "VERIFYING"]
}
```

| Key | Default | Rules |
|---|---|---|
| `maxRetries` | `10` | Integer `1`–`10`; valid continue/wait outcomes per lock cycle |
| `decisionPrompt` | see below | Non-blank, ≤ 16384 Unicode code points |
| `continuePrompt` | `Continue until user assistance is required.` | Non-blank, ≤ 16384 Unicode code points |
| `reasonTypes` | `["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"]` | Allowed unlock types; a valid list replaces defaults |
| `continueReasonTypes` | `["WORK_REMAINS", "VERIFYING"]` | Allowed continue types; same replace semantics |
| `idleDelaySeconds` | `10` | **Deprecated**, accepted but ignored; the idle fence is fixed at 10 seconds |

Built-in type meanings:

- Unlock: `JOB_DONE` — all work complete; `WAIT_USER` — user input/decision needed; `JOB_BLOCKED` — cannot proceed for another concrete reason.
- Continue: `WORK_REMAINS` — actionable work remains; `VERIFYING` — verification in progress.
- Passive waiting for external automation is expressed with `wait_watchdog`, not a continue type.

Reason types are trimmed and matched case-insensitively against their configured lists. Configured list entries must be nonblank but have no identifier regex or artificial per-entry length limit. Reason content is trimmed, must be nonblank, and may contain at most 500 Unicode characters. Human `/unlock-continue-watchdog` stays untyped.

## Notifications for other extensions

On Pi's public event bus (`pi:semantic-hook:v1`), the watchdog publishes:

- `watchdog-continued` — after each durably recorded continue (`REASON_TYPE`, `REASON`).
- `user-ready` — once when a terminal idle state is reached: AI unlock (`AI_UNLOCK`), budget exhausted (`EXHAUSTED`), or three invalid decisions (`DECISION_FAILED`).

Delivery is best-effort; no consumer is required or waited for.

## Scope and limits

- Coverage means all Pi processes that loaded this extension and inherited the root's process domain. Sessions that strip their environment or don't load the watchdog are outside coverage.
- Only the elected main session decides; other attachments only observe. A UI-bound session wins main; otherwise the first-bound attachment is the best-effort main.
- Lock and wait state is runtime-only: it is not restored after a process restart, and a fresh process starts unlocked. Decision outcomes are recorded as persistent session/TUI audit entries for visibility. Those audit entries remain excluded from Agent/provider context; only bounded normalized prior results may be added explicitly to a later back-to-back watchdog decision prompt.
- Decision XML control is main-only; ordinary tools are blocked only while a decision is open.
- No external network connections are opened. Cross-process coordination uses an authenticated loopback transport local to this machine; all model traffic goes through the session's normal Pi provider.

## Development

Behavior contract: [`docs/behavior-contract.md`](docs/behavior-contract.md) · Architecture: [`docs/architecture.md`](docs/architecture.md)

```bash
npm ci
npm run check      # lint, typecheck, unit tests, build
npm run test:e2e   # packed install + stock Pi E2E
```

## Privacy

The extension opens no external network connections. Cross-process coordination uses authenticated loopback sockets on this machine only; decision and continuation turns use the session's normal Pi model provider, and waits start no additional model turn. Back-to-back decision history is limited to normalized terminal fields labeled as model-generated reference data; raw hidden model output, XML, provider errors, TUI text, and audit records are not restored.
