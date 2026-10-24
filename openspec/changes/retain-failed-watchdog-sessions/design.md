## Context

See [proposal](proposal.md) for motivation. This design applies to both watchdogs; Reflect's [companion design](../../../../pi-reflect-watchdog/openspec/changes/retain-failed-watchdog-sessions/design.md) describes its consumer boundary.

Both consumers pin `pi-extension-utils` revision `6e7a5fe6a85ac240585427996cb1540c1e9e2ee9` and execute through `private-inquiry`. The installed private runtime already creates a native fork JSONL beneath the parent session's directory:

```text
<parent-session-dir>/<parent-session-name>/forks/<run-id>/<child-session>.jsonl
```

This is separate from the temporary result/agent directory removed by the shared inquiry's final cleanup. The child's `sessionFile` already exists at the runtime boundary, but shared terminal results expose only `sessionId`. Continue forwards the child getter in `src/private-decision.ts`, then loses execution details behind generic terminal handling in `src/runtime.ts`. Reflect also forwards the getter, but its result handler explicitly notifies only `decision-failed`, not returned `execution-error`.

Existing main-session audit/review privacy rules prohibit copying private file paths and raw exchanges into those records. A human-only diagnostic is a separate output, not a relaxation of those rules.

## Goals / Non-Goals

**Goals:**
- Return the exact native session locator through the shared boundary and preserve it through teardown.
- Give both consumers truthful, bounded terminal-failure diagnostics without changing outcome authority.
- Add one shared mechanism, with plugin-specific wording at existing human-notification boundaries.

**Non-Goals:**
- A second JSONL export, database, upload service, retention settings, rotation policy or session browser.
- New notifications for successful corrections, changes to successful-session storage, or retention of temporary result files.
- Replaying failed sessions, changing retry budgets, or revising fail-open optional-review behavior.
- Diagnosing unrelated main-agent errors or changing post-result publication semantics.

## Decisions

### 1. Retain the existing native JSONL, not the temporary result directory

Use the actual runtime-provided session file; do not infer it from `sessionId` or reconstruct it from a naming convention. Wait for existing child settlement/disposal, retain the native file, and check that it is an accessible regular JSONL file before advertising it. Preserve available partial history on failure; a provider failure need not have a complete final response.

Continue removing the private result/agent directory. It contains transient transport state, not the diagnostic session, and must not become a durable authorization surface. No backup copy is needed for the current layout. If a supported runtime changes that layout, retention must complete before cleanup can delete the session, or evidence must be reported unavailable.

Alternative rejected: keeping the entire temporary directory. It retains irrelevant transport state and does not locate the existing JSONL.

### 2. Carry session availability through the shared operation

Extend `pi-extension-utils/private-inquiry` terminal metadata additively with the real optional session locator. Only an accessible retained session is presented as available; absent/unusable evidence gets a bounded reason, not an invented path. Keep session identity and path distinct. Consumers must not query whichever session happens to be selected when the asynchronous call returns.

Capture the locator as soon as the fork is known. For runtime setup errors after the fork file has been created but before a child is returned, preserve and propagate any locator already known at that runtime boundary using narrow failure metadata. Before any fork exists, report that no private session was created. Do not scan sibling sessions to guess which file belongs to the failure.

Both consumer wrappers must forward this metadata unchanged. Dependency adoption must be coordinated so tests cannot pass against a shared result shape unavailable in the other consumer.

Alternative rejected: independent path discovery in each plugin. It duplicates runtime knowledge and risks pointing at the main or another child's session.

### 3. Trigger only at a current terminal private-inquiry failure

The new diagnostic applies to `execution-error` and `decision-failed` after correction allowance is exhausted. If Continue's one reconsideration fails, the path still identifies the same child that contains both inquiry rounds. A correction that eventually succeeds does not trigger this feature; existing per-attempt warnings stay unchanged.

Expected abort, manual withdrawal/unlock, takeover, shutdown and stale ownership remain cancellation paths, not diagnostics failures. Recheck existing currentness/ownership guards after settlement and before notification; an old operation cannot notify into a replacement session. Optional semantic-review unavailability that releases a valid candidate is not a terminal private-inquiry failure.

Alternative rejected: notification on every invalid response. It adds noise for a recovery mechanism explicitly designed to correct those responses.

### 4. Add one human-only path notice at the existing failure boundary

Each current failed operation gets at most one new retention/path notice, attached to its existing terminal error where possible. The notice identifies Continue or Reflect, a safe failure category/summary, and the full copyable absolute session path. Example shape, not fixed wording:

```text
Continue watchdog failed: invalid result after correction limit.
Private session JSONL retained: /absolute/path/to/child-session.jsonl
```

If no session exists or retention cannot be verified, state that explicitly in the same notice. Never replace the original failure with a retention error, echo arbitrary provider error bodies, or claim a file was saved solely because a string locator exists. Check availability at notice preparation; subsequent external deletion is outside the guarantee.

Use existing human notification facilities, not status-row ticks, raw console dumps, prompts, new model-bound events or review/audit records. Existing canonical terminal outcome content remains unchanged. Retained content stays in the private JSONL; normal transcript/context isolation remains in force.

### 5. Diagnostics never become execution authority

No file inspection failure, notice failure or unavailable-evidence state may grant a decision, spend an extra continuation/invalid-response unit, launch another model call, relock, or prevent normal slot/resource release. Continue keeps its existing failure recovery; Reflect handles returned execution failures explicitly and still publishes no reflection/continuation for a failed inquiry. Retained files are not loaded on restart to resume operations or restore locks.

## Risks / Trade-offs

- Full forks contain inherited conversation, tool content and potentially secrets -> keep evidence local, retain existing privacy/access restrictions, display only the locator and safe summary; warn users before they share files.
- No automated expiry -> failure evidence remains available for user inspection and may consume disk; no new deletion or rotation policy is introduced.
- Setup can fail before a session exists, and storage can become unavailable -> disclose incomplete evidence rather than promising a session for every possible failure.
- A file can be externally deleted after its availability check -> guarantee the notice's observation, not immunity from external filesystem changes.
- Shared dependency changes can drift across repositories -> coordinate pins and run both consumers against the same shared revision.

## Migration Plan

1. Add and verify shared path/availability propagation, including setup and cleanup failure coverage, without changing existing outcome discriminants.
2. Adopt the compatible shared revision in both plugins and implement each existing terminal diagnostic boundary.
3. Verify failure, corrected-success and cancellation examples across both plugins; update user-facing diagnostic documentation and affected process models during implementation.
4. Rollback by reverting consumer adoption together with the shared metadata change if needed. Retained JSONL needs no migration or deletion; rollback must not remove users' diagnostic evidence.
