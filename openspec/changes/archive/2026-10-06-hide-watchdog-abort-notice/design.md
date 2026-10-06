## Context

See `proposal.md` for motivation and scope. This design is needed because the same message outcome currently controls both Pi's abort presentation and the watchdog's automatic-unlock gate.

Accepted refinement (2026-10-06): after the real-host check exposed an earlier streaming notice, the user accepted temporary appearance and delegated the complexity trade-off. Keep the plugin-only solution: the finalized presentation must be quiet; do not modify Pi to promise zero transient notices. After review found that rewriting `stopReason` changes host execution, the user accepted an Alt+U-like quiet appearance. Use blank notice text, not Alt+U's content cleanup; residual host spacing is acceptable.

Source observations:

- `src/extension.ts` routes the configured shortcut to `handleUnlock` and registers abort-unlock lifecycle handlers before the runtime settlement handler.
- `src/commands.ts` unlocks first; `src/runtime.ts::handleManualUnlock` then records cancellation identity, requests abort, and enables full owned-residue cleanup. This is stronger than the requested native-abort presentation change.
- `src/runtime.ts::handleDecisionMessageEnd` already runs through the uninterruptible `message_end` registration. It neutralizes manual cancellation and takeover messages, while an ordinary native decision abort retains its aborted outcome. Native continuation output is not subjected to manual-unlock cleanup.
- `src/abort-outcome.ts` captures a main-run branch boundary and inspects the terminal new assistant at `agent_settled`. An aborted outcome triggers the existing unlock; manual cancellation/takeover can suppress that gate through a separate marker.
- The inspected Pi assistant renderer displays an abort footer when `stopReason` is `aborted` and the message has no tool calls. An absent or empty `errorMessage` falls back to `Operation aborted`; a nonempty space renders no visible text. The installed public extension API does not expose a standard-assistant renderer override.
- Pi mutates the finalized assistant in place before agent-core checks `stopReason` for tool dispatch and queue polling; post-run compaction also checks it. Therefore `stopReason` is a control field, not a display-only field. Keeping shadow evidence in the watchdog cannot repair host control after rewriting it.

## Goals / Non-Goals

**Goals:**

- Separate the owned run's authoritative abort outcome from the fields Pi uses to display its assistant footer.
- Retain the existing settlement gate, ownership fencing, unlock notification, and content handling.
- Make the change through existing extension lifecycle APIs without a host patch or a new subsystem.

**Non-Goals:**

- Detecting double Esc, rebinding keys, adding a quiet-mode setting, pausing a still-locked watchdog, or guaranteeing zero transient abort frames.
- Reusing the entire manual-unlock cleanup path for native aborts.
- Hiding tool cancellation results or genuine errors, changing private queues, or rolling back completed side effects.
- Deleting or splicing additional transcript content to hide the notice, or changing the success/error/abort settlement matrix.

## Decisions

### 1. Observe the actual owned abort, not the keyboard

Recognize the original aborted assistant at the existing uninterruptible finalized-message boundary while the runtime still has the exact current ownership and exchange identity. Eligible work is a submitted watchdog decision/correction or a running watchdog continuation, not merely any run while the controller is locked.

Keep existing manual cancellation, quarantine, and user-takeover handling distinct. In particular, a foreign input already revokes sole continuation ownership in `handleMessageStart`; its later abort must not be made quiet under an obsolete identity.

**Rejected:** raw terminal listeners or shortcut overrides. They change input handling and miss cancellation initiated through other host paths.

### 2. Keep the authoritative abort on the message

Leave `stopReason: "aborted"` intact through all host and watchdog lifecycle handlers. The existing branch-boundary gate in `src/abort-outcome.ts` remains the sole automatic-unlock path; runtime's existing abort checks still bypass successful/missing-verdict handling. No shadow evidence, new one-shot marker, extra `ctx.abort()`, or extension wiring is needed.

A repeated final-message callback sees the same abort, while duplicate settlement remains inert through the gate's existing capture consumption. New runs, ownership/session transitions and shutdown retain their existing fences.

**Rejected after review:** rewriting `stopReason` to `stop`, even with retained original evidence. Actual-host probes showed another turn/tool result, changed queue consumption and threshold compaction. A repeated normalized message could also erase the retained evidence. Preserve the native outcome instead of adding a second control-state system.

### 3. Replace only visible abort text

For the exact eligible aborted assistant, return `errorMessage: " "` through the existing uninterruptible `message_end` boundary. Pi uses this nonempty blank instead of its default abort text. This leaves the footer's blank spacing, but no visible notice. Keep existing content treatment: internal decision content remains hidden; partial continuation content, tool calls/results and unrelated history gain no cleanup.

Do not route this through `handleManualUnlock`, cancellation markers, or `spliceEntry`. The user accepted an Alt+U-like quiet appearance, not Alt+U's stronger content removal.

Only the stored `errorMessage` changes; the stored and host-visible `stopReason` remains `aborted`. The abort branch does not use error text for control. Verify both visible rendering and host execution, including partial tool calls, queued steering/follow-up and compaction thresholds.

**Rejected:** clearing `errorMessage` to an empty string (restores default text), replacing continuation content with an empty message, or patching Pi's renderer.

### 4. Verify one narrow behavior slice in existing harnesses

Use the existing runtime and abort-outcome harnesses for the semantic path, and an isolated supported-Pi rendering/lifecycle check for the visual result. The primary paired assertion is: no finalized assistant abort footer **and** the same automatic unlock with the same surviving partial output. Record earlier streaming notices separately; final-message hiding is not a claim that the live TUI never briefly displayed a notice.

Keep the negative cases focused: ordinary user abort, takeover/stale identity, genuine error, and unchanged Alt+U. Reuse existing regression coverage rather than building a new framework. During implementation, update only affected shipped documentation/process-model claims and validate any changed Lean file; planning artifacts do not claim those changes have shipped.

## Risks / Trade-offs

- **Presentation rewrite changes host execution** -> Keep `stopReason: "aborted"`; exercise actual-host tool, queue and compaction control, not only watchdog settlement.
- **Repeated callback loses abort classification** -> Preserve the native outcome instead of maintaining shadow evidence; test repeated `message_end` and settlement.
- **Quiet state leaks to an ordinary run** -> Use the live ownership predicate for each message, with no retained presentation state; test takeover plus subsequent user abort.
- **An earlier render briefly displays the notice** -> Pi 0.85.1 can emit an aborted `message_update/text_end` before `message_end`. The user accepts this transient boundary. Keep it in diagnostics and assert the finalized view is quiet; do not patch Pi or claim zero-flash behavior.
- **Manual unlock cleanup is accidentally broadened to native abort** -> Assert that partial continuation text and tool results survive and that Alt+U retains its separate existing behavior.

## Migration Plan

No configuration or data migration is required. Ship the extension change only after the focused semantic/rendering checks and existing relevant checks pass, then reload the extension normally. Rollback restores the previous extension revision and its native abort notice; there is no new stored configuration to remove. Historical abort notices are not rewritten by this change.
