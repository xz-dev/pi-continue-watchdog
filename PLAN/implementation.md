# Implementation plan — pi-continue-watchdog

**Status:** Ready to implement after accepted **two-stage decision-flow** contract in `PLAN/acceptance.md`
**Method:** One vertical behavior slice per branch; RED → GREEN → review (when functional) → merge → next branch
**Language:** English only for all project artifacts

Do **not** expand product scope beyond `PLAN/acceptance.md`. If a slice would change observable behavior, stop and update the acceptance contract with the human first.

**Supersession:** This plan implements the decision-flow redesign. It does **not** implement the rejected direct-continuation design (idle → steer continue custom message + persistent always-on unlock tool). Do not reintroduce that path.

**Implementation status:** No production code is claimed complete by this plan. Checkboxes below track planning only until slices land.

---

## Goals

1. Implement the accepted examples in `PLAN/acceptance.md` (auto-lock, commands, observable active-main Escape unlock, temporary decision tools, validator + 3 re-asks, context folding, exponential continues, exhaustion, packaging/CI).
2. Keep each branch small enough to review: one user-visible or install-visible behavior seam.
3. Prefer test-first (ATDD outer / TDD inner) for functional slices.
4. Mirror proven patterns from **pi-watchdog** (hub, trust-gated config, generation-safe timers, packed stock-Pi E2E, BSD-3-Clause) without copying unrelated product features or the rejected continue-watchdog v0 path.

---

## Grounding (already done)

| Source | Takeaway for this plugin |
|---|---|
| pi-watchdog | Process-global hub, UI-first root election, trust-gated config merge, generation/epoch timer guards, source + release install shapes, packed isolated stock-Pi CI |
| pi-notify | Trust-gated global/project config precedence; **not** a model for decision tools or context folding |
| Pi public APIs | Auto-lock on user-role `message_start` (not `input`); settle on `agent_settled`; wake via custom message **steer + triggerTurn**; `hasUI` for root priority; `setActiveTools` for next request; context hooks for non-destructive model-bound edits; `terminate: true` batch limitation; `ctx.ui.onTerminalInput` + TUI `ctx.isIdle()` for best-effort active-main Escape unlock. Public agent lifecycle events do not expose abort provenance, so never infer abort from settle. |

---

## Target shape (indicative, not a scaffold mandate)

Keep modules deep and small. Exact filenames may adjust if a slice needs a tighter seam, but avoid a single god-file.

| Area | Responsibility |
|---|---|
| `package.json` / entry | Source-installable `pi.extensions` entry; scripts for check/test/e2e |
| `src/hub.ts` | Process-global attachment registry, main election, busy/idle snapshots |
| `src/config.ts` + loader | Defaults (`idleDelaySeconds`, `maxRetries`, `decisionPrompt`, `continuePrompt`), validation, global + trusted-project merge |
| `src/controller.ts` | Lock/attempt/exhaustion/decision-failed state machine; pure decisions preferred |
| `src/decision.ts` | Validity rules, re-ask error text, reason validation (trim, nonempty, ≤500 Unicode chars) |
| `src/context-fold.ts` | Model-bound removal/replacement of decision exchanges (unlock → nothing; continue → compact `continuePrompt`) |
| `src/render.ts` | Compact TUI tool rendering for continue (and related decision UI seams) |
| `src/extension.ts` | Pi hooks, commands, temporary tools, wiring, generation-safe timers, TUI notify |
| `test/**` | Unit + stock-Pi E2E |
| `scripts/**` | Pack/isolate E2E harness; optional release generator only if needed (never run destructive generators on repo root) |
| `README.md` / `LICENSE` | English docs; BSD-3-Clause; observable-coverage and Pi API limitations |

---

## Branch workflow (every functional slice)

1. Create branch `slice/<short-name>` from current `master`.
2. **RED:** add or extend the failing acceptance/unit test for **this slice only**.
3. **GREEN:** implement the minimum code to pass that slice’s tests and relevant checks.
4. Run focused checks for the slice; run broader suite when wiring or E2E is touched.
5. **Reviewer** required for functional/behavior branches; not required for pure docs/chore unless asked.
6. Address review; re-run checks; merge to `master`; delete branch.
7. Only then start the next slice branch.

**Commit discipline:** one logical commit per slice preferred; no unrelated files; docs for the slice may land with the slice if they describe shipped behavior, otherwise a follow-up docs-only commit.

**Do not:** install dependencies until the first implementation slice that needs them (Slice 0). The repository and `master` already exist; do not reinitialize Git.

---

## Slice map (one vertical slice per branch)

Order is dependency-aware. Each slice must leave `master` installable/testable for what it claims.

### Slice 0 — Repository skeleton

**Branch:** `slice/repo-skeleton`
**Examples touched:** 13 (packaging foundation only)
**Deliver:**

