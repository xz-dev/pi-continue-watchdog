-- Core Lean support provides finite data, equality decisions, and deterministic executable summaries.
import Std

set_option autoImplicit false

namespace WatchdogUserTakeover

-- Process vocabulary separates visible decision streaming, takeover synchronization, user work, and completion.
inductive Phase where
  | decisionStreaming
  | takeoverPending
  | userWork
  | complete
  deriving DecidableEq, Repr

-- Process data records transient presentation, persistent/context residue, fold evidence, user delivery, notices, and lock ownership.
structure ProcessState where
  phase : Phase
  hiddenPresentationRequested : Bool
  decisionStreamVisible : Bool
  assistantFinalDecisionStored : Bool
  sessionDecisionContentStored : Bool
  futureModelDecisionContent : Bool
  foldMarkerStored : Bool
  pendingUserMessage : Bool
  abortRequested : Bool
  userMessageStarted : Bool
  userMessageDeliveryCount : Nat
  userCycleStarted : Bool
  userOutputVisible : Bool
  operationAbortedVisible : Bool
  watchdogUnlockedVisible : Bool
  watchdogLocked : Bool
  deriving DecidableEq, Repr

-- Environmental assumptions bound liveness to host completion of abort-safe terminal cleanup, the aborted decision, and the subsequent user run.
structure EnvironmentAssumptions where
  uninterruptibleCleanupRuns : Bool
  abortedDecisionEnds : Bool
  userRunSettles : Bool
  deriving DecidableEq, Repr

def environmentAdmitted (environment : EnvironmentAssumptions) : Prop :=
  environment.uninterruptibleCleanupRuns = true ∧
    environment.abortedDecisionEnds = true ∧
    environment.userRunSettles = true

-- Named states make the complete object flow explicit; only the in-flight decision may expose transient streamed content, which finalization clears.
def decisionState (streamVisible : Bool) : ProcessState :=
  {
    phase := .decisionStreaming
    hiddenPresentationRequested := false
    decisionStreamVisible := streamVisible
    assistantFinalDecisionStored := false
    sessionDecisionContentStored := false
    futureModelDecisionContent := false
    foldMarkerStored := false
    pendingUserMessage := false
    abortRequested := false
    userMessageStarted := false
    userMessageDeliveryCount := 0
    userCycleStarted := false
    userOutputVisible := false
    operationAbortedVisible := false
    watchdogUnlockedVisible := false
    watchdogLocked := true
  }

def takeoverPendingState : ProcessState :=
  {
    phase := .takeoverPending
    hiddenPresentationRequested := false
    decisionStreamVisible := false
    assistantFinalDecisionStored := false
    sessionDecisionContentStored := false
    futureModelDecisionContent := false
    foldMarkerStored := true
    pendingUserMessage := true
    abortRequested := true
    userMessageStarted := false
    userMessageDeliveryCount := 0
    userCycleStarted := true
    userOutputVisible := false
    operationAbortedVisible := false
    watchdogUnlockedVisible := false
    watchdogLocked := true
  }

def userWorkState : ProcessState :=
  {
    phase := .userWork
    hiddenPresentationRequested := false
    decisionStreamVisible := false
    assistantFinalDecisionStored := false
    sessionDecisionContentStored := false
    futureModelDecisionContent := false
    foldMarkerStored := true
    pendingUserMessage := false
    abortRequested := true
    userMessageStarted := true
    userMessageDeliveryCount := 1
    userCycleStarted := true
    userOutputVisible := false
    operationAbortedVisible := false
    watchdogUnlockedVisible := false
    watchdogLocked := true
  }

def completedUserWorkState : ProcessState :=
  {
    phase := .complete
    hiddenPresentationRequested := false
    decisionStreamVisible := false
    assistantFinalDecisionStored := false
    sessionDecisionContentStored := false
    futureModelDecisionContent := false
    foldMarkerStored := true
    pendingUserMessage := false
    abortRequested := true
    userMessageStarted := true
    userMessageDeliveryCount := 1
    userCycleStarted := true
    userOutputVisible := true
    operationAbortedVisible := false
    watchdogUnlockedVisible := false
    watchdogLocked := true
  }

-- Final, safety, residue, takeover, and output predicates define the allowed result and every prohibited persistent artifact.
def finalState (state : ProcessState) : Prop :=
  state = completedUserWorkState

