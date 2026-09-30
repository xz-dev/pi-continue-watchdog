-- Core Lean support supplies finite lists, equality decisions, and deterministic executable summaries.
import Std

/-
Unlock-tool + direct-continuation process model. This file models the shipped
pi-continue-watchdog behavior: one always-registered unlock tool, the fixed
ten-second idle fence, aggregate idle across the hub and the authenticated
process domain, direct continuation publication with attempt accounting and
rollback, the optional jev wait gate before dispatch, exhaustion, and the shared
human/model event timeline. The pre-upgrade
XML inquiry protocol is removed; agents wait inside their own turn.
-/

set_option autoImplicit false

namespace OfficialPiIdleInquiry

/-!
## Vocabulary

`AgentId` names child Pi processes. `FenceToken` identifies one replaceable
fixed-delay timer. `PiPublicEvent` names public event triggers only: activity
facts always come from fresh official idle queries, never from labels.
-/

abbrev AgentId := Nat
abbrev FenceToken := Nat

/-- Case-insensitive equality used by the unlock tool's reason_type matching. -/
def equalsIgnoreCase (a b : String) : Bool :=
  a.toLower == b.toLower

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

/-!
## Runtime state

The runtime tracks the lock, the continuation budget, the replaceable fence,
the pending continuation correlation, and aggregate observations. The unlock
tool is session-scoped: once registered it never unregisters, so no state
change can alter the provider tool list.
-/

structure IdleFence where
  token : FenceToken
  armed : Bool
  remainingSeconds : Nat
  deriving DecidableEq, Repr

structure PendingContinuation where
  exchangeId : Nat
  published : Bool
  deriving DecidableEq, Repr

structure RuntimeState where
  enabled : Bool
  attempt : Nat
  maxRetries : Nat
  mainIdle : Bool
  busyChildren : List AgentId
  pendingMessages : Bool
  fence : Option IdleFence
  pendingContinuation : Option PendingContinuation
  exhaustionEventPublished : Bool
  deriving DecidableEq, Repr

def initialState (enabled : Bool) : RuntimeState :=
  { enabled
    attempt := 0
    maxRetries := 10
    mainIdle := true
    busyChildren := []
    pendingMessages := false
    fence := none
    pendingContinuation := none
    exhaustionEventPublished := false }

/-!
## Aggregate idle and eligibility

`aggregateIdle` combines the fresh official main idle query, the hub's busy
children, and pending messages. `continuationEligible` additionally requires
the lock, remaining budget, and no in-flight continuation.
-/

def aggregateIdle (state : RuntimeState) : Bool :=
  state.enabled ∧ state.mainIdle ∧ state.busyChildren.isEmpty ∧
    !state.pendingMessages

def continuationEligible (state : RuntimeState) : Bool :=
  aggregateIdle state ∧ state.attempt < state.maxRetries ∧
    state.pendingContinuation.isNone

def continuationClosed (state : RuntimeState) : Bool :=
  state.pendingContinuation.isNone

/-!
## Status projection

The status row mirrors authoritative runtime inputs only.
-/

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
  if state.mainIdle ∧ state.busyChildren.isEmpty then .idle else .running

def projectStatus (state : RuntimeState) : StatusProjection :=
  { activity := statusActivity state
    enabled := state.enabled
    rootRunning := !state.mainIdle
    busyObservedSubagents := state.busyChildren.length
    nextPhase :=
      if state.pendingContinuation.isSome then "continuing"
      else if state.fence.isSome then "fenced"
      else if state.enabled ∧ state.attempt ≥ state.maxRetries then "exhausted"
      else "-" }

/-!
## Shared event timeline

New continuation and exhaustion events have one immutable canonical body for
both readers. The unlock tool result is its own record; no unlock event body
is published.
-/

inductive SharedEventKind where
  | continue
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
  deriving DecidableEq, Repr

def humanEventBody (event : SharedEvent) : String := event.body

def modelEventBody (event : SharedEvent) : String := event.body

