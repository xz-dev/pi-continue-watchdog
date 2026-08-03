import assert from "node:assert/strict";
import test from "node:test";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { HumanUnlockEntry } from "../src/commands.js";
import type { ContinueWatchdogConfig } from "../src/config.js";
import {
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_MESSAGE_TYPE,
} from "../src/context-fold.js";
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
			this.currentTimeMs += record.delayMs;
			record.callback();
		}
	}
}

type Handler = (event: never, ctx: ExtensionContext) => unknown;

interface SentMessage {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details: unknown;
	};
	options?: { triggerTurn?: boolean; deliverAs?: string };
	streaming: boolean;
}

interface Harness {
	readonly handlers: Map<string, Handler[]>;
	readonly clock: FakeClock;
	readonly config: ContinueWatchdogConfig;
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly hub: ReturnType<typeof createObservableAgentHub>;
	readonly sent: SentMessage[];
	readonly notifications: Array<{ message: string; level?: string }>;
	readonly entries: Array<{ type: string; data: unknown }>;
	readonly tools: DecisionToolActivation;
	ctx: ExtensionContext;
	runtime: ReturnType<typeof createDecisionRuntime>;
	streaming: boolean;
	triggeredTurns: number;
	activeTools: string[];
	fire(name: string, event: unknown): Promise<void>;
	openDecision(): void;
	executeContinue(toolCallId?: string): Promise<AgentToolResult<unknown>>;
	executeUnlock(
		reason: string,
		toolCallId?: string,
	): Promise<AgentToolResult<unknown>>;
}

function assistant(content: unknown[], stopReason = "toolUse"): unknown {
	return { role: "assistant", content, stopReason };
}

function toolCall(id: string, name: string, args: unknown): unknown {
	return { type: "toolCall", id, name, arguments: args };
}

function createHarness(options?: {
	readonly config?: Partial<ContinueWatchdogConfig>;
	readonly activationThrows?: boolean;
	readonly sendThrows?: boolean;
	readonly hasUI?: boolean;
}): Harness {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: options?.config?.idleDelaySeconds ?? 3,
		maxRetries: options?.config?.maxRetries ?? 3,
		decisionPrompt: options?.config?.decisionPrompt ?? "Decide now.",
		continuePrompt: options?.config?.continuePrompt ?? "Continue compactly.",
	};
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController(config);
	const holder = { controller };
	const handlers = new Map<string, Handler[]>();
	const clock = new FakeClock();
	const sent: SentMessage[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	let activeTools = ["read", "bash"];
	let captured: string[] | null = null;
	let initialized = false;
	let runtime: ReturnType<typeof createDecisionRuntime>;

	const tools: DecisionToolActivation = {
		initializeDecisionToolsInactive(): boolean {
			initialized = true;
			return true;
		},
		activateDecisionTools(): boolean {
			if (options?.activationThrows) throw new Error("activation failed");
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
		config,
		controller,
		hub,
		sent,
		notifications,
		entries,
		tools,
		streaming: false,
		triggeredTurns: 0,
		get activeTools(): string[] {
			return [...activeTools];
		},
		set activeTools(value: string[]) {
			activeTools = [...value];
		},
	} as Harness;

	const pi = {
		on(name: string, handler: Handler): void {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		sendMessage(
			message: SentMessage["message"],
			sendOptions?: SentMessage["options"],
		): void {
			if (options?.sendThrows) throw new Error("send failed");
			sent.push({
				message,
				options: sendOptions,
				streaming: harness.streaming,
			});
			if (sendOptions?.triggerTurn && !harness.streaming) {
				harness.triggeredTurns += 1;
			}
		},
		appendEntry(type: string, data: HumanUnlockEntry): void {
			entries.push({ type, data });
		},
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
		createExchangeId: () => "exchange-1",
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

	return harness;
}

async function startIdle(harness: Harness): Promise<void> {
	await harness.fire("session_start", { type: "session_start" });
}

/**
 * Fire agent_settled and the deferred 0ms settled-phase wake scheduled last by
 * the production handler. Capture before/after so idle-timer arming (which may
 * also be 0ms when idleDelaySeconds=0) is not mistaken for the wake callback.
 */
async function settleOnly(harness: Harness): Promise<void> {
	const before = harness.clock.records.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	const after = harness.clock.records.length;
	assert.ok(
		after > before,
		"true-idle agent_settled must schedule a deferred settled-phase callback",
	);
	// Production schedules the settled-phase wake after any markIdle side effects.
	const deferred = after - 1;
	assert.equal(harness.clock.records[deferred]?.delayMs, 0);
	harness.clock.fire(deferred);
}

async function settleResponse(
	harness: Harness,
	message: unknown,
): Promise<void> {
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [message],
	});
	harness.streaming = false;
	await settleOnly(harness);
}

test("idle arms one unref timer and opens one hidden decision-only window", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();

	assert.equal(harness.clock.records.length, 1);
	assert.equal(harness.clock.records[0]?.delayMs, 3000);
	assert.equal(harness.clock.records[0]?.unrefCount, 1);
	harness.clock.fire(0);

	assert.deepEqual(harness.activeTools, [
		"continue_watchdog",
		"unlock_continue_watchdog",
	]);
	assert.equal(harness.sent[0]?.message.customType, DECISION_MESSAGE_TYPE);
	assert.equal(harness.sent[0]?.message.display, false);
	assert.deepEqual(harness.sent[0]?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
});

test("zero idle delay schedules an asynchronous immediate decision", async () => {
	const harness = createHarness({ config: { idleDelaySeconds: 0 } });
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();

	assert.equal(harness.clock.records.length, 1);
	assert.equal(harness.clock.records[0]?.delayMs, 0);
	assert.equal(harness.sent.length, 0);
	harness.clock.fire(0);
	assert.equal(harness.sent[0]?.message.customType, DECISION_MESSAGE_TYPE);
});

test("fractional idle delay is scheduled in milliseconds", async () => {
	const harness = createHarness({ config: { idleDelaySeconds: 0.5 } });
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();

	assert.equal(harness.clock.records[0]?.delayMs, 500);
});

test("delays beyond one Node timer are scheduled in bounded chunks", async () => {
	const maximumTimerDelayMs = 2 ** 31 - 1;
	const harness = createHarness({
		config: { idleDelaySeconds: (maximumTimerDelayMs + 1000) / 1000 },
	});
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();

	assert.equal(harness.clock.records[0]?.delayMs, maximumTimerDelayMs);
	harness.clock.fire(0);
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.clock.records[1]?.delayMs, 1000);
	harness.clock.fire(1);
	assert.equal(harness.sent[0]?.message.customType, DECISION_MESSAGE_TYPE);
});

