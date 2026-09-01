import assert from "node:assert/strict";
import test from "node:test";

import {
	type ActivityGeneration,
	type ActivityGraceClock,
	type ActivityGraceTimerHandle,
	createActivityGraceCoordinator,
	INQUIRY_FENCE_MS,
} from "../src/activity-grace.js";

interface TimerRecord {
	readonly callback: () => void;
	readonly delayMs: number;
	cleared: boolean;
}

class FakeClock implements ActivityGraceClock {
	readonly records: TimerRecord[] = [];
	private currentTimeMs = 0;

	setTimeout(callback: () => void, delayMs: number): TimerRecord {
		const record = { callback, delayMs, cleared: false };
		this.records.push(record);
		return record;
	}

	clearTimeout(handle: ActivityGraceTimerHandle): void {
		(handle as TimerRecord).cleared = true;
	}

	now(): number {
		return this.currentTimeMs;
	}

	advance(delayMs: number): void {
		this.currentTimeMs += delayMs;
	}
}

function generation(value: number): ActivityGeneration {
	return {
		domainEpoch: "epoch",
		activityGeneration: BigInt(value),
		ownershipGeneration: 1,
		localActivityGeneration: value,
	};
}

test("an idle observation waits exactly one fixed ten-second fence", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		clock,
		onReady: (value) => ready.push(value),
	});
	const observed = generation(1);

	coordinator.update({ allIdle: true, generation: observed });
	assert.equal(coordinator.snapshot.phase, "grace");
	assert.equal(coordinator.snapshot.deadlineMs, INQUIRY_FENCE_MS);
	assert.equal(clock.records[0]?.delayMs, INQUIRY_FENCE_MS);

	clock.advance(INQUIRY_FENCE_MS - 1);
	assert.deepEqual(ready, []);
	clock.advance(1);
	clock.records[0]?.callback();
	assert.deepEqual(ready, [observed]);
	assert.equal(coordinator.snapshot.phase, "ready");
});

test("wait deadline extends the fence without adding another fence afterward", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		clock,
		onReady: (value) => ready.push(value),
	});
	const observed = generation(1);

	coordinator.update({
		allIdle: true,
		generation: observed,
		notBeforeMs: 300_000,
	});
	assert.equal(coordinator.snapshot.deadlineMs, 300_000);
	assert.equal(clock.records[0]?.delayMs, 300_000);

	clock.advance(300_000);
	clock.records[0]?.callback();
	assert.deepEqual(ready, [observed]);
});

test("activity during a wait cancels the stale timer and keeps the absolute deadline", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		clock,
		onReady: (value) => ready.push(value),
	});
	const waitUntilMs = 300_000;

	coordinator.update({
		allIdle: true,
		generation: generation(1),
		notBeforeMs: waitUntilMs,
	});
	clock.advance(100_000);
	coordinator.update({ allIdle: false, generation: generation(2) });
	assert.equal(clock.records[0]?.cleared, true);
	clock.records[0]?.callback();
	assert.deepEqual(ready, []);

	clock.advance(100_000);
	const resumed = generation(3);
	coordinator.update({
		allIdle: true,
		generation: resumed,
		notBeforeMs: waitUntilMs,
	});
	assert.equal(coordinator.snapshot.deadlineMs, waitUntilMs);
	assert.equal(clock.records[1]?.delayMs, 100_000);

	clock.advance(100_000);
	clock.records[1]?.callback();
	assert.deepEqual(ready, [resumed]);
});

test("repeated equal idle reports replace and restart the full fence", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		clock,
		onReady: (value) => ready.push(value),
	});
	const observed = generation(1);

	coordinator.update({ allIdle: true, generation: observed });
	clock.advance(9_000);
	coordinator.update({ allIdle: true, generation: observed });

	assert.equal(clock.records[0]?.cleared, true);
	assert.equal(clock.records[1]?.delayMs, INQUIRY_FENCE_MS);
	assert.equal(coordinator.snapshot.deadlineMs, 19_000);
	clock.records[0]?.callback();
	assert.deepEqual(ready, []);
	clock.advance(INQUIRY_FENCE_MS);
	clock.records[1]?.callback();
	assert.deepEqual(ready, [observed]);
});

test("busy observations cancel the candidate and stale callbacks are inert", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		clock,
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	coordinator.update({ allIdle: false, generation: generation(2) });
	assert.equal(coordinator.snapshot.phase, "blocked");
	assert.equal(clock.records[0]?.cleared, true);
	clock.records[0]?.callback();
	assert.deepEqual(ready, []);
});

test("invalidate and dispose make captured callbacks inert", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		clock,
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	coordinator.invalidate();
	clock.records[0]?.callback();
	assert.deepEqual(ready, []);

	coordinator.update({ allIdle: true, generation: generation(2) });
	coordinator.dispose();
	clock.records[1]?.callback();
	assert.deepEqual(ready, []);
	assert.equal(coordinator.snapshot.phase, "blocked");
});

test("timer identity safety does not depend on unique host handles", () => {
	const callbacks: Array<() => void> = [];
	const sharedHandle = {};
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		clock: {
			setTimeout(callback) {
				callbacks.push(callback);
				return sharedHandle;
			},
			clearTimeout() {},
			now: () => 0,
		},
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	coordinator.update({ allIdle: true, generation: generation(2) });
	callbacks[0]?.();
	assert.deepEqual(ready, []);
	callbacks[1]?.();
	assert.deepEqual(ready, [generation(2)]);
});
