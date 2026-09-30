## Purpose

Before an automatic continuation is sent, asks TypeSafe's jev model whether the final assistant output is clearly waiting for a user answer. When jev says it is, the watchdog unlocks as a `WAIT_USER` stop instead of continuing.

## ADDED Requirements

### Requirement: Gate placement before an automatic continuation
When the locked current main agent qualifies at the post-idle check and the retry budget allows another continuation, the watchdog SHALL evaluate the jev wait gate before it publishes that continuation, if the gate is active. The gate SHALL NOT run for the exhaustion path, for a terminal-error settlement, for an abort, or while the watchdog is unlocked. The gate SHALL add no fixed delay beyond the existing idle fence. This requirement is the only exception to "no decision question precedes a direct continuation". When the gate is inactive or makes no request, continuation behavior SHALL be unchanged.

#### Scenario: Gate runs before a continuation
- **GIVEN** the gate is active and the watchdog is locked with retry budget remaining
- **WHEN** the main agent ends its run without calling `unlock_continue_watchdog` and the idle fence qualifies
- **THEN** exactly one jev classification is requested before any continuation is published

#### Scenario: No gate on exhaustion
- **GIVEN** the retry budget is already spent
- **WHEN** the idle fence qualifies
- **THEN** no jev request is made and the existing exhaustion behavior applies

### Requirement: Default enablement follows key availability
The gate SHALL be active by default exactly when a TypeSafe or OpenRouter API key can be resolved for its endpoint. The key SHALL be resolved from Pi's own credentials for the endpoint's provider first, then from the provider's standard environment variable (`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`), then from the global watchdog config. When no endpoint is configured, TypeSafe SHALL be preferred over OpenRouter. A configuration value of `enabled: false` SHALL disable the gate even when a key exists. An API key SHALL be accepted only from the global config layer, never from a project config. With no resolvable key the gate SHALL make no request and SHALL emit no warning on each continuation.

#### Scenario: TypeSafe key present
- **GIVEN** `TYPESAFE_API_KEY` is set and there is no `jevWaitCheck` config
- **WHEN** a continuation qualifies
- **THEN** the jev request is sent to the TypeSafe endpoint

#### Scenario: Only an OpenRouter key present
- **GIVEN** Pi has OpenRouter credentials and no TypeSafe key is resolvable
- **WHEN** a continuation qualifies
- **THEN** the jev request is sent to the OpenRouter System One endpoint

#### Scenario: No key
- **GIVEN** no TypeSafe or OpenRouter key is resolvable
- **WHEN** a continuation qualifies
- **THEN** no jev request is made and the continuation is published as before

#### Scenario: Project config cannot inject a key
- **WHEN** a trusted project config sets `jevWaitCheck.apiKey`
- **THEN** that value is ignored and a warning diagnostic names the key

### Requirement: Classified input is the final assistant text only
The gate SHALL classify only the visible text of the latest assistant message of the settled run, and only when that message ended normally with non-blank text. It SHALL send no tool arguments, tool results, hidden thinking, system prompt, or earlier messages. The resolved API key SHALL be removed from the sent text. The gate SHALL NOT request a classification more than once for the same assistant message within a session, including when that message becomes latest again after branch navigation. A qualification with no resolvable key SHALL NOT count as a classification, so a key that becomes available later still enables the gate for that message.

#### Scenario: Final message has no text
- **WHEN** the latest assistant message contains only tool calls or blank text
- **THEN** no jev request is made and the continuation proceeds

#### Scenario: Same message qualifies again
- **GIVEN** jev has already classified a given assistant message
- **WHEN** the same message is the latest one at a later qualification
- **THEN** no new jev request is made for it

