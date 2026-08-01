import assert from "node:assert/strict";
import test from "node:test";

import {
	type ControllerEffect,
	type ControllerTransition,
	createLockDecisionController,
} from "../src/controller.js";

function controller(
	config: { idleDelaySeconds: number; maxRetries: number } = {
		idleDelaySeconds: 3,
		maxRetries: 3,
	},
) {
	return createLockDecisionController(config);
}

function armEffect(
	transition: ControllerTransition,
): Extract<ControllerEffect, { kind: "armIdleTimer" }> {
	const effect = transition.effects.find(
		(candidate) => candidate.kind === "armIdleTimer",
	);
	assert.ok(effect, "expected an armIdleTimer effect");
	assert.equal(effect.kind, "armIdleTimer");
	return effect;
}

function decisionId(transition: ControllerTransition): number {
	const effect = transition.effects.find(
		(candidate) => candidate.kind === "openDecisionWindow",
	);
	assert.ok(effect, "expected an openDecisionWindow effect");
	assert.equal(effect.kind, "openDecisionWindow");
	return effect.decisionId;
}

function effectKinds(transition: ControllerTransition): string[] {
	return transition.effects.map((effect) => effect.kind);
}

function openDecision(state: ReturnType<typeof controller>): {
	decisionId: number;
	timerId: number;
} {
	const arm = armEffect(state.onAllObservableIdle());
	return {
		decisionId: decisionId(state.beginDecision(arm.timerId)),
		timerId: arm.timerId,
	};
}

test("Slice 2: initial snapshot is immutable and unlocked without timer or decision window", () => {
	const state = controller();

	assert.deepEqual(state.snapshot, {
		locked: false,
		attempt: 0,
		exhausted: false,
		decisionFailed: false,
		invalidDecisionAttempts: 0,
		lastInvalidDecisionError: null,
		idleTimer: null,
		decisionOpen: false,
	});
	assert.equal(Object.isFrozen(state.snapshot), true);
});

test("Examples 1-2: manual lock and main user start always reset, cancel stale state, and notify", () => {
	const state = controller({ idleDelaySeconds: 3, maxRetries: 2 });

	const first = state.lock();
	assert.equal(first.applied, true);
	assert.deepEqual(first.effects, [{ kind: "notify", notification: "locked" }]);

	const pending = armEffect(state.onAllObservableIdle());
	assert.equal(pending.attempt, 0);
	assert.equal(pending.delaySeconds, 3);

	const sameState = state.lock();
	assert.equal(sameState.applied, true);
	assert.deepEqual(sameState.effects, [
		{ kind: "cancelIdleTimer", timerId: pending.timerId },
		{ kind: "notify", notification: "locked" },
	]);
	assert.equal(state.snapshot.locked, true);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.snapshot.idleTimer, null);

	const { decisionId: oldDecisionId } = openDecision(state);
	const started = state.onMainUserMessageStart();
	assert.equal(started.applied, true);
	assert.deepEqual(started.effects, [
		{ kind: "restoreDecisionTools", decisionId: oldDecisionId },
		{ kind: "notify", notification: "locked" },
	]);
	assert.equal(state.snapshot.locked, true);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.snapshot.decisionOpen, false);
});

test("Examples 3 and 7 state seam: unlock is unconditional and resets/cancels/restores", () => {
	const state = controller();

	const alreadyUnlocked = state.unlock();
	assert.equal(alreadyUnlocked.applied, true);
	assert.deepEqual(alreadyUnlocked.effects, [
		{ kind: "notify", notification: "unlocked" },
	]);

	state.lock();
	const pending = armEffect(state.onAllObservableIdle());
	const duringDelay = state.unlock();
	assert.deepEqual(duringDelay.effects, [
		{ kind: "cancelIdleTimer", timerId: pending.timerId },
		{ kind: "notify", notification: "unlocked" },
	]);

	state.lock();
	const { decisionId: openDecisionId } = openDecision(state);
	const duringDecision = state.unlock();
	assert.deepEqual(duringDecision.effects, [
		{ kind: "restoreDecisionTools", decisionId: openDecisionId },
		{ kind: "notify", notification: "unlocked" },
	]);
	assert.deepEqual(state.snapshot, {
		locked: false,
		attempt: 0,
		exhausted: false,
		decisionFailed: false,
		invalidDecisionAttempts: 0,
		lastInvalidDecisionError: null,
		idleTimer: null,
		decisionOpen: false,
	});
});

