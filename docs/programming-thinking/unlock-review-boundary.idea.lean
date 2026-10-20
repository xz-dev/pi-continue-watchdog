-- Std-only process model; host/provider observations are inputs, not implementation-refinement proofs.
import Std

set_option autoImplicit false

namespace UnlockReviewBoundary

-- Ordered parent facts keep source roles and provenance; candidates are normalized file claims, not evidence.
structure Fact where
  sourceId : String
  role : String
  body : String
  metadata : String
  deriving DecidableEq, Repr

inductive Action where
  | continueWork | unlock | waitCallback
  deriving DecidableEq, Repr

structure Candidate where
  action : Action
  reasonType : String
  reasonContent : String
  deriving DecidableEq, Repr

structure ParentMacro where
  projectionVersion : Nat
  rubric : String
  facts : List Fact
  gaps : List String
  parentSession : String
  contextHead : Option String
  compactionBoundary : Option String
  permitted : Bool
  deriving DecidableEq, Repr

-- One captured owner fixes child/model/source identity. Host observations attest fences, including permitted owned audit descendants, rather than proving host behavior.
structure Ownership where
  child : String
  parentSession : String
  claim : Nat
  cycle : Nat
  sourceLeaf : String
  externalGeneration : Nat
  selectedModel : String
  thinking : String
  deriving DecidableEq, Repr

structure CurrentnessObservation where
  sameOwner : Bool
  sameCycle : Bool
  sourceAncestryCurrent : Bool
  sameSessionModelThinking : Bool
  sameExternalGeneration : Bool
  aggregateIdle : Bool
  notCancelled : Bool
  deriving DecidableEq, Repr

def current (observation : CurrentnessObservation) : Bool :=
  observation.sameOwner && observation.sameCycle && observation.sourceAncestryCurrent &&
  observation.sameSessionModelThinking && observation.sameExternalGeneration &&
  observation.aggregateIdle && observation.notCancelled

-- Service results distinguish accepted final answers from malformed, errored and aborted results.
-- Version two removed transport-observation completeness and unresolved tracking:
-- acceptance is the strict final-answer contract alone.
inductive NativeAcceptedAnswer where
  | supported | challenged | insufficient
  deriving DecidableEq, Repr

inductive ServiceStop where
  | stop | capacityError | deadline | inactivity | error | aborted | malformed
  deriving DecidableEq, Repr

inductive IncompleteReason where
  | error | aborted | malformed | insufficient
  deriving DecidableEq, Repr

inductive Disposition where
  | supported | challenged | incomplete (reason : IncompleteReason)
  deriving DecidableEq, Repr

structure ServiceResult where
  stop : ServiceStop
  requiredShapeValid : Bool
  requiredDropped : Bool
  acceptedAnswer : Option NativeAcceptedAnswer
  deriving DecidableEq, Repr

def classify (result : ServiceResult) : Disposition :=
  match result.stop with
  | .aborted => .incomplete .aborted
  | .capacityError | .deadline | .inactivity | .error => .incomplete .error
  | .malformed => .incomplete .malformed
  | .stop =>
    if !result.requiredShapeValid then
      .incomplete .malformed
    else if result.requiredDropped then .incomplete .insufficient
    else match result.acceptedAnswer with
      | none => .incomplete .malformed
      | some .supported => .supported
      | some .challenged => .challenged
      | some .insufficient => .incomplete .insufficient

-- Review sees only captured parent evidence and the initial candidate claim, with exact ownership association. Unavailable, inadmissible or foreign-parent snapshots fall back locally.
structure ReviewRequest where
  owner : Ownership
  frozenParent : ParentMacro
  candidateClaim : Candidate
  deriving DecidableEq, Repr

inductive ReviewObservation where
  | unavailable
  | waiting
  | settled (result : ServiceResult)
  deriving DecidableEq, Repr

structure ReviewRun where
  request : Option ReviewRequest
  businessCalls : Nat
  disposition : Option Disposition
  deriving DecidableEq, Repr

def review (owner : Ownership) (macroSnapshot : Option ParentMacro) (candidate : Candidate)
    (observation : ReviewObservation) : ReviewRun :=
  match macroSnapshot with
  | none => ⟨none, 0, some (.incomplete .error)⟩
  | some snapshot =>
    if !snapshot.permitted || snapshot.gaps != [] || snapshot.parentSession != owner.parentSession then
      ⟨none, 0, some (.incomplete .insufficient)⟩
    else match observation with
      | .unavailable => ⟨none, 0, some (.incomplete .error)⟩
      | .waiting => ⟨some ⟨owner, snapshot, candidate⟩, 1, none⟩
      | .settled result => ⟨some ⟨owner, snapshot, candidate⟩, 1, some (classify result)⟩

