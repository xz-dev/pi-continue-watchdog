import assert from "node:assert/strict";
import test from "node:test";

import {
	type ControllerTransition,
	createLockDecisionController,
} from "../src/controller.js";

function controller(maxContinue = 3) {
	return createLockDecisionController({ maxContinue });
}

function decisionId(transition: ControllerTransition): number {
	const effect = transition.effects.find(
		(candidate) => candidate.kind === "openDecisionWindow",
	);
	assert.ok(effect, "expected an openDecisionWindow effect");
	return effect.decisionId;
}

function openDecision(state: ReturnType<typeof controller>): number {
	return decisionId(state.beginDecision(Number.MAX_SAFE_INTEGER));
}

function effectKinds(transition: ControllerTransition): string[] {
	return transition.effects.map((effect) => effect.kind);
}

test("initial snapshot is unlocked with no decision window", () => {
	assert.deepEqual(controller().snapshot, {
		locked: false,
		attempt: 0,
		exhausted: false,
		callbackSuspended: false,
		decisionFailed: false,
		invalidDecisionAttempts: 0,
		lastInvalidDecisionError: null,
		decisionOpen: false,
	});
});

test("lock and main user start reset accounting and close pending decisions", () => {
	const state = controller(2);
	assert.deepEqual(state.lock().effects, [
		{ kind: "notify", notification: "locked" },
	]);
	const oldDecisionId = openDecision(state);
	state.recordInvalidDecision(oldDecisionId, "first");

	const restarted = state.onMainUserMessageStart();
	assert.deepEqual(restarted.effects, [
		{ kind: "restoreDecisionTools", decisionId: oldDecisionId },
		{ kind: "notify", notification: "locked" },
	]);
	assert.deepEqual(state.snapshot, {
		locked: true,
		attempt: 0,
		exhausted: false,
		callbackSuspended: false,
		decisionFailed: false,
		invalidDecisionAttempts: 0,
		lastInvalidDecisionError: null,
		decisionOpen: false,
	});
});

test("ensureLocked starts once and leaves an active lock untouched", () => {
	const state = controller();
	assert.equal(state.ensureLocked().applied, true);
	const activeDecisionId = openDecision(state);
	state.recordInvalidDecision(activeDecisionId, "first");

	const repeated = state.ensureLocked();
	assert.equal(repeated.applied, false);
	assert.deepEqual(repeated.effects, []);
	assert.equal(state.snapshot.decisionOpen, true);
	assert.equal(state.snapshot.invalidDecisionAttempts, 1);
	assert.equal(state.beginDecision(Number.MAX_SAFE_INTEGER).applied, false);
});

test("unlock closes pending work while preserving visible accounting", () => {
	const state = controller(2);
	state.lock();
	state.recordValidContinue(openDecision(state));
	const activeDecisionId = openDecision(state);
	state.recordInvalidDecision(activeDecisionId, "blank reason");

	const unlocked = state.unlock();
	assert.deepEqual(unlocked.effects, [
		{ kind: "restoreDecisionTools", decisionId: activeDecisionId },
		{ kind: "notify", notification: "unlocked" },
	]);
	assert.equal(state.snapshot.locked, false);
	assert.equal(state.snapshot.attempt, 1);
	assert.equal(state.snapshot.invalidDecisionAttempts, 1);
	assert.equal(state.snapshot.lastInvalidDecisionError, "blank reason");
	assert.equal(state.snapshot.decisionOpen, false);
});

test("valid continues consume only the retry budget and exhaust at max", () => {
	const state = controller(3);
	state.lock();

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const continued = state.recordValidContinue(openDecision(state));
		assert.deepEqual(effectKinds(continued), ["restoreDecisionTools"]);
		assert.equal(state.snapshot.attempt, attempt);
		assert.equal(state.snapshot.exhausted, attempt === 3);
	}

	assert.equal(state.beginDecision(Number.MAX_SAFE_INTEGER).applied, false);
});

test("valid wait is retired: recordValidWait no longer exists and no wait deadline blocks decisions", () => {
	const state = controller(3);
	state.lock();
	// The timed-wait outcome is retired from the controller surface entirely;
	// an old wait submission is one invalid response, never a scheduling state.
	assert.equal("recordValidWait" in state, false);
	assert.equal("rollbackValidWait" in state, false);
	assert.equal("waitUntilMs" in state.snapshot, false);
});

test("continuation-only exhaustion uses idle and ownership conditions, not a wait deadline", () => {
	const state = controller(1);
	state.lock();
	state.recordValidContinue(openDecision(state));
	assert.equal(state.snapshot.exhausted, true);
	assert.equal(state.beginDecision(0).applied, false);
	state.unlock();
	assert.equal(state.snapshot.exhausted, true);
});

