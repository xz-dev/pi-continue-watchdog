# pi-continue-watchdog

Pi extension that notices when every watchdog-loaded Pi process in an inherited authenticated process domain is idle and asks the root AI to continue or intentionally unlock, so work does not stop without explanation.

**Status:** live source package. This project has no versioned releases; users track the latest `master` commit.

**License:** [BSD-3-Clause](./LICENSE)

## Requirements

- Node.js `>= 22.19`
- Current Pi with the public extension `sendMessage` / lifecycle APIs. This watchdog does not require a downstream hidden-presentation seam.
- Uses the exact reviewed Git-pinned `pi-process-domain` library; no dependency on a subagent plugin

## Install

Source entry: `pi.extensions` → `./src/extension.ts`.

```bash
pi install git:github.com/xz-dev/pi-continue-watchdog
```

This unpinned Git source intentionally tracks the latest repository state. Use `pi update --extensions` to update installed Pi packages. The project does not publish npm versions, tags, or GitHub Releases.

The tracked root `.npmrc` sets `allow-git=root`. npm 12 otherwise rejects the exact Git-pinned `pi-process-domain` dependency when Pi installs this cloned Git package. The `root` policy admits only the dependency declared directly by this reviewed package; it does not broadly allow transitive Git dependencies. The package-owned `allowScripts` entry names only `pi-process-domain`; users do not need to relax their npm configuration.

Reload Pi extensions or start a new session after install.

## How it works

Observable behavior only (implementation details may change):

1. Whenever the **main agent starts running**, the continue watchdog ensures it is locked. If already locked, the current cycle is preserved. A real main user message starts a fresh cycle by silently performing a full unlock cleanup first—canceling timers and pending decision work—then locking again to reset old cycle accounting, without either notification.
2. While locked, after every participant in the inherited authenticated process domain stays idle for the current delay, the extension confirms an immutable broker fence and opens a short **decision check** on the root main—regardless of whether Pi stopped normally, after compaction, or because of a Provider/extension error.
3. The decision is an **automated custom message**, not a user message. It may stream in the live TUI/RPC while the check runs. Ordinary active tools and the system-prompt tool list remain unchanged for prompt-cache stability. The model decides quickly from existing conversation knowledge without tools and finishes with exactly one XML block:

   ```xml
   <watchdog><function>continue_watchdog</function></watchdog>
   ```

   or:

   ```xml
   <watchdog>
     <function>unlock_continue_watchdog</function>
     <reason_type>JOB_DONE</reason_type>
     <reason_content>All requested work is complete.</reason_content>
   </watchdog>
   ```

   It may explain first or output only XML, but after trimming the sole `</watchdog>` must be the end of the response. Multiple watchdog blocks are invalid. If it tries an ordinary tool during the decision, the extension blocks execution and reminds it to answer from existing context with XML. Interactive or RPC user input during the check preempts it: the original user message runs exactly once, the aborted decision assistant is cleared, and no `Operation aborted` or `Continue watchdog unlocked` notice is shown. Future model context then drops the preempted exchange.
4. During every decision cycle, a live colored Pi-TUI widget shows `Continue watchdog checking` and the current attempt. Each watchdog validation re-ask and non-watchdog error is also retained as a colored TUI-only event card with its exact safe parser/original error. **Continue** must persist `Continue watchdog continued` before dispatch, so repeated automatic continuation is visible and cannot silently consume tokens; if persistence fails, it fails closed without starting another turn. The complete decision exchange folds into the compact prompt `Continue until user assistance is required.` (configurable), and ordinary work resumes without further user input.
5. **AI unlock** requires an allowed `reason_type` and concise nonblank `reason_content` of at most 500 Unicode code points. It shows one muted persistent TUI line, `Continue watchdog unlocked · <TYPE> · <reason>`, with no duplicate transient notification, and does **not** start another work turn. Future model context drops the complete decision exchange. Human command unlock remains untyped.
6. A decision gets up to **3 total attempts**. An invalid final XML response counts as one attempt; blocked ordinary tool calls and provisional Provider errors that Pi retries within the same run do not. Invalid raw text is not retained. After the third invalid response, the extension stays locked/failed until a new main user message or manual lock, and the failed exchange is folded out of future model context.
7. After each valid continue, the next authoritative all-idle generation waits the same fixed delay: default **10s** each time, up to **10** valid continues per lock cycle.
8. An **aborted** main run unlocks immediately (reasonless). Child stop reasons are never inspected.

