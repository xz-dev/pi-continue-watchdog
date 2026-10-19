-- Read-only recovery assumes host-decoded native records, receipt/status joins, and active effective sources.
-- Scheduler/provider settlement, persistence, and final wire payloads are external observations, not proved here.
import Std

set_option autoImplicit false

namespace WatchdogReviewHistory

-- Legacy association data distinguishes captured responses from one optional canonical outcome.
-- Completeness means association detail is available, not that a live decision has finished.
inductive Outcome where
  | continueWork
  | unlock
  | decisionFailed
  deriving DecidableEq, BEq, Repr

structure ReviewRecord where
  entryId : Nat
  originSessionId : Nat
  metadataVersion : Option Nat
  projectionVersion : Nat
  schemaValid : Bool
  sourceIds : List Nat
  inquiryPresent : Bool
  auditPresent : Bool
  auditMatches : Bool
  observed : Option Outcome
  foldOutcome : Option Outcome
  interrupted : Bool
  quietUnlock : Bool
  unlockStatusPresent : Bool
  deriving Repr

structure HistoricalReview where
  entryId : Nat
  sourceAvailable : Bool
  complete : Bool
  observed : Option Outcome
  published : Option Outcome
  deriving Repr

-- Supported metadata must retain its source identities; optional history gaps never erase confirmed publication.
-- Quiet unlock additionally needs its correlated native status; interruption cannot publish.
def sourcesRetained (eligibleSourceIds : List Nat) (record : ReviewRecord) : Bool :=
  record.sourceIds.all eligibleSourceIds.contains

def sourceAvailable (eligibleSourceIds : List Nat) (record : ReviewRecord) : Bool :=
  record.metadataVersion == some 1 && record.projectionVersion == 1 &&
    record.schemaValid && sourcesRetained eligibleSourceIds record

def publicationComplete (record : ReviewRecord) : Bool :=
  match record.foldOutcome with
  | some .unlock => !record.quietUnlock || record.unlockStatusPresent
  | _ => !record.unlockStatusPresent

def publishedOutcome (record : ReviewRecord) : Option Outcome :=
  if record.interrupted then none else match record.foldOutcome with
  | some .unlock =>
    if record.quietUnlock && !record.unlockStatusPresent then none else some .unlock
  | outcome => outcome

def auditSatisfied (record : ReviewRecord) : Bool :=
  record.interrupted || (record.auditPresent && record.auditMatches)

def recoverOne (eligibleSourceIds : List Nat) (record : ReviewRecord) : HistoricalReview :=
  let available := sourceAvailable eligibleSourceIds record
  { entryId := record.entryId
    sourceAvailable := available
    complete := available && record.inquiryPresent && auditSatisfied record &&
      publicationComplete record
    observed := record.observed
    published := publishedOutcome record }

-- Legacy recovery filters the host-selected ancestry and returns operational authority unchanged.
-- No reconstructed record authorizes execution or contributes new model context.
def recoverSession {OperationalState : Type} (_currentSessionId : Nat)
    (live : OperationalState) (activeAncestry : List Nat)
    (eligibleSourcesAt : Nat → List Nat) (records : List ReviewRecord) :
    OperationalState × List HistoricalReview :=
  (live, (records.filter fun record => activeAncestry.contains record.entryId).map
    fun record => recoverOne (eligibleSourcesAt record.entryId) record)

-- Legacy laws retain incomplete/interrupted distinctions and separate responses from publication artifacts.
theorem recovery_preserves_live_state {OperationalState : Type}
    (currentSessionId : Nat) (live : OperationalState) (activeAncestry : List Nat)
    (eligibleSourcesAt : Nat → List Nat) (records : List ReviewRecord) :
    (recoverSession currentSessionId live activeAncestry eligibleSourcesAt records).1 = live := rfl

theorem response_is_not_publication (eligible : List Nat) (record : ReviewRecord)
    (observed : Option Outcome) :
    (recoverOne eligible { record with observed := observed }).published =
      (recoverOne eligible record).published := rfl

