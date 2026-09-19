-- Core Lean support supplies finite lists, equality decisions, and deterministic executable summaries.
import Std

set_option autoImplicit false

namespace OfficialPiIdleInquiry

-- Process vocabulary names public Pi event triggers, child identities, fence identities, and inquiry phases.
abbrev AgentId := Nat
abbrev FenceToken := Nat

def fixedIdleDelaySeconds : Nat := 10

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

inductive InquiryPhase where
  | none
  | open
  | preempted
  | committed
  deriving DecidableEq, Repr

-- Process data separates event-driven activity, the replaceable ten-second fence, and shared-library inquiry residue.
structure InquiryState where
  phase : InquiryPhase
  resultMayAct : Bool
  streamingXmlVisible : Bool
  sessionXmlStored : Bool
  futureContextContainsXml : Bool
  tuiContainsXml : Bool
  cleanupFoldPending : Bool
  userMessagePending : Bool
  userMessageDeliveryCount : Nat
  deriving DecidableEq, Repr

structure IdleFence where
  token : FenceToken
  remainingSeconds : Nat
  deriving DecidableEq, Repr

structure RuntimeState where
  enabled : Bool
  mainIdle : Bool
  busyChildren : List AgentId
  nextFenceToken : FenceToken
  fence : Option IdleFence
  inquiry : InquiryState
  deriving DecidableEq, Repr

-- Initial constructors start with no inferred idle state, no child activity, no fence, and no inquiry residue.
def emptyInquiry : InquiryState :=
  {
    phase := .none
    resultMayAct := false
    streamingXmlVisible := false
    sessionXmlStored := false
    futureContextContainsXml := false
    tuiContainsXml := false
    cleanupFoldPending := false
    userMessagePending := false
    userMessageDeliveryCount := 0
  }

def initialState (enabled : Bool) : RuntimeState :=
  {
    enabled
    mainIdle := false
    busyChildren := []
    nextFenceToken := 0
    fence := none
    inquiry := emptyInquiry
  }

-- Guards derive eligibility only from enabled state, live main idle, an empty busy-child set, and a closed inquiry.
def aggregateIdle (state : RuntimeState) : Bool :=
  state.mainIdle && state.busyChildren.isEmpty

def inquiryClosed (state : RuntimeState) : Bool :=
  state.inquiry.phase == .none || state.inquiry.phase == .preempted

def automaticInquiryEligible (state : RuntimeState) : Bool :=
  state.enabled && aggregateIdle state && inquiryClosed state

-- Status data projects enabled state and only currently busy observable root/child participants; layout remains one bounded row.
inductive StatusActivity where
  | idle
  | running
  deriving DecidableEq, Repr

structure StatusProjection where
  activity : StatusActivity
  enabled : Bool
  rootRunning : Bool
  busyObservedSubagents : Nat
  deriving DecidableEq, Repr

structure StatusLineLayout where
  lineCount : Nat
  visibleColumns : Nat
  deriving DecidableEq, Repr

structure AcceptedContinue where
  reasonType : String
  reason : String
  guidance : String
  deriving DecidableEq, Repr

structure ContinuationEnvelope where
  extensionAuthored : Bool
  userAuthored : Bool
  conveysUserAuthorization : Bool
  reasonType : String
  reason : String
  guidance : String
  stopAtUserBoundary : Bool
  deriving DecidableEq, Repr

-- Shared automatic events carry one immutable body through both human rendering and model context.
-- Timestamp syntax and body formatting are implementation obligations tested outside this process model;
-- the model proves routing, wait identity, elapsed-time arithmetic, and invalidation rather than model judgment.
inductive SharedEventKind where
  | continued
  | waiting
  | waitCompleted
  | unlocked
  | decisionFailed
  | exhausted
  deriving DecidableEq, Repr

structure RuntimeTimestamp where
  wallClockMs : Nat
  rfc3339WithNumericOffset : String
  deriving DecidableEq, Repr

structure SharedEvent where
  kind : SharedEventKind
  occurredAt : RuntimeTimestamp
  body : String
  startsOrdinaryWork : Bool
  deriving DecidableEq, Repr

structure CurrentWait where
  identity : Nat
  acceptedAt : RuntimeTimestamp
  requestedSeconds : Nat
  deadlineMs : Nat
  deriving DecidableEq, Repr

structure WaitWakeSnapshot where
  wait : CurrentWait
  observedAt : RuntimeTimestamp
  event : SharedEvent
  deriving DecidableEq, Repr

structure ExhaustionPublication where
  eventPublished : Bool
  hookPublished : Bool
  deriving DecidableEq, Repr


def humanEventBody (event : SharedEvent) : String :=
  event.body

def modelEventBody (event : SharedEvent) : String :=
  event.body

def appendSharedEvent
    (timeline : List SharedEvent)
    (event : SharedEvent) : List SharedEvent :=
  timeline ++ [event]

def commitWait
    (identity : Nat)
    (acceptedAt : RuntimeTimestamp)
    (requestedSeconds : Nat) : CurrentWait :=
  {
    identity
    acceptedAt
    requestedSeconds
    deadlineMs := acceptedAt.wallClockMs + requestedSeconds * 1000
  }

def publishExhaustionEvent
    (state : ExhaustionPublication) : ExhaustionPublication :=
  if state.eventPublished then state
  else { state with eventPublished := true }

