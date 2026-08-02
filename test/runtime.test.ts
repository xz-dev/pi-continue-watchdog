import assert from "node:assert/strict";
import test from "node:test";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	HUMAN_UNLOCK_ENTRY_TYPE,
	type HumanUnlockEntry,
} from "../src/commands.js";
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

	fire(index: number): void {
		const record = this.records[index];
		assert.ok(record, `expected timer ${index}`);
		if (!record.cleared) record.callback();
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
		registerDecisionTools: () => {},
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
	await harness.fire("agent_settled", { type: "agent_settled" });
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
	await harness.fire("agent_settled", { type: "agent_settled" });
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
	await harness.fire("agent_settled", { type: "agent_settled" });
	const secondTimer = harness.clock.records.length - 1;
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

test("valid unlock folds without a turn, persists reason, and notifies", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.executeUnlock("  waiting for user  ");
	const turnsBefore = harness.triggeredTurns;
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
			type: HUMAN_UNLOCK_ENTRY_TYPE,
			data: { reason: "waiting for user" },
		},
	]);
	assert.deepEqual(harness.notifications.at(-1), {
		message: "Continue watchdog unlocked: waiting for user",
		level: undefined,
	});
	assert.equal(harness.controller.snapshot.locked, false);
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
		await harness.fire("agent_settled", { type: "agent_settled" });
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

test("aborted decision response is left for the canonical abort settle path", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([], "aborted")],
	});
	await harness.fire("agent_settled", { type: "agent_settled" });

	assert.equal(harness.sent.length, 1);
	assert.equal(harness.controller.snapshot.decisionOpen, true);
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

	harness.runtime.prepareForLockStateChange();
	harness.runtime.applyTransition(harness.controller.unlock(), undefined, {
		suppressNotify: true,
	});
	assert.deepEqual(harness.activeTools, ["read", "bash"]);

	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
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

	harness.runtime.prepareForLockStateChange();
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	assert.deepEqual(harness.activeTools, ["read", "bash"]);
	assert.equal(harness.controller.snapshot.attempt, 0);

	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.sent.length, sentBefore);
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records.at(-1)?.delayMs, 3000);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
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
			registerDecisionTools: () => {},
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
