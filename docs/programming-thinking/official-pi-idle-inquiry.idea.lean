-- Std-only executable process document; runtime, provider and filesystem actions remain observations.
import Std

set_option autoImplicit false

namespace OfficialPiIdleInquiry

-- Normalized file claims retain action-specific policy; host validation supplies trimming and configured identity.
abbrev SessionId := Nat
abbrev ResultPath := Nat

inductive Action where
  | cont
  | unlock
  deriving DecidableEq, Repr

structure Verdict where
  action : Action
  reasonType : String
  reason : String
  deriving DecidableEq, Repr

structure Policy where
  continueTypes : List String
  unlockTypes : List String
  deriving DecidableEq, Repr

def validVerdict (policy : Policy) (v : Verdict) : Bool :=
  let allowed := if v.action == .cont then policy.continueTypes else policy.unlockTypes
  allowed.contains v.reasonType && 0 < v.reason.length && v.reason.length ≤ 1000

def isCallback (v : Verdict) : Bool :=
  v.action == .unlock && v.reasonType.toUpper == "WAIT_CALLBACK"

-- Captured effective source and host observations fence owner, ancestry, model and external activity.
structure Source where
  owner : Nat
  session : SessionId
  leaf : Nat
  cycle : Nat
  lifecycle : Nat
  externalGeneration : Nat
  providerModel : String
  thinking : String
  effectiveConversation : List String
  systemState : List String
  toolDeclarations : List String
  deriving DecidableEq, Repr

structure Observation where
  owner : Nat
  session : SessionId
  cycle : Nat
  lifecycle : Nat
  externalGeneration : Nat
  providerModel : String
  thinking : String
  sourceAnchorPresent : Bool
  descendantsAreContextExcluded : Bool
  aggregateIdle : Bool
  stopped : Bool
  cancelled : Bool
  deriving DecidableEq, Repr

def scopeCurrent (source : Source) (o : Observation) : Bool :=
  source.owner == o.owner && source.session == o.session &&
    source.cycle == o.cycle && source.lifecycle == o.lifecycle &&
    source.externalGeneration == o.externalGeneration &&
    source.providerModel == o.providerModel && source.thinking == o.thinking &&
    o.sourceAnchorPresent && o.descendantsAreContextExcluded && !o.stopped && !o.cancelled

def qualified (source : Source) (o : Observation) : Bool :=
  scopeCurrent source o && o.aggregateIdle

-- Full-fork construction preserves supplied effective conversation and declarations without ambient registration.
-- The frozen pre-child source owns compaction checkpoints even when their timestamp equals the fork timestamp.
structure Fork where
  child : SessionId
  resultPath : ResultPath
  conversation : List String
  systemState : List String
  declarations : List String
  providerModel : String
  thinking : String
  ambientExtensions : Bool
  publicRegistrations : List String
  deriving DecidableEq, Repr

def fullFork (source : Source) (child : SessionId) (path : ResultPath) : Fork :=
  { child, resultPath := path, conversation := source.effectiveConversation,
    systemState := source.systemState, declarations := source.toolDeclarations,
    providerModel := source.providerModel, thinking := source.thinking,
    ambientExtensions := false, publicRegistrations := [] }

-- Attempt inputs distinguish forbidden effects, decoded files, cancellation and host/provider failures.
inductive Effect where
  | write (path : ResultPath)
  | ordinaryWork
  | shell
  | delegate
  deriving DecidableEq, Repr

inductive FileValue where
  | emptyObject
  | malformed
  | object (v : Verdict)
  deriving DecidableEq, Repr

inductive Inquiry where
  | initial
  | reconsideration
  deriving DecidableEq, Repr

inductive AttemptOutcome where
  | valid (v : Verdict)
  | invalid (diagnostic : String)
  | cancelled
  | executionError
  deriving DecidableEq, Repr

inductive WriteObservation where
  | settled
  | hostFailure
  | cancelledAfterDrain
  deriving DecidableEq, Repr

inductive AttemptBoundary where
  | cancelledBeforeStart
  | resetFailure
  | providerFailure
  | normal (effects : List Effect) (regularFile : Bool)
      (write : WriteObservation) (file : FileValue) (afterJoin : Observation)
  deriving DecidableEq, Repr

structure AttemptInput where
  beforeReset : Observation
  beforePrompt : Observation
  boundary : AttemptBoundary
  deriving DecidableEq, Repr

-- One response and its admitted write join before reading; revocation permits draining, not reuse.
inductive JoinPhase where
  | fresh
  | ready
  | generating
  | writing
  | joined
  | revokedGenerating
  | revokedWriting
  | drained
  deriving DecidableEq, Repr

inductive JoinStep : JoinPhase → JoinPhase → Prop where
  | reset : JoinStep .fresh .ready
  | requestOneResponse : JoinStep .ready .generating
  | responseWithoutWrite : JoinStep .generating .joined
  | responseAdmitsOneWrite : JoinStep .generating .writing
  | writeSettles : JoinStep .writing .joined
  | revokeGeneration : JoinStep .generating .revokedGenerating
  | revokeWrite : JoinStep .writing .revokedWriting
  | drainGeneration : JoinStep .revokedGenerating .drained
  | drainWrite : JoinStep .revokedWriting .drained

inductive JoinTrace : JoinPhase → List JoinPhase → JoinPhase → Prop where
  | nil (phase : JoinPhase) : JoinTrace phase [] phase
  | cons {start next finish : JoinPhase} {tail : List JoinPhase} :
      JoinStep start next → JoinTrace next tail finish → JoinTrace start (next :: tail) finish

def allowsRead : JoinPhase → Bool
  | .joined => true
  | _ => false

def responseRequestsIn (trace : List JoinPhase) : Nat :=
  (trace.filter (· == .generating)).length

-- Join laws bound response requests and exclude reads or fresh work after revocation.
theorem join_step_rank_decreases (a b : JoinPhase) (step : JoinStep a b) :
    (match b with
      | .fresh => 5 | .ready => 4 | .generating => 3 | .writing => 2
      | .revokedGenerating | .revokedWriting => 1 | .joined | .drained => 0) <
    (match a with
      | .fresh => 5 | .ready => 4 | .generating => 3 | .writing => 2
      | .revokedGenerating | .revokedWriting => 1 | .joined | .drained => 0) := by
  cases step <;> decide

theorem no_step_after_join_or_drain (next : JoinPhase) :
    ¬JoinStep .joined next ∧ ¬JoinStep .drained next := by
  constructor <;> intro impossible <;> cases impossible

theorem revoked_write_cannot_read_or_reset :
    allowsRead .revokedWriting = false ∧ ¬JoinStep .revokedWriting .ready ∧
    ¬JoinStep .revokedWriting .generating ∧
    (∀ next, JoinStep .revokedWriting next → next = .drained) := by
  refine ⟨rfl, ?_, ?_, ?_⟩
  · intro impossible; cases impossible
  · intro impossible; cases impossible
  · intro next step; cases step; rfl

theorem read_requires_response_write_join (phase : JoinPhase) :
    allowsRead phase = true ↔ phase = .joined := by
  cases phase <;> simp [allowsRead]

theorem join_traces_have_at_most_one_response {start finish : JoinPhase}
    {trace : List JoinPhase} (execution : JoinTrace start trace finish) :
    responseRequestsIn trace ≤ (if start = .fresh ∨ start = .ready then 1 else 0) := by
  induction execution with
  | nil phase => simp [responseRequestsIn]
  | @cons start next finish tail step rest ih =>
      cases step <;>
        simp_all [responseRequestsIn]

theorem fresh_join_trace : JoinTrace .fresh [] .fresh := .nil .fresh

theorem response_join_trace : JoinTrace .fresh [.ready, .generating, .joined] .joined :=
  .cons .reset (.cons .requestOneResponse (.cons .responseWithoutWrite (.nil _)))

