import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";

import { AI_UNLOCK_ENTRY_TYPE } from "../src/commands.js";
import type { ContinueWatchdogConfig } from "../src/config.js";
import { createLockDecisionController } from "../src/controller.js";
import {
	createHubAttachmentInstance,
	createObservableAgentHub,
} from "../src/hub.js";
import type {
	DomainFence,
	DomainSnapshot,
	ProcessDomainCoordinator,
} from "../src/process-domain.js";
import {
	createDecisionRuntime,
	type RuntimeClock,
	type RuntimeTimerHandle,
} from "../src/runtime.js";
import {
	createUserReadyEnvelope,
	createWatchdogContinuedEnvelope,
	emitSemanticHook,
	SEMANTIC_HOOK_CHANNEL,
	type SemanticHookEnvelope,
	USER_READY_HOOK_NAME,
	WATCHDOG_CONTINUED_HOOK_NAME,
} from "../src/semantic-hook.js";
import {
	awaitPrivateOperation,
	awaitPrivatePrompt,
	createPrivateDriver,
	type PrivateDriver,
	settlePrivateDecision,
} from "./fixtures/private-decision-driver.js";

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
	readonly driver: PrivateDriver;
	readonly registeredTools: string[];
	answerContinue(): string;
	answerWait(waitSeconds?: number, reason?: string): string;
	answerUnlock(reason?: string, reasonType?: string): string;
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

function continueArgs(
	reasonType = "WORK_REMAINS",
	reason = "Implementation work remains.",
): Record<string, unknown> {
	return {
		action: "continue",
		reason_type: reasonType,
		reason_content: reason,
	};
}

function waitArgs(
	waitSeconds = 30,
	reason = "Waiting for automation.",
): Record<string, unknown> {
	return { action: "wait", reason_content: reason, wait_seconds: waitSeconds };
}

function unlockArgs(
	reasonType = "JOB_DONE",
	reason = "All requested work is complete.",
): Record<string, unknown> {
	return { action: "unlock", reason_type: reasonType, reason_content: reason };
}