test("Examples 5, 6, and 10: valid continues advance zero-based 3s exponential delays then exhaust", () => {
	const state = controller({ idleDelaySeconds: 3, maxRetries: 3 });
	state.lock();

	const first = armEffect(state.onAllObservableIdle());
	assert.deepEqual(
		{ attempt: first.attempt, delaySeconds: first.delaySeconds },
		{ attempt: 0, delaySeconds: 3 },
	);
	state.recordValidContinue(decisionId(state.beginDecision(first.timerId)));
	assert.equal(state.snapshot.attempt, 1);
	assert.equal(state.snapshot.exhausted, false);

	const second = armEffect(state.onAllObservableIdle());
	assert.deepEqual(
		{ attempt: second.attempt, delaySeconds: second.delaySeconds },
		{ attempt: 1, delaySeconds: 6 },
	);
	state.recordValidContinue(decisionId(state.beginDecision(second.timerId)));

	const third = armEffect(state.onAllObservableIdle());
	assert.deepEqual(
		{ attempt: third.attempt, delaySeconds: third.delaySeconds },
		{ attempt: 2, delaySeconds: 12 },
	);
	const finalContinue = state.recordValidContinue(
		decisionId(state.beginDecision(third.timerId)),
	);
	assert.deepEqual(effectKinds(finalContinue), ["restoreDecisionTools"]);
	assert.equal(state.snapshot.attempt, 3);
	assert.equal(state.snapshot.locked, true);
	assert.equal(state.snapshot.exhausted, true);
	assert.equal(state.onAllObservableIdle().applied, false);
	assert.equal(state.snapshot.idleTimer, null);
});

test("Example 10: stale or duplicate continue cannot double-consume the retry budget", () => {
	const state = controller({ idleDelaySeconds: 3, maxRetries: 1 });
	state.lock();
	const { decisionId: activeDecisionId } = openDecision(state);

	assert.equal(state.recordValidContinue(activeDecisionId).applied, true);
	assert.equal(state.snapshot.attempt, 1);
	assert.equal(state.snapshot.exhausted, true);

	const duplicate = state.recordValidContinue(activeDecisionId);
	assert.equal(duplicate.applied, false);
	assert.deepEqual(duplicate.effects, []);
	assert.equal(state.snapshot.attempt, 1);
});

test("Examples 1, 2, and 10: manual lock or actual main user start resets exhausted state", () => {
	const state = controller({ idleDelaySeconds: 3, maxRetries: 1 });
	state.lock();
	const { decisionId: firstDecisionId } = openDecision(state);
	state.recordValidContinue(firstDecisionId);
	assert.equal(state.snapshot.exhausted, true);

	const userStart = state.onMainUserMessageStart();
	assert.deepEqual(userStart.effects, [
		{ kind: "notify", notification: "locked" },
	]);
	assert.equal(state.snapshot.locked, true);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.snapshot.exhausted, false);

	const { decisionId: secondDecisionId } = openDecision(state);
	state.recordValidContinue(secondDecisionId);
	assert.equal(state.snapshot.exhausted, true);
	const manualLock = state.lock();
	assert.deepEqual(manualLock.effects, [
		{ kind: "notify", notification: "locked" },
	]);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.snapshot.exhausted, false);
});

test("Example 8: invalids re-ask twice without retry consumption, then enter locked decision-failed", () => {
	const state = controller({ idleDelaySeconds: 3, maxRetries: 2 });
	state.lock();
	const { decisionId: activeDecisionId } = openDecision(state);

	const firstInvalid = state.recordInvalidDecision(
		activeDecisionId,
		"Call exactly one decision tool.",
	);
	assert.deepEqual(firstInvalid.effects, [
		{
			kind: "reaskDecision",
			decisionId: activeDecisionId,
			invalidDecisionAttempt: 1,
			error: "Call exactly one decision tool.",
		},
	]);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.snapshot.invalidDecisionAttempts, 1);
	assert.equal(state.snapshot.decisionOpen, true);

	const secondInvalid = state.recordInvalidDecision(
		activeDecisionId,
		"The unlock reason is blank.",
	);
	assert.deepEqual(secondInvalid.effects, [
		{
			kind: "reaskDecision",
			decisionId: activeDecisionId,
			invalidDecisionAttempt: 2,
			error: "The unlock reason is blank.",
		},
	]);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.snapshot.invalidDecisionAttempts, 2);

	const thirdInvalid = state.recordInvalidDecision(
		activeDecisionId,
		"Unknown tool.",
	);
	assert.deepEqual(thirdInvalid.effects, [
		{ kind: "restoreDecisionTools", decisionId: activeDecisionId },
		{ kind: "decisionFailed", error: "Unknown tool." },
	]);
	assert.equal(state.snapshot.locked, true);
	assert.equal(state.snapshot.decisionFailed, true);
	assert.equal(state.snapshot.decisionOpen, false);
	assert.equal(state.snapshot.idleTimer, null);
	assert.equal(state.onAllObservableIdle().applied, false);

	const reset = state.lock();
	assert.equal(reset.applied, true);
	assert.equal(state.snapshot.decisionFailed, false);
	assert.equal(state.snapshot.invalidDecisionAttempts, 0);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.onAllObservableIdle().applied, true);
});