def observedElapsedSeconds (wake : WaitWakeSnapshot) : Nat :=
  (wake.observedAt.wallClockMs - wake.wait.acceptedAt.wallClockMs) / 1000

def waitWakeEligible (wait : CurrentWait) (observedAtMs : Nat) : Bool :=
  wait.deadlineMs ≤ observedAtMs

def invalidateCurrentWait (_wait : Option CurrentWait) : Option CurrentWait :=
  none

def reuseWakeSnapshot (wake : WaitWakeSnapshot) : WaitWakeSnapshot :=
  wake

def buildContinuationEnvelope
    (accepted : AcceptedContinue) : ContinuationEnvelope :=
  {
    extensionAuthored := true
    userAuthored := false
    conveysUserAuthorization := false
    reasonType := accepted.reasonType
    reason := accepted.reason
    guidance := accepted.guidance
    stopAtUserBoundary := true
  }

-- Decision facts formalize mutually exclusive outcome selection with the user boundary ahead of unfinished scope.
inductive DecisionOutcome where
  | waitUser
  | waitExternal
  | continueWork
  | jobDone
  | jobBlocked
  deriving DecidableEq, Repr

structure DecisionFacts where
  userActionRequired : Bool
  externalWaitRequired : Bool
  immediateAuthorizedAction : Bool
  allWorkComplete : Bool
  deriving DecidableEq, Repr

-- Facts represent requests reconciled with actual delivery, not stale plans or stop markers.
-- This classifier specifies the policy; it does not prove an LLM extracts these facts correctly.
def selectDecisionOutcome (facts : DecisionFacts) : DecisionOutcome :=
  if facts.allWorkComplete then
    .jobDone
  else if facts.immediateAuthorizedAction then
    .continueWork
  else if facts.userActionRequired then
    .waitUser
  else if facts.externalWaitRequired then
    .waitExternal
  else
    .jobBlocked

def statusActivity (state : RuntimeState) : StatusActivity :=
  if aggregateIdle state then .idle else .running

def projectStatus (state : RuntimeState) : StatusProjection :=
  {
    activity := statusActivity state
    enabled := state.enabled
    rootRunning := !state.mainIdle
    busyObservedSubagents := state.busyChildren.length
  }

def statusRowVisible
    (hasTui ownsMain controllerReady : Bool) : Bool :=
  hasTui && ownsMain && controllerReady

def layoutStatusLine
    (availableColumns preferredColumns : Nat) : StatusLineLayout :=
  {
    lineCount := 1
    visibleColumns := min availableColumns preferredColumns
  }

-- Event transitions always replace the old fence; child connect is neutral, while idle reports and disconnect remove every matching busy id.
def replaceFence (state : RuntimeState) : RuntimeState :=
  let token := state.nextFenceToken + 1
  let invalidated := { state with nextFenceToken := token, fence := none }
  if automaticInquiryEligible invalidated then
    { invalidated with
      fence := some {
        token
        remainingSeconds := fixedIdleDelaySeconds
      } }
  else
    invalidated

def reportMainState (idle : Bool) (state : RuntimeState) : RuntimeState :=
  replaceFence { state with mainIdle := idle }

def removeChild
    (agentId : AgentId)
    (children : List AgentId) : List AgentId :=
  children.filter fun child => child != agentId

def reportChildState
    (agentId : AgentId)
    (idle : Bool)
    (state : RuntimeState) : RuntimeState :=
  let withoutAgent := removeChild agentId state.busyChildren
  let children := if idle then withoutAgent else agentId :: withoutAgent
  replaceFence { state with busyChildren := children }

def observeMainEvent
    (_event : PiPublicEvent)
    (liveOfficialIdle : Bool)
    (state : RuntimeState) : RuntimeState :=
  reportMainState liveOfficialIdle state

def observeChildEvent
    (_event : PiPublicEvent)
    (agentId : AgentId)
    (liveOfficialIdle : Bool)
    (state : RuntimeState) : RuntimeState :=
  reportChildState agentId liveOfficialIdle state

def childConnected (_agentId : AgentId) (state : RuntimeState) : RuntimeState :=
  state

def childDisconnected
    (agentId : AgentId)
    (state : RuntimeState) : RuntimeState :=
  replaceFence { state with
    busyChildren := removeChild agentId state.busyChildren }

-- Transport reconnect is not activity. A disconnected child retries on a fixed one-second cadence;
-- once connected, the child must query and report fresh official idle state before changing the set.
def reconnectRetrySeconds : Nat := 1

structure ReconnectState where
  connected : Bool
  retryRemainingSeconds : Nat
  deriving DecidableEq, Repr

def disconnectedTransport : ReconnectState :=
  { connected := false
    retryRemainingSeconds := reconnectRetrySeconds }

def reconnectTick
    (transport : ReconnectState)
    (connectedNow : Bool) : ReconnectState :=
  if connectedNow then
    { connected := true
      retryRemainingSeconds := 0 }
  else
    { transport with retryRemainingSeconds := reconnectRetrySeconds }

def reconnectReport
    (agentId : AgentId)
    (liveOfficialIdle : Bool)
    (state : RuntimeState) : RuntimeState :=
  reportChildState agentId liveOfficialIdle state

def reconnectConnectionOnly (state : RuntimeState) : RuntimeState :=
  state

