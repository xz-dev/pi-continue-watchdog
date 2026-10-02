## MODIFIED Requirements

### Requirement: Confident waiting verdict unlocks as WAIT_USER
When jev chooses the waiting-for-user option with confidence at or above the configured threshold (default 0.8), and the post-request state check passes, the watchdog SHALL unlock the lock cycle without consuming a retry attempt and SHALL publish no continuation, except when a tool-review rejection occurred in that cycle: then the proposed automatic `WAIT_USER` unlock SHALL first pass the permission review specified by `jev-unlock-reason-review`. Both paths SHALL share the same three-rejection cap; a rejected automatic unlock SHALL publish the ordinary continuation instead and SHALL not publish `user-ready`. An accepted automatic unlock SHALL then publish `user-ready` under the same aggregate-idle conditions as an unlock through the tool, with `STOP_KIND=AI_UNLOCK`, `REASON_TYPE=WAIT_USER`, and a `REASON` that says the jev model judged the final output to be a question for the user, followed by the last paragraph of that output. `REASON` SHALL be at most 1000 Unicode code points. If the paragraph does not fit, its tail SHALL be kept with a leading ellipsis. The watchdog SHALL show the user a notification that jev unlocked it. It SHALL add no model-visible message on acceptance.

#### Scenario: Agent asks the user a question
- **GIVEN** the final assistant text ends with "Should I use Postgres or SQLite?" and jev answers waiting-for-user with confidence 0.93, with no tool rejection in this cycle
- **WHEN** the gate completes and the state is unchanged
- **THEN** the watchdog is unlocked, no continuation is published, the attempt count is unchanged
- **AND** `user-ready` is published with `REASON_TYPE=WAIT_USER` and a `REASON` that credits the jev model and contains "Should I use Postgres or SQLite?"

#### Scenario: Long last paragraph
- **WHEN** the last paragraph would push `REASON` past 1000 code points
- **THEN** `REASON` is exactly the prefix plus an ellipsis plus the paragraph's tail, and is no longer than 1000 code points

#### Scenario: Rejected stop cannot bypass tool review
- **GIVEN** the user already authorized the work and a tool review rejected a `WAIT_USER` call this cycle
- **WHEN** a confident wait-gate verdict proposes stopping for that approval again and the permission review contradicts it
- **THEN** the watchdog continues instead of automatically unlocking, with the shared rejection counter incremented

### Requirement: Gate configuration
The watchdog SHALL accept an optional `jevWaitCheck` object with `enabled` (boolean, default true), `apiUrl` (an http(s) URL, normally the TypeSafe or OpenRouter System One endpoint; default automatic selection), `model` (default `jev-latest`), `confidenceThreshold` (number in [0, 1], default 0.8), `unlockReviewThreshold` (number in [0, 1], default 0.8; the minimum `contradicted` probability at which a reviewed unlock is refused, see `jev-unlock-reason-review`), `timeoutMs` (integer of at least 1000, default 15000), and the global-only `apiKey`. Each field SHALL follow the existing per-field validation and precedence of built-ins, then global, then trusted project. An invalid value SHALL produce a warning diagnostic and keep the lower-precedence value. `enabled`, `apiUrl`, `model`, `timeoutMs`, and `apiKey` SHALL apply to both the wait gate and the unlock reason review.

#### Scenario: Disable the gate
- **WHEN** the global config sets `"jevWaitCheck": { "enabled": false }`
- **THEN** no jev request is ever made

#### Scenario: Invalid threshold
- **WHEN** a config layer sets `confidenceThreshold` to 1.5
- **THEN** a warning diagnostic names the field and the lower-precedence threshold remains in effect

#### Scenario: Invalid review threshold
- **WHEN** a config layer sets `unlockReviewThreshold` to -0.1
- **THEN** a warning diagnostic names the field and the lower-precedence value remains in effect