test("busy activity cancels the current chunk of a long delay", async () => {
	const maximumTimerDelayMs = 2 ** 31 - 1;
	const harness = createHarness({
		config: { idleDelaySeconds: (maximumTimerDelayMs + 1000) / 1000 },
	});
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();
	const child = harness.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "child",
		hasUI: false,
		initialBusy: false,
	}).attachment;

	harness.hub.markBusy(child);
	assert.equal(harness.clock.records[0]?.cleared, true);
	harness.clock.fire(0);
	assert.equal(harness.clock.records.length, 1);
	assert.equal(harness.sent.length, 0);
});

test("the largest finite delay starts with one bounded timer chunk", async () => {
	const maximumTimerDelayMs = 2 ** 31 - 1;
	const harness = createHarness({
		config: { idleDelaySeconds: Number.MAX_VALUE },
	});
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();

	assert.equal(harness.clock.records.length, 1);
	assert.equal(harness.clock.records[0]?.delayMs, maximumTimerDelayMs);
	assert.equal(harness.sent.length, 0);
	harness.clock.fire(0);
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.clock.records[1]?.delayMs, maximumTimerDelayMs);
	assert.equal(harness.clock.records.length, 2);
});

test("observable child busy cancels and full idle restarts the same delay", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();
	const child = harness.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "child",
		hasUI: false,
		initialBusy: false,
	}).attachment;

	harness.hub.markBusy(child);
	assert.equal(harness.clock.records[0]?.cleared, true);
	harness.hub.markIdle(child);
	assert.equal(harness.clock.records.length, 2);
	assert.equal(harness.clock.records[1]?.delayMs, 3000);
});