-- Timer transitions reject stale tokens and open an inquiry only after all ten ticks and a fresh official main-idle query.
def openInquiry (state : RuntimeState) : RuntimeState :=
  { state with
    fence := none
    inquiry := {
      state.inquiry with
      phase := .open
      resultMayAct := true
      streamingXmlVisible := false
      sessionXmlStored := false
      futureContextContainsXml := false
      tuiContainsXml := false
    }
  }

def timerTick
    (capturedToken : FenceToken)
    (liveMainIdle : Bool)
    (state : RuntimeState) : RuntimeState :=
  match state.fence with
  | none => state
  | some fence =>
      if fence.token != capturedToken then
        state
      else if fence.remainingSeconds ≤ 1 then
        let rechecked := { state with mainIdle := liveMainIdle, fence := none }
        if automaticInquiryEligible rechecked then openInquiry rechecked
        else rechecked
      else
        { state with
          fence := some {
            fence with remainingSeconds := fence.remainingSeconds - 1
          }
        }

def advanceTimer
    (capturedToken : FenceToken)
    (liveMainIdleAtWake : Bool) : Nat → RuntimeState → RuntimeState
  | 0, state => state
  | count + 1, state =>
      timerTick capturedToken liveMainIdleAtWake
        (advanceTimer capturedToken liveMainIdleAtWake count state)

-- Shared-inquiry transitions model streaming, finalization, commitment, user preemption, exactly-once delivery, and unconditional unlock cleanup.
def streamInquiryXml (state : RuntimeState) : RuntimeState :=
  if state.inquiry.phase == .open then
    { state with inquiry := {
      state.inquiry with
      streamingXmlVisible := true
      tuiContainsXml := true
    } }
  else
    state

def finalizeInquiryXml (state : RuntimeState) : RuntimeState :=
  if state.inquiry.phase == .open then
    { state with inquiry := {
      state.inquiry with
      streamingXmlVisible := false
      sessionXmlStored := true
      futureContextContainsXml := true
      tuiContainsXml := false
    } }
  else
    state

def commitInquiryResult (state : RuntimeState) : RuntimeState :=
  if state.inquiry.phase == .open && state.inquiry.resultMayAct then
    { state with inquiry := {
      state.inquiry with phase := .committed
    } }
  else
    state

def preemptInquiryForUser (state : RuntimeState) : RuntimeState :=
  { state with
    nextFenceToken := state.nextFenceToken + 1
    fence := none
    inquiry := {
      state.inquiry with
      phase := .preempted
      resultMayAct := false
      streamingXmlVisible := false
      sessionXmlStored := false
      futureContextContainsXml := false
      tuiContainsXml := false
      cleanupFoldPending := true
      userMessagePending := true
    }
  }

def cleanupFoldSendFailed (state : RuntimeState) : RuntimeState :=
  state

def cleanupFoldAcknowledged (state : RuntimeState) : RuntimeState :=
  { state with inquiry := {
    state.inquiry with cleanupFoldPending := false
  } }

def deliverPendingUserMessage (state : RuntimeState) : RuntimeState :=
  if state.inquiry.userMessagePending then
    { state with inquiry := {
      state.inquiry with
      userMessagePending := false
      userMessageDeliveryCount := state.inquiry.userMessageDeliveryCount + 1
    } }
  else
    state

def unlock (state : RuntimeState) : RuntimeState :=
  let preempted := preemptInquiryForUser state
  { preempted with
    enabled := false
    inquiry := {
      preempted.inquiry with userMessagePending := false
    }
  }

-- Safety predicates prohibit XML in every presentation or persistence surface and prohibit a preempted result from acting.
def noInquiryXmlResidue (state : RuntimeState) : Prop :=
  state.inquiry.streamingXmlVisible = false ∧
    state.inquiry.sessionXmlStored = false ∧
    state.inquiry.futureContextContainsXml = false ∧
    state.inquiry.tuiContainsXml = false

def cleanupCanRetry (state : RuntimeState) : Prop :=
  state.inquiry.cleanupFoldPending = true

def inquiryCannotAct (state : RuntimeState) : Prop :=
  state.inquiry.resultMayAct = false ∧
    state.inquiry.phase ≠ .committed

def idleCandidate : RuntimeState :=
  reportMainState true (initialState true)

-- Lifecycle proofs establish that event labels never infer state: each event uses only its fresh official idle query result.
theorem main_event_label_is_not_activity
    (first second : PiPublicEvent)
    (liveOfficialIdle : Bool)
    (state : RuntimeState) :
    observeMainEvent first liveOfficialIdle state =
      observeMainEvent second liveOfficialIdle state := by
  rfl

theorem child_event_label_is_not_activity
    (first second : PiPublicEvent)
    (agentId : AgentId)
    (liveOfficialIdle : Bool)
    (state : RuntimeState) :
    observeChildEvent first agentId liveOfficialIdle state =
      observeChildEvent second agentId liveOfficialIdle state := by
  rfl

-- Connection and set-update proofs establish neutral connect, deduplicated busy insertion, and complete removal on idle or disconnect.
theorem connected_child_does_not_change_activity
    (agentId : AgentId)
    (state : RuntimeState) :
    childConnected agentId state = state := by
  rfl

theorem reconnect_retry_is_fixed_one_second :
    (reconnectTick disconnectedTransport false).retryRemainingSeconds = 1 := by
  rfl

