## Purpose

Provide an independent review of AI unlock reasons, on by default, using the owning session's permitted macro-level evidence, without making third-party availability a prerequisite for the existing watchdog behavior.

## ADDED Requirements

### Requirement: Unlock review is enabled by default and limited to AI stopping decisions
The watchdog SHALL expose a boolean `unlockReviewEnabled` with default `true`, following existing trusted configuration layering and validation behavior. Disabled operation SHALL perform no review-service lookup or request. When enabled but the review service is absent, unconfigured, incompatible or otherwise unavailable, the watchdog SHALL show a warning notification and release the unlock normally without interrupting the session. Enabled operation SHALL review only a current, protocol-valid initial AI `unlock` candidate, before its effect is committed. All configured AI unlock reasons SHALL be eligible; `unlock` SHALL NOT be treated as synonymous with completed work. `continue`, invalid responses, ordinary reserved-function calls, manual unlock, abort, and terminal-error unlock SHALL NOT invoke this review. Enabling it SHALL NOT install a dependency or restore the removed `jevWaitCheck` setting.

#### Scenario: Disabled operation and continuations
- **WHEN** the setting is false, or the candidate is `continue`
- **THEN** the existing decision path runs without third-party discovery or review

#### Scenario: Enabled without an available service
- **WHEN** the setting is absent or true and no compatible review service is loaded
- **THEN** a warning is shown and the AI unlock proceeds through the normal path
- **AND** the session is not interrupted and no installation is attempted

#### Scenario: A non-completion unlock
- **WHEN** a valid initial AI unlock gives a waiting, callback, or blocker reason
- **THEN** the review assesses whether that stated stopping basis is supported rather than requiring all work to be completed
- **AND** custom reason labels receive no invented meanings

#### Scenario: Human cancellation bypasses review
- **WHEN** the user manually unlocks or aborts, or a terminal error triggers existing unlock behavior
- **THEN** that behavior does not wait for third-party approval

### Requirement: Macro evidence preserves effective conversation and source roles
Review input SHALL pair the candidate action, reason type, and reason content with a frozen permitted macro-level snapshot of the corresponding native effective conversation. The candidate SHALL be labelled as a claim to assess, not as delivery evidence or user permission. Public user instructions, ordinary assistant reports, eligible public custom messages, and applicable native summaries SHALL retain chronology and source provenance. Assistant reports SHALL remain reported facts rather than independently verified execution; summaries SHALL remain derived material. The projection SHALL respect the host-selected active ancestry and compaction boundary, without restoring excluded old raw material or using sibling records. Owned decision/control traffic and reviewer opinions SHALL NOT become new user requests or authorization.

#### Scenario: An older delivery is absent from the latest reply
- **WHEN** an earlier relevant delivery remains in native effective context but the latest reply does not repeat it
- **THEN** the permitted report remains available to review rather than being removed by a recent-message cutoff

#### Scenario: A later restriction changes the scope
- **WHEN** a later user instruction revokes or narrows earlier permission
- **THEN** both the prior evidence and later restriction retain their order and original roles
- **AND** the old permission is not promoted over the later restriction

#### Scenario: Compaction and a sibling verdict
- **WHEN** the host has summarized earlier material and a sibling branch contains a later verdict
- **THEN** review uses the current retained summary and eligible branch material, not summarized-away raw text or the sibling verdict

### Requirement: Tool reduction does not erase questionnaire answers
Ordinary tool and shell activity SHALL be represented by tool identity, call/result association, and available execution status, not commands, arguments, file contents, or result/log bodies. A returned call SHALL NOT establish task completion or user approval. A successful `ask_user_question` result SHALL instead keep its public question and answer text, attributed to the tool with its call/result provenance. Cancelled or error questionnaire results SHALL keep only their status. Ordinary text questions and answers between user and assistant SHALL remain in full as user/assistant rows.

#### Scenario: Ordinary text Q&A
- **WHEN** the assistant asks a question in text and the user answers in a normal message
- **THEN** both remain in full and in order in the review input

#### Scenario: Questionnaire answer is kept
- **WHEN** a successful `ask_user_question` result is on the effective context
- **THEN** review receives its question and answer text, not merely a successful tool event
- **AND** later user restrictions can still supersede that answer

#### Scenario: Cancelled questionnaire
- **WHEN** a questionnaire was cancelled or failed
- **THEN** it supplies no answer, only its status

### Requirement: Review privacy and factual completeness are explicit
The external macro snapshot SHALL exclude private thinking, hidden extension/control state, system prompts, skill catalogs, raw images/binary data, and context-excluded shell material. Excluded material and its source identities SHALL NOT leak through auxiliary evidence metadata. Known provider secrets SHALL be redacted by the shared service's existing mechanism; the watchdog SHALL NOT add a separate sanitizer. Public content that cannot be exported SHALL be labelled as an unsupported-content gap, and a known gap SHALL make the review incomplete without calling the service. The watchdog SHALL NOT substitute its bounded 8,000-code-point supplemental view, a last-N suffix, arbitrary character cropping, prior classifications, or processing checkpoints for the complete necessary permitted facts. If the required snapshot cannot be represented or admitted within the selected backend's capacity, review SHALL be incomplete; it SHALL NOT shorten facts until an apparently successful answer becomes possible.

#### Scenario: Input exceeds capacity
- **WHEN** the complete necessary macro snapshot does not fit the selected backend
- **THEN** the review is reported incomplete without an application-level suffix crop, extra summarizer, or guessed factual summary
- **AND** the still-current original unlock follows the incomplete-review policy

#### Scenario: Excluded and unsupported content
- **WHEN** the session contains excluded shell content, hidden control records, and an unsupported public attachment
- **THEN** excluded bodies and identities remain outside the request and its metadata
- **AND** unsupported necessary public content is disclosed as a gap, not invented as text