test("agent_end finalizes while streaming but settled alone dispatches continue", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.executeContinue();
	const before = harness.sent.length;
	const turnsBefore = harness.triggeredTurns;

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([toolCall("continue-1", "continue_watchdog", {})])],
	});
	assert.equal(harness.sent.length, before);
	assert.equal(harness.triggeredTurns, turnsBefore);

	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.equal(harness.sent.at(-1)?.message.content, "Continue compactly.");
	assert.deepEqual(harness.sent.at(-1)?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
	assert.equal(harness.triggeredTurns, turnsBefore + 1);
	assert.deepEqual(harness.activeTools, ["read", "bash"]);
	assert.equal(harness.controller.snapshot.attempt, 1);
});

test("continued settle rearms exponential delay once and exhausts at max", async () => {
	const harness = createHarness({ config: { maxRetries: 2 } });
	await startIdle(harness);
	harness.openDecision();
	await harness.executeContinue("continue-1");
	await settleResponse(
		harness,
		assistant([toolCall("continue-1", "continue_watchdog", {})]),
	);

	assert.equal(harness.clock.records.at(-1)?.delayMs, 6000);
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(harness.clock.records.at(-1)?.cleared, true);
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.idleTimer?.delaySeconds, 6);
	const secondTimer = harness.clock.records.findIndex(
		(record) => record.delayMs === 6000 && !record.cleared,
	);
	assert.ok(secondTimer >= 0);
	harness.clock.fire(secondTimer);
	await harness.executeContinue("continue-2");
	await settleResponse(
		harness,
		assistant([toolCall("continue-2", "continue_watchdog", {})]),
	);

	assert.equal(harness.controller.snapshot.exhausted, true);
	assert.equal(harness.controller.snapshot.attempt, 2);
	assert.equal(harness.controller.snapshot.idleTimer, null);
});

test("valid unlock folds without a turn and leaves one compact persisted result", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.executeUnlock("  waiting for user  ");
	const turnsBefore = harness.triggeredTurns;
	assert.deepEqual(harness.activeTools, [
		"continue_watchdog",
		"unlock_continue_watchdog",
	]);
	await settleResponse(
		harness,
		assistant([
			toolCall("unlock-1", "unlock_continue_watchdog", {
				reason: "waiting for user",
			}),
		]),
	);

	assert.deepEqual(harness.sent.at(-1)?.options, {
		triggerTurn: false,
		deliverAs: "steer",
	});
	assert.equal(harness.triggeredTurns, turnsBefore);
	assert.deepEqual(harness.entries, [
		{
			type: "pi-continue-watchdog:unlock",
			data: { reason: "waiting for user" },
		},
	]);
	// Settled delivery restores tools and persists the reason without a duplicate notification.
	assert.deepEqual(harness.activeTools, ["read", "bash"]);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.deepEqual(harness.notifications, []);
});

test("invalid decisions reask only after settle and third failure stays stopped", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const sentBefore = harness.sent.length;
		harness.streaming = true;
		await harness.fire("agent_start", { type: "agent_start" });
		await harness.fire("agent_end", {
			type: "agent_end",
			messages: [assistant([{ type: "text", text: "done" }], "stop")],
		});
		assert.equal(harness.sent.length, sentBefore);
		harness.streaming = false;
		await settleOnly(harness);
		if (attempt < 3) {
			assert.match(
				harness.sent.at(-1)?.message.content ?? "",
				/previous decision response was invalid/,
			);
		}
	}

	assert.equal(harness.controller.snapshot.decisionFailed, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.idleTimer, null);
	assert.deepEqual(harness.activeTools, ["read", "bash"]);
	assert.deepEqual(harness.notifications.at(-1), {
		message:
			"Continue watchdog decision failed after 3 attempts: Do not answer with prose; call exactly one decision tool.",
		level: "warning",
	});
});

test("aborted decision response is not finalized by agent_end (abort path owns unlock)", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([], "aborted")],
	});
	// Without the abort-outcome handler, true-idle settle treats the open decision
	// as a no-result and reasks once. agent_end itself must not finalize abort.
	assert.equal(harness.controller.snapshot.decisionOpen, true);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	await settleOnly(harness);
	assert.match(
		harness.sent.at(-1)?.message.content ?? "",
		/previous decision response was invalid/,
	);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
});

