## MODIFIED Requirements

### Requirement: Built-in WAIT_CALLBACK reason type
Default `reasonTypes` SHALL remain `JOB_DONE`, `WAIT_USER`, `JOB_BLOCKED`, and `WAIT_CALLBACK`; a valid configured list SHALL replace those defaults. Only authorized decision guidance SHALL explain callback waiting. The compatible wire pair `action: "unlock"` with a validated configured type matching the built-in `WAIT_CALLBACK` SHALL suspend automatic watchdog activity while retaining the lock, rather than unlock. The inquiry SHALL finish without an acknowledgement-only model turn. This accepted suspension SHALL consume one unit of the plugin's shared `maxContinue` budget, without resetting its cycle or previous usage. No new action, duration, timer, poll, fabricated callback, or ordinary-turn stopping function SHALL be introduced. Other unlock reasons, including `JOB_DONE`, SHALL retain actual unlock semantics.

#### Scenario: Default unlock with WAIT_CALLBACK
- **GIVEN** a confirmed current inquiry, one used unit of `maxContinue: 3`, and an expected callback
- **WHEN** it accepts `{"action":"unlock","reason_type":" wait_callback ","reason_content":" Waiting for the subagent result. "}` under default reason configuration
- **THEN** the lock remains held, usage becomes two, and automatic inquiries and continuations are suspended
- **AND** one quiet callback-wait status is eligible, with an idle-qualified `user-ready` hook carrying `STOP_KIND=WAIT_CALLBACK`, `REASON_TYPE=WAIT_CALLBACK`, and the trimmed reason

#### Scenario: Custom list excludes callback reason
- **WHEN** a configured reason list omits `WAIT_CALLBACK`
- **THEN** a submission using that value is rejected under normal decision validation
- **AND** the plugin does not silently restore default enums or invent the meaning of a custom label

#### Scenario: The exception belongs to the validated action and built-in type pair
- **WHEN** a valid result uses another configured unlock label, or a type allowed for `continue` with action `continue`
- **THEN** it retains that action's existing effect rather than acquiring callback-suspension semantics from its reason text or display spelling

### Requirement: Decision-only callback wait guidance
Callback selection guidance SHALL exist only inside the authorized inquiry. The public declaration, startup guidance, and fixed ordinary continuation body SHALL NOT teach proactive callback-control calls. Authorized guidance SHALL explain that `unlock` plus the configured built-in `WAIT_CALLBACK` is the compatibility spelling for a lock-retaining suspension and uses one shared `maxContinue` unit. Native callback-driven workflows SHALL NOT be converted to polling or watchdog sleeps. Callback suspension SHALL neither demand user action nor assert external-task completion. For non-callback work, decision guidance SHALL require an available authorized ordinary monitoring/task-owned waiting action for continue, or an appropriate actual blocker for unlock; it SHALL NOT offer a `wait_seconds` alternative.

#### Scenario: Native callback workflow
- **WHEN** no independent work remains and an external agent is expected to wake the session
- **THEN** the inquiry can select callback suspension through the existing wire pair without polling, sleeping, or assigning a deadline

#### Scenario: Ordinary run copies the callback payload
- **WHEN** ordinary work calls `cw` using a previously seen `WAIT_CALLBACK` payload
- **THEN** the phase guard rejects it with no lock, suspension, accounting, or notification effect

#### Scenario: Job lacks a callback
- **WHEN** a remote job can only be monitored through a task tool
- **THEN** guidance does not describe it as a future callback
- **AND** any continuation names an available authorized monitoring action, not a watchdog delay

## ADDED Requirements

### Requirement: Callback suspension resumes on actual ordinary work
A suspended current cycle SHALL remain locked and start no automatic inquiry or work turn solely because time passes, aggregate idle is observed again, or unrelated child/domain status changes. Actual new ordinary work beginning in the owning main session SHALL end suspension without consuming another budget unit or resetting prior usage. Owned inquiry, correction, review, publication, and status traffic SHALL NOT qualify as that work. A callback notice without a started run SHALL NOT resume the cycle. A user-role message whose entire text exactly equals an entry of the plugin's built-in callback wake-text list SHALL be treated as automation: it SHALL NOT start a fresh cycle, replenish usage, or count as genuine user takeover, while it still counts as ordinary work that ends suspension. The list SHALL be fixed in the plugin, SHALL NOT be configurable or disableable, and SHALL contain only exact texts known to be sent by callback producers (initially the pi-subagents parent wake and the pi-intercom idle wake). Matching SHALL compare the whole text exactly, without trimming, prefix, substring, case folding, or pattern rules. Any other user-role message, including an extension-sent one, SHALL retain the existing user-message fresh-cycle behavior; role alone SHALL NOT establish automation. Genuine new human work SHALL retain the existing fresh-cycle behavior. A callback arriving before a pending suspension commits SHALL invalidate the old result rather than let it suspend the newer work.