def forbiddenTakeoverResidue (state : ProcessState) : Prop :=
  state.phase ≠ .decisionStreaming ∧
    (state.decisionStreamVisible = true ∨
      state.assistantFinalDecisionStored = true ∨
      state.sessionDecisionContentStored = true ∨
      state.futureModelDecisionContent = true)

def processSafety (state : ProcessState) : Prop :=
  state.hiddenPresentationRequested = false ∧
    ¬forbiddenTakeoverResidue state ∧
    state.operationAbortedVisible = false ∧
    state.watchdogUnlockedVisible = false ∧
    state.userMessageDeliveryCount ≤ 1 ∧
    (state.userMessageStarted = true →
      state.userMessageDeliveryCount = 1 ∧
        state.userCycleStarted = true ∧
        state.watchdogLocked = true)

def takeoverPostcondition (state : ProcessState) : Prop :=
  state.phase = .takeoverPending ∧
    state.hiddenPresentationRequested = false ∧
    state.decisionStreamVisible = false ∧
    state.assistantFinalDecisionStored = false ∧
    state.sessionDecisionContentStored = false ∧
    state.futureModelDecisionContent = false ∧
    state.foldMarkerStored = true ∧
    state.pendingUserMessage = true ∧
    state.abortRequested = true ∧
    state.userCycleStarted = true ∧
    state.operationAbortedVisible = false ∧
    state.watchdogUnlockedVisible = false ∧
    state.watchdogLocked = true

def outputPostcondition (state : ProcessState) : Prop :=
  state.phase = .complete ∧
    state.hiddenPresentationRequested = false ∧
    state.decisionStreamVisible = false ∧
    state.assistantFinalDecisionStored = false ∧
    state.sessionDecisionContentStored = false ∧
    state.futureModelDecisionContent = false ∧
    state.foldMarkerStored = true ∧
    state.pendingUserMessage = false ∧
    state.userMessageStarted = true ∧
    state.userMessageDeliveryCount = 1 ∧
    state.userCycleStarted = true ∧
    state.userOutputVisible = true ∧
    state.operationAbortedVisible = false ∧
    state.watchdogUnlockedVisible = false ∧
    state.watchdogLocked = true

-- The invariant restricts reachable states to decision, cleaned takeover, exactly-once user work, and clean completion.
def processInvariant (streamWasVisible : Bool) (state : ProcessState) : Prop :=
  state = decisionState streamWasVisible ∨
    state = takeoverPendingState ∨
    state = userWorkState ∨
    state = completedUserWorkState

-- The deterministic transition models abort-safe public message-end replacement clearing decision content and records the fold before waiting for abort completion and user work.
def takeoverStep
    (environment : EnvironmentAssumptions)
    (state : ProcessState) : ProcessState :=
  match state.phase with
  | .decisionStreaming =>
      if environment.uninterruptibleCleanupRuns = true then
        takeoverPendingState
      else
        state
  | .takeoverPending =>
      if environment.abortedDecisionEnds = true then
        userWorkState
      else
        takeoverPendingState
  | .userWork =>
      if environment.userRunSettles = true then
        completedUserWorkState
      else
        userWorkState
  | .complete => state

-- Bounded iteration expresses complete traces without introducing an implementation workflow engine.
def iterate
    (step : ProcessState → ProcessState) : Nat → ProcessState → ProcessState
  | 0, state => state
  | count + 1, state => step (iterate step count state)

-- Phase guards form a complete and mutually exclusive branch partition for every process state.
def decisionIsStreaming (state : ProcessState) : Prop :=
  state.phase = .decisionStreaming

def waitingForAbortedDecisionEnd (state : ProcessState) : Prop :=
  state.phase = .takeoverPending

def processingUserWork (state : ProcessState) : Prop :=
  state.phase = .userWork

def processFinished (state : ProcessState) : Prop :=
  state.phase = .complete

def phaseGuardsCompleteAndExclusive (state : ProcessState) : Prop :=
  (decisionIsStreaming state ∨
      waitingForAbortedDecisionEnd state ∨
      processingUserWork state ∨
      processFinished state) ∧
    ¬(decisionIsStreaming state ∧ waitingForAbortedDecisionEnd state) ∧
    ¬(decisionIsStreaming state ∧ processingUserWork state) ∧
    ¬(decisionIsStreaming state ∧ processFinished state) ∧
    ¬(waitingForAbortedDecisionEnd state ∧ processingUserWork state) ∧
    ¬(waitingForAbortedDecisionEnd state ∧ processFinished state) ∧
    ¬(processingUserWork state ∧ processFinished state)

