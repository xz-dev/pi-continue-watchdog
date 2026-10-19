-- This cancellation and outcome-boundary slice uses Std only; actions are data and main performs deterministic stdout only.
import Std

set_option autoImplicit false

namespace WatchdogUserTakeover

-- Exact operation, child, resource, source and ownership identities fence every callback and cleanup action.
-- Source classification and identity freshness are host observations; this does not verify the production classifier.
structure Scope where
  operation : Nat
  child : Nat
  directory : Nat
  claim : Nat
  session : Nat
  sourceAnchor : Nat
  model : Nat
  thinking : Nat
  controller : Nat
  cycle : Nat
  externalGeneration : Nat
  deriving DecidableEq, Repr

inductive SourceAppend where
  | ownedExcludedAudit (operation : Nat)
  | foreignOrModelContent
  deriving DecidableEq, Repr

structure SourceView where
  scope : Scope
  descendants : List SourceAppend
  deriving DecidableEq, Repr

def sourceCurrent (captured : Scope) (view : SourceView) : Bool :=
  captured == view.scope && view.descendants.all
    (fun entry => entry == .ownedExcludedAudit captured.operation)

-- Admission assumes the observed idle gate and private runner contract, including full effective context, {} resets and bounded same-child responses.
-- These are runtime/provider/filesystem observations, not conclusions of the cancellation proof.
structure EntryObservations where
  idleMilliseconds : Nat
  locked : Bool
  callbackSuspended : Bool
  exhausted : Bool
  decisionOpen : Bool
  fullEffectiveFork : Bool
  privateFactoryWithoutPublicRegistration : Bool
  guardedWriterOnly : Bool
  oneResponseIncludingSettledWrite : Bool
  sameChildThreeResponsesPerInquiryAndOneReconsideration : Bool
  uniqueOwnerOnlyDirectory : Bool
  hostDeliversOriginalInput : Bool
  resultFileResetToEmptyObject : Bool
  deriving DecidableEq, Repr

def admitted (entry : EntryObservations) : Prop :=
  10000 ≤ entry.idleMilliseconds ∧ entry.locked = true ∧
    entry.callbackSuspended = false ∧ entry.exhausted = false ∧
    entry.decisionOpen = false ∧ entry.fullEffectiveFork = true ∧
    entry.privateFactoryWithoutPublicRegistration = true ∧ entry.guardedWriterOnly = true ∧
    entry.oneResponseIncludingSettledWrite = true ∧
    entry.sameChildThreeResponsesPerInquiryAndOneReconsideration = true ∧
    entry.uniqueOwnerOnlyDirectory = true ∧ entry.hostDeliversOriginalInput = true ∧
    entry.resultFileResetToEmptyObject = true

-- Main work remains host-owned; a private decision grants no ownership over an ordinary main run or the complete incoming payload.
inductive MainRun where
  | idle
  | foreign (identity : Nat)
  | ownedContinuation (scope : Scope)
  deriving DecidableEq, Repr

structure UserPayload where
  text : String
  images : List (String × String)
  deriving DecidableEq, Repr

structure ParentState where
  run : MainRun
  context : List String
  spent : Nat
  callbackSuspended : Bool
  locked : Bool
  deriving DecidableEq, Repr

-- Cancellation has a separate resource lifecycle; callback kinds describe completion notices, not requests for extra model responses.
inductive Phase where
  | active
  | revoked
  | drained
  | disposed
  deriving DecidableEq, Repr

-- Host maps Escape directed to current private work while main is idle to nativeChildAbort;
-- keyboard routing and lifecycle subscription are observed host boundaries, not extra modeled states.
inductive CancelCause where
  | manualUnlock
  | nativeChildAbort
  | userTakeover
  | externalWork
  | lifecycleReplacement
  | shutdown
  deriving DecidableEq, Repr

inductive PrivateCallback where
  | formatCorrection
  | reviewReconsideration
  | fileWrite
  | validResult
  | terminalSettlement
  deriving DecidableEq, Repr

structure ProcessState where
  scope : Scope
  source : SourceView
  phase : Phase
  authority : Bool
  childAbortRequested : Bool
  fileResultAccepted : Bool
  callbacksAccepted : Nat
  parent : ParentState
  deriving DecidableEq, Repr

-- Actions name only the exact child/resources and a direct host input pass; no main abort, model call, input capture or replay exists here.
inductive Action where
  | signalChild (child : Nat)
  | drainOrQuarantineWrites (child : Nat)
  | disposeOwnedResources (child directory : Nat)
  | passOriginalInput (payload : UserPayload)
  deriving DecidableEq, Repr

structure Transition where
  state : ProcessState
  actions : List Action
  deriving DecidableEq, Repr

-- Live authority admits callbacks only while the captured source is current; revocation precedes all emitted cancellation/cleanup actions.
-- Manual unlock and actual native-child abort unlock; takeover, external work and lifecycle invalidation do not impersonate those causes.
def initial (scope : Scope) (parent : ParentState) : ProcessState :=
  { scope, source := ⟨scope, []⟩, phase := .active, authority := true,
    childAbortRequested := false, fileResultAccepted := false,
    callbacksAccepted := 0, parent }

def canAccept (state : ProcessState) : Bool :=
  state.phase == .active && state.authority && sourceCurrent state.scope state.source

def unlockFor (cause : CancelCause) : Bool :=
  cause == .manualUnlock || cause == .nativeChildAbort