theorem missing_inquiry_is_incomplete (eligible : List Nat) (record : ReviewRecord)
    (missing : record.inquiryPresent = false) :
    (recoverOne eligible record).complete = false := by
  simp [recoverOne, missing]

theorem missing_quiet_status_is_not_publication (eligible : List Nat) (record : ReviewRecord)
    (folded : record.foldOutcome = some .unlock) (quiet : record.quietUnlock = true)
    (missing : record.unlockStatusPresent = false) :
    (recoverOne eligible record).published = none ∧
      (recoverOne eligible record).complete = false := by
  simp [recoverOne, publishedOutcome, publicationComplete, folded, quiet, missing]

theorem missing_audit_is_incomplete (eligible : List Nat) (record : ReviewRecord)
    (answered : record.interrupted = false) (missing : record.auditPresent = false) :
    (recoverOne eligible record).complete = false := by
  simp [recoverOne, auditSatisfied, answered, missing]

theorem interrupted_owes_no_audit (eligible : List Nat) (record : ReviewRecord)
    (stopped : record.interrupted = true) :
    (recoverOne eligible record).complete =
      (recoverOne eligible { record with auditPresent := true, auditMatches := true }).complete := by
  simp [recoverOne, auditSatisfied, publicationComplete, sourceAvailable, sourcesRetained, stopped]

theorem missing_sources_are_unavailable (eligible : List Nat) (record : ReviewRecord)
    (missing : sourcesRetained eligible record = false) :
    (recoverOne eligible record).sourceAvailable = false := by
  simp [recoverOne, sourceAvailable, missing]

theorem completeness_requires_association (eligible : List Nat) (record : ReviewRecord)
    (complete : (recoverOne eligible record).complete = true) :
    sourceAvailable eligible record = true ∧ record.inquiryPresent = true ∧
      auditSatisfied record = true ∧ publicationComplete record = true := by
  simpa [recoverOne, Bool.and_eq_true, and_assoc] using complete

-- Native ancestry, rather than origin session labels or file chronology, controls fork/resume selection.
theorem recovery_excludes_siblings {OperationalState : Type}
    (currentSessionId : Nat) (live : OperationalState) (activeAncestry : List Nat)
    (eligibleSourcesAt : Nat → List Nat) (records : List ReviewRecord)
    (review : HistoricalReview)
    (retained : review ∈ (recoverSession currentSessionId live activeAncestry eligibleSourcesAt records).2) :
    review.entryId ∈ activeAncestry := by
  obtain ⟨record, member, rfl⟩ := List.mem_map.mp retained
  exact List.contains_iff_mem.mp (List.mem_filter.mp member).2

theorem new_session_id_changes_no_history {OperationalState : Type}
    (oldId newId : Nat) (live : OperationalState) (activeAncestry : List Nat)
    (eligibleSourcesAt : Nat → List Nat) (records : List ReviewRecord) :
    recoverSession oldId live activeAncestry eligibleSourcesAt records =
    recoverSession newId live activeAncestry eligibleSourcesAt records := rfl

-- Private records carry exact decision/cycle/child/inquiry identity and safe per-response opinions.
-- Captured view and parent source IDs persist without prompts, paths, raw invalid bodies, or child transcripts.
inductive Inquiry where
  | initial
  | reconsideration
  deriving DecidableEq, BEq, Repr

structure Association where
  decisionId : Nat
  cycleId : Nat
  childId : Nat
  inquiry : Inquiry
  deriving DecidableEq, BEq, Repr

inductive Opinion where
  | continueWork
  | unlock
  | invalid
  deriving DecidableEq, BEq, Repr

structure PrivateStart where
  association : Association
  parent : ReviewRecord
  sourceView : Option String
  deriving Repr

structure PrivateResponse where
  entryId : Nat
  version : Nat
  association : Association
  attempt : Nat
  opinion : Opinion
  deriving Repr

