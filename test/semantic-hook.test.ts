import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { DomainFence, DomainSnapshot } from "pi-process-domain";

import type { ContinueWatchdogConfig } from "../src/config.js";
import { createLockDecisionController } from "../src/controller.js";
import {
	createHubAttachmentInstance,
	createObservableAgentHub,
} from "../src/hub.js";
import type { ProcessDomainCoordinator } from "../src/process-domain.js";
import {
	createDecisionRuntime,
	type RuntimeClock,
	type RuntimeTimerHandle,
} from "../src/runtime.js";
import {
	createUserReadyEnvelope,
	emitSemanticHook,
	SEMANTIC_HOOK_CHANNEL,
	type SemanticHookEnvelope,
	USER_READY_HOOK_NAME,
} from "../src/semantic-hook.js";

interface TimerRecord {
	callback: () => void;
	delayMs: number;
	cleared: boolean;
	unrefCount: number;
}

class FakeClock implements RuntimeClock {
	readonly records: TimerRecord[] = [];
	private currentTimeMs = 0;

	setTimeout(
		callback: () => void,
		delayMs: number,
	): TimerRecord & { unref(): void } {
		const record: TimerRecord & { unref(): void } = {
			callback,
			delayMs,
			cleared: false,
			unrefCount: 0,
			unref(): void {
				record.unrefCount += 1;
			},
		};
		this.records.push(record);
		return record;
	}

	clearTimeout(handle: RuntimeTimerHandle): void {
		(handle as TimerRecord).cleared = true;
	}

	now(): number {
		return this.currentTimeMs;
	}

	fire(index: number): void {
		const record = this.records[index];
		assert.ok(record, `expected timer ${index}`);
		if (!record.cleared) {
			// Advance virtual time so deadline-chunked idle timers complete.
			this.currentTimeMs += record.delayMs;
			record.callback();
		}
	}
}

type Handler = (event: never, ctx: ExtensionContext) => unknown;

interface SemanticHarness {
	readonly handlers: Map<string, Handler[]>;
	readonly clock: FakeClock;
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly hub: ReturnType<typeof createObservableAgentHub>;
	readonly received: SemanticHookEnvelope[];
	readonly bus: ReturnType<typeof createEventBus>;
	readonly notifications: Array<{ message: string; level?: string }>;
	readonly sentTypes: string[];
	ctx: ExtensionContext;
	runtime: ReturnType<typeof createDecisionRuntime>;
	streaming: boolean;
	fire(name: string, event: unknown): Promise<void>;
	openDecision(): Promise<void>;
	startDecision(): Promise<void>;
	answerContinue(): unknown;
	answerUnlock(reason?: string, reasonType?: string): unknown;
	snapshotController(): {
		locked: boolean;
		exhausted: boolean;
		decisionFailed: boolean;
		attempt: number;
	};
}

function assistant(content: unknown[], stopReason = "stop"): unknown {
	return { role: "assistant", content, stopReason };
}

function text(value: string): unknown {
	return { type: "text", text: value };
}

function continueXml(): string {
	return "<watchdog><function>continue_watchdog</function></watchdog>";
}

function unlockXml(
	reasonType = "JOB_DONE",
	reason = "All requested work is complete.",
): string {
	return `<watchdog><function>unlock_continue_watchdog</function><reason_type>${reasonType}</reason_type><reason_content>${reason}</reason_content></watchdog>`;
}

function idleDomainSnapshot(): DomainSnapshot {
	return {
		domainId: "semantic-domain",
		brokerEpoch: "epoch",
		revision: 1n,
		activityGeneration: 1n,
		participants: 1,
		busyParticipants: 0,
		pendingSpawns: 0,
		allIdle: true,
		certain: true,
		fence: { brokerEpoch: "epoch", activityGeneration: 1n },
	};
}

