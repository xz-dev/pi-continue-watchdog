import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";

import type { ContinueWatchdogConfig } from "../src/config.js";
import { createLockDecisionController } from "../src/controller.js";
import type { DecisionToolActivation } from "../src/decision-tools.js";
import {
	createHubAttachmentInstance,
	createObservableAgentHub,
} from "../src/hub.js";
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
	ctx: ExtensionContext;
	runtime: ReturnType<typeof createDecisionRuntime>;
	streaming: boolean;
	activeTools: string[];
	fire(name: string, event: unknown): Promise<void>;
	openDecision(): void;
	executeContinue(toolCallId?: string): Promise<AgentToolResult<unknown>>;
	executeUnlock(
		reason: string,
		toolCallId?: string,
	): Promise<AgentToolResult<unknown>>;
	snapshotController(): {
		locked: boolean;
		exhausted: boolean;
		decisionFailed: boolean;
		attempt: number;
	};
}

function assistant(content: unknown[], stopReason = "toolUse"): unknown {
	return { role: "assistant", content, stopReason };
}

function toolCall(id: string, name: string, args: unknown): unknown {
	return { type: "toolCall", id, name, arguments: args };
}

function createSemanticHarness(options?: {
	readonly config?: Partial<ContinueWatchdogConfig>;
	readonly hasUI?: boolean;
}): SemanticHarness {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: options?.config?.idleDelaySeconds ?? 3,
		maxRetries: options?.config?.maxRetries ?? 2,
		decisionPrompt: options?.config?.decisionPrompt ?? "Decide now.",
		continuePrompt: options?.config?.continuePrompt ?? "Continue compactly.",
	};
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController(config);
	const holder = { controller };
	const handlers = new Map<string, Handler[]>();
	const clock = new FakeClock();
	const received: SemanticHookEnvelope[] = [];
	const bus = createEventBus();
	const notifications: Array<{ message: string; level?: string }> = [];
	let activeTools = ["read", "bash"];
	let captured: string[] | null = null;
	let initialized = false;
	let runtime: ReturnType<typeof createDecisionRuntime>;

	bus.on(SEMANTIC_HOOK_CHANNEL, (data) => {
		received.push(data as SemanticHookEnvelope);
	});

	const tools: DecisionToolActivation = {
		registerDecisionTools: () => {},
		initializeDecisionToolsInactive(): boolean {
			initialized = true;
			return true;
		},
		activateDecisionTools(): boolean {
			if (!initialized || captured !== null) return false;
			captured = [...activeTools];
			activeTools = ["continue_watchdog", "unlock_continue_watchdog"];
			return true;
		},
		restoreDecisionTools(): boolean {
			if (captured === null) return false;
			activeTools = captured;
			captured = null;
			return true;
		},
		isActive: () => initialized && captured !== null,
		getCapturedActiveTools: () => captured,
	};

	const harness = {
		handlers,
		clock,
		controller,
		hub,
		received,
		bus,
		notifications,
		streaming: false,
		get activeTools(): string[] {
			return [...activeTools];
		},
	} as SemanticHarness;

	const pi = {
		on(name: string, handler: Handler): void {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		events: bus,
		sendMessage(): void {},
		appendEntry(): void {},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: options?.hasUI ?? true,
		cwd: "/project",
		isIdle: () => !harness.streaming,
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
		attachmentInstance: createHubAttachmentInstance(),
		controllerHolder: holder,
		decisionTools: tools,
		injectedController: true,
		initialConfig: config,
		clock,
		createExchangeId: () => "exchange-semantic",
	});
	runtime.registerLifecycle();

	harness.ctx = ctx;
	harness.runtime = runtime;
	harness.fire = async (name, event) => {
		for (const handler of handlers.get(name) ?? []) {
			await handler(event as never, ctx);
		}
	};
	harness.openDecision = () => {
		runtime.applyTransition(controller.lock(), undefined, {
			suppressNotify: true,
		});
		runtime.reconcileIdle();
		clock.fire(clock.records.length - 1);
	};
	harness.executeContinue = async (toolCallId = "continue-1") =>
		runtime.executeDecisionTool({
			kind: "continue",
			toolCallId,
			ctx,
		});
	harness.executeUnlock = async (reason, toolCallId = "unlock-1") =>
		runtime.executeDecisionTool({
			kind: "unlock",
			reason,
			toolCallId,
			ctx,
		});
	harness.snapshotController = () => ({
		locked: controller.snapshot.locked,
		exhausted: controller.snapshot.exhausted,
		decisionFailed: controller.snapshot.decisionFailed,
		attempt: controller.snapshot.attempt,
	});

	return harness;
}