test("demotion, shutdown, stale timer, activation and send failures cleanly unlock", async () => {
	const stale = createHarness({ hasUI: false });
	await startIdle(stale);
	stale.runtime.applyTransition(stale.controller.lock(), undefined, {
		suppressNotify: true,
	});
	stale.runtime.reconcileIdle();
	const timer = stale.clock.records[0];
	assert.ok(timer);
	const uiMain = stale.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "replacement",
		hasUI: true,
		initialBusy: false,
	});
	assert.equal(stale.controller.snapshot.locked, false);
	assert.equal(timer.cleared, true);
	stale.hub.detach(uiMain.attachment);
	stale.hub.reclaimMain(
		stale.hub.bind({
			instance: createHubAttachmentInstance(),
			sessionId: "candidate",
			hasUI: false,
		}).attachment,
	);
	stale.clock.fire(0);
	assert.equal(stale.sent.length, 0);

	const activation = createHarness({ activationThrows: true });
	await startIdle(activation);
	activation.openDecision();
	assert.equal(activation.controller.snapshot.locked, false);
	assert.deepEqual(activation.activeTools, ["read", "bash"]);

	const sending = createHarness({ sendThrows: true });
	await startIdle(sending);
	sending.openDecision();
	assert.equal(sending.controller.snapshot.locked, false);
	assert.deepEqual(sending.activeTools, ["read", "bash"]);

	stale.runtime.shutdown();
	assert.equal(timer.cleared, true);
});

test("external unlock after agent_end cancels pending continue before settle", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.executeContinue();

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([toolCall("continue-1", "continue_watchdog", {})])],
	});
	const sentBefore = harness.sent.length;
	const turnsBefore = harness.triggeredTurns;

	// Transition first (locked=false), then operational cleanup.
	harness.runtime.applyTransition(harness.controller.unlock(), undefined, {
		suppressNotify: true,
	});
	assert.equal(harness.controller.snapshot.locked, false);
	harness.runtime.clearOperationalPendingWork();
	assert.deepEqual(harness.activeTools, ["read", "bash"]);

	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(harness.triggeredTurns, turnsBefore);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.idleTimer, null);
});

test("manual lock after pending continue clears fold and rearms base idle delay", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.executeContinue();

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([toolCall("continue-1", "continue_watchdog", {})])],
	});
	const sentBefore = harness.sent.length;

	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.clearOperationalPendingWork();
	assert.deepEqual(harness.activeTools, ["read", "bash"]);
	assert.equal(harness.controller.snapshot.attempt, 0);

	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.sent.length, sentBefore);
	harness.runtime.reconcileIdle();
	assert.equal(harness.controller.snapshot.idleTimer?.delaySeconds, 3);
	assert.equal(
		harness.clock.records.some(
			(record) => record.delayMs === 3000 && !record.cleared,
		),
		true,
	);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
});

test("unlocked main agent_start silently locks; locked start preserves cycle and decision", async () => {
	const harness = createHarness();
	await startIdle(harness);
	assert.equal(harness.controller.snapshot.locked, false);

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.deepEqual(harness.notifications, []);

	harness.streaming = false;
	await settleOnly(harness);
	// True idle after silent lock arms the base delay (possibly before deferred wake).
	assert.equal(harness.controller.snapshot.idleTimer?.delaySeconds, 3);
	const idleTimerIndex = harness.clock.records.findIndex(
		(record) => record.delayMs === 3000 && !record.cleared,
	);
	assert.ok(idleTimerIndex >= 0);
	harness.clock.fire(idleTimerIndex);
	assert.equal(harness.controller.snapshot.decisionOpen, true);
	const openAttempt = harness.controller.snapshot.invalidDecisionAttempts;

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, true);
	assert.equal(
		harness.controller.snapshot.invalidDecisionAttempts,
		openAttempt,
	);
	assert.deepEqual(harness.activeTools, [
		"continue_watchdog",
		"unlock_continue_watchdog",
	]);
});

test("false-idle settle schedules no deferred callback; later true settle reconciles", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	// Attachment already idle from session_start; mark busy then leave hub idle.
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(harness.hub.snapshot.allObservableIdle, false);

	// Nested false-idle outer settle must not schedule deferred wake or arm.
	harness.streaming = true;
	const timersBefore = harness.clock.records.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.hub.snapshot.allObservableIdle, false);
	assert.equal(harness.clock.records.length, timersBefore);

	// True settle: deferred wake finalizes/reconciles (and markIdle may arm too).
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.hub.snapshot.allObservableIdle, true);
	assert.notEqual(harness.controller.snapshot.idleTimer, null);

	// Cancel via busy, re-idle, then clear the timer without a hub edge and
	// prove true-idle settle still arms again via deferred reconcile.
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(harness.controller.snapshot.idleTimer, null);
	harness.streaming = false;
	await settleOnly(harness);
	const armed = harness.controller.snapshot.idleTimer;
	assert.ok(armed);
	// Force controller timer cleared without hub notification (no-op markIdle path).
	harness.controller.onObservableBusy();
	assert.equal(harness.controller.snapshot.idleTimer, null);
	assert.equal(harness.hub.snapshot.allObservableIdle, true);
	await settleOnly(harness);
	assert.notEqual(harness.controller.snapshot.idleTimer, null);
});