-- Each abstract attempt resets the file and authorizes one response in the same child; the provider/host must enforce this primitive and settle or quarantine writes before reuse.
-- Valid observations assume the existing file validator; waiting preserves pending state without assuming scheduler fairness or a wall-clock bound.
inductive ResponseOutcome where
  | valid (normalizedFileCandidate : Candidate)
  | invalid
  | executionError
  | cancelled
  | waiting
  deriving DecidableEq, Repr

structure AttemptObservation where
  beforeCurrent : CurrentnessObservation
  afterCurrent : CurrentnessObservation
  outcome : ResponseOutcome
  deriving DecidableEq, Repr

structure AttemptAction where
  child : String
  resetFileTo : String
  authorizedModelResponses : Nat
  deriving DecidableEq, Repr

inductive InquiryOutcome where
  | valid (candidate : Candidate)
  | formatExhausted | executionError | cancelled | pending
  deriving DecidableEq, Repr

structure InquiryRun where
  attempts : List AttemptAction
  outcome : InquiryOutcome
  deriving DecidableEq, Repr

def oneResponse (child : String) : AttemptAction := ⟨child, "{}", 1⟩

def inquire (child : String) : Nat → (Nat → AttemptObservation) → InquiryRun
  | 0, _ => ⟨[], .formatExhausted⟩
  | fuel + 1, observations =>
    let observed := observations 0
    if !current observed.beforeCurrent then ⟨[], .cancelled⟩
    else
      let outcome := if current observed.afterCurrent then observed.outcome else .cancelled
      match outcome with
      | .invalid =>
        let next := inquire child fuel (fun index => observations (index + 1))
        ⟨oneResponse child :: next.attempts, next.outcome⟩
      | .valid candidate => ⟨[oneResponse child], .valid candidate⟩
      | .executionError => ⟨[oneResponse child], .executionError⟩
      | .cancelled => ⟨[oneResponse child], .cancelled⟩
      | .waiting => ⟨[oneResponse child], .pending⟩

-- One private operation owns both three-response inquiries and its optional review; only an initial valid unlock can open review. Reconsideration has no review loop.
inductive TerminalOutcome where
  | decision (candidate : Candidate)
  | decisionFailed | executionError | cancelled
  deriving DecidableEq, Repr

def terminalOf : InquiryOutcome → Option TerminalOutcome
  | .valid candidate => some (.decision candidate)
  | .formatExhausted => some .decisionFailed
  | .executionError => some .executionError
  | .cancelled => some .cancelled
  | .pending => none

structure Operation where
  owner : Ownership
  frozenParent : Option ParentMacro
  qualifiedFullFork : Bool
  reviewEnabled : Bool
  deriving DecidableEq, Repr

structure Observations where
  initial : Nat → AttemptObservation
  replacement : Nat → AttemptObservation
  review : ReviewObservation
  afterReviewCurrent : CurrentnessObservation
  afterCleanupCurrent : CurrentnessObservation

structure PrivateRun where
  initial : InquiryRun
  review : Option ReviewRun
  reconsideration : Option InquiryRun
  terminal : Option TerminalOutcome
  deriving DecidableEq, Repr

def unlockCandidate (candidate : Candidate) : Bool :=
  match candidate.action with
  | .continueWork => false
  | .unlock | .waitCallback => true

def localRun (operation : Operation) (observations : Observations) : PrivateRun :=
  if !operation.qualifiedFullFork then
    ⟨⟨[], .executionError⟩, none, none, some .executionError⟩
  else
    let initial := inquire operation.owner.child 3 observations.initial
    match initial.outcome with
    | .valid candidate =>
      if unlockCandidate candidate && operation.reviewEnabled then
        let report := review operation.owner operation.frozenParent candidate observations.review
        if !current observations.afterReviewCurrent then
          ⟨initial, some report, none, some .cancelled⟩
        else match report.disposition with
          | none => ⟨initial, some report, none, none⟩
          | some .challenged =>
            let replacement := inquire operation.owner.child 3 observations.replacement
            ⟨initial, some report, some replacement, terminalOf replacement.outcome⟩
          | some .supported | some (.incomplete _) =>
            ⟨initial, some report, none, some (.decision candidate)⟩
      else ⟨initial, none, none, some (.decision candidate)⟩
    | other => ⟨initial, none, none, terminalOf other⟩