async function startIdle(harness: SemanticHarness): Promise<void> {
	await harness.fire("session_start", { type: "session_start" });
}

async function settleResponse(
	harness: SemanticHarness,
	message: unknown,
): Promise<void> {
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [message],
	});
	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
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
		REASON: "waiting for review",
	});
	const exhausted = createUserReadyEnvelope({ STOP_KIND: "EXHAUSTED" });
	const failed = createUserReadyEnvelope({ STOP_KIND: "DECISION_FAILED" });

	assert.deepEqual(unlock, {
		version: 1,
		name: USER_READY_HOOK_NAME,
		values: { STOP_KIND: "AI_UNLOCK", REASON: "waiting for review" },
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

test("AI decision unlock publishes exact validated reason once at terminal idle", async () => {
	const harness = createSemanticHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.executeUnlock("  waiting for user  ");
	await settleResponse(
		harness,
		assistant([
			toolCall("unlock-1", "unlock_continue_watchdog", {
				reason: "waiting for user",
			}),
		]),
	);

	assert.equal(harness.received.length, 1);
	const unlockEnvelope = harness.received[0];
	assert.ok(unlockEnvelope);
	assert.deepEqual(unlockEnvelope, {
		version: 1,
		name: "user-ready",
		values: { STOP_KIND: "AI_UNLOCK", REASON: "waiting for user" },
	});
	assertFrozenEnvelope(unlockEnvelope);
	assert.equal(harness.snapshotController().locked, false);

	// Same idle epoch reconcile must not republish.
	harness.runtime.reconcileIdle();
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.received.length, 1);
});

test("exhausted and decisionFailed publish exact STOP_KIND envelopes once", async () => {
	const exhausted = createSemanticHarness({ config: { maxRetries: 1 } });
	await startIdle(exhausted);
	exhausted.openDecision();
	await exhausted.executeContinue("continue-1");
	await settleResponse(
		exhausted,
		assistant([toolCall("continue-1", "continue_watchdog", {})]),
	);
	assert.equal(exhausted.snapshotController().exhausted, true);
	// Continue turn settles into terminal exhausted idle.
	await settleResponse(
		exhausted,
		assistant([{ type: "text", text: "done working" }], "stop"),
	);
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
	await exhausted.fire("agent_settled", { type: "agent_settled" });
	assert.equal(exhausted.received.length, 1);

	const failed = createSemanticHarness();
	await startIdle(failed);
	failed.openDecision();
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
	await human.fire("agent_settled", { type: "agent_settled" });
	assert.equal(human.received.length, 0);

	human.runtime.prepareForLockStateChange();
	human.runtime.applyTransition(human.controller.lock(), undefined, {
		suppressNotify: true,
	});
	human.runtime.reconcileIdle();
	assert.equal(human.clock.records.length, 1);
	human.runtime.prepareForLockStateChange();
	human.runtime.applyTransition(human.controller.unlock(), undefined, {
		suppressNotify: true,
	});
	await human.fire("agent_settled", { type: "agent_settled" });
	assert.equal(human.received.length, 0);

	// Canonical/manual abort unlock path: prepare + reasonless unlock.
	human.runtime.applyTransition(human.controller.lock(), undefined, {
		suppressNotify: true,
	});
	human.runtime.reconcileIdle();
	human.runtime.prepareForLockStateChange();
	human.runtime.applyTransition(human.controller.unlock(), undefined, {
		suppressNotify: true,
	});
	await human.fire("agent_settled", { type: "agent_settled" });
	assert.equal(human.received.length, 0);

	const continued = createSemanticHarness({ config: { maxRetries: 3 } });
	await startIdle(continued);
	continued.openDecision();
	await continued.executeContinue("continue-1");
	await settleResponse(
		continued,
		assistant([toolCall("continue-1", "continue_watchdog", {})]),
	);
	// Intermediate post-continue rearm must not publish.
	assert.equal(continued.received.length, 0);
	assert.notEqual(continued.controller.snapshot.idleTimer, null);
	// Locked pending idle timer epoch stays quiet.
	continued.runtime.reconcileIdle();
	assert.equal(continued.received.length, 0);
});

test("AI unlock intent waits for aggregate idle and publishes only once", async () => {
	const harness = createSemanticHarness();
	await startIdle(harness);
	harness.openDecision();
	const child = harness.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "child",
		hasUI: false,
		initialBusy: true,
	}).attachment;
	await harness.executeUnlock("child still busy");
	await settleResponse(
		harness,
		assistant([
			toolCall("unlock-1", "unlock_continue_watchdog", {
				reason: "child still busy",
			}),
		]),
	);
	// Main settled but child busy: retain intent, no publish yet.
	assert.equal(harness.received.length, 0);

	harness.hub.markIdle(child);
	assert.equal(harness.received.length, 1);
	assert.deepEqual(harness.received[0]?.values, {
		STOP_KIND: "AI_UNLOCK",
		REASON: "child still busy",
	});

	// Same terminal epoch: no second publication.
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
	reloaded.openDecision();
	await reloaded.executeUnlock("will reload");
	// Shutdown before settle clears ownership generation bookkeeping.
	reloaded.runtime.shutdown();
	await reloaded.fire("agent_end", {
		type: "agent_end",
		messages: [
			assistant([
				toolCall("unlock-1", "unlock_continue_watchdog", {
					reason: "will reload",
				}),
			]),
		],
	});
	await reloaded.fire("agent_settled", { type: "agent_settled" });
	assert.equal(reloaded.received.length, 0);
});