def revoke (scope : Scope) (cause : CancelCause) (state : ProcessState) : Transition :=
  if scope != state.scope then ⟨state, []⟩ else
    if state.phase != .active then ⟨state, []⟩ else
      ⟨{ state with
          phase := .revoked
          authority := false
          childAbortRequested := true
          parent := if unlockFor cause then { state.parent with locked := false }
            else state.parent },
        [.signalChild scope.child, .drainOrQuarantineWrites scope.child]⟩

-- Takeover passes the full original value once in this transition, without waiting for the private child or retaining a queue slot.
def takeover (scope : Scope) (payload : UserPayload) (state : ProcessState) : Transition :=
  let cancelled := revoke scope .userTakeover state
  { cancelled with actions := cancelled.actions ++ [.passOriginalInput payload] }

-- Cleanup requires observed write drain/permanent quarantine before disposal; scheduling the two successful cleanup steps is an explicit liveness premise.
-- No wall-clock, hardware, detached-work termination or rollback of completed tool effects is asserted.
structure CleanupObservations where
  writesDrainedOrPermanentlyQuarantined : Bool
  disposalSettles : Bool
  deriving DecidableEq, Repr

def cleanup (scope : Scope) (host : CleanupObservations)
    (state : ProcessState) : Transition :=
  if scope != state.scope then ⟨state, []⟩ else
    match state.phase with
    | .revoked =>
        if host.writesDrainedOrPermanentlyQuarantined then
          ⟨{ state with phase := .drained }, []⟩
        else ⟨state, []⟩
    | .drained =>
        if host.disposalSettles then
          ⟨{ state with phase := .disposed },
            [.disposeOwnedResources scope.child scope.directory]⟩
        else ⟨state, []⟩
    | _ => ⟨state, []⟩

-- Only current completion notices gain authority; ignored late notices do not imply their physical writes were rolled back.
-- Observing an incompatible source revokes the operation, while exact owned excluded-audit appends retain its source.
def callback (scope : Scope) (event : PrivateCallback)
    (state : ProcessState) : ProcessState :=
  if scope != state.scope then state else
    if canAccept state then
      { state with
        callbacksAccepted := state.callbacksAccepted + 1
        fileResultAccepted := state.fileResultAccepted || event == .fileWrite }
    else state

def observeSource (scope : Scope) (view : SourceView) (state : ProcessState) : ProcessState :=
  if scope != state.scope then state else
    if sourceCurrent state.scope view then { state with source := view }
    else (revoke scope .lifecycleReplacement { state with source := view }).state

-- Finite traces admit arbitrary interleavings of source observations, callbacks, cancellation and cleanup for a fixed operation identity.
inductive Event where
  | cancel (cause : CancelCause)
  | cleanup (host : CleanupObservations)
  | callback (event : PrivateCallback)
  | sourceChanged (view : SourceView)
  deriving DecidableEq, Repr

def step (scope : Scope) (event : Event) (state : ProcessState) : ProcessState :=
  match event with
  | .cancel cause => (revoke scope cause state).state
  | .cleanup host => (cleanup scope host state).state
  | .callback event => callback scope event state
  | .sourceChanged view => observeSource scope view state

def run (scope : Scope) (events : List Event) (state : ProcessState) : ProcessState :=
  events.foldl (fun state event => step scope event state) state

-- Safety ties authority to the live phase and keeps private completion/cancellation out of main work, context, budget and callback suspension.
def invariant (state : ProcessState) : Prop :=
  (state.phase = .active ↔ state.authority = true) ∧
    (state.phase ≠ .active → state.childAbortRequested = true)

def privateIsolation (before after : ProcessState) : Prop :=
  after.parent.run = before.parent.run ∧
    after.parent.context = before.parent.context ∧
    after.parent.spent = before.parent.spent ∧
    after.parent.callbackSuspended = before.parent.callbackSuspended

def noFurtherAuthority (state : ProcessState) : Prop :=
  state.phase ≠ .active ∧ state.authority = false ∧ canAccept state = false

-- Initialization, exact targeting and the callback guard establish the local cancellation contract for both current and foreign identities.
theorem initial_invariant (scope : Scope) (parent : ParentState) :
    invariant (initial scope parent) := by
  simp [invariant, initial]

theorem revoke_current (state : ProcessState) (cause : CancelCause)
    (active : state.phase = .active) :
    noFurtherAuthority (revoke state.scope cause state).state ∧
      (revoke state.scope cause state).state.childAbortRequested = true ∧
      (revoke state.scope cause state).actions =
        [.signalChild state.scope.child, .drainOrQuarantineWrites state.scope.child] := by
  simp [revoke, active, noFurtherAuthority, canAccept]

theorem targeted_signal_and_cause (state : ProcessState) (cause : CancelCause)
    (active : state.phase = .active) :
    (revoke state.scope cause state).actions =
      [.signalChild state.scope.child, .drainOrQuarantineWrites state.scope.child] ∧
    (revoke state.scope cause state).state.parent.locked =
      if unlockFor cause then false else state.parent.locked := by
  cases unlock : unlockFor cause <;> simp [revoke, active, unlock]

theorem callback_guard_sound_and_complete (state : ProcessState) :
    canAccept state = true ↔ state.phase = .active ∧ state.authority = true ∧
      sourceCurrent state.scope state.source = true := by
  simp [canAccept, Bool.and_eq_true, and_assoc]

theorem callback_revoked (scope : Scope) (event : PrivateCallback)
    (state : ProcessState) (revoked : noFurtherAuthority state) :
    callback scope event state = state := by
  simp [callback, revoked.2.2]