test("stale decisions cannot consume retry budget twice", () => {
	const state = controller(1);
	state.lock();
	const activeDecisionId = openDecision(state);

	assert.equal(state.recordValidContinue(activeDecisionId).applied, true);
	assert.equal(state.recordValidContinue(activeDecisionId).applied, false);
	assert.equal(
		state.recordInvalidDecision(activeDecisionId, "stale").applied,
		false,
	);
	assert.equal(state.snapshot.attempt, 1);
});

test("invalid decisions re-ask twice without retry consumption, then fail closed", () => {
	const state = controller(2);
	state.lock();
	const activeDecisionId = openDecision(state);

	const first = state.recordInvalidDecision(activeDecisionId, "first");
	assert.deepEqual(first.effects, [
		{
			kind: "reaskDecision",
			decisionId: activeDecisionId,
			invalidDecisionAttempt: 1,
			error: "first",
		},
	]);
	const second = state.recordInvalidDecision(activeDecisionId, "second");
	assert.deepEqual(second.effects, [
		{
			kind: "reaskDecision",
			decisionId: activeDecisionId,
			invalidDecisionAttempt: 2,
			error: "second",
		},
	]);
	const third = state.recordInvalidDecision(activeDecisionId, "third");
	assert.deepEqual(third.effects, [
		{ kind: "restoreDecisionTools", decisionId: activeDecisionId },
		{ kind: "decisionFailed", error: "third" },
	]);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.snapshot.decisionFailed, true);
	assert.equal(state.snapshot.decisionOpen, false);
	assert.equal(state.beginDecision(Number.MAX_SAFE_INTEGER).applied, false);
});

test("transactional rollback restores invalid and continue accounting", () => {
	const state = controller(2);
	state.lock();
	const activeDecisionId = openDecision(state);
	state.recordInvalidDecision(activeDecisionId, "temporary");
	assert.equal(
		state.rollbackInvalidDecision(activeDecisionId, 0, null).applied,
		true,
	);
	assert.equal(state.snapshot.invalidDecisionAttempts, 0);
	assert.equal(state.snapshot.lastInvalidDecisionError, null);

	state.recordValidContinue(activeDecisionId);
	assert.equal(state.snapshot.attempt, 1);
	assert.equal(state.rollbackValidContinue().applied, true);
	assert.equal(state.snapshot.attempt, 0);
	assert.equal(state.snapshot.exhausted, false);
	assert.equal(state.rollbackValidContinue().applied, false);
});

test("invalidating and unlocking require the current decision id", () => {
	const state = controller();
	state.lock();
	const activeDecisionId = openDecision(state);

	assert.equal(state.invalidateDecision(activeDecisionId + 1).applied, false);
	assert.equal(state.recordValidUnlock(activeDecisionId + 1).applied, false);
	assert.deepEqual(state.invalidateDecision(activeDecisionId).effects, [
		{ kind: "restoreDecisionTools", decisionId: activeDecisionId },
	]);

	const unlockDecisionId = openDecision(state);
	assert.deepEqual(state.recordValidUnlock(unlockDecisionId).effects, [
		{ kind: "restoreDecisionTools", decisionId: unlockDecisionId },
		{ kind: "notify", notification: "unlocked" },
	]);
	assert.equal(state.snapshot.locked, false);
});

test("resumed invalid accounting keeps the three-response bound, separate from maxContinue", () => {
	for (const consumed of [1, 2]) {
		const state = controller(1);
		state.lock();
		const previousId = openDecision(state);
		for (let count = 0; count < consumed; count += 1) {
			state.recordInvalidDecision(previousId, "safe diagnostic");
		}
		state.invalidateDecision(previousId);
		const resumedId = openDecision(state);
		assert.equal(
			state.restoreInvalidDecisionAttempts(previousId, consumed, "stale")
				.applied,
			false,
		);
		for (const invalidCount of [-1, 0.5, 3]) {
			assert.equal(
				state.restoreInvalidDecisionAttempts(resumedId, invalidCount, "invalid")
					.applied,
				false,
			);
		}
		assert.equal(
			state.restoreInvalidDecisionAttempts(
				resumedId,
				consumed,
				"safe diagnostic",
			).applied,
			true,
		);
		assert.equal(state.snapshot.invalidDecisionAttempts, consumed);
		assert.equal(state.snapshot.lastInvalidDecisionError, "safe diagnostic");
		for (let count = consumed + 1; count <= 3; count += 1) {
			state.recordInvalidDecision(resumedId, "next diagnostic");
			assert.equal(state.snapshot.decisionFailed, count === 3);
		}
		assert.equal(state.recordValidUnlock(resumedId).applied, false);
		assert.equal(state.beginDecision(0).applied, false);
		assert.equal(state.snapshot.invalidDecisionAttempts, 3);
		assert.equal(state.snapshot.attempt, 0);
		assert.equal(state.snapshot.exhausted, false);
	}
});

