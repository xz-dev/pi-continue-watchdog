-- Std-only component model; no TypeScript refinement, privacy or complete lifecycle/history proof.
import Std

set_option autoImplicit false

namespace UnlockReviewBoundary

-- Full ordered source facts, policy and provenance are supplied by the projector, not proved here.
structure Fact where
  sourceId : String
  role : String
  body : String
  metadata : String
  deriving DecidableEq, Repr

structure Candidate where
  reasonType : String
  reasonContent : String
  deriving DecidableEq, Repr

structure FixedState where
  projectionVersion : Nat
  rubric : String
  candidate : Candidate
  facts : List Fact
  gaps : List String
  contextHead : Option String
  compactionBoundary : Option String
  deriving DecidableEq, Repr

-- Caller-supplied projection precondition; no historical producer/UI attestation requirement.
structure Input where
  fixed : FixedState
  permittedCompleteProjection : Bool
  deriving DecidableEq, Repr

structure Request where
  fixed : FixedState
  splittableFacts : List Fact
  deriving DecidableEq, Repr

def ProjectionPrecondition (input : Input) : Prop :=
  input.permittedCompleteProjection = true

-- Preparing preserves fixed identity; fact placement and service capacity policy do not change.
def prepare (input : Input) : Request :=
  { fixed := input.fixed, splittableFacts := [] }

inductive NativeAcceptedAnswer where
  | supported | challenged | insufficient
  deriving DecidableEq, Repr

inductive ServiceStop where
  | stop | capacityError | deadline | inactivity | error | aborted | malformed
  deriving DecidableEq, Repr

inductive IncompleteReason where
  | error | aborted | malformed | unresolved | unobserved | insufficient
  deriving DecidableEq, Repr

inductive Disposition where
  | supported | challenged | incomplete (reason : IncompleteReason)
  deriving DecidableEq, Repr

-- Consumed-result abstraction: malformed fields reject; unknown optional accounting cannot authorize.
structure ServiceResult where
  stop : ServiceStop
  requiredShapeValid : Bool
  optionalAccountingAdmissible : Bool
  requiredUnresolved : Bool
  completeObservation : Bool
  acceptedAnswer : Option NativeAcceptedAnswer
  reportedAttempts : Option Nat
  deriving DecidableEq, Repr

-- Decode only native accepted observed answers, without confidence or attempt-count thresholds.
def classify (result : ServiceResult) : Disposition :=
  match result.stop with
  | .aborted => .incomplete .aborted
  | .capacityError | .deadline | .inactivity | .error => .incomplete .error
  | .malformed => .incomplete .malformed
  | .stop =>
    if !(result.requiredShapeValid && result.optionalAccountingAdmissible) then
      .incomplete .malformed
    else if result.requiredUnresolved then .incomplete .unresolved
    else if !result.completeObservation then .incomplete .unobserved
    else match result.acceptedAnswer with
      | none => .incomplete .malformed
      | some .supported => .supported
      | some .challenged => .challenged
      | some .insufficient => .incomplete .insufficient

-- Currentness governs publication; an incomplete result preserves the original decision.
inductive Effect where
  | noAction | originalUnlock | oneReconsideration
  deriving DecidableEq, Repr

def decide (current : Bool) (disposition : Disposition) : Effect :=
  if current then
    match disposition with
    | .challenged => .oneReconsideration
    | .supported | .incomplete _ => .originalUnlock
  else .noAction

inductive Phase where
  | prepared | waiting | classified (disposition : Disposition)
  | finished (disposition : Option Disposition) (effect : Effect)
  deriving DecidableEq, Repr

structure State where
  request : Request
  businessCalls : Nat
  authorizations : Nat
  current : Bool
  phase : Phase
  deriving DecidableEq, Repr

def initial (input : Input) : State :=
  { request := prepare input, businessCalls := 0, authorizations := 0, current := true, phase := .prepared }

-- Admission handles necessary content gaps locally; the empty-gap path waits on one business review.
def admission (input : Input) : State :=
  if input.fixed.gaps = [] then
    { initial input with businessCalls := 1, phase := .waiting }
  else
    { initial input with phase := .classified (.incomplete .insufficient) }

def Unfinished (phase : Phase) : Prop :=
  match phase with
  | .finished _ _ => False
  | _ => True

def Finished (phase : Phase) : Prop :=
  ∃ disposition effect, phase = .finished disposition effect

