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

test("final root detach resets topology and clears its marker", async () => {
	const domain = new FakeDomain();
	const env: NodeJS.ProcessEnv = {};
	const coordinator = createProcessDomainCoordinator({
		env,
		pid: 100,
		open: async () => ({ domain, created: true }),
	});
	const attachment = {};
	await coordinator.attach(attachment, { initialBusy: false, onFatal() {} });
	await coordinator.detach(attachment);

	assert.equal(coordinator.isRootProcess, false);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], undefined);
	assert.equal(domain.closeCount, 1);
});

test("reattach after final root detach creates a fresh root", async () => {
	const domains = [new FakeDomain(), new FakeDomain()];
	const env: NodeJS.ProcessEnv = {};
	let opens = 0;
	const coordinator = createProcessDomainCoordinator({
		env,
		pid: 100,
		open: async () => ({
			domain: domains[opens++] as FakeDomain,
			created: true,
		}),
	});
	const first = {};
	await coordinator.attach(first, { initialBusy: false, onFatal() {} });
	await coordinator.detach(first);
	const second = {};
	await coordinator.attach(second, { initialBusy: false, onFatal() {} });

	assert.equal(opens, 2);
	assert.equal(coordinator.isRootProcess, true);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], "100");
	assert.equal(domains[0]?.closeCount, 1);
	await coordinator.detach(second);
});

test("concurrent final detach and attach wait for teardown then open a fresh root", async () => {
	let releaseClose = () => {};
	const closeStarted = new Promise<void>((resolve) => {
		releaseClose = resolve;
	});
	let allowClose = () => {};
	const closeAllowed = new Promise<void>((resolve) => {
		allowClose = resolve;
	});
	const firstDomain = new FakeDomain();
	const domains = [firstDomain, new FakeDomain()];
	firstDomain.close = async () => {
		firstDomain.closeCount += 1;
		releaseClose();
		await closeAllowed;
	};
	const env: NodeJS.ProcessEnv = {};
	let opens = 0;
	const coordinator = createProcessDomainCoordinator({
		env,
		pid: 100,
		open: async () => ({
			domain: domains[opens++] as FakeDomain,
			created: true,
		}),
	});
	const first = {};
	const second = {};
	await coordinator.attach(first, { initialBusy: false, onFatal() {} });
	const detach = coordinator.detach(first);
	await closeStarted;
	const attach = coordinator.attach(second, {
		initialBusy: false,
		onFatal() {},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(opens, 1, "reattach must wait while the old root is closing");
	allowClose();
	await Promise.all([detach, attach]);

	assert.equal(opens, 2);
	assert.equal(coordinator.isRootProcess, true);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], "100");
	assert.equal(coordinator.snapshot.brokerEpoch, "epoch");
	assert.equal(domains[0]?.closeCount, 1);
	assert.equal(domains[1]?.closeCount, 0);
	await coordinator.detach(second);
	assert.equal(domains[1]?.closeCount, 1);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], undefined);
});

test("final observer detach preserves the inherited foreign marker", async () => {
	const domain = new FakeDomain();
	const env = declaredEnv("100");
	const coordinator = createProcessDomainCoordinator({
		env,
		pid: 200,
		open: async () => ({ domain, created: false }),
	});
	const attachment = {};
	await coordinator.attach(attachment, { initialBusy: false, onFatal() {} });
	await coordinator.detach(attachment);

	assert.equal(coordinator.isRootProcess, false);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], "100");
	assert.equal(domain.closeCount, 1);
});

test("final root detach preserves a replaced foreign marker", async () => {
	const domain = new FakeDomain();
	const env: NodeJS.ProcessEnv = {};
	const coordinator = createProcessDomainCoordinator({
		env,
		pid: 100,
		open: async () => ({ domain, created: true }),
	});
	const attachment = {};
	await coordinator.attach(attachment, { initialBusy: false, onFatal() {} });
	env[WATCHDOG_ROOT_PID_ENV] = "200";
	await coordinator.detach(attachment);

	assert.equal(coordinator.isRootProcess, false);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], "200");
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