-- Guard proof establishes that exactly one phase branch applies at every decision point.
theorem phase_guards_complete_and_exclusive (state : ProcessState) :
    phaseGuardsCompleteAndExclusive state := by
  cases state with
  | mk phase hiddenPresentationRequested decisionStreamVisible
      assistantFinalDecisionStored sessionDecisionContentStored
      futureModelDecisionContent foldMarkerStored pendingUserMessage
      abortRequested userMessageStarted userMessageDeliveryCount
      userCycleStarted userOutputVisible operationAbortedVisible
      watchdogUnlockedVisible watchdogLocked =>
      cases phase <;>
        simp [phaseGuardsCompleteAndExclusive, decisionIsStreaming,
          waitingForAbortedDecisionEnd, processingUserWork, processFinished]

-- Supporting proofs establish initialization, preservation, safety, immediate cleanup, progress, termination, and the output contract.
theorem initialization (streamWasVisible : Bool) :
    processInvariant streamWasVisible (decisionState streamWasVisible) := by
  simp [processInvariant]

theorem takeover_step_preserves_invariant
    (environment : EnvironmentAssumptions)
    (streamWasVisible : Bool)
    (state : ProcessState)
    (invariant : processInvariant streamWasVisible state) :
    processInvariant streamWasVisible (takeoverStep environment state) := by
  rcases invariant with rfl | rfl | rfl | rfl
  · cases cleanupRuns : environment.uninterruptibleCleanupRuns <;>
      simp [takeoverStep, processInvariant, decisionState, cleanupRuns]
  · cases decisionEnds : environment.abortedDecisionEnds <;>
      simp [takeoverStep, processInvariant, takeoverPendingState, decisionEnds]
  · cases userSettles : environment.userRunSettles <;>
      simp [takeoverStep, processInvariant, userWorkState, userSettles]
  · simp [takeoverStep, processInvariant, completedUserWorkState]

theorem invariant_implies_safety
    (streamWasVisible : Bool)
    (state : ProcessState)
    (invariant : processInvariant streamWasVisible state) :
    processSafety state := by
  rcases invariant with rfl | rfl | rfl | rfl <;>
    simp [processSafety, forbiddenTakeoverResidue, decisionState,
      takeoverPendingState, userWorkState, completedUserWorkState]

theorem invariant_after_every_step
    (environment : EnvironmentAssumptions)
    (streamWasVisible : Bool)
    (count : Nat) :
    processInvariant streamWasVisible
      (iterate (takeoverStep environment) count
        (decisionState streamWasVisible)) := by
  induction count with
  | zero => exact initialization streamWasVisible
  | succ count inductionHypothesis =>
      exact takeover_step_preserves_invariant environment streamWasVisible _
        inductionHypothesis

theorem safety_after_every_step
    (environment : EnvironmentAssumptions)
    (streamWasVisible : Bool)
    (count : Nat) :
    processSafety
      (iterate (takeoverStep environment) count
        (decisionState streamWasVisible)) :=
  invariant_implies_safety streamWasVisible _
    (invariant_after_every_step environment streamWasVisible count)

theorem immediate_takeover_cleanup
    (environment : EnvironmentAssumptions)
    (assumptions : environmentAdmitted environment)
    (streamWasVisible : Bool) :
    takeoverPostcondition
      (takeoverStep environment (decisionState streamWasVisible)) := by
  simp [takeoverStep, assumptions.1, takeoverPostcondition, decisionState,
    takeoverPendingState]

theorem progress
    (environment : EnvironmentAssumptions)
    (assumptions : environmentAdmitted environment)
    (streamWasVisible : Bool)
    (state : ProcessState)
    (invariant : processInvariant streamWasVisible state)
    (notFinal : ¬finalState state) :
    takeoverStep environment state ≠ state := by
  rcases invariant with rfl | rfl | rfl | rfl <;>
    simp [takeoverStep, assumptions.1, assumptions.2.1, assumptions.2.2, finalState,
      decisionState, takeoverPendingState, userWorkState,
      completedUserWorkState] at *

