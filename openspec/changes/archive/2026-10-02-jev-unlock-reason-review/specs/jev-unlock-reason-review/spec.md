## Purpose

Before a `WAIT_USER` unlock takes effect, asks TypeSafe's jev model whether the evidence of the current turn already contains the permission the agent is waiting for; when it clearly does, the unlock is refused and the agent is told to continue.

## ADDED Requirements

### Requirement: Review scope
The watchdog SHALL review an `unlock_continue_watchdog` call only when all of the following hold: the call's arguments are valid, the normalized `reason_type` is `WAIT_USER`, the watchdog is locked for the current main agent, the `jevWaitCheck` gate is enabled, a jev endpoint and key resolve, and fewer than 3 rejections have happened in the current lock cycle. In every other case the call SHALL be handled exactly as it is without this capability. `JOB_DONE`, `JOB_BLOCKED`, `WAIT_CALLBACK`, and custom reason types SHALL never be reviewed. Human unlocks, terminal-error unlocks, and abort unlocks SHALL be unchanged. Following a tool-review rejection in a lock cycle, automatic wait-gate unlocks SHALL pass the same permission review and share its three-rejection budget; a rejected automatic unlock SHALL dispatch the ordinary continuation instead.

#### Scenario: JOB_DONE is not reviewed
- **GIVEN** the watchdog is locked and a jev key resolves
- **WHEN** the agent calls the tool with `reason_type` `JOB_DONE`
- **THEN** no jev request is made and the watchdog unlocks as before

#### Scenario: Callback waits are unchanged
- **WHEN** the agent calls the tool with `WAIT_CALLBACK`
- **THEN** no unlock-review request is made and the existing callback-wait behavior is preserved

#### Scenario: No key
- **GIVEN** no TypeSafe or OpenRouter key resolves
- **WHEN** the agent calls the tool with `reason_type` `WAIT_USER`
- **THEN** no jev request is made and the watchdog unlocks as before

#### Scenario: Not locked
- **GIVEN** the watchdog is unlocked
- **WHEN** the agent calls the tool with `reason_type` `WAIT_USER`
- **THEN** no jev request is made and the informational already-unlocked result is returned

### Requirement: Reviewed state is the current turn only
The review SHALL send jev exactly four sections, in this order: the stop claim (`reason_type` and `reason`); the latest user message on the current branch followed by the visible text of every `ask_user_question` result after it, marked as a user choice; the visible text of every assistant message after that user message, including the message carrying the tool call, oldest first, or an explicit empty marker; and one line per tool call after that user message giving the tool name, a one-line argument summary, and whether its result was an error. The review SHALL NOT send earlier user or assistant messages, tool result bodies other than `ask_user_question` answers, hidden thinking, the system prompt, or watchdog-injected continuation events. The resolved API key SHALL be removed from the sent text. When the state exceeds 24,000 Unicode characters, the oldest trace lines SHALL be dropped first, then assistant texts SHALL be shortened keeping their head and tail, then the user message and questionnaire answers SHALL be shortened keeping their head and tail. Every shortened section SHALL carry an explicit truncation marker. The stop claim SHALL remain complete. Missing tool results SHALL be marked pending, never successful. All state content SHALL be treated as evidence, not instructions for the reviewer.

#### Scenario: Earlier turns are excluded
- **GIVEN** a branch with five user messages
- **WHEN** the agent calls the tool with `WAIT_USER`
- **THEN** the sent state contains only the fifth user message, the ask answers and assistant texts after it, and the tool calls after it

#### Scenario: ask_user_question answer is included as user evidence
- **GIVEN** the agent asked a question with `ask_user_question` this turn and the user chose "fix and continue"
- **WHEN** the agent calls the tool with `WAIT_USER`
- **THEN** the sent state contains that answer in the user section

#### Scenario: Oversized user content
- **WHEN** the user message and questionnaire answers alone exceed the remaining state budget
- **THEN** their head and tail are retained with explicit truncation markers and the entire state is at most 24,000 Unicode characters

#### Scenario: Oversized trace
- **WHEN** the state would exceed the budget because of 300 tool calls
- **THEN** the oldest trace lines are dropped until it fits and the latest user message is still complete

