-- Std supplies finite data and ordinary Lean foundations (propext, Classical.choice, Quot.sound).
-- The executable only computes examples and writes stdout; it does not operate a live watchdog.
import Std

set_option autoImplicit false

namespace OfficialPiIdleInquiry

-- Identifiers, bounds, and event labels name the process vocabulary, not transport encodings.
abbrev AgentId := Nat
abbrev FenceToken := Nat
abbrev DecisionId := Nat
abbrev CycleId := Nat
abbrev ToolCallId := Nat
abbrev NowMs := Nat

def equalsIgnoreCase (a b : String) : Bool :=
  a.toLower == b.toLower

def fixedIdleDelaySeconds : Nat := 10
def invalidDecisionLimit : Nat := 3
def maxReasonLength : Nat := 1000

inductive PiPublicEvent where
  | sessionStart
  | agentStart
  | agentEnd
  | agentSettled
  | messageStart
  | messageEnd
  | toolCall
  | input
  deriving DecidableEq, Repr

-- Verdicts and response blocks abstract decoded input; JSON shape, trimming, and configured
-- type admission remain transport obligations. The model checks reason bounds explicitly.
-- The timed-wait verdict is retired: an old wait submission is one invalid response, never
-- an accepted outcome, and WAIT_CALLBACK is an unlock reason that arms no timer.
inductive Verdict where
  | cont (reasonType : String) (reason : String)
  | unlock (reasonType : String) (reason : String)
  deriving DecidableEq, Repr

def validVerdict (v : Verdict) : Bool :=
  match v with
  | .cont _ r => 0 < r.length && r.length ≤ maxReasonLength
  | .unlock _ r => 0 < r.length && r.length ≤ maxReasonLength

def normalizeDecisionReasonType (supplied : String)
    (allowed : List String) : Option String :=
  match allowed.filter fun entry => equalsIgnoreCase entry supplied with
  | [] => none
  | entry :: _ => some entry.toUpper

inductive ResponseBlock where
  | cwCall (id : ToolCallId) (verdict : Option Verdict)
  | otherToolCall (id : ToolCallId)
  | visibleText
  | thinking
  | malformed
  deriving DecidableEq, Repr

inductive ResponsePlan where
  | none
  | invalid
  | verdict (v : Verdict)
  deriving DecidableEq, Repr

inductive SubmitOutcome where
  | unauthorized
  | duplicate
  | stagedInvalid
  | stagedVerdict
  deriving DecidableEq, Repr

inductive GateDecision where
  | allowed
  | blockedTerminating
  deriving DecidableEq, Repr

inductive FinalOutcome where
  | continued
  | unlocked
  | reask
  | decisionFailed
  | deferred
  deriving DecidableEq, Repr

-- A batch must contain exactly one result call, with thinking allowed but no visible prose or work tools.
def cwBlockCount (blocks : List ResponseBlock) : Nat :=
  (blocks.filter fun b =>
    match b with
    | .cwCall .. => true
    | _ => false).length

def otherToolCount (blocks : List ResponseBlock) : Nat :=
  (blocks.filter fun b =>
    match b with
    | .otherToolCall _ => true
    | _ => false).length

def hasDisallowedContent (blocks : List ResponseBlock) : Bool :=
  blocks.any fun b =>
    match b with
    | .visibleText | .malformed => true
    | _ => false

def validResponseBatch (blocks : List ResponseBlock) : Bool :=
  cwBlockCount blocks == 1 && otherToolCount blocks == 0 &&
    !hasDisallowedContent blocks

def verdictOf (blocks : List ResponseBlock) : Option Verdict :=
  match
    blocks.filter fun b =>
      match b with
      | .cwCall .. => true
      | _ => false
  with
  | [.cwCall _ v] => v
  | _ => none

def toolCallIds (blocks : List ResponseBlock) : List ToolCallId :=
  blocks.filterMap fun b =>
    match b with
    | .cwCall id _ => some id
    | .otherToolCall id => some id
    | _ => none

-- Human and model consumers receive one shared event body in the same append order.
-- New timelines carry no waited/completedWait events; legacy persisted records stay readable.
-- An accepted unlock publishes no shared model-bound body at all: its human outcome is one
-- quiet UI-only status record excluded from model-bound conversation and native summaries.
inductive SharedEventKind where
  | continued
  | decisionFailed
  | exhausted
  deriving DecidableEq, Repr

-- The quiet AI-unlock status: human-only, typed, one per accepted unlock.
structure UnlockStatusRecord where
  reasonType : String
  reason : String
  humanOnly : Bool
  modelBound : Bool
  carriesTimestampBoxOrDisclaimer : Bool
  deriving DecidableEq, Repr

def buildUnlockStatus (reasonType reason : String) : UnlockStatusRecord :=
  { reasonType
    reason
    humanOnly := true
    modelBound := false
    carriesTimestampBoxOrDisclaimer := false }

structure RuntimeTimestamp where
  wallClockMs : Nat
  rfc3339WithNumericOffset : String
  deriving DecidableEq, Repr

structure SharedEvent where
  kind : SharedEventKind
  occurredAt : RuntimeTimestamp
  body : String
  deriving DecidableEq, Repr

def humanEventBody (event : SharedEvent) : String := event.body

def modelEventBody (event : SharedEvent) : String := event.body

def appendSharedEvent
    (timeline : List SharedEvent)
    (event : SharedEvent) :
    List SharedEvent := timeline ++ [event]

-- Continuation is attributed plugin next-action guidance: the accepted reason appears once as
-- the suggested next step, never as a quoted prior-result JSON object, never as user permission,
-- and never teaching proactive control-function use. The notice preserves already-granted
-- permission instead of resetting it.
structure ContinuationEnvelope where
  guidance : String
  reasonType : String
  reason : String
  extensionAuthored : Bool
  userAuthored : Bool
  conveysUserAuthorization : Bool
  stopAtUserBoundary : Bool
  checksEveryRequestedTask : Bool
  checksLatestDelivery : Bool
  preservesGrantedPermission : Bool
  presentsReasonAsNextStep : Bool
  duplicatesReasonAsHistory : Bool
  teachesReservedFunctionUse : Bool
  deriving DecidableEq, Repr

def buildContinuationEnvelope (guidance reasonType reason : String) :
    ContinuationEnvelope :=
  { guidance
    reasonType
    reason
    extensionAuthored := true
    userAuthored := false
    conveysUserAuthorization := false
    stopAtUserBoundary := true
    checksEveryRequestedTask := true
    checksLatestDelivery := true
    preservesGrantedPermission := true
    presentsReasonAsNextStep := true
    duplicatesReasonAsHistory := false
    teachesReservedFunctionUse := false }

-- Native summary projection: the same exact-exchange fold governs the host's compaction and
-- branch-summary preparations. Owned finalized exchanges, invalidated exchanges, recognizable
-- legacy control replacements, and quiet unlock statuses never enter summarized model input;
-- accepted continuations survive at their selected fold positions; unowned records pass through.
-- The projection covers watchdog-owned records on supported native request paths only: it does
-- not erase raw storage, old summaries, user quotations, or content another extension
-- independently reintroduces, and it never mutates stored entries.
inductive ProjectionInput where
  | ownedFinalizedExchange (correlation : String)
  | ownedInvalidatedExchange (correlation : String)
  | legacyControlReplacement (correlation : String)
  | unlockStatus
  | continuationFold (correlation : String)
  | unownedRecord (kind : String)
  deriving DecidableEq, Repr

def summarizeKeeps (input : ProjectionInput) : Bool :=
  match input with
  | .continuationFold _ => true
  | .unownedRecord _ => true
  | _ => false

-- The reserved root function keeps a stable minimal declaration: fixed name
-- and description, a structurally constrained parameter schema, and no
-- explanatory parameter prose. Structural constraints (required fields,
-- action enum, reason-type union, reason bounds) are part of the declaration;
-- descriptions, examples, and defaults are not. Argument *usage* is still
-- taught only by an inquiry.
structure ReservedFunctionDeclaration where
  name : String
  description : String
  declaresArguments : Bool
  exposesReasonEnums : Bool
  explainsParametersInDeclaration : Bool
  rootOnly : Bool
  deriving DecidableEq, Repr

def reservedFunctionDeclaration : ReservedFunctionDeclaration :=
  { name := "cw"
    description := "don't use unless ask"
    declaresArguments := true
    exposesReasonEnums := true
    explainsParametersInDeclaration := false
    rootOnly := true }

-- State separates the idle fence, attempt consumption, staged response, and the continuation budget.
-- Prompt booleans abstract exact current run/claim/attempt correlation checked by the host adapter.
structure IdleFence where
  token : FenceToken
  armed : Bool
  remainingSeconds : Nat
  deriving DecidableEq, Repr

structure ActiveDecision where
  decisionId : DecisionId
  cycle : CycleId
  scheduled : Bool
  promptSeenInRun : Bool
  promptInProviderContext : Bool
  invalidated : Bool
  recordedCalls : List ToolCallId
  singleReservedCall : Bool
  staged : ResponsePlan
  planned : ResponsePlan
  captured : Bool
  deriving DecidableEq, Repr

structure RuntimeState where
  locked : Bool
  attempt : Nat
  maxRetries : Nat
  invalidAttempts : Nat
  decisionFailed : Bool
  nextDecisionId : DecisionId
  mainIdle : Bool
  busyChildren : List AgentId
  pendingMessages : Bool
  fence : Option IdleFence
  active : Option ActiveDecision
  exhaustionPublished : Bool
  deriving DecidableEq, Repr

-- Entry requires an idle locked cycle with capacity; authority additionally requires consumption.
def initialState (maxRetries : Nat) : RuntimeState :=
  { locked := true
    attempt := 0
    maxRetries
    invalidAttempts := 0
    decisionFailed := false
    nextDecisionId := 1
    mainIdle := true
    busyChildren := []
    pendingMessages := false
    fence := none
    active := none
    exhaustionPublished := false }

