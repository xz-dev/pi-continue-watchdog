import assert from "node:assert/strict";
import test from "node:test";

import type {
	DomainFence,
	DomainSnapshot,
	ProcessDomain,
} from "pi-process-domain";

import {
	createProcessDomainCoordinator,
	WATCHDOG_ROOT_PID_ENV,
} from "../src/process-domain.js";

function snapshot(generation: bigint, busy = 0): DomainSnapshot {
	return {
		domainId: "domain",
		brokerEpoch: "epoch",
		revision: generation,
		activityGeneration: generation,
		participants: 1,
		busyParticipants: busy,
		pendingSpawns: 0,
		certain: true,
		allIdle: busy === 0,
		fence: { brokerEpoch: "epoch", activityGeneration: generation },
	};
}

class FakeDomain implements ProcessDomain {
	readonly writes: string[] = [];
	closeCount = 0;
	current = snapshot(1n);
	listeners = new Set<(value: DomainSnapshot) => void>();

	snapshot(): DomainSnapshot {
		return this.current;
	}
	async setActivity(state: "busy" | "idle"): Promise<DomainSnapshot> {
		this.writes.push(state);
		this.current = snapshot(
			this.current.activityGeneration + 1n,
			state === "busy" ? 1 : 0,
		);
		for (const listener of this.listeners) listener(this.current);
		return this.current;
	}
	async reserveSpawn(): Promise<never> {
		throw new Error("unused");
	}
	subscribe(listener: (value: DomainSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async publish(): Promise<void> {}
	subscribeSignals(): () => void {
		return () => {};
	}
	async confirm(fence: DomainFence): Promise<boolean> {
		return (
			fence.brokerEpoch === this.current.brokerEpoch &&
			fence.activityGeneration === this.current.activityGeneration &&
			this.current.allIdle
		);
	}
	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

function declaredEnv(rootPid = "100"): NodeJS.ProcessEnv {
	return {
		PI_PROCESS_DOMAIN_ID: "abcdefghijklmnop",
		PI_PROCESS_DOMAIN_KEY: Buffer.alloc(32).toString("base64url"),
		PI_PROCESS_DOMAIN_PROTOCOL: "1.0",
		[WATCHDOG_ROOT_PID_ENV]: rootPid,
	};
}

test("one coordinator opens one participant and aggregates attachments", async () => {
	const domain = new FakeDomain();
	let opens = 0;
	const env: NodeJS.ProcessEnv = {};
	const coordinator = createProcessDomainCoordinator({
		env,
		pid: 100,
		open: async () => {
			opens += 1;
			return { domain, created: true };
		},
	});
	const first = {};
	const second = {};
	await coordinator.attach(first, { initialBusy: false, onFatal() {} });
	await coordinator.attach(second, { initialBusy: false, onFatal() {} });
	assert.equal(opens, 1);
	assert.equal(coordinator.isRootProcess, true);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], "100");

	await coordinator.markBusy(first);
	await coordinator.markBusy(second, { internalDecision: true });
	await coordinator.markIdle(first);
	assert.deepEqual(domain.writes, ["busy", "idle"]);

	await coordinator.detach(first);
	assert.equal(domain.closeCount, 0);
	await coordinator.detach(second);
	assert.equal(domain.closeCount, 1);
});

test("a predeclared domain without a marker is observer-only", async () => {
	const domain = new FakeDomain();
	const env = declaredEnv();
	delete env[WATCHDOG_ROOT_PID_ENV];
	const coordinator = createProcessDomainCoordinator({
		env,
		pid: 200,
		open: async () => ({ domain, created: false }),
	});
	await coordinator.attach({}, { initialBusy: false, onFatal() {} });
	assert.equal(coordinator.isRootProcess, false);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], undefined);
});

test("a different inherited pid is observer-only", async () => {
	const domain = new FakeDomain();
	const coordinator = createProcessDomainCoordinator({
		env: declaredEnv("100"),
		pid: 200,
		open: async () => ({ domain, created: false }),
	});
	await coordinator.attach({}, { initialBusy: false, onFatal() {} });
	assert.equal(coordinator.isRootProcess, false);
});

test("partial or marker-inconsistent declarations fail closed", async () => {
	for (const env of [
		{ PI_PROCESS_DOMAIN_ID: "partial" },
		{ [WATCHDOG_ROOT_PID_ENV]: "100" },
		{ ...declaredEnv(), [WATCHDOG_ROOT_PID_ENV]: "not-a-pid" },
	]) {
		const coordinator = createProcessDomainCoordinator({
			env,
			pid: 100,
			open: async () => {
				throw new Error("must not open");
			},
		});
		await assert.rejects(
			coordinator.attach({}, { initialBusy: false, onFatal() {} }),
		);
	}
});

test("subscriptions and fence confirmation use the broker view", async () => {
	const domain = new FakeDomain();
	const coordinator = createProcessDomainCoordinator({
		env: declaredEnv(),
		pid: 100,
		open: async () => ({ domain, created: false }),
	});
	const seen: bigint[] = [];
	const sources: Array<"local" | "domain"> = [];
	coordinator.subscribe((value, source) => {
		seen.push(value.activityGeneration);
		sources.push(source);
	});
	const attachment = {};
	await coordinator.attach(attachment, { initialBusy: false, onFatal() {} });
	const fence = coordinator.snapshot.fence;
	assert.equal(await coordinator.confirm(fence), true);
	await coordinator.markBusy(attachment);
	assert.equal(await coordinator.confirm(fence), false);
	assert.deepEqual(sources, ["domain", "local"]);
	assert.deepEqual(seen, [1n, 2n]);
});