test("Example 9: busy cancels the delay and the next all-idle arms full delay for same attempt", () => {
	const state = controller({ idleDelaySeconds: 7, maxRetries: 2 });
	state.lock();
	const first = armEffect(state.onAllObservableIdle());
	assert.equal(first.delaySeconds, 7);
	assert.equal(first.attempt, 0);

	const busy = state.onObservableBusy();
	assert.deepEqual(busy.effects, [
		{ kind: "cancelIdleTimer", timerId: first.timerId },
	]);
	assert.equal(state.snapshot.idleTimer, null);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.beginDecision(first.timerId).applied, false);

	const second = armEffect(state.onAllObservableIdle());
	assert.equal(second.delaySeconds, 7);
	assert.equal(second.attempt, 0);
	assert.notEqual(second.timerId, first.timerId);
});

test("Slice 2: stale/duplicate idle, timer fires, and decision responses have deterministic guarded outcomes", () => {
	const state = controller();
	state.lock();
	const timer = armEffect(state.onAllObservableIdle());
	assert.equal(state.onAllObservableIdle().applied, false);
	assert.equal(state.beginDecision(timer.timerId + 1).applied, false);

	const activeDecisionId = decisionId(state.beginDecision(timer.timerId));
	assert.equal(state.beginDecision(timer.timerId).applied, false);
	assert.equal(state.onAllObservableIdle().applied, false);
	assert.equal(state.recordValidContinue(activeDecisionId).applied, true);
	assert.equal(state.recordValidContinue(activeDecisionId).applied, false);
	assert.equal(
		state.recordInvalidDecision(activeDecisionId, "stale").applied,
		false,
	);
});

test("Slice 2: snapshots/effects are immutable and controller copies its validated config values", () => {
	const suppliedConfig = { idleDelaySeconds: 3, maxRetries: 2 };
	const state = controller(suppliedConfig);
	const initial = state.snapshot;
	const locked = state.lock();
	assert.equal(Object.isFrozen(initial), true);
	assert.equal(Object.isFrozen(locked), true);
	assert.equal(Object.isFrozen(locked.effects), true);
	assert.equal(Object.isFrozen(locked.effects[0]), true);

	const arm = armEffect(state.onAllObservableIdle());
	const snapshot = state.snapshot;
	assert.ok(snapshot.idleTimer);
	assert.equal(Object.isFrozen(snapshot.idleTimer), true);
	suppliedConfig.idleDelaySeconds = 999;
	suppliedConfig.maxRetries = 999;
	assert.equal(arm.delaySeconds, 3);
	assert.equal(snapshot.idleTimer.delaySeconds, 3);
	assert.throws(() => {
		(snapshot as unknown as { attempt: number }).attempt = 99;
	}, TypeError);
	assert.throws(() => {
		(snapshot.idleTimer as { delaySeconds: number }).delaySeconds = 99;
	}, TypeError);
});

test("Slice 2: hostile invalid-decision inputs are bounded and do not consume valid retries", () => {
	const state = controller({ idleDelaySeconds: 3, maxRetries: 2 });
	state.lock();
	const { decisionId: activeDecisionId } = openDecision(state);

	const hostile = state.recordInvalidDecision(
		activeDecisionId,
		Symbol("hostile"),
	);
	assert.deepEqual(hostile.effects, [
		{
			kind: "reaskDecision",
			decisionId: activeDecisionId,
			invalidDecisionAttempt: 1,
			error: "Invalid decision.",
		},
	]);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.snapshot.invalidDecisionAttempts, 1);
	assert.equal(state.snapshot.lastInvalidDecisionError, "Invalid decision.");
});