def aggregateIdle (state : RuntimeState) : Bool :=
  state.locked && state.mainIdle && state.busyChildren.isEmpty &&
    !state.pendingMessages

def exhausted (state : RuntimeState) : Bool :=
  state.attempt ≥ state.maxRetries

def fenceEligible (state : RuntimeState) : Bool :=
  aggregateIdle state && !exhausted state && !state.decisionFailed &&
    state.active.isNone

def decisionEligibleAt (state : RuntimeState) (_now : NowMs) : Bool :=
  fenceEligible state

def consumedEvidence (attempt : ActiveDecision) : Bool :=
  attempt.promptSeenInRun && attempt.promptInProviderContext

def decisionAuthorized (attempt : ActiveDecision) : Bool :=
  !attempt.invalidated && consumedEvidence attempt

def submissionAuthorizedFor (attempt : ActiveDecision)
    (callId : ToolCallId) : Bool :=
  decisionAuthorized attempt && !attempt.captured &&
    attempt.recordedCalls.contains callId

-- Status is a projection of live observations, not an inference from event labels.
inductive StatusActivity where
  | idle
  | running
  deriving DecidableEq, Repr

structure StatusProjection where
  activity : StatusActivity
  enabled : Bool
  rootRunning : Bool
  busyObservedSubagents : Nat
  nextPhase : String
  deriving DecidableEq, Repr

def statusActivity (state : RuntimeState) : StatusActivity :=
  if state.mainIdle && state.busyChildren.isEmpty then .idle else .running

def projectStatus (state : RuntimeState) : StatusProjection :=
  { activity := statusActivity state
    enabled := state.locked
    rootRunning := !state.mainIdle
    busyObservedSubagents := state.busyChildren.length
    nextPhase :=
      if state.active.isSome then "asking"
      else if state.fence.isSome then "fenced"
      else if state.locked && exhausted state then "exhausted"
      else if state.decisionFailed then "decision-failed"
      else "-" }

-- Fresh activity replaces the ten-second fence; child observations deduplicate busy identities.
def nextFenceToken (state : RuntimeState) : FenceToken :=
  (state.fence.map fun f => f.token).getD 0 + 1

def armedFence (token : FenceToken) (seconds : Nat) : IdleFence :=
  { token := token, armed := true, remainingSeconds := seconds }

def replaceFence (state : RuntimeState) : RuntimeState :=
  if fenceEligible state then
    { state with
        fence := some (armedFence (nextFenceToken state) fixedIdleDelaySeconds) }
  else
    { state with fence := none }

def reportMainState (idle : Bool) (state : RuntimeState) : RuntimeState :=
  replaceFence { state with mainIdle := idle }

def removeChild
    (agentId : AgentId)
    (state : RuntimeState) :
    RuntimeState :=
  replaceFence
    { state with
        busyChildren := state.busyChildren.filter fun child => child != agentId }

def reportChildState
    (agentId : AgentId)
    (idle : Bool)
    (state : RuntimeState) :
    RuntimeState :=
  if idle then removeChild agentId state
  else
    if state.busyChildren.contains agentId then state
    else
      replaceFence
        { state with
            busyChildren := state.busyChildren ++ [agentId] }

def observeMainEvent (_event : PiPublicEvent) (idle : Bool)
    (state : RuntimeState) : RuntimeState :=
  reportMainState idle state

def observeChildEvent (agentId : AgentId) (_event : PiPublicEvent)
    (idle : Bool) (state : RuntimeState) : RuntimeState :=
  reportChildState agentId idle state

def childConnected (_agentId : AgentId) (state : RuntimeState) :
    RuntimeState := state

def childDisconnected (agentId : AgentId) (state : RuntimeState) :
    RuntimeState := removeChild agentId state

-- Reconnection remains activity-neutral until a fresh live-state report arrives.
def reconnectRetrySeconds : Nat := 1

structure ReconnectState where
  attempts : Nat
  connected : Bool
  deriving DecidableEq, Repr

def disconnectedTransport : ReconnectState :=
  { attempts := 0, connected := false }

def reconnectTick (state : ReconnectState) : ReconnectState :=
  { state with attempts := state.attempts + 1 }

def reconnectReport (idle : Bool) (state : ReconnectState) :
    ReconnectState × Bool :=
  ({ state with connected := true }, idle)

def reconnectConnectionOnly (state : ReconnectState) : ReconnectState :=
  { state with connected := true }

-- Inquiry entry, dispatch, run correlation, and provider-context confirmation are distinct transitions.
-- Every new context projection replaces consumption evidence rather than latching historical confirmation.
def freshAttempt (decisionId : DecisionId) : ActiveDecision :=
  { decisionId
    cycle := 1
    scheduled := false
    promptSeenInRun := false
    promptInProviderContext := false
    invalidated := false
    recordedCalls := []
    singleReservedCall := false
    staged := ResponsePlan.none
    planned := ResponsePlan.none
    captured := false }

def beginDecision (now : NowMs) (state : RuntimeState) : RuntimeState :=
  if decisionEligibleAt state now then
    { state with
        active := some (freshAttempt state.nextDecisionId)
        invalidAttempts := 0
        nextDecisionId := state.nextDecisionId + 1
        fence := none }
  else
    state

def dispatchPrompt (state : RuntimeState) : RuntimeState :=
  match state.active with
  | some attempt =>
      if !attempt.invalidated && !attempt.promptSeenInRun then
        { state with active := some { attempt with scheduled := true } }
      else
        state
  | none => state

def observeRunStart (carriesPrompt : Bool) (state : RuntimeState) :
    RuntimeState :=
  match state.active with
  | some attempt =>
      if !attempt.invalidated && attempt.scheduled && carriesPrompt then
        { state with
            active :=
              some { attempt with promptSeenInRun := true, scheduled := false } }
      else
        state
  | none => state

def observeProviderContext (carriesPrompt : Bool) (state : RuntimeState) :
    RuntimeState :=
  match state.active with
  | some attempt =>
      if !attempt.invalidated && attempt.promptSeenInRun then
        { state with
            active := some { attempt with promptInProviderContext := carriesPrompt } }
      else
        state
  | none => state

-- Capture, tool blocking, and submission share the same consumption predicate before inspecting payloads.
-- A complete response is preflighted before executable calls may stage a verdict; staging is not commitment.
def provisionalPlan (staged : ResponsePlan) (blocks : List ResponseBlock) :
    ResponsePlan :=
  if validResponseBatch blocks then
    match staged with
    | .verdict v => if validVerdict v then .verdict v else .invalid
    | .invalid => .invalid
    | .none =>
        match verdictOf blocks with
        | some v => if validVerdict v then .verdict v else .invalid
        | none => .invalid
  else
    .invalid

def preflightResponse (blocks : List ResponseBlock)
    (state : RuntimeState) : RuntimeState :=
  match state.active with
  | some attempt =>
      if decisionAuthorized attempt && !attempt.captured then
        { state with
            active :=
              some
                { attempt with
                    recordedCalls :=
                      if cwBlockCount blocks == 1 && otherToolCount blocks == 0
                      then toolCallIds blocks else []
                    singleReservedCall :=
                      cwBlockCount blocks == 1 &&
                        otherToolCount blocks == 0
                    planned := provisionalPlan attempt.staged blocks } }
      else
        state
  | none => state

-- The singleton result-call batch shape shared by transport projection and traces.
def singleCallBatch (verdict : Verdict) : List ResponseBlock :=
  [.cwCall 1 (some verdict)]

-- Once authority is established, non-object/truncated transports, malformed batches,
-- and schema-invalid payload singletons alike project to a normal stop with no
-- executable calls; only a batch whose plan stays non-invalid retains its calls.
-- Ordinary responses remain untouched.
structure HostProjection where
  executable : List ResponseBlock
  terminate : Bool
  state : RuntimeState

def projectOwnedTransport (nativeShapeValid : Bool)
    (blocks : List ResponseBlock) (state : RuntimeState) : HostProjection :=
  match state.active with
  | some attempt =>
      if decisionAuthorized attempt && !attempt.captured then
        if !nativeShapeValid || !validResponseBatch blocks then
          ⟨[], true, preflightResponse [.malformed] state⟩
        else
          let projected := preflightResponse blocks state
          match projected.active with
          | some projectedAttempt =>
              if projectedAttempt.planned == ResponsePlan.invalid then
                -- A payload-invalid singleton ends before native schema-error
                -- follow-up: no executable calls, a normal stop, and the
                -- captured diagnostic charged once at settlement.
                ⟨[], true, projected⟩
              else
                ⟨blocks, false, projected⟩
          | none => ⟨blocks, false, projected⟩
      else
        ⟨blocks, false, state⟩
  | none => ⟨blocks, false, state⟩

def NativeTransportSafety : Prop :=
  (∀ state attempt, state.active = some attempt →
    decisionAuthorized attempt = true → attempt.captured = false →
    ∀ blocks, (projectOwnedTransport false blocks state).executable = [] ∧
      (projectOwnedTransport false blocks state).terminate = true) ∧
  (∀ state attempt, state.active = some attempt →
    decisionAuthorized attempt = true → attempt.captured = false →
    ∀ blocks, validResponseBatch blocks = true →
      provisionalPlan attempt.staged blocks = ResponsePlan.invalid →
      (projectOwnedTransport true blocks state).executable = [] ∧
        (projectOwnedTransport true blocks state).terminate = true) ∧
  (∀ state, state.active = none → ∀ nativeShape blocks,
    projectOwnedTransport nativeShape blocks state = ⟨blocks, false, state⟩)