test("deferred settled wake is inert after later agent_start; next true settle works", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();

	// Open decision run with no agent_end so a true settle would synthesize no-result.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	harness.streaming = false;
	const before = harness.clock.records.length;
	const sentBefore = harness.sent.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.clock.records.length, before + 1);
	assert.equal(harness.clock.records[before]?.delayMs, 0);
	const deferred = before;

	// Nested/later start before the deferred settled-phase callback.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(harness.hub.snapshot.allObservableIdle, false);
	harness.clock.fire(deferred);

	// Must not finalize no-result or reask while busy.
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, true);

	// Later true settle finalizes once.
	harness.streaming = false;
	await settleOnly(harness);
	assert.match(
		harness.sent.at(-1)?.message.content ?? "",
		/previous decision response was invalid/,
	);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
});

test("stale deferred settle is inert after later start+settle even when ctx is idle again", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();

	// Run A: open decision turn, settle without agent_end, leave callback A unfired.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	harness.streaming = false;
	const settleABefore = harness.clock.records.length;
	const sentBefore = harness.sent.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.clock.records.length, settleABefore + 1);
	assert.equal(harness.clock.records[settleABefore]?.delayMs, 0);
	const deferredA = settleABefore;

	// Run B starts and true-idles before callback A fires. ctx is idle again.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	harness.streaming = false;
	const settleBBefore = harness.clock.records.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.clock.records.length, settleBBefore + 1);
	assert.equal(harness.clock.records[settleBBefore]?.delayMs, 0);
	const deferredB = settleBBefore;
	assert.equal(harness.hub.snapshot.allObservableIdle, true);

	// Stale callback A must not finalize/count/send/arm while B is the latest settle.
	harness.clock.fire(deferredA);
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, true);
	assert.equal(
		harness.clock.records.some(
			(record, index) =>
				index > deferredB && record.delayMs === 3000 && !record.cleared,
		),
		false,
	);

	// Latest callback B finalizes exactly once.
	harness.clock.fire(deferredB);
	assert.match(
		harness.sent.at(-1)?.message.content ?? "",
		/previous decision response was invalid/,
	);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.sent.length, sentBefore + 1);
});

test("duplicate true-idle settles schedule two wakes but only the latest acts", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	// No agent_end: both settles would synthesize no-result if both acted.
	harness.streaming = false;
	const firstBefore = harness.clock.records.length;
	const sentBefore = harness.sent.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.clock.records.length, firstBefore + 1);
	const deferredFirst = firstBefore;

	const secondBefore = harness.clock.records.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.clock.records.length, secondBefore + 1);
	const deferredSecond = secondBefore;

	// Older duplicate settle is inert.
	harness.clock.fire(deferredFirst);
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);

	// Latest settle acts once.
	harness.clock.fire(deferredSecond);
	assert.match(
		harness.sent.at(-1)?.message.content ?? "",
		/previous decision response was invalid/,
	);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.sent.length, sentBefore + 1);
});

test("decision settle without agent_end reasks twice then decision-fails without double count", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const sentBefore = harness.sent.length;
		harness.streaming = true;
		await harness.fire("agent_start", { type: "agent_start" });
		// No agent_end: true-idle settle must synthesize one malformed/no-result.
		harness.streaming = false;
		await settleOnly(harness);
		if (attempt < 3) {
			assert.match(
				harness.sent.at(-1)?.message.content ?? "",
				/previous decision response was invalid/,
			);
			assert.equal(
				harness.controller.snapshot.invalidDecisionAttempts,
				attempt,
			);
			assert.equal(harness.sent.length, sentBefore + 1);
		}
	}

	assert.equal(harness.controller.snapshot.decisionFailed, true);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 3);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.deepEqual(harness.activeTools, ["read", "bash"]);
	assert.deepEqual(harness.notifications.at(-1), {
		message:
			"Continue watchdog decision failed after 3 attempts: The decision response was malformed. Call exactly one decision tool.",
		level: "warning",
	});
});

