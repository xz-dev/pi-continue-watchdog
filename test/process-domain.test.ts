import assert from "node:assert/strict";
import test from "node:test";

import type {
	ProcessDomainDataMessage,
	ProcessDomainEvent,
	ProcessDomainNode,
} from "pi-extension-utils/process-domain";

import {
	createProcessDomainCoordinator,
	ProcessDomainFatalError,
	WATCHDOG_ROOT_PID_ENV,
} from "../src/process-domain.js";

class FakeNode implements ProcessDomainNode {
	readonly nodeId: string;
	readonly transport = "ipc" as const;
	readonly endpoint = "ipc://temporary";
	readonly declaration;
	readonly sent: Array<{ targetId: string; channel: string; value: unknown }> =
		[];
	readonly broadcasts: Array<{ channel: string; value: unknown }> = [];
	closeCount = 0;
	sendError: Error | null = null;
	sendBarrier: Promise<void> | null = null;
	onSubscribe: ((channel: string) => void) | null = null;
	private readonly channelListeners = new Map<
		string,
		Set<(message: ProcessDomainDataMessage) => void>
	>();
	private readonly eventListeners = new Set<
		(event: ProcessDomainEvent) => void
	>();
	private readonly peerValues = new Map<
		string,
		ReturnType<ProcessDomainNode["peers"]>[number]
	>();

	constructor(
		readonly role: "host" | "client",
		nodeId: string = role,
	) {
		this.nodeId = nodeId;
		this.declaration = {
			version: 1 as const,
			domainId: "domain",
			endpoint: this.endpoint,
			capability: "capability",
			hostNodeId: "host",
		};
	}

	peers() {
		return Array.from(this.peerValues.values());
	}

	async send(targetId: string, channel: string, value: unknown): Promise<void> {
		this.sent.push({ targetId, channel, value });
		if (this.sendBarrier !== null) await this.sendBarrier;
		if (this.sendError !== null) throw this.sendError;
	}

	async broadcast(channel: string, value: unknown): Promise<void> {
		this.broadcasts.push({ channel, value });
	}

	async reportLifecycle(): Promise<void> {}

	subscribe(
		channel: string,
		listener: (message: ProcessDomainDataMessage) => void,
	): () => void {
		let listeners = this.channelListeners.get(channel);
		if (listeners === undefined) {
			listeners = new Set();
			this.channelListeners.set(channel, listeners);
		}
		listeners.add(listener);
		this.onSubscribe?.(channel);
		return () => listeners?.delete(listener);
	}

	subscribeEvents(listener: (event: ProcessDomainEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}

	emitChannel(channel: string, value: unknown, senderId = "child"): void {
		const message: ProcessDomainDataMessage = {
			id: "message",
			channel,
			value,
			senderId,
			targetId: this.nodeId,
			receivedAt: Date.now(),
		};
		for (const listener of this.channelListeners.get(channel) ?? []) {
			listener(message);
		}
	}

	emitPeer(nodeId: string, status: "online" | "offline"): void {
		const peer = {
			nodeId,
			status,
			metadata: { activity: "idle" },
			connectedAt: Date.now(),
			...(status === "offline" ? { disconnectedAt: Date.now() } : {}),
		} as const;
		this.peerValues.set(nodeId, peer);
		for (const listener of this.eventListeners) {
			listener({ type: "peer", peer });
		}
	}
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("host aggregates local attachments and owns immutable idle generations", async () => {
	const node = new FakeNode("host");
	const env: NodeJS.ProcessEnv = {};
	let opens = 0;
	const coordinator = createProcessDomainCoordinator({
		env,
		pid: 100,
		open: async () => {
			opens += 1;
			return node;
		},
	});
	const first = {};
	const second = {};
	await coordinator.attach(first, { initialBusy: false, onFatal() {} });
	await coordinator.attach(second, { initialBusy: false, onFatal() {} });

	assert.equal(opens, 1);
	assert.equal(coordinator.isRootProcess, true);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], "100");
	assert.equal(coordinator.snapshot.participants, 1);
	assert.equal(coordinator.snapshot.allIdle, true);
	const idleFence = coordinator.snapshot.fence;
	assert.equal(coordinator.confirm(idleFence), true);

	await coordinator.markBusy(first);
	assert.equal(coordinator.snapshot.busyParticipants, 1);
	assert.equal(coordinator.snapshot.allIdle, false);
	assert.equal(coordinator.confirm(idleFence), false);

	await coordinator.markBusy(second, { internalDecision: true });
	await coordinator.markIdle(first);
	assert.equal(coordinator.snapshot.allIdle, true);

	await coordinator.detach(first);
	assert.equal(node.closeCount, 0);
	await coordinator.detach(second);
	assert.equal(node.closeCount, 1);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], undefined);
	assert.equal(coordinator.isRootProcess, false);
});