theorem foreign_events_inert (incoming : Scope) (event : Event)
    (state : ProcessState) (foreign : incoming ≠ state.scope) :
    step incoming event state = state := by
  cases event <;> simp [step, revoke, cleanup, callback, observeSource, foreign]

-- Every permitted event preserves the lifecycle invariant and parent isolation, including source replacement and repeated completion notices.
theorem step_preserves_invariant (scope : Scope) (event : Event)
    (state : ProcessState) (valid : invariant state) :
    invariant (step scope event state) := by
  cases event with
  | cancel cause =>
      by_cases same : scope = state.scope
      · by_cases active : state.phase = .active
        · simp [step, revoke, same, active, invariant]
        · simpa [step, revoke, same, active] using valid
      · simpa [step, revoke, same] using valid
  | callback event =>
      by_cases same : scope = state.scope <;>
        by_cases accept : canAccept state = true <;>
        simpa [step, callback, same, accept, invariant] using valid
  | sourceChanged view =>
      by_cases same : scope = state.scope <;>
        by_cases current : sourceCurrent state.scope view = true <;>
        by_cases active : state.phase = .active <;>
        simp_all [step, observeSource, revoke, invariant]
  | cleanup host =>
      by_cases same : scope = state.scope
      · cases phase : state.phase <;>
          cases writes : host.writesDrainedOrPermanentlyQuarantined <;>
          cases disposed : host.disposalSettles <;>
          simp_all [step, cleanup, invariant]
      · simpa [step, cleanup, same] using valid

theorem step_isolates_parent (scope : Scope) (event : Event) (state : ProcessState) :
    privateIsolation state (step scope event state) := by
  cases event with
  | cancel cause =>
      by_cases same : scope = state.scope <;>
        by_cases active : state.phase = .active <;>
        cases unlock : unlockFor cause <;>
        simp [step, revoke, same, active, unlock, privateIsolation]
  | callback event =>
      by_cases same : scope = state.scope <;>
        cases accept : canAccept state <;>
        simp [step, callback, same, accept, privateIsolation]
  | sourceChanged view =>
      by_cases same : scope = state.scope <;>
        by_cases current : sourceCurrent state.scope view = true <;>
        by_cases active : state.phase = .active <;>
        simp [step, observeSource, revoke, same, current, active, unlockFor, privateIsolation]
  | cleanup host =>
      by_cases same : scope = state.scope <;>
        cases phase : state.phase <;>
        cases writes : host.writesDrainedOrPermanentlyQuarantined <;>
        cases disposed : host.disposalSettles <;>
        simp [step, cleanup, same, phase, writes, disposed, privateIsolation]

theorem run_preserves_invariant (scope : Scope) (events : List Event)
    (state : ProcessState) (valid : invariant state) :
    invariant (run scope events state) := by
  induction events generalizing state with
  | nil => exact valid
  | cons event events ih =>
      exact ih _ (step_preserves_invariant scope event state valid)

theorem run_isolates_parent (scope : Scope) (events : List Event) (state : ProcessState) :
    privateIsolation state (run scope events state) := by
  induction events generalizing state with
  | nil => simp [run, privateIsolation]
  | cons event events ih =>
      have first := step_isolates_parent scope event state
      have rest := ih (step scope event state)
      exact ⟨rest.1.trans first.1, rest.2.1.trans first.2.1,
        rest.2.2.1.trans first.2.2.1, rest.2.2.2.trans first.2.2.2⟩

-- Revocation is permanent across every finite event interleaving; repeated cancellation emits no further owned actions.
theorem repeated_cancellation_is_inert (scope : Scope) (cause : CancelCause)
    (state : ProcessState) (revoked : noFurtherAuthority state) :
    revoke scope cause state = ⟨state, []⟩ := by
  simp [revoke, revoked.1]

theorem step_preserves_revocation (scope : Scope) (event : Event)
    (state : ProcessState) (revoked : noFurtherAuthority state) :
    noFurtherAuthority (step scope event state) := by
  cases event with
  | cancel cause => simpa [step, revoke, revoked.1] using revoked
  | callback event => simpa [step, callback_revoked scope event state revoked] using revoked
  | sourceChanged view =>
      by_cases same : scope = state.scope <;>
        by_cases current : sourceCurrent state.scope view = true <;>
        simp_all [step, observeSource, revoke, noFurtherAuthority, canAccept]
  | cleanup host =>
      by_cases same : scope = state.scope
      · cases phase : state.phase <;>
          cases writes : host.writesDrainedOrPermanentlyQuarantined <;>
          cases disposed : host.disposalSettles <;>
          simp_all [step, cleanup, noFurtherAuthority, canAccept]
      · simpa [step, cleanup, same] using revoked

theorem revoked_for_every_interleaving (scope : Scope) (events : List Event)
    (state : ProcessState) (revoked : noFurtherAuthority state) :
    noFurtherAuthority (run scope events state) := by
  induction events generalizing state with
  | nil => exact revoked
  | cons event events ih =>
      exact ih _ (step_preserves_revocation scope event state revoked)

-- Takeover preserves main state and emits one complete host input pass; cleanup progresses only after its explicit observations.
-- Termination proves the two-step admitted cleanup path, not termination under a scheduler that never runs cleanup.
theorem takeover_passes_complete_payload_once (state : ProcessState)
    (payload : UserPayload) (active : state.phase = .active) :
    (takeover state.scope payload state).actions =
      [.signalChild state.scope.child, .drainOrQuarantineWrites state.scope.child,
        .passOriginalInput payload] ∧
      (takeover state.scope payload state).state.parent = state.parent := by
  simp [takeover, revoke, active, unlockFor]

