## MODIFIED Requirements

### Requirement: Macro evidence preserves effective conversation and source roles
Review input SHALL pair the candidate action, reason type, and reason content with a frozen permitted macro-level snapshot of the owning main session's effective conversation at the private decision's qualified source boundary. The candidate SHALL be labelled as a claim to assess, not as delivery evidence or user permission. Public user instructions, ordinary assistant reports, eligible public custom messages, and applicable native summaries SHALL retain chronology and source provenance. Assistant reports SHALL remain reported facts rather than independently verified execution; summaries SHALL remain derived material. The projection SHALL respect the host-selected active ancestry and compaction boundary, without restoring excluded old raw material or using sibling records. Private child tasks, format corrections, result-file bodies and paths, result-write tools, and reviewer opinions SHALL NOT become new user requests, ordinary delivery, or authorization, and SHALL NOT replace the parent evidence snapshot.

#### Scenario: An older delivery is absent from the latest reply
- **WHEN** an earlier relevant delivery remains in effective parent context but the latest reply does not repeat it
- **THEN** the permitted report remains available to review rather than being removed by a recent-message cutoff

#### Scenario: A later restriction changes the scope
- **WHEN** a later user instruction revokes or narrows earlier permission
- **THEN** both the prior evidence and later restriction retain their order and original roles
- **AND** the old permission is not promoted over the later restriction

#### Scenario: Compaction and a sibling verdict
- **WHEN** the host has summarized earlier material and a sibling branch contains a later verdict
- **THEN** review uses the current retained summary and eligible branch material, not summarized-away raw text or the sibling verdict

#### Scenario: A private retry wrote a candidate
- **WHEN** a locally corrected file result becomes an eligible initial unlock candidate
- **THEN** review receives the labelled candidate plus permitted parent evidence
- **AND** the private correction and file-write exchange is not reclassified as ordinary work or evidence of completion

### Requirement: Incomplete review preserves the current original unlock
A supported review SHALL release the original candidate to existing commit and publication checks. Missing/incompatible service, exception, timeout, malformed or missing required answer, insufficient evidence, unavailable observation capability, or inadmissible necessary context SHALL be recorded as incomplete review and SHALL likewise release the still-current original candidate. These conditions SHALL NOT cause an additional decision-model response in either session, an automatic review retry loop, or a false review-approval claim. This fallback SHALL NOT resurrect a candidate invalidated by user takeover, manual unlock, abort, branch/session replacement, ownership loss, shutdown, or other existing currentness guards. A valid candidate awaiting review SHALL remain owned by the same pending private operation rather than being returned to and re-entered from the main model.

#### Scenario: Service timeout while the candidate is current
- **WHEN** the service reports a timeout or inactivity error and the original candidate still qualifies
- **THEN** the original unlock proceeds through the normal publication path with review marked incomplete
- **AND** neither a new child nor an extra main/child model response is requested merely because review failed

#### Scenario: User takeover and a late service response
- **WHEN** user takeover invalidates the candidate before a supported answer or timeout callback arrives
- **THEN** neither approval nor incomplete-review fallback publishes the old unlock, re-locks the session, or changes the new work's accounting

### Requirement: A definite challenge allows one semantic reconsideration
A complete accepted challenge SHALL withhold the initial candidate's effect and request at most one separately owned reconsideration inquiry in the same private child session, using the same decision model. The feedback SHALL identify the challenged candidate and review classification, distinguish opinion from evidence, and ask the decision model to recheck the original permitted facts without inventing reviewer-authored explanations or new user permission. The reviewer SHALL NOT choose the replacement watchdog action. The result file SHALL be reset before the reconsideration's first response. A valid reconsidered `continue` or `unlock` SHALL follow the existing outcome path without another third-party review in that logical decision. Repeated callbacks, format corrections, or delivery deferrals SHALL NOT reset the reconsideration bound or cause a new fork. Each reconsideration response attempt SHALL use the same hard one-response boundary and its own existing maximum of three consumed responses. Inquiry-format failure SHALL retain the bounded decision-failed behavior rather than masquerading as third-party unavailability. No reconsideration prompt or intermediate candidate SHALL enter the main model conversation.

#### Scenario: The main model keeps unlock
- **WHEN** a challenged candidate is reconsidered once and the private model writes a valid unlock again
- **THEN** that result reaches existing currentness/publication checks without a second review or an automatic reversal to continue
- **AND** the original child session remains the sole decision session

#### Scenario: The main model changes to continue
- **WHEN** the one reconsideration returns a valid authorized continuation
- **THEN** normal durable continuation publication and retry accounting apply
- **AND** the review and reconsideration themselves spend no continuation attempt

#### Scenario: The reconsideration fails its response protocol
- **WHEN** the reconsideration exhausts its three single-response attempts
- **THEN** the normal decision-failed path applies, without another reconsideration or release of the superseded initial candidate

### Requirement: Review history and diagnostics do not create execution authority
Each review's disposition, service identity, and observed attempt/usage diagnostics SHALL be appended as one context-excluded record to the owning main session, linked to the exact local decision and private child/inquiry identity. No separate review database or durable file sidecar SHALL be introduced. Supported, challenged, incomplete, and stale/cancelled outcomes SHALL remain distinguishable from a published watchdog outcome. One business review SHALL NOT be advertised as exactly one provider request; missing usage SHALL NOT be reported as zero. Optional diagnostic/history failures SHALL NOT relock an unlock, charge continuation budget, launch another provider call, or add an independent append-acknowledgement execution gate. Recovery SHALL restore history only, never child sessions, temporary-file authority, locks, pending calls, or automatic publication. Existing canonical-publication requirements and rollback SHALL remain unchanged. Private raw outputs, file paths, tool payloads, and thinking SHALL not be copied into these main-session review diagnostics.

#### Scenario: Optional history writing fails
- **WHEN** review has a usable disposition but optional association/diagnostic persistence fails
- **THEN** normal current outcome behavior remains available and incomplete history is disclosed safely
- **AND** no replacement store, extra model call, or relock is created

#### Scenario: Session reopen after a challenged candidate
- **WHEN** the native main session is reopened with a review record but no published replacement outcome
- **THEN** the record remains historical and no old reconsideration, temporary file, or outcome is automatically executed

#### Scenario: Transport retries are observed
- **WHEN** one review operation causes several service-owned transport attempts or reports incomplete usage
- **THEN** diagnostics preserve the actual observations and missing values instead of claiming one request or zero cost