- Start from the existing Git repository and `master`; do not run `git init`
- `package.json`, TypeScript setup, BSD-3-Clause `LICENSE`, minimal README stub
- Source entry loadable by Pi (`pi.extensions` → `./src/extension.ts` or agreed path)
- `npm` test runner scripts (node:test + tsx or project-chosen equivalent consistent with sibling plugins)
- Empty/no-op extension that loads without error

**RED/GREEN:** package scripts + load smoke (extension factory returns without throw).
**Review:** optional if pure scaffold; still keep the branch small.

---

### Slice 1 — Config load and trusted-project precedence

**Branch:** `slice/config`
**Examples:** 12

**Deliver:**

- Defaults: `idleDelaySeconds=3`, `maxRetries=10`, exact default `decisionPrompt`, exact default `continuePrompt` (`Continue until all jobs are done.`)
- Global + trusted-project field merge; untrusted project ignored
- Invalid values fall back safely with bounded diagnostics
- Do **not** ship or default the rejected direct-continuation reminder string

**RED:** unit tests for defaults, override, invalid, untrusted project, exact default prompt strings.
**GREEN:** config module + loader only; extension may read config at start without full lock behavior.

---

### Slice 2 — Lock / decision state machine (pure)

**Branch:** `slice/lock-state`
**Examples:** 1–4, 8–10 (state outcomes), partial 11 (reset to unlocked)

**Deliver pure controller API, e.g.:**

- `lock()` → locked, attempt 0, clear exhausted/decision-failed, always “notify lock”
- `unlock()` → unlocked, cancel-timer intent, attempt 0, clear decision-failed, always “notify unlock”
- `onMainUserMessageStart()` → same as lock assignment/reset (auto-lock)
- `onAllObservableIdle(now)` / `onObservableBusy()` → timer arm/cancel/rearm; no timer when unlocked/exhausted/decision-failed
- `beginDecision()` / `recordInvalidDecision(error)` / `recordValidContinue()` / `recordValidUnlock()` → re-ask budget (fixed 3), decision-failed, attempt advance only on valid continue
- Delay for zero-based `attempt`: `idleDelaySeconds * 2^attempt` (equivalently one-based `N = attempt + 1` and `idleDelaySeconds * 2^(N-1)`), documented in tests

**RED:** table-driven unit tests for same-state assign, exponential delays, maxRetries exhaustion, invalid re-asks not consuming retries, decision-failed after 3, no timer when unlocked/exhausted/decision-failed.
**GREEN:** no Pi hooks yet if possible—keep pure.

---

### Slice 3 — Process hub: main election + observable busy

**Branch:** `slice/hub`
**Examples:** scope rules for 5, 9; classification for tool visibility

**Deliver:**

- `Symbol.for("pi-continue-watchdog:hub:v1")` (or equivalent) on `globalThis`
- Attachment register/unregister on session start/shutdown
- Main election: UI > headless first-bound; generation on claim/demote
- Busy/idle tracking from public lifecycle (`agent_start` / `agent_settled` or equivalent documented idle seam)
- Snapshot: all observable idle vs not

**RED:** unit tests with fake attachments (UI steals main, demotion, busy counts, stale generation).
**GREEN:** hub module + thin extension wiring for lifecycle only.

---

### Slice 4 — Commands, optional reason, TUI-only reason entry

**Branch:** `slice/commands-notify`
**Examples:** 2, 3

**Deliver:**

- `/lock-continue-watchdog` → controller.lock + TUI notify `Continue watchdog locked`
- `/unlock-continue-watchdog [reason]`:
  - empty/blank → `Continue watchdog unlocked`, no reason entry
  - nonblank → trim + truncate to 500 Unicode characters; notify `Continue watchdog unlocked: <reason>`; append persisted TUI-only reason entry
- Same-state still notifies
- Handlers inert when not current main / wrong session identity (demotion-safe)

**RED:** handler tests with fake `pi` notify/command APIs; reason empty/long/multiline cases.
**GREEN:** register commands on main claim; decision tools come in later slices.

---

### Slice 5 — Temporary decision tools (registration only)

**Branch:** `slice/decision-tools`
**Examples:** 5 (tool set shape), 7 (unlock schema/description), 6 (continue empty schema)

**Deliver:**

- Registered definitions for `continue_watchdog({})` and `unlock_continue_watchdog({ reason: string })`; Pi exposes no public unregister API
- Unlock tool description states concise single-sentence reason guidance (validation still in decision module)
- Capture the prior active tool-name set; **activate** exactly these two for the main decision request; restore the captured set on continue, unlock, invalid×3, Escape unlock, demotion, reload, and shutdown
- Definitions may remain registered but are inactive/model-invisible outside a decision window; do not describe registration as temporary
- Non-main must never activate them as main controls

