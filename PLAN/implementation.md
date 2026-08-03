# Implementation plan — pi-continue-watchdog

**Status:** Public live Git package on `master`. Slices 0–17 are complete; npm, tags, and GitHub Releases are intentionally not used.
**Method:** One vertical behavior slice per branch; RED → GREEN → review (when functional) → merge → next branch
**Language:** English only for all project artifacts

Do **not** expand product scope beyond `PLAN/acceptance.md`. If a slice would change observable behavior, stop and update the acceptance contract with the human first.

**Supersession:** This plan implements the decision-flow redesign. It does **not** implement the rejected direct-continuation design (idle → continue custom message + persistent always-on unlock tool). Do not reintroduce that path.

## Simplicity policy

- Acceptance specifies **observable behavior** only; implementation mechanisms are replaceable.
- Trust normal stock Pi public API shapes.
- No hostile Proxy / speculative global hardening required for v1.
- Prefer simple, obvious modules the human can modify later.
- Core product goal: prevent unexplained AI stops. Remove complexity that does not serve that goal.
- A final `merge-code-reviewer` review is mandatory before publication.

---

## Progress

| Slice | Name | Status |
|---|---|---|
| 0 | Repository skeleton | Complete |
| 1 | Config load / trusted-project precedence | Complete |
| 2 | Lock / decision state machine | Complete |
| 3 | Process hub (main election + observable busy) | Complete |
| 4 | Commands / optional reason / TUI-only entry | Complete |
| 5 | Decision tools registration + temporary activation | Complete |
| 6 | Protocol validator + 3 re-asks | Complete |
| 7 | Context folding + continue rendering | Complete |
| 8 | Auto-lock on main user message start | Complete |
| 9 | Abort-outcome unlock | Complete |
| 10 | Idle timer / decision cycle / exhaustion | Complete |
| 11 | Packed isolated stock-Pi E2E + CI | Complete |
| 12 | README product docs | Complete |
| 13 | Publication readiness | Complete (public live Git package) |
| 14 | Neutral `user-ready` semantic producer | Complete |
| 15 | Universal idle lifecycle state machine | Complete |
| 16 | Unified reasoned unlock UI | Complete |
| 17 | Realm-wide process domain + root-only control | Complete |

**Current architecture (indicative filenames; may still be simplified):**

| Area | File(s) | Responsibility |
|---|---|---|
| Entry | `src/extension.ts` | Pi lifecycle wiring for one attachment |
| Hub | `src/hub.ts` | Realm-wide process domain (`globalThis` + versioned `Symbol.for`): attachment registry, main election, busy/idle. Not a module-evaluation singleton. |
| Config | `src/config.ts`, `src/config-loader.ts` | Defaults, validation, global + trusted-project merge (loaded only by current-main ownership) |
| Controller | `src/controller.ts` | Lock / attempt / exhaustion / decision-failed state |
| Decision protocol | `src/decision-protocol.ts` | Validity, re-asks, decision-failed text |
| Decision tools | `src/decision-tools.ts` | Definitions + temporary active set (main decision window only) |
| Context fold | `src/context-fold.ts` | Model-bound remove/replace of decision exchanges |
| Render | `src/render.ts` | Compact continue TUI line |
| Runtime | `src/runtime.ts` | Lifecycle observe/report for every attachment; config/controller/timer/decision tools/messages/UI/`user-ready` only under exact current-main generation claim |
| Semantic hook | `src/semantic-hook.ts` | Neutral `pi:semantic-hook:v1` / `user-ready` producer helpers via ResourceLoader-local `pi.events` (delivery only, not process coordination) |
| Commands | `src/commands.ts` | `/lock-continue-watchdog`, `/unlock-continue-watchdog` (main-owned) |
| Auto-lock / abort | `src/auto-lock.ts`, `src/abort-outcome.ts` | Main user fresh-cycle lock; current-main aborted-run unlock |
| Tests / CI | `test/**`, `e2e/**`, `.github/workflows/ci.yml` | Unit + packed stock-Pi E2E (incl. multi-ResourceLoader / distinct-cwd) |