theorem write_join_trace : JoinTrace .fresh [.ready, .generating, .writing, .joined] .joined :=
  .cons .reset (.cons .requestOneResponse
    (.cons .responseAdmitsOneWrite (.cons .writeSettles (.nil _))))

theorem generation_drain_trace :
    JoinTrace .fresh [.ready, .generating, .revokedGenerating, .drained] .drained :=
  .cons .reset (.cons .requestOneResponse
    (.cons .revokeGeneration (.cons .drainGeneration (.nil _))))

theorem write_drain_trace :
    JoinTrace .fresh [.ready, .generating, .writing, .revokedWriting, .drained] .drained :=
  .cons .reset (.cons .requestOneResponse (.cons .responseAdmitsOneWrite
    (.cons .revokeWrite (.cons .drainWrite (.nil _)))))

-- Attempt traces record abstract enforced actions, not actual I/O; boundary observations must be truthful.
structure AttemptLog where
  child : SessionId
  path : ResultPath
  resetValue : Option String
  requestedResponses : Nat
  completedResponses : Nat
  executedEffects : List Effect
  writesDrained : Bool
  joinPhases : List JoinPhase
  finalJoinPhase : JoinPhase
  readFile : Option FileValue
  formatCharges : Nat
  outcome : AttemptOutcome
  deriving DecidableEq, Repr

def stoppedAttempt (fork : Fork) (outcome : AttemptOutcome) : AttemptLog :=
  { child := fork.child, path := fork.resultPath, resetValue := none,
    requestedResponses := 0, completedResponses := 0, executedEffects := [],
    writesDrained := true, joinPhases := [], finalJoinPhase := .fresh,
    readFile := none, formatCharges := 0, outcome }

def requestedAttempt (fork : Fork) : AttemptLog :=
  { stoppedAttempt fork .executionError with
    resetValue := some "{}", requestedResponses := 1,
    joinPhases := [.ready, .generating, .revokedGenerating, .drained], finalJoinPhase := .drained }

def decodeFile (policy : Policy) (file : FileValue) : AttemptOutcome :=
  match file with
  | .emptyObject => .invalid "Required decision fields are missing."
  | .malformed => .invalid "Expected one complete JSON object."
  | .object v =>
      if validVerdict policy v then .valid v
      else .invalid "Decision fields do not satisfy the active policy."

def runAttempt (source : Source) (policy : Policy) (fork : Fork)
    (input : AttemptInput) : AttemptLog :=
  if !qualified source input.beforeReset || !qualified source input.beforePrompt then
    stoppedAttempt fork .cancelled
  else match input.boundary with
  | .cancelledBeforeStart => stoppedAttempt fork .cancelled
  | .resetFailure => stoppedAttempt fork .executionError
  | .providerFailure => requestedAttempt fork
  | .normal effects regular write file afterJoin =>
      let response := { requestedAttempt fork with
        completedResponses := 1, joinPhases := [.ready, .generating, .joined], finalJoinPhase := .joined }
      if !qualified source afterJoin then { response with outcome := .cancelled }
      else if effects != [.write fork.resultPath] then
        { response with
          formatCharges := 1,
          outcome := .invalid "Expected exactly one designated result-file write." }
      else if !regular then { response with outcome := .executionError }
      else
        let admitted := { response with
          executedEffects := [.write fork.resultPath],
          joinPhases := [.ready, .generating, .writing, .revokedWriting, .drained],
          finalJoinPhase := .drained }
        match write with
        | .hostFailure => { admitted with outcome := .executionError }
        | .cancelledAfterDrain => { admitted with outcome := .cancelled }
        | .settled =>
            { admitted with
              readFile := some file, formatCharges := 1,
              joinPhases := [.ready, .generating, .writing, .joined], finalJoinPhase := .joined,
              outcome := decodeFile policy file }

-- Every modeled attempt preserves exact child/path, reset, effect and joined-read bounds.
def AttemptSafe (fork : Fork) (log : AttemptLog) : Prop :=
  log.child = fork.child ∧ log.path = fork.resultPath ∧
  log.requestedResponses ≤ 1 ∧ log.completedResponses ≤ log.requestedResponses ∧
  log.formatCharges ≤ log.completedResponses ∧ log.writesDrained = true ∧
  (log.requestedResponses = 1 → log.resetValue = some "{}") ∧
  (log.executedEffects = [] ∨ log.executedEffects = [.write fork.resultPath]) ∧
  (log.readFile ≠ none → log.completedResponses = 1 ∧
    log.executedEffects = [.write fork.resultPath] ∧ log.writesDrained = true ∧
    allowsRead log.finalJoinPhase = true) ∧
  JoinTrace .fresh log.joinPhases log.finalJoinPhase

theorem attempt_is_safe (source : Source) (policy : Policy) (fork : Fork)
    (input : AttemptInput) : AttemptSafe fork (runAttempt source policy fork input) := by
  rcases input with ⟨beforeReset, beforePrompt, boundary⟩
  simp only [runAttempt]
  split
  · simp [stoppedAttempt, AttemptSafe, fresh_join_trace]
  · cases boundary with
    | cancelledBeforeStart => simp [stoppedAttempt, AttemptSafe, fresh_join_trace]
    | resetFailure => simp [stoppedAttempt, AttemptSafe, fresh_join_trace]
    | providerFailure =>
        simp [requestedAttempt, stoppedAttempt, AttemptSafe, generation_drain_trace]
    | normal effects regular write file afterJoin =>
        simp only
        split
        · simp [AttemptSafe, requestedAttempt, stoppedAttempt, response_join_trace]
        · split
          · simp [AttemptSafe, requestedAttempt, stoppedAttempt, response_join_trace]
          · split
            · simp [AttemptSafe, requestedAttempt, stoppedAttempt, response_join_trace]
            · cases write <;>
                simp [AttemptSafe, requestedAttempt, stoppedAttempt, write_join_trace,
                  write_drain_trace, allowsRead]

theorem stale_attempt_cannot_supply_result (source : Source) (policy : Policy)
    (fork : Fork) (effects : List Effect) (regular : Bool) (write : WriteObservation)
    (file : FileValue) (o : Observation) (stale : qualified source o = false) :
    let log := runAttempt source policy fork ⟨o, o, .normal effects regular write file o⟩
    log.outcome = .cancelled ∧ log.readFile = none ∧ log.formatCharges = 0 := by
  simp [runAttempt, stale, stoppedAttempt]

theorem forbidden_batch_has_no_effects (source : Source) (policy : Policy)
    (fork : Fork) (effects : List Effect) (regular : Bool) (write : WriteObservation)
    (file : FileValue) (o : Observation)
    (forbidden : effects ≠ [.write fork.resultPath]) :
    (runAttempt source policy fork ⟨o, o, .normal effects regular write file o⟩).executedEffects = [] := by
  simp [runAttempt, forbidden, requestedAttempt, stoppedAttempt]
  split <;> rfl

theorem decode_accepts_only_valid_file (policy : Policy) (file : FileValue) (v : Verdict)
    (accepted : decodeFile policy file = .valid v) :
    file = .object v ∧ validVerdict policy v = true := by
  cases file with
  | emptyObject => simp [decodeFile] at accepted
  | malformed => simp [decodeFile] at accepted
  | object candidate =>
      simp only [decodeFile] at accepted
      split at accepted
      · cases accepted; exact ⟨rfl, by assumption⟩
      · contradiction