Design note: the extension does **not** blindly continue. It asks first so completed or intentionally waiting work can unlock cleanly.

## Commands

| Command | Effect |
|---|---|
| `/lock-continue-watchdog` | Silently perform full unlock cleanup first, then start a fresh lock cycle and emit exactly one TUI notification: `Continue watchdog locked` |
| `/unlock-continue-watchdog [reason]` | Set unlocked and cancel pending checks while preserving cycle counters/failure state. Blank reason: notify `Continue watchdog unlocked`; nonblank reason: persist one muted `Continue watchdog unlocked · <reason>` entry |
| `/status-continue-watchdog` | Show current main/lock/attempt state, trigger blocker, grace phase, observable busy counts, and pending spawns without changing watchdog state |

Same-state commands still assign (no silent no-op). A manual lock always runs the complete unlock-cleanup → fresh-lock sequence even when already unlocked or locked, suppresses prerequisite unlock output, and emits only `Continue watchdog locked`. A direct manual unlock still emits its normal output. Only fresh lock semantics reset the cycle; a real main user message applies the same full sequence with both notifications suppressed. Ordinary main `agent_start` without a new user message remains ensure-lock behavior and preserves an already locked cycle.

Human unlock reason is optional: trimmed and truncated to 500 Unicode characters; multiline allowed. Nonblank reasons also appear as a TUI-only history entry (not model context).

## XML decisions (main decision window only)

Canonical continue output:

```xml
<watchdog><function>continue_watchdog</function></watchdog>
```

Canonical unlock output:

```xml
<watchdog>
  <function>unlock_continue_watchdog</function>
  <reason_type>JOB_DONE</reason_type>
  <reason_content>All requested work is complete.</reason_content>
</watchdog>
```

The final non-thinking assistant text is trimmed, must end in `</watchdog>`, and must contain exactly one watchdog block. The extension extracts from that sole `<watchdog>` opening tag to the end and parses it. Unlock requires an allowed type and a concise nonblank reason of at most 500 Unicode code points. Thinking is ignored. Ordinary tools remain active for prompt-prefix stability but are blocked before execution while this decision is open.

Default decision intent (configurable):

```text
This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. It does not represent any decision by the user. Decide whether work should continue. Before deciding, check whether every task the user requested in this session is complete, including earlier requests and not only the latest one.
```