theorem reconnect_connection_is_activity_neutral
    (state : RuntimeState) :
    reconnectConnectionOnly state = state := by
  rfl

theorem reconnect_report_uses_fresh_live_state
    (agentId : AgentId)
    (liveOfficialIdle : Bool)
    (state : RuntimeState) :
    reconnectReport agentId liveOfficialIdle state =
      reportChildState agentId liveOfficialIdle state := by
  rfl

theorem non_idle_child_is_deduplicated_and_cancels_fence
    (agentId : AgentId)
    (state : RuntimeState) :
    let reported := reportChildState agentId false state
    agentId ∈ reported.busyChildren ∧ reported.fence = none := by
  simp [reportChildState, removeChild, replaceFence,
    automaticInquiryEligible, aggregateIdle]

theorem idle_child_is_removed
    (agentId : AgentId)
    (state : RuntimeState) :
    agentId ∉ (reportChildState agentId true state).busyChildren := by
  simp only [reportChildState, ite_eq_left]
  unfold replaceFence removeChild
  dsimp
  split <;> simp

theorem disconnected_child_is_removed
    (agentId : AgentId)
    (state : RuntimeState) :
    agentId ∉ (childDisconnected agentId state).busyChildren := by
  unfold childDisconnected replaceFence removeChild
  dsimp
  split <;> simp

-- Fence proofs establish unconditional replacement, stale-callback rejection, fixed delay, wake recheck, and full restart after repeated idle input.
theorem event_replaces_fence_even_for_repeated_idle
    (state : RuntimeState)
    (_idle : state.mainIdle = true)
    (_empty : state.busyChildren = [])
    (_enabled : state.enabled = true)
    (_closed : inquiryClosed state = true) :
    (reportMainState true state).nextFenceToken = state.nextFenceToken + 1 := by
  simp only [reportMainState]
  unfold replaceFence
  dsimp
  split <;> rfl

theorem stale_timer_is_inert
    (capturedToken : FenceToken)
    (liveMainIdle : Bool)
    (state : RuntimeState)
    (fence : IdleFence)
    (current : state.fence = some fence)
    (stale : fence.token ≠ capturedToken) :
    timerTick capturedToken liveMainIdle state = state := by
  simp [timerTick, current, stale]

theorem no_inquiry_before_fixed_delay :
    (advanceTimer 1 true 9 idleCandidate).inquiry.phase = .none := by
  decide

theorem fixed_delay_opens_inquiry_after_recheck :
    (advanceTimer 1 true 10 idleCandidate).inquiry.phase = .open := by
  decide

theorem live_main_busy_at_wake_blocks_inquiry :
    (advanceTimer 1 false 10 idleCandidate).inquiry.phase = .none := by
  decide

theorem main_activity_cancels_candidate
    (state : RuntimeState) :
    (reportMainState false state).fence = none := by
  simp [reportMainState, replaceFence, automaticInquiryEligible, aggregateIdle]

theorem repeated_idle_report_restarts_full_delay :
    let almostReady := advanceTimer 1 true 9 idleCandidate
    let restarted := reportMainState true almostReady
    restarted.inquiry.phase = .none ∧
      (advanceTimer restarted.nextFenceToken true 9 restarted).inquiry.phase = .none ∧
      (advanceTimer restarted.nextFenceToken true 10 restarted).inquiry.phase = .open := by
  decide

-- Inquiry proofs establish abort-safe cleanup, idempotence, inability to commit after preemption, exactly-once user delivery, and unlock cleanup.
theorem preemption_is_clean_and_cannot_act
    (state : RuntimeState) :
    let preempted := preemptInquiryForUser state
    noInquiryXmlResidue preempted ∧ inquiryCannotAct preempted := by
  simp [preemptInquiryForUser, noInquiryXmlResidue, inquiryCannotAct]

theorem preemption_cleanup_is_idempotent
    (state : RuntimeState) :
    preemptInquiryForUser (preemptInquiryForUser state) =
      { preemptInquiryForUser state with
        nextFenceToken := state.nextFenceToken + 2 } := by
  rfl

theorem failed_cleanup_send_retains_retry
    (state : RuntimeState) :
    cleanupCanRetry (cleanupFoldSendFailed (preemptInquiryForUser state)) := by
  simp [cleanupFoldSendFailed, preemptInquiryForUser, cleanupCanRetry]

theorem acknowledged_cleanup_clears_retry
    (state : RuntimeState) :
    (cleanupFoldAcknowledged (preemptInquiryForUser state)).inquiry.cleanupFoldPending = false := by
  simp [cleanupFoldAcknowledged, preemptInquiryForUser]

theorem preempted_result_cannot_commit
    (state : RuntimeState) :
    commitInquiryResult (preemptInquiryForUser state) =
      preemptInquiryForUser state := by
  simp [commitInquiryResult, preemptInquiryForUser]

theorem preempted_user_message_is_delivered_exactly_once
    (state : RuntimeState) :
    let preempted := preemptInquiryForUser state
    let delivered := deliverPendingUserMessage preempted
    delivered.inquiry.userMessageDeliveryCount =
        state.inquiry.userMessageDeliveryCount + 1 ∧
      deliverPendingUserMessage delivered = delivered := by
  simp [preemptInquiryForUser, deliverPendingUserMessage]