**Distribution:** public `xz-dev/pi-continue-watchdog`, installed only with the unpinned command `pi install git:github.com/xz-dev/pi-continue-watchdog`. No npm publication, tags, or GitHub Releases.

---

## Goals

1. Implement the accepted examples in `PLAN/acceptance.md`.
2. Keep each branch small enough to review.
3. Prefer test-first for functional slices.
4. Mirror proven patterns from sibling plugins (hub, trust-gated config, packed stock-Pi E2E, BSD-3-Clause) without copying unrelated product features or the rejected continue-watchdog path.

---

## Grounding

| Source | Takeaway |
|---|---|
| pi-watchdog | Process-global hub, UI-first root election, trust-gated config, packed isolated stock-Pi CI |
| pi-notify | Trust-gated global/project config precedence only |
| Pi public APIs | Ensure lock on current-main start; fresh lock on actual main user message start; true idle after all observable agents settle; wake via hidden custom message; temporary decision tools; context hooks for model-bound edits; abort unlock from Pi-reported aborted main runs |

---

## Branch workflow (historical; remaining slices)

1. Branch `slice/<short-name>` from current `master`.
2. RED → GREEN for the slice only.
3. Checks green; functional slices get independent review when required.
4. Merge to `master`; next slice.

**Commit discipline:** one logical commit per slice preferred; docs describe shipped behavior.

---

## Slice map (reference)

Historical slice map. Status is in the Progress table above; do not treat open checkboxes below as current truth.

### Slice 0 — Repository skeleton — Complete

Package, TypeScript, LICENSE, source entry, load smoke.

### Slice 1 — Config — Complete

Defaults, global + trusted project merge, invalid field fallback, exact default prompts.

### Slice 2 — Lock / decision state machine — Complete

Pure controller: fresh lock, non-resetting unlock, ensure-lock, exponential delays, exhaustion, invalid/no-result re-asks, decision-failed.

### Slice 3 — Hub — Complete

Process-local hub, main election, busy/idle snapshots. (Later corrected by Slice 17: the process domain is realm-wide via `globalThis` + `Symbol.for`, not a module-evaluation singleton.)

### Slice 4 — Commands / notify — Complete

Exact command names, same-state notify, optional human reason + TUI-only entry.

### Slice 5 — Decision tools — Complete

`continue_watchdog` / `unlock_continue_watchdog` definitions; temporary activation only during decision windows.

### Slice 6 — Validator + 3 re-asks — Complete

Validity matrix; re-ask prompts with previous error; decision-failed warning text.

### Slice 7 — Context fold + render — Complete

Unlock → fold to nothing; continue → compact `continuePrompt`; compact continue TUI line.

### Slice 8 — Auto-lock — Complete

Main user message processing start locks; queue-only input and child user messages do not.

### Slice 9 — Abort unlock — Complete

Actual Pi-reported main abort unlocks reasonlessly; ordinary settle does not.

### Slice 10 — Idle decision cycle — Complete

Timers, decision entry, continue/unlock lifecycle, exhaustion, shutdown cleanup.

### Slice 11 — E2E + CI — Complete

Packed install + stock Pi E2E; GitHub Actions `check` + `test:e2e`.

### Slice 12 — README — Complete

Public English install/behavior/commands/config/limitations/CI/license docs.

### Slice 13 — Publication readiness — Complete

- Final `merge-code-reviewer` review approved
- Public repository created at `xz-dev/pi-continue-watchdog`
- `master` is the live package source
- Install only with `pi install git:github.com/xz-dev/pi-continue-watchdog`
- No npm publication, version tags, or GitHub Releases

### Slice 14 — Neutral `user-ready` semantic producer — Complete

Publishes a generic same-process semantic hook only for terminal AI unlock, exhaustion, or decision-failed states without coupling to a consumer plugin.

### Slice 15 — Universal idle lifecycle state machine — Complete

- Every current-main start is covered without resetting an already locked cycle
- Fresh `/lock` semantics alone reset cycle data; a real main user message invokes them silently
- Unlock assigns `locked=false` before operational cleanup and preserves cycle accounting
- Main abort unlocks immediately; child stop reasons are ignored
- Every true-idle settle reconciles aggregate idle without compaction/error classification
- A decision turn with no verifiable result uses the existing three-attempt invalid budget