def appendSharedEvent
    (timeline : List SharedEvent)
    (event : SharedEvent) :
    List SharedEvent := timeline ++ [event]

/-!
## Continuation envelope

The direct continuation body is extension-authored, explicitly not a user
message or authorization, embeds the configured guidance, states that the
agent ended its turn without calling the unlock tool, and carries the
unlock-or-continue and wait-by-blocking instructions. It also carries the
completeness check shared verbatim with the unlock tool description: compare
every requested task, including earlier ones, with what was delivered before
unlocking, and treat a non-user blocker as an unlock case too.
-/

structure ContinuationEnvelope where
  guidance : String
  extensionAuthored : Bool
  userAuthored : Bool
  conveysUserAuthorization : Bool
  stopAtUserBoundary : Bool
  endedWithoutUnlockTool : Bool
  waitByBlockingOrSleeping : Bool
  checksEveryRequestedTask : Bool
  unlockOnNonUserBlocker : Bool
  deriving DecidableEq, Repr

def buildContinuationEnvelope (guidance : String) : ContinuationEnvelope :=
  { guidance
    extensionAuthored := true
    userAuthored := false
    conveysUserAuthorization := false
    stopAtUserBoundary := true
    endedWithoutUnlockTool := true
    waitByBlockingOrSleeping := true
    checksEveryRequestedTask := true
    unlockOnNonUserBlocker := true }

/-!
## Unlock tool

One always-registered tool. Invalid arguments are ordinary tool errors; a valid
call from the locked current main unlocks and terminates the run.
-/

inductive UnlockToolOutcome where
  | unlocked
  | alreadyUnlocked
  | invalidArguments
  deriving DecidableEq, Repr

structure UnlockToolCall where
  reasonType : String
  reason : String
  deriving DecidableEq, Repr

structure UnlockToolState where
  registered : Bool
  lockState : RuntimeState
  deriving DecidableEq, Repr

def registeredUnlockTool (lockState : RuntimeState) : UnlockToolState :=
  { registered := true, lockState }

def validReasonType (call : UnlockToolCall)
    (allowed : List String) : Bool :=
  allowed.any fun entry => equalsIgnoreCase entry call.reasonType

def executeUnlockTool (call : UnlockToolCall)
    (allowed : List String)
    (state : UnlockToolState) :
    UnlockToolOutcome × UnlockToolState :=
  if !validReasonType call allowed then
    (.invalidArguments, state)
  else if !state.lockState.enabled then
    (.alreadyUnlocked, state)
  else
    (.unlocked,
      { state with
          lockState :=
            { state.lockState with
                enabled := false
                fence := none
                pendingContinuation := none } })

/-!
## Fence and observation transitions

Every relevant observation replaces the fence; stale timer callbacks are
inert. Child reports update the busy set and replace the fence.
-/

def nextFenceToken (state : RuntimeState) : Nat :=
  (state.fence.map fun f => f.token).getD 0 + 1

def armedFence (token : FenceToken) (seconds : Nat) : IdleFence :=
  { token := token, armed := true, remainingSeconds := seconds }

def replaceFence (state : RuntimeState) : RuntimeState :=
  if continuationEligible state then
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

/-!
## Reconnect submodel

Disconnect removes the busy id; the fixed one-second reconnect retry is
connection-neutral and republishes a fresh live report.
-/

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

/-!
## Timer and dispatch

`timerTick` models one second of fence progress. On expiry the runtime
re-checks eligibility and dispatches exactly one direct continuation:
consume one attempt, publish the canonical body, correlate the run, and
publish the `watchdog-continued` hook with no values once the correlated
continuation reaches `message_start` while still owned (Pi's send is
asynchronous). A failed send rolls the attempt back: a synchronous throw,
ownership loss across the send, or settling while still pending-start.
-/

def dispatchContinuation (exchangeId : Nat) (state : RuntimeState) :
    RuntimeState :=
  if !continuationEligible state then state
  else
    { state with
        attempt := state.attempt + 1,
        pendingContinuation :=
          some { exchangeId := exchangeId, published := true },
        fence := none }