**RED:** registration/restore tests; assert normal tool set does not permanently include decision tools.
**GREEN:** tool modules + setActiveTools wiring helpers; full idle entry may still be stubbed until later slices.

---

### Slice 6 — Protocol validator + 3 re-asks

**Branch:** `slice/decision-validator`
**Examples:** 8; reason rules for 7

**Deliver:**

- Pure validator: exactly one valid decision tool; reject no tool, both/multiple, extra/unknown, prose-only, invalid reason
- Reason: trim, nonempty, ≤500 Unicode characters, newlines allowed
- On invalid: produce exact previous-error text for the next hidden re-ask prompt
- After 3 invalids: signal decision-failed; restore tools; emit exact TUI warning
  `Continue watchdog decision failed after 3 attempts: <last error>`
- Invalid path does not advance exponential continue attempt

**RED:** matrix tests for all invalid classes + third-failure warning text.
**GREEN:** decision module + controller integration; extension may drive re-ask with fakes.

---

### Slice 7 — Context folding + custom continue rendering

**Branch:** `slice/context-fold-render`
**Examples:** 6, 7

**Deliver:**

- On valid unlock: context hook removes entire decision exchange; inserts **nothing**; TUI reason notify + TUI-only entry already from unlock path; `terminate: true` on unlock result
- On valid continue: context hook removes decision prompt/reply/tool call/results and inserts one compact custom message = configured `continuePrompt`
- Custom tool renderer folds continue call/result into one compact TUI line showing `continuePrompt`
- Document Pi limitations: non-destructive model-bound edits; raw session may retain protocol records; terminate only if all batch results terminate

**RED:** fold unit tests (unlock empty replacement vs continue compact prompt); renderer snapshot tests.
**GREEN:** context hook + renderer wiring without full timer path if still isolated.

---

### Slice 8 — Auto-lock on actual main user `message_start`

**Branch:** `slice/auto-lock`
**Examples:** 1

**Deliver:**

- On main user-role `message_start`: unconditional lock + attempt/failure reset
- Ignore child user messages and mere `input` queueing
- Document hook choice in README when docs slice lands

**RED:** lifecycle tests distinguishing `input` vs user `message_start` vs child session.
**GREEN:** hook wiring to controller.

---

### Slice 9 — Observable active-main Escape unlock

**Branch:** `slice/escape-abort-unlock`
**Examples:** 4

**Deliver:**

- In interactive TUI main only, register a public `ctx.ui.onTerminalInput` listener and match Escape using Pi TUI key utilities
- If main is non-idle, apply unconditional reasonless unlock before Pi handles input: cancel timers/decision state, restore normal tools, reset attempts/failures, and notify exactly `Continue watchdog unlocked`
- Return Escape unchanged and never consume it; Pi remains responsible for aborting the run
- Ignore Escape while main is idle so selector/editor cancellation and double-Escape navigation do not unlock
- Do not infer abort from `agent_settled`; document that headless/RPC/programmatic aborts and input consumed before this listener are outside truthful public-API coverage
- Dispose the terminal listener on demote/reload/shutdown

**RED:** terminal-input tests for active Escape unlock + pass-through, same-state notification, idle Escape no-op, no duplicate notification on settle, and listener cleanup.
**GREEN:** thin UI input adapter to the existing unconditional unlock controller path.

---

### Slice 10 — Idle timer, decision entry, continue/exhaustion lifecycle

**Branch:** `slice/idle-decision-cycle`
**Examples:** 5, 6, 7, 9, 10, 11

**Deliver:**

- When locked and all observable idle → arm one-shot timer for current attempt delay
- Busy → cancel; idle again → full delay restart for same attempt
- Fire → enter decision window: `setActiveTools` to decision pair; send **hidden** `decisionPrompt` via steer+triggerTurn (or documented equivalent that does not cancel in-flight tools)
- Wire valid continue → restore tools, fold, advance attempt, allow next idle cycle
- Wire valid unlock → restore tools, fold to nothing, unlock notify/reason
- After `maxRetries` valid continues → exhausted, no timer
- session shutdown / demote / reload: unlock clean, clear timers, restore tools, no durable restore
- Generation guards on callbacks; `unref` timers

**RED:** fake clock/timer tests for cancel/restart/stale callback; decision entry asserts no rejected direct-continuation default string; exhaustion + shutdown/demote tests.
**GREEN:** full extension wiring of hub + controller + decision + fold.

---

### Slice 11 — Packed isolated stock-Pi E2E + CI

**Branch:** `slice/e2e-ci`
**Examples:** 13; end-to-end smoke for 1–8 as feasible, including active-main Escape pass-through unlock

**Deliver:**

