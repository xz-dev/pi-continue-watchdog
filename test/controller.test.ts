import assert from "node:assert/strict";
import test from "node:test";

import {
	type ControllerTransition,
	createLockDecisionController,
} from "../src/controller.js";

function controller(maxRetries = 3) {
	return createLockDecisionController({ maxRetries });
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
		decisionFailed: false,
		invalidDecisionAttempts: 0,
		lastInvalidDecisionError: null,
		decisionOpen: false,
		waitUntilMs: 0,
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
		decisionFailed: false,
		invalidDecisionAttempts: 0,
		lastInvalidDecisionError: null,
		decisionOpen: false,
		waitUntilMs: 0,
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

test("valid wait consumes a retry, blocks early decisions, and unlock clears its timestamp", () => {
	const state = controller(3);
	state.lock();
	const waited = state.recordValidWait(openDecision(state), 310_000);
	assert.deepEqual(effectKinds(waited), ["restoreDecisionTools"]);
	assert.equal(state.snapshot.attempt, 1);
	assert.equal(state.snapshot.waitUntilMs, 310_000);
	assert.equal(state.beginDecision(309_999).applied, false);
	assert.equal(state.beginDecision(310_000).applied, true);

	state.unlock();
	assert.equal(state.snapshot.waitUntilMs, 0);
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

test("snapshots are fresh and construction copies retry config", () => {
	const supplied = { maxRetries: 2 };
	const state = createLockDecisionController(supplied);
	state.lock();
	const first = state.snapshot;
	const second = state.snapshot;
	assert.notEqual(first, second);
	assert.deepEqual(first, second);

	supplied.maxRetries = 99;
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