function idleDomainSnapshot(): DomainSnapshot {
	return {
		domainId: "semantic-domain",
		domainEpoch: "epoch",
		activityGeneration: 1n,
		busyParticipants: 0,
		allIdle: true,
		fence: { domainEpoch: "epoch", activityGeneration: 1n },
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
		async reportIdle() {},
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
	readonly onAppend?: (
		type: string,
		hub: ReturnType<typeof createObservableAgentHub>,
	) => void;
	readonly appendThrows?: string;
	readonly sendThrows?: string;
	readonly sendWithoutReceipt?: string;
	readonly listen?: boolean;
	readonly eventBus?: ReturnType<typeof createEventBus>;
}): SemanticHarness {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: options?.config?.idleDelaySeconds ?? 3,
		maxContinue: options?.config?.maxContinue ?? 2,
		decisionPrompt: options?.config?.decisionPrompt ?? "Decide now.",
		continuePrompt: options?.config?.continuePrompt ?? "Continue compactly.",
		reasonTypes: options?.config?.reasonTypes ?? [
			"JOB_DONE",
			"WAIT_USER",
			"JOB_BLOCKED",
		],
		continueReasonTypes: options?.config?.continueReasonTypes ?? [
			"WORK_REMAINS",
			"VERIFYING",
		],
		unlockShortcut: options?.config?.unlockShortcut ?? "alt+u",
		unlockReviewEnabled: options?.config?.unlockReviewEnabled ?? false,
	};
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController(config);
	const holder = { controller };
	const handlers = new Map<string, Handler[]>();
	const clock = new FakeClock();
	const received: SemanticHookEnvelope[] = [];
	const bus = options?.eventBus ?? createEventBus();
	const notifications: Array<{ message: string; level?: string }> = [];
	const sentTypes: string[] = [];
	const driver = createPrivateDriver();
	const registeredTools: string[] = [];
	let pendingMessages = false;
	const branch: Array<{
		id: string;
		type: "message" | "custom_message" | "custom";
		customType?: string;
		message?: unknown;
		details?: unknown;
		data?: unknown;
	}> = [
		{
			id: "source-user",
			type: "message",
			message: {
				role: "user",
				content: "Finish requested work.",
				timestamp: 1,
			},
		},
		{
			id: "source-assistant",
			type: "message",
			message: assistant([{ type: "text", text: "Work checkpoint." }]),
		},
	];

	if (options?.listen !== false) {
		bus.on(SEMANTIC_HOOK_CHANNEL, (data) => {
			received.push(data as SemanticHookEnvelope);
		});
	}

	const harness = {
		handlers,
		clock,
		controller,
		hub,
		received,
		bus,
		notifications,
		sentTypes,
		driver,
		registeredTools,
		streaming: false,
	} as SemanticHarness;

	const pi = {
		on(name: string, handler: Handler): void {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		events: bus,
		sendMessage(
			message: { customType?: string; details?: unknown },
			delivery?: { triggerTurn?: boolean },
		): void {
			const customType = message.customType ?? "unknown";
			sentTypes.push(customType);
			options?.onSend?.(customType, hub);
			if (customType === options?.sendThrows) throw new Error("send failed");
			if (delivery?.triggerTurn) pendingMessages = true;
			if (customType === options?.sendWithoutReceipt) return;
			branch.push({
				id: `message-${branch.length + 1}`,
				type: "custom_message",
				customType,
				details: message.details,
			});
			if (
				(message.details as { watchdogOutcome?: unknown } | undefined)
					?.watchdogOutcome === "continue"
			) {
				// Parent continuation observation acknowledges persisted delivery.
				// Private generation never emits parent context events.
				queueMicrotask(() => {
					void harness.fire("context", { type: "context", messages: [] });
				});
			}
		},
		appendEntry(type: string, data?: unknown): void {
			options?.onAppend?.(type, hub);
			if (type === options?.appendThrows) throw new Error("append failed");
			branch.push({
				id: `custom-${branch.length + 1}`,
				type: "custom",
				customType: type,
				data,
			});
		},
		registerTool(definition: { readonly name: string }): void {
			registeredTools.push(definition.name);
		},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: options?.hasUI ?? true,
		cwd: "/project",
		isIdle: () => options?.isIdle?.() ?? !harness.streaming,
		hasPendingMessages: () => pendingMessages,
		isProjectTrusted: () => true,
		model: { provider: "fake", id: "local" },
		modelRegistry: {},
		sessionManager: {
			getSessionId: () => "main",
			getSessionFile: () => undefined,
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => branch,
			buildContextEntries: () => branch,
		},
		ui: {
			notify(message: string, level?: string): void {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;

	const runtime = createDecisionRuntime({
		pi,
		hub,
		processDomain: options?.processDomain,
		attachmentInstance: createHubAttachmentInstance(),
		controllerHolder: holder,
		injectedController: true,
		initialConfig: config,
		clock,
		createExchangeId: () => `exchange-semantic-${driver.operations.length + 1}`,
		executePrivateDecision: driver.execute,
	});
	runtime.registerLifecycle();

	harness.ctx = ctx;
	harness.runtime = runtime;
	harness.fire = async (name, event) => {
		if (name === "agent_start") pendingMessages = false;
		if (name === "message_start") {
			await runtime.handleMessageStart(event as { readonly message: unknown });
		}
		for (const handler of handlers.get(name) ?? []) {
			await handler(
				(name === "message_end"
					? { type: "message_end", message: event }
					: event) as never,
				ctx,
			);
		}
	};
	harness.openDecision = async () => {
		const index = driver.operations.length;
		runtime.applyTransition(controller.lock(), undefined, {
			suppressNotify: true,
		});
		runtime.reconcileIdle();
		clock.fire(clock.records.length - 1);
		await awaitPrivateOperation(driver, { index });
		await harness.startDecision();
	};
	harness.startDecision = async () => {
		const previous = driver.current;
		await awaitPrivateOperation(driver, {
			index: previous?.settled
				? driver.operations.length
				: Math.max(0, driver.operations.length - 1),
		});
		await awaitPrivatePrompt(driver);
		assert.equal(
			harness.streaming,
			false,
			"private generation leaves main idle",
		);
		assert.equal(ctx.isIdle(), true);
		assert.deepEqual(registeredTools, [], "no decision-result tool registered");
		assert.equal(sentTypes.includes("pi-continue-watchdog:inquiry"), false);
		assert.equal(driver.forkInputs.at(-1)?.parent, ctx.sessionManager);
		assert.equal(driver.forkInputs.at(-1)?.model, "fake/local:off");
	};
	harness.answerContinue = () => JSON.stringify(continueArgs());
	harness.answerWait = (waitSeconds = 30, reason = "Waiting for automation.") =>
		JSON.stringify(waitArgs(waitSeconds, reason));
	harness.answerUnlock = (
		reason = "All requested work is complete.",
		reasonType = "JOB_DONE",
	) => JSON.stringify(unlockArgs(reasonType, reason));
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
	for (let attempt = 0; attempt < 2000 && !fence.hasPending(); attempt += 1) {
		// Private decision finalization follows real filesystem work.
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
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

/** Observe ordinary main settlement; never substitute for private completion. */
async function settleOnly(harness: SemanticHarness): Promise<void> {
	await harness.fire("agent_settled", { type: "agent_settled" });
	await Promise.resolve();
	await Promise.resolve();
}

async function settleResponse(
	harness: SemanticHarness,
	write?: string,
): Promise<void> {
	await harness.startDecision();
	harness.driver.respond(write === undefined ? {} : { write });
	for (let attempt = 0; attempt < 2000; attempt += 1) {
		if (harness.driver.current?.settled) {
			await settlePrivateDecision(harness.driver);
			return;
		}
		if (harness.driver.awaitingResponse) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	assert.fail("private response neither settled nor requested correction");
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

test("protocol builders emit exact terminal and continue envelopes as fresh frozen plain data", () => {
	const unlock = createUserReadyEnvelope({
		STOP_KIND: "AI_UNLOCK",
		REASON_TYPE: "JOB_DONE",
		REASON: "waiting for review",
	});
	const exhausted = createUserReadyEnvelope({ STOP_KIND: "EXHAUSTED" });
	const failed = createUserReadyEnvelope({ STOP_KIND: "DECISION_FAILED" });
	const continued = createWatchdogContinuedEnvelope({
		REASON_TYPE: "VERIFYING",
		REASON: "Tests still need to run.",
	});

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
	assert.deepEqual(continued, {
		version: 1,
		name: WATCHDOG_CONTINUED_HOOK_NAME,
		values: {
			REASON_TYPE: "VERIFYING",
			REASON: "Tests still need to run.",
		},
	});
	assert.notEqual(unlock, exhausted);
	assert.notEqual(exhausted, failed);
	assertFrozenEnvelope(unlock);
	assertFrozenEnvelope(exhausted);
	assertFrozenEnvelope(failed);
	assertFrozenEnvelope(continued);

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

test("exhausted publishes exact STOP_KIND once after continuation settles", async () => {
	const exhausted = createSemanticHarness({ config: { maxContinue: 1 } });
	await startIdle(exhausted);
	await exhausted.openDecision();
	await settleResponse(exhausted, exhausted.answerContinue());
	assert.equal(exhausted.received[0]?.name, "watchdog-continued");
	assert.equal(exhausted.snapshotController().exhausted, true);
	assert.equal(exhausted.ctx.hasPendingMessages(), true);
	assert.deepEqual(
		exhausted.received.map((envelope) => envelope.name),
		["watchdog-continued"],
		"EXHAUSTED must wait for queued continuation work to settle",
	);
	// Continue turn settles into terminal exhausted idle.
	exhausted.streaming = true;
	await exhausted.fire("agent_start", { type: "agent_start" });
	await exhausted.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([{ type: "text", text: "done working" }], "stop")],
	});
	exhausted.streaming = false;
	await settleOnly(exhausted);
	assert.equal(
		exhausted.sentTypes.filter((type) => type === "pi-continue-watchdog:event")
			.length,
		1,
	);
	assert.equal(exhausted.received.length, 2);
	const exhaustedEnvelope = exhausted.received[1];
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
	assert.equal(exhausted.received.length, 2);
	assert.equal(
		exhausted.sentTypes.filter((type) => type === "pi-continue-watchdog:event")
			.length,
		1,
	);
});

test("decisionFailed publishes exact STOP_KIND once after three private responses", async () => {
	const failed = createSemanticHarness();
	await startIdle(failed);
	await failed.openDecision();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await settleResponse(failed);
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

test("retired wait submissions publish no waiting hook and charge no attempt", async () => {
	const harness = createSemanticHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerWait(30, "Waiting for CI."));
	assert.equal(harness.received.length, 0);
	assert.deepEqual(harness.snapshotController(), {
		locked: true,
		exhausted: false,
		decisionFailed: false,
		attempt: 0,
	});
	assert.equal(
		harness.received.some((envelope) => envelope.name === "watchdog-waiting"),
		false,
	);
	assert.equal(harness.sentTypes.includes("pi-continue-watchdog:wait"), false);
	// Retired wait consumes one private response; correction stays in same child.
	assert.equal(harness.driver.children.length, 1);
	assert.equal(harness.driver.children[0]?.prompts.length, 2);
	assert.equal(harness.driver.awaitingResponse, true);
	assert.deepEqual(harness.sentTypes, []);
	await harness.runtime.shutdown();
	await settlePrivateDecision(harness.driver);
});

test("three retired wait submissions decision-fail without any waiting hook", async () => {
	const harness = createSemanticHarness();
	await startIdle(harness);
	await harness.openDecision();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await settleResponse(harness, harness.answerWait(30, "Waiting for CI."));
	}
	assert.equal(harness.driver.children.length, 1);
	assert.equal(harness.driver.children[0]?.prompts.length, 3);
	assert.deepEqual(harness.driver.children[0]?.fileStates, ["{}", "{}", "{}"]);
	assert.equal(harness.driver.awaitingResponse, false);
	assert.equal(harness.snapshotController().decisionFailed, true);
	assert.equal(harness.snapshotController().attempt, 0);
	assert.equal(
		harness.received.some((envelope) => envelope.name === "watchdog-waiting"),
		false,
	);
	assert.deepEqual(harness.received, [
		{
			version: 1,
			name: "user-ready",
			values: { STOP_KIND: "DECISION_FAILED" },
		},
	]);
});

test("final continuation exhausts and publishes EXHAUSTED with no wait deadline timer", async () => {
	const harness = createSemanticHarness({ config: { maxContinue: 1 } });
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	assert.equal(harness.received[0]?.name, "watchdog-continued");
	assert.equal(harness.snapshotController().exhausted, true);
	// The continuation turn settles into terminal exhausted idle.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([{ type: "text", text: "done working" }], "stop")],
	});
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(
		harness.received.some((envelope) => envelope.name === "user-ready"),
		true,
	);
	const deadlineTimers = harness.clock.records.filter(
		(record) => !record.cleared && record.delayMs > 10_000,
	);
	assert.deepEqual(deadlineTimers, []);
});

test("WAIT_CALLBACK publishes its own stop kind while the lock is retained", async () => {
	const harness = createSemanticHarness({
		config: {
			reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerUnlock(
			"  Waiting for the subagent callback.  ",
			"wait_callback",
		),
	);
	assert.equal(harness.snapshotController().attempt, 1);
	assert.equal(harness.snapshotController().locked, true);
	assert.deepEqual(harness.received, [
		{
			version: 1,
			name: "user-ready",
			values: {
				STOP_KIND: "WAIT_CALLBACK",
				REASON_TYPE: "WAIT_CALLBACK",
				REASON: "Waiting for the subagent callback.",
			},
		},
	]);
	harness.runtime.reconcileIdle();
	await settleOnly(harness);
	assert.equal(harness.received.length, 1);
	const deadlineTimers = harness.clock.records.filter(
		(record) => !record.cleared && record.delayMs !== 10_000,
	);
	assert.deepEqual(deadlineTimers, []);
});

test("final callback unit waits first and reports exhaustion after callback work settles", async () => {
	const harness = createSemanticHarness({
		config: {
			maxContinue: 2,
			reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([{ type: "text", text: "started child" }], "stop")],
	});
	harness.streaming = false;
	await settleOnly(harness);
	// Second inquiry from the same cycle's idle fence (no fresh lock).
	const fence = harness.clock.records.findLastIndex(
		(record) => record.delayMs === 10_000 && !record.cleared,
	);
	assert.ok(fence >= 0, "expected a second idle fence in the same cycle");
	harness.clock.fire(fence);
	for (let i = 0; i < 50; i += 1) await Promise.resolve();
	await harness.startDecision();
	await settleResponse(
		harness,
		harness.answerUnlock("Waiting for the child.", "WAIT_CALLBACK"),
	);
	assert.equal(harness.snapshotController().attempt, 2);
	assert.equal(harness.snapshotController().exhausted, true);
	assert.deepEqual(
		harness.received.map(
			(envelope) => envelope.values?.STOP_KIND ?? envelope.name,
		),
		["watchdog-continued", "WAIT_CALLBACK"],
	);
	harness.runtime.reconcileIdle();
	await settleOnly(harness);
	assert.equal(harness.received.length, 2);

	// Actual callback work runs without replenishing, then settles: EXHAUSTED once.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(harness.snapshotController().attempt, 2);
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [
			assistant([{ type: "text", text: "child result read" }], "stop"),
		],
	});
	harness.streaming = false;
	await settleOnly(harness);
	assert.deepEqual(
		harness.received.map(
			(envelope) => envelope.values?.STOP_KIND ?? envelope.name,
		),
		["watchdog-continued", "WAIT_CALLBACK", "EXHAUSTED"],
	);
	harness.runtime.reconcileIdle();
	await settleOnly(harness);
	assert.equal(harness.received.length, 3);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
});

test("continue shared-fold failure publishes no hook and dispatches no continuation", async () => {
	const harness = createSemanticHarness({
		sendThrows: "pi-continue-watchdog:inquiry-fold",
	});
	await startIdle(harness);
	await harness.openDecision();
	const sentBefore = harness.sentTypes.length;
	await settleResponse(harness, harness.answerContinue());

	assert.equal(harness.received.length, 0);
	assert.deepEqual(harness.sentTypes.slice(sentBefore), [
		"pi-continue-watchdog:inquiry-fold",
	]);
	// Failed outcome has no receipt; private work needs no parent cleanup fold.
	assert.equal(harness.driver.children[0]?.disposed, true);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
});

test("private correction publishes only final file-owned outcome without parent prompt traffic", async () => {
	const harness = createSemanticHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, "private invalid body: do not publish");
	assert.deepEqual(harness.received, []);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.controller.snapshot.attempt, 0);
	await settleResponse(
		harness,
		harness.answerUnlock("Need approval.", "wait_user"),
	);
	assert.equal(harness.driver.children.length, 1);
	assert.equal(harness.driver.children[0]?.prompts.length, 2);
	assert.deepEqual(harness.driver.children[0]?.fileStates, ["{}", "{}"]);
	assert.deepEqual(harness.received, [
		{
			version: 1,
			name: "user-ready",
			values: {
				STOP_KIND: "AI_UNLOCK",
				REASON_TYPE: "WAIT_USER",
				REASON: "Need approval.",
			},
		},
	]);
	const parentHistory = JSON.stringify(harness.ctx.sessionManager.getBranch());
	assert.equal(parentHistory.includes("private invalid body"), false);
	assert.equal(parentHistory.includes("watchdog_result_file"), false);
	for (const input of harness.driver.forkInputs) {
		assert.equal(parentHistory.includes(input.resultFile), false);
	}
	assert.equal(
		harness.sentTypes.includes("pi-continue-watchdog:inquiry"),
		false,
	);
	await settleOnly(harness);
	assert.equal(harness.received.length, 1);
});

test("continued hook requires actual parent receipt and absent publication refunds budget", async () => {
	const harness = createSemanticHarness({
		sendWithoutReceipt: "pi-continue-watchdog:inquiry-fold",
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	assert.deepEqual(harness.sentTypes, ["pi-continue-watchdog:inquiry-fold"]);
	assert.deepEqual(harness.received, []);
	// Void send return is not persistence. A real main lifecycle observation
	// confirms absence and rolls the charge back without a continued hook.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([{ type: "text", text: "ordinary work" }])],
	});
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.deepEqual(harness.received, []);
});

test("AI unlock hook waits for exact human status receipt, not only valid private file", async () => {
	const harness = createSemanticHarness({ appendThrows: AI_UNLOCK_ENTRY_TYPE });
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerUnlock("Need approval.", "WAIT_USER"),
	);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.driver.current?.settled, true);
	assert.deepEqual(harness.sentTypes, ["pi-continue-watchdog:inquiry-fold"]);
	assert.deepEqual(harness.received, []);
	await settleOnly(harness);
	assert.deepEqual(harness.received, []);
	await harness.runtime.shutdown();
});