structure PrivateHistory where
  association : Association
  sourceView : Option String
  attempts : List Nat
  opinions : List Opinion
  review : HistoricalReview
  deriving Repr

-- Native storage distinguishes context-excluded associations from ordinary and accepted canonical context.
-- These are decoded records, not a proof of raw JSONL parsing or publication receipt acquisition.
inductive NativeRecord where
  | legacy (record : ReviewRecord)
  | privateStart (record : PrivateStart)
  | privateResponse (record : PrivateResponse)
  | ordinary (entryId payload : Nat)
  | canonical (entryId payload : Nat)
  deriving Repr

def NativeRecord.entryId : NativeRecord → Nat
  | .legacy r => r.entryId
  | .privateStart r => r.parent.entryId
  | .privateResponse r => r.entryId
  | .ordinary id _ | .canonical id _ => id

-- Host supplies active ancestry and compaction-aware eligibility at each association boundary.
-- HostScope states the explicit prior-active-source assumption needed for source provenance conclusions.
structure HostObservations where
  activeAncestry : List Nat
  eligibleSourcesAt : Nat → List Nat

structure HostScope (host : HostObservations) : Prop where
  effectiveSourcesPrecedeAssociation : ∀ (anchor source : Nat),
    source ∈ host.eligibleSourcesAt anchor →
    source ∈ host.activeAncestry ∧
      host.activeAncestry.idxOf source < host.activeAncestry.idxOf anchor

-- Selection admits only active native records and exactly matching, versioned response ordinals 1 through 3.
-- Ordinal validation describes historical association, not provider scheduling or live retry accounting.
def activeRecords (host : HostObservations) (records : List NativeRecord) : List NativeRecord :=
  records.filter fun record => host.activeAncestry.contains record.entryId

def responseMatches (start : PrivateStart) (response : PrivateResponse) : Bool :=
  response.version == 1 && decide (response.association = start.association) &&
    1 ≤ response.attempt && response.attempt ≤ 3

def matchedResponses (start : PrivateStart) (records : List NativeRecord) : List PrivateResponse :=
  records.filterMap fun record => match record with
    | .privateResponse response => if responseMatches start response then some response else none
    | _ => none

def lastOutcome (responses : List PrivateResponse) : Option Outcome :=
  match responses.getLast? with
  | some response => match response.opinion with
    | .continueWork => some .continueWork
    | .unlock => some .unlock
    | .invalid => none
  | none => none

def privateViewAvailable (view : Option String) : Bool :=
  match view with
  | none => false
  | some text => text.length ≤ 8000

-- A retained private start/view replaces the legacy parent-query dependency; only matching responses become opinions.
-- The independently decoded final publication remains optional even when all response opinions are available.
def recoverPrivateOne (eligible : List Nat) (start : PrivateStart)
    (records : List NativeRecord) : PrivateHistory :=
  let responses := matchedResponses start records
  let associated := { start.parent with
    inquiryPresent := privateViewAvailable start.sourceView
    auditPresent := !responses.isEmpty
    auditMatches := true
    observed := lastOutcome responses }
  { association := start.association
    sourceView := start.sourceView
    attempts := responses.map PrivateResponse.attempt
    opinions := responses.map PrivateResponse.opinion
    review := recoverOne eligible associated }

-- Unified recovery reads both transports without recovering a child, lock, retry allowance, or file authority.
-- OperationalState is opaque, including ownership, cancellation, receipts/rollback, callbacks, and shared budgets.
inductive Recovered where
  | legacy (review : HistoricalReview)
  | privateReview (review : PrivateHistory)
  deriving Repr

def recoverNative {OperationalState : Type} (live : OperationalState)
    (host : HostObservations) (records : List NativeRecord) : OperationalState × List Recovered :=
  let active := activeRecords host records
  (live, active.filterMap fun record => match record with
    | .legacy record => some (.legacy (recoverOne (host.eligibleSourcesAt record.entryId) record))
    | .privateStart start => some (.privateReview
        (recoverPrivateOne (host.eligibleSourcesAt start.parent.entryId) start active))
    | _ => none)