function deferredDomain() {
	const pending: Array<{ readonly id: number; resolve(value: boolean): void }> =
		[];
	let confirmCalls = 0;
	let defer = true;
	const snapshot = idleDomainSnapshot();
	const domain: ProcessDomainCoordinator = {
		get snapshot() {
			return snapshot;
		},
		isRootProcess: true,
		async attach() {},
		async markBusy() {},
		async markIdle() {},
		async setInternalDecision() {},
		confirm(_fence: DomainFence) {
			confirmCalls += 1;
			if (!defer) return Promise.resolve(true);
			const id = confirmCalls;
			return new Promise<boolean>((resolve) => {
				pending.push({ id, resolve });
			});
		},
		subscribe() {
			return () => {};
		},
		async detach() {},
	};
	return {
		domain,
		hasPending(): boolean {
			return pending.length > 0;
		},
		confirmCallCount(): number {
			return confirmCalls;
		},
		pendingIds(): number[] {
			return pending.map((item) => item.id);
		},
		resolve(value: boolean): void {
			const item = pending.shift();
			assert.ok(item, "expected pending domain confirmation");
			item.resolve(value);
		},
		setDeferred(value: boolean): void {
			defer = value;
		},
	};
}

function createSemanticHarness(options?: {
	readonly config?: Partial<ContinueWatchdogConfig>;
	readonly hasUI?: boolean;
	readonly processDomain?: ProcessDomainCoordinator;
	readonly isIdle?: () => boolean;
	readonly onSend?: (
		customType: string,
		hub: ReturnType<typeof createObservableAgentHub>,
	) => void;
}): SemanticHarness {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: options?.config?.idleDelaySeconds ?? 3,
		maxRetries: options?.config?.maxRetries ?? 2,
		decisionPrompt: options?.config?.decisionPrompt ?? "Decide now.",
		continuePrompt: options?.config?.continuePrompt ?? "Continue compactly.",
		reasonTypes: options?.config?.reasonTypes ?? [
			"JOB_DONE",
			"WAIT_USER",
			"JOB_BLOCKED",
		],
	};
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController(config);
	const holder = { controller };
	const handlers = new Map<string, Handler[]>();
	const clock = new FakeClock();
	const received: SemanticHookEnvelope[] = [];
	const bus = createEventBus();
	const notifications: Array<{ message: string; level?: string }> = [];
	const sentTypes: string[] = [];
	let runtime: ReturnType<typeof createDecisionRuntime>;
	let lastDecisionMessage: { customType?: string; details?: unknown } | null =
		null;
	let startedDecisionDetails: unknown = null;

	bus.on(SEMANTIC_HOOK_CHANNEL, (data) => {
		received.push(data as SemanticHookEnvelope);
	});

	const harness = {
		handlers,
		clock,
		controller,
		hub,
		received,
		bus,
		notifications,
		sentTypes,
		streaming: false,
	} as SemanticHarness;

	const pi = {
		on(name: string, handler: Handler): void {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		events: bus,
		sendMessage(message: { customType?: string; details?: unknown }): void {
			const customType = message.customType ?? "unknown";
			sentTypes.push(customType);
			if (message.customType === "pi-continue-watchdog:decision") {
				lastDecisionMessage = message;
			}
			options?.onSend?.(customType, hub);
		},
		appendEntry(): void {},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: options?.hasUI ?? true,
		cwd: "/project",
		isIdle: () => options?.isIdle?.() ?? !harness.streaming,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "main" },
		ui: {
			notify(message: string, level?: string): void {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;

	runtime = createDecisionRuntime({
		pi,
		hub,
		processDomain: options?.processDomain,
		attachmentInstance: createHubAttachmentInstance(),
		controllerHolder: holder,
		injectedController: true,
		initialConfig: config,
		clock,
		createExchangeId: () => "exchange-semantic",
	});
	runtime.registerLifecycle();

	harness.ctx = ctx;
	harness.runtime = runtime;
	harness.fire = async (name, event) => {
		if (name === "message_start") {
			await runtime.handleMessageStart(event as { readonly message: unknown });
		}
		for (const handler of handlers.get(name) ?? []) {
			await handler(event as never, ctx);
		}
	};
	harness.openDecision = async () => {
		runtime.applyTransition(controller.lock(), undefined, {
			suppressNotify: true,
		});
		runtime.reconcileIdle();
		clock.fire(clock.records.length - 1);
		for (
			let attempt = 0;
			attempt < 50 && lastDecisionMessage === null;
			attempt += 1
		) {
			await Promise.resolve();
		}
		await harness.startDecision();
	};
	harness.startDecision = async () => {
		assert.ok(lastDecisionMessage, "expected dispatched decision message");
		if (startedDecisionDetails === lastDecisionMessage.details) return;
		harness.streaming = true;
		await harness.fire("agent_start", { type: "agent_start" });
		await harness.fire("message_start", {
			type: "message_start",
			message: {
				role: "custom",
				customType: lastDecisionMessage.customType,
				details: lastDecisionMessage.details,
			},
		});
		startedDecisionDetails = lastDecisionMessage.details;
	};
	harness.answerContinue = () => assistant([text(continueXml())]);
	harness.answerUnlock = (
		reason = "All requested work is complete.",
		reasonType = "JOB_DONE",
	) => assistant([text(unlockXml(reasonType, reason))]);
	harness.snapshotController = () => ({
		locked: controller.snapshot.locked,
		exhausted: controller.snapshot.exhausted,
		decisionFailed: controller.snapshot.decisionFailed,
		attempt: controller.snapshot.attempt,
	});

	return harness;
}

async function waitForPendingConfirm(
	fence: ReturnType<typeof deferredDomain>,
): Promise<void> {
	for (let attempt = 0; attempt < 50 && !fence.hasPending(); attempt += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal(
		fence.hasPending(),
		true,
		"expected pending domain confirmation",
	);
}

async function startIdle(harness: SemanticHarness): Promise<void> {
	await harness.fire("session_start", { type: "session_start" });
}

/**
 * Fire agent_settled and the deferred 0ms settled-phase wake. Capture before/
 * after so any idle-timer arming (also 0ms when idleDelaySeconds=0) is not
 * mistaken for the wake callback; production schedules the wake last.
 */
async function settleOnly(harness: SemanticHarness): Promise<void> {
	const before = harness.clock.records.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	const after = harness.clock.records.length;
	assert.ok(
		after > before,
		"true-idle agent_settled must schedule a deferred settled-phase callback",
	);
	const deferred = after - 1;
	assert.equal(harness.clock.records[deferred]?.delayMs, 0);
	harness.clock.fire(deferred);
	await Promise.resolve();
	await Promise.resolve();
}

async function settleResponse(
	harness: SemanticHarness,
	message: unknown,
): Promise<void> {
	await harness.startDecision();
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [message],
	});
	harness.streaming = false;
	await settleOnly(harness);
}

function assertFrozenEnvelope(envelope: SemanticHookEnvelope): void {
	assert.equal(Object.isFrozen(envelope), true);
	assert.equal(Object.isFrozen(envelope.values), true);
	assert.throws(() => {
		(envelope as { name: string }).name = "mutated";
	});
	assert.throws(() => {
		(envelope.values as { STOP_KIND: string }).STOP_KIND = "MUTATED";
	});
}

test("protocol builders emit exact three envelopes as fresh frozen plain data", () => {
	const unlock = createUserReadyEnvelope({
		STOP_KIND: "AI_UNLOCK",
		REASON_TYPE: "JOB_DONE",
		REASON: "waiting for review",
	});
	const exhausted = createUserReadyEnvelope({ STOP_KIND: "EXHAUSTED" });
	const failed = createUserReadyEnvelope({ STOP_KIND: "DECISION_FAILED" });

	assert.deepEqual(unlock, {
		version: 1,
		name: USER_READY_HOOK_NAME,
		values: {
			STOP_KIND: "AI_UNLOCK",
			REASON_TYPE: "JOB_DONE",
			REASON: "waiting for review",
		},
	});
	assert.deepEqual(exhausted, {
		version: 1,
		name: USER_READY_HOOK_NAME,
		values: { STOP_KIND: "EXHAUSTED" },
	});
	assert.deepEqual(failed, {
		version: 1,
		name: USER_READY_HOOK_NAME,
		values: { STOP_KIND: "DECISION_FAILED" },
	});
	assert.notEqual(unlock, exhausted);
	assert.notEqual(exhausted, failed);
	assertFrozenEnvelope(unlock);
	assertFrozenEnvelope(exhausted);
	assertFrozenEnvelope(failed);

	const bus = createEventBus();
	const seen: unknown[] = [];
	bus.on(SEMANTIC_HOOK_CHANNEL, (data) => {
		seen.push(data);
	});
	emitSemanticHook(bus, unlock);
	assert.equal(seen.length, 1);
	assert.equal(seen[0], unlock);
});

test("AI decision unlock publishes exact validated reasonType and reason once at terminal idle", async () => {
	const harness = createSemanticHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerUnlock("waiting for user", "wait_user"),
	);

	assert.equal(harness.received.length, 1);
	const unlockEnvelope = harness.received[0];
	assert.ok(unlockEnvelope);
	assert.deepEqual(unlockEnvelope, {
		version: 1,
		name: "user-ready",
		values: {
			STOP_KIND: "AI_UNLOCK",
			REASON_TYPE: "WAIT_USER",
			REASON: "waiting for user",
		},
	});
	assertFrozenEnvelope(unlockEnvelope);
	assert.equal(harness.snapshotController().locked, false);

	// Same idle epoch reconcile must not republish.
	harness.runtime.reconcileIdle();
	await settleOnly(harness);
	assert.equal(harness.received.length, 1);
});