test("pending valid continue keeps reconcile inert until fold delivery", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.executeContinue();

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([toolCall("continue-1", "continue_watchdog", {})])],
	});
	// Pending finalization must not arm a next delay yet.
	const timersAfterEnd = harness.clock.records.length;
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records.length, timersAfterEnd);
	assert.equal(harness.controller.snapshot.idleTimer, null);

	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.equal(harness.clock.records.at(-1)?.delayMs, 6000);
});

test("child completion only makes aggregate idle; exactly one inquiry comes from main", async () => {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: 3,
		maxRetries: 2,
		decisionPrompt: "Decide now.",
		continuePrompt: "Continue compactly.",
	};
	const hub = createObservableAgentHub();
	const clock = new FakeClock();
	const sentBy: string[] = [];
	const activatedBy: string[] = [];

	function attach(sessionId: string, hasUI: boolean) {
		const handlers = new Map<string, Handler[]>();
		const controller = createLockDecisionController(config);
		let active = false;
		const tools: DecisionToolActivation = {
			initializeDecisionToolsInactive: () => true,
			activateDecisionTools(): boolean {
				activatedBy.push(sessionId);
				active = true;
				return true;
			},
			restoreDecisionTools(): boolean {
				const wasActive = active;
				active = false;
				return wasActive;
			},
			isActive: () => active,
			getCapturedActiveTools: () => (active ? ["read"] : null),
		};
		const pi = {
			on(event: string, handler: Handler): void {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			sendMessage(): void {
				sentBy.push(sessionId);
			},
			appendEntry(): void {},
		} as unknown as ExtensionAPI;
		const runtime = createDecisionRuntime({
			pi,
			hub,
			attachmentInstance: createHubAttachmentInstance(),
			controllerHolder: { controller },
			decisionTools: tools,
			injectedController: true,
			initialConfig: config,
			clock,
		});
		runtime.registerLifecycle();
		let idle = false;
		const ctx = {
			hasUI,
			cwd: "/project",
			isIdle: () => idle,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => sessionId },
			ui: { notify(): void {} },
		} as unknown as ExtensionContext;
		return {
			runtime,
			controller,
			ctx,
			async emit(event: string): Promise<void> {
				if (event === "agent_settled") idle = true;
				for (const handler of handlers.get(event) ?? []) {
					await handler({ type: event } as never, ctx);
				}
			},
		};
	}

	const main = attach("main", true);
	const firstChild = attach("child-a", false);
	const lastChild = attach("child-b", false);
	await main.emit("session_start");
	await firstChild.emit("session_start");
	await lastChild.emit("session_start");
	main.runtime.applyTransition(main.controller.lock(), undefined, {
		suppressNotify: true,
	});

	await main.emit("agent_settled");
	assert.equal(clock.records[0]?.delayMs, 0);
	clock.fire(0);
	assert.deepEqual(sentBy, []);

	await firstChild.emit("agent_settled");
	assert.equal(clock.records[1]?.delayMs, 0);
	clock.fire(1);
	assert.deepEqual(sentBy, []);

	await lastChild.emit("agent_settled");
	assert.equal(clock.records[2]?.delayMs, 3000);
	assert.equal(clock.records[3]?.delayMs, 0);
	clock.fire(3);
	assert.deepEqual(sentBy, []);
	assert.deepEqual(activatedBy, []);
	clock.fire(2);
	assert.deepEqual(activatedBy, ["main"]);
	assert.deepEqual(sentBy, ["main"]);
});

