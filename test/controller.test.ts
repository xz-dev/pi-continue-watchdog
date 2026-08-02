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

test("initial snapshot is unlocked with no timer or decision window", () => {
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
});

test("manual lock and main user start always reset, cancel pending work, and notify", () => {
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

test("unlock is unconditional and cancels or restores pending work", () => {
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

	state.lock();
	const { decisionId: validUnlockDecisionId } = openDecision(state);
	const validUnlock = state.recordValidUnlock(validUnlockDecisionId);
	assert.deepEqual(validUnlock.effects, [
		{ kind: "restoreDecisionTools", decisionId: validUnlockDecisionId },
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

test("valid continues advance zero-based exponential delays then exhaust", () => {
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

test("stale continue cannot double-consume the retry budget", () => {
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

test("manual lock or main user start resets exhausted and decision-failed state", () => {
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

test("invalid decisions re-ask twice without retry consumption, then decision-fail", () => {
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

	const reset = state.onMainUserMessageStart();
	assert.equal(reset.applied, true);
	assert.deepEqual(reset.effects, [{ kind: "notify", notification: "locked" }]);
	assert.equal(state.snapshot.decisionFailed, false);
	assert.equal(state.snapshot.invalidDecisionAttempts, 0);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.onAllObservableIdle().applied, true);
});

test("busy cancels the delay and the next all-idle arms the same attempt again", () => {
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

test("stale idle, timer, and decision ids are inert", () => {
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

test("snapshots are fresh objects and config values are copied at construction", () => {
	const suppliedConfig = { idleDelaySeconds: 3, maxRetries: 2 };
	const state = controller(suppliedConfig);
	const locked = state.lock();
	const arm = armEffect(state.onAllObservableIdle());
	const snapA = state.snapshot;
	const snapB = state.snapshot;

	assert.notEqual(snapA, snapB);
	assert.deepEqual(snapA, snapB);
	assert.notEqual(locked.effects, state.lock().effects);

	suppliedConfig.idleDelaySeconds = 999;
	suppliedConfig.maxRetries = 999;
	assert.equal(arm.delaySeconds, 3);

	const nonString = openDecision(state);
	const hostile = state.recordInvalidDecision(
		nonString.decisionId,
		Symbol("not-a-string"),
	);
	assert.equal(
		hostile.effects[0]?.kind === "reaskDecision"
			? hostile.effects[0].error
			: null,
		"Invalid decision.",
	);
});
