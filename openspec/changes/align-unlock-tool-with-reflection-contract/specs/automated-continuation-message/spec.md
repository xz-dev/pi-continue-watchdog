## MODIFIED Requirements

### Requirement: Bounded resumed work
The system SHALL instruct the agent to resume only work already requested and authorized by the user. When additional user input, approval, or assistance is required, it SHALL direct the agent to stop that work and ask the user in normal reply text, without requiring a proactive watchdog function call. The body SHALL retain the completeness check across all session requests, excluding work already delivered, cancelled, or superseded.

#### Scenario: Remaining work needs no new approval
- **WHEN** actionable remaining work is already within the user's request and authorization
- **THEN** the continuation message directs the agent to resume that work

#### Scenario: Remaining work reaches user boundary
- **WHEN** resumed work reaches a step requiring new user input, approval, or assistance
- **THEN** the continuation message requires the agent to stop that action and ask the user
- **AND** it does not instruct an ordinary-turn unlock call

#### Scenario: Earlier request still missing
- **WHEN** an automatic continuation is published
- **THEN** its body tells the agent to check every task requested in the session, including earlier requests and not only the latest one, against actual delivery
- **AND** to continue requested and authorized work that can still proceed, otherwise report the actual boundary in normal reply text

### Requirement: Configurable guidance preservation
The system SHALL retain the effective configured continuation guidance inside the fixed automated attribution, completeness, and authorization-boundary wrapper. This complete body SHALL be available to both the human and the model, and rendering SHALL NOT substitute a summary. An old continuation event SHALL retain the guidance effective when it was published. Fixed extension guidance SHALL NOT require ordinary-turn use of the reserved function or disclose its argument contract.

#### Scenario: Custom continuation guidance is configured
- **WHEN** a valid custom continuation prompt is active and an automatic continuation is published
- **THEN** the continuation includes the custom guidance
- **AND** fixed source attribution, completeness, and non-authorization statements remain present
- **AND** the human-visible event contains that same complete text

#### Scenario: Guidance changes after acceptance
- **WHEN** configured continuation guidance changes after an event has been stored
- **THEN** reopening or rendering the old event does not regenerate its guidance

### Requirement: Watchdog events are not additional authority
New shared continuation, wait, completed-wait, unlock, decision-failure, and exhaustion bodies SHALL identify the extension as their source and explicitly deny being a user message, request, approval, confirmation, consent, or authorization. A watchdog decision or event SHALL NOT replace missing user authorization.

#### Scenario: Continuation while approval remains pending
- **WHEN** a continuation event appears while existing conversation contains an unresolved approval request
- **THEN** the event explicitly provides no approval or authorization
- **AND** existing user-boundary rules remain in effect

## REMOVED Requirements

### Requirement: Direct continuation without inquiry
**Reason**: Ordinary turn completion must trigger a watchdog-owned decision, not force another work turn or rely on a proactive unlock.
**Migration**: Open the qualified inquiry and publish ordinary continuation only after its accepted continue verdict.

#### Scenario: Ordinary settlement qualifies
- **WHEN** a locked ordinary run settles and the aggregate-idle fence qualifies with budget remaining
- **THEN** one decision inquiry precedes any ordinary continuation

### Requirement: Continuation body without model reason
**Reason**: The decision model once again selects continuation and supplies its reason.
**Migration**: Include the accepted reason type and reason in the shared canonical continuation event.

#### Scenario: Continued work has a selected reason
- **WHEN** a continue verdict is accepted
- **THEN** its normalized reason type and reason appear in the shared continuation body

### Requirement: Unlock and waiting guidance
**Reason**: Startup-style instructions to call unlock or stay inside an ordinary turn bypass the restored decision and bounded-wait flow.
**Migration**: Teach control outcomes only in the decision prompt. Ordinary continuation requests only authorized work and normal user-facing delivery.

#### Scenario: External work remains pending
- **WHEN** an ordinary run reports unfinished external work and settles
- **THEN** the qualified decision can choose bounded wait or a configured callback-wait unlock instead of mandatory ordinary-turn monitoring

## ADDED Requirements

### Requirement: Accepted continue starts one ordinary turn
A current accepted continue verdict SHALL publish one automatic continuation, consume one shared continue/wait retry attempt, and start one ordinary work turn. Neither inquiry dispatch nor a decision correction SHALL itself count as ordinary continuation. If no attempts remain, the existing terminal exhaustion behavior SHALL apply without a new inquiry or work turn. Failed publication and ownership races SHALL retain the existing rollback safeguards.

#### Scenario: Continue verdict accepted
- **WHEN** a consumed current decision accepts continue with budget remaining
- **THEN** one shared continuation event starts one ordinary turn and consumes one attempt
- **AND** the decision creates no separate acknowledgement-only turn

#### Scenario: Wait or unlock verdict accepted
- **WHEN** the current decision accepts wait or unlock
- **THEN** no immediate ordinary continuation is published

### Requirement: Continuation body includes the accepted reason
Each continuation SHALL be a shared timestamped event containing the normalized accepted continuation reason type and trimmed reason, fixed attribution, effective configured guidance, completeness check, and authorization boundary. Human and model SHALL receive the same canonical body, not a TUI-only result plus an independently assembled model summary. It SHALL contain no fixed instruction to call a watchdog function before ending ordinary work.

#### Scenario: Continuation body content
- **WHEN** an automatic continuation is published
- **THEN** both human and model receive the same runtime timestamp, accepted reason, attribution, guidance, and authorization boundary
- **AND** the body is not duplicated in a separate watchdog-only history block