theorem termination
    (environment : EnvironmentAssumptions)
    (assumptions : environmentAdmitted environment)
    (streamWasVisible : Bool) :
    iterate (takeoverStep environment) 3 (decisionState streamWasVisible) =
      completedUserWorkState := by
  simp [iterate, takeoverStep, assumptions.1, assumptions.2.1,
    assumptions.2.2,
    decisionState, takeoverPendingState, userWorkState]

theorem postcondition
    (environment : EnvironmentAssumptions)
    (assumptions : environmentAdmitted environment)
    (streamWasVisible : Bool) :
    outputPostcondition
      (iterate (takeoverStep environment) 3
        (decisionState streamWasVisible)) := by
  rw [termination environment assumptions streamWasVisible]
  simp [outputPostcondition, completedUserWorkState]

-- Inquiry correlation models one logical exchange/cycle boundary and permits arbitrary unrelated plugin entries without granting them watchdog ownership.
structure CorrelationKey where
  exchangeId : Nat
  cycleId : Nat
  deriving DecidableEq, Repr

structure InquiryTrace where
  marker : CorrelationKey
  decision : CorrelationKey
  fold : CorrelationKey
  assistant : CorrelationKey
  assistantContentEmpty : Bool
  assistantStopReasonStop : Bool
  assistantPreemptedMarker : Bool
  interleavedPluginEntries : Nat
  preservedPluginEntries : Nat
  assistantSpliced : Bool
  deriving DecidableEq, Repr

def exactInquiryAssociation (trace : InquiryTrace) : Bool :=
  trace.marker == trace.decision &&
    trace.decision == trace.fold &&
    trace.assistant == trace.marker

def safePreemptedAssistant (trace : InquiryTrace) : Bool :=
  trace.assistantContentEmpty &&
    trace.assistantStopReasonStop &&
    trace.assistantPreemptedMarker

def eligibleForIdleSplice (trace : InquiryTrace) : Bool :=
  exactInquiryAssociation trace && safePreemptedAssistant trace

def idleSplice (trace : InquiryTrace) : InquiryTrace :=
  if eligibleForIdleSplice trace then
    { trace with
      preservedPluginEntries := trace.interleavedPluginEntries
      assistantSpliced := true }
  else
    trace

-- Correlation proofs show exact marked cleanup preserves every interleaved plugin entry and rejects mismatched or unmarked candidates.
theorem eligible_idle_splice_is_exact_and_preserves_plugins
    (trace : InquiryTrace)
    (eligible : eligibleForIdleSplice trace = true) :
    (idleSplice trace).assistantSpliced = true ∧
      (idleSplice trace).preservedPluginEntries =
        trace.interleavedPluginEntries := by
  simp [idleSplice, eligible]

theorem mismatched_marker_is_not_spliced
    (trace : InquiryTrace)
    (mismatch : trace.marker ≠ trace.decision) :
    idleSplice trace = trace := by
  have associationFalse : exactInquiryAssociation trace = false := by
    simp only [exactInquiryAssociation, Bool.and_eq_false_iff]
    left
    simp [mismatch]
  simp [idleSplice, eligibleForIdleSplice, associationFalse]

theorem mismatched_fold_is_not_spliced
    (trace : InquiryTrace)
    (mismatch : trace.decision ≠ trace.fold) :
    idleSplice trace = trace := by
  have associationFalse : exactInquiryAssociation trace = false := by
    simp only [exactInquiryAssociation, Bool.and_eq_false_iff]
    left
    right
    simp [mismatch]
  simp [idleSplice, eligibleForIdleSplice, associationFalse]

theorem unmarked_assistant_is_not_spliced
    (trace : InquiryTrace)
    (notMarked : trace.assistantPreemptedMarker = false) :
    idleSplice trace = trace := by
  have safeFalse : safePreemptedAssistant trace = false := by
    simp [safePreemptedAssistant, notMarked]
  simp [idleSplice, eligibleForIdleSplice, safeFalse]

-- Marker guarantees collect the exact-association, preservation, and fail-closed splice obligations.
structure InquiryMarkerGuarantees : Prop where
  exactCleanup : ∀ trace, eligibleForIdleSplice trace = true →
    (idleSplice trace).assistantSpliced = true
  pluginPreservation : ∀ trace, eligibleForIdleSplice trace = true →
    (idleSplice trace).preservedPluginEntries =
      trace.interleavedPluginEntries
  markerBoundary : ∀ trace, trace.marker ≠ trace.decision →
    idleSplice trace = trace
  foldBoundary : ∀ trace, trace.decision ≠ trace.fold →
    idleSplice trace = trace
  assistantMarker : ∀ trace, trace.assistantPreemptedMarker = false →
    idleSplice trace = trace