-- Context projection excludes all association records; only ordinary or canonical payloads survive.
-- The structural scan measure counts finite native input, not asynchronous provider progress.
def parentContext (records : List NativeRecord) : List Nat :=
  records.filterMap fun record => match record with
    | .ordinary _ payload | .canonical _ payload => some payload
    | _ => none

def recoverySteps : List NativeRecord → Nat
  | [] => 0
  | _ :: records => 1 + recoverySteps records

-- Exact association prevents borrowing another child's or inquiry's response, including during reconsideration.
theorem response_association_is_exact (start : PrivateStart) (response : PrivateResponse)
    (accepted : responseMatches start response = true) :
    response.version = 1 ∧ response.association = start.association ∧
      1 ≤ response.attempt ∧ response.attempt ≤ 3 := by
  simpa [responseMatches, Bool.and_eq_true, and_assoc] using accepted

theorem wrong_child_or_inquiry_is_rejected (start : PrivateStart) (response : PrivateResponse)
    (wrong : response.association.childId ≠ start.association.childId ∨
      response.association.inquiry ≠ start.association.inquiry) :
    responseMatches start response = false := by
  cases h : responseMatches start response with
  | false => rfl
  | true =>
    have exactKey := (response_association_is_exact start response h).2.1
    cases wrong with
    | inl different => exact False.elim (different (congrArg Association.childId exactKey))
    | inr different => exact False.elim (different (congrArg Association.inquiry exactKey))

theorem matched_response_is_exact (start : PrivateStart) (records : List NativeRecord)
    (response : PrivateResponse) (member : response ∈ matchedResponses start records) :
    response.version = 1 ∧ response.association = start.association ∧
      1 ≤ response.attempt ∧ response.attempt ≤ 3 := by
  obtain ⟨record, _, found⟩ := List.mem_filterMap.mp member
  cases record <;> simp at found
  obtain ⟨accepted, rfl⟩ := found
  exact response_association_is_exact start _ accepted

-- Private recovery cannot promote an opinion to publication or require an old main-session query.
-- Missing source/view/response details remain partial; interrupted associations owe no response audit.
theorem captured_opinions_do_not_publish (eligible : List Nat) (start : PrivateStart)
    (first second : List NativeRecord) :
    (recoverPrivateOne eligible start first).review.published =
      (recoverPrivateOne eligible start second).review.published := rfl

theorem private_missing_view_is_incomplete (eligible : List Nat) (start : PrivateStart)
    (records : List NativeRecord) (missing : start.sourceView = none) :
    (recoverPrivateOne eligible start records).review.complete = false := by
  simp [recoverPrivateOne, recoverOne, privateViewAvailable, missing]

theorem private_parent_query_not_required (eligible : List Nat) (start : PrivateStart)
    (records : List NativeRecord) (present : Bool) :
    recoverPrivateOne eligible { start with parent := { start.parent with inquiryPresent := present } }
      records = recoverPrivateOne eligible start records := rfl

theorem private_sources_are_active_and_prior (host : HostObservations) (scope : HostScope host)
    (start : PrivateStart) (records : List NativeRecord)
    (complete : (recoverPrivateOne (host.eligibleSourcesAt start.parent.entryId) start records).review.complete = true)
    (source : Nat) (member : source ∈ start.parent.sourceIds) :
    source ∈ host.activeAncestry ∧
      host.activeAncestry.idxOf source < host.activeAncestry.idxOf start.parent.entryId := by
  have available := (completeness_requires_association
    (host.eligibleSourcesAt start.parent.entryId) _ complete).1
  simp only [sourceAvailable, Bool.and_eq_true] at available
  have present := List.all_eq_true.mp available.2 source member
  exact scope.effectiveSourcesPrecedeAssociation start.parent.entryId source
    (List.contains_iff_mem.mp present)