- Pack extension → install into isolated `HOME` / agent dir → stock Pi
- E2E: load, command lock/unlock (± reason), auto-lock seam, at least one real or harness-accelerated path into decision tools + valid continue or unlock fold
- Prefer coverage of third-invalid decision-failed warning when harness allows
- GitHub Actions: lint/typecheck/unit + E2E on PR/push to `master`
- Safety: no destructive release generator aimed at repo root

**RED:** E2E fails before feature complete; then green on `master` after merge.
**Review:** required (CI and isolation are high-risk).

---

### Slice 12 — README product docs (English)

**Branch:** `slice/readme`
**Examples:** documentation of all accepted examples; limitations

**Deliver:**

- User-facing install, commands, decision tools, config sample, defaults, exponential policy
- Explicit supersession note: prior direct-continuation design rejected
- Observable-coverage warning
- Pi API limitations table (context hook, setActiveTools, terminate batch rule, raw session retention)
- BSD license blurb

**Review:** docs-only → reviewer optional unless product wording is sensitive (prefer quick human skim).

---

### Slice 13 — Publication readiness

**Branch:** `slice/publish-prep` or direct release checklist on `master` after human authority

**Deliver:**

- Final README/license consistency
- Confirm public repo plan `xz-dev/pi-continue-watchdog`
- No tags/npm unless later authorized
- Human confirmation before `gh repo create` / first push

**Not authorized by this plan alone:** creating the GitHub repo or pushing. Wait for explicit publish authority.

---

## Testing strategy

| Layer | What |
|---|---|
| Pure unit | Config, controller delays/attempts/decision-failed, reason validation, decision validity matrix, hub election, generation guards, context fold replacements |
| Extension unit | Commands, temporary tools, hooks, re-ask prompts with fake Pi context |
| E2E | Packed artifact + stock Pi; isolated dirs; process-group cleanup |
| ATDD traceability | Each automated test names the acceptance example ID it protects |

Break implementations deliberately once per critical test to prove failure mode (not tautologies).

**Stale-string guard:** tests and docs search must fail if the rejected default direct reminder reappears:

```text
Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.
```

---

## Review and merge gates

| Change type | Reviewer | Merge when |
|---|---|---|
| Functional slices 1–11 | Required | Approved + checks green |
| Scaffold 0, docs 12 | Optional | Checks green; human may still skim README |
| Publish | Human product authority | Explicit yes |

Independent review contract for functional merges: Critical/Important/Minor findings; end with `APPROVED` or `CHANGES REQUIRED`.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Reintroducing rejected direct continue | Acceptance supersession + stale-string guard in tests/docs |
| Stale timers open decision after unlock/demote | Generation + epoch on every callback |
| False abort attribution | Use only active-main TUI Escape as a documented best-effort abort request; pass it through unchanged; never infer abort from settle or claim headless/programmatic coverage |
| Decision tools stuck active | Always restore on unlock/continue/decision-failed/demote/shutdown; tests assert restore |
| Over-claiming “all agents” | Docs + diagnostics: observable same-process only |
| Queued vs actual user message | Auto-lock only on user-role `message_start` |
| Same-state silent commands | Unconditional assign + exact TUI strings in tests |
| Context pollution | Fold unlock → nothing; continue → compact `continuePrompt` only |
| `terminate: true` ignored in mixed batches | Document Pi limitation; prefer unlock as sole tool in its batch |
| Destructive packaging scripts | Never default output to repo root; sentinel-owned dirs only |
| Scope creep (footer, wall clock, other plugins) | Reject; point to acceptance non-examples |

---

## Immediate next action after this plan

1. Human (or root agent with authority) starts **Slice 0** on a new branch from the existing repository and adds the minimal package.
2. Proceed slice-by-slice; do not open parallel feature branches that edit the same extension wiring without a clear ownership split.
3. Keep `PLAN/acceptance.md` authoritative; update it only with human confirmation.

---

## Checklist (progress)

- [x] Acceptance contract rewritten for two-stage decision-flow (`PLAN/acceptance.md`)
- [x] Implementation slice map rewritten for decision-flow (`PLAN/implementation.md`)
- [ ] Slice 0 skeleton
- [ ] Slice 1 config
- [ ] Slice 2 lock/decision state
- [ ] Slice 3 hub
- [ ] Slice 4 commands / reason entry
- [ ] Slice 5 temporary decision tools
- [ ] Slice 6 protocol validator + 3 re-asks
- [ ] Slice 7 context folding + custom rendering
- [ ] Slice 8 auto-lock
- [ ] Slice 9 active-main Escape unlock
- [ ] Slice 10 idle timer / decision cycle / exhaustion
- [ ] Slice 11 E2E/CI
- [ ] Slice 12 README
- [ ] Slice 13 publish (human-gated)

**Note:** Implementation is **not** complete. Only planning artifacts exist for this redesign until slices merge.
