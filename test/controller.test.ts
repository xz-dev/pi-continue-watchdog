import assert from "node:assert/strict";
import test from "node:test";

import { createLockDecisionController } from "../src/controller.js";

function controller(maxRetries = 3) {
	return createLockDecisionController({ maxRetries });
}

test("initial snapshot is unlocked with empty accounting", () => {
	assert.deepEqual(controller().snapshot, {
		locked: false,
		attempt: 0,
		exhausted: false,
	});
});

test("lock and main user start reset accounting", () => {
	const state = controller(2);
	assert.deepEqual(state.lock().effects, [
		{ kind: "notify", notification: "locked" },
	]);
	assert.equal(state.recordAutomaticContinue().applied, true);
	assert.equal(state.snapshot.attempt, 1);

	const restarted = state.onMainUserMessageStart();
	assert.deepEqual(restarted.effects, [
		{ kind: "notify", notification: "locked" },
	]);
	assert.deepEqual(state.snapshot, {
		locked: true,
		attempt: 0,
		exhausted: false,
	});
});

test("ensureLocked preserves an existing cycle", () => {
	const state = controller(2);
	state.lock();
	state.recordAutomaticContinue();
	const transition = state.ensureLocked();
	assert.equal(transition.applied, false);
	assert.deepEqual(state.snapshot, {
		locked: true,
		attempt: 1,
		exhausted: false,
	});
});

test("ensureLocked silently starts a fresh cycle when unlocked", () => {
	const state = controller(2);
	state.lock();
	state.recordAutomaticContinue();
	const transition = state.ensureLocked();
	assert.equal(transition.applied, false || state.snapshot.locked === false);
	// unlocked + ensureLocked => lock applied and accounting reset
	const state2 = controller(2);
	state2.lock();
	state2.unlock();
	const locked = state2.ensureLocked();
	assert.equal(locked.applied, true);
	assert.deepEqual(state2.snapshot, {
		locked: true,
		attempt: 0,
		exhausted: false,
	});
	assert.equal(transition.applied, false);
});

test("unlock keeps attempt and exhaustion visible until fresh lock", () => {
	const state = controller(1);
	state.lock();
	state.recordAutomaticContinue();
	assert.equal(state.snapshot.exhausted, true);
	const transition = state.unlock();
	assert.deepEqual(transition.effects, [
		{ kind: "notify", notification: "unlocked" },
	]);
	assert.deepEqual(state.snapshot, {
		locked: false,
		attempt: 1,
		exhausted: true,
	});
	state.lock();
	assert.deepEqual(state.snapshot, {
		locked: true,
		attempt: 0,
		exhausted: false,
	});
});

test("recordAutomaticContinue counts attempts and sets exhaustion at budget", () => {
	const state = controller(3);
	state.lock();
	assert.equal(state.recordAutomaticContinue().applied, true);
	assert.equal(state.snapshot.attempt, 1);
	assert.equal(state.snapshot.exhausted, false);
	state.recordAutomaticContinue();
	assert.equal(state.snapshot.attempt, 2);
	assert.equal(state.snapshot.exhausted, false);
	state.recordAutomaticContinue();
	assert.equal(state.snapshot.attempt, 3);
	assert.equal(state.snapshot.exhausted, true);
	// Exhausted: further continuations are refused.
	assert.equal(state.recordAutomaticContinue().applied, false);
	assert.equal(state.snapshot.attempt, 3);
});

test("recordAutomaticContinue is refused while unlocked", () => {
	const state = controller(3);
	assert.equal(state.recordAutomaticContinue().applied, false);
	assert.equal(state.snapshot.attempt, 0);
});

test("rollbackAutomaticContinue undoes one consumed attempt", () => {
	const state = controller(2);
	state.lock();
	state.recordAutomaticContinue();
	const rolled = state.rollbackAutomaticContinue();
	assert.equal(rolled.applied, true);
	assert.deepEqual(state.snapshot, {
		locked: true,
		attempt: 0,
		exhausted: false,
	});
	// Nothing left to roll back.
	assert.equal(state.rollbackAutomaticContinue().applied, false);
});

test("exhaustion clears after rollback", () => {
	const state = controller(1);
	state.lock();
	state.recordAutomaticContinue();
	assert.equal(state.snapshot.exhausted, true);
	state.rollbackAutomaticContinue();
	assert.equal(state.snapshot.exhausted, false);
});

test("recordAiUnlock unlocks without resetting accounting", () => {
	const state = controller(3);
	state.lock();
	state.recordAutomaticContinue();
	const transition = state.recordAiUnlock();
	assert.equal(transition.applied, true);
	assert.deepEqual(transition.effects, [
		{ kind: "notify", notification: "unlocked" },
	]);
	assert.deepEqual(state.snapshot, {
		locked: false,
		attempt: 1,
		exhausted: false,
	});
	// Second unlock while already unlocked is a no-op.
	assert.equal(state.recordAiUnlock().applied, false);
});

test("continuation after AI unlock is refused until a fresh lock", () => {
	const state = controller(3);
	state.lock();
	state.recordAiUnlock();
	assert.equal(state.recordAutomaticContinue().applied, false);
	state.lock();
	assert.equal(state.recordAutomaticContinue().applied, true);
});