-- These local projection guarantees are conditional on authentic consumption metadata.
-- Pi 0.85.1's intermediate context hook alone does not establish that premise: the runtime
-- additionally requires the exact correlated run observation and the recorded batch identity
-- before a submission is authorized, and final provider-bound isolation is enforced by the
-- exact-exchange fold over ordinary requests and the native summary projection over the
-- host's compaction/branch-summary preparations. Scheduling, parser transport, metadata
-- authenticity, and durable I/O remain explicit external assumptions.
theorem native_transport_is_guarded : NativeTransportSafety := by
  refine ⟨?_, ?_, ?_⟩
  · intro state attempt active authorized openWindow blocks
    simp [projectOwnedTransport, active, authorized, openWindow]
  · intro state attempt active authorized openWindow blocks batchValid
      planInvalid
    simp only [projectOwnedTransport, active, authorized, openWindow,
      Bool.not_false, Bool.and_self, Bool.not_true, batchValid]
    simp [preflightResponse, active, authorized, openWindow, planInvalid]
  · intro state noAttempt nativeShape blocks
    simp [projectOwnedTransport, noAttempt]

-- A correlated staged validation failure is an error result, not an ordinary successful return.
def stagedResultIsError (result : SubmitOutcome) : Bool := result == .stagedInvalid

theorem staged_validation_is_error : stagedResultIsError .stagedInvalid = true := by
  rfl

-- Receipt observation is three-valued: only confirmed absence on the current attempt
-- permits a budget refund; a failed branch read leaves the accounting unchanged.
inductive ReceiptObservation where
  | confirmed
  | absent
  | unreadable
  deriving DecidableEq, Repr

def receiptAccount (current : Bool) (receipt : ReceiptObservation) (attempt : Nat) : Nat :=
  if current && receipt == .absent then attempt - 1 else attempt

-- The accounting guard treats uncertainty separately from confirmed publication failure.
theorem unreadable_receipt_preserves_budget (current : Bool) (attempt : Nat) :
    receiptAccount current .unreadable attempt = attempt := by
  cases current <;> rfl

-- Timed waits are retired. The three-valued receipt rule still governs continuation
-- publication accounting: only confirmed absence on the current attempt permits a refund,
-- and an unreadable receipt leaves the budget unchanged.

def toolGate (callId : ToolCallId) (state : RuntimeState) : GateDecision :=
  match state.active with
  | none => .allowed
  | some attempt =>
      if !decisionAuthorized attempt || attempt.captured then
        .allowed
      else if attempt.singleReservedCall &&
          attempt.recordedCalls == [callId] then
        .allowed
      else
        .blockedTerminating

def submitDecisionResult (callId : ToolCallId) (verdict : Option Verdict)
    (state : RuntimeState) : SubmitOutcome × RuntimeState :=
  match state.active with
  | none => (.unauthorized, state)
  | some attempt =>
      if !decisionAuthorized attempt || attempt.captured ||
          !attempt.recordedCalls.contains callId then
        (.unauthorized, state)
      else
        match attempt.staged with
        | .none =>
            match verdict with
            | some v =>
                if validVerdict v then
                  (.stagedVerdict,
                    { state with
                        active := some { attempt with staged := .verdict v } })
                else
                  (.stagedInvalid,
                    { state with
                        active := some { attempt with staged := .invalid } })
            | none =>
                (.stagedInvalid,
                  { state with
                      active := some { attempt with staged := .invalid } })
        | _ => (.duplicate, state)

-- Authoritative settlement converts missing execution into an invalid response only for a consumed inquiry.
-- stillQualified abstracts the rechecked current ownership, idle generation, and process-domain fence.
def captureSettlement (state : RuntimeState) : RuntimeState :=
  match state.active with
  | some attempt =>
      if decisionAuthorized attempt && !attempt.captured then
        let converted :=
          match attempt.planned, attempt.staged with
          | .none, _ | .verdict _, .none => ResponsePlan.invalid
          | p, _ => p
        { state with
            active :=
              some { attempt with planned := converted, captured := true } }
      else
        state
  | none => state

def finalizeDecision (_now : NowMs) (stillQualified : Bool)
    (state : RuntimeState) : FinalOutcome × RuntimeState :=
  match state.active with
  | none => (.deferred, state)
  | some attempt =>
      if !decisionAuthorized attempt || !stillQualified then
        (.deferred, { state with active := none })
      else if !attempt.captured then
        (.deferred, state)
      else
        match attempt.planned with
        | .verdict (.cont _ _) =>
            (.continued,
              { state with
                  active := none
                  attempt := state.attempt + 1 })
        | .verdict (.unlock _ _) =>
            (.unlocked,
              { state with
                  active := none
                  locked := false })
        | .invalid =>
            if state.invalidAttempts + 1 < invalidDecisionLimit then
              (.reask,
                { state with
                    invalidAttempts := state.invalidAttempts + 1
                    active :=
                      some
                        { attempt with
                            cycle := attempt.cycle + 1
                            scheduled := false
                            promptSeenInRun := false
                            promptInProviderContext := false
                            recordedCalls := []
                            singleReservedCall := false
                            staged := ResponsePlan.none
                            planned := ResponsePlan.none
                            captured := false } })
            else
              (.decisionFailed,
                { state with
                    active := none
                    invalidAttempts := invalidDecisionLimit
                    decisionFailed := true })
        | .none => (.deferred, state)

-- Publication failures, takeover, manual unlock, and fresh cycles retain distinct recovery transitions.
def rollbackContinue (state : RuntimeState) : RuntimeState :=
  if state.active.isNone && 0 < state.attempt then
    { state with attempt := state.attempt - 1 }
  else
    state

def preemptActiveDecision (state : RuntimeState) : RuntimeState :=
  match state.active with
  | some _ => { state with active := none }
  | none => state

def manualUnlock (state : RuntimeState) : RuntimeState :=
  { preemptActiveDecision state with
      locked := false
      fence := none }

-- The host supplies authoritative settlement only after native retries finish.
-- Provider failures before that boundary leave the decision and both budgets intact.
def providerFailureAt (event : PiPublicEvent) (state : RuntimeState) : RuntimeState :=
  if event == .agentSettled then manualUnlock state else state

theorem provider_failures_preserve_budgets (state : RuntimeState) :
    providerFailureAt .agentEnd state = state ∧
    (providerFailureAt .agentSettled state).locked = false ∧
    (providerFailureAt .agentSettled state).active = none ∧
    (providerFailureAt .agentSettled state).attempt = state.attempt ∧
    (providerFailureAt .agentSettled state).invalidAttempts = state.invalidAttempts := by
  cases h : state.active <;>
    simp [providerFailureAt, manualUnlock, preemptActiveDecision, h]

def freshLockCycle (state : RuntimeState) : RuntimeState :=
  { state with
      locked := true
      attempt := 0
      invalidAttempts := 0
      decisionFailed := false
      fence := none
      active := none
      exhaustionPublished := false }

-- Timer expiry is separate from idle qualification; the fixed fence is the only timer.
def timerTick (now : NowMs) (state : RuntimeState) : RuntimeState :=
  match state.fence with
  | some fence =>
      if fence.armed && fence.remainingSeconds > 1 then
        { state with
            fence :=
              some { fence with remainingSeconds := fence.remainingSeconds - 1 } }
      else if fence.armed then
        beginDecision now state
      else
        { state with fence := none }
  | none => state

def advanceTimer (now : Nat) (seconds : Nat) (state : RuntimeState) :
    RuntimeState :=
  match seconds with
  | 0 => state
  | n + 1 => advanceTimer now n (timerTick now state)

def exhaustionEligible (state : RuntimeState) : Bool :=
  state.locked && exhausted state && aggregateIdle state

def decisionFailedEligible (state : RuntimeState) : Bool :=
  state.locked && state.decisionFailed && aggregateIdle state

-- Bounded progress assumes host delivery, response completion, settlement, and durable publication.
-- It does not assert scheduler fairness, model judgment quality, or eventual completion of arbitrary user work.
structure EnvironmentAssumptions where
  fenceExpires : Bool
  promptStartsCorrelatedRun : Bool
  providerContextCarriesPrompt : Bool
  responseCompletes : Bool
  settlementOccurs : Bool
  publicationDurable : Bool
  deriving DecidableEq, Repr

def environmentAdmitted (environment : EnvironmentAssumptions) : Prop :=
  environment.fenceExpires = true ∧
    environment.promptStartsCorrelatedRun = true ∧
    environment.providerContextCarriesPrompt = true ∧
    environment.responseCompletes = true ∧
    environment.settlementOccurs = true ∧
    environment.publicationDurable = true

def invalidBatch : List ResponseBlock :=
  [.visibleText]

-- These composed traces expose each handoff from eligible entry through the consumed response to finalization.
def runGuardedInquiry (environment : EnvironmentAssumptions) (now : NowMs)
    (verdict : Verdict) (state : RuntimeState) :
    FinalOutcome × RuntimeState :=
  let opened :=
    if environment.fenceExpires then beginDecision now state else state
  let dispatched := dispatchPrompt opened
  let started :=
    observeRunStart environment.promptStartsCorrelatedRun dispatched
  let projected :=
    observeProviderContext environment.providerContextCarriesPrompt started
  let prefetched :=
    if environment.responseCompletes then
      preflightResponse (singleCallBatch verdict) projected
    else
      projected
  let submitted := (submitDecisionResult 1 (some verdict) prefetched).2
  let captured :=
    if environment.settlementOccurs then captureSettlement submitted
    else submitted
  if environment.publicationDurable then
    finalizeDecision now true captured
  else
    (.deferred, captured)

def runGuardedInvalidResponse (environment : EnvironmentAssumptions)
    (now : NowMs) (state : RuntimeState) : FinalOutcome × RuntimeState :=
  let opened :=
    if environment.fenceExpires then beginDecision now state else state
  let dispatched := dispatchPrompt opened
  let started :=
    observeRunStart environment.promptStartsCorrelatedRun dispatched
  let projected :=
    observeProviderContext environment.providerContextCarriesPrompt started
  let prefetched :=
    if environment.responseCompletes then
      preflightResponse invalidBatch projected
    else
      projected
  let captured :=
    if environment.settlementOccurs then captureSettlement prefetched
    else prefetched
  if environment.publicationDurable then
    finalizeDecision now true captured
  else
    (.deferred, captured)