theorem inquiry_marker_is_correct : InquiryMarkerGuarantees := by
  exact {
    exactCleanup := fun trace eligible =>
      (eligible_idle_splice_is_exact_and_preserves_plugins trace eligible).1
    pluginPreservation := fun trace eligible =>
      (eligible_idle_splice_is_exact_and_preserves_plugins trace eligible).2
    markerBoundary := mismatched_marker_is_not_spliced
    foldBoundary := mismatched_fold_is_not_spliced
    assistantMarker := unmarked_assistant_is_not_spliced
  }

-- Typed continue evidence models independent type authorization, bounded reasons, durable visibility, neutral publication, and dispatch ordering.
inductive ContinueReasonType where
  | workRemains
  | verifying
  | waitAutomation
  deriving DecidableEq, Repr

structure ContinueEvidence where
  reasonType : ContinueReasonType
  reasonLength : Nat
  userDecisionMade : Bool
  auditStored : Bool
  tuiEntryStored : Bool
  hookPublished : Bool
  continuationDispatched : Bool
  deriving DecidableEq, Repr

def validContinueReason (evidence : ContinueEvidence) : Prop :=
  evidence.reasonLength > 0 ∧ evidence.reasonLength ≤ 500

def continueEvidenceOrdered (evidence : ContinueEvidence) : Prop :=
  (evidence.hookPublished = true → evidence.tuiEntryStored = true) ∧
    (evidence.continuationDispatched = true → evidence.tuiEntryStored = true)

structure ContinueGuarantees : Prop where
  accepted : ∀ evidence, validContinueReason evidence →
    evidence.userDecisionMade = false →
    evidence.auditStored = true →
    evidence.tuiEntryStored = true →
    evidence.hookPublished = true →
    evidence.continuationDispatched = true →
    continueEvidenceOrdered evidence
  persistenceFailureClosed : ∀ evidence,
    evidence.tuiEntryStored = false →
    evidence.hookPublished = false →
    evidence.continuationDispatched = false →
    continueEvidenceOrdered evidence

def protocolContinueEvidence (reasonType : ContinueReasonType) (reasonLength : Nat) : ContinueEvidence :=
  {
    reasonType
    reasonLength
    userDecisionMade := false
    auditStored := false
    tuiEntryStored := false
    hookPublished := false
    continuationDispatched := false
  }

theorem protocol_continue_makes_no_user_decision
    (reasonType : ContinueReasonType)
    (reasonLength : Nat) :
    (protocolContinueEvidence reasonType reasonLength).userDecisionMade = false := by
  rfl

theorem typed_continue_is_correct : ContinueGuarantees := by
  exact {
    accepted := by
      intro evidence validReason noUserDecision auditStored tuiStored hookPublished dispatched
      simp [continueEvidenceOrdered, tuiStored]
    persistenceFailureClosed := by
      intro evidence tuiMissing hookMissing dispatchMissing
      simp [continueEvidenceOrdered, hookMissing, dispatchMissing]
  }

-- The guarantee record gathers all whole-process obligations under abort-safe cleanup and the two explicit host-settlement assumptions.
structure TakeoverGuarantees
    (environment : EnvironmentAssumptions)
    (streamWasVisible : Bool) : Prop where
  initialization : processInvariant streamWasVisible
    (decisionState streamWasVisible)
  preservation : ∀ state, processInvariant streamWasVisible state →
    processInvariant streamWasVisible (takeoverStep environment state)
  guardDiscipline : ∀ state, phaseGuardsCompleteAndExclusive state
  immediateCleanup : takeoverPostcondition
    (takeoverStep environment (decisionState streamWasVisible))
  safety : ∀ count, processSafety
    (iterate (takeoverStep environment) count
      (decisionState streamWasVisible))
  progress : ∀ state, processInvariant streamWasVisible state →
    ¬finalState state → takeoverStep environment state ≠ state
  termination : iterate (takeoverStep environment) 3
    (decisionState streamWasVisible) = completedUserWorkState
  postcondition : outputPostcondition
    (iterate (takeoverStep environment) 3
      (decisionState streamWasVisible))

