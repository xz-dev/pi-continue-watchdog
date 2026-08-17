import Std

set_option autoImplicit false

namespace CrossPluginRunActivity

/-!
## Wire classification abstraction

`exactObservation` is the result of matching the complete TypeScript wire
contract: the namespaced key, protocol version, and `observation` activity must
all be exact. `absent`, `malformed`, and `unknown` represent every fail-closed
parser outcome. Producer and consumer identities are carried only to prove that
classification does not depend on a particular extension pairing.
-/

abbrev ProducerId := Nat
abbrev ConsumerId := Nat

inductive ActivityMarker where
  | exactObservation
  | exactWork
  | absent
  | malformed
  | unknown
  deriving DecidableEq, Repr

inductive RunActivity where
  | observation
  | work
  deriving DecidableEq, Repr

inductive Phase where
  | idle
  | pendingClassification
  | running
  | final
  deriving DecidableEq, Repr

/-!
## Runtime state

The state records only protocol-relevant effects: shared-domain busy state,
active-time accounting, completed loop accounting, decision authority, and
owned-output cleanup. Pi rendering and transport details are intentionally
outside this model.
-/

structure RunState where
  phase : Phase
  activity : Option RunActivity
  domainBusy : Bool
  activeTimeRunning : Bool
  completedLoops : Nat
  decisionOutputOwned : Bool
  decisionResultMayAct : Bool
  cleanupPending : Bool
  xmlStored : Bool
  deriving DecidableEq, Repr

/-!
## Fail-closed classifier

Observation is opt-in. Every marker except the one exact supported observation
shape is ordinary work.
-/

def classifyActivity : ActivityMarker → RunActivity
  | .exactObservation => .observation
  | .exactWork => .work
  | .absent => .work
  | .malformed => .work
  | .unknown => .work

/-!
## Event transitions

The transition order models stock Pi as verified in `agent-loop.ts`:
`agent_start` first creates an unclassified run, then the first actual
`message_start` supplies classification. Observation runs never report busy or
start active time. Decision invalidation removes authority but deliberately does
not remove cleanup responsibility; terminal `message_end` owns that cleanup.
-/

def initialState (decisionOutputOwned : Bool) : RunState :=
  {
    phase := .idle
    activity := none
    domainBusy := false
    activeTimeRunning := false
    completedLoops := 0
    decisionOutputOwned := decisionOutputOwned
    decisionResultMayAct := decisionOutputOwned
    cleanupPending := decisionOutputOwned
    xmlStored := false
  }

def agentStart (state : RunState) : RunState :=
  { state with
    phase := .pendingClassification
    activity := none
    domainBusy := false
    activeTimeRunning := false }

def messageStart (marker : ActivityMarker) (state : RunState) : RunState :=
  let activity := classifyActivity marker
  { state with
    phase := .running
    activity := some activity
    domainBusy := activity == .work
    activeTimeRunning := activity == .work }

def messageStartFrom
    (_producer : ProducerId)
    (_consumer : ConsumerId)
    (marker : ActivityMarker)
    (state : RunState) : RunState :=
  messageStart marker state

def assistantProducesOutput (state : RunState) : RunState :=
  if state.decisionOutputOwned then { state with xmlStored := true } else state

def invalidateDecision (state : RunState) : RunState :=
  { state with decisionResultMayAct := false }

def turnEnd (state : RunState) : RunState :=
  if state.phase == .running && state.activity == some .work then
    { state with completedLoops := state.completedLoops + 1 }
  else
    state

def messageEnd (state : RunState) : RunState :=
  if state.cleanupPending then
    { state with cleanupPending := false, xmlStored := false }
  else
    state

def agentSettled (state : RunState) : RunState :=
  { state with
    phase := .final
    domainBusy := false
    activeTimeRunning := false }

def executeDecision
    (producer : ProducerId)
    (consumer : ConsumerId)
    (marker : ActivityMarker)
    (invalidated : Bool) : RunState :=
  let started := agentStart (initialState true)
  let classified := messageStartFrom producer consumer marker started
  let answered := assistantProducesOutput classified
  let decided := if invalidated then invalidateDecision answered else answered
  agentSettled (messageEnd (turnEnd decided))