def run (operation : Operation) (observations : Observations) : PrivateRun :=
  let result := localRun operation observations
  if current observations.afterCleanupCurrent then result
  else { result with terminal := some .cancelled }

-- Main receives only the terminal outcome, not private attempts or intermediate candidates; origin and trace invariants constrain that handoff.
def terminalHandoff (result : PrivateRun) : Option TerminalOutcome := result.terminal

def CandidateOrigin (result : PrivateRun) (candidate : Candidate) : Prop :=
  (result.reconsideration = none ∧ result.initial.outcome = .valid candidate) ∨
  ∃ replacement, result.reconsideration = some replacement ∧ replacement.outcome = .valid candidate

def allAttempts (result : PrivateRun) : List AttemptAction :=
  result.initial.attempts ++ (result.reconsideration.map InquiryRun.attempts).getD []

def InquiryInvariant (child : String) (fuel : Nat) (result : InquiryRun) : Prop :=
  result.attempts.length ≤ fuel ∧ ∀ attempt ∈ result.attempts, attempt = oneResponse child

def RunInvariant (operation : Operation) (result : PrivateRun) : Prop :=
  InquiryInvariant operation.owner.child 3 result.initial ∧
  (∀ replacement ∈ result.reconsideration,
    InquiryInvariant operation.owner.child 3 replacement) ∧
  (∀ report ∈ result.review, report.businessCalls ≤ 1 ∧
    ∃ candidate, result.initial.outcome = .valid candidate ∧
      unlockCandidate candidate = true ∧ operation.reviewEnabled = true ∧
      ∀ request ∈ report.request, request.owner = operation.owner ∧
        some request.frozenParent = operation.frozenParent ∧ request.candidateClaim = candidate ∧
        request.frozenParent.permitted = true ∧ request.frozenParent.gaps = [] ∧
        request.frozenParent.parentSession = operation.owner.parentSession) ∧
  (result.reconsideration.isSome = true →
    ∃ report, result.review = some report ∧ report.disposition = some .challenged)

-- Parent accounting models the net state after the existing publication/rollback protocol, assuming truthful correlated receipts and currentness. Callback suspension spends the same budget but is not continuation publication.
inductive ReceiptObservation where
  | confirmed | absent | unknown | busyBeforeStart
  deriving DecidableEq, Repr

inductive Effect where
  | continueMain | unlock | suspendCallback
  deriving DecidableEq, Repr

structure ParentState where
  current : Bool
  terminalApplied : Bool
  budgetUsed : Nat
  budgetLimit : Nat
  callbackSuspended : Bool
  locked : Bool
  effect : Option Effect
  deriving DecidableEq, Repr

def accept (state : ParentState) (terminal : Option TerminalOutcome)
    (receipt : ReceiptObservation) : ParentState :=
  if !state.current || !state.locked || state.terminalApplied then state
  else match terminal with
    | some (.decision candidate) =>
      match candidate.action with
      | .continueWork =>
        if receipt == .confirmed && state.budgetUsed < state.budgetLimit then
          { state with
            terminalApplied := true
            budgetUsed := state.budgetUsed + 1
            effect := some .continueMain }
        else state
      | .waitCallback =>
        if state.budgetUsed < state.budgetLimit then
          { state with
            terminalApplied := true
            budgetUsed := state.budgetUsed + 1
            callbackSuspended := true
            effect := some .suspendCallback }
        else state
      | .unlock =>
        { state with terminalApplied := true, locked := false, effect := some .unlock }
    | _ => state

-- Apply only the terminal handoff; cancellation revokes authority, optional audits are non-gating, and recovery restores history without live resources.
def applyTerminal (state : ParentState) (result : PrivateRun)
    (receipt : ReceiptObservation) : ParentState := accept state (terminalHandoff result) receipt

def cancel (state : ParentState) : ParentState := { state with current := false }

def audit (_persisted : Bool) (state : ParentState) : ParentState := state

structure HistoryRecovery where
  history : List Disposition
  parent : ParentState
  activeChild : Option Ownership
  temporaryFileAuthority : Bool
  pendingResult : Option TerminalOutcome
  deriving DecidableEq, Repr

def recoverHistory (history : List Disposition) : HistoryRecovery :=
  ⟨history, ⟨false, false, 0, 0, false, false, none⟩, none, false, none⟩

def mainModelContextAfter (_result : PrivateRun) (parentContext : List Fact) : List Fact :=
  parentContext