-- Observation and timer lemmas preserve the existing activity, reconnect, disconnect, and fixed-fence rules.
theorem main_event_label_is_not_activity
    (eventA eventB : PiPublicEvent) (idle : Bool)
    (state : RuntimeState) :
    observeMainEvent eventA idle state = observeMainEvent eventB idle state := by
  simp [observeMainEvent, reportMainState]

theorem child_event_label_is_not_activity
    (eventA eventB : PiPublicEvent) (agentId : AgentId) (idle : Bool)
    (state : RuntimeState) :
    observeChildEvent agentId eventA idle state =
      observeChildEvent agentId eventB idle state := by
  simp [observeChildEvent, reportChildState]

theorem connected_child_does_not_change_activity
    (agentId : AgentId) (state : RuntimeState) :
    (childConnected agentId state).busyChildren =
      state.busyChildren := by
  simp [childConnected]

theorem reconnect_retry_is_fixed_one_second :
    reconnectRetrySeconds = 1 := by
  rfl

theorem reconnect_connection_is_activity_neutral
    (state : ReconnectState) :
    (reconnectConnectionOnly state).attempts = state.attempts := by
  simp [reconnectConnectionOnly]

theorem reconnect_report_uses_fresh_live_state
    (idle : Bool) (state : ReconnectState) :
    (reconnectReport idle state).2 = idle := by
  simp [reconnectReport]

theorem non_idle_child_is_deduplicated
    (agentId : AgentId) (state : RuntimeState)
    (alreadyBusy : agentId ∈ state.busyChildren) :
    (reportChildState agentId false state).busyChildren =
      state.busyChildren := by
  simp [reportChildState, alreadyBusy]

theorem idle_child_is_removed
    (agentId : AgentId)
    (state : RuntimeState) :
    agentId ∉ (reportChildState agentId true state).busyChildren := by
  simp only [reportChildState, ite_true]
  unfold removeChild replaceFence
  split <;> simp

theorem disconnected_child_is_removed
    (agentId : AgentId)
    (state : RuntimeState) :
    agentId ∉ (childDisconnected agentId state).busyChildren := by
  unfold childDisconnected removeChild replaceFence
  split <;> simp