theorem cleanup_waits_for_writes (state : ProcessState)
    (revoked : state.phase = .revoked) (host : CleanupObservations)
    (notDrained : host.writesDrainedOrPermanentlyQuarantined = false) :
    cleanup state.scope host state = ⟨state, []⟩ := by
  simp [cleanup, revoked, notDrained]

theorem disposal_requires_drain (scope : Scope) (state : ProcessState)
    (host : CleanupObservations)
    (disposes : Action.disposeOwnedResources scope.child scope.directory ∈
      (cleanup scope host state).actions) :
    scope = state.scope ∧ state.phase = .drained := by
  by_cases same : scope = state.scope
  · cases phase : state.phase <;>
      cases writes : host.writesDrainedOrPermanentlyQuarantined <;>
      cases disposed : host.disposalSettles <;>
      simp_all [cleanup]
  · simp [cleanup, same] at disposes

theorem cleanup_progress_and_termination (state : ProcessState)
    (active : state.phase = .active) (cause : CancelCause)
    (host : CleanupObservations)
    (drains : host.writesDrainedOrPermanentlyQuarantined = true)
    (settles : host.disposalSettles = true) :
    let revoked := (revoke state.scope cause state).state
    let drained := (cleanup state.scope host revoked).state
    let disposed := (cleanup state.scope host drained).state
    revoked.phase = .revoked ∧ drained.phase = .drained ∧
      disposed.phase = .disposed ∧ noFurtherAuthority disposed := by
  simp [revoke, active, cleanup, drains, settles, noFurtherAuthority, canAccept]

-- Source fences reject changed identities and foreign/model-content appends without making exact owned audit descendants stale against themselves.
theorem source_mismatch_blocks_acceptance (state : ProcessState)
    (mismatch : state.scope ≠ state.source.scope) :
    canAccept state = false := by
  simp [canAccept, sourceCurrent, mismatch]

theorem exact_owned_audit_keeps_source (scope : Scope) (entries : List SourceAppend)
    (valid : sourceCurrent scope ⟨scope, entries⟩ = true) :
    sourceCurrent scope ⟨scope, entries ++ [.ownedExcludedAudit scope.operation]⟩ = true := by
  simpa [sourceCurrent, List.all_append] using valid

theorem foreign_append_blocks_source (scope : Scope) (entries : List SourceAppend) :
    sourceCurrent scope ⟨scope, entries ++ [.foreignOrModelContent]⟩ = false := by
  simp [sourceCurrent, List.all_append]

-- The separate ordinary-work path may abort only an exactly owned main continuation; genuine user work clears that ownership.
inductive AbortTarget where
  | none
  | main (scope : Scope)
  deriving DecidableEq, Repr

def ordinaryManualUnlockTarget (claim : Scope) (run : MainRun) : AbortTarget :=
  match run with
  | .ownedContinuation owner => if owner == claim then .main owner else .none
  | _ => .none

def foreignUserTakesContinuation (_run : MainRun) (newIdentity : Nat) : MainRun :=
  .foreign newIdentity

theorem ordinary_cancellation_exact (scope owner : Scope) (identity : Nat) :
    ordinaryManualUnlockTarget scope (.ownedContinuation scope) = .main scope ∧
    (owner ≠ scope → ordinaryManualUnlockTarget scope (.ownedContinuation owner) = .none) ∧
    ordinaryManualUnlockTarget scope (.foreign identity) = .none ∧
    ordinaryManualUnlockTarget scope
      (foreignUserTakesContinuation (.ownedContinuation scope) identity) = .none := by
  simp [ordinaryManualUnlockTarget, foreignUserTakesContinuation]

-- Terminality, normalized validation and confirmed parent receipts are explicit boundary observations, never inferred from a readable private result file.
-- A transaction is the authoritative owned publication state; replay uses its updated charge/application flags, not a reconstructed old snapshot.
inductive Outcome where
  | continueWork
  | waitCallback
  | unlock
  deriving DecidableEq, Repr

structure Publication where
  scope : Scope
  outcome : Outcome
  terminal : Bool
  normalized : Bool
  confirmedReceipt : Bool
  charged : Bool
  applied : Bool
  deriving DecidableEq, Repr

def costsUnit (outcome : Outcome) : Bool := outcome != .unlock

structure Transaction where
  publication : Publication
  state : ProcessState
  deriving DecidableEq, Repr

-- Final continue and callback outcomes share one unit; only unconfirmed, unapplied continuation reservations can be refunded.
-- Applying an outcome requires current scope, a terminal validated candidate and an actual observed receipt.
def reserve (transaction : Transaction) : Transaction :=
  let publication := transaction.publication
  let state := transaction.state
  if publication.scope == state.scope && canAccept state &&
      publication.terminal && publication.normalized && !publication.charged &&
      costsUnit publication.outcome then
    { publication := { publication with charged := true }
      state := { state with parent := { state.parent with spent := state.parent.spent + 1 } } }
  else transaction

def rollback (transaction : Transaction) : Transaction :=
  let publication := transaction.publication
  let state := transaction.state
  if publication.scope == state.scope && publication.charged &&
      !publication.confirmedReceipt && !publication.applied &&
      publication.outcome == .continueWork then
    { publication := { publication with charged := false }
      state := { state with parent := { state.parent with spent := state.parent.spent - 1 } } }
  else transaction