theorem attempt_accepts_only_joined_valid_file (source : Source) (policy : Policy)
    (fork : Fork) (input : AttemptInput) (v : Verdict)
    (accepted : (runAttempt source policy fork input).outcome = .valid v) :
    (runAttempt source policy fork input).readFile = some (.object v) ∧
    validVerdict policy v = true := by
  rcases input with ⟨beforeReset, beforePrompt, boundary⟩
  simp only [runAttempt] at accepted ⊢
  split at accepted
  · simp [stoppedAttempt] at accepted
  · rename_i current
    simp only [ite_eq_right current]
    cases boundary with
    | cancelledBeforeStart => simp [stoppedAttempt] at accepted
    | resetFailure => simp [stoppedAttempt] at accepted
    | providerFailure => simp [requestedAttempt, stoppedAttempt] at accepted
    | normal effects regular write file afterJoin =>
        simp only at accepted ⊢
        split at accepted
        · simp at accepted
        · rename_i afterCurrent
          simp only [ite_eq_right afterCurrent]
          split at accepted
          · simp at accepted
          · rename_i allowed
            simp only [ite_eq_right allowed]
            split at accepted
            · simp at accepted
            · rename_i regularFile
              simp only [ite_eq_right regularFile]
              cases write with
              | hostFailure => simp at accepted
              | cancelledAfterDrain => simp at accepted
              | settled =>
                  obtain ⟨fileEquals, valid⟩ := decode_accepts_only_valid_file policy file v accepted
                  exact ⟨congrArg some fileEquals, valid⟩

-- Bounded recursion appends concrete correction diagnostics in the same fork and stops on non-format outcomes.
structure InquiryResult where
  outcome : AttemptOutcome
  attempts : List AttemptLog
  corrections : List String
  deriving DecidableEq, Repr

def runInquiry (source : Source) (policy : Policy) (fork : Fork)
    (inputs : Nat → AttemptInput) : Nat → Nat → InquiryResult
  | 0, _ => ⟨.invalid "Three responses exhausted.", [], []⟩
  | fuel + 1, index =>
      let attempt := runAttempt source policy fork (inputs index)
      match attempt.outcome with
      | .invalid error =>
          match fuel with
          | 0 => ⟨attempt.outcome, [attempt], []⟩
          | rest + 1 =>
              let next := runInquiry source policy fork inputs (rest + 1) (index + 1)
              { next with
                attempts := attempt :: next.attempts,
                corrections := error :: next.corrections }
      | outcome => ⟨outcome, [attempt], []⟩

def responseRequests (attempts : List AttemptLog) : Nat :=
  (attempts.map (·.requestedResponses)).sum

def formatCharges (attempts : List AttemptLog) : Nat :=
  (attempts.map (·.formatCharges)).sum

def InquirySafe (fork : Fork) (fuel : Nat) (result : InquiryResult) : Prop :=
  (∀ log ∈ result.attempts, AttemptSafe fork log) ∧
  result.attempts.length ≤ fuel ∧ responseRequests result.attempts ≤ fuel ∧
  formatCharges result.attempts ≤ responseRequests result.attempts ∧
  result.corrections.length < fuel + 1

-- Inquiry laws preserve validation and prove exact exhaustion for observed invalid responses.
theorem inquiry_is_safe (source : Source) (policy : Policy) (fork : Fork)
    (inputs : Nat → AttemptInput) (fuel index : Nat) :
    InquirySafe fork fuel (runInquiry source policy fork inputs fuel index) := by
  induction fuel generalizing index with
  | zero => simp [InquirySafe, runInquiry, responseRequests, formatCharges]
  | succ fuel ih =>
      have safe := attempt_is_safe source policy fork (inputs index)
      have one := safe.2.2.1
      have completed := safe.2.2.2.1
      have charges := Nat.le_trans safe.2.2.2.2.1 completed
      cases outcome : (runAttempt source policy fork (inputs index)).outcome with
      | valid v =>
          simp [runInquiry, outcome, InquirySafe, responseRequests, formatCharges, safe, charges]
          omega
      | cancelled =>
          simp [runInquiry, outcome, InquirySafe, responseRequests, formatCharges, safe, charges]
          omega
      | executionError =>
          simp [runInquiry, outcome, InquirySafe, responseRequests, formatCharges, safe, charges]
          omega
      | invalid error =>
          cases fuel with
          | zero =>
              simp [runInquiry, outcome, InquirySafe, responseRequests, formatCharges]
              exact ⟨safe, one, charges⟩
          | succ rest =>
              obtain ⟨allSafe, lengthBound, requestBound, chargeBound, correctionBound⟩ :=
                ih (index + 1)
              rw [runInquiry]
              simp only [outcome, InquirySafe, List.mem_cons,
                List.length_cons, responseRequests, formatCharges, List.map_cons,
                List.sum_cons]
              unfold responseRequests at requestBound chargeBound
              unfold formatCharges at chargeBound
              refine ⟨?_, by omega, by omega, by omega, by omega⟩
              intro log member
              rcases member with same | later
              · subst log; exact safe
              · exact allSafe log later

theorem inquiry_accepts_only_valid_candidate (source : Source) (policy : Policy)
    (fork : Fork) (inputs : Nat → AttemptInput) (fuel index : Nat) (v : Verdict)
    (accepted : (runInquiry source policy fork inputs fuel index).outcome = .valid v) :
    validVerdict policy v = true := by
  induction fuel generalizing index with
  | zero => simp [runInquiry] at accepted
  | succ fuel ih =>
      rw [runInquiry] at accepted
      cases outcome : (runAttempt source policy fork (inputs index)).outcome with
      | valid candidate =>
          simp only [outcome] at accepted
          cases accepted
          exact (attempt_accepts_only_joined_valid_file source policy fork (inputs index) v outcome).2
      | cancelled => simp [outcome] at accepted
      | executionError => simp [outcome] at accepted
      | invalid error =>
          cases fuel with
          | zero => simp [outcome] at accepted
          | succ rest =>
              simp only [outcome] at accepted
              exact ih (index + 1) accepted

def invalidOutcome (o : AttemptOutcome) : Bool :=
  match o with | .invalid _ => true | _ => false

theorem invalid_responses_exhaust_exact_allowance (source : Source) (policy : Policy)
    (fork : Fork) (inputs : Nat → AttemptInput)
    (invalid : ∀ index, ∃ diagnostic,
      (runAttempt source policy fork (inputs index)).outcome = .invalid diagnostic ∧
      (runAttempt source policy fork (inputs index)).requestedResponses = 1 ∧
      (runAttempt source policy fork (inputs index)).formatCharges = 1)
    (fuel index : Nat) :
    let r := runInquiry source policy fork inputs fuel index
    invalidOutcome r.outcome = true ∧ responseRequests r.attempts = fuel ∧
    formatCharges r.attempts = fuel ∧ r.corrections.length = fuel - 1 := by
  induction fuel generalizing index with
  | zero => simp [runInquiry, invalidOutcome, responseRequests, formatCharges]
  | succ fuel ih =>
      obtain ⟨diagnostic, outcome, requests, charges⟩ := invalid index
      rw [runInquiry]
      cases fuel with
      | zero => simp [outcome, invalidOutcome, responseRequests, formatCharges, requests, charges]
      | succ rest =>
          have next := ih (index + 1)
          simp only [outcome, responseRequests, formatCharges, List.map_cons, List.sum_cons,
            List.length_cons, requests, charges]
          dsimp only at next
          unfold responseRequests formatCharges at next
          exact ⟨next.1, by omega, by omega, by omega⟩

-- One initial unlock may receive review; one challenge consumes a separate three-response inquiry.
inductive Review where
  | disabled
  | supported
  | incomplete
  | challenged
  deriving DecidableEq, Repr

inductive Terminal where
  | decision (v : Verdict)
  | decisionFailed
  | cancelled
  | executionError
  deriving DecidableEq, Repr

def terminalOf : AttemptOutcome → Terminal
  | .valid v => .decision v
  | .invalid _ => .decisionFailed
  | .cancelled => .cancelled
  | .executionError => .executionError