-- Call bounds count business reviews, not provider attempts. Waiting remains externally unbounded.
inductive Step (input : Input) : State → State → Prop where
  | start (permitted : ProjectionPrecondition input) (clear : input.fixed.gaps = []) :
    Step input (initial input)
      { request := prepare input, businessCalls := 1, authorizations := 0, current := true, phase := .waiting }
  | rejectGaps (necessary : input.fixed.gaps ≠ []) :
    Step input (initial input)
      { request := prepare input, businessCalls := 0, authorizations := 0, current := true,
        phase := .classified (.incomplete .insufficient) }
  | stall (request : Request) (calls : Nat) (current : Bool) :
    Step input { request, businessCalls := calls, authorizations := 0, current, phase := .waiting }
      { request, businessCalls := calls, authorizations := 0, current, phase := .waiting }
  | receive (request : Request) (calls : Nat) (current live : Bool) (result : ServiceResult) :
    Step input { request, businessCalls := calls, authorizations := 0, current, phase := .waiting }
      { request, businessCalls := calls, authorizations := 0, current := current && live,
        phase := .classified (classify result) }
  | publish (request : Request) (calls : Nat) (current live : Bool) (disposition : Disposition) :
    Step input { request, businessCalls := calls, authorizations := 0, current, phase := .classified disposition }
      { request, businessCalls := calls, authorizations := if current && live then 1 else 0, current := current && live,
        phase := .finished (some disposition) (decide (current && live) disposition) }
  | escape (state : State) (pending : Unfinished state.phase) :
    Step input state { state with current := false, phase := .finished none .noAction }
  | late (request : Request) (calls authorizations : Nat) (current : Bool)
      (disposition : Option Disposition) (effect : Effect) :
    Step input { request, businessCalls := calls, authorizations, current, phase := .finished disposition effect }
      { request, businessCalls := calls, authorizations, current, phase := .finished disposition effect }

-- Reachable traces preserve fixed facts, at-most-once authorization, and zero dispatch for necessary gaps.
inductive Reachable (input : Input) : State → Prop where
  | initial : Reachable input (initial input)
  | advance {before after : State} : Reachable input before → Step input before after →
    Reachable input after

def FixedOnce (input : Input) (state : State) : Prop :=
  state.request.fixed = input.fixed ∧ state.request.splittableFacts = []

def CallsConsistent (state : State) : Prop :=
  match state.phase with
  | .prepared => state.businessCalls = 0
  | .waiting => state.businessCalls = 1
  | .classified disposition => state.businessCalls = 1 ∨
      (state.businessCalls = 0 ∧ disposition = .incomplete .insufficient)
  | .finished _ _ => state.businessCalls ≤ 1

def NoCallsWithGaps (state : State) : Prop :=
  state.request.fixed.gaps ≠ [] → state.businessCalls = 0

def Postcondition (state : State) : Prop :=
  match state.phase with
  | .finished none effect => effect = .noAction ∧ state.current = false
  | .finished (some disposition) effect => effect = decide state.current disposition
  | _ => True

def Invariant (input : Input) (state : State) : Prop :=
  FixedOnce input state ∧ state.businessCalls ≤ 1 ∧ CallsConsistent state ∧ Postcondition state ∧
  state.authorizations ≤ 1 ∧ (Unfinished state.phase → state.authorizations = 0) ∧ NoCallsWithGaps state

-- Fixed request identity changes only when input identity changes.
theorem prepare_identity (left right : Input) :
    prepare left = prepare right ↔ left.fixed = right.fixed := by
  constructor
  · intro equality
    exact congrArg Request.fixed equality
  · intro equality
    simp [prepare, equality]

-- Challenge authorization needs a native accepted answer and complete observation, not an attempt count.
def AcceptedChallenge (result : ServiceResult) : Prop :=
  result.stop = .stop ∧ result.requiredShapeValid = true ∧
  result.optionalAccountingAdmissible = true ∧ result.requiredUnresolved = false ∧
  result.completeObservation = true ∧ result.acceptedAnswer = some .challenged

theorem challenge_requires_accepted_observation (result : ServiceResult)
    (challenged : classify result = .challenged) : AcceptedChallenge result := by
  rcases result with ⟨transportStop, shape, accounting, unresolved, observation, answer, attempts⟩
  cases answer with
  | none =>
    cases transportStop <;> cases shape <;> cases accounting <;> cases unresolved <;>
      cases observation <;> simp [classify] at challenged
  | some answer =>
    cases answer <;> cases transportStop <;> cases shape <;> cases accounting <;>
      cases unresolved <;> cases observation <;>
      simp [classify, AcceptedChallenge] at challenged ⊢

theorem optional_attempt_count_does_not_authorize (result : ServiceResult) (attempts : Option Nat) :
    classify { result with reportedAttempts := attempts } = classify result := by
  rfl