theorem private_missing_response_is_incomplete (eligible : List Nat) (start : PrivateStart)
    (records : List NativeRecord) (missing : matchedResponses start records = [])
    (uninterrupted : start.parent.interrupted = false) :
    (recoverPrivateOne eligible start records).review.complete = false := by
  simp [recoverPrivateOne, recoverOne, auditSatisfied, missing, uninterrupted]

theorem private_interruption_owes_no_response (eligible : List Nat) (start : PrivateStart)
    (first second : List NativeRecord) (stopped : start.parent.interrupted = true) :
    (recoverPrivateOne eligible start first).review.complete =
      (recoverPrivateOne eligible start second).review.complete := by
  simp [recoverPrivateOne, recoverOne, auditSatisfied, publicationComplete,
    sourceAvailable, sourcesRetained, stopped]

theorem interruption_never_publishes (eligible : List Nat) (record : ReviewRecord)
    (stopped : record.interrupted = true) :
    (recoverOne eligible record).published = none := by
  simp [recoverOne, publishedOutcome, stopped]

-- Recovery leaves every live capability unchanged, excludes siblings, hides private records, and retains legacy reads.
theorem recovery_does_not_rearm {OperationalState : Type} (live : OperationalState)
    (host : HostObservations) (records : List NativeRecord) :
    (recoverNative live host records).1 = live := rfl

theorem selected_native_record_is_active (host : HostObservations) (records : List NativeRecord)
    (record : NativeRecord) (selected : record ∈ activeRecords host records) :
    record.entryId ∈ host.activeAncestry := by
  exact List.contains_iff_mem.mp (List.mem_filter.mp selected).2

theorem private_records_are_context_excluded (start : PrivateStart) (response : PrivateResponse)
    (records : List NativeRecord) :
    parentContext (.privateStart start :: .privateResponse response :: records) =
      parentContext records := rfl

theorem legacy_recovery_is_retained (eligible : List Nat) (record : ReviewRecord) :
    (recoverNative () ⟨[record.entryId], fun _ => eligible⟩ [.legacy record]).2 =
      [.legacy (recoverOne eligible record)] := by
  simp [recoverNative, activeRecords, NativeRecord.entryId]

theorem recovery_terminates (records : List NativeRecord) :
    recoverySteps records = records.length := by
  induction records with
  | nil => rfl
  | cons record records ih => simp [recoverySteps, ih, Nat.add_comm]

-- Combined claim preserves legacy safety and adds private history-only, correlation, source, and context guarantees.
-- It does not prove live fork execution, publication interleavings, LLM judgment, hardware, or actual wire correctness.
def legacy_correctness_statement : Prop :=
  (∀ (live : Nat) (path : List Nat) (sources : Nat → List Nat) (records : List ReviewRecord),
    (recoverSession 0 live path sources records).1 = live) ∧
  (∀ (sources : List Nat) (record : ReviewRecord) (observed : Option Outcome),
    (recoverOne sources { record with observed := observed }).published =
      (recoverOne sources record).published) ∧
  (∀ (sources : List Nat) (record : ReviewRecord), record.interrupted = false →
    record.auditPresent = false → (recoverOne sources record).complete = false) ∧
  (∀ (sources : List Nat) (record : ReviewRecord), record.interrupted = true →
    (recoverOne sources record).complete =
      (recoverOne sources { record with auditPresent := true, auditMatches := true }).complete) ∧
  (∀ (sources : List Nat) (record : ReviewRecord), sourcesRetained sources record = false →
    (recoverOne sources record).sourceAvailable = false) ∧
  (∀ (sources : List Nat) (record : ReviewRecord), record.inquiryPresent = false →
    (recoverOne sources record).complete = false) ∧
  (∀ (sources : List Nat) (record : ReviewRecord), record.foldOutcome = some .unlock →
    record.quietUnlock = true → record.unlockStatusPresent = false →
    (recoverOne sources record).published = none ∧ (recoverOne sources record).complete = false)