structure PrivateResult where
  terminal : Terminal
  attempts : List AttemptLog
  corrections : List String
  reviewCalls : Nat
  reconsiderations : Nat
  mainConversation : List String
  child : SessionId
  cleanupDrained : Bool
  revokedFileAuthority : Bool
  cancelledSessions : List SessionId
  selectedSession : SessionId
  handoffs : List Terminal
  deriving DecidableEq, Repr

-- Terminal handoff retains main context and selection; cleanup/currentness observations gate candidate release.
def finish (source : Source) (fork : Fork) (result : InquiryResult)
    (reviews reconsiderations : Nat) (afterCleanup : Observation) : PrivateResult :=
  let terminal := if qualified source afterCleanup then terminalOf result.outcome else .cancelled
  { terminal, attempts := result.attempts, corrections := result.corrections,
    reviewCalls := reviews, reconsiderations, mainConversation := source.effectiveConversation,
    child := fork.child, cleanupDrained := true, revokedFileAuthority := true,
    cancelledSessions := [fork.child], selectedSession := source.session, handoffs := [terminal] }

def executePrivate (source : Source) (policy : Policy) (fork : Fork)
    (initial replacement : Nat → AttemptInput) (review : Review)
    (afterReview afterCleanup : Observation) : PrivateResult :=
  let first := runInquiry source policy fork initial 3 0
  match first.outcome with
  | .valid v =>
      if v.action == .unlock && review != .disabled then
        if !qualified source afterReview then
          finish source fork { first with outcome := .cancelled } 1 0 afterCleanup
        else if review == .challenged then
          let second := runInquiry source policy fork replacement 3 0
          finish source fork
            { second with
              attempts := first.attempts ++ second.attempts,
              corrections := first.corrections ++ second.corrections } 1 1 afterCleanup
        else finish source fork first 1 0 afterCleanup
      else finish source fork first 0 0 afterCleanup
  | _ => finish source fork first 0 0 afterCleanup

-- Combined private traces bound six responses, one review and one reconsideration, with one terminal handoff.
def PrivateSafe (source : Source) (fork : Fork) (r : PrivateResult) : Prop :=
  (∀ log ∈ r.attempts, AttemptSafe fork log) ∧
  responseRequests r.attempts ≤ 6 ∧ formatCharges r.attempts ≤ responseRequests r.attempts ∧
  r.reviewCalls ≤ 1 ∧ r.reconsiderations ≤ r.reviewCalls ∧
  r.mainConversation = source.effectiveConversation ∧ r.child = fork.child ∧
  r.cleanupDrained = true ∧ r.handoffs = [r.terminal] ∧
  r.revokedFileAuthority = true ∧ r.cancelledSessions = [fork.child] ∧
  r.selectedSession = source.session

theorem finish_is_safe (source : Source) (fork : Fork) (r : InquiryResult)
    (reviews reconsiderations : Nat) (o : Observation)
    (allSafe : ∀ log ∈ r.attempts, AttemptSafe fork log)
    (bound : responseRequests r.attempts ≤ 6)
    (charges : formatCharges r.attempts ≤ responseRequests r.attempts)
    (reviewBound : reviews ≤ 1) (reconsiderationBound : reconsiderations ≤ reviews) :
    PrivateSafe source fork (finish source fork r reviews reconsiderations o) := by
  exact ⟨allSafe, bound, charges, reviewBound, reconsiderationBound,
    rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem private_execution_is_safe (source : Source) (policy : Policy) (fork : Fork)
    (initial replacement : Nat → AttemptInput) (review : Review)
    (afterReview afterCleanup : Observation) :
    PrivateSafe source fork
      (executePrivate source policy fork initial replacement review afterReview afterCleanup) := by
  obtain ⟨allFirst, _, firstBound, firstCharges, _⟩ :=
    inquiry_is_safe source policy fork initial 3 0
  obtain ⟨allSecond, _, secondBound, secondCharges, _⟩ :=
    inquiry_is_safe source policy fork replacement 3 0
  cases firstOutcome : (runInquiry source policy fork initial 3 0).outcome with
  | valid v =>
    simp only [executePrivate, firstOutcome]
    split
    · split
      · exact finish_is_safe source fork _ 1 0 afterCleanup allFirst (by dsimp; omega)
          firstCharges (by omega) (by omega)
      · split
        · apply finish_is_safe source fork _ 1 1 afterCleanup
          · intro log member
            rcases List.mem_append.mp member with first | second
            · exact allFirst log first
            · exact allSecond log second
          · simpa [responseRequests, List.map_append, List.sum_append] using
              Nat.add_le_add firstBound secondBound
          · simpa [formatCharges, responseRequests, List.map_append, List.sum_append] using
              Nat.add_le_add firstCharges secondCharges
          · omega
          · omega
        · exact finish_is_safe source fork _ 1 0 afterCleanup allFirst (by omega)
            firstCharges (by omega) (by omega)
    · exact finish_is_safe source fork _ 0 0 afterCleanup allFirst (by omega)
        firstCharges (by omega) (by omega)
  | invalid _ | cancelled | executionError =>
      simp only [executePrivate, firstOutcome]
      exact finish_is_safe source fork _ 0 0 afterCleanup allFirst (by omega)
        firstCharges (by omega) (by omega)

theorem finish_accepts_only_valid (source : Source) (policy : Policy) (fork : Fork)
    (r : InquiryResult) (reviews reconsiderations : Nat) (o : Observation) (v : Verdict)
    (valid : ∀ candidate, r.outcome = .valid candidate → validVerdict policy candidate = true)
    (accepted : (finish source fork r reviews reconsiderations o).terminal = .decision v) :
    validVerdict policy v = true := by
  simp only [finish] at accepted
  split at accepted
  · cases outcome : r.outcome <;> simp [terminalOf, outcome] at accepted
    rename_i candidate
    subst candidate
    exact valid v outcome
  · contradiction

theorem private_accepts_only_valid (source : Source) (policy : Policy) (fork : Fork)
    (initial replacement : Nat → AttemptInput) (review : Review)
    (afterReview afterCleanup : Observation) (v : Verdict)
    (accepted : (executePrivate source policy fork initial replacement review
      afterReview afterCleanup).terminal = .decision v) : validVerdict policy v = true := by
  have firstValid := inquiry_accepts_only_valid_candidate source policy fork initial 3 0
  have secondValid := inquiry_accepts_only_valid_candidate source policy fork replacement 3 0
  simp only [executePrivate] at accepted
  split at accepted
  · split at accepted
    · split at accepted
      · exact finish_accepts_only_valid source policy fork _ 1 0 afterCleanup v
          (by intro candidate impossible; cases impossible) accepted
      · split at accepted
        · exact finish_accepts_only_valid source policy fork _ 1 1 afterCleanup v secondValid accepted
        · exact finish_accepts_only_valid source policy fork _ 1 0 afterCleanup v firstValid accepted
    · exact finish_accepts_only_valid source policy fork _ 0 0 afterCleanup v firstValid accepted
  · exact finish_accepts_only_valid source policy fork _ 0 0 afterCleanup v firstValid accepted

theorem finish_rechecks_currentness (source : Source) (fork : Fork) (r : InquiryResult)
    (reviews reconsiderations : Nat) (o : Observation) (stale : qualified source o = false) :
    (finish source fork r reviews reconsiderations o).terminal = .cancelled := by
  simp [finish, stale]

-- Setup refuses absent full projection, non-distinct children or unavailable private resources without fallback.
structure Setup where
  child : SessionId
  resultPath : ResultPath
  fullProjectionAvailable : Bool
  freshPrivateLocation : Bool
  filesystemReady : Bool
  deriving DecidableEq, Repr

def setupAdmitted (source : Source) (setup : Setup) : Bool :=
  setup.child != source.session && setup.fullProjectionAvailable &&
    setup.freshPrivateLocation && setup.filesystemReady