-- Accepted challenges, inquiry preservation and frozen review requests establish local safety independently of LLM judgment quality.
def AcceptedChallenge (result : ServiceResult) : Prop :=
  result.stop = .stop ∧ result.requiredShapeValid = true ∧
  result.requiredDropped = false ∧ result.acceptedAnswer = some .challenged

theorem challenge_requires_valid_final_answer (result : ServiceResult)
    (challenged : classify result = .challenged) : AcceptedChallenge result := by
  rcases result with ⟨transportStop, shape, dropped, answer⟩
  cases answer with
  | none =>
    cases transportStop <;> cases shape <;> cases dropped <;> simp [classify] at challenged
  | some answer =>
    cases answer <;> cases transportStop <;> cases shape <;> cases dropped <;>
      simp [classify, AcceptedChallenge] at challenged ⊢

theorem inquiry_invariant (child : String) (fuel : Nat) (observations : Nat → AttemptObservation) :
    InquiryInvariant child fuel (inquire child fuel observations) := by
  induction fuel generalizing observations with
  | zero => simp [inquire, InquiryInvariant]
  | succ fuel induction =>
    have smaller := induction (fun index => observations (index + 1))
    simp only [inquire]
    split
    · simp [InquiryInvariant]
    · split <;> simp_all [InquiryInvariant, List.mem_cons]
      omega

theorem review_bound_and_frozen (owner : Ownership) (snapshot : Option ParentMacro) (candidate : Candidate)
    (observed : ReviewObservation) :
    (review owner snapshot candidate observed).businessCalls ≤ 1 ∧
    ∀ request ∈ (review owner snapshot candidate observed).request,
      request.owner = owner ∧ some request.frozenParent = snapshot ∧ request.candidateClaim = candidate ∧
      request.frozenParent.permitted = true ∧ request.frozenParent.gaps = [] ∧
      request.frozenParent.parentSession = owner.parentSession := by
  cases snapshot with
  | none => simp [review]
  | some snapshot =>
    simp only [review]
    split
    · simp
    · cases observed <;> simp_all

theorem local_run_invariant (operation : Operation) (observations : Observations) :
    RunInvariant operation (localRun operation observations) := by
  have first := inquiry_invariant operation.owner.child 3 observations.initial
  have second := inquiry_invariant operation.owner.child 3 observations.replacement
  simp only [localRun]
  split
  · simp [RunInvariant, InquiryInvariant]
  · split
    · rename_i candidate valid
      split
      · rename_i eligible
        have both : unlockCandidate candidate = true ∧ operation.reviewEnabled = true := by
          simpa using eligible
        have unlock := both.1
        have report := review_bound_and_frozen operation.owner operation.frozenParent candidate observations.review
        have reportValid : (review operation.owner operation.frozenParent candidate observations.review).businessCalls ≤ 1 ∧
            ∃ claim, (inquire operation.owner.child 3 observations.initial).outcome = .valid claim ∧
              unlockCandidate claim = true ∧ operation.reviewEnabled = true ∧
              ∀ request ∈ (review operation.owner operation.frozenParent candidate observations.review).request,
                request.owner = operation.owner ∧
                some request.frozenParent = operation.frozenParent ∧ request.candidateClaim = claim ∧
                request.frozenParent.permitted = true ∧ request.frozenParent.gaps = [] ∧
                request.frozenParent.parentSession = operation.owner.parentSession :=
          ⟨report.1, candidate, valid, unlock, both.2, report.2⟩
        split
        · simpa [RunInvariant] using And.intro first reportValid
        · split <;> simp_all [RunInvariant]
      · simpa [RunInvariant] using first
    · simpa [RunInvariant] using first

theorem run_invariant (operation : Operation) (observations : Observations) :
    RunInvariant operation (run operation observations) := by
  have valid := local_run_invariant operation observations
  unfold run
  split <;> exact valid

theorem at_most_six_same_child_responses (operation : Operation) (observations : Observations) :
    (allAttempts (run operation observations)).length ≤ 6 ∧
    ∀ attempt ∈ allAttempts (run operation observations),
      attempt.child = operation.owner.child ∧ attempt.resetFileTo = "{}" ∧
      attempt.authorizedModelResponses = 1 := by
  have valid := run_invariant operation observations
  have firstBound := valid.1.1
  rcases resultEq : (run operation observations).reconsideration with _ | replacement
  · simp only [allAttempts, resultEq, Option.map_none, Option.getD_none, List.append_nil]
    constructor
    · omega
    · intro attempt present
      have same := valid.1.2 attempt present
      simp [same, oneResponse]
  · have second := valid.2.1 replacement (by simp [resultEq])
    have secondBound := second.1
    simp only [allAttempts, resultEq, Option.map_some, Option.getD_some, List.length_append]
    constructor
    · omega
    · intro attempt present
      rcases List.mem_append.mp present with first | later
      · simp [valid.1.2 attempt first, oneResponse]
      · simp [second.2 attempt later, oneResponse]

