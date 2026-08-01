# Implementation plan — pi-continue-watchdog

**Status:** Ready to implement after accepted contract in `PLAN/acceptance.md`  
**Method:** One vertical behavior slice per branch; RED → GREEN → review (when functional) → merge → next branch  
**Language:** English only for all project artifacts  

Do **not** expand product scope beyond `PLAN/acceptance.md`. If a slice would change observable behavior, stop and update the acceptance contract with the human first.

---

## Goals

1. Implement the accepted 11-example contract with unconditional same-state TUI notifications.
2. Keep each branch small enough to review: one user-visible or install-visible behavior seam.
3. Prefer test-first (ATDD outer / TDD inner) for functional slices.
4. Mirror proven patterns from **pi-watchdog** (hub, trust-gated config, generation-safe timers, packed stock-Pi E2E, BSD-3-Clause) without copying unrelated product features.

---

## Grounding (already done)

| Source | Takeaway for this plugin |
|---|---|
| pi-watchdog | Process-global hub, UI-first root election, trust-gated config merge, generation/epoch timer guards, source + release install shapes, packed isolated stock-Pi CI |
| pi-notify | Trust-gated global/project config precedence; **not** a model for idle aggregation or auto-lock (lacks hub/busy counts/timers) |
| Pi public APIs | Auto-lock on user-role `message_start` (not `input`); settle on `agent_settled`; wake via custom message **steer + triggerTurn**; `hasUI` for root priority |

---

## Target shape (indicative, not a scaffold mandate)

Keep modules deep and small. Exact filenames may adjust if a slice needs a tighter seam, but avoid a single god-file.

| Area | Responsibility |
|---|---|
| `package.json` / entry | Source-installable `pi.extensions` entry; scripts for check/test/e2e |
| `src/hub.ts` | Process-global attachment registry, main election, busy/idle snapshots |
| `src/config.ts` + loader | Defaults, validation, global + trusted-project merge |
| `src/controller.ts` | Lock/attempt/exhaustion state machine; pure decisions preferred |
| `src/extension.ts` | Pi hooks, commands, tool, wiring, generation-safe timers, TUI notify |
| `test/**` | Unit + stock-Pi E2E |
| `scripts/**` | Pack/isolate E2E harness; optional release generator only if needed (never run destructive generators on repo root) |
| `README.md` / `LICENSE` | English docs; BSD-3-Clause; observable-coverage limitations |

---

## Branch workflow (every functional slice)

1. Create branch `slice/<short-name>` from current `master` (after repo init).
2. **RED:** add or extend the failing acceptance/unit test for **this slice only**.
3. **GREEN:** implement the minimum code to pass that slice’s tests and relevant checks.
4. Run focused checks for the slice; run broader suite when wiring or E2E is touched.
5. **Reviewer** required for functional/behavior branches; not required for pure docs/chore unless asked.
6. Address review; re-run checks; merge to `master`; delete branch.
7. Only then start the next slice branch.

**Commit discipline:** one logical commit per slice preferred; no unrelated files; docs for the slice may land with the slice if they describe shipped behavior, otherwise a follow-up docs-only commit.

**Do not:** initialize Git or install dependencies until the first implementation slice that needs them (slice 0). This planning task only wrote `PLAN/`.

---

## Slice map (one vertical slice per branch)

Order is dependency-aware. Each slice must leave `master` installable/testable for what it claims.

### Slice 0 — Repository skeleton

**Branch:** `slice/repo-skeleton`  
**Examples touched:** 11 (packaging foundation only)  
**Deliver:**

- Git init when implementation starts (not during planning)
- `package.json`, TypeScript setup, BSD-3-Clause `LICENSE`, minimal README stub
- Source entry loadable by Pi (`pi.extensions` → `./src/extension.ts` or agreed path)
- `npm` test runner scripts (node:test + tsx or project-chosen equivalent consistent with sibling plugins)
- Empty/no-op extension that loads without error

**RED/GREEN:** package scripts + load smoke (extension factory returns without throw).  
**Review:** optional if pure scaffold; still keep the branch small.

---

### Slice 1 — Config load and trusted-project precedence

**Branch:** `slice/config`  
**Examples:** 10  

**Deliver:**

- Defaults: `idleDelaySeconds=10`, `maxRetries=10`, exact default `continuePrompt`
- Global + trusted-project field merge; untrusted project ignored
- Invalid values fall back safely with bounded diagnostics

