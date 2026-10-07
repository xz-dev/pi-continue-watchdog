-- Executable documentation for historical recovery, not a TypeScript refinement proof.
-- Host-selected ancestry, eligible pre-review source IDs and decoded records are inputs.
import Std

set_option autoImplicit false

namespace WatchdogReviewHistory

-- Observed responses and published canonical outcomes are separate data flows.
-- Version/schema checks are abstract inputs; no natural-language judgment is modelled.
inductive Outcome where
  | continueWork
  | unlock
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

-- Only retained source identities support an available association. Missing audit
-- detail makes history incomplete without removing an independently published outcome.
def sourcesRetained (eligibleSourceIds : List Nat) (record : ReviewRecord) : Bool :=
  record.sourceIds.all eligibleSourceIds.contains

def sourceAvailable (eligibleSourceIds : List Nat) (record : ReviewRecord) : Bool :=
  record.metadataVersion == some 1 && record.projectionVersion == 1 &&
    record.schemaValid && sourcesRetained eligibleSourceIds record

-- Publication needs the decoded fold and, for quiet unlock, its correlated status.
-- Legacy replacement unlocks remain readable without a quiet status record.
def publicationComplete (record : ReviewRecord) : Bool :=
  match record.foldOutcome with
  | some .unlock => !record.quietUnlock || record.unlockStatusPresent
  | _ => !record.unlockStatusPresent

def publishedOutcome (record : ReviewRecord) : Option Outcome :=
  match record.foldOutcome with
  | some .unlock =>
    if record.quietUnlock && !record.unlockStatusPresent then none else some .unlock
  | outcome => outcome

-- Missing inquiry/audit data or an incomplete publication marks association partial;
-- an independently established published outcome remains readable.
def recoverOne (eligibleSourceIds : List Nat) (record : ReviewRecord) : HistoricalReview :=
  let available := sourceAvailable eligibleSourceIds record
  { entryId := record.entryId
    sourceAvailable := available
    complete := available && record.inquiryPresent && record.auditPresent &&
      record.auditMatches && publicationComplete record
    observed := record.observed
    published := publishedOutcome record }

-- Recovery is a terminating filter/map over active ancestry; all live authority is opaque
-- and returned unchanged. New model context is not assembled from these historical records.
def recoverSession {OperationalState : Type} (_currentSessionId : Nat)
    (live : OperationalState) (activeAncestry : List Nat)
    (eligibleSourcesAt : Nat → List Nat) (records : List ReviewRecord) :
    OperationalState × List HistoricalReview :=
  (live, (records.filter fun record => activeAncestry.contains record.entryId).map
    fun record => recoverOne (eligibleSourcesAt record.entryId) record)

-- These laws forbid history from restoring operational state or promoting a response
-- into publication. Missing inputs or publication artifacts cannot establish complete association.
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
    (missing : record.auditPresent = false) :
    (recoverOne eligible record).complete = false := by
  simp [recoverOne, missing]

theorem missing_sources_are_unavailable (eligible : List Nat) (record : ReviewRecord)
    (missing : sourcesRetained eligible record = false) :
    (recoverOne eligible record).sourceAvailable = false := by
  simp [recoverOne, sourceAvailable, missing]

theorem completeness_requires_association (eligible : List Nat) (record : ReviewRecord)
    (complete : (recoverOne eligible record).complete = true) :
    sourceAvailable eligible record = true ∧ record.inquiryPresent = true ∧
      record.auditPresent = true ∧ record.auditMatches = true ∧
      publicationComplete record = true := by
  simpa [recoverOne, Bool.and_eq_true, and_assoc] using complete

-- Selection follows the supplied native path, not file chronology or origin session ID.
-- Fork invariance assumes retained source IDs; label/parent rewrites are outside this model.
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

-- The combined claim covers the read-only recovery process under these inputs only.
-- It proves neither host persistence, selector bounds, nor semantic completion accuracy.
def process_is_correct_statement : Prop :=
  (∀ (live : Nat) (path : List Nat) (sources : Nat → List Nat) (records : List ReviewRecord),
    (recoverSession 0 live path sources records).1 = live) ∧
  (∀ (sources : List Nat) (record : ReviewRecord) (observed : Option Outcome),
    (recoverOne sources { record with observed := observed }).published =
      (recoverOne sources record).published) ∧
  (∀ (sources : List Nat) (record : ReviewRecord), record.auditPresent = false →
    (recoverOne sources record).complete = false) ∧
  (∀ (sources : List Nat) (record : ReviewRecord), sourcesRetained sources record = false →
    (recoverOne sources record).sourceAvailable = false) ∧
  (∀ (sources : List Nat) (record : ReviewRecord), record.inquiryPresent = false →
    (recoverOne sources record).complete = false) ∧
  (∀ (sources : List Nat) (record : ReviewRecord), record.foldOutcome = some .unlock →
    record.quietUnlock = true → record.unlockStatusPresent = false →
    (recoverOne sources record).published = none ∧ (recoverOne sources record).complete = false)

theorem process_is_correct : process_is_correct_statement :=
  ⟨fun _ _ _ _ => rfl, response_is_not_publication,
    missing_audit_is_incomplete, missing_sources_are_unavailable,
    missing_inquiry_is_incomplete, missing_quiet_status_is_not_publication⟩

-- Kernel foundations are printed explicitly; no additional axioms or placeholders.
#print axioms process_is_correct
#print axioms recovery_excludes_siblings

end WatchdogReviewHistory

-- Deterministic examples cover missing inquiry/audit/status/cleanup and sibling cases.
-- Execution performs no file, network, provider or lifecycle effects.
open WatchdogReviewHistory in
def main : IO Unit := do
  let record : ReviewRecord := {
    entryId := 10, originSessionId := 1, metadataVersion := some 1,
    projectionVersion := 1, schemaValid := true, sourceIds := [2, 3],
    inquiryPresent := true, auditPresent := true, auditMatches := true,
    observed := some .continueWork, foldOutcome := none,
    quietUnlock := false, unlockStatusPresent := false }
  let observedOnly := recoverOne [2, 3] record
  let quiet : ReviewRecord := { record with
    foldOutcome := some .unlock, quietUnlock := true, unlockStatusPresent := true }
  let published := recoverOne [2, 3] quiet
  let noAudit := recoverOne [2, 3] { quiet with auditPresent := false }
  let noInquiry := recoverOne [2, 3] { quiet with inquiryPresent := false }
  let noStatus := recoverOne [2, 3] { quiet with unlockStatusPresent := false }
  let noFold := recoverOne [2, 3] { quiet with foldOutcome := none }
  let missing := recoverOne [2] record
  let restored := recoverSession 99 7 [10] (fun _ => [2, 3]) [record, { record with entryId := 11 }]
  let valid := observedOnly.published.isNone && published.complete &&
    published.published == some .unlock && noAudit.published == some .unlock &&
    !noAudit.complete && !noInquiry.complete && noInquiry.published == some .unlock &&
    noStatus.published.isNone && !noStatus.complete && noFold.published.isNone &&
    !noFold.complete && !missing.sourceAvailable && restored.1 == 7 && restored.2.length == 1
  if !valid then throw (IO.userError "review-history examples failed")
  IO.println "Review history: inquiry required; quiet unlock needs fold and status; sibling excluded; live state unchanged."