theorem unlock_disables_and_cleans
    (state : RuntimeState) :
    let stopped := unlock state
    stopped.enabled = false ∧ stopped.fence = none ∧
      noInquiryXmlResidue stopped ∧ inquiryCannotAct stopped := by
  simp [unlock, preemptInquiryForUser, noInquiryXmlResidue,
    inquiryCannotAct]

-- Status proofs tie activity, enablement, participant count, TUI ownership, and width to their authoritative runtime inputs.
theorem status_activity_matches_aggregate_idle
    (state : RuntimeState) :
    (projectStatus state).activity = .idle ↔ aggregateIdle state = true := by
  simp [projectStatus, statusActivity]

theorem status_projection_uses_only_observed_busy_state
    (state : RuntimeState) :
    (projectStatus state).enabled = state.enabled ∧
      (projectStatus state).rootRunning = !state.mainIdle ∧
      (projectStatus state).busyObservedSubagents = state.busyChildren.length := by
  simp [projectStatus]

theorem visible_status_requires_tui_main_and_controller
    (hasTui ownsMain controllerReady : Bool) :
    statusRowVisible hasTui ownsMain controllerReady = true ↔
      hasTui = true ∧ ownsMain = true ∧ controllerReady = true := by
  simp [statusRowVisible, and_assoc]

theorem status_layout_is_one_line
    (availableColumns preferredColumns : Nat) :
    (layoutStatusLine availableColumns preferredColumns).lineCount = 1 := by
  rfl

theorem status_layout_fits_available_width
    (availableColumns preferredColumns : Nat) :
    (layoutStatusLine availableColumns preferredColumns).visibleColumns ≤
      availableColumns := by
  exact Nat.min_le_left availableColumns preferredColumns

theorem continuation_is_extension_authored
    (accepted : AcceptedContinue) :
    (buildContinuationEnvelope accepted).extensionAuthored = true ∧
      (buildContinuationEnvelope accepted).userAuthored = false := by
  simp [buildContinuationEnvelope]

theorem continuation_does_not_authorize
    (accepted : AcceptedContinue) :
    (buildContinuationEnvelope accepted).conveysUserAuthorization = false ∧
      (buildContinuationEnvelope accepted).stopAtUserBoundary = true := by
  simp [buildContinuationEnvelope]

theorem continuation_preserves_reason_and_guidance
    (accepted : AcceptedContinue) :
    (buildContinuationEnvelope accepted).reasonType = accepted.reasonType ∧
      (buildContinuationEnvelope accepted).reason = accepted.reason ∧
      (buildContinuationEnvelope accepted).guidance = accepted.guidance := by
  simp [buildContinuationEnvelope]

-- Shared-timeline proofs establish one body for both readers and wait-local timing without external-progress claims.
theorem shared_event_body_is_identical
    (event : SharedEvent) :
    humanEventBody event = modelEventBody event := by
  rfl

theorem shared_timeline_append_preserves_order
    (timeline : List SharedEvent)
    (event : SharedEvent) :
    appendSharedEvent timeline event = timeline ++ [event] := by
  rfl

theorem committed_wait_uses_one_acceptance_origin
    (identity : Nat)
    (acceptedAt : RuntimeTimestamp)
    (requestedSeconds : Nat) :
    (commitWait identity acceptedAt requestedSeconds).deadlineMs =
      acceptedAt.wallClockMs + requestedSeconds * 1000 := by
  rfl

theorem exhaustion_event_publication_is_idempotent
    (state : ExhaustionPublication) :
    publishExhaustionEvent (publishExhaustionEvent state) =
      publishExhaustionEvent state := by
  cases state with
  | mk eventPublished hookPublished =>
      cases eventPublished <;> rfl

theorem wake_snapshot_reuse_is_immutable
    (wake : WaitWakeSnapshot) :
    reuseWakeSnapshot wake = wake := by
  rfl

theorem invalidation_removes_pending_wait
    (wait : Option CurrentWait) :
    invalidateCurrentWait wait = none := by
  rfl

theorem wake_retains_originating_wait
    (wake : WaitWakeSnapshot) :
    (reuseWakeSnapshot wake).wait.identity = wake.wait.identity ∧
      (reuseWakeSnapshot wake).wait.acceptedAt = wake.wait.acceptedAt ∧
      (reuseWakeSnapshot wake).wait.deadlineMs = wake.wait.deadlineMs := by
  simp [reuseWakeSnapshot]

theorem late_wake_reports_observed_elapsed :
    let accepted : RuntimeTimestamp :=
      { wallClockMs := 0,
        rfc3339WithNumericOffset := "2026-09-19T16:02:16.951+08:00" }
    let observed : RuntimeTimestamp :=
      { wallClockMs := 1531000,
        rfc3339WithNumericOffset := "2026-09-19T16:27:47.951+08:00" }
    let wait : CurrentWait := commitWait 1 accepted 1500
    let wake : WaitWakeSnapshot :=
      { wait,
        observedAt := observed,
        event := {
          kind := .waitCompleted,
          occurredAt := observed,
          body := "requested=1500; elapsed=1531; external-status=unknown",
          startsOrdinaryWork := false } }
    waitWakeEligible wait observed.wallClockMs = true ∧
      observedElapsedSeconds wake = 1531 ∧
      wake.wait.requestedSeconds = 1500 ∧
      wake.event.startsOrdinaryWork = false := by
  decide