theorem stale_cleanup_cannot_return_candidate (operation : Operation) (observations : Observations)
    (stale : current observations.afterCleanupCurrent = false) :
    (run operation observations).terminal = some .cancelled := by simp [run, stale]

theorem stale_parent_cannot_act (state : ParentState) (terminal : Option TerminalOutcome)
    (receipt : ReceiptObservation) (stale : state.current = false) :
    accept state terminal receipt = state := by simp [accept, stale]

theorem terminal_callback_is_inert (state : ParentState) (terminal : Option TerminalOutcome)
    (receipt : ReceiptObservation) (applied : state.terminalApplied = true) :
    accept state terminal receipt = state := by simp [accept, applied]

theorem no_receipt_no_continue_charge (state : ParentState) (candidate : Candidate)
    (receipt : ReceiptObservation) (continuation : candidate.action = .continueWork)
    (unconfirmed : receipt ≠ .confirmed) :
    accept state (some (.decision candidate)) receipt = state := by
  simp [accept, continuation, unconfirmed]

theorem nondecision_has_no_effect (state : ParentState) (outcome : InquiryOutcome)
    (notValid : ∀ candidate, outcome ≠ .valid candidate) (receipt : ReceiptObservation) :
    accept state (terminalOf outcome) receipt = state := by
  cases outcome <;> simp_all [terminalOf, accept]

theorem final_shared_budget_bound (state : ParentState) (terminal : Option TerminalOutcome)
    (receipt : ReceiptObservation) :
    (accept state terminal receipt).budgetUsed ≤ state.budgetUsed + 1 := by
  simp only [accept]
  repeat' split
  all_goals simp_all <;> omega

theorem parent_context_isolated (result : PrivateRun) (parentContext : List Fact) :
    mainModelContextAfter result parentContext = parentContext := by rfl

theorem no_authority_from_audit_or_recovery (state : ParentState) (persisted : Bool)
    (history : List Disposition) :
    audit persisted state = state ∧ (recoverHistory history).history = history ∧
    (recoverHistory history).parent.current = false ∧
    (recoverHistory history).parent.locked = false ∧
    (recoverHistory history).parent.effect = none ∧
    (recoverHistory history).activeChild = none ∧
    (recoverHistory history).temporaryFileAuthority = false ∧
    (recoverHistory history).pendingResult = none := by simp [audit, recoverHistory]

-- Conditional progress assumes the scheduler/provider/service supply settled observations; absent settlement remains pending. No real provider termination or hardware behavior is proved.
def ResponsesSettle (observations : Nat → AttemptObservation) : Prop :=
  ∀ index, (observations index).outcome ≠ .waiting

def ExternalSettlements (observations : Observations) : Prop :=
  ResponsesSettle observations.initial ∧ ResponsesSettle observations.replacement ∧
    observations.review ≠ .waiting

theorem inquiry_conditional_termination (child : String) (fuel : Nat)
    (observations : Nat → AttemptObservation) (settled : ResponsesSettle observations) :
    (inquire child fuel observations).outcome ≠ .pending := by
  induction fuel generalizing observations with
  | zero => simp [inquire]
  | succ fuel induction =>
    have later : ResponsesSettle (fun index => observations (index + 1)) :=
      fun index => settled (index + 1)
    have next := induction (fun index => observations (index + 1)) later
    have own := settled 0
    by_cases before : current (observations 0).beforeCurrent = true
    · by_cases after : current (observations 0).afterCurrent = true
      · cases response : (observations 0).outcome <;> simp_all [inquire]
      · simp [inquire, before, after]
    · simp [inquire, before]

theorem review_conditional_termination (owner : Ownership) (snapshot : Option ParentMacro) (candidate : Candidate)
    (observation : ReviewObservation) (settled : observation ≠ .waiting) :
    (review owner snapshot candidate observation).disposition ≠ none := by
  cases snapshot with
  | none => simp [review]
  | some snapshot =>
    simp only [review]
    split
    · simp
    · cases observation <;> simp_all

theorem terminal_of_none_iff (outcome : InquiryOutcome) :
    terminalOf outcome ≠ none ↔ outcome ≠ .pending := by
  cases outcome <;> simp [terminalOf]

