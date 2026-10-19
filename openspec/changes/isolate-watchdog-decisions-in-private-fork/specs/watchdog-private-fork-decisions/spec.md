## Purpose

Keep watchdog decision execution and format correction in one private fork session, with a host-owned JSON result file and a bounded terminal handoff that does not expose orchestration or decision tools to ordinary work.

## ADDED Requirements

### Requirement: Decision execution exposes no public orchestration surface
The watchdog SHALL own its decision runner independently of any public subagent extension installed by the user. Loading the watchdog SHALL NOT register subagent tools, commands, RPC/delegation bridges, agent catalogs, or decision-result functions in the user's session. Internal agent selection and retry policy SHALL NOT use user-defined agent profiles or public subagent configuration. The private child SHALL load only the required watchdog execution hooks, not ambient extension factories; provider registrations needed for the parent's selected model SHALL remain available without reloading those extensions. This is API and session isolation, not an operating-system sandbox against trusted code in the same process.

#### Scenario: Watchdog is installed without public subagents
- **WHEN** the watchdog starts a decision and no public subagent extension is installed
- **THEN** the private runner is available through the watchdog's own dependency
- **AND** no public subagent or decision-result tool or command is added

#### Scenario: Public subagents is also installed
- **WHEN** the user independently installs a public subagent extension and defines an agent with the same display name as the internal decision agent
- **THEN** the internal runner and policy are unchanged
- **AND** the watchdog neither replaces nor registers duplicate public tools, commands, or runtime state for that extension

### Requirement: One logical decision inherits a full effective fork
Each logical decision SHALL create one distinct child session from the owning main session's qualified active leaf. The child SHALL use the parent's current provider/model and thinking setting and inherit the full effective active-branch conversation, system prompt state, and tool declarations, subject only to the host's existing compaction, exclusion, and provider-compatibility rules. Decision instructions and source supplements SHALL be appended after the inherited conversation rather than replacing it. Legacy watchdog folding SHALL apply before inherited decision input is sent. No pruned fork, recent-message suffix, alternate-model fallback, or silent fresh-context fallback SHALL substitute for an unavailable full fork. Inherited tool declarations SHALL NOT grant execution permission. The system SHALL NOT claim byte-identical final provider payloads or guaranteed cache hits across arbitrary provider serializers or third-party transformations.

#### Scenario: The main model differs from the configured default
- **WHEN** an eligible main session uses a model other than the user's default
- **THEN** the private child uses that active model and a different session identity
- **AND** the user's selected session and main conversation remain unchanged during the decision

#### Scenario: Effective history excludes old internal exchanges
- **WHEN** the source branch contains old watchdog inquiry records, a retained native summary, and excluded or sibling material
- **THEN** the child receives the same eligible retained conversation and summary boundary without resurrecting old internal exchanges or sibling history
- **AND** new private decision messages are appended only to the child

#### Scenario: A full fork cannot be established
- **WHEN** the required source session, active leaf, or full-fork projection is unavailable
- **THEN** the operation reports an execution/setup failure without launching a fresh substitute
- **AND** no valid decision, invalid-format charge, or continuation charge is invented

### Requirement: A host-created JSON file is the only decision submission
The host SHALL allocate a private temporary result location unique to the logical decision and initialize its result file to the JSON object `{}` before each response attempt. It SHALL finish the prior attempt's admitted writes before resetting the file. A result SHALL be read only after that attempt's one model response and admitted write have settled normally. Only one complete JSON object read from the designated regular file SHALL supply the candidate; assistant prose, stdout, a tool result, a claimed success, and another file SHALL NOT supply or repair it. Missing, untouched, malformed, and structurally invalid model results SHALL follow the bounded invalid-response policy. A host filesystem/setup failure SHALL remain distinct from a model-format error. The temporary file SHALL NOT be a durable recovery or authorization store.

#### Scenario: No result was written
- **WHEN** a completed attempt leaves the initialized file as `{}`
- **THEN** required-field validation rejects that response once
- **AND** a statement in the assistant's reply that the decision succeeded does not replace the file

#### Scenario: JSON exists only in the assistant reply
- **WHEN** a completed response prints a valid-looking decision but does not write the designated result file
- **THEN** that printed object is not accepted as a result

#### Scenario: A previous attempt wrote a valid object
- **WHEN** the next authorized attempt starts
- **THEN** the host first resets its result file to `{}` after prior writes have stopped
- **AND** an unchanged old object cannot become the next attempt's decision

### Requirement: Child effects are restricted to the designated result write
The child SHALL be able to write its designated result file without a specialized decision-result function. Its execution permission SHALL permit at most the one designated result-file write for a response and SHALL reject ordinary work tools, delegation, shell commands, other paths, and replacement through a symbolic link. A response requesting forbidden or mixed tool effects SHALL be rejected before those effects run and SHALL count once as invalid rather than opening an uncontrolled tool-error loop. Access restrictions SHALL be enforced by the runner, not only described in a prompt. Parent tool declarations and executable child tools SHALL remain separate concepts.

