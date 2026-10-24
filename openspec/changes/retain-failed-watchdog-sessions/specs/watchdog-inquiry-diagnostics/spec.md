## Purpose

Let users inspect the exact private watchdog session after a final inquiry failure, with reliable local JSONL retention and truthful human-only path diagnostics shared by Continue and Reflect.

## ADDED Requirements

### Requirement: Final inquiry failures retain the exact private session

Continue and Reflect SHALL preserve the existing native JSONL of the exact private child when a current logical inquiry ends in an execution failure or exhausts its invalid-result correction allowance. Available history SHALL survive operation cleanup and normal extension teardown without this feature deleting, truncating or replacing it. Partial history SHALL remain inspectable when execution fails before a complete final response. The parent session and other private sessions SHALL NOT substitute for the failed child. Retained history SHALL remain diagnostic evidence, not restored execution or result authority.

#### Scenario: Invalid corrections are exhausted
- **WHEN** a current inquiry consumes its permitted invalid-result attempts and ends in final failure
- **THEN** the exact child's native JSONL remains available after operation cleanup
- **AND** it includes the initial inquiry and the correction exchanges actually persisted for that operation
- **AND** no additional correction or model request is launched to create diagnostic evidence

#### Scenario: Provider execution fails after the child begins
- **WHEN** the provider terminates a current private inquiry with an execution failure after the child session has been persisted
- **THEN** the available private history is retained even without a complete final assistant response
- **AND** the failure does not erase that JSONL during normal teardown

#### Scenario: Continue reconsideration fails
- **WHEN** Continue's permitted semantic reconsideration ends in a final inquiry failure
- **THEN** the retained path identifies the same child used by the initial inquiry and reconsideration
- **AND** the main session remains separate from those private exchanges

### Requirement: Final failures disclose truthful session availability to the user

Each current failed logical inquiry SHALL produce at most one new human-only session-retention notice, combined with an existing terminal failure notice where possible. It SHALL identify the watchdog, provide a bounded safe failure summary, and show the full copyable absolute path of its retained JSONL when availability has been verified after settlement. The displayed locator SHALL come from the exact operation's actual native session, not model output, an inferred filename or the currently selected parent session. If no private session was created, or its evidence cannot be retained or verified, the notice SHALL explicitly state that evidence is unavailable and give a bounded safe reason without presenting a missing or unverified file as saved. An evidence failure SHALL NOT hide or replace the original inquiry failure.

#### Scenario: Continue final failure has retained evidence
- **WHEN** a current Continue inquiry fails and its private JSONL is accessible after settlement
- **THEN** the terminal human diagnostic identifies Continue, the safe failure summary and the full absolute private-session path
- **AND** that path opens the exact failed child's retained JSONL

#### Scenario: Reflect returns an execution failure
- **WHEN** a current Reflect inquiry returns an execution failure with an accessible private JSONL
- **THEN** the user receives a terminal human diagnostic naming Reflect and that JSONL's full absolute path
- **AND** the failure is not silently treated as an unreported non-success

#### Scenario: Setup fails before a child session exists
- **WHEN** private inquiry setup fails before any private JSONL is created
- **THEN** the human diagnostic reports the inquiry failure and states that no private session was created
- **AND** it does not label the main session or an invented child path as retained evidence

#### Scenario: Setup fails after native fork creation
- **WHEN** setup fails after a private fork JSONL has been created and its locator is known
- **THEN** the same retention and verified-path diagnostic contract applies to that file
- **AND** failure to finish child startup does not by itself discard the known evidence locator

#### Scenario: Evidence becomes unavailable before notification
- **WHEN** a failed operation has a session locator but the file is missing, unreadable or cannot be confirmed as its retained regular session file
- **THEN** the diagnostic states that evidence is unavailable or retention could not be verified
- **AND** it preserves the original safe failure summary without claiming successful retention

### Requirement: Only final failures trigger the new path notice

Normal success, intermediate invalid responses that later succeed, and provider transport retries that eventually succeed SHALL NOT trigger the new retention/path notice. Existing intermediate invalid-attempt warnings SHALL remain unchanged. Expected cancellation, user takeover, manual unlock or withdrawal, shutdown and stale ownership SHALL NOT be reported as final inquiry failures by this feature. Existing operation/session/ownership fencing SHALL apply immediately before notification so late results cannot publish a failure notice into a replacement session. An optional review-service failure that releases a valid decision SHALL NOT be reclassified as a failed private inquiry.

#### Scenario: Invalid response is corrected successfully
- **WHEN** an inquiry first produces an invalid result and later returns a valid accepted result within its allowance
- **THEN** existing correction warnings and successful outcome behavior remain unchanged
- **AND** no new retained-session path notice is emitted

#### Scenario: User takes over before settlement
- **WHEN** the user takes over or replaces the source session while a private inquiry is pending
- **THEN** normal cancellation and freshness rules remain authoritative
- **AND** no new failure/path notice is delivered into the replacement session

#### Scenario: Optional review is unavailable but the decision proceeds
- **WHEN** an optional review cannot complete and existing policy releases a valid private decision
- **THEN** the existing review warning and outcome policy remain unchanged
- **AND** that review condition alone does not trigger this feature's path notice

### Requirement: Diagnostic retention preserves privacy and outcome behavior

The new path and evidence-availability information SHALL be human-only and SHALL NOT enter prompts, model-bound continuation/feedback, normal outcome bodies, main-session private-review/audit records or completion hooks. The diagnostic SHALL NOT echo raw malformed results, provider response bodies, thinking or tool arguments. Evidence SHALL remain local, without automatic upload or expanded access permissions. Existing private-session isolation, temporary result cleanup, response/helper/continuation allowances, outcome validation, cancellation and resource-release behavior SHALL remain unchanged. Retention or notification failure SHALL NOT start another model request, authorize a result, restore a lock or prevent normal slot release. This capability SHALL NOT introduce a new successful-session cleanup or automatic diagnostic-expiry policy.

#### Scenario: Failure includes sensitive private content
- **WHEN** a final failed private inquiry contains inherited user material, private thinking, tool payloads or malformed result text
- **THEN** the new human diagnostic contains only its safe summary and session availability/path
- **AND** the private content remains in the retained JSONL rather than being copied into the main conversation or uploaded

#### Scenario: Retention verification or notification fails
- **WHEN** evidence verification or the human notification facility fails during terminal error handling
- **THEN** existing inquiry failure recovery and resource release still complete
- **AND** no extra retry, continuation charge, reflection dispatch or model call is caused by that diagnostic failure

#### Scenario: A retained failed session is present on restart
- **WHEN** the plugin reloads with a previously retained failed-session JSONL on disk
- **THEN** that file remains available for user inspection
- **AND** its presence does not resume the inquiry, replay a result or restore prior execution authority