#### Scenario: A prior opinion exists without the necessary facts
- **WHEN** a stored judgment or processing checkpoint remains available but its needed source facts are unavailable
- **THEN** the old judgment does not certify a complete current review

### Requirement: The shared service owns inference and exact-input reuse
The watchdog SHALL use the already-loaded shared review capability rather than a direct provider client, alternative model fallback, or a competing cache/recovery engine. Discovery SHALL occur only at an eligible review boundary and SHALL be retried on a later eligible decision if the dependency was previously absent. Review SHALL be bounded by the shared service's own backend-specific timeout policy and SHALL be cancellable through lifecycle-linked abort; the watchdog SHALL NOT add a competing outer timer. Required final accepted answers SHALL distinguish support, a definite challenge, and insufficient evidence; partial progress, missing answers, errors, and unsupported capabilities SHALL NOT authorize a challenge. Identical factual inputs and questions SHALL remain eligible for service-owned reuse, while changes in candidate meaning, evidence, provenance, or policy SHALL prevent inappropriate reuse. Review output SHALL NOT create user authorization or bypass local outcome validation.

#### Scenario: Dependency becomes available later
- **WHEN** review is enabled but the service is absent for one decision and present for a later eligible decision
- **THEN** the first decision uses the unavailable-review path without automatic installation or provider fallback
- **AND** the later decision discovers the service normally

#### Scenario: Repeated settlement observes one pending review
- **WHEN** the same candidate is observed repeatedly before review settles
- **THEN** those observations do not create duplicate business review requests

#### Scenario: Reuse versus changed facts
- **WHEN** identical public input is reviewed again, or a user decision or candidate reason changes
- **THEN** the service can reuse the identical judgment but cannot present the old judgment as evaluation of changed meaning

### Requirement: Incomplete review preserves the current original unlock
A supported review SHALL release the original candidate to existing commit and publication checks. Missing/incompatible service, exception, timeout, malformed or missing required answer, insufficient evidence, unavailable observation capability, or inadmissible necessary context SHALL be recorded as incomplete review and SHALL likewise release the still-current original candidate. These conditions SHALL NOT cause an additional main-model reconsideration, automatic retry loop, or false review-approval claim. This fallback SHALL NOT resurrect a candidate invalidated by user takeover, manual unlock, abort, branch/session replacement, ownership loss, shutdown, or other existing currentness guards.

#### Scenario: Service timeout while the candidate is current
- **WHEN** the service reports a timeout or inactivity error and the original candidate still qualifies
- **THEN** the original unlock proceeds through the normal publication path with review marked incomplete
- **AND** no extra main-model request is made merely because review failed

#### Scenario: User takeover and a late service response
- **WHEN** user takeover invalidates the candidate before a supported answer or timeout callback arrives
- **THEN** neither approval nor incomplete-review fallback publishes the old unlock, re-locks the session, or changes the new work's accounting

### Requirement: A definite challenge allows one semantic reconsideration
A complete accepted challenge SHALL withhold the initial candidate's effect and request at most one separately owned main-model reconsideration inquiry. The feedback SHALL identify the challenged candidate and review classification, distinguish opinion from evidence, and ask the main model to recheck the original permitted facts without inventing reviewer-authored explanations or new user permission. The reviewer SHALL NOT choose the replacement watchdog action. A valid reconsidered `continue` or `unlock` SHALL follow the existing outcome path without another third-party review in that logical decision. Repeated callbacks, format corrections, or delivery deferrals SHALL NOT reset the reconsideration bound. Inquiry-format failure SHALL retain the existing bounded decision-failed behavior rather than masquerading as third-party unavailability.

#### Scenario: The main model keeps unlock
- **WHEN** a challenged candidate is reconsidered once and the main model submits a valid unlock again
- **THEN** that result reaches existing currentness/publication checks without a second review or an automatic reversal to continue

#### Scenario: The main model changes to continue
- **WHEN** the one reconsideration returns a valid authorized continuation
- **THEN** normal durable continuation publication and retry accounting apply
- **AND** the review and reconsideration themselves spend no continuation attempt

#### Scenario: The reconsideration fails its response protocol
- **WHEN** the reconsideration exhausts its existing inquiry-format response allowance
- **THEN** the normal decision-failed path applies, without another reconsideration or release of the superseded initial candidate

### Requirement: Review history and diagnostics do not create execution authority
Each review's disposition, service identity, and observed attempt/usage diagnostics SHALL be appended as one record to the owning native session, linked to the exact local decision. No separate review database or sidecar SHALL be introduced. Supported, challenged, incomplete, and stale/cancelled outcomes SHALL remain distinguishable from a published watchdog outcome. One business review SHALL NOT be advertised as exactly one provider request; missing usage SHALL NOT be reported as zero. Optional diagnostic/history failures SHALL NOT relock an unlock, charge continuation budget, launch another provider call, or add an independent append-acknowledgement execution gate. Recovery SHALL restore history only, never locks, pending calls, or automatic publication. Existing canonical-publication requirements and rollback SHALL remain unchanged.

#### Scenario: Optional history writing fails
- **WHEN** review has a usable disposition but optional association/diagnostic persistence fails
- **THEN** normal current outcome behavior remains available and incomplete history is disclosed safely
- **AND** no replacement store, extra model call, or relock is created

#### Scenario: Session reopen after a challenged candidate
- **WHEN** the native session is reopened with a review record but no published replacement outcome
- **THEN** the record remains historical and no old reconsideration or outcome is automatically executed

#### Scenario: Transport retries are observed
- **WHEN** one review operation causes several service-owned transport attempts or reports incomplete usage
- **THEN** diagnostics preserve the actual observations and missing values instead of claiming one request or zero cost