### Requirement: Confident contradiction refuses the unlock
When jev chooses `contradicted` with probability at or above `jevWaitCheck.unlockReviewThreshold` (default 0.8), the tool call SHALL fail with an error result that states the review found the permission already given in this turn, names the reason type, shows the rejection count as `n/3`, and tells the agent to continue the authorized work instead of asking again. The watchdog SHALL remain locked, SHALL not change the attempt count, SHALL not publish `user-ready`, and SHALL not request run termination. The agent's run SHALL continue through Pi's ordinary tool-error follow-up.

#### Scenario: User already said continue
- **GIVEN** the latest user message is "你继续就行，不必总是问我" and the agent's final reply asks for a go-ahead
- **WHEN** the agent calls the tool with `WAIT_USER` and jev answers `contradicted` at 0.84
- **THEN** the tool result is an error containing `1/3`
- **AND** the watchdog is still locked and no `user-ready` is published

#### Scenario: Low probability is accepted
- **WHEN** jev answers `contradicted` at 0.53
- **THEN** the watchdog unlocks as before

### Requirement: Review fails open
Any outcome other than a confident `contradicted` SHALL accept the unlock exactly as without review: `supported`, `insufficient_evidence`, a probability below the threshold, a missing or invalid `contradicted` probability, a network or HTTP error, a malformed response, or a timeout. The review SHALL NOT substitute confidence for probability and SHALL NOT retry a failed request. The review SHALL use the `jevWaitCheck` endpoint, key order, model, and `timeoutMs`.

#### Scenario: Probability missing
- **WHEN** jev chooses `contradicted` with confidence 0.99 but no valid contradiction probability
- **THEN** the unlock is accepted

#### Scenario: jev times out
- **WHEN** the jev request exceeds `jevWaitCheck.timeoutMs`
- **THEN** the watchdog unlocks as before and no second request is sent

#### Scenario: Gate disabled
- **GIVEN** `jevWaitCheck.enabled` is `false`
- **WHEN** the agent calls the tool with `WAIT_USER`
- **THEN** no jev request is made and the watchdog unlocks as before

### Requirement: At most three rejections per lock cycle
The watchdog SHALL count rejections per lock cycle. After the third rejection in a cycle, further `WAIT_USER` calls and gated automatic unlocks in that cycle SHALL be accepted without a jev request. The counter SHALL reset when a new lock cycle starts (a new main user message or a lock-cycle restart). A rejection SHALL NOT consume an automatic-continuation attempt.

#### Scenario: Fourth call passes
- **GIVEN** three rejections already happened in this lock cycle
- **WHEN** the agent calls the tool with `WAIT_USER` again
- **THEN** no jev request is made and the watchdog unlocks

#### Scenario: Old gate cannot bypass a rejection
- **GIVEN** a tool review rejected the stop in this lock cycle
- **WHEN** the old wait gate proposes `WAIT_USER` and the permission review confidently contradicts it again
- **THEN** the shared rejection count increases, the watchdog remains locked, and the ordinary continuation is dispatched without `user-ready`

#### Scenario: New user message resets the count
- **GIVEN** two rejections happened in the previous lock cycle
- **WHEN** the user sends a new message and the agent later calls the tool with `WAIT_USER`
- **THEN** the review runs and a confident contradiction reports `1/3`

### Requirement: Stale verdicts are discarded
If, while the jev request is in flight, the watchdog is unlocked by any other path, the lock cycle restarts, or the calling session stops being the current main agent, the verdict SHALL be ignored: the call SHALL return the informational no-unlock-applied result and SHALL neither reject nor unlock.

#### Scenario: Human unlock during review
- **GIVEN** a review request is in flight
- **WHEN** the user runs the unlock command
- **THEN** the tool call returns the informational result and the human unlock stands

### Requirement: In-flight review aborts on shutdown
A review request SHALL be aborted on session shutdown or session switch, and its result SHALL have no effect.

#### Scenario: Shutdown mid-review
- **WHEN** the session shuts down while a review request is in flight
- **THEN** the request is aborted and nothing is unlocked or rejected afterwards