theorem run_conditional_termination (operation : Operation) (observations : Observations)
    (settled : ExternalSettlements observations) :
    (run operation observations).terminal ≠ none := by
  have first := inquiry_conditional_termination operation.owner.child 3 observations.initial settled.1
  have second := inquiry_conditional_termination operation.owner.child 3 observations.replacement settled.2.1
  simp only [run]
  split
  · simp only [localRun]
    split
    · simp
    · split
      · rename_i candidate valid
        have report := review_conditional_termination operation.owner operation.frozenParent candidate observations.review settled.2.2
        split
        · split
          · simp
          · split <;> simp_all [terminal_of_none_iff]
        · simp
      · change terminalOf (inquire operation.owner.child 3 observations.initial).outcome ≠ none
        exact (terminal_of_none_iff _).2 first
  · simp

-- Fallback retains only a still-current original; final callback accounting and repeated acceptance cannot add a second effect.
theorem incomplete_preserves_current_original (operation : Operation) (observations : Observations)
    (candidate : Candidate) (reason : IncompleteReason)
    (qualified : operation.qualifiedFullFork = true)
    (initialValid : (inquire operation.owner.child 3 observations.initial).outcome = .valid candidate)
    (eligible : unlockCandidate candidate = true) (enabled : operation.reviewEnabled = true)
    (incomplete : (review operation.owner operation.frozenParent candidate observations.review).disposition =
      some (.incomplete reason))
    (reviewCurrent : current observations.afterReviewCurrent = true)
    (cleanupCurrent : current observations.afterCleanupCurrent = true) :
    (run operation observations).terminal = some (.decision candidate) ∧
    (run operation observations).reconsideration = none := by
  simp [run, localRun, qualified, initialValid, eligible, enabled, incomplete, reviewCurrent, cleanupCurrent]

theorem callback_final_effect (state : ParentState) (candidate : Candidate) (receipt : ReceiptObservation)
    (live : state.current = true) (locked : state.locked = true)
    (fresh : state.terminalApplied = false) (budget : state.budgetUsed < state.budgetLimit)
    (callback : candidate.action = .waitCallback) :
    (accept state (some (.decision candidate)) receipt).budgetUsed = state.budgetUsed + 1 ∧
    (accept state (some (.decision candidate)) receipt).callbackSuspended = true ∧
    (accept state (some (.decision candidate)) receipt).locked = true ∧
    (accept state (some (.decision candidate)) receipt).terminalApplied = true := by
  simp [accept, live, locked, fresh, budget, callback]

theorem cancelled_parent_stays_inert (state : ParentState) (terminal : Option TerminalOutcome)
    (receipt : ReceiptObservation) : accept (cancel state) terminal receipt = cancel state := by
  simp [cancel, accept]

theorem acceptance_idempotent (state : ParentState) (terminal : Option TerminalOutcome)
    (receipt : ReceiptObservation) :
    accept (accept state terminal receipt) terminal receipt = accept state terminal receipt := by
  simp only [accept]
  repeat' split
  all_goals simp_all <;> omega

-- Fence completeness, candidate provenance and review guards prevent stale or superseded claims from becoming terminal authority.
theorem current_requires_every_fence (observation : CurrentnessObservation)
    (live : current observation = true) :
    observation.sameOwner = true ∧ observation.sameCycle = true ∧
    observation.sourceAncestryCurrent = true ∧ observation.sameSessionModelThinking = true ∧
    observation.sameExternalGeneration = true ∧ observation.aggregateIdle = true ∧
    observation.notCancelled = true := by
  simpa only [current, Bool.and_eq_true, and_assoc] using live

theorem terminal_of_decision_iff (outcome : InquiryOutcome) (candidate : Candidate) :
    terminalOf outcome = some (.decision candidate) ↔ outcome = .valid candidate := by
  cases outcome <;> simp [terminalOf]

theorem local_final_candidate_origin (operation : Operation) (observations : Observations)
    (candidate : Candidate)
    (accepted : (localRun operation observations).terminal = some (.decision candidate)) :
    CandidateOrigin (localRun operation observations) candidate := by
  simp only [localRun] at accepted ⊢
  split
  · simp_all
  · split
    · split
      · split
        · simp_all
        · split <;> simp_all [CandidateOrigin, terminal_of_decision_iff]
      · simp_all [CandidateOrigin]
    · simp_all [terminal_of_decision_iff]