def runOwnedDecision (source : Source) (policy : Policy) (setup : Setup)
    (initial replacement : Nat → AttemptInput) (review : Review)
    (afterReview afterCleanup : Observation) : PrivateResult :=
  let fork := fullFork source setup.child setup.resultPath
  if setupAdmitted source setup then
    executePrivate source policy fork initial replacement review afterReview afterCleanup
  else finish source fork ⟨.executionError, [], []⟩ 0 0 afterCleanup

theorem owned_execution_is_safe (source : Source) (policy : Policy) (setup : Setup)
    (initial replacement : Nat → AttemptInput) (review : Review)
    (afterReview afterCleanup : Observation) :
    PrivateSafe source (fullFork source setup.child setup.resultPath)
      (runOwnedDecision source policy setup initial replacement review afterReview afterCleanup) := by
  unfold runOwnedDecision
  split
  · exact private_execution_is_safe source policy _ initial replacement review afterReview afterCleanup
  · apply finish_is_safe <;> simp [responseRequests, formatCharges]

theorem no_fresh_context_fallback (source : Source) (policy : Policy) (setup : Setup)
    (initial replacement : Nat → AttemptInput) (review : Review)
    (afterReview afterCleanup : Observation) (unavailable : setup.fullProjectionAvailable = false) :
    (runOwnedDecision source policy setup initial replacement review afterReview afterCleanup).attempts = [] := by
  simp [runOwnedDecision, setupAdmitted, unavailable, finish]

theorem owned_child_is_distinct (source : Source) (setup : Setup)
    (admitted : setupAdmitted source setup = true) : setup.child ≠ source.session := by
  simp only [setupAdmitted, Bool.and_eq_true, bne_iff_ne] at admitted
  exact admitted.1.1.1

-- These environmental contracts explain refinement and eventual settlement assumptions, not additional proven liveness.
structure EnvironmentAssumptions where
  qualifiedFenceDelivered : Prop
  completeResponseBoundaryObserved : Prop
  nativeFollowupPrevented : Prop
  admittedWritesJoinedBeforeReadResetOrCleanup : Prop
  authenticSourceAndOwnershipObservations : Prop
  fullEffectiveForkProjectionAvailable : Prop
  descriptorAndDecodedFileObservationsAuthentic : Prop
  parentPublicationReceiptsAuthentic : Prop
  allBoundariesEventuallyReturnOrCancel : Prop

def EnvironmentAdmitted (e : EnvironmentAssumptions) : Prop :=
  e.qualifiedFenceDelivered ∧ e.completeResponseBoundaryObserved ∧
  e.nativeFollowupPrevented ∧ e.admittedWritesJoinedBeforeReadResetOrCleanup ∧
  e.authenticSourceAndOwnershipObservations ∧ e.fullEffectiveForkProjectionAvailable ∧
  e.descriptorAndDecodedFileObservationsAuthentic ∧ e.parentPublicationReceiptsAuthentic ∧
  e.allBoundariesEventuallyReturnOrCancel

-- Main state models replaceable idle qualification and shared continue/callback units; private activity is inert.
structure RuntimeState where
  locked : Bool
  attempt : Nat
  maxContinue : Nat
  callbackSuspended : Bool
  decisionFailed : Bool
  decisionOpen : Bool
  mainIdle : Bool
  busyChildren : List Nat
  pendingMessages : Bool
  fenceToken : Nat
  fenceRemaining : Option Nat
  deriving DecidableEq, Repr

def initialState (maxContinue : Nat) : RuntimeState :=
  { locked := true, attempt := 0, maxContinue, callbackSuspended := false,
    decisionFailed := false, decisionOpen := false, mainIdle := true,
    busyChildren := [], pendingMessages := false, fenceToken := 0, fenceRemaining := none }

def aggregateIdle (s : RuntimeState) : Bool :=
  s.mainIdle && s.busyChildren.isEmpty && !s.pendingMessages

def eligible (s : RuntimeState) : Bool :=
  s.locked && aggregateIdle s && !s.callbackSuspended && s.attempt < s.maxContinue &&
    !s.decisionFailed && !s.decisionOpen

def replaceFence (s : RuntimeState) : RuntimeState :=
  { s with
    fenceToken := s.fenceToken + 1,
    fenceRemaining := if eligible s then some 10 else none }

def reportMain (_eventLabel : String) (idle : Bool) (s : RuntimeState) : RuntimeState :=
  replaceFence { s with mainIdle := idle }

def reportExternalChild (id : Nat) (idle : Bool) (s : RuntimeState) : RuntimeState :=
  replaceFence { s with busyChildren :=
    if idle then s.busyChildren.filter (· != id)
    else if s.busyChildren.contains id then s.busyChildren else s.busyChildren ++ [id] }

def reportPrivateChild (_id : Nat) (_idle : Bool) (s : RuntimeState) : RuntimeState := s

def connectionOnly (_id : Nat) (s : RuntimeState) : RuntimeState := s

def timerExpiry (token : Nat) (s : RuntimeState) : RuntimeState :=
  if token == s.fenceToken && s.fenceRemaining == some 0 && eligible s then
    { s with decisionOpen := true, fenceRemaining := none }
  else s

def tick (s : RuntimeState) : RuntimeState :=
  { s with fenceRemaining := s.fenceRemaining.map (· - 1) }

def exhaustionEligible (s : RuntimeState) : Bool :=
  s.locked && aggregateIdle s && !s.callbackSuspended && s.maxContinue ≤ s.attempt

def cancelDecision (s : RuntimeState) : RuntimeState :=
  { s with decisionOpen := false, fenceRemaining := none }

def manualUnlock (s : RuntimeState) : RuntimeState :=
  { cancelDecision s with locked := false, callbackSuspended := false }

def freshLockCycle (s : RuntimeState) : RuntimeState :=
  { s with
    locked := true, attempt := 0, callbackSuspended := false,
    decisionFailed := false, decisionOpen := false, fenceRemaining := none }

def resumeFromCallback (s : RuntimeState) : RuntimeState :=
  if s.locked && s.callbackSuspended then { s with callbackSuspended := false } else s

def callbackWakeTexts : List String :=
  ["Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.",
   "New intercom message above."]

def observeUserStart (text : String) (s : RuntimeState) : RuntimeState :=
  if callbackWakeTexts.contains text then resumeFromCallback s else freshLockCycle s

-- Preserve the remote ownership fix: blank user/custom rows are inert, while missing or non-text payloads are work.
-- Content classification is a host observation here; busy activity remains independently qualified.
def carriesContent (hasContentField textOnly blankText : Bool) : Bool :=
  if !hasContentField then true else if !textOnly then true else !blankText

def classifyMessageStart (roleIsUserOrCustom hasContentField textOnly blankText : Bool) : Bool :=
  roleIsUserOrCustom && carriesContent hasContentField textOnly blankText

def preemptOnMessageStart (foreignInput : Bool) (s : RuntimeState) : RuntimeState :=
  if foreignInput then cancelDecision s else s

def observeClassifiedUserMessageStart (hasContentField textOnly blankText : Bool)
    (text : String) (s : RuntimeState) : RuntimeState :=
  if classifyMessageStart true hasContentField textOnly blankText then
    if hasContentField && textOnly then observeUserStart text s else freshLockCycle s
  else s

-- Publication separates provisional accounting from confirmed-receipt main work; absent receipts alone permit refund/retry.
inductive Receipt where
  | confirmed
  | absent
  | unreadable
  deriving DecidableEq, Repr

structure Publication where
  source : Source
  terminal : Terminal
  charged : Bool
  acknowledged : Bool
  receipt : Receipt
  deriving DecidableEq, Repr

inductive MainEntry where
  | ordinary (text : String)
  | continuation (reasonType reason : String)
  | decisionFailed
  | exhaustion
  | quietUnlock (reasonType reason : String)
  | quietCallback (reasonType reason : String)
  | excludedAudit
  | legacyPrivateExchange
  deriving DecidableEq, Repr