-- Outcome proofs establish WAIT_USER priority, external-wait separation, immediate-action continue, and terminal unlock categories.
theorem user_boundary_has_priority
    (facts : DecisionFacts)
    (incomplete : facts.allWorkComplete = false)
    (userRequired : facts.userActionRequired = true)
    (noImmediate : facts.immediateAuthorizedAction = false) :
    selectDecisionOutcome facts = .waitUser := by
  simp [selectDecisionOutcome, incomplete, userRequired, noImmediate]

theorem external_wait_is_not_user_wait
    (facts : DecisionFacts)
    (incomplete : facts.allWorkComplete = false)
    (noUser : facts.userActionRequired = false)
    (externalWait : facts.externalWaitRequired = true)
    (noImmediate : facts.immediateAuthorizedAction = false) :
    selectDecisionOutcome facts = .waitExternal := by
  simp [selectDecisionOutcome, incomplete, noUser, externalWait, noImmediate]

theorem independent_authorized_action_can_continue
    (facts : DecisionFacts)
    (incomplete : facts.allWorkComplete = false)
    (immediate : facts.immediateAuthorizedAction = true) :
    selectDecisionOutcome facts = .continueWork := by
  simp [selectDecisionOutcome, incomplete, immediate]

theorem completed_work_is_done
    (facts : DecisionFacts)
    (complete : facts.allWorkComplete = true) :
    selectDecisionOutcome facts = .jobDone := by
  simp [selectDecisionOutcome, complete]

theorem remaining_non_user_blocker_is_blocked
    (facts : DecisionFacts)
    (noUser : facts.userActionRequired = false)
    (noExternalWait : facts.externalWaitRequired = false)
    (noImmediate : facts.immediateAuthorizedAction = false)
    (incomplete : facts.allWorkComplete = false) :
    selectDecisionOutcome facts = .jobBlocked := by
  simp [selectDecisionOutcome, noUser, noExternalWait, noImmediate, incomplete]

-- The guarantee record gathers lifecycle, delayed inquiry, disconnect, preemption, and scoped bounded-status obligations.
structure ProcessGuarantees : Prop where
  noEarlyInquiry :
    (advanceTimer 1 true 9 idleCandidate).inquiry.phase = .none
  inquiryAfterDelay :
    (advanceTimer 1 true 10 idleCandidate).inquiry.phase = .open
  recheckBlocksBusyMain :
    (advanceTimer 1 false 10 idleCandidate).inquiry.phase = .none
  mainEventsQueryLiveState : ∀ first second liveOfficialIdle state,
    observeMainEvent first liveOfficialIdle state =
      observeMainEvent second liveOfficialIdle state
  childEventsQueryLiveState : ∀ first second agentId liveOfficialIdle state,
    observeChildEvent first agentId liveOfficialIdle state =
      observeChildEvent second agentId liveOfficialIdle state
  childConnectNeutral : ∀ agentId state,
    childConnected agentId state = state
  childDisconnectRemovesBusy : ∀ agentId state,
    agentId ∉ (childDisconnected agentId state).busyChildren
  reconnectRetryFixed :
    (reconnectTick disconnectedTransport false).retryRemainingSeconds = 1
  reconnectConnectNeutral : ∀ state,
    reconnectConnectionOnly state = state
  reconnectReportsFresh : ∀ agentId liveOfficialIdle state,
    reconnectReport agentId liveOfficialIdle state =
      reportChildState agentId liveOfficialIdle state
  preemptionClean : ∀ state,
    noInquiryXmlResidue (preemptInquiryForUser state)
  preemptionCannotAct : ∀ state,
    inquiryCannotAct (preemptInquiryForUser state)
  failedCleanupRetriable : ∀ state,
    cleanupCanRetry (cleanupFoldSendFailed (preemptInquiryForUser state))
  cleanupAckTerminal : ∀ state,
    (cleanupFoldAcknowledged (preemptInquiryForUser state)).inquiry.cleanupFoldPending = false
  userDeliveredOnce : ∀ state,
    let delivered := deliverPendingUserMessage (preemptInquiryForUser state)
    delivered.inquiry.userMessageDeliveryCount =
      state.inquiry.userMessageDeliveryCount + 1
  statusMatchesAggregateIdle : ∀ state,
    (projectStatus state).activity = .idle ↔ aggregateIdle state = true
  statusUsesObservedBusyState : ∀ state,
    (projectStatus state).enabled = state.enabled ∧
      (projectStatus state).rootRunning = !state.mainIdle ∧
      (projectStatus state).busyObservedSubagents = state.busyChildren.length
  statusVisibilityIsScoped : ∀ hasTui ownsMain controllerReady,
    statusRowVisible hasTui ownsMain controllerReady = true ↔
      hasTui = true ∧ ownsMain = true ∧ controllerReady = true
  statusIsOneLine : ∀ availableColumns preferredColumns,
    (layoutStatusLine availableColumns preferredColumns).lineCount = 1
  statusFitsWidth : ∀ availableColumns preferredColumns,
    (layoutStatusLine availableColumns preferredColumns).visibleColumns ≤
      availableColumns
  continuationAttributed : ∀ accepted,
    (buildContinuationEnvelope accepted).extensionAuthored = true ∧
      (buildContinuationEnvelope accepted).userAuthored = false
  continuationNotAuthorization : ∀ accepted,
    (buildContinuationEnvelope accepted).conveysUserAuthorization = false ∧
      (buildContinuationEnvelope accepted).stopAtUserBoundary = true
  continuationPreservesDecision : ∀ accepted,
    (buildContinuationEnvelope accepted).reasonType = accepted.reasonType ∧
      (buildContinuationEnvelope accepted).reason = accepted.reason ∧
      (buildContinuationEnvelope accepted).guidance = accepted.guidance
  sharedEventBodySame : ∀ event,
    humanEventBody event = modelEventBody event
  sharedTimelineOrder : ∀ timeline event,
    appendSharedEvent timeline event = timeline ++ [event]
  waitCommitOrigin : ∀ identity acceptedAt requestedSeconds,
    (commitWait identity acceptedAt requestedSeconds).deadlineMs =
      acceptedAt.wallClockMs + requestedSeconds * 1000
  exhaustionEventOneShot : ∀ state,
    publishExhaustionEvent (publishExhaustionEvent state) =
      publishExhaustionEvent state
  wakeSnapshotStable : ∀ wake,
    reuseWakeSnapshot wake = wake
  waitInvalidationClears : ∀ wait,
    invalidateCurrentWait wait = none
  wakeKeepsWaitIdentity : ∀ wake,
    (reuseWakeSnapshot wake).wait.identity = wake.wait.identity ∧
      (reuseWakeSnapshot wake).wait.acceptedAt = wake.wait.acceptedAt ∧
      (reuseWakeSnapshot wake).wait.deadlineMs = wake.wait.deadlineMs
  observedElapsedExample :
    let accepted : RuntimeTimestamp :=
      { wallClockMs := 0,
        rfc3339WithNumericOffset := "2026-09-19T16:02:16.951+08:00" }
    let observed : RuntimeTimestamp :=
      { wallClockMs := 1531000,
        rfc3339WithNumericOffset := "2026-09-19T16:27:47.951+08:00" }
    let wait : CurrentWait := commitWait 1 accepted 1500
    let wake : WaitWakeSnapshot :=
      { wait,
        observedAt := observed,
        event := {
          kind := .waitCompleted,
          occurredAt := observed,
          body := "requested=1500; elapsed=1531; external-status=unknown",
          startsOrdinaryWork := false } }
    waitWakeEligible wait observed.wallClockMs = true ∧
      observedElapsedSeconds wake = 1531 ∧
      wake.wait.requestedSeconds = 1500 ∧
      wake.event.startsOrdinaryWork = false
  completionFirst : ∀ facts,
    facts.allWorkComplete = true → selectDecisionOutcome facts = .jobDone
  userBoundaryFirst : ∀ facts,
    facts.allWorkComplete = false →
    facts.userActionRequired = true →
      facts.immediateAuthorizedAction = false →
      selectDecisionOutcome facts = .waitUser
  externalWaitDistinct : ∀ facts,
    facts.allWorkComplete = false →
    facts.userActionRequired = false →
      facts.externalWaitRequired = true →
      facts.immediateAuthorizedAction = false →
      selectDecisionOutcome facts = .waitExternal
  independentWorkContinues : ∀ facts,
    facts.allWorkComplete = false →
    facts.immediateAuthorizedAction = true →
      selectDecisionOutcome facts = .continueWork