theorem final_candidate_origin (operation : Operation) (observations : Observations)
    (candidate : Candidate)
    (accepted : terminalHandoff (run operation observations) = some (.decision candidate)) :
    CandidateOrigin (run operation observations) candidate := by
  by_cases live : current observations.afterCleanupCurrent = true
  · simp only [terminalHandoff, run, live, ite_true] at accepted ⊢
    exact local_final_candidate_origin operation observations candidate accepted
  · simp [terminalHandoff, run, live] at accepted

theorem supported_preserves_current_original (operation : Operation) (observations : Observations)
    (candidate : Candidate) (qualified : operation.qualifiedFullFork = true)
    (initialValid : (inquire operation.owner.child 3 observations.initial).outcome = .valid candidate)
    (eligible : unlockCandidate candidate = true) (enabled : operation.reviewEnabled = true)
    (supported : (review operation.owner operation.frozenParent candidate observations.review).disposition =
      some .supported)
    (reviewCurrent : current observations.afterReviewCurrent = true)
    (cleanupCurrent : current observations.afterCleanupCurrent = true) :
    (run operation observations).terminal = some (.decision candidate) ∧
    (run operation observations).reconsideration = none := by
  simp [run, localRun, qualified, initialValid, eligible, enabled, supported, reviewCurrent, cleanupCurrent]

theorem necessary_gaps_never_dispatch (owner : Ownership) (snapshot : ParentMacro)
    (candidate : Candidate) (observation : ReviewObservation) (gaps : snapshot.gaps ≠ []) :
    (review owner (some snapshot) candidate observation).businessCalls = 0 ∧
    (review owner (some snapshot) candidate observation).disposition = some (.incomplete .insufficient) := by
  simp [review, gaps]

theorem disabled_review_never_reconsiders (operation : Operation) (observations : Observations)
    (disabled : operation.reviewEnabled = false) :
    (run operation observations).review = none ∧
    (run operation observations).reconsideration = none := by
  simp only [run, localRun]
  repeat' split
  all_goals simp_all

-- Combined correctness covers finite observed workflow, bounded same-child actions, initial-only frozen review, terminal provenance, guarded effects, isolation and history-only recovery.
-- Truthful projection/validation/fence/receipt observations and enforcement of abstract response/write actions remain scope assumptions, not conclusions about final wire payloads.
theorem process_is_correct (operation : Operation) (observations : Observations) :
    RunInvariant operation (run operation observations) ∧
    ((allAttempts (run operation observations)).length ≤ 6 ∧
      ∀ attempt ∈ allAttempts (run operation observations),
        attempt.child = operation.owner.child ∧ attempt.resetFileTo = "{}" ∧
        attempt.authorizedModelResponses = 1) ∧
    (∀ result, classify result = .challenged → AcceptedChallenge result) ∧
    (∀ state terminal receipt, state.current = false → accept state terminal receipt = state) ∧
    (∀ state terminal receipt, state.terminalApplied = true → accept state terminal receipt = state) ∧
    (∀ state candidate receipt, candidate.action = .continueWork → receipt ≠ .confirmed →
      accept state (some (.decision candidate)) receipt = state) ∧
    (∀ state terminal receipt, (accept state terminal receipt).budgetUsed ≤ state.budgetUsed + 1) ∧
    (∀ parentContext, mainModelContextAfter (run operation observations) parentContext = parentContext) ∧
    (ExternalSettlements observations → (run operation observations).terminal ≠ none) ∧
    (∀ candidate, terminalHandoff (run operation observations) = some (.decision candidate) →
      CandidateOrigin (run operation observations) candidate) ∧
    (∀ state persisted history, audit persisted state = state ∧
      (recoverHistory history).history = history ∧
      (recoverHistory history).parent.current = false ∧
      (recoverHistory history).parent.locked = false ∧
      (recoverHistory history).parent.effect = none ∧
      (recoverHistory history).activeChild = none ∧
      (recoverHistory history).temporaryFileAuthority = false ∧
      (recoverHistory history).pendingResult = none) := by
  exact ⟨run_invariant operation observations, at_most_six_same_child_responses operation observations,
    challenge_requires_valid_final_answer, stale_parent_cannot_act, terminal_callback_is_inert,
    no_receipt_no_continue_charge, final_shared_budget_bound,
    parent_context_isolated (run operation observations), run_conditional_termination operation observations,
    final_candidate_origin operation observations, no_authority_from_audit_or_recovery⟩