The extension always appends fixed XML instructions and the effective configured reason types. These instructions require exactly one watchdog block at the response end and never advertise compatibility-only tolerance for surplus XML keys.

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
  "idleDelaySeconds": 10,
  "maxRetries": 10,
  "decisionPrompt": "This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. It does not represent any decision by the user. Decide whether work should continue. Before deciding, check whether every task the user requested in this session is complete, including earlier requests and not only the latest one.",
  "continuePrompt": "Continue until user assistance is required.",
  "reasonTypes": ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"]
}
```

| Key | Default | Range / rules |
|---|---|---|
| `idleDelaySeconds` | `10` | Any finite number `≥ 0`; `0` schedules a 0 ms timer and fractions are allowed |
| `maxRetries` | `10` | Safe integer `1`–`10` (valid continues per lock cycle) |
| `decisionPrompt` | see above | Non-blank, ≤ **16384** Unicode code points |
| `continuePrompt` | `Continue until user assistance is required.` | Non-blank, ≤ **16384** Unicode code points |
| `reasonTypes` | `["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"]` | Nonempty array of trim-nonblank strings. A valid configured list **replaces** the defaults; it does not extend them. |

Default meanings: `JOB_DONE` means all requested work is complete; `WAIT_USER` means progress genuinely requires user input or a user decision; `JOB_BLOCKED` means the job cannot continue for another concrete reason.

For AI unlock, the extension trims XML `reason_type`, matches it against the effective list case-insensitively by lowercasing both values, and emits the **matched configured value uppercased**. It trims `reason_content` but does not truncate it: blank or over-500-code-point AI reasons are invalid and use the decision re-ask protocol. The effective allowed list is included in the fixed prompt suffix. Human `/unlock-continue-watchdog [reason]` remains untyped and keeps its separate truncating behavior.

Invalid re-ask budget is fixed at **3** (not configurable).

Every new authoritative all-idle activity generation waits one fixed
`idleDelaySeconds` grace. Valid continues advance only the `maxRetries`
accounting; they do not lengthen later grace periods.


## Neutral `user-ready` semantic hook

When the elected main attachment reaches a **terminal aggregate-idle** epoch where this extension will not start another automatic decision or continue run, it publishes one fresh plain-data envelope on Pi's public bus:

- Channel: `pi:semantic-hook:v1`
- Envelope name: `user-ready`
- Values by stop kind:
  - AI decision unlock: `{ "STOP_KIND": "AI_UNLOCK", "REASON_TYPE": "<matched TYPE>", "REASON": "<validated reason>" }`
  - Max valid continues exhausted: `{ "STOP_KIND": "EXHAUSTED" }`
  - Third invalid decision: `{ "STOP_KIND": "DECISION_FAILED" }`

Publication is at most once per such terminal idle epoch. It does **not** publish for human `/unlock-continue-watchdog`, abort unlock, valid continue, intermediate decision states, or ordinary unlocked idle. The producer does not import, identify, require, or wait for any consumer (including pi-notify). Delivery is best-effort current-listener-only with no ack, retry, or replay.

## Scope and limitations

- **“All agents”** means watchdog-loaded Pi sessions in the authenticated `pi-process-domain` declaration inherited from the root. Same-realm attachments aggregate into one OS-process participant; inherited child and nested Pi processes join as observer-only participants. A deliberately stripped/replaced environment, a child that disables watchdog, and the unreserved gap before child `session_start` are outside coverage. Launchers needing zero-gap coverage must use `reserveSpawn()` before `spawn()`.
- Each root Pi hosts its own embedded per-domain broker and is the sole decision authority while that domain is open. `PI_CONTINUE_WATCHDOG_ROOT_PID` marks the current creator role; final root detach clears it, closes the broker, and allows a later attachment to create a fresh domain. Inherited PIDs remain observers. The marker is topology metadata, not authentication.
- Initial declaration/authentication/protocol/runtime-path failures fail closed with sanitized output and exit status 78, including a startup domain-key mismatch. Runtime lease, reconnect, or broker loss instead makes watchdog decisions uncertain/fail-closed without terminating Pi or reviving a protocol-v2 broker. Each domain uses a private Unix socket on Linux/macOS/FreeBSD or a Windows named pipe; endpoint names do not contain the domain key.
- **Main election:** UI-bound session wins; pure headless uses first-bound attachment as best-effort main; later non-UI attachments do not steal main.
- **Root ownership:** every extension-enabled attachment observes and reports busy/idle. Only the exact current main owns config, timers, XML decision messages, tool-call blocking, UI notifies, and `user-ready` publication. Non-main attachments are **observer-only** and do not load watchdog config or open decision windows.
- **Framework boundary:** coordination uses only Pi public lifecycle/session APIs. There is no dependence on other plugins or path heuristics. Pi's `pi.events` bus is for semantic-hook delivery only, not for process coordination.
- **Lock state is runtime-only.** A new process/session attachment begins unlocked until its current main agent starts. Nothing is written to disk, and shutdown cancels runtime activity.
- XML decision control is main-only; ordinary tools remain advertised but are blocked while the main decision is open.

## Context cleanliness

After valid continue, valid unlock, terminal decision failure, or user preemption, future **model-bound** context drops the complete decision exchange, including the decision question, any streamed assistant/tool-result residue, re-asks, and fold marker. Continue replaces it with the compact continue prompt; unlock, failure, and preemption replace it with nothing. Canonical aborted decision pairs are also removed. A malformed or incomplete historical exchange fails closed only for its own correlation ID; it cannot disable folding for later independent exchanges.

Each decision stores only a structured `pi-continue-watchdog:decision-audit` custom entry. Pi explicitly excludes plain custom entries from Agent/provider context, so the audit survives `pi -c` without becoming conversation. Valid unlock audits keep the validated type and reason; invalid audits keep only the fixed validation error, never raw model text. The original XML is not retained as assistant content.

## Development

The detailed accepted behavior contract is maintained in [`docs/behavior-contract.md`](docs/behavior-contract.md). For the current module design, lifecycle, XML finalization, session persistence, and provider-context isolation, see [`docs/architecture.md`](docs/architecture.md).

```bash
npm ci
npm run check      # lint, typecheck, unit tests, build
npm run test:e2e   # packed isolated install + stock Pi E2E (timing, multi-loader ownership, XML hiding, bounded idle, persisted resume context)
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check`, and `npm run test:e2e` on `master` push and pull requests.

## Privacy

The extension does not open its own network connections. Decision and continue turns use the normal Pi model provider path already configured for the session.