theorem legacy_recovery_is_correct : legacy_correctness_statement :=
  ⟨fun _ _ _ _ => rfl, response_is_not_publication,
    missing_audit_is_incomplete, interrupted_owes_no_audit, missing_sources_are_unavailable,
    missing_inquiry_is_incomplete, missing_quiet_status_is_not_publication⟩

def private_correctness_statement : Prop :=
  (∀ (OperationalState : Type) (live : OperationalState) (host : HostObservations)
      (records : List NativeRecord),
    (recoverNative live host records).1 = live) ∧
  (∀ (start : PrivateStart) (records : List NativeRecord) (response : PrivateResponse),
    response ∈ matchedResponses start records →
    response.version = 1 ∧ response.association = start.association ∧
      1 ≤ response.attempt ∧ response.attempt ≤ 3) ∧
  (∀ (sources : List Nat) (start : PrivateStart) (first second : List NativeRecord),
    (recoverPrivateOne sources start first).review.published =
      (recoverPrivateOne sources start second).review.published) ∧
  (∀ (sources : List Nat) (start : PrivateStart) (records : List NativeRecord),
    start.sourceView = none → (recoverPrivateOne sources start records).review.complete = false) ∧
  (∀ (start : PrivateStart) (response : PrivateResponse) (records : List NativeRecord),
    parentContext (.privateStart start :: .privateResponse response :: records) = parentContext records) ∧
  (∀ (host : HostObservations) (records : List NativeRecord) (record : NativeRecord),
    record ∈ activeRecords host records → record.entryId ∈ host.activeAncestry) ∧
  (∀ (sources : List Nat) (record : ReviewRecord), record.interrupted = true →
    (recoverOne sources record).published = none) ∧
  (∀ (records : List NativeRecord), recoverySteps records = records.length) ∧
  (∀ (host : HostObservations) (_scope : HostScope host) (start : PrivateStart)
      (records : List NativeRecord),
    (recoverPrivateOne (host.eligibleSourcesAt start.parent.entryId) start records).review.complete = true →
    ∀ (source : Nat), source ∈ start.parent.sourceIds →
      source ∈ host.activeAncestry ∧
        host.activeAncestry.idxOf source < host.activeAncestry.idxOf start.parent.entryId) ∧
  (∀ (sources : List Nat) (start : PrivateStart) (records : List NativeRecord) (present : Bool),
    recoverPrivateOne sources { start with parent := { start.parent with inquiryPresent := present } }
      records = recoverPrivateOne sources start records) ∧
  (∀ (sources : List Nat) (start : PrivateStart) (records : List NativeRecord),
    matchedResponses start records = [] → start.parent.interrupted = false →
      (recoverPrivateOne sources start records).review.complete = false) ∧
  (∀ (sources : List Nat) (start : PrivateStart) (first second : List NativeRecord),
    start.parent.interrupted = true →
    (recoverPrivateOne sources start first).review.complete =
      (recoverPrivateOne sources start second).review.complete) ∧
  (∀ (sources : List Nat) (record : ReviewRecord),
    (recoverNative () ⟨[record.entryId], fun _ => sources⟩ [.legacy record]).2 =
      [.legacy (recoverOne sources record)])

theorem process_is_correct : legacy_correctness_statement ∧ private_correctness_statement :=
  ⟨legacy_recovery_is_correct, (fun _ => recovery_does_not_rearm), matched_response_is_exact,
    captured_opinions_do_not_publish, private_missing_view_is_incomplete,
    private_records_are_context_excluded, selected_native_record_is_active,
    interruption_never_publishes, recovery_terminates, private_sources_are_active_and_prior,
    private_parent_query_not_required, private_missing_response_is_incomplete,
    private_interruption_owes_no_response, legacy_recovery_is_retained⟩

-- Accepted Lean foundations are propext, Classical.choice, and Quot.sound; no domain axioms are introduced.
#print axioms process_is_correct
#print axioms recovery_excludes_siblings