def applyPublished (transaction : Transaction) : Transaction :=
  let publication := transaction.publication
  let state := transaction.state
  if publication.scope == state.scope && canAccept state &&
      publication.terminal && publication.normalized && publication.confirmedReceipt &&
      !publication.applied && (!costsUnit publication.outcome || publication.charged) then
    let parent := match publication.outcome with
      | .continueWork => { state.parent with run := .ownedContinuation state.scope }
      | .waitCallback => { state.parent with callbackSuspended := true }
      | .unlock => { state.parent with locked := false }
    { publication := { publication with applied := true }
      state := { state with parent } }
  else transaction

def resumeCallback (parent : ParentState) : ParentState :=
  { parent with callbackSuspended := false }

-- These boundary proofs reject intermediate, stale, revoked or unreceipted effects and establish once-only charge/apply/refund behavior.
theorem no_receipt_no_effect (transaction : Transaction)
    (missing : transaction.publication.confirmedReceipt = false) :
    applyPublished transaction = transaction := by
  simp [applyPublished, missing]

theorem no_intermediate_parent_effect (transaction : Transaction)
    (intermediate : transaction.publication.terminal = false) :
    applyPublished transaction = transaction ∧ reserve transaction = transaction := by
  simp [applyPublished, reserve, intermediate]

theorem revoked_has_no_publication (transaction : Transaction)
    (revoked : noFurtherAuthority transaction.state) :
    applyPublished transaction = transaction ∧ reserve transaction = transaction := by
  simp [applyPublished, reserve, revoked.2.2]

theorem stale_publication_inert (transaction : Transaction)
    (stale : transaction.publication.scope ≠ transaction.state.scope) :
    applyPublished transaction = transaction ∧ reserve transaction = transaction ∧
      rollback transaction = transaction := by
  simp [applyPublished, reserve, rollback, stale]

theorem confirmed_receipt_not_refunded (transaction : Transaction)
    (confirmed : transaction.publication.confirmedReceipt = true) :
    rollback transaction = transaction := by
  simp [rollback, confirmed]

theorem callback_not_refunded (transaction : Transaction)
    (callbackOutcome : transaction.publication.outcome = .waitCallback) :
    rollback transaction = transaction := by
  simp [rollback, callbackOutcome]

theorem shared_budget_unit (transaction : Transaction)
    (same : transaction.publication.scope = transaction.state.scope)
    (current : canAccept transaction.state = true)
    (terminal : transaction.publication.terminal = true)
    (normalized : transaction.publication.normalized = true)
    (notCharged : transaction.publication.charged = false) :
    (reserve transaction).state.parent.spent =
      transaction.state.parent.spent + if costsUnit transaction.publication.outcome then 1 else 0 := by
  cases cost : costsUnit transaction.publication.outcome <;>
    simp [reserve, same, current, terminal, normalized, notCharged, cost]

theorem unsent_continuation_rollback (transaction : Transaction)
    (same : transaction.publication.scope = transaction.state.scope)
    (charged : transaction.publication.charged = true)
    (unconfirmed : transaction.publication.confirmedReceipt = false)
    (unapplied : transaction.publication.applied = false)
    (outcome : transaction.publication.outcome = .continueWork)
    (previousSpent : Nat) (count : transaction.state.parent.spent = previousSpent + 1) :
    (rollback transaction).state.parent.spent = previousSpent := by
  simp [rollback, same, charged, unconfirmed, unapplied, outcome, count]

theorem transaction_replay_is_inert (transaction : Transaction) :
    reserve (reserve transaction) = reserve transaction ∧
      rollback (rollback transaction) = rollback transaction ∧
      applyPublished (applyPublished transaction) = applyPublished transaction := by
  constructor
  · unfold reserve
    dsimp only
    split <;> simp_all
  constructor
  · unfold rollback
    dsimp only
    split <;> simp_all
  · unfold applyPublished
    dsimp only
    split <;> simp_all

theorem callback_resume_costs_zero (parent : ParentState) :
    (resumeCallback parent).spent = parent.spent ∧
      (resumeCallback parent).callbackSuspended = false := by
  simp [resumeCallback]

-- Native main-abort presentation is fenced by actual aborted outcome and exact current continuation ownership, not text or a child notice.
structure NativeAbort where
  run : MainRun
  claim : Scope
  actualAborted : Bool
  noticeVisible : Bool
  partialOutput : String
  toolResults : List String
  settled : Bool
  unlockCount : Nat
  locked : Bool
  deriving DecidableEq, Repr

def quietNativeAbort (state : NativeAbort) : NativeAbort :=
  if state.actualAborted && ordinaryManualUnlockTarget state.claim state.run != .none then
    { state with noticeVisible := false }
  else state

theorem exact_native_abort_hides_notice (state : NativeAbort)
    (aborted : state.actualAborted = true)
    (owned : ordinaryManualUnlockTarget state.claim state.run ≠ .none) :
    (quietNativeAbort state).noticeVisible = false := by
  simp [quietNativeAbort, aborted, owned]

theorem native_abort_exact_and_control_preserved (state : NativeAbort) :
    (quietNativeAbort state).actualAborted = state.actualAborted ∧
    (quietNativeAbort state).partialOutput = state.partialOutput ∧
    (quietNativeAbort state).toolResults = state.toolResults ∧
    (state.actualAborted = false → quietNativeAbort state = state) ∧
    (ordinaryManualUnlockTarget state.claim state.run = .none →
      quietNativeAbort state = state) ∧
    quietNativeAbort (quietNativeAbort state) = quietNativeAbort state := by
  by_cases abort : state.actualAborted = true <;>
    by_cases target : ordinaryManualUnlockTarget state.claim state.run = .none <;>
    simp_all [quietNativeAbort]