-- Kernel-checked finite examples exercise six responses, original fallback, pending review, cancellation, exhaustion, no second review and shared callback accounting.
def demoLive : CurrentnessObservation := ⟨true, true, true, true, true, true, true⟩

def demoCandidate (action : Action) : Candidate := ⟨action, "configured-reason", "normalized claim"⟩

def demoOperation : Operation :=
  { owner := ⟨"sole-child", "parent", 7, 4, "source-leaf", 2, "provider/model", "selected"⟩
    frozenParent := some ⟨3, "review rubric", [], [], "parent", some "source-leaf", none, true⟩
    qualifiedFullFork := true
    reviewEnabled := true }

def demoResponses (action : Action) (index : Nat) : AttemptObservation :=
  ⟨demoLive, demoLive, if index < 2 then .invalid else .valid (demoCandidate action)⟩

def demoChallenge : ServiceResult :=
  ⟨.stop, true, false, some .challenged⟩

def demoObservations : Observations :=
  ⟨demoResponses .unlock, demoResponses .continueWork, .settled demoChallenge, demoLive, demoLive⟩

def demoRun : PrivateRun := run demoOperation demoObservations

def demoParent : ParentState := ⟨true, false, 2, 5, false, true, none⟩

example : (allAttempts demoRun).length = 6 ∧
    demoRun.terminal = some (.decision (demoCandidate .continueWork)) ∧
    (demoRun.review.map ReviewRun.businessCalls) = some 1 := by decide

example : (accept demoParent demoRun.terminal .confirmed).budgetUsed = 3 ∧
    (accept demoParent demoRun.terminal .absent) = demoParent ∧
    (accept demoParent demoRun.terminal .unknown) = demoParent ∧
    (accept demoParent demoRun.terminal .busyBeforeStart) = demoParent := by decide

example :
    (run demoOperation { demoObservations with review := .unavailable }).terminal =
      some (.decision (demoCandidate .unlock)) ∧
    (run demoOperation { demoObservations with review := .waiting }).terminal = none ∧
    (run demoOperation { demoObservations with
      afterReviewCurrent := { demoLive with notCancelled := false } }).terminal = some .cancelled := by decide

example : (inquire "sole-child" 3 (fun _ => ⟨demoLive, demoLive, .invalid⟩)).outcome = .formatExhausted ∧
    (inquire "sole-child" 3 (fun _ => ⟨demoLive, demoLive, .executionError⟩)).attempts.length = 1 := by decide

example :
    (run demoOperation { demoObservations with replacement := demoResponses .unlock }).terminal =
      some (.decision (demoCandidate .unlock)) ∧
    ((run demoOperation { demoObservations with replacement := demoResponses .unlock }).review.map
      ReviewRun.businessCalls) = some 1 ∧
    (run demoOperation { demoObservations with
      replacement := fun _ => ⟨demoLive, demoLive, .invalid⟩ }).terminal = some .decisionFailed := by decide

example :
    (accept demoParent (some (.decision (demoCandidate .waitCallback))) .unknown).budgetUsed = 3 ∧
    (accept demoParent (some (.decision (demoCandidate .waitCallback))) .unknown).callbackSuspended = true ∧
    (accept demoParent (some (.decision (demoCandidate .waitCallback))) .unknown).locked = true := by decide

end UnlockReviewBoundary

-- Inspect foundations of the top theorem; no project-specific assumptions are introduced as axioms.
#print axioms UnlockReviewBoundary.process_is_correct

-- Deterministic computation and stdout illustrate the bounded workflow and net receipt accounting, without filesystem or provider effects.
def main : IO Unit := do
  let result := UnlockReviewBoundary.demoRun
  IO.println s!"Challenged initial unlock: responses={(UnlockReviewBoundary.allAttempts result).length}, review calls={repr (result.review.map UnlockReviewBoundary.ReviewRun.businessCalls)}, final={repr result.terminal}"
  IO.println s!"Shared budget: confirmed={(UnlockReviewBoundary.accept UnlockReviewBoundary.demoParent result.terminal .confirmed).budgetUsed}; absent/net unchanged={(UnlockReviewBoundary.accept UnlockReviewBoundary.demoParent result.terminal .absent).budgetUsed}"
  IO.println "Proved: same child; reset {}; one abstract response per attempt; three per inquiry; at most six total; initial-only review; final-only effects; stale and repeated callbacks inert; termination conditional on external settlements."
  IO.println "Scope assumptions: truthful host currentness/projection/validation/receipt observations; enforced provider/write boundary and draining; finite observed actions, not actual I/O, LLM quality, hardware, or final wire payload correctness."