-- Top-level correctness proves the gathered obligations for either visible or not-yet-visible in-flight decision streaming; no finalized decision content survives.
theorem takeover_process_is_correct
    (environment : EnvironmentAssumptions)
    (assumptions : environmentAdmitted environment)
    (streamWasVisible : Bool) :
    TakeoverGuarantees environment streamWasVisible := by
  exact {
    initialization := initialization streamWasVisible
    preservation := takeover_step_preserves_invariant environment streamWasVisible
    guardDiscipline := phase_guards_complete_and_exclusive
    immediateCleanup := immediate_takeover_cleanup environment assumptions streamWasVisible
    safety := safety_after_every_step environment streamWasVisible
    progress := progress environment assumptions streamWasVisible
    termination := termination environment assumptions streamWasVisible
    postcondition := postcondition environment assumptions streamWasVisible
  }

theorem process_is_correct
    (environment : EnvironmentAssumptions)
    (assumptions : environmentAdmitted environment)
    (streamWasVisible : Bool) :
    TakeoverGuarantees environment streamWasVisible ∧
      InquiryMarkerGuarantees ∧
      ContinueGuarantees := by
  exact ⟨takeover_process_is_correct environment assumptions streamWasVisible,
    inquiry_marker_is_correct,
    typed_continue_is_correct⟩

-- Executable projections expose deterministic summaries of immediate cleanup and clean exactly-once completion.
def takeoverPostconditionBool (state : ProcessState) : Bool :=
  state.phase == .takeoverPending &&
    !state.hiddenPresentationRequested &&
    !state.decisionStreamVisible &&
    !state.assistantFinalDecisionStored &&
    !state.sessionDecisionContentStored &&
    !state.futureModelDecisionContent &&
    state.foldMarkerStored &&
    state.pendingUserMessage &&
    state.abortRequested &&
    state.userCycleStarted &&
    !state.operationAbortedVisible &&
    !state.watchdogUnlockedVisible &&
    state.watchdogLocked

def continueEvidenceOrderedBool (evidence : ContinueEvidence) : Bool :=
  (!evidence.hookPublished || evidence.tuiEntryStored) &&
    (!evidence.continuationDispatched || evidence.tuiEntryStored)

def outputPostconditionBool (state : ProcessState) : Bool :=
  state.phase == .complete &&
    !state.hiddenPresentationRequested &&
    !state.decisionStreamVisible &&
    !state.assistantFinalDecisionStored &&
    !state.sessionDecisionContentStored &&
    !state.futureModelDecisionContent &&
    state.foldMarkerStored &&
    !state.pendingUserMessage &&
    state.userMessageStarted &&
    state.userMessageDeliveryCount == 1 &&
    state.userCycleStarted &&
    state.userOutputVisible &&
    !state.operationAbortedVisible &&
    !state.watchdogUnlockedVisible &&
    state.watchdogLocked

end WatchdogUserTakeover

#print axioms WatchdogUserTakeover.process_is_correct

-- The executable summary demonstrates the accepted visible-stream boundary, cleanup milestones, and typed continue ordering.
def acceptedContinue : WatchdogUserTakeover.ContinueEvidence :=
  {
    reasonType := .verifying
    reasonLength := 24
    userDecisionMade := false
    auditStored := true
    tuiEntryStored := true
    hookPublished := true
    continuationDispatched := true
  }

-- The executable summary demonstrates the accepted visible-stream boundary and both proved cleanup milestones.
def main : IO Unit := do
  let environment : WatchdogUserTakeover.EnvironmentAssumptions :=
    { uninterruptibleCleanupRuns := true,
      abortedDecisionEnds := true,
      userRunSettles := true }
  let visibleDecision := WatchdogUserTakeover.decisionState true
  let takeover := WatchdogUserTakeover.takeoverStep environment visibleDecision
  let completed := WatchdogUserTakeover.iterate
    (WatchdogUserTakeover.takeoverStep environment) 3 visibleDecision
  IO.println s!"Decision stream may be visible before takeover: {visibleDecision.decisionStreamVisible}"
  IO.println s!"Takeover immediately clears decision residue: {WatchdogUserTakeover.takeoverPostconditionBool takeover}"
  IO.println s!"User work completes once with clean context: {WatchdogUserTakeover.outputPostconditionBool completed}"
  IO.println s!"Typed continue avoids user decisions and persists before dispatch: {WatchdogUserTakeover.continueEvidenceOrderedBool acceptedContinue}"