test("postcommit reapply changes only the expected rolled-back continuation count", () => {
	const state = controller(2);
	state.lock();
	state.recordValidContinue(openDecision(state));
	state.rollbackValidContinue();
	for (const count of [-1, 0.5, 1, 2, Number.NaN])
		assert.equal(state.reapplyValidContinue(count).applied, false);
	assert.deepEqual(state.reapplyValidContinue(0).effects, []);
	assert.equal(state.snapshot.attempt, 1);
	assert.equal(state.reapplyValidContinue(0).applied, false);
	state.recordValidContinue(openDecision(state));
	state.rollbackValidContinue();
	assert.equal(state.reapplyValidContinue(1).applied, true);
	assert.equal(state.snapshot.exhausted, true);
	assert.equal(state.reapplyValidContinue(2).applied, false);
	state.lock();
	openDecision(state);
	assert.equal(state.reapplyValidContinue(0).applied, false);
	state.unlock();
	assert.equal(state.reapplyValidContinue(0).applied, false);
	state.lock();
	const id = openDecision(state);
	for (let i = 0; i < 3; i += 1) state.recordInvalidDecision(id, "invalid");
	assert.equal(state.reapplyValidContinue(0).applied, false);
});

test("snapshots are fresh and construction copies retry config", () => {
	const supplied = { maxContinue: 2 };
	const state = createLockDecisionController(supplied);
	state.lock();
	const first = state.snapshot;
	const second = state.snapshot;
	assert.notEqual(first, second);
	assert.deepEqual(first, second);

	supplied.maxContinue = 99;
	state.recordValidContinue(openDecision(state));
	state.recordValidContinue(openDecision(state));
	assert.equal(state.snapshot.exhausted, true);

	state.lock();
	const hostileId = openDecision(state);
	const hostile = state.recordInvalidDecision(hostileId, Symbol("invalid"));
	assert.equal(
		hostile.effects[0]?.kind === "reaskDecision"
			? hostile.effects[0].error
			: null,
		"Invalid decision.",
	);
});

test("callback suspension shares the budget, retains the lock, and blocks inquiries", () => {
	const state = controller(3);
	state.lock();
	state.recordValidContinue(openDecision(state));
	const id = openDecision(state);
	const suspended = state.recordValidCallbackSuspension(id);
	assert.equal(suspended.applied, true);
	assert.deepEqual(effectKinds(suspended), ["restoreDecisionTools"]);
	assert.equal(state.snapshot.locked, true);
	assert.equal(state.snapshot.callbackSuspended, true);
	assert.equal(state.snapshot.attempt, 2);
	assert.equal(state.snapshot.decisionOpen, false);
	// Stale/duplicate results, idle observations and rollback spend nothing.
	assert.equal(state.recordValidCallbackSuspension(id).applied, false);
	assert.equal(state.beginDecision(Number.MAX_SAFE_INTEGER).applied, false);
	assert.equal(state.rollbackValidContinue().applied, false);
	assert.equal(state.reapplyValidContinue(1).applied, false);
	assert.equal(state.snapshot.attempt, 2);
	// Callback work resumes the same cycle without spending or replenishing.
	assert.equal(state.resumeFromCallback().applied, true);
	assert.equal(state.resumeFromCallback().applied, false);
	assert.equal(state.snapshot.attempt, 2);
	assert.equal(state.snapshot.callbackSuspended, false);
	state.recordValidContinue(openDecision(state));
	assert.equal(state.snapshot.exhausted, true);
});

test("final callback unit is exhausted numerically but stays suspended until resume", () => {
	const state = controller(2);
	state.lock();
	state.recordValidContinue(openDecision(state));
	state.recordValidCallbackSuspension(openDecision(state));
	assert.equal(state.snapshot.attempt, 2);
	assert.equal(state.snapshot.exhausted, true);
	assert.equal(state.snapshot.callbackSuspended, true);
	state.resumeFromCallback();
	assert.equal(state.snapshot.exhausted, true);
	assert.equal(state.snapshot.callbackSuspended, false);
	assert.equal(state.beginDecision(Number.MAX_SAFE_INTEGER).applied, false);
});

test("unlock and a fresh lock clear callback suspension", () => {
	const state = controller(3);
	state.lock();
	state.recordValidCallbackSuspension(openDecision(state));
	state.unlock();
	assert.equal(state.snapshot.callbackSuspended, false);
	assert.equal(state.snapshot.locked, false);
	state.lock();
	state.recordValidCallbackSuspension(openDecision(state));
	state.onMainUserMessageStart();
	assert.equal(state.snapshot.callbackSuspended, false);
	assert.equal(state.snapshot.attempt, 0);
});