-- Native settlement records its handled bit before another callback can unlock again; actual abort state and prior output/tool results survive.
def settleNativeAbort (state : NativeAbort) : NativeAbort :=
  if state.settled then state else
    if state.actualAborted && ordinaryManualUnlockTarget state.claim state.run != .none then
      { state with settled := true, unlockCount := state.unlockCount + 1, locked := false }
    else { state with settled := true }

theorem exact_native_abort_unlocks_once (state : NativeAbort)
    (unhandled : state.settled = false) (aborted : state.actualAborted = true)
    (owned : ordinaryManualUnlockTarget state.claim state.run ≠ .none) :
    (settleNativeAbort state).settled = true ∧
      (settleNativeAbort state).unlockCount = state.unlockCount + 1 ∧
      (settleNativeAbort state).locked = false := by
  simp [settleNativeAbort, unhandled, aborted, owned]

theorem native_settlement_is_once_and_fenced (state : NativeAbort) :
    settleNativeAbort (settleNativeAbort state) = settleNativeAbort state ∧
    (ordinaryManualUnlockTarget state.claim state.run = .none →
      (settleNativeAbort state).unlockCount = state.unlockCount ∧
      (settleNativeAbort state).locked = state.locked) ∧
    (settleNativeAbort state).actualAborted = state.actualAborted ∧
    (settleNativeAbort state).partialOutput = state.partialOutput ∧
    (settleNativeAbort state).toolResults = state.toolResults := by
  by_cases settled : state.settled = true <;>
    by_cases abort : state.actualAborted = true <;>
    by_cases target : ordinaryManualUnlockTarget state.claim state.run = .none <;>
    simp_all [settleNativeAbort]

-- Historical projection removes only exactly classified owned residue; unrelated plugin/user records remain available unchanged.
-- Entry classification is an input contract, not a proof of the real legacy parser or persisted byte format.
structure LegacyEntry where
  owner : Option Scope
  internalInquiryOrOwnedCancellationResidue : Bool
  content : String
  deriving DecidableEq, Repr

def legacyProjection (scope : Scope) (entries : List LegacyEntry) : List LegacyEntry :=
  entries.filter (fun entry => !(entry.owner == some scope &&
    entry.internalInquiryOrOwnedCancellationResidue))

theorem unrelated_legacy_entries_preserved (scope : Scope) (entry : LegacyEntry)
    (entries : List LegacyEntry) (foreign : entry.owner ≠ some scope) :
    entry ∈ legacyProjection scope entries ↔ entry ∈ entries := by
  simp [legacyProjection, foreign]

theorem exact_legacy_residue_removed (scope : Scope) (entry : LegacyEntry)
    (entries : List LegacyEntry) (same : entry.owner = some scope)
    (internalEntry : entry.internalInquiryOrOwnedCancellationResidue = true) :
    entry ∉ legacyProjection scope entries := by
  simp [legacyProjection, same, internalEntry]

-- Recovery restores safe audit history only, with no child, lock, result path authority, retry allowance or publication to resume.
-- Ordinary conversation is supplied separately from context-excluded private/legacy history.
structure History where
  safeAudit : List String
  legacyInquiry : List String
  privatePromptAndToolTraffic : List String
  deriving DecidableEq, Repr

structure Recovered where
  audit : List String
  activeChild : Option Scope
  resultAuthority : Bool
  locked : Bool
  retryAllowance : Nat
  publication : Option Publication
  deriving DecidableEq, Repr

def recover (history : History) : Recovered :=
  ⟨history.safeAudit, none, false, false, 0, none⟩

def mainContextProjection (ordinary : List String) (_history : History) : List String :=
  ordinary

theorem history_only_recovery (history : History) (ordinary : List String) :
    (recover history).activeChild = none ∧
      (recover history).resultAuthority = false ∧
      (recover history).locked = false ∧
      (recover history).retryAllowance = 0 ∧
      (recover history).publication = none ∧
      mainContextProjection ordinary history = ordinary := by
  simp [recover, mainContextProjection]

-- The cancellation guarantee record collects initialization, preservation, trace safety, replacement isolation, pass-through and conditional cleanup progress.
structure CancellationGuarantees (scope : Scope) (parent : ParentState) : Prop where
  initialization : invariant (initial scope parent)
  preservation : ∀ state event, invariant state → invariant (step scope event state)
  safety : ∀ events, invariant (run scope events (initial scope parent))
  privateIsolation : ∀ state event, WatchdogUserTakeover.privateIsolation state (step scope event state)
  traceIsolation : ∀ state events, WatchdogUserTakeover.privateIsolation state (run scope events state)
  repeatedCancellation : ∀ state cause, noFurtherAuthority state →
    revoke scope cause state = ⟨state, []⟩
  immediateRevocation : ∀ state cause, state.phase = .active →
    noFurtherAuthority (revoke state.scope cause state).state
  targetedSignal : ∀ state cause, state.phase = .active →
    (revoke state.scope cause state).actions =
      [.signalChild state.scope.child, .drainOrQuarantineWrites state.scope.child] ∧
    (revoke state.scope cause state).state.parent.locked =
      if unlockFor cause then false else state.parent.locked
  callbackGuard : ∀ state, canAccept state = true ↔
    state.phase = .active ∧ state.authority = true ∧ sourceCurrent state.scope state.source = true
  allInterleavings : ∀ state events, noFurtherAuthority state →
    noFurtherAuthority (run scope events state)
  replacementScope : ∀ incoming state event, incoming ≠ state.scope →
    step incoming event state = state
  hostInputPassThrough : ∀ state payload, state.phase = .active →
    (takeover state.scope payload state).actions =
      [.signalChild state.scope.child, .drainOrQuarantineWrites state.scope.child,
        .passOriginalInput payload] ∧
      (takeover state.scope payload state).state.parent = state.parent
  disposalAfterDrain : ∀ state host,
    Action.disposeOwnedResources scope.child scope.directory ∈
      (cleanup scope host state).actions → scope = state.scope ∧ state.phase = .drained
  conditionalTermination : ∀ state cause host, state.phase = .active →
    host.writesDrainedOrPermanentlyQuarantined = true → host.disposalSettles = true →
    let revoked := (revoke state.scope cause state).state
    let drained := (cleanup state.scope host revoked).state
    let disposed := (cleanup state.scope host drained).state
    revoked.phase = .revoked ∧ drained.phase = .drained ∧
      disposed.phase = .disposed ∧ noFurtherAuthority disposed