def modelProjection : MainEntry → List String
  | .ordinary text => [text]
  | .continuation kind reason =>
      [s!"Extension next-action guidance ({kind}): {reason}. Check all requested tasks and latest delivery. Preserve granted permission; stop at the user boundary."]
  | .decisionFailed => ["Watchdog decision failed."]
  | .exhaustion => ["Watchdog continuation budget exhausted."]
  | _ => []

structure CommitResult where
  state : RuntimeState
  publication : Publication
  entries : List MainEntry
  mainWorkRequested : Bool
  deriving DecidableEq, Repr

def commitTerminal (o : Observation) (s : RuntimeState) (p : Publication) : CommitResult :=
  let unchanged : CommitResult := ⟨s, p, [], false⟩
  if !qualified p.source o || !s.locked || !s.decisionOpen || p.acknowledged then unchanged
  else
    match p.terminal with
    | .cancelled => ⟨cancelDecision s, p, [], false⟩
    | .executionError => ⟨manualUnlock s, p, [], false⟩
    | .decisionFailed =>
        ⟨{ s with decisionOpen := false, decisionFailed := true },
          { p with acknowledged := true }, [.decisionFailed], false⟩
    | .decision v =>
        if v.action == .cont then
          if s.maxContinue ≤ s.attempt then unchanged
          else
            ⟨{ s with decisionOpen := false, attempt := s.attempt + 1 },
              { p with charged := true, acknowledged := true },
              [.continuation v.reasonType v.reason], p.receipt == .confirmed⟩
        else if isCallback v then
          if s.maxContinue ≤ s.attempt then unchanged
          else
            ⟨{ s with
              decisionOpen := false, attempt := s.attempt + 1,
              callbackSuspended := true }, { p with charged := true, acknowledged := true },
              [.quietCallback v.reasonType v.reason], false⟩
        else
          ⟨{ s with locked := false, decisionOpen := false },
            { p with acknowledged := true }, [.quietUnlock v.reasonType v.reason], false⟩

def isContinuationTerminal : Terminal → Bool
  | .decision v => v.action == .cont
  | _ => false

def reconcileReceipt (ledgerCurrent : Bool) (p : Publication) (s : RuntimeState) :
    Publication × RuntimeState :=
  if ledgerCurrent && p.charged && !s.callbackSuspended && p.receipt == .absent &&
      isContinuationTerminal p.terminal &&
      !s.decisionOpen && 0 < s.attempt then
    ({ p with charged := false }, { s with attempt := s.attempt - 1 })
  else (p, s)

def receiptAllowsRetry (p : Publication) : Bool := p.receipt == .absent

def reapplyContinuation (o : Observation) (ledgerCurrent : Bool) (previousAttempt : Nat)
    (p : Publication) (s : RuntimeState) : Publication × RuntimeState :=
  if qualified p.source o && ledgerCurrent && receiptAllowsRetry p && !p.charged &&
      p.acknowledged && s.locked && !s.callbackSuspended && !s.decisionOpen &&
      !s.decisionFailed && s.attempt == previousAttempt && previousAttempt < s.maxContinue &&
      isContinuationTerminal p.terminal then
    ({ p with charged := true }, { s with attempt := previousAttempt + 1 })
  else (p, s)

-- Historical projection retains ordinary/canonical facts but restores no operational or temporary-file authority.
structure RecoveredHistory where
  entries : List MainEntry
  activeChild : Option SessionId
  resultAuthority : Option ResultPath
  locked : Bool
  responseAllowance : Nat
  publicationPending : Bool
  deriving DecidableEq, Repr

def recoverHistory (entries : List MainEntry) : RecoveredHistory :=
  ⟨entries, none, none, false, 0, false⟩

-- Main-boundary laws preserve inherited source, qualification, accounting, receipt and callback safeguards.
theorem full_fork_preserves_effective_source (source : Source) (child : SessionId)
    (path : ResultPath) :
    let fork := fullFork source child path
    fork.conversation = source.effectiveConversation ∧
    fork.systemState = source.systemState ∧ fork.declarations = source.toolDeclarations ∧
    fork.providerModel = source.providerModel ∧ fork.thinking = source.thinking ∧
    fork.ambientExtensions = false ∧ fork.publicRegistrations = [] := by
  simp [fullFork]

theorem main_activity_cancels_fence (s : RuntimeState) (label : String) :
    (reportMain label false s).fenceRemaining = none := by
  simp [reportMain, replaceFence, eligible, aggregateIdle]

theorem event_labels_do_not_determine_activity (a b : String) (idle : Bool)
    (s : RuntimeState) : reportMain a idle s = reportMain b idle s := rfl

theorem private_activity_does_not_invalidate (id : Nat) (idle : Bool) (s : RuntimeState) :
    reportPrivateChild id idle s = s ∧ connectionOnly id s = s := ⟨rfl, rfl⟩

theorem stale_timer_is_inert (token : Nat) (s : RuntimeState)
    (stale : token ≠ s.fenceToken) : timerExpiry token s = s := by
  simp [timerExpiry, stale]

theorem fixed_fence_and_busy_guard (s : RuntimeState) :
    (eligible s = true → (replaceFence s).fenceRemaining = some 10) ∧
    (aggregateIdle s = false → eligible s = false) := by
  constructor
  · intro h; simp [replaceFence, h]
  · intro h; simp [eligible, h]

theorem cancellation_preserves_budgets (s : RuntimeState) :
    (cancelDecision s).attempt = s.attempt ∧
    (cancelDecision s).decisionOpen = false ∧
    (manualUnlock s).attempt = s.attempt ∧ (manualUnlock s).locked = false := by
  simp [cancelDecision, manualUnlock]

theorem stale_terminal_has_no_effect (o : Observation) (s : RuntimeState) (p : Publication)
    (stale : qualified p.source o = false) :
    commitTerminal o s p = ⟨s, p, [], false⟩ := by
  simp [commitTerminal, stale]

theorem duplicate_terminal_has_no_effect (o : Observation) (s : RuntimeState) (p : Publication)
    (done : p.acknowledged = true) : commitTerminal o s p = ⟨s, p, [], false⟩ := by
  simp [commitTerminal, done]

theorem commit_budget_is_bounded (o : Observation) (s : RuntimeState) (p : Publication)
    (bound : s.attempt ≤ s.maxContinue) :
    (commitTerminal o s p).state.attempt ≤ s.maxContinue := by
  unfold commitTerminal
  split
  · exact bound
  · cases terminal : p.terminal with
    | cancelled => simpa only [terminal, cancelDecision] using bound
    | executionError => simpa only [terminal, manualUnlock, cancelDecision] using bound
    | decisionFailed => simpa only [terminal] using bound
    | decision v =>
        simp only
        split
        · split
          · exact bound
          · simp only; omega
        · split
          · split
            · exact bound
            · simp only; omega
          · exact bound

theorem confirmed_or_unknown_receipt_never_refunds (current : Bool)
    (p : Publication) (s : RuntimeState) (notAbsent : p.receipt ≠ .absent) :
    reconcileReceipt current p s = (p, s) := by
  simp [reconcileReceipt, notAbsent]

theorem callback_unit_never_refunds (current : Bool) (p : Publication) (s : RuntimeState)
    (suspended : s.callbackSuspended = true) : reconcileReceipt current p s = (p, s) := by
  simp [reconcileReceipt, suspended]

theorem callback_suspension_blocks_inquiry_and_exhaustion (s : RuntimeState)
    (suspended : s.callbackSuspended = true) :
    eligible s = false ∧ exhaustionEligible s = false := by
  simp [eligible, exhaustionEligible, suspended]