test("exhausted and decisionFailed publish exact STOP_KIND envelopes once", async () => {
	const exhausted = createSemanticHarness({ config: { maxRetries: 1 } });
	await startIdle(exhausted);
	await exhausted.openDecision();
	await settleResponse(exhausted, exhausted.answerContinue());
	assert.equal(exhausted.snapshotController().exhausted, true);
	// Continue turn settles into terminal exhausted idle.
	exhausted.streaming = true;
	await exhausted.fire("agent_start", { type: "agent_start" });
	await exhausted.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([{ type: "text", text: "done working" }], "stop")],
	});
	exhausted.streaming = false;
	await settleOnly(exhausted);
	assert.equal(exhausted.received.length, 1);
	const exhaustedEnvelope = exhausted.received[0];
	assert.ok(exhaustedEnvelope);
	assert.deepEqual(exhaustedEnvelope, {
		version: 1,
		name: "user-ready",
		values: { STOP_KIND: "EXHAUSTED" },
	});
	assertFrozenEnvelope(exhaustedEnvelope);
	// Same terminal idle epoch: settled/reconcile without becoming busy again.
	exhausted.runtime.reconcileIdle();
	await settleOnly(exhausted);
	assert.equal(exhausted.received.length, 1);

	const failed = createSemanticHarness();
	await startIdle(failed);
	await failed.openDecision();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await settleResponse(
			failed,
			assistant([{ type: "text", text: "done" }], "stop"),
		);
	}
	assert.equal(failed.snapshotController().decisionFailed, true);
	assert.equal(failed.received.length, 1);
	assert.deepEqual(failed.received[0], {
		version: 1,
		name: "user-ready",
		values: { STOP_KIND: "DECISION_FAILED" },
	});
	// Decision-failed envelope must not include last error text.
	assert.equal(
		Object.hasOwn(failed.received[0]?.values ?? {}, "REASON"),
		false,
	);
	assert.equal(Object.hasOwn(failed.received[0]?.values ?? {}, "ERROR"), false);
	failed.runtime.reconcileIdle();
	assert.equal(failed.received.length, 1);
});