test("absent and throwing consumers leave controller and results unchanged", async () => {
	const noConsumer = createSemanticHarness();
	// Drop the only listener so emission has no consumer.
	noConsumer.bus.clear();
	await startIdle(noConsumer);
	noConsumer.openDecision();
	await noConsumer.executeUnlock("silent consumer absence");
	await settleResponse(
		noConsumer,
		assistant([
			toolCall("unlock-1", "unlock_continue_watchdog", {
				reason: "silent consumer absence",
			}),
		]),
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
		throwing.openDecision();
		await throwing.executeUnlock("consumer throws");
		await settleResponse(
			throwing,
			assistant([
				toolCall("unlock-1", "unlock_continue_watchdog", {
					reason: "consumer throws",
				}),
			]),
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
	options?: { readonly hasUI?: boolean },
): Promise<{
	readonly harness: SemanticHarness;
	readonly child: ReturnType<
		ReturnType<typeof createObservableAgentHub>["bind"]
	>["attachment"];
}> {
	const harness = createSemanticHarness({
		hasUI: options?.hasUI ?? true,
	});
	await startIdle(harness);
	harness.openDecision();
	const child = harness.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: `child-${reason}`,
		hasUI: false,
		initialBusy: true,
	}).attachment;
	await harness.executeUnlock(reason);
	await settleResponse(
		harness,
		assistant([toolCall("unlock-1", "unlock_continue_watchdog", { reason })]),
	);
	assert.equal(harness.received.length, 0);
	assert.equal(harness.snapshotController().locked, false);
	return { harness, child };
}

function aiUnlockCount(received: readonly SemanticHookEnvelope[]): number {
	return received.filter(
		(envelope) => envelope.values?.STOP_KIND === "AI_UNLOCK",
	).length;
}

test("pending AI unlock intent is cleared by external lock/ownership transitions", async () => {
	// Human/manual unlock seam: prepareForLockStateChange + controller unlock.
	// Canonical abort also clears via the same prepareForLockStateChange public
	// seam before unlock; the semantic harness has no sessionManager branch
	// surface for a full abort capture, so this is the reachable external path.
	{
		const { harness, child } = await establishPendingAiUnlock(
			"pending then human unlock",
		);
		harness.runtime.prepareForLockStateChange();
		harness.runtime.applyTransition(harness.controller.unlock(), undefined, {
			suppressNotify: true,
		});
		harness.hub.markIdle(child);
		harness.runtime.reconcileIdle();
		await harness.fire("agent_settled", { type: "agent_settled" });
		assert.equal(aiUnlockCount(harness.received), 0);
		assert.equal(harness.received.length, 0);
	}

	// Human/manual lock replaces state after prepare clears retained intent.
	{
		const { harness, child } = await establishPendingAiUnlock(
			"pending then human lock",
		);
		harness.runtime.prepareForLockStateChange();
		harness.runtime.applyTransition(harness.controller.lock(), undefined, {
			suppressNotify: true,
		});
		harness.hub.markIdle(child);
		harness.runtime.reconcileIdle();
		await harness.fire("agent_settled", { type: "agent_settled" });
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
		await harness.fire("agent_settled", { type: "agent_settled" });
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
		await harness.fire("agent_settled", { type: "agent_settled" });
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
		harness.openDecision();
		await harness.executeUnlock("async reject path");
		await settleResponse(
			harness,
			assistant([
				toolCall("unlock-1", "unlock_continue_watchdog", {
					reason: "async reject path",
				}),
			]),
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
		values: { STOP_KIND: "AI_UNLOCK", REASON: "async reject path" },
	});
	assert.deepEqual(harness.snapshotController(), {
		locked: false,
		exhausted: false,
		decisionFailed: false,
		attempt: 0,
	});
});