test("failed initial attach rolls back and a later attachment opens fresh", async () => {
	for (const failure of ["open", "snapshot", "subscribe", "marker"] as const) {
		let failMarker = failure === "marker";
		const env: NodeJS.ProcessEnv =
			failure === "marker"
				? new Proxy<NodeJS.ProcessEnv>(
						{},
						{
							set(target, property, value) {
								Reflect.set(target, property, value);
								if (failMarker) {
									failMarker = false;
									throw new Error("transient marker failure");
								}
								return true;
							},
						},
					)
				: {};
		const failedDomain = new FakeDomain();
		const domain = new FakeDomain();
		if (failure === "marker") {
			failedDomain.close = async () => {
				failedDomain.closeCount += 1;
				throw new Error("rollback close failure");
			};
		}
		let opens = 0;
		let firstFatal = 0;
		let secondFatal = 0;
		if (failure === "snapshot") {
			failedDomain.snapshot = () => {
				throw new Error("transient snapshot failure");
			};
		}
		if (failure === "subscribe") {
			failedDomain.subscribe = () => {
				throw new Error("transient subscribe failure");
			};
		}
		const coordinator = createProcessDomainCoordinator({
			env,
			pid: 100,
			open: async () => {
				opens += 1;
				if (opens === 1) {
					if (failure === "open") throw new Error("transient open failure");
					return { domain: failedDomain, created: true };
				}
				return { domain, created: true };
			},
		});
		await assert.rejects(
			coordinator.attach(
				{},
				{
					initialBusy: false,
					onFatal() {
						firstFatal += 1;
					},
				},
			),
			new RegExp(`transient ${failure} failure`),
		);
		assert.equal(failedDomain.closeCount, failure === "open" ? 0 : 1);
		assert.equal(env[WATCHDOG_ROOT_PID_ENV], undefined);
		assert.equal(coordinator.isRootProcess, false);
		assert.equal(coordinator.snapshot.domainId, "pending");

		const second = {};
		await coordinator.attach(second, {
			initialBusy: false,
			onFatal() {
				secondFatal += 1;
			},
		});
		assert.equal(opens, 2);
		assert.equal(firstFatal, 1);
		assert.equal(secondFatal, 0);
		assert.equal(coordinator.isRootProcess, true);
		await coordinator.detach(second);
		assert.equal(domain.closeCount, 1);
	}
});

test("final root detach recovers from a rejected write and reopens fresh", async () => {
	const domains = [new FakeDomain(), new FakeDomain()];
	const env: NodeJS.ProcessEnv = {};
	let opens = 0;
	let failNext = true;
	const firstDomain = domains[0];
	assert.ok(firstDomain);
	const firstSetActivity = firstDomain.setActivity.bind(firstDomain);
	firstDomain.setActivity = async (state) => {
		if (failNext) {
			failNext = false;
			throw new Error("stale participant lease");
		}
		return firstSetActivity(state);
	};
	const coordinator = createProcessDomainCoordinator({
		env,
		pid: 100,
		open: async () => ({
			domain: domains[opens++] as FakeDomain,
			created: true,
		}),
	});
	const first = {};
	await coordinator.attach(first, { initialBusy: false, onFatal() {} });
	await assert.rejects(coordinator.markBusy(first), /stale participant/);
	await coordinator.detach(first);

	assert.equal(domains[0]?.closeCount, 1);
	assert.equal(coordinator.isRootProcess, false);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], undefined);

	const second = {};
	await coordinator.attach(second, { initialBusy: false, onFatal() {} });
	assert.equal(opens, 2);
	assert.equal(coordinator.isRootProcess, true);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], "100");
	assert.equal(coordinator.snapshot.brokerEpoch, "epoch");
	await coordinator.detach(second);
	assert.equal(domains[1]?.closeCount, 1);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], undefined);
});

test("final detach does not hide a close failure", async () => {
	const domain = new FakeDomain();
	domain.close = async () => {
		domain.closeCount += 1;
		throw new Error("close failed");
	};
	const coordinator = createProcessDomainCoordinator({
		env: {},
		pid: 100,
		open: async () => ({ domain, created: true }),
	});
	const attachment = {};
	await coordinator.attach(attachment, { initialBusy: false, onFatal() {} });

	await assert.rejects(coordinator.detach(attachment), /close failed/);
	assert.equal(domain.closeCount, 1);
	assert.equal(coordinator.isRootProcess, false);
});

test("a rejected runtime write does not poison later coordinator writes", async () => {
	const domain = new FakeDomain();
	let failNext = true;
	const originalSetActivity = domain.setActivity.bind(domain);
	domain.setActivity = async (state) => {
		if (failNext) {
			failNext = false;
			throw new Error("stale participant lease");
		}
		return originalSetActivity(state);
	};
	const coordinator = createProcessDomainCoordinator({
		env: declaredEnv(),
		pid: 100,
		open: async () => ({ domain, created: false }),
	});
	const attachment = {};
	await coordinator.attach(attachment, { initialBusy: false, onFatal() {} });

	await assert.rejects(coordinator.markBusy(attachment), /stale participant/);
	await coordinator.markIdle(attachment);
	assert.deepEqual(domain.writes, ["idle"]);
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