theorem process_is_correct : ProcessGuarantees := by
  exact {
    noEarlyInquiry := no_inquiry_before_fixed_delay
    inquiryAfterDelay := fixed_delay_opens_inquiry_after_recheck
    recheckBlocksBusyMain := live_main_busy_at_wake_blocks_inquiry
    mainEventsQueryLiveState := main_event_label_is_not_activity
    childEventsQueryLiveState := child_event_label_is_not_activity
    childConnectNeutral := connected_child_does_not_change_activity
    childDisconnectRemovesBusy := disconnected_child_is_removed
    reconnectRetryFixed := reconnect_retry_is_fixed_one_second
    reconnectConnectNeutral := reconnect_connection_is_activity_neutral
    reconnectReportsFresh := reconnect_report_uses_fresh_live_state
    preemptionClean := fun state => (preemption_is_clean_and_cannot_act state).1
    preemptionCannotAct := fun state =>
      (preemption_is_clean_and_cannot_act state).2
    failedCleanupRetriable := failed_cleanup_send_retains_retry
    cleanupAckTerminal := acknowledged_cleanup_clears_retry
    userDeliveredOnce := by
      intro state
      exact (preempted_user_message_is_delivered_exactly_once state).1
    statusMatchesAggregateIdle := status_activity_matches_aggregate_idle
    statusUsesObservedBusyState := status_projection_uses_only_observed_busy_state
    statusVisibilityIsScoped := visible_status_requires_tui_main_and_controller
    statusIsOneLine := status_layout_is_one_line
    statusFitsWidth := status_layout_fits_available_width
    continuationAttributed := continuation_is_extension_authored
    continuationNotAuthorization := continuation_does_not_authorize
    continuationPreservesDecision := continuation_preserves_reason_and_guidance
    sharedEventBodySame := shared_event_body_is_identical
    sharedTimelineOrder := shared_timeline_append_preserves_order
    waitCommitOrigin := committed_wait_uses_one_acceptance_origin
    exhaustionEventOneShot := exhaustion_event_publication_is_idempotent
    wakeSnapshotStable := wake_snapshot_reuse_is_immutable
    waitInvalidationClears := invalidation_removes_pending_wait
    wakeKeepsWaitIdentity := wake_retains_originating_wait
    observedElapsedExample := late_wake_reports_observed_elapsed
    completionFirst := completed_work_is_done
    userBoundaryFirst := user_boundary_has_priority
    externalWaitDistinct := external_wait_is_not_user_wait
    independentWorkContinues := independent_authorized_action_can_continue
  }