-- Kernel-checked examples cover partial legacy records, private retries, identity mismatches, and history-only resume.
def exampleChecks : Bool × Bool := Id.run do
  let record : ReviewRecord := {
    entryId := 10, originSessionId := 1, metadataVersion := some 1,
    projectionVersion := 1, schemaValid := true, sourceIds := [2, 3],
    inquiryPresent := true, auditPresent := true, auditMatches := true,
    observed := some .continueWork, foldOutcome := none, interrupted := false,
    quietUnlock := false, unlockStatusPresent := false }
  let observedOnly := recoverOne [2, 3] record
  let quiet : ReviewRecord := { record with
    foldOutcome := some .unlock, quietUnlock := true, unlockStatusPresent := true }
  let published := recoverOne [2, 3] quiet
  let noAudit := recoverOne [2, 3] { quiet with auditPresent := false }
  let noInquiry := recoverOne [2, 3] { quiet with inquiryPresent := false }
  let noStatus := recoverOne [2, 3] { quiet with unlockStatusPresent := false }
  let noFold := recoverOne [2, 3] { quiet with foldOutcome := none }
  let interruptedNoAudit := recoverOne [2, 3]
    { record with observed := none, interrupted := true, auditPresent := false }
  let missing := recoverOne [2] record
  let restored := recoverSession 99 7 [10] (fun _ => [2, 3]) [record, { record with entryId := 11 }]
  let valid := observedOnly.published.isNone && published.complete &&
    published.published == some .unlock && noAudit.published == some .unlock &&
    !noAudit.complete && !noInquiry.complete && noInquiry.published == some .unlock &&
    noStatus.published.isNone && !noStatus.complete && noFold.published.isNone &&
    !noFold.complete && interruptedNoAudit.complete &&
    interruptedNoAudit.published.isNone && !missing.sourceAvailable && restored.1 == 7 && restored.2.length == 1
  let key : Association := { decisionId := 42, cycleId := 1, childId := 7, inquiry := .initial }
  let start : PrivateStart := {
    association := key, parent := { record with inquiryPresent := false },
    sourceView := some "captured parent view" }
  let response : PrivateResponse := {
    entryId := 12, version := 1, association := key, attempt := 2, opinion := .unlock }
  let invalid := { response with entryId := 11, attempt := 1, opinion := .invalid }
  let wrongChild := { response with
    entryId := 13, association := { key with childId := 8 } }
  let wrongInquiry := { response with
    entryId := 14, association := { key with inquiry := .reconsideration } }
  let traffic := [NativeRecord.privateStart start, .privateResponse invalid, .privateResponse response,
    .privateResponse wrongChild, .privateResponse wrongInquiry]
  let privateHistory := recoverPrivateOne [2, 3] start traffic
  let noPrivateResponse := recoverPrivateOne [2, 3] start []
  let privatePublished := recoverPrivateOne [2, 3] { start with parent := quiet } []
  let legacyUnknown := recoverOne [2, 3] { quiet with metadataVersion := some 2 }
  let native := recoverNative 9 ⟨[2, 3, 10, 11, 12], fun _ => [2, 3]⟩ traffic
  let privateValid := privateHistory.review.complete && privateHistory.review.published.isNone &&
    privateHistory.attempts == [1, 2] && privateHistory.opinions == [.invalid, .unlock] &&
    !noPrivateResponse.review.complete && privatePublished.review.published == some .unlock &&
    !privatePublished.review.complete && !legacyUnknown.sourceAvailable &&
    legacyUnknown.published == some .unlock && (parentContext traffic).isEmpty &&
    native.1 == 9 && native.2.length == 1
  return (valid, privateValid)

theorem example_checks_pass : exampleChecks = (true, true) := by decide

end WatchdogReviewHistory

-- Executable summary performs deterministic computation and stdout only; no storage, process, or provider effects.
def main : IO Unit := do
  let (legacy, privateHistory) := WatchdogReviewHistory.exampleChecks
  IO.println s!"History checks: legacy={legacy}; private={privateHistory}; exact association; opinions do not publish; no parent query/file recovery; live state unchanged."