-- Initialization and every transition preserve the boundary invariant.
theorem initial_invariant (input : Input) : Invariant input (initial input) := by
  simp [Invariant, FixedOnce, CallsConsistent, Postcondition, Unfinished, NoCallsWithGaps, initial, prepare]

theorem step_preserves_invariant {input : Input} {before after : State}
    (valid : Invariant input before) (step : Step input before after) : Invariant input after := by
  cases step <;> simp_all [Invariant, FixedOnce, CallsConsistent, Postcondition, Unfinished, NoCallsWithGaps, initial, prepare]
  all_goals first
    | (split <;> simp_all)
    | (apply Classical.byContradiction; intro gaps
       rcases valid with ⟨⟨fixed, _⟩, _, calls, noCalls⟩
       have zero := noCalls (by simpa [fixed] using gaps)
       omega)

theorem reachable_invariant (input : Input) (state : State) (reachable : Reachable input state) :
    Invariant input state := by
  induction reachable with
  | initial => exact initial_invariant input
  | advance previous step induction => exact step_preserves_invariant induction step

-- Both admission branches are reachable; necessary gaps never dispatch and publish only through currentness.
theorem admission_is_step (input : Input) (permitted : ProjectionPrecondition input) :
    Step input (initial input) (admission input) := by
  by_cases clear : input.fixed.gaps = []
  · simpa [admission, clear, initial] using Step.start permitted clear
  · simpa [admission, clear, initial] using Step.rejectGaps clear

theorem gaps_are_zero_call_incomplete (input : Input) (necessary : input.fixed.gaps ≠ []) :
    (admission input).businessCalls = 0 ∧
    (admission input).phase = .classified (.incomplete .insufficient) := by
  simp [admission, necessary, initial]

theorem necessary_gaps_never_dispatch (input : Input) (state : State)
    (reachable : Reachable input state) (necessary : input.fixed.gaps ≠ []) :
    state.businessCalls = 0 := by
  have valid := reachable_invariant input state reachable
  exact valid.2.2.2.2.2.2 (by simpa [valid.1.1] using necessary)

theorem gap_admission_publication (input : Input) (necessary : input.fixed.gaps ≠ []) (live : Bool) :
    Step input (admission input)
      { request := prepare input, businessCalls := 0, authorizations := if live then 1 else 0,
        current := live, phase := .finished (some (.incomplete .insufficient))
          (decide live (.incomplete .insufficient)) } := by
  simpa [admission, necessary, initial] using
    Step.publish (input := input) (prepare input) 0 true live (.incomplete .insufficient)

-- Incomplete current results retain the original; stale publications cannot act.
theorem finished_outcome_is_currentness_guarded (input : Input) (state : State)
    (reachable : Reachable input state) (disposition : Disposition) (effect : Effect)
    (finished : state.phase = .finished (some disposition) effect) :
    effect = decide state.current disposition := by
  have invariant := reachable_invariant input state reachable
  simpa [Postcondition, finished] using invariant.2.2.2.1

theorem current_incomplete_preserves_original (reason : IncompleteReason) :
    decide true (.incomplete reason) = .originalUnlock := by rfl

theorem stale_cannot_act (disposition : Disposition) :
    decide false disposition = .noAction := by rfl

-- Once finished, repeated terminal callbacks cannot add actions or authorizations.
inductive Steps (input : Input) : State → State → Prop where
  | refl (state : State) : Steps input state state
  | next {before middle after : State} : Step input before middle → Steps input middle after →
    Steps input before after

theorem finished_step_is_inert {input : Input} {before after : State}
    (finished : Finished before.phase) (step : Step input before after) : after = before := by
  rcases finished with ⟨disposition, effect, phase⟩
  cases step <;> simp_all [initial, Unfinished]

theorem finished_trace_is_inert {input : Input} {before after : State}
    (trace : Steps input before after) : Finished before.phase → after = before := by
  induction trace with
  | refl => intro _; rfl
  | next step _ induction =>
    intro finished
    have same := finished_step_is_inert finished step
    exact (induction (by simpa [same] using finished)).trans same

-- Progress after an external terminal result is conditional, never a total external-LLM wait bound.
def TerminalProgress (input : Input) (request : Request) (calls : Nat)
    (current observedLive publishLive : Bool) (result : ServiceResult) : Prop :=
  ∃ middle final, Step input { request, businessCalls := calls, authorizations := 0, current, phase := .waiting } middle ∧
    Step input middle final ∧ middle.phase = .classified (classify result) ∧
    final.phase = .finished (some (classify result))
      (decide ((current && observedLive) && publishLive) (classify result)) ∧
    final.current = ((current && observedLive) && publishLive) ∧
    final.businessCalls = calls ∧ Finished final.phase