test("host reduces versioned remote activity into watchdog state", async () => {
	const node = new FakeNode("host");
	const coordinator = createProcessDomainCoordinator({
		env: {},
		open: async () => node,
	});
	const seen: bigint[] = [];
	coordinator.subscribe((snapshot) => seen.push(snapshot.activityGeneration));
	await coordinator.attach({}, { initialBusy: false, onFatal() {} });

	node.emitPeer("child", "online");
	await flush();
	assert.equal(coordinator.snapshot.participants, 2);
	assert.equal(coordinator.snapshot.certain, false);
	assert.equal(coordinator.snapshot.allIdle, false);
	node.emitChannel("pi-continue-watchdog.activity.v1", {
		state: "idle",
		revision: "1",
	});
	await flush();
	assert.equal(coordinator.snapshot.certain, true);
	assert.equal(coordinator.snapshot.allIdle, true);

	node.emitChannel("pi-continue-watchdog.activity.v1", {
		state: "busy",
		revision: "2",
	});
	await flush();
	assert.equal(coordinator.snapshot.busyParticipants, 1);
	node.emitChannel("pi-continue-watchdog.activity.v1", {
		state: "idle",
		revision: "1",
	});
	await flush();
	assert.equal(coordinator.snapshot.busyParticipants, 1);
	node.emitChannel("pi-continue-watchdog.activity.v1", {
		state: "idle",
		revision: "3",
	});
	await flush();
	assert.equal(coordinator.snapshot.allIdle, true);

	node.emitPeer("child", "offline");
	await flush();
	assert.equal(coordinator.snapshot.participants, 2);
	assert.equal(coordinator.snapshot.certain, false);
	node.emitChannel("pi-continue-watchdog.activity.v1", {
		state: "idle",
		revision: "4",
	});
	await flush();
	assert.equal(coordinator.snapshot.certain, false);
	node.emitPeer("child", "online");
	await flush();
	assert.equal(coordinator.snapshot.certain, false);
	node.emitChannel("pi-continue-watchdog.activity.v1", {
		state: "idle",
		revision: "4",
	});
	await flush();
	assert.equal(coordinator.snapshot.certain, true);
	assert.equal(coordinator.snapshot.allIdle, true);
	assert.equal(seen.length >= 5, true);
});

test("initial client attach reserves activity revision before snapshot subscription", async () => {
	const node = new FakeNode("client", "child");
	node.emitPeer("host", "online");
	node.onSubscribe = (channel) => {
		if (channel !== "pi-continue-watchdog.snapshot.v1") return;
		node.emitChannel(
			channel,
			{
				domainId: "domain",
				domainEpoch: "domain",
				revision: "1",
				activityGeneration: "1",
				participants: 2,
				busyParticipants: 0,
				allIdle: true,
				certain: true,
				activityRevisions: [],
			},
			"host",
		);
	};
	const coordinator = createProcessDomainCoordinator({
		env: { PI_EXTENSION_UTILS_PROCESS_DOMAIN: "declaration" },
		open: async () => node,
	});
	await coordinator.attach({}, { initialBusy: false, onFatal() {} });
	assert.equal(node.sent.length, 1);
	assert.deepEqual(node.sent.at(-1)?.value, {
		state: "idle",
		revision: "1",
	});
	assert.equal(coordinator.snapshot.certain, false);
	node.emitChannel(
		"pi-continue-watchdog.snapshot.v1",
		{
			domainId: "domain",
			domainEpoch: "domain",
			revision: "2",
			activityGeneration: "2",
			participants: 2,
			busyParticipants: 0,
			allIdle: true,
			certain: true,
			activityRevisions: [{ nodeId: "child", revision: "1" }],
		},
		"host",
	);
	assert.equal(coordinator.snapshot.certain, true);
	const second = {};
	await coordinator.attach(second, { initialBusy: false, onFatal() {} });
	assert.equal(node.sent.length, 2);
	assert.deepEqual(node.sent.at(-1)?.value, {
		state: "idle",
		revision: "2",
	});
	await coordinator.detach(second);
	assert.equal(node.sent.length, 3);
	assert.deepEqual(node.sent.at(-1)?.value, {
		state: "idle",
		revision: "3",
	});
});

