# watchdog-unlock-review Specification Delta

Delta for `openspec/specs/watchdog-unlock-review/spec.md`.

## MODIFIED Requirements

### Requirement: The shared service owns inference and exact-input reuse
The watchdog SHALL use the already-loaded shared judgment service's version-two `judge()` entry rather than a direct provider client, alternative model fallback, or a competing cache/recovery engine. Discovery SHALL occur only at an eligible review boundary and SHALL be retried on a later eligible decision if the dependency was previously absent. Review SHALL be bounded by the shared service's own backend-specific timeout policy and SHALL be cancellable through lifecycle-linked abort; the watchdog SHALL NOT add a competing outer timer. Required final accepted answers SHALL distinguish support, a definite challenge, and insufficient evidence; missing, dropped, malformed or wrongly typed answers, errors, and unsupported/incompatible service versions SHALL NOT authorize a challenge. Review output SHALL NOT create user authorization or bypass local outcome validation.

#### Scenario: Dependency becomes available later
- **WHEN** review is enabled but the service is absent for one decision and present for a later eligible decision
- **THEN** the first decision uses the unavailable-review path without automatic installation or provider fallback
- **AND** the later decision discovers the service normally

#### Scenario: Version mismatch is explicit
- **WHEN** a discovered service advertises `version` other than 2 or lacks a callable `judge()` entry
- **THEN** the review is incomplete with the incompatible disposition
- **AND** no v1 `review()` invocation, downgrade, or compatibility facade is attempted

#### Scenario: Repeated settlement observes one pending review
- **WHEN** the same candidate is observed repeatedly before review settles
- **THEN** those observations do not create duplicate business review requests

#### Scenario: Reuse versus changed facts
- **WHEN** identical public input is judged again, or a user decision or candidate reason changes
- **THEN** the stateless service performs independent inference per call and the old judgment is not presented as evaluation of changed meaning

### Requirement: Incomplete review preserves the current original unlock
A supported review SHALL release the original candidate to existing commit and publication checks. Missing/incompatible service, exception, timeout, malformed/dropped/missing required answer, insufficient evidence, or inadmissible necessary context SHALL be recorded as incomplete review and SHALL likewise release the still-current original candidate. These conditions SHALL NOT cause an additional decision-model response in either session, an automatic review retry loop, or a false review-approval claim. This fallback SHALL NOT resurrect a candidate invalidated by user takeover, manual unlock, abort, branch/session replacement, ownership loss, shutdown, or other existing currentness guards. A valid candidate awaiting review SHALL remain owned by the same pending private operation rather than being returned to and re-entered from the main model.

#### Scenario: Service timeout while the candidate is current
- **WHEN** the service reports a timeout or inactivity error and the original candidate still qualifies
- **THEN** the original unlock proceeds through the normal publication path with review marked incomplete
- **AND** neither a new child nor an extra main/child model response is requested merely because review failed

#### Scenario: User takeover and a late service response
- **WHEN** user takeover invalidates the candidate before a supported answer or timeout callback arrives
- **THEN** neither approval nor incomplete-review fallback publishes the old unlock, re-locks the session, or changes the new work's accounting

#### Scenario: Dropped or malformed required answer
- **WHEN** a `stop` result omits the required question or returns a wrongly typed or illegal answer
- **THEN** the review is incomplete (malformed), never a challenge or approval
- **AND** a dropped required id is recorded as insufficient evidence; either way the still-current original candidate follows the incomplete-review policy

### Requirement: Review history and diagnostics do not create execution authority
Each review's disposition and actual service identity SHALL be appended as one context-excluded record to the owning main session, linked to the exact local decision and private child/inquiry identity. Optional backend-reported usage SHALL keep its stated scope and absence SHALL NOT be reported as zero; a logical judgment SHALL NOT be labelled as a provider transport attempt or a billable request. No separate review database or durable file sidecar SHALL be introduced. Supported, challenged, incomplete, and stale/cancelled outcomes SHALL remain distinguishable from a published watchdog outcome. Optional diagnostic/history failures SHALL NOT relock an unlock, charge continuation budget, launch another provider call, or add an independent append-acknowledgement execution gate. Recovery SHALL restore history only, never child sessions, temporary-file authority, locks, pending calls, or automatic publication. Existing canonical-publication requirements and rollback SHALL remain unchanged. Private raw outputs, file paths, tool payloads, and thinking SHALL not be copied into these main-session review diagnostics.

#### Scenario: Optional history writing fails
- **WHEN** review has a usable disposition but optional association/diagnostic persistence fails
- **THEN** normal current outcome behavior remains available and incomplete history is disclosed safely
- **AND** no replacement store, extra model call, or relock is created

#### Scenario: Session reopen after a challenged candidate
- **WHEN** the native main session is reopened with a review record but no published replacement outcome
- **THEN** the record remains historical and no old reconsideration, temporary file, or outcome is automatically executed

#### Scenario: Transport retries are observed
- **WHEN** the service reports optional backend usage from its terminal attempt only
- **THEN** diagnostics keep that stated scope without claiming one request, complete operation billing, or zero cost when values are absent

#### Scenario: Existing session history
- **WHEN** a session contains old review records with transport-attempt or observation fields
- **THEN** the upgrade leaves them intact and does not restore pending calls, checkpoints, locks or execution authority from them

## ADDED Requirements

### Requirement: Final judgment replaces transport accounting as the acceptance condition
The watchdog SHALL accept a review outcome only from a live `stop` result whose required answer is present, correctly typed (`choice`) and one of the legal `supported`/`challenged`/`insufficient_evidence` labels, with the required id absent from `dropped` and `contextOverflow` not set. It SHALL NOT require `reviewVersion`, `unresolved`, checkpoint progress, `observationCoverage`, attempt counts or any transport-observation completeness. Removed observation completeness SHALL NOT be replaced by a fabricated successful-observation marker; a missing or absent usage report SHALL remain absent and SHALL NOT be reported as zero. Only a valid definite challenge SHALL allow the existing single semantic reconsideration; it SHALL not itself choose a replacement action or create user authority.

#### Scenario: Valid challenge without attempt observations
- **WHEN** a current version-two judgment returns the legal required `challenged` choice and no transport diagnostics
- **THEN** watchdog permits at most its existing one reconsideration after local validation, without manufacturing observation evidence

#### Scenario: Unsupported evidence or malformed result
- **WHEN** necessary permitted facts are unavailable or the returned required answer is missing/malformed
- **THEN** review is incomplete, not a challenge or approval, and the still-current original candidate follows existing policy

#### Scenario: Cancellation wins
- **WHEN** the user takes over or manually unlocks while judgment is pending
- **THEN** owned work is cancelled and neither its late answer nor an incomplete-result fallback resurrects the old candidate
