## Purpose

Make long-running private watchdog work visible in the existing below-editor rows without exposing private content or changing execution policy. This capability in pi-continue-watchdog is the canonical shared presentation contract for Continue and Reflect; each repository owns its local implementation.

## ADDED Requirements

### Requirement: Both watchdogs use their existing status rows
Continue and Reflect SHALL each present live background progress in their existing single below-editor status row. Continue SHALL replace its separate multi-line checking panel with progress in that row. The plugins SHALL NOT replace terminal/session tabs, the main editor or footer, or create a second live progress panel. Both rows SHALL coexist when both plugins are installed, and either plugin SHALL work independently when the other is absent.

#### Scenario: Both private operations are running
- **WHEN** Continue is checking a decision and Reflect is running a reflection in the same visible session
- **THEN** each existing row shows its own operation and progress independently
- **AND** neither row replaces the other or adds a separate checking panel

#### Scenario: One plugin is installed
- **WHEN** only Continue or only Reflect is installed
- **THEN** its row displays progress without requiring the other plugin or a cross-plugin coordinator

### Requirement: Highlight means owned background work
Each row SHALL use the same theme-aware active foreground/background semantics while its own background operation is pending, including preparation, review and cancellation drain. A non-active row SHALL return to its existing muted presentation. Ordinary root/subagent activity, enabled state, cooldown and a pending manual request SHALL NOT alone activate the private-operation highlight. An explicit stage label SHALL accompany the color so the indication remains understandable without color. The highlight SHALL end when the exact operation settles or loses its visible session/owner scope.

#### Scenario: Root works without a private inquiry
- **WHEN** the root is running and Continue is enabled but no private Continue decision exists
- **THEN** Continue retains its ordinary activity and unlock information without an active private-operation highlight

#### Scenario: Root is idle during review
- **WHEN** the root is idle and Continue awaits its optional unlock review
- **THEN** Continue's row is highlighted and identifies review rather than implying ordinary root work

### Requirement: Progress names observed work rather than inferred completion
An active row SHALL identify its current observed stage and total elapsed time since operation admission. Observable preparation, model waiting/generation, result validation, format correction, outcome publication and cancellation drain SHALL be represented when they occur. Admitted private evidence-tool execution SHALL identify only safe tool names. Continue SHALL additionally identify optional unlock review and the single review-triggered reconsideration when present. While a private model request is streaming, the model-waiting stage SHALL be replaced by a content-free streaming activity label: the latest official output kind (`thinking`, `writing` or `tool call`), an indicator that advances only as streamed output arrives, and the number of characters streamed in the current response (for example `writing ⠙ 1.2k`). Before the first streamed output of a request, and after that response ends, the stage SHALL return to `waiting for model`. The activity label SHALL be derived only from official streaming delta kinds and lengths; streamed text, thinking, tool names inside the private response, tool arguments and result paths SHALL NOT be read for display, rendered or retained. Unobserved phases SHALL NOT be invented; elapsed time, accounting counters and token silence SHALL NOT be treated as proof of task completion or a percentage/ETA. Brief synchronous stages SHALL update projection without requiring an artificial delay to force a frame.

#### Scenario: Long model wait
- **WHEN** a private decision has waited 18 seconds without another observable phase change
- **THEN** its row still identifies model waiting and shows increasing operation elapsed time
- **AND** it does not invent completed steps or a completion estimate

#### Scenario: Model streams a private response
- **WHEN** a private model request streams thinking and then answer text
- **THEN** the row replaces `waiting for model` with `thinking`, then `writing`, an indicator that moves only while output arrives, and a growing streamed-character count, keeping correction/reconsideration prefixes, elapsed time and attempt
- **AND** none of the streamed text, thinking or tool-call arguments appears in the row or any retained state

#### Scenario: Reflection reads evidence
- **WHEN** a private reflection starts an admitted read helper and later returns to model generation
- **THEN** its row switches to evidence execution with the safe helper name and then back to model work
- **AND** neither the file path, arguments, output nor private assistant text is displayed

### Requirement: Attempt and review progress retain existing meanings
Rows SHALL show the current result-attempt ordinal and limit when known. A bounded invalid-result correction SHALL advance the displayed result attempt only when the next attempt is authorized. Continue's review-triggered reconsideration SHALL be named separately and use its existing independent result-attempt allowance. Provider transport retries, helper-only turns and review-service attempts SHALL NOT be counted as invalid-result attempts. Progress SHALL NOT alter any retry limit or enable retries otherwise disabled by plugin policy.

#### Scenario: Invalid Continue result is corrected
- **WHEN** Continue rejects result attempt 1 and authorizes its second result attempt
- **THEN** the row identifies correction and attempt 2/3 without changing the logical operation's elapsed-time origin
- **AND** no raw invalid response is displayed