#### Scenario: A response includes a file result and ordinary work
- **WHEN** one response requests both the result write and a source-code edit or shell command
- **THEN** the whole response is invalid and neither effect executes
- **AND** the runner remains within the existing correction allowance

#### Scenario: A write targets another path
- **WHEN** the response requests a write outside the host-designated result file
- **THEN** that write is prevented and cannot be accepted as a decision submission

### Requirement: Each response attempt has a hard one-response boundary
One attempt SHALL admit at most one completed model response and the permitted result write requested by that response. It SHALL allow the admitted write to complete before evaluating the file and SHALL prevent the agent loop from automatically requesting a second model response after tool success, tool failure, or missing submission. The single-response limit SHALL be enforced by execution control rather than prompt wording or a deprecated turn-budget field. Provider-owned transport retries SHALL remain subject to their existing policy and SHALL NOT be represented as model-format correction attempts or guaranteed single HTTP requests.

#### Scenario: A write would normally cause a follow-up model request
- **WHEN** the first model response requests the admitted result write
- **THEN** the write completes and the attempt stops without an acknowledgement-only or tool-follow-up model response
- **AND** file validation determines whether another authorized correction attempt is needed

#### Scenario: The first response contains no write
- **WHEN** the first model response settles without a result submission
- **THEN** that attempt ends after one response
- **AND** only the private correction policy can authorize another response

### Requirement: Format correction stays in the same child session
The private runner SHALL retain one child session for the initial inquiry, its format corrections, and any one optional review-triggered reconsideration. Each inquiry SHALL permit at most three consumed response attempts: the initial response and at most two corrections. After an invalid response, the runner SHALL append its concrete safe validator diagnostic and correction instruction to that child, reset the result file, and authorize the next single-response attempt without settling the foreground handoff or entering the main model. A valid candidate awaiting review SHALL not settle the handoff. One definite review challenge SHALL start a separate reconsideration inquiry in the same child with its own three-response allowance; no second review or reconsideration SHALL occur. Cancellation, stale ownership, setup failure, and provider failure SHALL NOT be charged as model-format errors.

#### Scenario: Invalid fields are corrected locally
- **WHEN** the first response writes a decision missing `action` and the second writes a valid decision after receiving that exact validation error
- **THEN** both responses have the same child session identity and no new fork is created
- **AND** the outer foreground operation returns only the final valid result

#### Scenario: All three responses are invalid
- **WHEN** an inquiry consumes three invalid responses
- **THEN** the runner returns one decision-failed terminal result and makes no fourth response request
- **AND** no continuation budget unit is spent

#### Scenario: Reconsideration also needs correction
- **WHEN** the one permitted semantic reconsideration begins after an initial valid unlock candidate
- **THEN** it uses the same child session and at most three single-response attempts of its own
- **AND** the logical decision contains at most six consumed decision responses, excluding independent review-service transport attempts

### Requirement: Foreground waiting is cancellable and does not invalidate itself
The foreground operation SHALL keep the main UI responsive and the main session selected while waiting for its terminal result. A private decision's own activity SHALL NOT be classified as external ordinary work that invalidates that decision or qualifies another concurrent inquiry. Genuine user takeover, manual unlock, source-branch/session replacement, ownership loss, shutdown, and external-work invalidation SHALL cancel the exact child and revoke its file-result authority. Parent-session abort SHALL NOT be used to cancel an unrelated main run. No cancelled attempt SHALL be reset or retried until its admitted writes can no longer affect a later attempt.

#### Scenario: The private child begins work
- **WHEN** the owned child changes from idle to generating
- **THEN** that internal activity neither cancels its own decision nor starts a second inquiry

#### Scenario: The user takes over
- **WHEN** genuine new user input starts while the private decision is pending
- **THEN** the old child's result authority is revoked and its work is cancelled
- **AND** the user's complete input follows normal main-session handling without a private queue replay

### Requirement: Only a current terminal handoff can affect the main session
The parent SHALL receive only a terminal validated decision or a typed terminal failure/cancellation from the private operation. Before a candidate commits, existing owner, source-session/branch, cycle, external-activity, and publication guards SHALL still qualify. Accepted fields SHALL pass unchanged through the existing normalization and outcome policy, without a main-model rewrite. Ordinary continuation work SHALL still run in the main session. New private prompts, invalid results, correction messages, tool traffic, and partial output SHALL NOT be appended to the main model conversation, visible transcript, or native summary input; existing accepted outcome presentation and context-excluded audit metadata SHALL remain permitted.

#### Scenario: A valid decision is delivered
- **WHEN** the child returns a valid still-current continuation decision
- **THEN** the parent publishes the existing canonical continuation using that decision's normalized fields
- **AND** no main-model request is made solely to confirm or reword the result

#### Scenario: A valid file arrives after cancellation
- **WHEN** a cancelled child or old temporary file becomes readable after the user has started new work
- **THEN** it cannot unlock, continue, charge, or publish into the replacement cycle

#### Scenario: Private retries completed successfully
- **WHEN** a decision required local corrections before final acceptance
- **THEN** the main conversation contains only the accepted outcome permitted by existing publication rules, not the private retry exchanges
