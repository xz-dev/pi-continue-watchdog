## MODIFIED Requirements

### Requirement: Bounded resumed work
The system SHALL direct the agent to resume only still-needed work already requested and authorized by the user. It SHALL compare all outstanding session requests against actual delivery, excluding delivered, cancelled, or superseded work. When new input, approval, or assistance is necessary, it SHALL direct the agent to stop that action and ask the user normally, not call a control function proactively. Guidance SHALL preserve explicit permission for unchanged scope and SHALL not create a new confirmation step merely because the watchdog resumed the agent or a prior assistant reply asked for the same permission. Later scope restrictions and genuinely unsatisfied confirmation requirements SHALL remain controlling. A watchdog-generated next-action suggestion SHALL NOT override the user's scope, constraints, permissions, or latest actual delivery evidence.

#### Scenario: Remaining work needs no new approval
- **WHEN** requested, authorized verification remains incomplete
- **THEN** continuation directs the agent toward that concrete verification

#### Scenario: Remaining work reaches user boundary
- **WHEN** the suggested next action requires permission not yet granted
- **THEN** the agent is instructed to stop that action and ask the user
- **AND** the event does not supply approval or teach an ordinary-turn `cw` call

#### Scenario: Earlier request still missing
- **WHEN** a continuation is selected for an earlier outstanding request
- **THEN** its guidance preserves that request while excluding already delivered or superseded work

### Requirement: Configurable guidance preservation
The accepted next-action reason SHALL appear prominently in a fixed plugin-attributed continuation envelope together with the effective configured continuation guidance, delivery check, and authorization boundary. The same immutable body SHALL be available to the human and the model, with only presentation styling differences. Redraw or later configuration changes SHALL NOT regenerate old event text. Fixed ordinary continuation text SHALL NOT disclose the reserved function's argument contract or require its proactive use.

#### Scenario: Custom continuation guidance is configured
- **WHEN** a continuation is published with custom guidance
- **THEN** its body includes the accepted next-action reason and configured guidance
- **AND** source attribution and non-authorization statements remain present

#### Scenario: Guidance changes after acceptance
- **WHEN** configuration changes after publication
- **THEN** rendering or reopening the event preserves its original body

### Requirement: Provider-facing semantics
The provider-bound continuation SHALL identify Continue watchdog as an automated extension source, not a user message, request, approval, confirmation, consent, or authorization, regardless of provider role conversion. Its accepted reason SHALL be labeled as the plugin's suggested next step, not a verified fact or a user's instruction. Its canonical human-visible body SHALL survive as a text segment without a duplicate independently constructed reason or summary.

#### Scenario: Custom message converts to user role
- **WHEN** Pi converts the continuation to a provider-facing user-role message
- **THEN** its body still states its extension origin and absence of user authorization
- **AND** both readers receive the same accepted next-action text

### Requirement: Visible extension event block
A continuation SHALL remain an extension-owned message distinguishable from user-authored conversation. It SHALL clearly name Continue watchdog and the suggested next step, preserve its runtime-authored RFC 3339 publication timestamp with explicit offset, and avoid a separate receipt-only message. These continuation requirements SHALL NOT force an AI unlock to become model-bound content.

#### Scenario: Human views history
- **WHEN** the user scrolls to an accepted continuation
- **THEN** one extension event identifies its next action and original publication time
- **AND** no additional `Decision received.` row appears for its successful internal exchange

### Requirement: Watchdog events are not additional authority
New shared continuation, exhaustion, and decision-failure bodies SHALL identify the extension as their source and explicitly deny being a user message, request, approval, confirmation, consent, or authorization. An AI-unlock status SHALL be excluded from model-bound conversation rather than repeating that disclaimer to the user. No outcome SHALL expand the user's authorization. The fixed continuation guidance SHALL also make clear that absence of new authorization from the plugin does not revoke or reset permission already granted by the user; permission is reevaluated only against actual scope changes, revocations, and applicable unsatisfied requirements.

#### Scenario: Continuation while approval remains pending
- **WHEN** an automatic continuation is published while a required approval is unresolved
- **THEN** the message supplies no approval and retains the user-boundary rule

#### Scenario: Continuation after permission was already granted
- **GIVEN** the user has authorized the exact remaining action and no separate confirmation requirement is outstanding
- **WHEN** the continuation says that it is not user authorization
- **THEN** its guidance preserves the existing permission instead of asking for the same approval again

## REMOVED Requirements

### Requirement: Direct continuation without inquiry
**Reason**: The current guarded inquiry remains the sole model-decision entry point; this change does not restore proactive unlocking or unconditional continuation.
**Migration**: Retain the predecessor's inquiry lifecycle and narrow its accepted results to continue and unlock.

#### Scenario: Eligible ordinary settlement
- **WHEN** locked work settles with budget remaining
- **THEN** the qualified internal inquiry precedes any continuation

### Requirement: Continuation body without model reason
**Reason**: The accepted reason is the useful next-action hint the user wants surfaced.
**Migration**: Carry the validated reason once as explicitly plugin-generated next-step guidance.

#### Scenario: Accepted continuation reason
- **WHEN** the decision selects continue with `Run the requested tests.`
- **THEN** the continuation presents that text as its suggested next step

### Requirement: Unlock and waiting guidance
**Reason**: Ordinary work must not be taught proactive control calls; timed watchdog waiting is retired.
**Migration**: Explain only actionable continuation and authorization boundaries in ordinary context; provide outcome selection rules only within the authorized inquiry.

#### Scenario: Native callback work remains pending
- **WHEN** a native callback-capable task is pending
- **THEN** the continuation does not instruct proactive callback unlocking or replace the native callback with polling

## ADDED Requirements

### Requirement: Action-oriented continuation reason
Each accepted continuation SHALL introduce its normalized reason type and trimmed reason as the Continue watchdog next-action hint. It SHALL NOT wrap the reason merely as a quoted previous automated result or a JSON history object. The reason SHALL remain plugin-generated guidance, not new permission, task-completion evidence, or an unconditional instruction. Guidance SHALL require reconciliation against current user scope and latest delivered results rather than repeating an already-delivered answer or reopening an answered permission question solely because a watchdog reason requests it. No extra model request SHALL be used solely to rephrase that reason.

#### Scenario: Specific next action
- **WHEN** a current decision accepts `VERIFYING` with reason `Run the requested tests.`
- **THEN** the next ordinary request prominently contains a Continue watchdog next-step label and that reason
- **AND** it does not contain the raw `cw` submission or a duplicate prior-result JSON object

#### Scenario: Stale next-action hint requests repeated delivery
- **WHEN** a continuation asks for a proposal summary already present in the latest ordinary reply
- **THEN** its fixed guidance requires checking actual delivery instead of treating that hint as proof of unfinished work
- **AND** the hint supplies neither a requirement to repeat the answer nor permission to start an unrequested next phase

### Requirement: Accepted continue starts one ordinary turn
A current accepted continue verdict SHALL publish one attributed continuation, consume one retry attempt, and start one ordinary work turn under the existing durable-publication, ownership, rollback, and cancellation safeguards. Inquiry dispatch, corrections, unlock status, and invalid decisions SHALL start no ordinary work turn by themselves.

#### Scenario: Continue verdict accepted
- **WHEN** a valid current continue result is accepted and publication succeeds
- **THEN** exactly one continuation starts ordinary work and consumes one attempt

#### Scenario: Unlock verdict accepted
- **WHEN** a valid current unlock result is accepted
- **THEN** no ordinary continuation or acknowledgement-only model turn starts