#### Scenario: Idle observations cannot spend more units
- **GIVEN** callback suspension has consumed two of three units
- **WHEN** multiple idle observations and arbitrary elapsed time occur without new ordinary work
- **THEN** the lock and usage remain unchanged, with no new model request, timer-driven wake-up, or repeated suspension signal

#### Scenario: Extension wake uses a user-role transport
- **GIVEN** a suspended cycle with two of three units consumed
- **WHEN** a callback producer starts ordinary parent work with a user-role message whose text exactly equals a built-in wake text
- **THEN** that work proceeds in the same cycle with usage still two
- **AND** successful settlement can qualify for a new decision only after the existing idle fence

#### Scenario: Near-match text is not a known wake
- **WHEN** a user-role message differs from every built-in wake text by surrounding whitespace, case, or extra content
- **THEN** it is treated as an ordinary user message with the existing fresh-cycle behavior

#### Scenario: Status notice does not start work
- **WHEN** a callback notification is appended for display without starting ordinary execution
- **THEN** suspension and accounting remain unchanged

#### Scenario: Human starts a new request
- **WHEN** genuine interactive or RPC user work starts while callback suspension is current
- **THEN** the old suspension is superseded and the existing fresh-cycle behavior applies
- **AND** no old suspension signal or late result can alter that replacement cycle

#### Scenario: Callback beats the staged waiting verdict
- **WHEN** ordinary callback work starts after a waiting verdict is staged but before its guarded commit
- **THEN** the old verdict cannot pause the newer work, spend its budget, or emit a current waiting signal

### Requirement: Final callback allowance waits before exhaustion
When an accepted callback suspension consumes the final `maxContinue` unit, the watchdog SHALL remain locked and suspended and retain the `WAIT_CALLBACK` outcome, not immediately substitute `EXHAUSTED`. Actual callback-triggered ordinary work SHALL be allowed to run without replenishing the budget. After that work successfully settles and normal currentness and aggregate-idle publication checks pass, exhaustion SHALL be reported at most once and no further automatic inquiry or continuation SHALL begin. Terminal error, abort, manual unlock, genuine user replacement, and lifecycle invalidation SHALL retain their existing precedence and SHALL NOT fabricate callback completion.

#### Scenario: Last unit is a callback wait
- **GIVEN** `maxContinue` is two and one continuation has been consumed
- **WHEN** the next accepted result is callback suspension
- **THEN** usage becomes two, the lock remains held, and the eligible signal is `WAIT_CALLBACK`, not `EXHAUSTED`
- **AND** after actual callback work runs and successfully settles, the eligible signal becomes `EXHAUSTED` with no new automatic inquiry

#### Scenario: No callback arrives
- **WHEN** the final permitted callback suspension receives no actual new ordinary work
- **THEN** it stays suspended without a timeout, exhaustion signal, or fabricated task-completion claim

#### Scenario: Resumed callback work fails terminally
- **WHEN** resumed work settles with a terminal error after consuming the final waiting allowance
- **THEN** the existing terminal-error unlock path takes precedence rather than a successful-work exhaustion outcome

### Requirement: Callback suspension is live authority, not recoverable execution
Manual unlock SHALL clear a current suspension immediately. Existing abort, branch/session replacement, ownership loss, shutdown, and stale-result safeguards SHALL invalidate it and its pending publication as appropriate to those existing paths. Native retained records SHALL describe historical suspension without restoring its lock, budget, pending publication, or an automatic wake-up. Late callbacks and review results SHALL NOT restore an invalidated suspension; any genuinely new run remains subject to normal current lifecycle rules.

#### Scenario: Human unlocks while waiting
- **WHEN** the user invokes the unlock command or shortcut during suspension
- **THEN** the lock and suspension are released without waiting for a callback or reviewer
- **AND** a late result cannot reapply the old suspension or signal

#### Scenario: Reopen waiting history
- **WHEN** a session with a saved callback-wait status is reopened
- **THEN** that status remains historical, without restoring the prior suspension, budget, timer, notification, or execution