### Requirement: Confident waiting verdict unlocks as WAIT_USER
When jev chooses the waiting-for-user option with confidence at or above the configured threshold (default 0.8), and the post-request state check passes, the watchdog SHALL unlock the lock cycle without consuming a retry attempt and SHALL publish no continuation. It SHALL then publish `user-ready` under the same aggregate-idle conditions as an unlock through the tool, with `STOP_KIND=AI_UNLOCK`, `REASON_TYPE=WAIT_USER`, and a `REASON` that says the jev model judged the final output to be a question for the user, followed by the last paragraph of that output. `REASON` SHALL be at most 1000 Unicode code points. If the paragraph does not fit, its tail SHALL be kept with a leading ellipsis. The watchdog SHALL show the user a notification that jev unlocked it. It SHALL add no model-visible message.

#### Scenario: Agent asks the user a question
- **GIVEN** the final assistant text ends with "Should I use Postgres or SQLite?" and jev answers waiting-for-user with confidence 0.93
- **WHEN** the gate completes and the state is unchanged
- **THEN** the watchdog is unlocked, no continuation is published, the attempt count is unchanged
- **AND** `user-ready` is published with `REASON_TYPE=WAIT_USER` and a `REASON` that credits the jev model and contains "Should I use Postgres or SQLite?"

#### Scenario: Long last paragraph
- **WHEN** the last paragraph would push `REASON` past 1000 code points
- **THEN** `REASON` is exactly the prefix plus an ellipsis plus the paragraph's tail, and is no longer than 1000 code points

### Requirement: Gate fails open
The watchdog SHALL continue exactly as it does without the gate whenever the gate does not produce a confident waiting verdict. This covers a network error, HTTP error, timeout (default 15 seconds), malformed response, a not-waiting or unclear choice, and confidence below the threshold. Failures SHALL NOT be retried within the same qualification, SHALL NOT unlock, and SHALL NOT consume any extra attempt.

#### Scenario: jev times out
- **WHEN** the jev request exceeds its timeout
- **THEN** the continuation is published as if the gate were inactive

#### Scenario: Low-confidence waiting
- **WHEN** jev chooses waiting-for-user with confidence below the threshold
- **THEN** the continuation is published

### Requirement: Stale verdicts are discarded
After the jev request settles, the watchdog SHALL re-check that the same main ownership, the same aggregate idle generation, the lock, the qualified fence, a fresh idle state, and the classified message still being the branch's latest assistant message all still hold. If any of them changed during the request, including a new user message, an agent turn started by another extension, branch navigation, a manual unlock, or a lock-cycle restart, the verdict SHALL be discarded. The watchdog SHALL then neither unlock nor continue for that qualification. Later activity SHALL be handled by the normal fence.

#### Scenario: Another extension wakes the agent during the request
- **GIVEN** a jev request is in flight
- **WHEN** another extension steers the agent and a new turn starts
- **THEN** the jev verdict is ignored and no continuation or unlock results from it

#### Scenario: Branch navigation during the request
- **GIVEN** a jev request for message A is in flight
- **WHEN** the user navigates to a branch whose latest assistant message is B
- **THEN** the verdict for A neither unlocks nor continues
- **AND** the next qualification classifies B

#### Scenario: User replies during the request
- **WHEN** the user sends a message while the jev request is in flight
- **THEN** the verdict is discarded and the new user message starts a fresh lock cycle as usual

### Requirement: Gate configuration
The watchdog SHALL accept an optional `jevWaitCheck` object with `enabled` (boolean, default true), `apiUrl` (an http(s) URL, normally the TypeSafe or OpenRouter System One endpoint; default automatic selection), `model` (default `jev-latest`), `confidenceThreshold` (number in [0, 1], default 0.8), `timeoutMs` (integer of at least 1000, default 15000), and the global-only `apiKey`. Each field SHALL follow the existing per-field validation and precedence of built-ins, then global, then trusted project. An invalid value SHALL produce a warning diagnostic and keep the lower-precedence value.

#### Scenario: Disable the gate
- **WHEN** the global config sets `"jevWaitCheck": { "enabled": false }`
- **THEN** no jev request is ever made

#### Scenario: Invalid threshold
- **WHEN** a config layer sets `confidenceThreshold` to 1.5
- **THEN** a warning diagnostic names the field and the lower-precedence threshold remains in effect