**RED:** unit tests for defaults, override, invalid, untrusted project.  
**GREEN:** config module + loader only; extension may read config at start without full lock behavior.

---

### Slice 2 — Lock state machine (pure)

**Branch:** `slice/lock-state`  
**Examples:** 1–3 (state outcomes), 7–8 (attempt/exhaustion math), partial 9 (reset to unlocked)

**Deliver pure controller API, e.g.:**

- `lock()` → locked, attempt 0, clear exhausted, always “notify lock”
- `unlock()` → unlocked, cancel-timer intent, attempt 0, always “notify unlock”
- `onMainUserMessageStart()` → same as lock assignment/reset (auto-lock)
- `onAllObservableIdle(now)` / `onObservableBusy()` / `onContinueSettledStillLocked()` → timer arm/cancel/rearm and attempt advancement per examples 4–8
- Delay: `idleDelaySeconds * 2^(attempt-1)` with attempt indexing documented in tests

**RED:** table-driven unit tests for same-state assign, exponential delays, maxRetries exhaustion, no timer when unlocked/exhausted.  
**GREEN:** no Pi hooks yet if possible—keep pure.

---

### Slice 3 — Process hub: main election + observable busy

**Branch:** `slice/hub`  
**Examples:** scope rules for 4–6; classification for tool visibility  

**Deliver:**

- `Symbol.for("pi-continue-watchdog:hub:v1")` (or equivalent) on `globalThis`
- Attachment register/unregister on session start/shutdown
- Main election: UI > headless first-bound; generation on claim/demote
- Busy/idle tracking from public lifecycle (`agent_start` / `agent_settled` or equivalent documented idle seam)
- Snapshot: all observable idle vs not

**RED:** unit tests with fake attachments (UI steals main, demotion, busy counts, stale generation).  
**GREEN:** hub module + thin extension wiring for lifecycle only.

---

### Slice 4 — Commands and TUI notifications

**Branch:** `slice/commands-notify`  
**Examples:** 2, 3 (command paths), unconditional notify texts  

**Deliver:**

- `/lock-continue-watchdog` → controller.lock + TUI notify `Continue watchdog locked`
- `/unlock-continue-watchdog` → controller.unlock + TUI notify `Continue watchdog unlocked`
- Same-state still notifies
- Handlers inert when not current main / wrong session identity (demotion-safe)

**RED:** handler tests with fake `pi` notify/command APIs.  
**GREEN:** register commands on main claim; keep tool for next slice if cleaner.

---

### Slice 5 — Main-only AI unlock tool

**Branch:** `slice/unlock-tool`  
**Examples:** 3 (tool path), 5 (tool description guidance)  

**Deliver:**

- Register `unlock_continue_watchdog` only for main
- Description tells model to call it when intentionally waiting for the user or all tasks are complete
- On invoke: unlock + TUI `Continue watchdog unlocked` (always)
- Return only model-visible `Continue watchdog unlocked`; do not return state, config, or structured details
- Return Pi's `terminate: true` hint so a final standalone unlock call skips the redundant post-tool model turn; test/document the all-results-in-batch limitation
- Non-main must not successfully act as main unlock

**RED:** tool registration/visibility and invoke notify/state tests.  
**GREEN:** tool wiring on claim; remove/inert on demote.

---

### Slice 6 — Auto-lock on actual main user `message_start`

**Branch:** `slice/auto-lock`  
**Examples:** 1  

**Deliver:**

- On main user-role `message_start`: unconditional lock + attempt reset
- Ignore child user messages and mere `input` queueing
- Document hook choice in README

**RED:** lifecycle tests distinguishing `input` vs user `message_start` vs child session.  
**GREEN:** hook wiring to controller.

---

### Slice 7 — Idle timer, cancel/restart, continue delivery

**Branch:** `slice/idle-continue`  
**Examples:** 4, 5, 6, 7  

**Deliver:**

- When locked and all observable idle → arm one-shot timer for current attempt delay
- Busy → cancel; idle again → full delay restart for same attempt
- Fire → send visible custom non-user message to main with **steer + triggerTurn**, exact/default prompt
- Generation guards on callback; `unref` timers; no tool cancel
- After continue run settles still locked → next attempt (example 7)

**RED:** fake clock/timer tests for cancel/restart/stale callback; message shape/delivery options asserted at the seam.  
**GREEN:** timer + `sendMessage` wiring.

---

### Slice 8 — Exhaustion and lifecycle cleanup