test("human unlock, abort unlock, continue, and initial unlocked idle publish nothing", async () => {
	const human = createSemanticHarness();
	await startIdle(human);
	// Initial ordinary unlocked idle.
	human.runtime.reconcileIdle();
	await settleOnly(human);
	assert.equal(human.received.length, 0);

	human.runtime.applyTransition(human.controller.lock(), undefined, {
		suppressNotify: true,
	});
	human.runtime.clearOperationalPendingWork();
	human.runtime.reconcileIdle();
	assert.equal(
		human.clock.records.some(
			(record) => record.delayMs === 3000 && !record.cleared,
		),
		true,
	);
	human.runtime.applyTransition(human.controller.unlock(), undefined, {
		suppressNotify: true,
	});
	human.runtime.clearOperationalPendingWork();
	await settleOnly(human);
	assert.equal(human.received.length, 0);

	// Canonical/manual abort unlock path: unlock first, then operational cleanup.
	human.runtime.applyTransition(human.controller.lock(), undefined, {
		suppressNotify: true,
	});
	human.runtime.reconcileIdle();
	human.runtime.applyTransition(human.controller.unlock(), undefined, {
		suppressNotify: true,
	});
	human.runtime.clearOperationalPendingWork();
	await settleOnly(human);
	assert.equal(human.received.length, 0);

	const continued = createSemanticHarness({ config: { maxRetries: 3 } });
	await startIdle(continued);
	await continued.openDecision();
	await settleResponse(continued, continued.answerContinue());
	// Intermediate post-continue rearm must not publish.
	assert.equal(continued.received.length, 0);
	assert.equal(continued.controller.snapshot.locked, true);
	// Locked pending grace epoch stays quiet.
	continued.runtime.reconcileIdle();
	assert.equal(continued.received.length, 0);
});