-- This theorem closes every modeled cancellation obligation for arbitrary parent snapshots and finite event traces.
theorem cancellation_is_correct (scope : Scope) (parent : ParentState) :
    CancellationGuarantees scope parent := by
  exact {
    initialization := initial_invariant scope parent
    preservation := fun state event valid => step_preserves_invariant scope event state valid
    safety := fun events => run_preserves_invariant scope events _ (initial_invariant scope parent)
    privateIsolation := fun state event => step_isolates_parent scope event state
    traceIsolation := fun state events => run_isolates_parent scope events state
    repeatedCancellation := fun state cause revoked =>
      repeated_cancellation_is_inert scope cause state revoked
    immediateRevocation := fun state cause active => (revoke_current state cause active).1
    targetedSignal := targeted_signal_and_cause
    callbackGuard := callback_guard_sound_and_complete
    allInterleavings := fun state events revoked =>
      revoked_for_every_interleaving scope events state revoked
    replacementScope := fun incoming state event foreign =>
      foreign_events_inert incoming event state foreign
    hostInputPassThrough := takeover_passes_complete_payload_once
    disposalAfterDrain := fun state host disposes => disposal_requires_drain scope state host disposes
    conditionalTermination := fun state cause host active drains settles =>
      cleanup_progress_and_termination state active cause host drains settles }

-- Boundary obligations retain exact ownership/source checks, receipt/refund accounting, callback behavior, native abort safety and history-only recovery.
structure BoundaryGuarantees : Prop where
  sourceMismatch : ∀ state, state.scope ≠ state.source.scope → canAccept state = false
  ownedAudit : ∀ scope entries, sourceCurrent scope ⟨scope, entries⟩ = true →
    sourceCurrent scope ⟨scope, entries ++ [.ownedExcludedAudit scope.operation]⟩ = true
  foreignSource : ∀ scope entries,
    sourceCurrent scope ⟨scope, entries ++ [.foreignOrModelContent]⟩ = false
  exactMainTarget : ∀ scope owner identity,
    ordinaryManualUnlockTarget scope (.ownedContinuation scope) = .main scope ∧
    (owner ≠ scope → ordinaryManualUnlockTarget scope (.ownedContinuation owner) = .none) ∧
    ordinaryManualUnlockTarget scope (.foreign identity) = .none ∧
    ordinaryManualUnlockTarget scope
      (foreignUserTakesContinuation (.ownedContinuation scope) identity) = .none
  receiptRequired : ∀ transaction, transaction.publication.confirmedReceipt = false →
    applyPublished transaction = transaction
  terminalOnly : ∀ transaction, transaction.publication.terminal = false →
    applyPublished transaction = transaction ∧ reserve transaction = transaction
  revokedPublication : ∀ transaction, noFurtherAuthority transaction.state →
    applyPublished transaction = transaction ∧ reserve transaction = transaction
  stalePublication : ∀ transaction, transaction.publication.scope ≠ transaction.state.scope →
    applyPublished transaction = transaction ∧ reserve transaction = transaction ∧
      rollback transaction = transaction
  confirmedNotRefunded : ∀ transaction, transaction.publication.confirmedReceipt = true →
    rollback transaction = transaction
  callbackNotRefunded : ∀ transaction, transaction.publication.outcome = .waitCallback →
    rollback transaction = transaction
  sharedBudget : ∀ transaction, transaction.publication.scope = transaction.state.scope →
    canAccept transaction.state = true → transaction.publication.terminal = true →
    transaction.publication.normalized = true → transaction.publication.charged = false →
    (reserve transaction).state.parent.spent = transaction.state.parent.spent +
      if costsUnit transaction.publication.outcome then 1 else 0
  unsentRollback : ∀ transaction previousSpent,
    transaction.publication.scope = transaction.state.scope →
    transaction.publication.charged = true → transaction.publication.confirmedReceipt = false →
    transaction.publication.applied = false → transaction.publication.outcome = .continueWork →
    transaction.state.parent.spent = previousSpent + 1 →
    (rollback transaction).state.parent.spent = previousSpent
  transactionReplay : ∀ transaction,
    reserve (reserve transaction) = reserve transaction ∧
    rollback (rollback transaction) = rollback transaction ∧
    applyPublished (applyPublished transaction) = applyPublished transaction
  callbackResume : ∀ parent, (resumeCallback parent).spent = parent.spent ∧
    (resumeCallback parent).callbackSuspended = false
  nativeNoticeHidden : ∀ state, state.actualAborted = true →
    ordinaryManualUnlockTarget state.claim state.run ≠ .none →
    (quietNativeAbort state).noticeVisible = false
  nativeUnlockOnce : ∀ state, state.settled = false → state.actualAborted = true →
    ordinaryManualUnlockTarget state.claim state.run ≠ .none →
    (settleNativeAbort state).settled = true ∧
    (settleNativeAbort state).unlockCount = state.unlockCount + 1 ∧
    (settleNativeAbort state).locked = false
  nativePresentation : ∀ state,
    (quietNativeAbort state).actualAborted = state.actualAborted ∧
    (quietNativeAbort state).partialOutput = state.partialOutput ∧
    (quietNativeAbort state).toolResults = state.toolResults ∧
    (state.actualAborted = false → quietNativeAbort state = state) ∧
    (ordinaryManualUnlockTarget state.claim state.run = .none → quietNativeAbort state = state) ∧
    quietNativeAbort (quietNativeAbort state) = quietNativeAbort state
  nativeSettlement : ∀ state,
    settleNativeAbort (settleNativeAbort state) = settleNativeAbort state ∧
    (ordinaryManualUnlockTarget state.claim state.run = .none →
      (settleNativeAbort state).unlockCount = state.unlockCount ∧
      (settleNativeAbort state).locked = state.locked) ∧
    (settleNativeAbort state).actualAborted = state.actualAborted ∧
    (settleNativeAbort state).partialOutput = state.partialOutput ∧
    (settleNativeAbort state).toolResults = state.toolResults
  foreignEntries : ∀ scope entry entries, entry.owner ≠ some scope →
    (entry ∈ legacyProjection scope entries ↔ entry ∈ entries)
  ownedResidue : ∀ scope entry entries, entry.owner = some scope →
    entry.internalInquiryOrOwnedCancellationResidue = true → entry ∉ legacyProjection scope entries
  recovery : ∀ history ordinary, (recover history).activeChild = none ∧
    (recover history).resultAuthority = false ∧ (recover history).locked = false ∧
    (recover history).retryAllowance = 0 ∧ (recover history).publication = none ∧
    mainContextProjection ordinary history = ordinary