/-!
## Safety predicates

Final safety requires no busy/active accounting and no persisted owned XML.
Observation isolation requires no loop increment. An invalidated decision must
both lose authority and finish without stored XML.
-/

def finalSafety (state : RunState) : Prop :=
  state.phase = .final →
    state.domainBusy = false ∧
    state.activeTimeRunning = false ∧
    state.xmlStored = false ∧
    state.cleanupPending = false

def observationIsolation (state : RunState) : Prop :=
  state.activity = some .observation →
    state.completedLoops = 0

def invalidatedResultSafety (state : RunState) : Prop :=
  state.decisionResultMayAct = false ∧ state.xmlStored = false

/-!
## Classification proofs

These theorems establish identity independence and strict versioned opt-in by
working over the post-parse marker abstraction.
-/

theorem classification_is_identity_independent
    (producerA producerB : ProducerId)
    (consumerA consumerB : ConsumerId)
    (marker : ActivityMarker)
    (state : RunState) :
    messageStartFrom producerA consumerA marker state =
      messageStartFrom producerB consumerB marker state := by
  rfl

theorem only_exact_observation_is_observation (marker : ActivityMarker) :
    classifyActivity marker = .observation ↔ marker = .exactObservation := by
  cases marker <;> simp [classifyActivity]

theorem non_observation_markers_fail_closed_to_work
    (marker : ActivityMarker)
    (notObservation : marker ≠ .exactObservation) :
    classifyActivity marker = .work := by
  cases marker <;> simp_all [classifyActivity]

/-!
## Accounting proofs

A run remains neutral until message classification. Exact observation stays
neutral and contributes no loop; exact or fail-closed work starts accounting.
-/

theorem pending_classification_reports_no_activity
    (state : RunState) :
    let pending := agentStart state
    pending.phase = .pendingClassification ∧
      pending.domainBusy = false ∧
      pending.activeTimeRunning = false := by
  simp [agentStart]

theorem exact_observation_starts_no_activity
    (producer : ProducerId)
    (consumer : ConsumerId)
    (state : RunState) :
    let classified := messageStartFrom producer consumer .exactObservation state
    classified.activity = some .observation ∧
      classified.domainBusy = false ∧
      classified.activeTimeRunning = false := by
  simp [messageStartFrom, messageStart, classifyActivity]

theorem work_starts_activity
    (producer : ProducerId)
    (consumer : ConsumerId)
    (state : RunState) :
    let classified := messageStartFrom producer consumer .exactWork state
    classified.activity = some .work ∧
      classified.domainBusy = true ∧
      classified.activeTimeRunning = true := by
  simp [messageStartFrom, messageStart, classifyActivity]

theorem observation_turn_does_not_increment
    (producer : ProducerId)
    (consumer : ConsumerId) :
    let started := agentStart (initialState true)
    let classified := messageStartFrom producer consumer .exactObservation started
    (turnEnd classified).completedLoops = 0 := by
  simp [initialState, agentStart, messageStartFrom, messageStart,
    classifyActivity, turnEnd]

theorem work_turn_increments_once
    (producer : ProducerId)
    (consumer : ConsumerId) :
    let started := agentStart (initialState false)
    let classified := messageStartFrom producer consumer .exactWork started
    (turnEnd classified).completedLoops = 1 := by
  simp [initialState, agentStart, messageStartFrom, messageStart,
    classifyActivity, turnEnd]

/-!
## Cleanup and termination proofs

Decision authority and output ownership are separate obligations. Invalidating
a fence cannot discard cleanup ownership, and every modeled execution reaches a
final state with no stored XML.
-/

theorem invalidation_preserves_cleanup_responsibility
    (state : RunState)
    (pending : state.cleanupPending = true) :
    (invalidateDecision state).cleanupPending = true := by
  simpa [invalidateDecision] using pending

theorem message_end_clears_owned_output
    (state : RunState)
    (pending : state.cleanupPending = true) :
    let completed := messageEnd state
    completed.cleanupPending = false ∧ completed.xmlStored = false := by
  simp [messageEnd, pending]