test("AI unlock intent waits for aggregate idle and publishes typed pair only once", async () => {
	let child:
		| ReturnType<
				ReturnType<typeof createObservableAgentHub>["bind"]
		  >["attachment"]
		| null = null;
	const harness = createSemanticHarness({
		onSend(customType, hub) {
			if (customType !== "pi-continue-watchdog:decision-fold") return;
			child = hub.bind({
				instance: createHubAttachmentInstance(),
				sessionId: "child",
				hasUI: false,
				initialBusy: true,
			}).attachment;
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerUnlock("Need deploy approval.", "wait_user"),
	);
	// Main settled but child busy: retain complete pair, no publish yet.
	assert.equal(harness.received.length, 0);
	assert.ok(child);

	harness.hub.markIdle(child);
	await Promise.resolve();
	assert.equal(harness.received.length, 1);
	assert.deepEqual(harness.received[0]?.values, {
		STOP_KIND: "AI_UNLOCK",
		REASON_TYPE: "WAIT_USER",
		REASON: "Need deploy approval.",
	});

	// Same terminal epoch: no second publication.
	harness.runtime.reconcileIdle();
	assert.equal(harness.received.length, 1);
});

test("AI unlock intent is retained until publication confirmation succeeds", async () => {
	const fence = deferredDomain();
	const harness = createSemanticHarness({ processDomain: fence.domain });
	await startIdle(harness);
	fence.setDeferred(false);
	await harness.openDecision();
	for (
		let attempt = 0;
		attempt < 100 && harness.sentTypes.length === 0;
		attempt += 1
	) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal(harness.sentTypes.length, 1);
	fence.setDeferred(true);

	// Finalization's first fence succeeds; publication's fence remains pending.
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerUnlock("Need approval.", "WAIT_USER")],
	});
	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	const deferred = harness.clock.records.length - 1;
	assert.equal(harness.clock.records[deferred]?.delayMs, 0);
	harness.clock.fire(deferred);
	await new Promise<void>((resolve) => setImmediate(resolve));
	// Resolve deferred finalization confirmations while local Pi remains idle,
	// stopping as soon as the unlock has committed. The next pending confirmation
	// is therefore publication C2 and must remain unresolved here.
	for (let attempt = 0; attempt < 5; attempt += 1) {
		await waitForPendingConfirm(fence);
		if (!harness.controller.snapshot.locked) break;
		fence.resolve(true);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal(harness.controller.snapshot.locked, false);
	assert.ok(fence.confirmCallCount() >= 2);
	assert.equal(fence.hasPending(), true);

	// C2: only publication is now pending. Another observable AI becomes busy
	// before resolution, retaining the intent without inventing local sub-states.
	const child = harness.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "publication-retry-child",
		hasUI: false,
		initialBusy: false,
	}).attachment;
	harness.hub.markBusy(child);
	fence.resolve(true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.received.length, 0);

	// That AI's later idle edge with immediate confirmation publishes once.
	fence.setDeferred(false);
	harness.hub.markIdle(child);
	for (
		let attempt = 0;
		attempt < 200 && harness.received.length === 0;
		attempt += 1
	) {
		await Promise.resolve();
	}
	assert.deepEqual(harness.received[0]?.values, {
		STOP_KIND: "AI_UNLOCK",
		REASON_TYPE: "WAIT_USER",
		REASON: "Need approval.",
	});
	harness.runtime.reconcileIdle();
	assert.equal(harness.received.length, 1);
});

