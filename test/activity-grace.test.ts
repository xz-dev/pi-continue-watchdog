import assert from "node:assert/strict";
import test from "node:test";

import {
	type ActivityGeneration,
	type ActivityGraceClock,
	type ActivityGraceTimerHandle,
	createActivityGraceCoordinator,
} from "../src/activity-grace.js";

interface TimerRecord {
	readonly callback: () => void;
	readonly delayMs: number;
	cleared: boolean;
	unrefCount: number;
}

class FakeClock implements ActivityGraceClock {
	readonly records: TimerRecord[] = [];
	private currentTimeMs = 0;

	setTimeout(callback: () => void, delayMs: number): TimerRecord {
		const record: TimerRecord = {
			callback,
			delayMs,
			cleared: false,
			unrefCount: 0,
		};
		this.records.push(record);
		return record;
	}

	clearTimeout(handle: ActivityGraceTimerHandle): void {
		(handle as TimerRecord).cleared = true;
	}

	now(): number {
		return this.currentTimeMs;
	}

	advanceWithoutFiring(delayMs: number): void {
		this.currentTimeMs += delayMs;
	}

	fire(index: number): void {
		const record = this.records[index];
		assert.ok(record, `expected timer ${index}`);
		if (record.cleared) return;
		this.currentTimeMs += record.delayMs;
		record.callback();
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

test("one aggregate all-idle generation gets one fixed grace", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		graceSeconds: 10,
		clock,
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	coordinator.update({ allIdle: true, generation: generation(1) });

	assert.equal(coordinator.snapshot.phase, "grace");
	assert.equal(coordinator.snapshot.deadlineMs, 10_000);
	assert.equal(clock.records.length, 1);
	assert.equal(clock.records[0]?.delayMs, 10_000);

	clock.fire(0);
	assert.equal(coordinator.snapshot.phase, "ready");
	assert.deepEqual(ready, [generation(1)]);

	coordinator.update({ allIdle: true, generation: generation(1) });
	assert.equal(clock.records.length, 1);
	assert.deepEqual(ready, [generation(1)]);
});

test("reobserving one generation does not alter the fixed grace deadline", () => {
	const clock = new FakeClock();
	const coordinator = createActivityGraceCoordinator({
		graceSeconds: 10,
		clock,
		onReady: () => {},
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	clock.advanceWithoutFiring(4_000);
	coordinator.update({ allIdle: true, generation: generation(1) });

	assert.equal(coordinator.snapshot.deadlineMs, 10_000);
	assert.equal(clock.records.length, 1);
});

test("activity invalidates the old grace callback and a new idle generation gets a full grace", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		graceSeconds: 10,
		clock,
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	coordinator.update({ allIdle: false, generation: generation(2) });
	assert.equal(coordinator.snapshot.phase, "blocked");
	assert.equal(clock.records[0]?.cleared, true);

	// A callback already queued by the host must still be strictly inert.
	clock.records[0]?.callback();
	assert.deepEqual(ready, []);

	coordinator.update({ allIdle: true, generation: generation(3) });
	assert.equal(coordinator.snapshot.phase, "grace");
	assert.equal(clock.records[1]?.delayMs, 10_000);

	clock.fire(1);
	assert.deepEqual(ready, [generation(3)]);
});

test("a changed all-idle generation replaces grace and stales the old callback", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		graceSeconds: 10,
		clock,
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	clock.advanceWithoutFiring(3_000);
	coordinator.update({ allIdle: true, generation: generation(2) });

	assert.equal(clock.records[0]?.cleared, true);
	assert.equal(clock.records[1]?.delayMs, 10_000);
	assert.equal(coordinator.snapshot.deadlineMs, 13_000);

	clock.records[0]?.callback();
	assert.deepEqual(ready, []);
	clock.fire(1);
	assert.deepEqual(ready, [generation(2)]);
});

test("one generation cannot rearm after becoming blocked", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		graceSeconds: 10,
		clock,
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	clock.fire(0);
	assert.deepEqual(ready, [generation(1)]);

	coordinator.update({ allIdle: false, generation: generation(1) });
	coordinator.update({ allIdle: true, generation: generation(1) });
	assert.equal(coordinator.snapshot.phase, "blocked");
	assert.equal(clock.records.length, 1);
	assert.deepEqual(ready, [generation(1)]);

	coordinator.update({ allIdle: true, generation: generation(2) });
	assert.equal(coordinator.snapshot.phase, "grace");
	assert.equal(clock.records.length, 2);
});

test("wall-clock deadline is preserved when a long timer is chunked", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		graceSeconds: 3_000_000,
		clock,
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	assert.equal(clock.records[0]?.delayMs, 2 ** 31 - 1);
	clock.fire(0);

	assert.equal(coordinator.snapshot.phase, "grace");
	assert.equal(clock.records[1]?.delayMs, 3_000_000_000 - (2 ** 31 - 1));
	clock.fire(1);
	assert.deepEqual(ready, [generation(1)]);
});

test("timer safety does not depend on unique handles", () => {
	const callbacks: Array<() => void> = [];
	const sharedHandle = {};
	let now = 0;
	const clock: ActivityGraceClock = {
		setTimeout(callback) {
			callbacks.push(callback);
			return sharedHandle;
		},
		clearTimeout() {},
		now: () => now,
	};
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		graceSeconds: 10,
		clock,
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	coordinator.update({ allIdle: false, generation: generation(2) });
	coordinator.update({ allIdle: true, generation: generation(3) });
	now = 10_000;

	callbacks[0]?.();
	assert.deepEqual(ready, []);
	callbacks[1]?.();
	assert.deepEqual(ready, [generation(3)]);
});

test("explicit invalidation consumes the generation until activity changes", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		graceSeconds: 10,
		clock,
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	coordinator.invalidate();
	assert.equal(coordinator.snapshot.phase, "blocked");
	assert.deepEqual(coordinator.snapshot.generation, generation(1));
	assert.equal(clock.records[0]?.cleared, true);

	coordinator.update({ allIdle: true, generation: generation(1) });
	assert.equal(coordinator.snapshot.phase, "blocked");
	assert.equal(clock.records.length, 1);
	clock.records[0]?.callback();
	assert.deepEqual(ready, []);

	coordinator.update({ allIdle: true, generation: generation(2) });
	assert.equal(coordinator.snapshot.phase, "grace");
	assert.equal(clock.records[1]?.delayMs, 10_000);
	clock.fire(1);
	assert.deepEqual(ready, [generation(2)]);
});

test("dispose makes every previously captured callback inert", () => {
	const clock = new FakeClock();
	const ready: ActivityGeneration[] = [];
	const coordinator = createActivityGraceCoordinator({
		graceSeconds: 10,
		clock,
		onReady: (value) => ready.push(value),
	});

	coordinator.update({ allIdle: true, generation: generation(1) });
	coordinator.dispose();
	assert.equal(coordinator.snapshot.phase, "blocked");
	assert.equal(clock.records[0]?.cleared, true);

	clock.records[0]?.callback();
	coordinator.update({ allIdle: true, generation: generation(2) });
	assert.deepEqual(ready, []);
	assert.equal(clock.records.length, 1);
});