theorem observation_execution_is_isolated
    (producer : ProducerId)
    (consumer : ConsumerId)
    (invalidated : Bool) :
    observationIsolation
      (executeDecision producer consumer .exactObservation invalidated) := by
  intro _
  cases invalidated <;>
    simp [executeDecision, initialState, agentStart, messageStartFrom,
      messageStart, classifyActivity, assistantProducesOutput,
      invalidateDecision, turnEnd, messageEnd, agentSettled]

theorem every_execution_is_final_and_clean
    (producer : ProducerId)
    (consumer : ConsumerId)
    (marker : ActivityMarker)
    (invalidated : Bool) :
    finalSafety (executeDecision producer consumer marker invalidated) := by
  intro _
  cases marker <;> cases invalidated <;>
    simp [executeDecision, initialState, agentStart, messageStartFrom,
      messageStart, classifyActivity, assistantProducesOutput,
      invalidateDecision, turnEnd, messageEnd, agentSettled]

theorem invalidated_execution_cannot_act_or_store_xml
    (producer : ProducerId)
    (consumer : ConsumerId)
    (marker : ActivityMarker) :
    invalidatedResultSafety (executeDecision producer consumer marker true) := by
  cases marker <;>
    simp [invalidatedResultSafety, executeDecision, initialState, agentStart,
      messageStartFrom, messageStart, classifyActivity,
      assistantProducesOutput, invalidateDecision, turnEnd, messageEnd,
      agentSettled]

theorem process_has_bounded_progress
    (producer : ProducerId)
    (consumer : ConsumerId)
    (marker : ActivityMarker)
    (invalidated : Bool) :
    (executeDecision producer consumer marker invalidated).phase = .final := by
  cases marker <;> cases invalidated <;>
    simp [executeDecision, initialState, agentStart, messageStartFrom,
      messageStart, classifyActivity, assistantProducesOutput,
      invalidateDecision, turnEnd, messageEnd, agentSettled]

/-!
## Composed protocol guarantee

The top-level theorem combines normal finalization, invalidated finalization,
invalidated-result safety, and exact observation classification for arbitrary
producer and consumer identities.
-/

def ProcessGuarantees
    (producer : ProducerId)
    (consumer : ConsumerId)
    (marker : ActivityMarker) : Prop :=
  finalSafety (executeDecision producer consumer marker false) ∧
    finalSafety (executeDecision producer consumer marker true) ∧
    invalidatedResultSafety (executeDecision producer consumer marker true) ∧
    (classifyActivity marker = .observation ↔ marker = .exactObservation)

theorem cross_plugin_run_activity_process_is_correct
    (producer : ProducerId)
    (consumer : ConsumerId)
    (marker : ActivityMarker) :
    ProcessGuarantees producer consumer marker := by
  exact ⟨every_execution_is_final_and_clean producer consumer marker false,
    every_execution_is_final_and_clean producer consumer marker true,
    invalidated_execution_cannot_act_or_store_xml producer consumer marker,
    only_exact_observation_is_observation marker⟩

/-!
## Executable witnesses

The executable summary is a semantic smoke test: an invalidated observation is
clean and uncounted, while an unknown marker is conservatively counted as work.
-/

def summary (state : RunState) : String :=
  s!"phase={repr state.phase}; activity={repr state.activity}; busy={state.domainBusy}; active={state.activeTimeRunning}; loops={state.completedLoops}; mayAct={state.decisionResultMayAct}; xmlStored={state.xmlStored}"

end CrossPluginRunActivity

#print axioms CrossPluginRunActivity.cross_plugin_run_activity_process_is_correct

def main : IO Unit := do
  let observation := CrossPluginRunActivity.executeDecision 7 19 .exactObservation true
  let unknown := CrossPluginRunActivity.executeDecision 23 41 .unknown false
  IO.println s!"Observation decision: {CrossPluginRunActivity.summary observation}"
  IO.println s!"Unknown marker defaults to work: {CrossPluginRunActivity.summary unknown}"
  IO.println "Proved: producer/consumer identity is irrelevant, observation is opt-in, unknown input fails closed, and every decision terminates without stored XML."