test("main-only ownership, stale demotion, and reload/shutdown publish nothing", async () => {
	const nonMain = createSemanticHarness({ hasUI: false });
	await startIdle(nonMain);
	// Steal main with a UI attachment so the first runtime is demoted.
	const usurper = nonMain.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "ui-main",
		hasUI: true,
		initialBusy: false,
	}).attachment;
	assert.equal(nonMain.runtime.isCurrentMain(), false);

	nonMain.runtime.applyTransition(nonMain.controller.lock(), undefined, {
		suppressNotify: true,
	});
	// Demoted runtime must not open decisions or publish terminal hooks.
	nonMain.runtime.reconcileIdle();
	assert.equal(nonMain.clock.records.length, 0);
	assert.equal(nonMain.received.length, 0);

	nonMain.hub.detach(usurper);
	nonMain.runtime.shutdown();
	assert.equal(nonMain.received.length, 0);

	const reloaded = createSemanticHarness();
	await startIdle(reloaded);
	await reloaded.openDecision();
	// Shutdown before settle clears ownership generation bookkeeping.
	reloaded.runtime.shutdown();
	await reloaded.fire("agent_end", {
		type: "agent_end",
		messages: [reloaded.answerUnlock("will reload", "JOB_DONE")],
	});
	// Shutdown stops lifecycle; settled handlers may still run but must not publish.
	const timersBefore = reloaded.clock.records.length;
	await reloaded.fire("agent_settled", { type: "agent_settled" });
	assert.equal(reloaded.clock.records.length, timersBefore);
	assert.equal(reloaded.received.length, 0);
});

test("absent and throwing consumers leave controller and results unchanged", async () => {
	const noConsumer = createSemanticHarness();
	// Drop the only listener so emission has no consumer.
	noConsumer.bus.clear();
	await startIdle(noConsumer);
	await noConsumer.openDecision();
	await settleResponse(
		noConsumer,
		noConsumer.answerUnlock("silent consumer absence", "JOB_DONE"),
	);
	assert.deepEqual(noConsumer.snapshotController(), {
		locked: false,
		exhausted: false,
		decisionFailed: false,
		attempt: 0,
	});
	assert.equal(noConsumer.received.length, 0);

	const throwing = createSemanticHarness();
	throwing.bus.on(SEMANTIC_HOOK_CHANNEL, () => {
		throw new Error("intentional consumer failure");
	});
	const errors: unknown[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args);
	};
	try {
		await startIdle(throwing);
		await throwing.openDecision();
		await settleResponse(
			throwing,
			throwing.answerUnlock("consumer throws", "JOB_DONE"),
		);
	} finally {
		console.error = originalError;
	}

	assert.equal(throwing.received.length, 1);
	assert.deepEqual(throwing.snapshotController(), {
		locked: false,
		exhausted: false,
		decisionFailed: false,
		attempt: 0,
	});
	assert.equal(
		errors.some((entry) =>
			String(entry).includes("intentional consumer failure"),
		),
		true,
	);
});

/**
 * Establish AI unlock finalization with a busy child so publication intent is
 * retained and no user-ready event has been emitted yet.
 */