test("client requires host snapshots to acknowledge its current activity revision", async () => {
	const node = new FakeNode("client", "child");
	const coordinator = createProcessDomainCoordinator({
		env: { PI_EXTENSION_UTILS_PROCESS_DOMAIN: "declaration" },
		open: async () => node,
	});
	const attachment = {};
	await coordinator.attach(attachment, { initialBusy: false, onFatal() {} });
	assert.equal(coordinator.isRootProcess, false);
	assert.deepEqual(node.sent.at(-1), {
		targetId: "host",
		channel: "pi-continue-watchdog.activity.v1",
		value: { state: "idle", revision: "1" },
	});

	node.emitPeer("host", "online");
	await flush();
	assert.deepEqual(node.sent.at(-1)?.value, {
		state: "idle",
		revision: "2",
	});
	node.emitChannel(
		"pi-continue-watchdog.snapshot.v1",
		{
			domainId: "domain",
			domainEpoch: "domain",
			revision: "4",
			activityGeneration: "3",
			participants: 2,
			busyParticipants: 0,
			allIdle: true,
			certain: true,
			activityRevisions: [{ nodeId: "child", revision: "2" }],
		},
		"host",
	);
	assert.equal(coordinator.snapshot.allIdle, true);
	assert.equal(coordinator.snapshot.activityGeneration, 3n);
	node.emitChannel(
		"pi-continue-watchdog.snapshot.v1",
		{
			domainId: "domain",
			domainEpoch: "domain",
			revision: "3",
			activityGeneration: "2",
			participants: 2,
			busyParticipants: 1,
			allIdle: false,
			certain: true,
			activityRevisions: [{ nodeId: "child", revision: "2" }],
		},
		"host",
	);
	assert.equal(coordinator.snapshot.activityGeneration, 3n);
	assert.equal(coordinator.snapshot.allIdle, true);

	node.emitPeer("host", "offline");
	assert.equal(coordinator.snapshot.certain, false);
	assert.equal(coordinator.snapshot.activityGeneration, 4n);
	const sendsBeforeReconnect = node.sent.length;
	let releaseReconnect: (() => void) | undefined;
	node.sendBarrier = new Promise<void>((resolve) => {
		releaseReconnect = resolve;
	});
	node.emitPeer("host", "online");
	node.emitChannel(
		"pi-continue-watchdog.snapshot.v1",
		{
			domainId: "domain",
			domainEpoch: "domain",
			revision: "5",
			activityGeneration: "5",
			participants: 2,
			busyParticipants: 0,
			allIdle: true,
			certain: true,
			activityRevisions: [{ nodeId: "child", revision: "2" }],
		},
		"host",
	);
	assert.equal(coordinator.snapshot.certain, false);
	releaseReconnect?.();
	node.sendBarrier = null;
	await flush();
	assert.equal(node.sent.length, sendsBeforeReconnect + 1);
	assert.deepEqual(node.sent.at(-1)?.value, {
		state: "idle",
		revision: "3",
	});
	node.emitChannel(
		"pi-continue-watchdog.snapshot.v1",
		{
			domainId: "domain",
			domainEpoch: "domain",
			revision: "6",
			activityGeneration: "6",
			participants: 2,
			busyParticipants: 0,
			allIdle: true,
			certain: true,
			activityRevisions: [{ nodeId: "child", revision: "3" }],
		},
		"host",
	);
	assert.equal(coordinator.snapshot.certain, true);

	node.sendError = new Error("host temporarily offline");
	const busyWrite = coordinator.markBusy(attachment);
	assert.equal(coordinator.snapshot.certain, false);
	await assert.rejects(busyWrite, /temporarily offline/);
	assert.equal(coordinator.snapshot.certain, false);
	node.sendError = null;
	node.emitPeer("host", "online");
	await flush();
	assert.deepEqual(node.sent.at(-1)?.value, {
		state: "busy",
		revision: "5",
	});
	await coordinator.detach(attachment);
	assert.equal(node.closeCount, 1);
});

test("queued client writes bind each revision to its activity state", async () => {
	const node = new FakeNode("client", "child");
	const coordinator = createProcessDomainCoordinator({
		env: { PI_EXTENSION_UTILS_PROCESS_DOMAIN: "declaration" },
		open: async () => node,
	});
	const attachment = {};
	await coordinator.attach(attachment, { initialBusy: false, onFatal() {} });
	node.emitPeer("host", "online");
	await flush();
	node.emitChannel(
		"pi-continue-watchdog.snapshot.v1",
		{
			domainId: "domain",
			domainEpoch: "domain",
			revision: "1",
			activityGeneration: "1",
			participants: 2,
			busyParticipants: 0,
			allIdle: true,
			certain: true,
			activityRevisions: [{ nodeId: "child", revision: "2" }],
		},
		"host",
	);
	assert.equal(coordinator.snapshot.certain, true);

	let releaseBusy: (() => void) | undefined;
	node.sendBarrier = new Promise<void>((resolve) => {
		releaseBusy = resolve;
	});
	const busy = coordinator.markBusy(attachment);
	const idle = coordinator.markIdle(attachment);
	assert.equal(coordinator.snapshot.certain, false);
	releaseBusy?.();
	node.sendBarrier = null;
	await Promise.all([busy, idle]);
	assert.deepEqual(
		node.sent.slice(-2).map((entry) => entry.value),
		[
			{ state: "busy", revision: "3" },
			{ state: "idle", revision: "4" },
		],
	);
	await coordinator.detach(attachment);
});

test("failed open rolls back and a later attachment can retry", async () => {
	const node = new FakeNode("host");
	let opens = 0;
	let fatalCount = 0;
	const coordinator = createProcessDomainCoordinator({
		env: {},
		open: async () => {
			opens += 1;
			if (opens === 1) throw new Error("transport unavailable");
			return node;
		},
	});
	await assert.rejects(
		coordinator.attach(
			{},
			{
				initialBusy: false,
				onFatal(error) {
					fatalCount += 1;
					assert.equal(error instanceof ProcessDomainFatalError, true);
				},
			},
		),
		/failed to initialize/,
	);
	assert.equal(fatalCount, 1);
	assert.equal(coordinator.snapshot.domainId, "pending");

	const second = {};
	await coordinator.attach(second, { initialBusy: false, onFatal() {} });
	assert.equal(opens, 2);
	await coordinator.detach(second);
});