def rollbackContinuation (state : RuntimeState) : RuntimeState :=
  match state.pendingContinuation with
  | some _ =>
      { state with
          attempt := if state.attempt > 0 then state.attempt - 1 else 0
          pendingContinuation := none
          fence := none }
  | none => state

def timerTick (state : RuntimeState) : RuntimeState :=
  match state.fence with
  | some fence =>
      if fence.armed ∧ fence.remainingSeconds > 1 then
        { state with
            fence := some { fence with
                remainingSeconds := fence.remainingSeconds - 1 } }
      else if fence.armed then
        dispatchContinuation fence.token state
      else { state with fence := none }
  | none => state

def advanceTimer (seconds : Nat) (state : RuntimeState) : RuntimeState :=
  match seconds with
  | 0 => state
  | n + 1 => advanceTimer n (timerTick state)

/-!
## Unlock and fresh-cycle transitions

Unlock assigns unlocked first, cancels the fence and pending continuation,
and preserves attempt accounting. Fresh lock resets the attempt budget.
-/

def unlock (state : RuntimeState) : RuntimeState :=
  { state with
      enabled := false
      fence := none
      pendingContinuation := none }

def freshLockCycle (state : RuntimeState) : RuntimeState :=
  { state with
      enabled := true
      attempt := 0
      exhaustionEventPublished := false
      fence := none
      pendingContinuation := none }

/-!
## jev wait gate

After the fence qualifies and before dispatch, an optional jev verdict on the
final assistant text is awaited. The verdict applies only when the exact
qualified state is unchanged after the request (`stale = false`). A confident
`waiting_user` unlocks without consuming an attempt; every other outcome,
including no key or any failure (`none`), dispatches as before.
-/

inductive JevChoice where
  | waitingUser
  | notWaiting
  | unclear
  deriving DecidableEq, Repr

structure JevVerdict where
  choice : JevChoice
  confident : Bool
  deriving DecidableEq, Repr

inductive GateOutcome where
  | continued
  | waitUserUnlocked
  | dropped
  deriving DecidableEq, Repr

def jevWaits (verdict : Option JevVerdict) : Bool :=
  match verdict with
  | some v => v.choice == .waitingUser && v.confident
  | none => false

def applyJevGate (exchangeId : Nat) (verdict : Option JevVerdict)
    (stale : Bool) (state : RuntimeState) : GateOutcome × RuntimeState :=
  if stale || !continuationEligible state then (.dropped, state)
  else if jevWaits verdict then (.waitUserUnlocked, unlock state)
  else (.continued, dispatchContinuation exchangeId state)

/-- Gate-aware fence expiry: the runtime's actual path. With no verdict and a
fresh state it equals the plain `timerTick` dispatch (see
`gated_tick_without_verdict_is_timer_tick`). A branch change or any other
activity during the request is `stale`. -/
def gatedTimerTick (verdict : Option JevVerdict) (stale : Bool)
    (state : RuntimeState) : GateOutcome × RuntimeState :=
  match state.fence with
  | some fence =>
      if fence.armed ∧ fence.remainingSeconds ≤ 1 then
        applyJevGate fence.token verdict stale state
      else (.continued, timerTick state)
  | none => (.continued, state)

/-!
## Lifecycle proofs