-- Supporting proofs jointly discharge those local boundary obligations; this is not a proof of all real publication interleavings.
theorem boundaries_are_correct : BoundaryGuarantees := by
  exact {
    sourceMismatch := source_mismatch_blocks_acceptance
    ownedAudit := exact_owned_audit_keeps_source
    foreignSource := foreign_append_blocks_source
    exactMainTarget := ordinary_cancellation_exact
    receiptRequired := no_receipt_no_effect
    terminalOnly := no_intermediate_parent_effect
    revokedPublication := revoked_has_no_publication
    stalePublication := stale_publication_inert
    confirmedNotRefunded := confirmed_receipt_not_refunded
    callbackNotRefunded := callback_not_refunded
    sharedBudget := shared_budget_unit
    unsentRollback := fun transaction previousSpent same charged unconfirmed unapplied outcome count =>
      unsent_continuation_rollback transaction same charged unconfirmed unapplied outcome previousSpent count
    transactionReplay := transaction_replay_is_inert
    callbackResume := callback_resume_costs_zero
    nativeNoticeHidden := exact_native_abort_hides_notice
    nativeUnlockOnce := exact_native_abort_unlocks_once
    nativePresentation := native_abort_exact_and_control_preserved
    nativeSettlement := native_settlement_is_once_and_fenced
    foreignEntries := unrelated_legacy_entries_preserved
    ownedResidue := exact_legacy_residue_removed
    recovery := history_only_recovery }

-- Top correctness combines the cancellation process and local boundaries under the explicit admitted host/runner observations.
-- It does not certify LLM judgment, actual final provider wire payloads, hardware behavior or observed production conformance.
theorem process_is_correct (scope : Scope) (parent : ParentState)
    (entry : EntryObservations) (observed : admitted entry) :
    admitted entry ∧ CancellationGuarantees scope parent ∧ BoundaryGuarantees := by
  exact ⟨observed, cancellation_is_correct scope parent, boundaries_are_correct⟩

end WatchdogUserTakeover

-- Inspect the combined theorem: accepted Lean foundations are propext, Classical.choice and Quot.sound, with no custom axioms.
#print axioms WatchdogUserTakeover.process_is_correct

-- Executable examples illustrate revoked child authority, unchanged foreign main state, complete input pass-through and observed cleanup completion.
def main : IO Unit := do
  let scope : WatchdogUserTakeover.Scope := ⟨1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11⟩
  let parent : WatchdogUserTakeover.ParentState := ⟨.foreign 12, ["ordinary conversation"], 2, false, true⟩
  let state := WatchdogUserTakeover.initial scope parent
  let payload : WatchdogUserTakeover.UserPayload := ⟨"Inspect image", [("image/png", "opaque bytes")]⟩
  let takeover := WatchdogUserTakeover.takeover scope payload state
  let host : WatchdogUserTakeover.CleanupObservations := ⟨true, true⟩
  let drained := (WatchdogUserTakeover.cleanup scope host takeover.state).state
  let disposed := (WatchdogUserTakeover.cleanup scope host drained).state
  IO.println s!"Private signal revokes authority before cleanup: {!takeover.state.authority}"
  IO.println s!"Original text/images pass once; no capture/replay: {takeover.actions == [.signalChild scope.child, .drainOrQuarantineWrites scope.child, .passOriginalInput payload]}"
  IO.println s!"Foreign main run/context/budget unchanged: {disposed.parent == parent}"
  IO.println s!"Drain then owned disposal completes: {disposed.phase == .disposed}"
  IO.println "Proof scope: modeled cancellation interleavings; host/source/provider observations assumed, not live I/O or LLM judgment."