#### Scenario: Review challenges an unlock candidate
- **WHEN** the configured review challenges the initial valid candidate and reconsideration starts
- **THEN** the row distinguishes review from reconsideration and shows the reconsideration attempt within its own existing allowance
- **AND** UI updates do not create an additional review or inquiry

#### Scenario: Native transport retries
- **WHEN** Reflect's native provider retries a request without consuming another result attempt
- **THEN** the row does not advance the result-attempt count
- **AND** a retry or compaction label is shown only if an official observation exposes that stage

### Requirement: Phase updates and elapsed time remain live
Under a responsive interactive host, an observed stage or terminal lifecycle change SHALL request a redraw immediately, without waiting for unrelated user input, parent output or an accounting tick. Active-operation elapsed time SHALL refresh at a one-second cadence, measured from a monotonic elapsed-time source rather than callback count, independently of the existing accounting clocks. Long setup and review waits SHALL remain live even when ordinary activity is idle. UI timers SHALL stop when no longer needed; they SHALL NOT start model work, keep a finished session alive or affect accounting/reset rules.

#### Scenario: Review runs without ordinary activity
- **WHEN** all ordinary agents are idle while a private review is pending
- **THEN** the visible operation elapsed time continues to update every second under a responsive host
- **AND** a review completion updates the row without requiring another agent event

### Requirement: Existing controls and counters survive responsive rendering
At sufficient width, Continue SHALL retain its ordinary running/idle state, enabled/disabled state, effective configured unlock shortcut or command, and root/subagent or decision-countdown information. Reflect SHALL retain active duration/loops, task duration/limit, root/all loop budgets, cooldown and any effective pending-request cancellation hint. Both rows SHALL use the same layout order at every width: plugin identity, then the active stage, elapsed time and attempt, then existing controls/counters; full-width rows SHALL NOT place progress after the controls/counters. Compact rows keep that order and drop secondary controls/counters first as space requires. Each SHALL render one line within available terminal columns across resize and theme changes, without mutating stored values. Omitted details SHALL reappear when width permits.

#### Scenario: Both rows active at full width
- **WHEN** Continue and Reflect both show private progress at sufficient width
- **THEN** each row shows its stage immediately after its plugin name, so both stages are vertically aligned at the start of the rows
- **AND** the existing controls/counters follow the progress in each row

#### Scenario: Narrow terminal during private work
- **WHEN** the terminal narrows so full state and progress no longer fit
- **THEN** each row uses a compact plugin identity and prioritizes the active stage over secondary counters
- **AND** neither row wraps, overruns the available columns or retains stale theme styling

#### Scenario: Customized unlock binding
- **WHEN** Continue uses a non-default unlock key and the terminal has room for full status
- **THEN** the row shows the effective binding, not a hardcoded alt+u hint

### Requirement: UI updates are scoped and cannot change policy
Progress SHALL belong to one exact operation and visible session ownership scope. On takeover, cancellation, completion, failure, branch/session replacement, ownership loss or shutdown, obsolete progress SHALL be cleared or changed to cancelling while that same operation drains. Late callbacks SHALL NOT repaint a newer operation, clear its highlight or restart its timer. UI observations/rendering failures SHALL NOT change result validation, accounting, control authority, outcome publication or unrelated parent execution.

#### Scenario: Cancelled operation reports late
- **WHEN** an old operation emits a helper or completion event after a new operation is visible
- **THEN** the new operation's stage, elapsed-time origin and highlight remain unchanged
- **AND** the old event cannot publish a result or schedule more work

#### Scenario: Private operation fails
- **WHEN** a current operation fails and settles
- **THEN** its active highlight and elapsed-time updates end and existing safe failure presentation remains available
- **AND** progress does not invent success, unlock or a continuation

### Requirement: Live progress stays outside conversation content
Live stages and elapsed ticks SHALL be ephemeral human UI only, not main transcript messages, model/summary input, per-tick history, notification spam or semantic completion hooks. Private thinking, raw responses, result-file locations, helper arguments/results and credentials SHALL remain hidden. Existing accepted outcome records, bounded safe diagnostics and semantic hooks SHALL retain their existing publication semantics. Non-TUI modes SHALL not require terminal components; existing RPC status support SHALL remain functional with safe plain-text progress where supported.

#### Scenario: Many redraws during a private inquiry
- **WHEN** an operation emits phase observations and sixty elapsed-time redraws
- **THEN** no new conversation, summary or audit entries are created solely by those progress updates
- **AND** accepted final content is published only through the existing outcome path

#### Scenario: RPC execution
- **WHEN** a plugin runs in RPC mode
- **THEN** its operation can finish without a terminal widget
- **AND** any existing supported status projection remains safe plain text rather than ANSI terminal rendering
