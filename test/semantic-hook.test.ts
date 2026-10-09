import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";

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
	decisionToolDefinition: {
		readonly execute: (
			toolCallId: string,
			args: unknown,
		) => Promise<{
			readonly content: Array<{ type: string; text?: string }>;
			readonly details?: { readonly outcome?: string };
			readonly terminate?: boolean;
		}>;
	} | null;
	submitDecisionTool(toolCallId: string, args: unknown): Promise<unknown>;
	answerContinue(): unknown;
	answerWait(waitSeconds?: number, reason?: string): unknown;
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

let nextDecisionCallId = 0;

function cwCall(args: Record<string, unknown>): unknown {
	nextDecisionCallId += 1;
	const toolCallId = `cw-${nextDecisionCallId}`;
	return assistant([
		{ type: "toolCall", id: toolCallId, name: "cw", arguments: args },
	]);
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
	readonly listen?: boolean;
	readonly eventBus?: ReturnType<typeof createEventBus>;
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
	const branch: Array<{
		id: string;
		type: "custom_message" | "custom";
		customType: string;
		details?: unknown;
		data?: unknown;
	}> = [];
	let runtime: ReturnType<typeof createDecisionRuntime>;
	let lastDecisionMessage: { customType?: string; details?: unknown } | null =
		null;
	let startedDecisionDetails: unknown = null;

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
			if (message.customType === "pi-continue-watchdog:inquiry") {
				lastDecisionMessage = message;
			}
			options?.onSend?.(customType, hub);
			if (customType === options?.sendThrows) throw new Error("send failed");
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
				// A later lifecycle observation, after persistence, acknowledges delivery.
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
			harness.decisionToolDefinition = definition as unknown as NonNullable<
				SemanticHarness["decisionToolDefinition"]
			>;
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: options?.hasUI ?? true,
		cwd: "/project",
		isIdle: () => options?.isIdle?.() ?? !harness.streaming,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "main", getBranch: () => branch },
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
			await handler(
				(name === "message_end"
					? { type: "message_end", message: event }
					: event) as never,
				ctx,
			);
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
		// The provider-bound context projection carrying this attempt's exact
		// prompt: the consumption evidence required before any result can act.
		await harness.fire("context", {
			type: "context",
			messages: [
				{
					role: "custom",
					customType: lastDecisionMessage.customType,
					content: [{ type: "text", text: "decision prompt body" }],
					details: lastDecisionMessage.details,
					timestamp: Date.now(),
				},
			],
		});
		startedDecisionDetails = lastDecisionMessage.details;
	};
	harness.answerContinue = () => cwCall(continueArgs());
	harness.answerWait = (waitSeconds = 30, reason = "Waiting for automation.") =>
		cwCall(waitArgs(waitSeconds, reason));
	harness.answerUnlock = (
		reason = "All requested work is complete.",
		reasonType = "JOB_DONE",
	) => cwCall(unlockArgs(reasonType, reason));
	harness.decisionToolDefinition = null;
	harness.submitDecisionTool = async (toolCallId, args) =>
		harness.decisionToolDefinition?.execute(toolCallId, args);
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

/** agent_settled itself is the authoritative finalization boundary. */
async function settleOnly(harness: SemanticHarness): Promise<void> {
	await harness.fire("agent_settled", { type: "agent_settled" });
	await Promise.resolve();
	await Promise.resolve();
}

async function settleResponse(
	harness: SemanticHarness,
	message: unknown,
): Promise<void> {
	await harness.startDecision();
	// Mirror Pi ordering: message_end preflight, then the reserved call's
	// execute stages the verdict, then agent_end carries the terminal message.
	await harness.fire("message_end", message);
	const content =
		message !== null &&
		typeof message === "object" &&
		Array.isArray((message as { content?: unknown }).content)
			? ((message as { content: unknown[] }).content as Array<
					Record<string, unknown>
				>)
			: [];
	for (const block of content) {
		if (block.type !== "toolCall" || block.name !== "cw") continue;
		await harness.submitDecisionTool(String(block.id), block.arguments);
	}
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

test("exhausted and decisionFailed publish exact STOP_KIND envelopes once", async () => {
	const exhausted = createSemanticHarness({ config: { maxRetries: 1 } });
	await startIdle(exhausted);
	await exhausted.openDecision();
	await settleResponse(exhausted, exhausted.answerContinue());
	assert.equal(exhausted.received[0]?.name, "watchdog-continued");
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
	// The retired wait is one invalid response: its re-ask stays internal.
	const decisionCount = harness.sentTypes.filter(
		(type) => type === "pi-continue-watchdog:inquiry",
	).length;
	assert.ok(decisionCount >= 1);
});

test("three retired wait submissions decision-fail without any waiting hook", async () => {
	const harness = createSemanticHarness();
	await startIdle(harness);
	await harness.openDecision();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await settleResponse(harness, harness.answerWait(30, "Waiting for CI."));
	}
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
	const harness = createSemanticHarness({ config: { maxRetries: 1 } });
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

test("WAIT_CALLBACK unlock publishes typed user-ready with no waiting hook or timer", async () => {
	const harness = createSemanticHarness({
		config: {
			reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerUnlock("Waiting for the subagent callback.", "WAIT_CALLBACK"),
	);
	assert.equal(harness.snapshotController().attempt, 0);
	assert.equal(harness.snapshotController().locked, false);
	assert.deepEqual(harness.received, [
		{
			version: 1,
			name: "user-ready",
			values: {
				STOP_KIND: "AI_UNLOCK",
				REASON_TYPE: "WAIT_CALLBACK",
				REASON: "Waiting for the subagent callback.",
			},
		},
	]);
	const deadlineTimers = harness.clock.records.filter(
		(record) => !record.cleared && record.delayMs !== 10_000,
	);
	assert.deepEqual(deadlineTimers, []);
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
		"pi-continue-watchdog:inquiry-fold",
	]);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
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

	const continued = createSemanticHarness({ config: { maxRetries: 3 } });
	await startIdle(continued);
	await continued.openDecision();
	await settleResponse(
		continued,
		cwCall(continueArgs("verifying", "Tests still need to run.")),
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
	const settling = harness.fire("agent_settled", { type: "agent_settled" });
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
	await settling;
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