theorem callback_resumption_does_not_replenish (s : RuntimeState) :
    (observeUserStart "New intercom message above." s).attempt = s.attempt ∧
    (observeUserStart "New intercom message above." s).locked = s.locked := by
  simp [observeUserStart, callbackWakeTexts, resumeFromCallback]
  split <;> simp

theorem near_match_starts_fresh_cycle (s : RuntimeState) :
    observeUserStart "New intercom message above. " s = freshLockCycle s ∧
    observeUserStart "new intercom message above." s = freshLockCycle s := by
  simp [observeUserStart, callbackWakeTexts]

theorem final_callback_unit_waits (s : RuntimeState) (locked : s.locked = true)
    (suspended : s.callbackSuspended = true) (spent : s.maxContinue ≤ s.attempt)
    (idle : aggregateIdle s = true) :
    exhaustionEligible s = false ∧ exhaustionEligible (resumeFromCallback s) = true ∧
    (resumeFromCallback s).attempt = s.attempt := by
  have idleFields := idle
  unfold aggregateIdle at idleFields
  simp [exhaustionEligible, resumeFromCallback, locked, suspended, aggregateIdle, idleFields, spent]

theorem initialization_establishes_budget_invariant (maxContinue : Nat) :
    (initialState maxContinue).attempt ≤ maxContinue ∧
    (initialState maxContinue).decisionOpen = false ∧
    (initialState maxContinue).callbackSuspended = false := by
  simp [initialState]

theorem busy_child_and_active_decision_block_entry (s : RuntimeState) :
    (s.busyChildren.isEmpty = false → eligible s = false) ∧
    (s.decisionOpen = true → eligible s = false) := by
  constructor
  · intro busy; simp [eligible, aggregateIdle, busy]
  · intro active; simp [eligible, active]

theorem accepted_continuation_spends_one (o : Observation) (s : RuntimeState) (p : Publication)
    (v : Verdict) (current : qualified p.source o = true) (locked : s.locked = true)
    (openWindow : s.decisionOpen = true) (fresh : p.acknowledged = false)
    (terminal : p.terminal = .decision v) (action : v.action = .cont)
    (capacity : s.attempt < s.maxContinue) (receipt : p.receipt = .confirmed) :
    (commitTerminal o s p).state.attempt = s.attempt + 1 ∧
    (commitTerminal o s p).entries = [.continuation v.reasonType v.reason] ∧
    (commitTerminal o s p).mainWorkRequested = true := by
  simp [commitTerminal, current, locked, openWindow, fresh, terminal, action,
    Nat.not_le_of_gt capacity, receipt]

theorem accepted_callback_spends_one_without_main_work (o : Observation)
    (s : RuntimeState) (p : Publication) (v : Verdict)
    (current : qualified p.source o = true) (locked : s.locked = true)
    (openWindow : s.decisionOpen = true) (fresh : p.acknowledged = false)
    (terminal : p.terminal = .decision v) (action : v.action = .unlock)
    (callback : isCallback v = true) (capacity : s.attempt < s.maxContinue) :
    (commitTerminal o s p).state.attempt = s.attempt + 1 ∧
    (commitTerminal o s p).state.locked = true ∧
    (commitTerminal o s p).state.callbackSuspended = true ∧
    (commitTerminal o s p).mainWorkRequested = false ∧
    (commitTerminal o s p).entries = [.quietCallback v.reasonType v.reason] := by
  simp [commitTerminal, current, locked, openWindow, fresh, terminal, action, callback,
    Nat.not_le_of_gt capacity]

theorem accepted_unlock_spends_nothing (o : Observation) (s : RuntimeState) (p : Publication)
    (v : Verdict) (current : qualified p.source o = true) (locked : s.locked = true)
    (openWindow : s.decisionOpen = true) (fresh : p.acknowledged = false)
    (terminal : p.terminal = .decision v) (action : v.action = .unlock)
    (notCallback : isCallback v = false) :
    (commitTerminal o s p).state.attempt = s.attempt ∧
    (commitTerminal o s p).state.locked = false ∧
    (commitTerminal o s p).entries = [.quietUnlock v.reasonType v.reason] := by
  simp [commitTerminal, current, locked, openWindow, fresh, terminal, action, notCallback]

theorem failures_spend_no_continuation_unit (o : Observation) (s : RuntimeState)
    (p : Publication) (failure : p.terminal = .decisionFailed ∨ p.terminal = .executionError ∨
      p.terminal = .cancelled) : (commitTerminal o s p).state.attempt = s.attempt := by
  unfold commitTerminal
  split
  · rfl
  · rcases failure with failed | failed | cancelled <;>
      simp_all [manualUnlock, cancelDecision]

theorem unconfirmed_receipt_cannot_start_main_work (o : Observation) (s : RuntimeState)
    (p : Publication) (unconfirmed : p.receipt ≠ .confirmed) :
    (commitTerminal o s p).mainWorkRequested = false := by
  unfold commitTerminal
  split
  · rfl
  · cases p.terminal with
    | cancelled | executionError | decisionFailed => rfl
    | decision v =>
        simp only
        split
        · split
          · rfl
          · simp [unconfirmed]
        · split
          · split <;> rfl
          · rfl

theorem receipt_refund_requires_current_absence (current : Bool) (p : Publication)
    (s : RuntimeState) (changed : (reconcileReceipt current p s).2.attempt ≠ s.attempt) :
    current = true ∧ p.receipt = .absent ∧
    (reconcileReceipt current p s).2.attempt = s.attempt - 1 := by
  unfold reconcileReceipt at changed ⊢
  split
  · rename_i guard
    simp only [Bool.and_eq_true, beq_iff_eq] at guard
    exact ⟨guard.1.1.1.1.1.1, guard.1.1.1.2, rfl⟩
  · rename_i noRefund
    simp only [ite_eq_right noRefund] at changed
    exact absurd rfl changed

theorem reapply_preserves_budget_bound (o : Observation) (current : Bool)
    (previousAttempt : Nat) (p : Publication) (s : RuntimeState)
    (bound : s.attempt ≤ s.maxContinue) :
    (reapplyContinuation o current previousAttempt p s).2.attempt ≤ s.maxContinue := by
  unfold reapplyContinuation
  split
  · rename_i guard
    simp only [Bool.and_eq_true, decide_eq_true_eq] at guard
    have capacity := guard.1.2
    dsimp
    omega
  · exact bound

theorem uncertain_publication_never_resends (o : Observation) (current : Bool)
    (previousAttempt : Nat) (p : Publication) (s : RuntimeState)
    (notAbsent : p.receipt ≠ .absent) :
    receiptAllowsRetry p = false ∧ reapplyContinuation o current previousAttempt p s = (p, s) := by
  simp [receiptAllowsRetry, notAbsent, reapplyContinuation]

theorem recovery_is_history_only (entries : List MainEntry) :
    let recovered := recoverHistory entries
    recovered.entries = entries ∧ recovered.activeChild = none ∧
    recovered.resultAuthority = none ∧ recovered.locked = false ∧
    recovered.responseAllowance = 0 ∧ recovered.publicationPending = false := by
  simp [recoverHistory]

theorem private_and_quiet_entries_are_not_model_input (kind reason : String) :
    modelProjection (.quietUnlock kind reason) = [] ∧
    modelProjection (.quietCallback kind reason) = [] ∧
    modelProjection .excludedAudit = [] ∧ modelProjection .legacyPrivateExchange = [] := by
  simp [modelProjection]

-- Deterministic examples illustrate three invalid responses and two corrections without proving LLM judgment.
def demoObservation : Observation :=
  ⟨1, 1, 1, 1, 0, "parent/model", "parent-thinking", true, true, true, false, false⟩

def allInvalid : Nat → AttemptInput := fun _ =>
  ⟨demoObservation, demoObservation, .normal [] true .settled .emptyObject demoObservation⟩