test("shared hub reclaims main after UI shutdown then prefers a new UI bind", async () => {
	const hub = createObservableAgentHub();
	const clock = new FakeClock();
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: 3,
		maxRetries: 2,
		decisionPrompt: "Decide now.",
		continuePrompt: "Continue compactly.",
	};

	function attach(sessionId: string, hasUI: boolean) {
		const handlers = new Map<string, Handler[]>();
		const controller = createLockDecisionController(config);
		const holder = { controller };
		let activeTools = ["read", "bash"];
		let captured: string[] | null = null;
		const tools: DecisionToolActivation = {
			initializeDecisionToolsInactive(): boolean {
				return true;
			},
			activateDecisionTools(): boolean {
				if (captured !== null) return false;
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
			isActive: () => captured !== null,
			getCapturedActiveTools: () => captured,
		};
		const pi = {
			on(name: string, handler: Handler): void {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			sendMessage(): void {},
			appendEntry(): void {},
		} as unknown as ExtensionAPI;
		const runtime = createDecisionRuntime({
			pi,
			hub,
			attachmentInstance: createHubAttachmentInstance(),
			controllerHolder: holder,
			decisionTools: tools,
			injectedController: true,
			initialConfig: config,
			clock,
		});
		runtime.registerLifecycle();
		const ctx = {
			hasUI,
			cwd: "/project",
			isIdle: () => true,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => sessionId },
			ui: { notify(): void {} },
		} as unknown as ExtensionContext;
		return {
			runtime,
			controller,
			handlers,
			ctx,
			async start() {
				for (const handler of handlers.get("session_start") ?? []) {
					await handler({ type: "session_start" } as never, ctx);
				}
			},
		};
	}

	const ui = attach("ui-main", true);
	const child = attach("child", false);
	await ui.start();
	await child.start();
	assert.equal(ui.runtime.isCurrentMain(), true);
	assert.equal(child.runtime.isCurrentMain(), false);

	ui.runtime.applyTransition(ui.controller.lock(), undefined, {
		suppressNotify: true,
	});
	ui.runtime.reconcileIdle();
	assert.equal(clock.records.length, 1);

	ui.runtime.shutdown();
	assert.equal(child.runtime.isCurrentMain(), true);
	assert.equal(hub.snapshot.main?.sessionId, "child");
	assert.equal(hub.snapshot.main?.hasUI, false);

	child.runtime.applyTransition(child.controller.lock(), undefined, {
		suppressNotify: true,
	});
	child.runtime.reconcileIdle();
	assert.equal(clock.records.at(-1)?.delayMs, 3000);

	const nextUi = attach("ui-next", true);
	await nextUi.start();
	assert.equal(nextUi.runtime.isCurrentMain(), true);
	assert.equal(child.runtime.isCurrentMain(), false);
	assert.equal(hub.snapshot.main?.sessionId, "ui-next");
	assert.equal(hub.snapshot.main?.hasUI, true);

	nextUi.runtime.applyTransition(nextUi.controller.lock(), undefined, {
		suppressNotify: true,
	});
	nextUi.runtime.reconcileIdle();
	assert.equal(clock.records.at(-1)?.delayMs, 3000);
	assert.equal(nextUi.controller.snapshot.locked, true);
});

test("effective config loads before binding is reconciled and shutdown blocks late load", async () => {
	let resolveLoad:
		| ((value: { config: ContinueWatchdogConfig; diagnostics: [] }) => void)
		| undefined;
	const loaded = new Promise<{
		config: ContinueWatchdogConfig;
		diagnostics: [];
	}>((resolve) => {
		resolveLoad = resolve;
	});
	const base = createHarness();
	base.runtime.shutdown();
	const holder = {
		controller: createLockDecisionController({
			idleDelaySeconds: 3,
			maxRetries: 1,
		}),
	};
	const runtime = createDecisionRuntime({
		pi: {
			on(name: string, handler: Handler): void {
				const list = base.handlers.get(name) ?? [];
				list.push(handler);
				base.handlers.set(name, list);
			},
		} as unknown as ExtensionAPI,
		hub: createObservableAgentHub(),
		attachmentInstance: createHubAttachmentInstance(),
		controllerHolder: holder,
		decisionTools: base.tools,
		clock: base.clock,
		loadConfig: async () => loaded,
		agentDir: "/agent",
	});
	runtime.registerLifecycle();
	const start = (base.handlers.get("session_start") ?? []).at(-1);
	assert.ok(start);
	const pending = start({ type: "session_start" } as never, base.ctx);
	runtime.shutdown();
	resolveLoad?.({
		config: {
			idleDelaySeconds: 9,
			maxRetries: 2,
			decisionPrompt: "loaded decision",
			continuePrompt: "loaded continue",
		},
		diagnostics: [],
	});
	await pending;

	assert.equal(runtime.config.idleDelaySeconds, 3);
	assert.equal(holder.controller.snapshot.locked, false);
	assert.equal(base.clock.records.length, 0);
});