### Slice 16 — Unified reasoned unlock UI — Complete

- Human and AI reasoned unlocks emit no transient reason notification
- Both persist exactly one muted TUI-only `Continue watchdog unlocked · <reason>` entry
- Reasonless manual/abort unlock notifications remain unchanged

### Slice 17 — Realm-wide process domain + root-only control — Complete

**Problem:** Pi may load this extension through independent `DefaultResourceLoader` instances and independent Jiti/module evaluations in one Node process (including distinct `cwd` values). A module-local hub singleton splits observable-agent membership, main election, and aggregate idle. Child attachments must not run a full control plane.

**Module boundary change:**

| Concern | Boundary |
|---|---|
| Same-process coordination | One JavaScript-realm domain in `src/hub.ts`: standard `globalThis` + versioned `Symbol.for(...)`. Survives independent ResourceLoader/Jiti evaluations and distinct cwd values. |
| Framework inputs | Pi public lifecycle/session APIs only. No other-plugin dependencies and no path heuristics for identity/election. |
| Attachment roles | Every extension-enabled attachment observes and reports lifecycle. Only the exact current-main generation claim owns config load, controller, timers, decision tools/messages, UI notifies, and `user-ready`. |
| Non-main attachments | Observer-only: do not load project/global watchdog config and do not register decision tools. |
| `pi.events` | Remains ResourceLoader-local; used only for semantic-hook delivery, never for process coordination. |
| Pure headless | First-bound best-effort main is unchanged. |
| Coverage | Still excludes out-of-process, isolated, and non-extension children. |

**Verification:**

- Unit: process-domain loading under public multi-`DefaultResourceLoader` / distinct-cwd independent evaluations; observer-only control (config unread, no decision-tool registration, root-only effects)
- Packed stock-Pi E2E: multi-ResourceLoader / distinct-cwd path asserts shared aggregate idle and root-only decision/control effects
- Acceptance Example 15 remains the product contract

---

## Testing strategy

| Layer | What |
|---|---|
| Pure unit | Config, controller, reason validation, decision validity, hub, fold replacements |
| Extension unit | Commands, tools, hooks with fakes; observer-only vs current-main ownership |
| Process domain | Independent ResourceLoader/module evaluations share one realm-wide hub |
| E2E | Packed artifact + stock Pi; isolated dirs; multi-ResourceLoader / distinct-cwd root-only control |
| ATDD traceability | Tests name acceptance example IDs where practical |

**Stale-string guard:** tests/docs must not reintroduce the rejected direct reminder:

```text
Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.
```

---

## Review and merge gates

| Change type | Reviewer | Merge when |
|---|---|---|
| Functional slices 1–11 | Required | Approved + checks green |
| Scaffold 0, docs 12 | Optional | Checks green; human may skim README |
| Final publication review | `merge-code-reviewer` | Approved + all checks green |
| Publish | Human product authority | Final review approved + explicit yes |

Independent review contract for functional merges: Critical/Important/Minor; end with `APPROVED` or `CHANGES REQUIRED`. The final publication review must use `merge-code-reviewer`.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Reintroducing rejected direct continue | Acceptance supersession + stale-string guard |
| Stale timers after unlock/demote | Generation/epoch guards |
| False abort attribution | Only unlock on actual Pi-reported aborted main runs |
| Decision tools stuck active | Always restore after unlock/continue/failed/demote/shutdown |
| Over-claiming “all agents” | Observable same-process only; exclude out-of-process / isolated / non-extension |
| Split hub under multi-ResourceLoader | Realm-wide `globalThis` + versioned `Symbol.for` domain |
| Child full control plane | Non-main is observer-only; exact current-main generation owns control |
| Queued vs actual user message | Auto-lock only when processing starts |
| Same-state silent commands | Unconditional assign + exact TUI strings |
| Context pollution | Fold unlock → nothing; continue → compact prompt only |
| Scope creep | Reject non-examples in acceptance |

---

## Ongoing maintenance

1. Keep `master` installable and CI green; users track its latest commit.
2. Keep `PLAN/acceptance.md` authoritative for observable behavior.
3. Do not add npm publication, version tags, or GitHub Releases.