Event labels never infer activity: each observation uses only its fresh
official idle query.
-/

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
    (continuationEligible { state with mainIdle := idle } = true →
      (reportMainState idle state).fence.map (·.token) =
        some ((state.fence.map (·.token)).getD 0 + 1)) ∧
    (continuationEligible { state with mainIdle := idle } = false →
      (reportMainState idle state).fence = none) := by
  constructor
  · intro h
    rw [reportMainState, replaceFence, ite_eq_left h]
    simp [armedFence, nextFenceToken]
  · intro h
    have h' : ¬continuationEligible { state with mainIdle := idle } :=
      Bool.not_eq_true _ ▸ h
    rw [reportMainState, replaceFence, ite_eq_right h']

theorem stale_timer_is_inert
    (state : RuntimeState)
    (noFence : state.fence = none) :
    timerTick state = state := by
  simp [timerTick, noFence]

theorem live_main_busy_at_wake_blocks_continuation

    (state : RuntimeState) (busy : state.mainIdle = false) :
    continuationEligible state = false := by
  simp [continuationEligible, aggregateIdle, busy]

theorem main_activity_cancels_candidate
    (state : RuntimeState) :
    (reportMainState false state).fence = none := by
  simp [reportMainState, replaceFence, continuationEligible, aggregateIdle]

theorem fence_arm_targets_full_fixed_delay
    (state : RuntimeState)
    (eligible : continuationEligible state = true) :
    ((replaceFence state).fence.map (·.remainingSeconds)).getD 0 =
      fixedIdleDelaySeconds := by
  rw [replaceFence, ite_eq_left eligible]
  simp [armedFence]

theorem failed_send_rolls_back_attempt
    (state : RuntimeState)
    (dispatched : state.pendingContinuation.isSome = true) :
    (rollbackContinuation state).attempt + 1 = state.attempt ∨
      (state.attempt = 0 ∧ (rollbackContinuation state).attempt = 0) := by
  cases hpc : state.pendingContinuation with
  | none => rw [hpc] at dispatched; simp at dispatched
  | some pending =>
      simp only [rollbackContinuation, hpc]
      by_cases h0 : state.attempt = 0
      · right
        simp [h0]
      · left
        have hpos : state.attempt > 0 := Nat.pos_of_ne_zero h0
        simp only [hpos, ite_true]
        omega

theorem unlock_disables_and_cleans
    (state : RuntimeState) :
    let stopped := unlock state
    stopped.enabled = false ∧ stopped.fence = none ∧
      continuationClosed stopped := by
  simp [unlock, continuationClosed]

theorem fresh_cycle_resets_budget
    (state : RuntimeState) :
    let fresh := freshLockCycle state
    fresh.attempt = 0 ∧ fresh.exhaustionEventPublished = false ∧
      continuationClosed fresh := by
  simp [freshLockCycle, continuationClosed]

/-!
## Unlock tool proofs
-/

theorem unlock_tool_stays_registered
    (call : UnlockToolCall) (allowed : List String)
    (state : UnlockToolState) :
    (executeUnlockTool call allowed state).2.registered =
      state.registered := by
  simp only [executeUnlockTool]
  split
  · rfl
  · split <;> rfl

theorem invalid_arguments_keep_lock
    (call : UnlockToolCall) (allowed : List String)
    (state : UnlockToolState)
    (invalid : validReasonType call allowed = false) :
    (executeUnlockTool call allowed state).1 = .invalidArguments ∧
      (executeUnlockTool call allowed state).2.lockState.enabled =
        state.lockState.enabled := by
  simp [executeUnlockTool, invalid]

theorem valid_call_unlocks_and_terminates
    (call : UnlockToolCall) (allowed : List String)
    (state : UnlockToolState)
    (valid : validReasonType call allowed = true)
    (locked : state.lockState.enabled = true) :
    (executeUnlockTool call allowed state).1 = .unlocked ∧
      (executeUnlockTool call allowed state).2.lockState.enabled = false ∧
      (executeUnlockTool call allowed state).2.lockState.pendingContinuation
        = none := by
  simp [executeUnlockTool, valid, locked]

theorem already_unlocked_call_is_informational
    (call : UnlockToolCall) (allowed : List String)
    (state : UnlockToolState)
    (valid : validReasonType call allowed = true)
    (unlocked : state.lockState.enabled = false) :
    (executeUnlockTool call allowed state).1 = .alreadyUnlocked := by
  simp [executeUnlockTool, valid, unlocked]

/-!
## Status proofs
-/

theorem status_activity_matches_idle_children
    (state : RuntimeState) :
    (projectStatus state).activity = .idle ↔
      (state.mainIdle = true ∧ state.busyChildren.isEmpty = true) := by
  simp [projectStatus, statusActivity]

theorem status_projection_uses_only_observed_busy_state
    (state : RuntimeState) :
    (projectStatus state).enabled = state.enabled ∧
      (projectStatus state).rootRunning = !state.mainIdle ∧
      (projectStatus state).busyObservedSubagents = state.busyChildren.length := by
  simp [projectStatus]

/-!
## Shared-timeline proofs
-/

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
    (guidance : String) :
    (buildContinuationEnvelope guidance).extensionAuthored = true ∧
      (buildContinuationEnvelope guidance).userAuthored = false := by
  simp [buildContinuationEnvelope]

theorem continuation_does_not_authorize
    (guidance : String) :
    (buildContinuationEnvelope guidance).conveysUserAuthorization = false ∧
      (buildContinuationEnvelope guidance).stopAtUserBoundary = true := by
  simp [buildContinuationEnvelope]

theorem continuation_states_missing_tool_call
    (guidance : String) :
    (buildContinuationEnvelope guidance).endedWithoutUnlockTool = true ∧
      (buildContinuationEnvelope guidance).waitByBlockingOrSleeping = true := by
  simp [buildContinuationEnvelope]

theorem continuation_requires_completeness_check
    (guidance : String) :
    (buildContinuationEnvelope guidance).checksEveryRequestedTask = true ∧
      (buildContinuationEnvelope guidance).unlockOnNonUserBlocker = true := by
  simp [buildContinuationEnvelope]

theorem continuation_preserves_guidance
    (guidance : String) :
    (buildContinuationEnvelope guidance).guidance = guidance := by
  simp [buildContinuationEnvelope]

/-- One-shot dispatch consumes one attempt and arms the pending continuation. -/
theorem dispatch_consumes_one_attempt
    (exchangeId : Nat) (state : RuntimeState)
    (eligible : continuationEligible state = true) :
    (dispatchContinuation exchangeId state).attempt = state.attempt + 1 ∧
      (dispatchContinuation exchangeId state).pendingContinuation.isSome =
        true ∧
      (dispatchContinuation exchangeId state).fence = none := by
  simp [dispatchContinuation, eligible]

/-- A non-eligible dispatch is a no-op. -/
theorem ineligible_dispatch_is_noop
    (exchangeId : Nat) (state : RuntimeState)
    (ineligible : continuationEligible state = false) :
    dispatchContinuation exchangeId state = state := by
  simp [dispatchContinuation, Bool.not_eq_true _ ▸ ineligible]

/-- Expiry of an armed fence on an eligible state dispatches exactly once. -/
theorem armed_fence_expiry_dispatches
    (state : RuntimeState) (fence : IdleFence)
    (hfence : state.fence = some fence)
    (harmed : fence.armed = true)
    (done_ : fence.remainingSeconds = 0)
    (eligible : continuationEligible state = true) :
    (timerTick state).attempt = state.attempt + 1 ∧
      (timerTick state).pendingContinuation.isSome = true := by
  obtain ⟨token, armed, remaining⟩ := fence
  simp only [] at hfence harmed done_
  subst done_
  subst harmed
  simp [timerTick, hfence, dispatchContinuation, eligible]

/-!
## jev gate proofs
-/

/-- A stale verdict neither unlocks nor continues. -/
theorem stale_jev_verdict_is_dropped
    (exchangeId : Nat) (verdict : Option JevVerdict) (state : RuntimeState) :
    applyJevGate exchangeId verdict true state = (.dropped, state) := by
  simp [applyJevGate]

/-- No key or any failure fails open to the ordinary dispatch. -/
theorem missing_jev_verdict_fails_open
    (exchangeId : Nat) (state : RuntimeState)
    (eligible : continuationEligible state = true) :
    applyJevGate exchangeId none false state =
      (.continued, dispatchContinuation exchangeId state) := by
  simp [applyJevGate, eligible, jevWaits]

/-- A confident waiting verdict unlocks without consuming an attempt. -/
theorem confident_wait_unlocks_without_attempt
    (exchangeId : Nat) (state : RuntimeState)
    (eligible : continuationEligible state = true) :
    let result := applyJevGate exchangeId
      (some { choice := .waitingUser, confident := true }) false state
    result.1 = .waitUserUnlocked ∧ result.2.enabled = false ∧
      result.2.attempt = state.attempt ∧ continuationClosed result.2 := by
  simp [applyJevGate, eligible, jevWaits, unlock, continuationClosed]

/-- A non-confident or non-waiting verdict continues exactly as before. -/
theorem other_jev_verdict_continues
    (exchangeId : Nat) (verdict : JevVerdict) (state : RuntimeState)
    (eligible : continuationEligible state = true)
    (notWait : jevWaits (some verdict) = false) :
    applyJevGate exchangeId (some verdict) false state =
      (.continued, dispatchContinuation exchangeId state) := by
  simp [applyJevGate, eligible, notWait]

/-- Without a verdict, an eligible gated expiry is exactly the plain
`timerTick` dispatch: the gate adds no behavior when it has nothing to say. -/
theorem gated_tick_without_verdict_is_timer_tick
    (state : RuntimeState) (fence : IdleFence)
    (hfence : state.fence = some fence)
    (harmed : fence.armed = true)
    (hdue : fence.remainingSeconds ≤ 1)
    (eligible : continuationEligible state = true) :
    (gatedTimerTick none false state).2 = timerTick state := by
  have hnot : ¬ (1 < fence.remainingSeconds) := by omega
  simp [gatedTimerTick, timerTick, hfence, harmed, hdue, hnot, applyJevGate,
    eligible, jevWaits]

/-- A stale gated expiry changes nothing. -/
theorem stale_gated_tick_is_inert
    (verdict : Option JevVerdict) (state : RuntimeState) (fence : IdleFence)
    (hfence : state.fence = some fence)
    (harmed : fence.armed = true)
    (hdue : fence.remainingSeconds ≤ 1) :
    gatedTimerTick verdict true state = (.dropped, state) := by
  simp [gatedTimerTick, hfence, harmed, hdue, applyJevGate]

/-!
## Deterministic executable summary
-/

#eval (initialState true).attempt
#eval (advanceTimer fixedIdleDelaySeconds
        (replaceFence (initialState true))).attempt