theorem idle_report_replaces_fence_token
    (idle : Bool) (state : RuntimeState) :
    (fenceEligible { state with mainIdle := idle } = true →
      (reportMainState idle state).fence.map (·.token) =
        some ((state.fence.map (·.token)).getD 0 + 1)) ∧
    (fenceEligible { state with mainIdle := idle } = false →
      (reportMainState idle state).fence = none) := by
  constructor
  · intro h
    rw [reportMainState, replaceFence, ite_eq_left h]
    simp [armedFence, nextFenceToken]
  · intro h
    have h' : ¬fenceEligible { state with mainIdle := idle } :=
      Bool.not_eq_true _ ▸ h
    rw [reportMainState, replaceFence, ite_eq_right h']

theorem stale_timer_is_inert
    (now : NowMs)
    (state : RuntimeState)
    (noFence : state.fence = none) :
    timerTick now state = state := by
  simp [timerTick, noFence]

theorem live_main_busy_blocks_decision_opening
    (state : RuntimeState) (busy : state.mainIdle = false) :
    fenceEligible state = false := by
  simp [fenceEligible, aggregateIdle, busy]

theorem main_activity_cancels_candidate
    (state : RuntimeState) :
    (reportMainState false state).fence = none := by
  simp [reportMainState, replaceFence, fenceEligible, aggregateIdle]

theorem fence_arm_targets_full_fixed_delay
    (state : RuntimeState)
    (eligible : fenceEligible state = true) :
    ((replaceFence state).fence.map (·.remainingSeconds)).getD 0 =
      fixedIdleDelaySeconds := by
  rw [replaceFence, ite_eq_left eligible]
  simp [armedFence]

theorem ineligible_begin_is_noop
    (now : NowMs) (state : RuntimeState)
    (ineligible : decisionEligibleAt state now = false) :
    beginDecision now state = state := by
  simp [beginDecision, ineligible]

theorem begin_decision_opens_fresh_window
    (now : NowMs) (state : RuntimeState)
    (eligible : decisionEligibleAt state now = true) :
    ∃ attempt,
      (beginDecision now state).active = some attempt ∧
        attempt.promptSeenInRun = false ∧
        attempt.promptInProviderContext = false ∧
        attempt.staged = ResponsePlan.none ∧
        attempt.invalidated = false ∧
        (beginDecision now state).invalidAttempts = 0 := by
  refine ⟨freshAttempt state.nextDecisionId, ?_, rfl, rfl, rfl, rfl, ?_⟩
  · simp [beginDecision, eligible]
  · simp [beginDecision, eligible]

theorem armed_fence_expiry_opens_decision
    (now : NowMs) (state : RuntimeState) (fence : IdleFence)
    (hfence : state.fence = some fence)
    (harmed : fence.armed = true)
    (hdue : fence.remainingSeconds ≤ 1)
    (eligible : decisionEligibleAt state now = true) :
    (timerTick now state).active.isSome = true ∧
      (timerTick now state).invalidAttempts = 0 := by
  have hnot : ¬ (fence.remainingSeconds > 1) := by omega
  simp [timerTick, hfence, harmed, hnot, beginDecision, eligible]

-- Authorization lemmas distinguish queued prompts, current consumed attempts, foreign calls, and duplicates.
theorem run_start_without_prompt_does_not_consume
    (carriesPrompt : Bool) (state : RuntimeState)
    (absent : carriesPrompt = false) :
    (observeRunStart carriesPrompt state).active = state.active := by
  cases h : state.active <;> simp [observeRunStart, h, absent]

theorem foreign_context_does_not_confirm
    (state : RuntimeState) :
    ((observeProviderContext false state).active.all fun attempt =>
      !decisionAuthorized attempt) = true := by
  cases h : state.active with
  | none => simp [observeProviderContext, h]
  | some attempt =>
      simp only [observeProviderContext, h]
      split <;> cases hi : attempt.invalidated <;>
        simp_all [decisionAuthorized, consumedEvidence]

theorem submission_without_window_is_unauthorized
    (callId : ToolCallId) (verdict : Option Verdict)
    (state : RuntimeState) (noWindow : state.active = none) :
    (submitDecisionResult callId verdict state).1 = .unauthorized ∧
      (submitDecisionResult callId verdict state).2 = state := by
  simp [submitDecisionResult, noWindow]

theorem queued_prompt_cannot_authorize
    (callId : ToolCallId) (verdict : Option Verdict)
    (state : RuntimeState) (attempt : ActiveDecision)
    (h : state.active = some attempt)
    (notConsumed : consumedEvidence attempt = false) :
    (submitDecisionResult callId verdict state).1 = .unauthorized ∧
      (submitDecisionResult callId verdict state).2 = state := by
  simp [submitDecisionResult, decisionAuthorized, h, notConsumed]

theorem unrecorded_call_identity_is_unauthorized
    (callId : ToolCallId) (verdict : Option Verdict)
    (state : RuntimeState) (attempt : ActiveDecision)
    (h : state.active = some attempt)
    (consumed : consumedEvidence attempt = true)
    (notInvalid : attempt.invalidated = false)
    (notCaptured : attempt.captured = false)
    (unrecorded : attempt.recordedCalls.contains callId = false) :
    (submitDecisionResult callId verdict state).1 = .unauthorized ∧
      (submitDecisionResult callId verdict state).2 = state := by
  simp_all [submitDecisionResult, decisionAuthorized]

theorem second_submission_is_duplicate
    (callId : ToolCallId) (verdict : Option Verdict)
    (state : RuntimeState) (attempt : ActiveDecision)
    (h : state.active = some attempt)
    (consumed : consumedEvidence attempt = true)
    (notInvalid : attempt.invalidated = false)
    (notCaptured : attempt.captured = false)
    (recorded : attempt.recordedCalls.contains callId = true)
    (alreadyStaged : attempt.staged ≠ ResponsePlan.none) :
    (submitDecisionResult callId verdict state).1 = .duplicate ∧
      (submitDecisionResult callId verdict state).2 = state := by
  cases hs : attempt.staged <;> simp_all [submitDecisionResult, decisionAuthorized]

theorem authorized_submission_stages_verdict_once
    (callId : ToolCallId) (verdict : Verdict)
    (state : RuntimeState) (attempt : ActiveDecision)
    (h : state.active = some attempt)
    (consumed : consumedEvidence attempt = true)
    (notInvalid : attempt.invalidated = false)
    (notCaptured : attempt.captured = false)
    (recorded : attempt.recordedCalls.contains callId = true)
    (fresh : attempt.staged = ResponsePlan.none)
    (valid : validVerdict verdict = true) :
    (submitDecisionResult callId (some verdict) state).1 = .stagedVerdict ∧
      (submitDecisionResult callId (some verdict) state).2 =
        { state with
            active := some { attempt with staged := .verdict verdict } } := by
  simp_all [submitDecisionResult, decisionAuthorized]

theorem invalid_verdict_submission_is_staged_invalid
    (callId : ToolCallId) (verdict : Verdict)
    (state : RuntimeState) (attempt : ActiveDecision)
    (h : state.active = some attempt)
    (consumed : consumedEvidence attempt = true)
    (notInvalid : attempt.invalidated = false)
    (notCaptured : attempt.captured = false)
    (recorded : attempt.recordedCalls.contains callId = true)
    (fresh : attempt.staged = ResponsePlan.none)
    (invalid : validVerdict verdict = false) :
    (submitDecisionResult callId (some verdict) state).1 = .stagedInvalid ∧
      (submitDecisionResult callId (some verdict) state).2 =
        { state with
            active := some { attempt with staged := .invalid } } := by
  simp_all [submitDecisionResult, decisionAuthorized]

-- Batch and gate lemmas forbid ordinary work only inside a consumed decision response.
theorem mixed_batch_is_rejected
    (blocks : List ResponseBlock)
    (mixed : 0 < otherToolCount blocks) :
    validResponseBatch blocks = false := by
  have h :
      (otherToolCount blocks == 0) = false := by
    cases hz : otherToolCount blocks
    · omega
    · simp
  simp [validResponseBatch, h]

theorem duplicate_reserved_calls_are_rejected
    (blocks : List ResponseBlock)
    (duplicated : 1 < cwBlockCount blocks) :
    validResponseBatch blocks = false := by
  have h : (cwBlockCount blocks == 1) = false := by
    cases hz : cwBlockCount blocks
    · omega
    · simp; omega
  simp [validResponseBatch, h]

theorem visible_text_is_rejected
    (blocks : List ResponseBlock)
    (text : hasDisallowedContent blocks = true) :
    validResponseBatch blocks = false := by
  simp [validResponseBatch, text]

theorem rejected_batch_plans_invalid
    (staged : ResponsePlan) (blocks : List ResponseBlock)
    (rejected : validResponseBatch blocks = false) :
    provisionalPlan staged blocks = .invalid := by
  simp [provisionalPlan, rejected]

theorem single_call_batch_is_valid
    (verdict : Verdict) :
    validResponseBatch (singleCallBatch verdict) = true ∧
      verdictOf (singleCallBatch verdict) = some verdict ∧
      toolCallIds (singleCallBatch verdict) = [1] := by
  simp [validResponseBatch, cwBlockCount, otherToolCount,
    hasDisallowedContent, verdictOf, toolCallIds, singleCallBatch]

theorem thinking_is_permitted
    (verdict : Verdict) :
    validResponseBatch [.thinking, .cwCall 1 (some verdict)] = true := by
  simp [validResponseBatch, cwBlockCount, otherToolCount,
    hasDisallowedContent]

theorem foreign_tool_call_is_blocked
    (callId : ToolCallId) (state : RuntimeState) (attempt : ActiveDecision)
    (h : state.active = some attempt)
    (consumed : consumedEvidence attempt = true)
    (notInvalid : attempt.invalidated = false)
    (notCaptured : attempt.captured = false)
    (notAuthorized :
      (attempt.singleReservedCall && attempt.recordedCalls == [callId]) = false) :
    toolGate callId state = .blockedTerminating := by
  simp only [toolGate, h, decisionAuthorized, consumed, notInvalid, notCaptured,
    Bool.not_false, Bool.and_true, Bool.not_true, Bool.false_or]
  simp_all

theorem ordinary_work_keeps_tool_access
    (callId : ToolCallId) (state : RuntimeState)
    (noWindow : state.active = none) :
    toolGate callId state = .allowed := by
  simp [toolGate, noWindow]

theorem unstaged_verdict_counts_as_missing
    (verdict : Verdict) (state : RuntimeState) (attempt : ActiveDecision)
    (h : state.active = some attempt)
    (consumed : consumedEvidence attempt = true)
    (notInvalid : attempt.invalidated = false)
    (notCaptured : attempt.captured = false)
    (planned : attempt.planned = .verdict verdict)
    (unstaged : attempt.staged = ResponsePlan.none) :
    (captureSettlement state).active =
      some { attempt with planned := .invalid, captured := true } := by
  simp [captureSettlement, decisionAuthorized, h, consumed, notInvalid, notCaptured, planned,
    unstaged]

-- Outcome lemmas establish exact retry charges, fresh correction evidence, and the third-invalid terminal state.
theorem accepted_continue_consumes_one_attempt
    (now : NowMs) (state : RuntimeState) (attempt : ActiveDecision)
    {reasonType reason : String}
    (h : state.active = some attempt)
    (consumed : consumedEvidence attempt = true)
    (captured : attempt.captured = true)
    (notInvalid : attempt.invalidated = false)
    (planned : attempt.planned = .verdict (.cont reasonType reason)) :
    (finalizeDecision now true state).1 = .continued ∧
      (finalizeDecision now true state).2.attempt = state.attempt + 1 ∧
      (finalizeDecision now true state).2.active.isNone = true := by
  simp [finalizeDecision, decisionAuthorized, consumed, h, captured, notInvalid, planned]

theorem accepted_unlock_unlocks_without_attempt
    (now : NowMs) (state : RuntimeState) (attempt : ActiveDecision)
    {reasonType reason : String}
    (h : state.active = some attempt)
    (consumed : consumedEvidence attempt = true)
    (captured : attempt.captured = true)
    (notInvalid : attempt.invalidated = false)
    (planned : attempt.planned = .verdict (.unlock reasonType reason)) :
    (finalizeDecision now true state).1 = .unlocked ∧
      (finalizeDecision now true state).2.locked = false ∧
      (finalizeDecision now true state).2.attempt = state.attempt ∧
      (finalizeDecision now true state).2.active.isNone = true := by
  simp [finalizeDecision, decisionAuthorized, consumed, h, captured, notInvalid, planned]

theorem early_invalid_reasks_with_fresh_evidence
    (now : NowMs) (state : RuntimeState) (attempt : ActiveDecision)
    (h : state.active = some attempt)
    (consumed : consumedEvidence attempt = true)
    (captured : attempt.captured = true)
    (notInvalid : attempt.invalidated = false)
    (planned : attempt.planned = .invalid)
    (withinBudget : state.invalidAttempts + 1 < invalidDecisionLimit) :
    (finalizeDecision now true state).1 = .reask ∧
      (finalizeDecision now true state).2.attempt = state.attempt ∧
      (finalizeDecision now true state).2.invalidAttempts =
        state.invalidAttempts + 1 ∧
      ∃ fresh,
        (finalizeDecision now true state).2.active = some fresh ∧
          fresh.cycle = attempt.cycle + 1 ∧
          consumedEvidence fresh = false ∧
          fresh.staged = ResponsePlan.none ∧
          fresh.recordedCalls = [] := by
  simp [finalizeDecision, decisionAuthorized, consumed, h, captured, notInvalid, planned, withinBudget]
  rfl

theorem third_invalid_fails_the_decision
    (now : NowMs) (state : RuntimeState) (attempt : ActiveDecision)
    (h : state.active = some attempt)
    (consumed : consumedEvidence attempt = true)
    (captured : attempt.captured = true)
    (notInvalid : attempt.invalidated = false)
    (planned : attempt.planned = .invalid)
    (atLimit : invalidDecisionLimit ≤ state.invalidAttempts + 1) :
    (finalizeDecision now true state).1 = .decisionFailed ∧
      (finalizeDecision now true state).2.attempt = state.attempt ∧
      (finalizeDecision now true state).2.invalidAttempts =
        invalidDecisionLimit ∧
      (finalizeDecision now true state).2.decisionFailed = true ∧
      (finalizeDecision now true state).2.active.isNone = true := by
  have hnot : ¬ (state.invalidAttempts + 1 < invalidDecisionLimit) := by omega
  simp [finalizeDecision, decisionAuthorized, consumed, h, captured, notInvalid, planned, hnot]

-- Recovery and postcondition lemmas preserve publication rollback and takeover cancellation.
theorem rollback_restores_failed_publication
    (state : RuntimeState)
    (windowClosed : state.active.isNone = true)
    (spent : 0 < state.attempt) :
    (rollbackContinue state).attempt = state.attempt - 1 := by
  simp [rollbackContinue, windowClosed, spent]

-- Exhaustion eligibility uses aggregate idle only; no retired wait deadline defers it.
theorem exhaustion_eligibility_ignores_retired_waits
    (state : RuntimeState) :
    exhaustionEligible state =
      (state.locked && exhausted state && aggregateIdle state) := by
  rfl

theorem busy_children_block_terminal_publication
    (state : RuntimeState)
    (busy : state.busyChildren ≠ []) :
    exhaustionEligible state = false ∧
      decisionFailedEligible state = false := by
  have h : state.busyChildren.isEmpty = false := by
    cases hc : state.busyChildren with
    | nil => exact absurd hc busy
    | cons _ _ => rfl
  simp [exhaustionEligible, decisionFailedEligible, aggregateIdle, h]

theorem takeover_closes_window_without_budget
    (state : RuntimeState) :
    (preemptActiveDecision state).active.isNone = true ∧
      (preemptActiveDecision state).attempt = state.attempt ∧
      (preemptActiveDecision state).invalidAttempts = state.invalidAttempts ∧
      (preemptActiveDecision state).decisionFailed = state.decisionFailed := by
  cases h : state.active with
  | none => simp [preemptActiveDecision, h]
  | some attempt => simp [preemptActiveDecision, h]

theorem late_submission_after_preempt_is_unauthorized
    (callId : ToolCallId) (verdict : Option Verdict)
    (state : RuntimeState) :
    (submitDecisionResult callId verdict (preemptActiveDecision state)).1 =
      .unauthorized := by
  unfold preemptActiveDecision
  cases h : state.active with
  | none => simp [submitDecisionResult, h]
  | some attempt => simp [submitDecisionResult]

theorem manual_unlock_cancels_window_and_fence
    (state : RuntimeState) :
    (manualUnlock state).locked = false ∧
      (manualUnlock state).active.isNone = true ∧
      (manualUnlock state).fence = none ∧
      (manualUnlock state).attempt = state.attempt := by
  cases h : state.active with
  | none => simp [manualUnlock, preemptActiveDecision, h]
  | some attempt => simp [manualUnlock, preemptActiveDecision, h]

theorem fresh_cycle_resets_budget
    (state : RuntimeState) :
    (freshLockCycle state).attempt = 0 ∧
      (freshLockCycle state).invalidAttempts = 0 ∧
      (freshLockCycle state).decisionFailed = false ∧
      (freshLockCycle state).exhaustionPublished = false ∧
      (freshLockCycle state).active.isNone = true := by
  simp [freshLockCycle]

-- Closed attempts have no remaining submission authority; invalid-response accounting stays bounded.
theorem finalized_window_grants_no_submission_authority
    (now : NowMs) (state : RuntimeState) (callId : ToolCallId)
    (finished : (finalizeDecision now true state).1 ≠ .deferred) :
    ((finalizeDecision now true state).2.active.all fun attempt =>
        !submissionAuthorizedFor attempt callId) = true := by
  cases h : state.active with
  | none => simp [finalizeDecision, h] at finished
  | some attempt =>
      cases ha : decisionAuthorized attempt with
      | false => simp [finalizeDecision, h, ha] at finished
      | true =>
          cases hc : attempt.captured with
          | false => simp [finalizeDecision, h, ha, hc] at finished
          | true =>
              cases hp : attempt.planned with
              | none => simp [finalizeDecision, h, ha, hc, hp] at finished
              | verdict v => cases v <;> simp [finalizeDecision, h, ha, hc, hp]
              | invalid =>
                  simp only [finalizeDecision, h, ha, hc, hp, Bool.not_true,
                    Bool.false_or, Bool.false_eq_true, ite_false]
                  split <;> simp [submissionAuthorizedFor, decisionAuthorized,
                    consumedEvidence]

theorem invalid_attempts_stay_bounded
    (now : NowMs) (state : RuntimeState)
    (bounded : state.invalidAttempts ≤ invalidDecisionLimit) :
    (finalizeDecision now true state).2.invalidAttempts ≤
      invalidDecisionLimit := by
  cases h : state.active with
  | none => simpa [finalizeDecision, h] using bounded
  | some attempt =>
      simp only [finalizeDecision, h]
      split
      · exact bounded
      · split
        · exact bounded
        · cases hp : attempt.planned with
          | none => simpa [hp] using bounded
          | verdict v => cases v <;> simpa [hp] using bounded
          | invalid =>
              simp only
              split <;> simp_all <;> omega

-- Payload-boundary and presentation lemmas constrain normalization, lengths, status, and extension authorship.
theorem normalized_type_comes_from_configuration
    (supplied : String) (allowed : List String) (normalized : String)
    (h : normalizeDecisionReasonType supplied allowed = some normalized) :
    ∃ entry,
      entry ∈ allowed ∧
        equalsIgnoreCase entry supplied = true ∧
        entry.toUpper = normalized := by
  simp only [normalizeDecisionReasonType] at h
  split at h
  · contradiction
  · rename_i entry rest heq
    have hm : entry ∈ allowed.filter (fun e => equalsIgnoreCase e supplied) := by
      rw [heq]
      exact List.mem_cons_self
    exact ⟨entry, (List.mem_filter.mp hm).1, (List.mem_filter.mp hm).2,
      Option.some.inj h⟩

theorem oversized_reason_is_invalid
    (reason : String)
    (oversized : maxReasonLength < reason.length) :
    validVerdict (.cont "WORK_REMAINS" reason) = false ∧
      validVerdict (.unlock "JOB_DONE" reason) = false := by
  simp [validVerdict, Nat.not_le_of_gt oversized]

theorem status_activity_matches_idle_children
    (state : RuntimeState) :
    (projectStatus state).activity = .idle ↔
      (state.mainIdle = true ∧ state.busyChildren.isEmpty = true) := by
  simp [projectStatus, statusActivity]

theorem status_projection_uses_only_observed_busy_state
    (state : RuntimeState) :
    (projectStatus state).enabled = state.locked ∧
      (projectStatus state).rootRunning = !state.mainIdle ∧
      (projectStatus state).busyObservedSubagents = state.busyChildren.length := by
  simp [projectStatus]

theorem shared_event_body_is_identical
    (event : SharedEvent) :
    humanEventBody event = modelEventBody event := by
  rfl

theorem shared_timeline_append_preserves_order
    (timeline : List SharedEvent)
    (event : SharedEvent) :
    appendSharedEvent timeline event = timeline ++ [event] := by
  rfl

theorem continuation_is_extension_authored
    (guidance reasonType reason : String) :
    (buildContinuationEnvelope guidance reasonType reason).extensionAuthored =
      true ∧
      (buildContinuationEnvelope guidance reasonType reason).userAuthored =
        false := by
  simp [buildContinuationEnvelope]

theorem continuation_does_not_authorize
    (guidance reasonType reason : String) :
    (buildContinuationEnvelope guidance reasonType reason).conveysUserAuthorization =
      false ∧
      (buildContinuationEnvelope guidance reasonType reason).stopAtUserBoundary =
        true := by
  simp [buildContinuationEnvelope]

theorem continuation_requires_completeness_check
    (guidance reasonType reason : String) :
    (buildContinuationEnvelope guidance reasonType reason).checksEveryRequestedTask =
      true := by
  simp [buildContinuationEnvelope]

theorem continuation_teaches_no_function_use
    (guidance reasonType reason : String) :
    (buildContinuationEnvelope guidance reasonType reason).teachesReservedFunctionUse =
      false := by
  simp [buildContinuationEnvelope]

theorem continuation_carries_accepted_reason
    (guidance reasonType reason : String) :
    (buildContinuationEnvelope guidance reasonType reason).reasonType =
      reasonType ∧
      (buildContinuationEnvelope guidance reasonType reason).reason = reason ∧
      (buildContinuationEnvelope guidance reasonType reason).guidance =
        guidance := by
  simp [buildContinuationEnvelope]

theorem continuation_presents_reason_once_as_next_step
    (guidance reasonType reason : String) :
    (buildContinuationEnvelope guidance reasonType reason).presentsReasonAsNextStep =
      true ∧
      (buildContinuationEnvelope guidance reasonType reason).duplicatesReasonAsHistory =
        false ∧
      (buildContinuationEnvelope guidance reasonType reason).checksLatestDelivery =
        true ∧
      (buildContinuationEnvelope guidance reasonType reason).preservesGrantedPermission =
        true := by
  simp [buildContinuationEnvelope]

theorem continuation_envelope_shape
    (guidance reasonType reason : String) :
    let envelope := buildContinuationEnvelope guidance reasonType reason
    envelope.extensionAuthored = true ∧
      envelope.userAuthored = false ∧
      envelope.conveysUserAuthorization = false ∧
      envelope.teachesReservedFunctionUse = false ∧
      envelope.presentsReasonAsNextStep = true ∧
      envelope.duplicatesReasonAsHistory = false ∧
      envelope.checksLatestDelivery = true ∧
      envelope.preservesGrantedPermission = true ∧
      envelope.reasonType = reasonType ∧
      envelope.reason = reason ∧
      envelope.guidance = guidance := by
  simp [buildContinuationEnvelope]

theorem unlock_status_is_quiet_and_human_only
    (reasonType reason : String) :
    (buildUnlockStatus reasonType reason).humanOnly = true ∧
      (buildUnlockStatus reasonType reason).modelBound = false ∧
      (buildUnlockStatus reasonType reason).carriesTimestampBoxOrDisclaimer =
        false := by
  simp [buildUnlockStatus]

-- Native summary projection keeps exactly continuations and unowned records.
theorem summary_projection_keeps_continuations_and_unowned_only :
    (∀ correlation,
      summarizeKeeps (.continuationFold correlation) = true ∧
        summarizeKeeps (.unownedRecord "user") = true) ∧
    (∀ correlation,
      summarizeKeeps (.ownedFinalizedExchange correlation) = false ∧
        summarizeKeeps (.ownedInvalidatedExchange correlation) = false ∧
        summarizeKeeps (.legacyControlReplacement correlation) = false ∧
        summarizeKeeps .unlockStatus = false) := by
  refine ⟨fun _ => ⟨rfl, rfl⟩, fun _ => ⟨rfl, rfl, rfl, rfl⟩⟩

theorem reserved_function_declaration_is_minimal :
    reservedFunctionDeclaration.name = "cw" ∧
      reservedFunctionDeclaration.description = "don't use unless ask" ∧
      reservedFunctionDeclaration.declaresArguments = true ∧
      reservedFunctionDeclaration.exposesReasonEnums = true ∧
      reservedFunctionDeclaration.explainsParametersInDeclaration = false ∧
      reservedFunctionDeclaration.rootOnly = true := by
  simp [reservedFunctionDeclaration]

-- Each admitted valid inquiry reaches its required outcome; three consumed invalid responses fail closed.
theorem guarded_continue_cycle_reaches_outcome
    (environment : EnvironmentAssumptions)
    (admitted : environmentAdmitted environment)
    (now : NowMs) (state : RuntimeState) (reasonType reason : String)
    (eligible : decisionEligibleAt state now = true)
    (valid : validVerdict (.cont reasonType reason) = true) :
    (runGuardedInquiry environment now (.cont reasonType reason) state).1 =
      .continued ∧
      (runGuardedInquiry environment now (.cont reasonType reason) state).2.attempt =
        state.attempt + 1 ∧
      (runGuardedInquiry environment now (.cont reasonType reason) state).2.active.isNone =
        true := by
  obtain ⟨h1, h2, h3, h4, h5, h6⟩ := admitted
  simp [runGuardedInquiry, h1, h2, h3, h4, h5, h6, beginDecision, eligible,
    dispatchPrompt, observeRunStart, observeProviderContext, preflightResponse,
    singleCallBatch, provisionalPlan, submitDecisionResult, captureSettlement,
    finalizeDecision, valid, freshAttempt, consumedEvidence, decisionAuthorized,
    validResponseBatch, cwBlockCount, otherToolCount, hasDisallowedContent,
    verdictOf, toolCallIds]

theorem guarded_unlock_cycle_reaches_outcome
    (environment : EnvironmentAssumptions)
    (admitted : environmentAdmitted environment)
    (now : NowMs) (state : RuntimeState) (reasonType reason : String)
    (eligible : decisionEligibleAt state now = true)
    (valid : validVerdict (.unlock reasonType reason) = true) :
    (runGuardedInquiry environment now (.unlock reasonType reason) state).1 =
      .unlocked ∧
      (runGuardedInquiry environment now (.unlock reasonType reason) state).2.locked =
        false ∧
      (runGuardedInquiry environment now (.unlock reasonType reason) state).2.attempt =
        state.attempt := by
  obtain ⟨h1, h2, h3, h4, h5, h6⟩ := admitted
  simp [runGuardedInquiry, h1, h2, h3, h4, h5, h6, beginDecision, eligible,
    dispatchPrompt, observeRunStart, observeProviderContext, preflightResponse,
    singleCallBatch, provisionalPlan, submitDecisionResult, captureSettlement,
    finalizeDecision, valid, freshAttempt, consumedEvidence, decisionAuthorized,
    validResponseBatch, cwBlockCount, otherToolCount, hasDisallowedContent,
    verdictOf, toolCallIds]

theorem three_invalid_responses_fail_the_decision
    (environment : EnvironmentAssumptions)
    (admitted : environmentAdmitted environment)
    (now1 now2 now3 : NowMs) (state : RuntimeState)
    (eligible : decisionEligibleAt state now1 = true) :
    (runGuardedInvalidResponse environment now3
        (runGuardedInvalidResponse environment now2
          (runGuardedInvalidResponse environment now1 state).2).2).1 =
      .decisionFailed ∧
    (runGuardedInvalidResponse environment now3
        (runGuardedInvalidResponse environment now2
          (runGuardedInvalidResponse environment now1 state).2).2).2.attempt =
      state.attempt ∧
    (runGuardedInvalidResponse environment now3
        (runGuardedInvalidResponse environment now2
          (runGuardedInvalidResponse environment now1 state).2).2).2.decisionFailed =
      true := by
  obtain ⟨h1, h2, h3, h4, h5, h6⟩ := admitted
  have opened : beginDecision now1 state =
      { state with
        active := some (freshAttempt state.nextDecisionId)
        invalidAttempts := 0
        nextDecisionId := state.nextDecisionId + 1
        fence := none } := by simp [beginDecision, eligible]
  simp only [runGuardedInvalidResponse, h1, h2, h3, h4, h5, h6,
    ite_true, opened]
  simp [beginDecision, dispatchPrompt, observeRunStart, observeProviderContext,
    preflightResponse, invalidBatch, provisionalPlan, captureSettlement,
    finalizeDecision, freshAttempt, consumedEvidence, decisionAuthorized,
    validResponseBatch, cwBlockCount, otherToolCount, hasDisallowedContent,
    decisionEligibleAt, fenceEligible, invalidDecisionLimit]

-- This bundle keeps the established transition-level obligations visible without claiming a live-host proof.
def ProcessSafety : Prop :=
    (∀ eventA eventB idle state,
      observeMainEvent eventA idle state = observeMainEvent eventB idle state) ∧
    (∀ agentId state,
      (childConnected agentId state).busyChildren = state.busyChildren) ∧
    (∀ state, (reportMainState false state).fence = none) ∧
    (∀ idle state,
      (fenceEligible { state with mainIdle := idle } = true →
        (reportMainState idle state).fence.map (·.token) =
          some ((state.fence.map (·.token)).getD 0 + 1)) ∧
      (fenceEligible { state with mainIdle := idle } = false →
        (reportMainState idle state).fence = none)) ∧
    (∀ state, fenceEligible state = true →
      ((replaceFence state).fence.map (·.remainingSeconds)).getD 0 =
        fixedIdleDelaySeconds) ∧
    (∀ now state, state.fence = none → timerTick now state = state) ∧
    (∀ now state, decisionEligibleAt state now = false →
      beginDecision now state = state) ∧
    (∀ callId verdict state, state.active = none →
      (submitDecisionResult callId verdict state).1 = .unauthorized ∧
        (submitDecisionResult callId verdict state).2 = state) ∧
    (∀ callId verdict state attempt, state.active = some attempt →
      consumedEvidence attempt = false →
      (submitDecisionResult callId verdict state).1 = .unauthorized ∧
        (submitDecisionResult callId verdict state).2 = state) ∧
    (∀ callId verdict state attempt, state.active = some attempt →
      consumedEvidence attempt = true → attempt.invalidated = false →
      attempt.captured = false →
      attempt.recordedCalls.contains callId = false →
      (submitDecisionResult callId verdict state).1 = .unauthorized ∧
        (submitDecisionResult callId verdict state).2 = state) ∧
    (∀ callId verdict state attempt, state.active = some attempt →
      consumedEvidence attempt = true → attempt.invalidated = false →
      attempt.captured = false →
      attempt.recordedCalls.contains callId = true →
      attempt.staged ≠ ResponsePlan.none →
      (submitDecisionResult callId verdict state).1 = .duplicate ∧
        (submitDecisionResult callId verdict state).2 = state) ∧
    (∀ blocks, 0 < otherToolCount blocks → validResponseBatch blocks = false) ∧
    (∀ blocks, 1 < cwBlockCount blocks → validResponseBatch blocks = false) ∧
    (∀ blocks, hasDisallowedContent blocks = true →
      validResponseBatch blocks = false) ∧
    (∀ staged blocks, validResponseBatch blocks = false →
      provisionalPlan staged blocks = .invalid) ∧
    (∀ callId state attempt, state.active = some attempt →
      consumedEvidence attempt = true → attempt.invalidated = false →
      attempt.captured = false →
      (attempt.singleReservedCall && attempt.recordedCalls == [callId]) = false →
      toolGate callId state = .blockedTerminating) ∧
    (∀ callId state, state.active = none →
      toolGate callId state = .allowed) ∧
    (∀ now state attempt reasonType reason, state.active = some attempt →
      consumedEvidence attempt = true →
      attempt.captured = true → attempt.invalidated = false →
      attempt.planned = .verdict (.cont reasonType reason) →
      (finalizeDecision now true state).1 = .continued ∧
        (finalizeDecision now true state).2.attempt = state.attempt + 1 ∧
        (finalizeDecision now true state).2.active.isNone = true) ∧
    (∀ now state attempt reasonType reason, state.active = some attempt →
      consumedEvidence attempt = true →
      attempt.captured = true → attempt.invalidated = false →
      attempt.planned = .verdict (.unlock reasonType reason) →
      (finalizeDecision now true state).1 = .unlocked ∧
        (finalizeDecision now true state).2.locked = false ∧
        (finalizeDecision now true state).2.attempt = state.attempt ∧
        (finalizeDecision now true state).2.active.isNone = true) ∧
    (∀ now state attempt, state.active = some attempt →
      consumedEvidence attempt = true →
      attempt.captured = true → attempt.invalidated = false →
      attempt.planned = .invalid →
      state.invalidAttempts + 1 < invalidDecisionLimit →
      (finalizeDecision now true state).2.attempt = state.attempt ∧
        (finalizeDecision now true state).2.invalidAttempts =
          state.invalidAttempts + 1 ∧
        (finalizeDecision now true state).2.active.isSome = true) ∧
    (∀ now state attempt, state.active = some attempt →
      consumedEvidence attempt = true →
      attempt.captured = true → attempt.invalidated = false →
      attempt.planned = .invalid →
      invalidDecisionLimit ≤ state.invalidAttempts + 1 →
      (finalizeDecision now true state).2.attempt = state.attempt ∧
        (finalizeDecision now true state).2.decisionFailed = true ∧
        (finalizeDecision now true state).2.active.isNone = true) ∧
    (∀ state, state.active.isNone = true → 0 < state.attempt →
      (rollbackContinue state).attempt = state.attempt - 1) ∧
    (∀ state, exhaustionEligible state =
      (state.locked && exhausted state && aggregateIdle state)) ∧
    (∀ state, state.busyChildren ≠ [] →
      exhaustionEligible state = false ∧
        decisionFailedEligible state = false) ∧
    (∀ state, (preemptActiveDecision state).active.isNone = true ∧
      (preemptActiveDecision state).attempt = state.attempt) ∧
    (∀ callId verdict state,
      (submitDecisionResult callId verdict (preemptActiveDecision state)).1 =
        .unauthorized) ∧
    (∀ state, (manualUnlock state).locked = false ∧
      (manualUnlock state).active.isNone = true ∧
      (manualUnlock state).attempt = state.attempt) ∧
    (∀ now state callId, (finalizeDecision now true state).1 ≠ .deferred →
      ((finalizeDecision now true state).2.active.all fun attempt =>
          !submissionAuthorizedFor attempt callId) = true) ∧
    (∀ now state, state.invalidAttempts ≤ invalidDecisionLimit →
      (finalizeDecision now true state).2.invalidAttempts ≤
        invalidDecisionLimit) ∧
    (∀ guidance reasonType reason,
      (buildContinuationEnvelope guidance reasonType reason).extensionAuthored =
        true ∧
        (buildContinuationEnvelope guidance reasonType reason).userAuthored =
          false ∧
        (buildContinuationEnvelope guidance reasonType reason).conveysUserAuthorization =
          false ∧
        (buildContinuationEnvelope guidance reasonType reason).teachesReservedFunctionUse =
          false ∧
        (buildContinuationEnvelope guidance reasonType reason).reasonType =
          reasonType ∧
        (buildContinuationEnvelope guidance reasonType reason).reason = reason ∧
        (buildContinuationEnvelope guidance reasonType reason).guidance =
          guidance) ∧
    (∀ event, humanEventBody event = modelEventBody event) ∧
    (reservedFunctionDeclaration.name = "cw" ∧
      reservedFunctionDeclaration.description = "don't use unless ask" ∧
      reservedFunctionDeclaration.declaresArguments = true ∧
      reservedFunctionDeclaration.exposesReasonEnums = true ∧
      reservedFunctionDeclaration.explainsParametersInDeclaration = false ∧
      reservedFunctionDeclaration.rootOnly = true) ∧
    (∀ guidance reasonType reason,
      let envelope := buildContinuationEnvelope guidance reasonType reason
      envelope.extensionAuthored = true ∧
        envelope.userAuthored = false ∧
        envelope.conveysUserAuthorization = false ∧
        envelope.teachesReservedFunctionUse = false ∧
        envelope.presentsReasonAsNextStep = true ∧
        envelope.duplicatesReasonAsHistory = false ∧
        envelope.checksLatestDelivery = true ∧
        envelope.preservesGrantedPermission = true ∧
        envelope.reasonType = reasonType ∧
        envelope.reason = reason ∧
        envelope.guidance = guidance) ∧
    (∀ reasonType reason,
      let status := buildUnlockStatus reasonType reason
      status.humanOnly = true ∧
        status.modelBound = false ∧
        status.carriesTimestampBoxOrDisclaimer = false) ∧
    ((∀ correlation,
        summarizeKeeps (.continuationFold correlation) = true ∧
          summarizeKeeps (.unownedRecord "user") = true) ∧
      (∀ correlation,
        summarizeKeeps (.ownedFinalizedExchange correlation) = false ∧
          summarizeKeeps (.ownedInvalidatedExchange correlation) = false ∧
          summarizeKeeps (.legacyControlReplacement correlation) = false ∧
          summarizeKeeps .unlockStatus = false))

-- The unchanged observation/recovery guarantees and corrected consumption guards jointly satisfy the bundle.
theorem transition_invariants : ProcessSafety := by
  refine ⟨main_event_label_is_not_activity,
    connected_child_does_not_change_activity,
    main_activity_cancels_candidate, idle_report_replaces_fence_token,
    fence_arm_targets_full_fixed_delay, stale_timer_is_inert,
    ineligible_begin_is_noop, submission_without_window_is_unauthorized,
    queued_prompt_cannot_authorize, unrecorded_call_identity_is_unauthorized,
    second_submission_is_duplicate, mixed_batch_is_rejected,
    duplicate_reserved_calls_are_rejected, visible_text_is_rejected,
    rejected_batch_plans_invalid, foreign_tool_call_is_blocked,
    ordinary_work_keeps_tool_access, ?_, ?_, ?_, ?_,
    rollback_restores_failed_publication,
    exhaustion_eligibility_ignores_retired_waits,
    busy_children_block_terminal_publication,
    ?_, late_submission_after_preempt_is_unauthorized, ?_,
    finalized_window_grants_no_submission_authority,
    invalid_attempts_stay_bounded, ?_, shared_event_body_is_identical,
    ⟨reserved_function_declaration_is_minimal,
      @continuation_envelope_shape,
      @unlock_status_is_quiet_and_human_only,
      summary_projection_keeps_continuations_and_unowned_only⟩⟩
  · intro now state attempt reasonType reason h consumed captured notInvalid planned
    have p := accepted_continue_consumes_one_attempt now state attempt h consumed
      captured notInvalid planned
    exact ⟨p.1, p.2.1, p.2.2⟩
  · intro now state attempt reasonType reason h consumed captured notInvalid planned
    have p := accepted_unlock_unlocks_without_attempt now state attempt h consumed
      captured notInvalid planned
    exact ⟨p.1, p.2.1, p.2.2.1, p.2.2.2⟩
  · intro now state attempt h consumed captured notInvalid planned withinBudget
    have p := early_invalid_reasks_with_fresh_evidence now state attempt h consumed
      captured notInvalid planned withinBudget
    obtain ⟨fresh, hfresh, _⟩ := p.2.2.2
    exact ⟨p.2.1, p.2.2.1, by simp [hfresh]⟩
  · intro now state attempt h consumed captured notInvalid planned atLimit
    have p := third_invalid_fails_the_decision now state attempt h consumed captured
      notInvalid planned atLimit
    exact ⟨p.2.1, p.2.2.2.1, p.2.2.2.2⟩
  · intro state
    have p := takeover_closes_window_without_budget state
    exact ⟨p.1, p.2.1⟩
  · intro state
    have p := manual_unlock_cancels_window_and_fence state
    exact ⟨p.1, p.2.1, p.2.2.2⟩
  · intro guidance reasonType reason
    simp [buildContinuationEnvelope]

-- An unconsumed pipeline neither captures ordinary replies nor blocks tools nor spends either retry budget.
theorem unconsumed_pipeline_is_inert
    (state : RuntimeState) (attempt : ActiveDecision)
    (h : state.active = some attempt)
    (unconsumed : consumedEvidence attempt = false)
    (blocks : List ResponseBlock) (callId : ToolCallId)
    (verdict : Option Verdict) (now : NowMs) :
    preflightResponse blocks state = state ∧
    toolGate callId state = .allowed ∧
    submitDecisionResult callId verdict state = (.unauthorized, state) ∧
    captureSettlement state = state ∧
    (finalizeDecision now true state).2.attempt = state.attempt ∧
    (finalizeDecision now true state).2.invalidAttempts = state.invalidAttempts ∧
    (finalizeDecision now true state).2.locked = state.locked := by
  simp [preflightResponse, toolGate, submitDecisionResult, captureSettlement,
    finalizeDecision, decisionAuthorized, h, unconsumed]

-- Required outcomes make conditional end-to-end termination explicit rather than relying on example execution.
def requiredOutcome : Verdict → FinalOutcome
  | .cont .. => .continued
  | .unlock .. => .unlocked

theorem guarded_inquiry_terminates
    (environment : EnvironmentAssumptions)
    (admitted : environmentAdmitted environment)
    (now : NowMs) (state : RuntimeState) (verdict : Verdict)
    (eligible : decisionEligibleAt state now = true)
    (valid : validVerdict verdict = true) :
    (runGuardedInquiry environment now verdict state).1 = requiredOutcome verdict := by
  cases verdict with
  | cont reasonType reason =>
      exact (guarded_continue_cycle_reaches_outcome environment admitted now state
        reasonType reason eligible valid).1
  | unlock reasonType reason =>
      exact (guarded_unlock_cycle_reaches_outcome environment admitted now state
        reasonType reason eligible valid).1

-- Whole-inquiry correctness combines safety, unauthorized inertness, context revocation, and bounded progress.
-- Runtime scheduling, metadata authenticity, parser correctness, and durable I/O remain external obligations.
theorem process_is_correct : ProcessSafety ∧
    (∀ state attempt, state.active = some attempt → consumedEvidence attempt = false →
      ∀ blocks callId verdict now,
        preflightResponse blocks state = state ∧
        toolGate callId state = .allowed ∧
        submitDecisionResult callId verdict state = (.unauthorized, state) ∧
        captureSettlement state = state ∧
        (finalizeDecision now true state).2.attempt = state.attempt ∧
        (finalizeDecision now true state).2.invalidAttempts = state.invalidAttempts ∧
        (finalizeDecision now true state).2.locked = state.locked) ∧
    (∀ state, ((observeProviderContext false state).active.all fun attempt =>
      !decisionAuthorized attempt) = true) ∧
    (∀ environment, environmentAdmitted environment →
      ∀ now state verdict, decisionEligibleAt state now = true →
        validVerdict verdict = true →
        (runGuardedInquiry environment now verdict state).1 = requiredOutcome verdict) ∧
    (∀ environment, environmentAdmitted environment →
      ∀ now1 now2 now3 state, decisionEligibleAt state now1 = true →
        (runGuardedInvalidResponse environment now3
          (runGuardedInvalidResponse environment now2
            (runGuardedInvalidResponse environment now1 state).2).2).1 = .decisionFailed ∧
        (runGuardedInvalidResponse environment now3
          (runGuardedInvalidResponse environment now2
            (runGuardedInvalidResponse environment now1 state).2).2).2.attempt = state.attempt ∧
        (runGuardedInvalidResponse environment now3
          (runGuardedInvalidResponse environment now2
            (runGuardedInvalidResponse environment now1 state).2).2).2.decisionFailed = true) ∧
    (∀ state, providerFailureAt .agentEnd state = state ∧
      (providerFailureAt .agentSettled state).locked = false ∧
      (providerFailureAt .agentSettled state).active = none ∧
      (providerFailureAt .agentSettled state).attempt = state.attempt ∧
      (providerFailureAt .agentSettled state).invalidAttempts = state.invalidAttempts) ∧
    NativeTransportSafety ∧ stagedResultIsError .stagedInvalid = true ∧
    (∀ current attempt, receiptAccount current .unreadable attempt = attempt) :=
  ⟨transition_invariants, unconsumed_pipeline_is_inert, foreign_context_does_not_confirm,
    guarded_inquiry_terminates, three_invalid_responses_fail_the_decision,
    provider_failures_preserve_budgets, native_transport_is_guarded,
    staged_validation_is_error, unreadable_receipt_preserves_budget⟩

end OfficialPiIdleInquiry

#print axioms OfficialPiIdleInquiry.process_is_correct

-- Deterministic smoke traces illustrate accounting; the closed theorem above is the proof evidence.
def main : IO Unit := do
  let environment : OfficialPiIdleInquiry.EnvironmentAssumptions :=
    ⟨true, true, true, true, true, true⟩
  let initial := OfficialPiIdleInquiry.initialState 2
  let continued := OfficialPiIdleInquiry.runGuardedInquiry environment 0
    (.cont "WORK_REMAINS" "Verification remains.") initial
  let callback := OfficialPiIdleInquiry.runGuardedInquiry environment 0
    (.unlock "WAIT_CALLBACK" "Waiting for the subagent callback.") continued.2
  let unlocked := OfficialPiIdleInquiry.runGuardedInquiry environment 0
    (.unlock "JOB_DONE" "Work is complete.") initial
  let invalid1 := OfficialPiIdleInquiry.runGuardedInvalidResponse environment 0 initial
  let invalid2 := OfficialPiIdleInquiry.runGuardedInvalidResponse environment 0 invalid1.2
  let invalid3 := OfficialPiIdleInquiry.runGuardedInvalidResponse environment 0 invalid2.2
  IO.println s!"continue: attempt={continued.2.attempt}; callback unlock: locked={callback.2.locked}, attempt={callback.2.attempt}"
  IO.println s!"unlock: locked={unlocked.2.locked}, attempt={unlocked.2.attempt}; three invalid: failed={invalid3.2.decisionFailed}, attempt={invalid3.2.attempt}"
  IO.println "process_is_correct: consumption-gated safety, provider failures preserve budgets until terminal unlock, and conditional inquiry termination; external scheduling and durable publication are assumptions."