def demoSource : Source :=
  ⟨1, 1, 10, 1, 1, 0, "parent/model", "parent-thinking", ["Retained effective parent history"],
    ["Parent system state"], ["write", "read", "shell"]⟩

def demoPolicy : Policy := ⟨["WORK_REMAINS"], ["JOB_DONE", "WAIT_CALLBACK"]⟩

def demoFork : Fork := fullFork demoSource 2 99

theorem three_invalid_responses_fail :
    let r := runInquiry demoSource demoPolicy demoFork allInvalid 3 0
    invalidOutcome r.outcome = true ∧ responseRequests r.attempts = 3 ∧
    formatCharges r.attempts = 3 ∧ r.corrections.length = 2 := by
  simp [runInquiry, runAttempt, allInvalid, demoSource, demoPolicy, demoFork,
    qualified, scopeCurrent, demoObservation, requestedAttempt, stoppedAttempt, invalidOutcome,
    responseRequests, formatCharges]

-- Shared classification protects both takeover and later auto-lock; real content still closes the decision without spending budget.
theorem empty_custom_message_does_not_preempt (s : RuntimeState) :
    preemptOnMessageStart (classifyMessageStart true true true true) s = s := by
  simp [preemptOnMessageStart, classifyMessageStart, carriesContent]

theorem whitespace_only_custom_message_does_not_preempt (s : RuntimeState) :
    preemptOnMessageStart (classifyMessageStart true true true true) s = s := by
  simp [preemptOnMessageStart, classifyMessageStart, carriesContent]

theorem content_bearing_custom_message_preempts (s : RuntimeState) :
    (preemptOnMessageStart (classifyMessageStart true true true false) s).decisionOpen = false ∧
    (preemptOnMessageStart (classifyMessageStart true true true false) s).attempt = s.attempt := by
  simp [preemptOnMessageStart, classifyMessageStart, carriesContent, cancelDecision]

theorem image_bearing_custom_message_preempts (s : RuntimeState) :
    (preemptOnMessageStart (classifyMessageStart true true false true) s).decisionOpen = false ∧
    (preemptOnMessageStart (classifyMessageStart true true false true) s).attempt = s.attempt := by
  simp [preemptOnMessageStart, classifyMessageStart, carriesContent, cancelDecision]

theorem non_user_or_custom_message_never_preempts (s : RuntimeState)
    (hasContentField textOnly blankText : Bool) :
    preemptOnMessageStart (classifyMessageStart false hasContentField textOnly blankText) s = s := by
  simp [preemptOnMessageStart, classifyMessageStart]

theorem empty_user_message_is_inert_through_both_handlers (text : String) (s : RuntimeState) :
    observeClassifiedUserMessageStart true true true text
      (preemptOnMessageStart (classifyMessageStart true true true true) s) = s := by
  simp [observeClassifiedUserMessageStart, preemptOnMessageStart, classifyMessageStart, carriesContent]

theorem missing_payload_is_foreign (textOnly blankText : Bool) :
    classifyMessageStart true false textOnly blankText = true := by
  simp [classifyMessageStart, carriesContent]

-- Carry those ownership laws into combined private-process correctness, not merely executable examples.
def PresentationSafety : Prop :=
  (∀ s, preemptOnMessageStart (classifyMessageStart true true true true) s = s) ∧
  (∀ s, (preemptOnMessageStart (classifyMessageStart true true true false) s).decisionOpen = false ∧
    (preemptOnMessageStart (classifyMessageStart true true true false) s).attempt = s.attempt) ∧
  (∀ s, (preemptOnMessageStart (classifyMessageStart true true false true) s).decisionOpen = false ∧
    (preemptOnMessageStart (classifyMessageStart true true false true) s).attempt = s.attempt) ∧
  (∀ s hasContentField textOnly blankText,
    preemptOnMessageStart (classifyMessageStart false hasContentField textOnly blankText) s = s) ∧
  (∀ text s, observeClassifiedUserMessageStart true true true text
    (preemptOnMessageStart (classifyMessageStart true true true true) s) = s) ∧
  (∀ textOnly blankText, classifyMessageStart true false textOnly blankText = true)

theorem presentation_is_correct : PresentationSafety :=
  ⟨empty_custom_message_does_not_preempt, content_bearing_custom_message_preempts,
    image_bearing_custom_message_preempts, non_user_or_custom_message_never_preempts,
    empty_user_message_is_inert_through_both_handlers, missing_payload_is_foreign⟩

-- Top theorem combines finite modeled safety and unconfirmed-receipt non-start; it is not a TypeScript or wire-payload proof.
def ProcessSafety : Prop :=
  (∀ source policy fork input, AttemptSafe fork (runAttempt source policy fork input)) ∧
  (∀ source policy fork inputs fuel index,
    InquirySafe fork fuel (runInquiry source policy fork inputs fuel index)) ∧
  (∀ source policy fork initial replacement review afterReview afterCleanup,
    PrivateSafe source fork
      (executePrivate source policy fork initial replacement review afterReview afterCleanup)) ∧
  (∀ o s p, qualified p.source o = false → commitTerminal o s p = ⟨s, p, [], false⟩) ∧
  (∀ o s p, p.acknowledged = true → commitTerminal o s p = ⟨s, p, [], false⟩) ∧
  (∀ o s p, s.attempt ≤ s.maxContinue →
    (commitTerminal o s p).state.attempt ≤ s.maxContinue) ∧
  (∀ current p s, p.receipt ≠ .absent → reconcileReceipt current p s = (p, s)) ∧
  (∀ s, s.callbackSuspended = true → eligible s = false ∧ exhaustionEligible s = false) ∧
  (∀ o s p, p.receipt ≠ .confirmed → (commitTerminal o s p).mainWorkRequested = false) ∧
  PresentationSafety ∧
  (∀ entries, (recoverHistory entries).activeChild = none ∧
    (recoverHistory entries).resultAuthority = none ∧ (recoverHistory entries).locked = false)

theorem process_is_correct : ProcessSafety := by
  exact ⟨attempt_is_safe, inquiry_is_safe, private_execution_is_safe,
    stale_terminal_has_no_effect, duplicate_terminal_has_no_effect, commit_budget_is_bounded,
    confirmed_or_unknown_receipt_never_refunds, callback_suspension_blocks_inquiry_and_exhaustion,
    unconfirmed_receipt_cannot_start_main_work, presentation_is_correct,
    fun _ => ⟨rfl, rfl, rfl⟩⟩

end OfficialPiIdleInquiry

-- Report checked foundations and deterministic modeled outcome through stdout only.
#print axioms OfficialPiIdleInquiry.process_is_correct

def main : IO Unit := do
  let first := OfficialPiIdleInquiry.runInquiry OfficialPiIdleInquiry.demoSource
    OfficialPiIdleInquiry.demoPolicy OfficialPiIdleInquiry.demoFork OfficialPiIdleInquiry.allInvalid 3 0
  IO.println s!"same-child invalid inquiry: responses={OfficialPiIdleInquiry.responseRequests first.attempts}, corrections={first.corrections.length}, terminal={repr (OfficialPiIdleInquiry.terminalOf first.outcome)}"
  let parent := { OfficialPiIdleInquiry.initialState 3 with decisionOpen := true }
  let blank := OfficialPiIdleInquiry.observeClassifiedUserMessageStart true true true ""
    (OfficialPiIdleInquiry.preemptOnMessageStart
      (OfficialPiIdleInquiry.classifyMessageStart true true true true) parent)
  IO.println s!"Presentation-only row keeps both ownership handlers inert: {decide (blank = parent)}"
  IO.println "process_is_correct: modeled one-response/write join, three/six bounds, same-child correction and one reconsideration, terminal-only handoff, source guards, shared budget, receipt uncertainty, callback suspension, presentation-only ownership, history-only recovery. Host/provider boundary observations and eventual return are assumptions; no LLM-quality, hardware, or final-wire claim."