async function establishPendingAiUnlock(
	reason: string,
	options?: { readonly hasUI?: boolean; readonly reasonType?: string },
): Promise<{
	readonly harness: SemanticHarness;
	readonly child: ReturnType<
		ReturnType<typeof createObservableAgentHub>["bind"]
	>["attachment"];
}> {
	const reasonType = options?.reasonType ?? "JOB_DONE";
	let child:
		| ReturnType<
				ReturnType<typeof createObservableAgentHub>["bind"]
		  >["attachment"]
		| null = null;
	const harness = createSemanticHarness({
		hasUI: options?.hasUI ?? true,
		onSend(customType, hub) {
			if (customType !== "pi-continue-watchdog:decision-fold") return;
			child = hub.bind({
				instance: createHubAttachmentInstance(),
				sessionId: `child-${reason}`,
				hasUI: false,
				initialBusy: true,
			}).attachment;
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerUnlock(reason, reasonType));
	await Promise.resolve();
	assert.equal(harness.received.length, 0);
	assert.equal(harness.snapshotController().locked, false);
	assert.ok(child);
	return { harness, child };
}

function aiUnlockCount(received: readonly SemanticHookEnvelope[]): number {
	return received.filter(
		(envelope) => envelope.values?.STOP_KIND === "AI_UNLOCK",
	).length;
}

test("pending AI unlock intent is cleared by external lock/ownership transitions", async () => {
	// Human/manual unlock seam: controller unlock first, then operational cleanup.
	// Canonical abort uses the same post-transition cleanup seam; the semantic
	// harness has no sessionManager branch surface for a full abort capture.
	{
		const { harness, child } = await establishPendingAiUnlock(
			"pending then human unlock",
		);
		harness.runtime.applyTransition(harness.controller.unlock(), undefined, {
			suppressNotify: true,
		});
		harness.runtime.clearOperationalPendingWork();
		harness.hub.markIdle(child);
		harness.runtime.reconcileIdle();
		await settleOnly(harness);
		assert.equal(aiUnlockCount(harness.received), 0);
		assert.equal(harness.received.length, 0);
	}

	// Human/manual lock replaces state after transition, then cleanup clears intent.
	{
		const { harness, child } = await establishPendingAiUnlock(
			"pending then human lock",
		);
		harness.runtime.applyTransition(harness.controller.lock(), undefined, {
			suppressNotify: true,
		});
		harness.runtime.clearOperationalPendingWork();
		harness.hub.markIdle(child);
		harness.runtime.reconcileIdle();
		await settleOnly(harness);
		assert.equal(aiUnlockCount(harness.received), 0);
		// New locked idle may arm a timer, but must never publish the old reason.
		assert.equal(harness.snapshotController().locked, true);
	}

	// Main demotion while intent is pending: later UI steals headless main.
	// Equal-priority UI cannot demote, so this case starts headless.
	{
		const { harness, child } = await establishPendingAiUnlock(
			"pending then demote",
			{ hasUI: false },
		);
		const usurper = harness.hub.bind({
			instance: createHubAttachmentInstance(),
			sessionId: "ui-main-pending",
			hasUI: true,
			initialBusy: false,
		}).attachment;
		assert.equal(harness.runtime.isCurrentMain(), false);
		harness.hub.markIdle(child);
		harness.runtime.reconcileIdle();
		// Observer-only demoted attachments schedule no deferred control wake.
		const timersBefore = harness.clock.records.length;
		await harness.fire("agent_settled", { type: "agent_settled" });
		assert.equal(harness.clock.records.length, timersBefore);
		assert.equal(aiUnlockCount(harness.received), 0);
		assert.equal(harness.received.length, 0);
		harness.hub.detach(usurper);
	}

	// Shutdown while intent is pending: stopped runtime never publishes stale unlock.
	{
		const { harness, child } = await establishPendingAiUnlock(
			"pending then shutdown",
		);
		harness.runtime.shutdown();
		harness.hub.markIdle(child);
		harness.runtime.reconcileIdle();
		const timersBefore = harness.clock.records.length;
		await harness.fire("agent_settled", { type: "agent_settled" });
		assert.equal(harness.clock.records.length, timersBefore);
		assert.equal(aiUnlockCount(harness.received), 0);
		assert.equal(harness.received.length, 0);
	}
});

test("async-rejecting bus consumer leaves producer and controller unchanged", async () => {
	const harness = createSemanticHarness();
	harness.bus.on(SEMANTIC_HOOK_CHANNEL, async () => {
		throw new Error("async consumer rejection");
	});

	const originalError = console.error;
	// Contain Pi bus error logging so the suite stays quiet; do not assert timing.
	console.error = () => {};
	try {
		await startIdle(harness);
		await harness.openDecision();
		await settleResponse(
			harness,
			harness.answerUnlock("async reject path", "JOB_DONE"),
		);
		// Flush the bus's async safeHandler microtask so rejection is contained.
		await Promise.resolve();
		await Promise.resolve();
	} finally {
		console.error = originalError;
	}

	assert.equal(harness.received.length, 1);
	assert.deepEqual(harness.received[0], {
		version: 1,
		name: "user-ready",
		values: {
			STOP_KIND: "AI_UNLOCK",
			REASON_TYPE: "JOB_DONE",
			REASON: "async reject path",
		},
	});
	assert.deepEqual(harness.snapshotController(), {
		locked: false,
		exhausted: false,
		decisionFailed: false,
		attempt: 0,
	});
});