-- Executable projections expose proved timer, clean-preemption, and status behavior without operational side effects.
def noInquiryXmlResidueBool (state : RuntimeState) : Bool :=
  !state.inquiry.streamingXmlVisible &&
    !state.inquiry.sessionXmlStored &&
    !state.inquiry.futureContextContainsXml &&
    !state.inquiry.tuiContainsXml

def runtimeSummary (state : RuntimeState) : String :=
  s!"enabled={state.enabled}; mainIdle={state.mainIdle}; busyChildren={state.busyChildren}; fence={repr state.fence}; inquiry={repr state.inquiry.phase}; cleanupPending={state.inquiry.cleanupFoldPending}; xmlClean={noInquiryXmlResidueBool state}; deliveries={state.inquiry.userMessageDeliveryCount}"

def statusSummary (state : RuntimeState) : String :=
  let status := projectStatus state
  s!"activity={repr status.activity}; enabled={status.enabled}; rootRunning={status.rootRunning}; busyObservedSubagents={status.busyObservedSubagents}"

end OfficialPiIdleInquiry

#print axioms OfficialPiIdleInquiry.process_is_correct

-- The executable summary demonstrates timer boundaries, clean user takeover, observed activity projection, and narrow layout.
def main : IO Unit := do
  let candidate := OfficialPiIdleInquiry.idleCandidate
  let before := OfficialPiIdleInquiry.advanceTimer 1 true 9 candidate
  let opened := OfficialPiIdleInquiry.advanceTimer 1 true 10 candidate
  let streamed := OfficialPiIdleInquiry.streamInquiryXml opened
  let preempted := OfficialPiIdleInquiry.preemptInquiryForUser streamed
  let delivered := OfficialPiIdleInquiry.deliverPendingUserMessage preempted
  let running := OfficialPiIdleInquiry.reportChildState 7 false
    (OfficialPiIdleInquiry.reportMainState false
      (OfficialPiIdleInquiry.initialState true))
  let narrow := OfficialPiIdleInquiry.layoutStatusLine 24 72
  let continuation := OfficialPiIdleInquiry.buildContinuationEnvelope {
    reasonType := "WORK_REMAINS"
    reason := "Implementation work remains."
    guidance := "Continue until user assistance is required."
  }
  let approvalGate := OfficialPiIdleInquiry.selectDecisionOutcome {
    userActionRequired := true
    externalWaitRequired := false
    immediateAuthorizedAction := false
    allWorkComplete := false
  }
  let independentWork := OfficialPiIdleInquiry.selectDecisionOutcome {
    userActionRequired := true
    externalWaitRequired := false
    immediateAuthorizedAction := true
    allWorkComplete := false
  }
  let completedDespiteStalePlan := OfficialPiIdleInquiry.selectDecisionOutcome {
    userActionRequired := true
    externalWaitRequired := true
    immediateAuthorizedAction := true
    allWorkComplete := true
  }
  IO.println s!"Before ten seconds: {OfficialPiIdleInquiry.runtimeSummary before}"
  IO.println s!"At ten seconds: {OfficialPiIdleInquiry.runtimeSummary opened}"
  IO.println s!"After user takeover: {OfficialPiIdleInquiry.runtimeSummary delivered}"
  IO.println s!"Running status: {OfficialPiIdleInquiry.statusSummary running}"
  IO.println s!"Narrow layout: lines={narrow.lineCount}; columns={narrow.visibleColumns}/24"
  IO.println s!"Continuation envelope: extensionAuthored={continuation.extensionAuthored}; userAuthored={continuation.userAuthored}; userAuthorization={continuation.conveysUserAuthorization}; reasonType={continuation.reasonType}; stopAtUserBoundary={continuation.stopAtUserBoundary}"
  IO.println s!"Decision priority: completedDespiteStalePlan={repr completedDespiteStalePlan}; approvalGate={repr approvalGate}; independentWork={repr independentWork}"
  let sharedEvent : OfficialPiIdleInquiry.SharedEvent := {
    kind := .continued
    occurredAt := {
      wallClockMs := 1
      rfc3339WithNumericOffset := "2026-09-19T16:39:21.901+08:00"
    }
    body := "one immutable human/model body"
    startsOrdinaryWork := true
  }
  IO.println s!"Shared event body equality: {decide (OfficialPiIdleInquiry.humanEventBody sharedEvent = OfficialPiIdleInquiry.modelEventBody sharedEvent)}"
  IO.println "Proved: fixed delay precedes inquiry, wake rechecks official idle, disconnect removes busy children, reconnect retries every second and reports fresh live state, preemption is clean and exactly-once, the scoped status projection is one bounded line, automatic continuation is extension-authored and non-authorizing, shared events route one immutable body in append order to human and model context, one acceptance sample determines each wait deadline, retry-exhaustion event publication is idempotent, wait wake snapshots retain one originating wait and report observed elapsed wall-clock time, reconciled completion wins over stale action flags, WAIT_USER wins for incomplete work when no authorized action can proceed, external waits remain distinct, and independent unfinished authorized work may continue."