**Branch:** `slice/exhaustion-lifecycle`  
**Examples:** 8, 9  

**Deliver:**

- After `maxRetries` continues, remain locked/exhausted with no timer
- Reset paths: main user `message_start`, manual lock
- session shutdown / demote / reload path: unlock clean, clear timers, no durable restore

**RED:** exhaustion + shutdown/demote tests.  
**GREEN:** cleanup on `session_shutdown` and main loss.

---

### Slice 9 — README product docs (English)

**Branch:** `slice/readme`  
**Examples:** documentation of all 11; limitations  

**Deliver:** user-facing install, commands, tool, config sample, defaults, exponential policy, observable-coverage warning, BSD license blurb.  
**Review:** docs-only → reviewer optional unless product wording is sensitive (prefer quick human skim).

---

### Slice 10 — Packed isolated stock-Pi E2E + CI

**Branch:** `slice/e2e-ci`  
**Examples:** 11; end-to-end smoke for 1–5 as feasible  

**Deliver:**

- Pack extension → install into isolated `HOME` / agent dir → stock Pi
- E2E: load, command lock/unlock notify path, auto-lock seam, at least one real or harness-accelerated continue delivery
- GitHub Actions: lint/typecheck/unit + E2E on PR/push to `master`
- Safety: no destructive release generator aimed at repo root

**RED:** E2E fails before feature complete; then green on `master` after merge.  
**Review:** required (CI and isolation are high-risk).

---

### Slice 11 — Publication readiness

**Branch:** `slice/publish-prep` or direct release checklist on `master` after human authority  

**Deliver:**

- Final README/license consistency
- Confirm public repo plan `xz-dev/pi-continue-watchdog`
- No tags/npm unless later authorized
- Human confirmation before `gh repo create` / first push

**Not authorized by this plan alone:** creating the GitHub repo or pushing. Wait for explicit publish authority (task “Verify and publish project”).

---

## Testing strategy

| Layer | What |
|---|---|
| Pure unit | Config, controller delays/attempts, hub election, generation guards |
| Extension unit | Commands, tool, hooks with fake Pi context |
| E2E | Packed artifact + stock Pi; isolated dirs; process-group cleanup |
| ATDD traceability | Each automated test names the acceptance example ID (1–11) it protects |

Break implementations deliberately once per critical test to prove failure mode (not tautologies).

---

## Review and merge gates

| Change type | Reviewer | Merge when |
|---|---|---|
| Functional slices 1–8, 10 | Required | Approved + checks green |
| Scaffold 0, docs 9 | Optional | Checks green; human may still skim README |
| Publish | Human product authority | Explicit yes |

Independent review contract for functional merges: Critical/Important/Minor findings; end with `APPROVED` or `CHANGES REQUIRED`.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Stale timers wake after unlock/demote | Generation + epoch on every callback (pi-watchdog pattern) |
| Over-claiming “all agents” | Docs + diagnostics: observable same-process only |
| Queued vs actual user message | Auto-lock only on user-role `message_start` |
| Same-state silent commands | Unconditional assign + exact TUI strings in tests |
| Unlock triggers redundant full LLM request | Minimal one-line result plus `terminate: true`; document that the paired call/result remains in later history and mixed tool batches only terminate when every result opts in |
| Destructive packaging scripts | Never default output to repo root; sentinel-owned dirs only |
| Scope creep (footer, wall clock, other plugins) | Reject; point to acceptance non-examples |

---

## Immediate next action after this plan

1. Human (or root agent with authority) starts **Slice 0** on a new branch: initialize Git and minimal package **only when coding begins**.  
2. Proceed slice-by-slice; do not open parallel feature branches that edit the same extension wiring without a clear ownership split.  
3. Keep `PLAN/acceptance.md` authoritative; update it only with human confirmation.

---

## Checklist (progress)

- [x] Acceptance contract with 11 examples + unconditional TUI notifies (`PLAN/acceptance.md`)
- [x] Implementation slice map (`PLAN/implementation.md`)
- [ ] Slice 0 skeleton
- [ ] Slice 1 config
- [ ] Slice 2 lock state
- [ ] Slice 3 hub
- [ ] Slice 4 commands/notify
- [ ] Slice 5 unlock tool
- [ ] Slice 6 auto-lock
- [ ] Slice 7 idle continue
- [ ] Slice 8 exhaustion/lifecycle
- [ ] Slice 9 README
- [ ] Slice 10 E2E/CI
- [ ] Slice 11 publish (human-gated)