theorem terminal_result_conditional_progress (input : Input) (request : Request) (calls : Nat)
    (current observedLive publishLive : Bool) (result : ServiceResult) :
    TerminalProgress input request calls current observedLive publishLive result := by
  refine ⟨_, _, Step.receive request calls current observedLive result,
    Step.publish request calls (current && observedLive) publishLive (classify result),
    rfl, rfl, rfl, rfl, ?_⟩
  exact ⟨some (classify result), decide ((current && observedLive) && publishLive) (classify result), rfl⟩

theorem immediate_escape (input : Input) (state : State) (pending : Unfinished state.phase) :
    ∃ final, Step input state final ∧ Finished final.phase ∧ final.current = false ∧
      final.businessCalls = state.businessCalls := by
  exact ⟨_, Step.escape state pending, ⟨none, .noAction, rfl⟩, rfl, rfl⟩

-- Combined component correctness includes gap admission, safety, conditional progress and terminal inertness.
theorem process_is_correct (input : Input) (permitted : ProjectionPrecondition input) :
    Step input (initial input) (admission input) ∧
    (∀ state, Reachable input state → Invariant input state) ∧
    (∀ other, prepare input = prepare other ↔ input.fixed = other.fixed) ∧
    (∀ result, classify result = .challenged → AcceptedChallenge result) ∧
    (∀ request calls current observedLive publishLive result,
      TerminalProgress input request calls current observedLive publishLive result) ∧
    (∀ state, Unfinished state.phase → ∃ final, Step input state final ∧ Finished final.phase ∧
      final.current = false ∧ final.businessCalls = state.businessCalls) ∧
    (∀ before after, Steps input before after → Finished before.phase → after = before) := by
  exact ⟨admission_is_step input permitted, reachable_invariant input, prepare_identity input,
    challenge_requires_accepted_observation, terminal_result_conditional_progress input, immediate_escape input,
    fun _ _ trace finished => finished_trace_is_inert trace finished⟩

end UnlockReviewBoundary

-- Inspect trusted foundations of final declarations; no custom axioms or unchecked proofs.
#print axioms UnlockReviewBoundary.process_is_correct
#print axioms UnlockReviewBoundary.finished_outcome_is_currentness_guarded
#print axioms UnlockReviewBoundary.optional_attempt_count_does_not_authorize
#print axioms UnlockReviewBoundary.current_incomplete_preserves_original
#print axioms UnlockReviewBoundary.stale_cannot_act
#print axioms UnlockReviewBoundary.gaps_are_zero_call_incomplete
#print axioms UnlockReviewBoundary.necessary_gaps_never_dispatch
#print axioms UnlockReviewBoundary.gap_admission_publication

-- Deterministic stdout illustrates consumed failures and zero-call necessary-gap admission.
def main : IO Unit := do
  let overflow : UnlockReviewBoundary.ServiceResult :=
    { stop := .capacityError, requiredShapeValid := false, optionalAccountingAdmissible := true,
      requiredUnresolved := false, completeObservation := false, acceptedAnswer := none,
      reportedAttempts := some 0 }
  let unobserved : UnlockReviewBoundary.ServiceResult :=
    { overflow with stop := .stop, requiredShapeValid := true, acceptedAnswer := some .challenged }
  IO.println s!"Capacity result: {repr (UnlockReviewBoundary.classify overflow)}"
  IO.println s!"Missing observation: {repr (UnlockReviewBoundary.classify unobserved)}"
  IO.println s!"Current incomplete: {repr (UnlockReviewBoundary.decide true (.incomplete .error))}; stale: {repr (UnlockReviewBoundary.decide false .supported)}"
  let withGap : UnlockReviewBoundary.Input :=
    { fixed :=
        { projectionVersion := 3
          rubric := "fixed policy"
          candidate := { reasonType := "JOB_DONE", reasonContent := "reported done" }
          facts := []
          gaps := ["unsupported-content"]
          contextHead := none
          compactionBoundary := none }
      permittedCompleteProjection := true }
  IO.println s!"Necessary gap: calls={(UnlockReviewBoundary.admission withGap).businessCalls}, phase={repr (UnlockReviewBoundary.admission withGap).phase}"
  IO.println "Proved: fixed facts retained once; at most one business review; necessary gaps dispatch zero calls; accepted observed challenge only; current-original incomplete fallback; stale inert; progress conditional on terminal service result, not a total external wait bound."