test("accepted continue publishes its typed reason while unlock-free idle stays quiet", async () => {
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
			(record) => record.delayMs === 10_000 && !record.cleared,
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

	const continued = createSemanticHarness({ config: { maxContinue: 3 } });
	await startIdle(continued);
	await continued.openDecision();
	await settleResponse(
		continued,
		JSON.stringify(continueArgs("verifying", "Tests still need to run.")),
	);
	assert.deepEqual(continued.received, [
		{
			version: 1,
			name: "watchdog-continued",
			values: {
				REASON_TYPE: "VERIFYING",
				REASON: "Tests still need to run.",
			},
		},
	]);
	assert.equal(continued.controller.snapshot.locked, true);
	continued.runtime.reconcileIdle();
	assert.equal(continued.received.length, 1);
});

test("AI unlock intent waits for aggregate idle and publishes typed pair only once", async () => {
	let child:
		| ReturnType<
				ReturnType<typeof createObservableAgentHub>["bind"]
		  >["attachment"]
		| null = null;
	const harness = createSemanticHarness({
		onSend(customType, hub) {
			if (customType !== "pi-continue-watchdog:inquiry-fold") return;
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
	assert.deepEqual(
		harness.sentTypes,
		[],
		"private prompt never reaches parent",
	);
	assert.equal(harness.driver.awaitingResponse, true);
	fence.setDeferred(true);

	// File result crosses finalization's fence while main stays idle; publication
	// then waits at its independent domain confirmation.
	harness.driver.respond({
		write: harness.answerUnlock("Need approval.", "WAIT_USER"),
	});
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
	await settlePrivateDecision(harness.driver);
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
	// Shutdown revokes exact child's authority before a queued valid file wins.
	reloaded.driver.respond({
		write: reloaded.answerUnlock("will reload", "JOB_DONE"),
	});
	await reloaded.runtime.shutdown();
	const cancelled = await settlePrivateDecision(reloaded.driver);
	assert.equal(cancelled?.kind, "cancelled");
	assert.equal(reloaded.driver.children[0]?.aborted, true);
	assert.equal(reloaded.driver.children[0]?.disposed, true);
	// Shutdown stops lifecycle; settled handlers may still run but must not publish.
	const timersBefore = reloaded.clock.records.length;
	await reloaded.fire("agent_settled", { type: "agent_settled" });
	assert.equal(reloaded.clock.records.length, timersBefore);
	assert.equal(reloaded.received.length, 0);
});

test("stale private owner or source cannot publish a hook from an otherwise valid file", async () => {
	for (const invalidation of ["owner", "source"] as const) {
		const harness = createSemanticHarness({ hasUI: false });
		await startIdle(harness);
		await harness.openDecision();
		const child = harness.driver.children[0];
		assert.ok(child);
		harness.driver.respond({ write: harness.answerUnlock("stale verdict") });
		if (invalidation === "owner") {
			harness.hub.bind({
				instance: createHubAttachmentInstance(),
				sessionId: "replacement-main",
				hasUI: true,
				initialBusy: false,
			});
			assert.equal(harness.runtime.isCurrentMain(), false);
		} else {
			harness.ctx.sessionManager.getBranch().push({
				id: "external-source-change",
				parentId: harness.ctx.sessionManager.getLeafId(),
				timestamp: new Date().toISOString(),
				type: "message",
				message: { role: "user", content: "New work.", timestamp: Date.now() },
			});
		}
		const result = await settlePrivateDecision(harness.driver);
		assert.equal(result?.kind, "cancelled", invalidation);
		assert.equal(child.aborted, true, invalidation);
		assert.equal(child.disposed, true, invalidation);
		assert.equal(harness.controller.snapshot.attempt, 0, invalidation);
		assert.deepEqual(harness.received, [], invalidation);
		assert.deepEqual(harness.sentTypes, [], invalidation);
		await harness.runtime.shutdown();
	}
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

	const continueWithoutConsumer = createSemanticHarness();
	continueWithoutConsumer.bus.clear();
	await startIdle(continueWithoutConsumer);
	await continueWithoutConsumer.openDecision();
	await settleResponse(
		continueWithoutConsumer,
		continueWithoutConsumer.answerContinue(),
	);
	assert.deepEqual(continueWithoutConsumer.snapshotController(), {
		locked: true,
		exhausted: false,
		decisionFailed: false,
		attempt: 1,
	});
	assert.equal(continueWithoutConsumer.received.length, 0);

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
			if (customType !== "pi-continue-watchdog:inquiry-fold") return;
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
	// Same cleanup seam clears pending hook authority after manual abort.
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

test("ERROR_UNLOCK waits for domain confirmation and rechecks busy activity", async () => {
	const fence = deferredDomain();
	const harness = createSemanticHarness({ processDomain: fence.domain });
	await startIdle(harness);
	harness.streaming = true;
	await harness.fire("agent_start", {});
	const claim = harness.runtime.getMainClaim();
	assert.ok(claim);
	harness.controller.unlock();
	harness.runtime.clearOperationalPendingWork();
	harness.runtime.retainErrorUnlock(claim);
	assert.deepEqual(harness.received, []);
	harness.streaming = false;
	const settling = settleOnly(harness);
	await waitForPendingConfirm(fence);
	assert.deepEqual(harness.received, []);
	const child = harness.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "error-publication-child",
		hasUI: false,
		initialBusy: true,
	}).attachment;
	while (fence.hasPending()) fence.resolve(true);
	await settling;
	assert.deepEqual(harness.received, []);
	fence.setDeferred(false);
	harness.hub.markIdle(child);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.received, [
		{ version: 1, name: "user-ready", values: { STOP_KIND: "ERROR_UNLOCK" } },
	]);
	await settleOnly(harness);
	assert.equal(harness.received.length, 1);
	await harness.runtime.shutdown();
});

test("ERROR_UNLOCK confirmation cannot survive manual unlock, re-lock, or shutdown", async () => {
	for (const transition of ["unlock", "lock", "shutdown"] as const) {
		const fence = deferredDomain();
		const harness = createSemanticHarness({ processDomain: fence.domain });
		await startIdle(harness);
		harness.streaming = true;
		await harness.fire("agent_start", {});
		const claim = harness.runtime.getMainClaim();
		assert.ok(claim);
		harness.controller.unlock();
		harness.runtime.clearOperationalPendingWork();
		harness.runtime.retainErrorUnlock(claim);
		harness.streaming = false;
		const settling = settleOnly(harness);
		await waitForPendingConfirm(fence);
		if (transition === "shutdown") await harness.runtime.shutdown();
		else {
			harness.controller[transition]();
			harness.runtime.clearOperationalPendingWork();
		}
		while (fence.hasPending()) fence.resolve(true);
		await settling;
		assert.deepEqual(harness.received, [], transition);
		await harness.runtime.shutdown();
	}
});