#eval (freshLockCycle (initialState true)).attempt
#eval (unlock (initialState true)).enabled
#eval (applyJevGate 1 (some { choice := .waitingUser, confident := true })
        false (initialState true)).1
#eval (applyJevGate 1 none false (initialState true)).2.attempt

/-- Aggregate correctness bundle: the model's key safety properties packaged
for a single axiom audit. -/
theorem process_is_correct :
    (∀ idle state,
      (continuationEligible { state with mainIdle := idle } = true →
        (reportMainState idle state).fence.map (·.token) =
          some ((state.fence.map (·.token)).getD 0 + 1)) ∧
      (continuationEligible { state with mainIdle := idle } = false →
        (reportMainState idle state).fence = none)) ∧
    (∀ state, (reportMainState false state).fence = none) ∧
    (∀ exchangeId state, continuationEligible state = true →
      (dispatchContinuation exchangeId state).attempt = state.attempt + 1 ∧
        (dispatchContinuation exchangeId state).pendingContinuation.isSome =
          true ∧
        (dispatchContinuation exchangeId state).fence = none) ∧
    (∀ exchangeId state, continuationEligible state = false →
      dispatchContinuation exchangeId state = state) ∧
    (∀ state, state.pendingContinuation.isSome = true →
      (rollbackContinuation state).attempt + 1 = state.attempt ∨
        (state.attempt = 0 ∧ (rollbackContinuation state).attempt = 0)) ∧
    (∀ state, let stopped := unlock state
      stopped.enabled = false ∧ stopped.fence = none ∧
        continuationClosed stopped) ∧
    (∀ state, let fresh := freshLockCycle state
      fresh.attempt = 0 ∧ fresh.exhaustionEventPublished = false ∧
        continuationClosed fresh) ∧
    (∀ call allowed state,
      (executeUnlockTool call allowed state).2.registered =
        state.registered) ∧
    (∀ call allowed state, validReasonType call allowed = true →
      state.lockState.enabled = true →
      (executeUnlockTool call allowed state).1 = .unlocked ∧
        (executeUnlockTool call allowed state).2.lockState.enabled = false ∧
        (executeUnlockTool call allowed state).2.lockState.pendingContinuation
          = none) ∧
    (∀ call allowed state,
      validReasonType call allowed = false →
      (executeUnlockTool call allowed state).1 = .invalidArguments ∧
        (executeUnlockTool call allowed state).2.lockState.enabled =
          state.lockState.enabled) ∧
    (∀ state, (projectStatus state).activity = .idle ↔
      (state.mainIdle = true ∧ state.busyChildren.isEmpty = true)) ∧
    (∀ event, humanEventBody event = modelEventBody event) ∧
    (∀ guidance,
      (buildContinuationEnvelope guidance).extensionAuthored = true ∧
        (buildContinuationEnvelope guidance).userAuthored = false ∧
        (buildContinuationEnvelope guidance).conveysUserAuthorization =
          false ∧
        (buildContinuationEnvelope guidance).stopAtUserBoundary = true ∧
        (buildContinuationEnvelope guidance).endedWithoutUnlockTool = true ∧
        (buildContinuationEnvelope guidance).waitByBlockingOrSleeping = true ∧
        (buildContinuationEnvelope guidance).guidance = guidance) ∧
    (∀ exchangeId verdict state,
      applyJevGate exchangeId verdict true state = (.dropped, state)) ∧
    (∀ exchangeId state, continuationEligible state = true →
      applyJevGate exchangeId none false state =
        (.continued, dispatchContinuation exchangeId state)) ∧
    (∀ exchangeId state, continuationEligible state = true →
      let result := applyJevGate exchangeId
        (some { choice := .waitingUser, confident := true }) false state
      result.1 = .waitUserUnlocked ∧ result.2.enabled = false ∧
        result.2.attempt = state.attempt ∧ continuationClosed result.2) ∧
    (∀ state fence, state.fence = some fence → fence.armed = true →
      fence.remainingSeconds ≤ 1 → continuationEligible state = true →
      (gatedTimerTick none false state).2 = timerTick state) ∧
    (∀ verdict state fence, state.fence = some fence → fence.armed = true →
      fence.remainingSeconds ≤ 1 →
      gatedTimerTick verdict true state = (.dropped, state)) :=
  ⟨idle_report_replaces_fence_token,
   main_activity_cancels_candidate,
   dispatch_consumes_one_attempt,
   ineligible_dispatch_is_noop,
   failed_send_rolls_back_attempt,
   unlock_disables_and_cleans,
   fresh_cycle_resets_budget,
   unlock_tool_stays_registered,
   valid_call_unlocks_and_terminates,
   invalid_arguments_keep_lock,
   status_activity_matches_idle_children,
   shared_event_body_is_identical,
   fun guidance =>
     ⟨continuation_is_extension_authored guidance |> And.left,
      continuation_is_extension_authored guidance |> And.right,
      continuation_does_not_authorize guidance |> And.left,
      continuation_does_not_authorize guidance |> And.right,
      continuation_states_missing_tool_call guidance |> And.left,
      continuation_states_missing_tool_call guidance |> And.right,
      continuation_preserves_guidance guidance⟩,
   stale_jev_verdict_is_dropped,
   missing_jev_verdict_fails_open,
   confident_wait_unlocks_without_attempt,
   gated_tick_without_verdict_is_timer_tick,
   fun verdict state fence => stale_gated_tick_is_inert verdict state fence⟩

end OfficialPiIdleInquiry

#print axioms OfficialPiIdleInquiry.process_is_correct
