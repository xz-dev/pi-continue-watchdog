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

const ACTIVITY_CHANNEL = "pi-continue-watchdog.activity.v2";

class FakeNode implements ProcessDomainNode {
	readonly transport = "tcp-loopback" as const;
	readonly endpoint = "tcp://127.0.0.1:1234";
	readonly declaration;
	readonly sent: Array<{ targetId: string; channel: string; value: unknown }> =
		[];
	closeCount = 0;
	sendError: Error | null = null;
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
		readonly nodeId: string = role,
	) {
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
		if (this.sendError !== null) throw this.sendError;
	}

	async broadcast(): Promise<void> {}
	async reportLifecycle(): Promise<void> {}

	subscribe(
		channel: string,
		listener: (message: ProcessDomainDataMessage) => void,
	): () => void {
		const listeners = this.channelListeners.get(channel) ?? new Set();
		listeners.add(listener);
		this.channelListeners.set(channel, listeners);
		return () => listeners.delete(listener);
	}

	subscribeEvents(listener: (event: ProcessDomainEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}

	emitChannel(value: unknown, senderId = "child"): void {
		const message: ProcessDomainDataMessage = {
			id: "message",
			channel: ACTIVITY_CHANNEL,
			value,
			senderId,
			targetId: this.nodeId,
			receivedAt: Date.now(),
		};
		for (const listener of this.channelListeners.get(ACTIVITY_CHANNEL) ?? []) {
			listener(message);
		}
	}

	emitPeer(nodeId: string, status: "online" | "offline"): void {
		const peer = {
			nodeId,
			status,
			metadata: {},
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

test("host keeps a deduplicated busy-child set and every report replaces the fence", async () => {
	const node = new FakeNode("host");
	const env: NodeJS.ProcessEnv = {};
	const coordinator = createProcessDomainCoordinator({
		env,
		pid: 100,
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getIdle: () => true, onFatal() {} });

	assert.equal(env[WATCHDOG_ROOT_PID_ENV], "100");
	assert.equal(coordinator.snapshot.allIdle, true);
	const initial = coordinator.snapshot.fence;

	node.emitPeer("child", "online");
	assert.deepEqual(coordinator.snapshot.fence, initial, "connect is neutral");

	node.emitChannel({ agentId: "child", idle: true });
	const firstIdle = coordinator.snapshot.fence;
	assert.notDeepEqual(firstIdle, initial);
	assert.equal(coordinator.snapshot.allIdle, true);

	node.emitChannel({ agentId: "child", idle: true });
	const repeatedIdle = coordinator.snapshot.fence;
	assert.notDeepEqual(repeatedIdle, firstIdle);
	assert.equal(coordinator.confirm(firstIdle), false);
	assert.equal(coordinator.confirm(repeatedIdle), true);

	node.emitChannel({ agentId: "child", idle: false });
	assert.equal(coordinator.snapshot.busyParticipants, 1);
	assert.equal(coordinator.snapshot.allIdle, false);
	node.emitChannel({ agentId: "child", idle: false });
	assert.equal(
		coordinator.snapshot.busyParticipants,
		1,
		"busy IDs deduplicate",
	);

	node.emitPeer("child", "offline");
	assert.equal(coordinator.snapshot.busyParticipants, 0);
	assert.equal(coordinator.snapshot.allIdle, true);

	await coordinator.detach(instance, true);
	assert.equal(node.closeCount, 1);
	assert.equal(env[WATCHDOG_ROOT_PID_ENV], undefined);
});

test("host rejects malformed or spoofed business payloads", async () => {
	const node = new FakeNode("host");
	const coordinator = createProcessDomainCoordinator({
		env: {},
		open: async () => node,
	});
	await coordinator.attach({}, { getIdle: () => true, onFatal() {} });
	node.emitPeer("child", "online");
	const before = coordinator.snapshot.fence;

	for (const value of [
		{ agentId: "other", idle: false },
		{ agentId: "child", idle: false, revision: "1" },
		{ agentId: "child", idle: "false" },
		{ idle: false },
	]) {
		node.emitChannel(value);
	}
	assert.deepEqual(coordinator.snapshot.fence, before);
	assert.equal(coordinator.snapshot.busyParticipants, 0);
});

test("client reports live state at attach, on events, and immediately after reconnect", async () => {
	const node = new FakeNode("client", "child");
	const coordinator = createProcessDomainCoordinator({
		env: { PI_EXTENSION_UTILS_PROCESS_DOMAIN: "declaration" },
		open: async () => node,
	});
	let idle = true;
	let liveQueries = 0;
	const instance = {};
	await coordinator.attach(instance, {
		getIdle: () => {
			liveQueries += 1;
			return idle;
		},
		onFatal() {},
	});
	assert.deepEqual(node.sent.at(-1), {
		targetId: "host",
		channel: ACTIVITY_CHANNEL,
		value: { agentId: "child", idle: true },
	});

	idle = false;
	await coordinator.reportIdle(instance, false);
	assert.deepEqual(node.sent.at(-1)?.value, { agentId: "child", idle: false });

	const second = {};
	await coordinator.attach(second, { getIdle: () => true, onFatal() {} });
	assert.deepEqual(node.sent.at(-1)?.value, {
		agentId: "child",
		idle: false,
	});
	await coordinator.detach(second, true);

	const queriesBeforeReconnect = liveQueries;
	idle = true;
	node.emitPeer("host", "online");
	await flush();
	assert.equal(liveQueries, queriesBeforeReconnect + 1);
	assert.deepEqual(node.sent.at(-1)?.value, { agentId: "child", idle: true });

	await coordinator.detach(instance, true);
	assert.equal(node.closeCount, 1);
});

test("transient client write failures do not create a business uncertain state", async () => {
	const node = new FakeNode("client", "child");
	const coordinator = createProcessDomainCoordinator({
		env: { PI_EXTENSION_UTILS_PROCESS_DOMAIN: "declaration" },
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getIdle: () => true, onFatal() {} });
	node.sendError = new Error("host offline");
	await assert.rejects(coordinator.reportIdle(instance, false), /host offline/);
	node.sendError = null;
	node.emitPeer("host", "online");
	await flush();
	assert.deepEqual(node.sent.at(-1)?.value, { agentId: "child", idle: true });
	await coordinator.detach(instance, true);
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
				getIdle: () => true,
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
	await coordinator.attach(second, { getIdle: () => true, onFatal() {} });
	assert.equal(opens, 2);
	await coordinator.detach(second, true);
});
