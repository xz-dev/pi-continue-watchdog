import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { HumanUnlockEntry } from "../src/commands.js";
import {
	type ContinueWatchdogConfig,
	MAX_PROMPT_CHARACTERS,
} from "../src/config.js";
import {
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_MESSAGE_TYPE,
} from "../src/context-fold.js";
import { createLockDecisionController } from "../src/controller.js";
import { DECISION_TOOL_BLOCK_REASON } from "../src/decision-protocol.js";
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

interface DecisionMessageReplacement {
	readonly message: {
		readonly role: "assistant";
		readonly content: readonly unknown[];
	};
}

interface Harness {
	readonly handlers: Map<string, Handler[]>;
	readonly clock: FakeClock;
	readonly widgets: Array<{ key: string; value: unknown }>;
	readonly config: ContinueWatchdogConfig;
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly hub: ReturnType<typeof createObservableAgentHub>;
	readonly sent: SentMessage[];
	readonly notifications: Array<{ message: string; level?: string }>;
	readonly entries: Array<{ type: string; data: unknown }>;
	ctx: ExtensionContext;
	runtime: ReturnType<typeof createDecisionRuntime>;
	streaming: boolean;
	triggeredTurns: number;
	fire(name: string, event: unknown): Promise<void>;
	openDecision(): void;
	answerContinue(): unknown;
	answerUnlock(reason?: string, reasonType?: string): unknown;
	answerInvalid(text?: string): unknown;
	endDecisionMessage(message: unknown): Promise<unknown>;
	blockToolCall(): Promise<unknown>;
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

function createHarness(options?: {
	readonly config?: Partial<ContinueWatchdogConfig>;
	readonly sendThrows?: boolean;
	readonly appendThrows?: boolean | string;
	readonly hasUI?: boolean;
	readonly onNotify?: (message: string) => void;
}): Harness {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: options?.config?.idleDelaySeconds ?? 3,
		maxRetries: options?.config?.maxRetries ?? 3,
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
	const sent: SentMessage[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const widgets: Array<{ key: string; value: unknown }> = [];
	let runtime: ReturnType<typeof createDecisionRuntime>;

	const harness = {
		handlers,
		clock,
		config,
		controller,
		hub,
		sent,
		notifications,
		entries,
		widgets,
		streaming: false,
		triggeredTurns: 0,
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
			if (options?.appendThrows === true || options?.appendThrows === type) {
				throw new Error("append failed");
			}
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
				options?.onNotify?.(message);
			},
			setWidget(key: string, value: unknown): void {
				widgets.push({ key, value });
			},
		},
	} as unknown as ExtensionContext;

	runtime = createDecisionRuntime({
		pi,
		hub,
		attachmentInstance: createHubAttachmentInstance(),
		controllerHolder: holder,
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
	harness.answerContinue = () => assistant([text(continueXml())]);
	harness.answerUnlock = (
		reason = "All requested work is complete.",
		reasonType = "JOB_DONE",
	) => assistant([text(unlockXml(reasonType, reason))]);
	harness.answerInvalid = (value = "I will wait.") => assistant([text(value)]);
	harness.endDecisionMessage = async (message: unknown) => {
		let result: unknown;
		for (const handler of handlers.get("message_end") ?? []) {
			result = await handler({ type: "message_end", message } as never, ctx);
		}
		return result;
	};
	harness.blockToolCall = async () => {
		let result: unknown;
		for (const handler of handlers.get("tool_call") ?? []) {
			result = await handler(
				{
					type: "tool_call",
					toolCallId: "bash-1",
					toolName: "bash",
					input: { command: "true" },
				} as never,
				ctx,
			);
		}
		return result;
	};

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
	const deferred = after - 1;
	assert.equal(harness.clock.records[deferred]?.delayMs, 0);
	harness.clock.fire(deferred);
	await Promise.resolve();
	await Promise.resolve();
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

	assert.equal(harness.sent[0]?.message.customType, DECISION_MESSAGE_TYPE);
	assert.equal(harness.sent[0]?.message.display, false);
	assert.deepEqual(harness.sent[0]?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
});

test("maximum configured decision prompt still opens and re-asks with generated XML suffix", async () => {
	const configuredPrompt = "x".repeat(MAX_PROMPT_CHARACTERS);
	const harness = createHarness({
		config: { decisionPrompt: configuredPrompt },
	});
	await startIdle(harness);
	harness.openDecision();

	const firstPrompt = harness.sent.at(-1)?.message.content ?? "";
	assert.equal(firstPrompt.startsWith(configuredPrompt), true);
	assert.equal(firstPrompt.length > MAX_PROMPT_CHARACTERS, true);
	assert.match(firstPrompt, /exactly one <watchdog>/);

	await settleResponse(harness, harness.answerInvalid());
	const reask = harness.sent.at(-1)?.message.content ?? "";
	assert.equal(reask.startsWith(configuredPrompt), true);
	assert.equal(reask.length > firstPrompt.length, true);
	assert.match(reask, /previous decision response was invalid/);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
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
	assert.deepEqual(harness.entries, []);
	assert.equal(harness.widgets.at(-1)?.key, "pi-continue-watchdog:status");
	assert.notEqual(harness.widgets.at(-1)?.value, undefined);
	const before = harness.sent.length;
	const turnsBefore = harness.triggeredTurns;

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerContinue()],
	});
	assert.equal(harness.sent.length, before);
	assert.equal(harness.triggeredTurns, turnsBefore);

	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.deepEqual(harness.sent.at(-1)?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
	assert.equal(harness.triggeredTurns, turnsBefore + 1);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.deepEqual(harness.entries, [
		{
			type: "pi-continue-watchdog:continue",
			data: {},
		},
	]);
	assert.deepEqual(harness.widgets.at(-1), {
		key: "pi-continue-watchdog:status",
		value: undefined,
	});
});

test("continue entry persistence failure prevents an invisible continuation", async () => {
	const harness = createHarness({
		appendThrows: "pi-continue-watchdog:continue",
	});
	await startIdle(harness);
	harness.openDecision();
	const sentBefore = harness.sent.length;

	await settleResponse(harness, harness.answerContinue());

	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(harness.triggeredTurns, 1);
	assert.deepEqual(harness.entries, []);
});

test("decision message_end hides XML, persists a context-excluded audit, and finalizes from the captured response", async () => {
	const harness = createHarness();
	await startIdle(harness);
	const answer = harness.answerUnlock("Waiting for approval.", "WAIT_USER");

	assert.equal(await harness.endDecisionMessage(answer), undefined);
	assert.deepEqual(harness.entries, []);

	harness.openDecision();
	const replacement = (await harness.endDecisionMessage(
		answer,
	)) as DecisionMessageReplacement;
	assert.equal(replacement.message.role, "assistant");
	assert.deepEqual(replacement.message.content, []);
	assert.deepEqual(harness.entries.at(-1), {
		type: "pi-continue-watchdog:decision-audit",
		data: {
			version: 1,
			exchangeId: "exchange-1",
			cycleId: 1,
			outcome: "unlock",
			reasonType: "WAIT_USER",
			reason: "Waiting for approval.",
		},
	});

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [replacement.message],
	});
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.deepEqual(harness.entries.at(-1), {
		type: "pi-continue-watchdog:unlock",
		data: { reasonType: "WAIT_USER", reason: "Waiting for approval." },
	});
});

test("decision provider error stays provisional so the same Pi run can retry and unlock", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	const providerError = assistant([], "error");
	assert.equal(await harness.endDecisionMessage(providerError), undefined);
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [providerError],
	});

	const unlock = harness.answerUnlock(
		"All requested work is complete.",
		"JOB_DONE",
	);
	const replacement = (await harness.endDecisionMessage(
		unlock,
	)) as DecisionMessageReplacement;
	assert.deepEqual(replacement.message.content, []);
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [unlock],
	});

	harness.streaming = false;
	await settleOnly(harness);

	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(
		harness.sent.filter((entry) =>
			entry.message.content.includes("previous decision response was invalid"),
		).length,
		0,
	);
	assert.equal(
		harness.sent.filter(
			(entry) => entry.message.customType === DECISION_FOLD_MESSAGE_TYPE,
		).length,
		1,
	);
	assert.deepEqual(harness.sent.at(-1), {
		message: {
			customType: DECISION_FOLD_MESSAGE_TYPE,
			content: "",
			display: false,
			details: {
				version: 1,
				exchangeId: "exchange-1",
				cycleId: 1,
				outcome: "unlock",
			},
		},
		options: { triggerTurn: false, deliverAs: "steer" },
		streaming: false,
	});
	assert.deepEqual(
		harness.entries.filter(
			(entry) => entry.type !== "pi-continue-watchdog:status",
		),
		[
			{
				type: "pi-continue-watchdog:decision-audit",
				data: {
					version: 1,
					exchangeId: "exchange-1",
					cycleId: 1,
					outcome: "unlock",
					reasonType: "JOB_DONE",
					reason: "All requested work is complete.",
				},
			},
			{
				type: "pi-continue-watchdog:unlock",
				data: {
					reasonType: "JOB_DONE",
					reason: "All requested work is complete.",
				},
			},
		],
	);
	assert.deepEqual(harness.notifications, []);
});

test("each invalid XML response persists a parser re-ask event and updates checking", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();

	await settleResponse(harness, harness.answerInvalid("not XML"));

	assert.deepEqual(harness.entries.at(-1), {
		type: "pi-continue-watchdog:status",
		data: {
			kind: "validation-error",
			exchangeId: "exchange-1",
			cycleId: 1,
			message: "End the response with one valid watchdog XML decision block.",
		},
	});
	assert.notEqual(harness.widgets.at(-1)?.value, undefined);
});

test("decision provider errors persist Other error with original content", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	const providerError = {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "Connection error.",
	};

	assert.equal(await harness.endDecisionMessage(providerError), undefined);
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [providerError],
	});

	assert.deepEqual(harness.entries.at(-1), {
		type: "pi-continue-watchdog:status",
		data: {
			kind: "other-error",
			exchangeId: "exchange-1",
			cycleId: 1,
			message: "Connection error.",
		},
	});
});

test("decision message_end audit records invalid output without retaining raw text", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	const replacement = (await harness.endDecisionMessage(
		harness.answerInvalid("private malformed watchdog answer"),
	)) as DecisionMessageReplacement;

	assert.deepEqual(replacement.message.content, []);
	assert.deepEqual(harness.entries.at(-1), {
		type: "pi-continue-watchdog:decision-audit",
		data: {
			version: 1,
			exchangeId: "exchange-1",
			cycleId: 1,
			outcome: "invalid",
			error: "End the response with one valid watchdog XML decision block.",
		},
	});
	assert.equal(
		JSON.stringify(harness.entries).includes("private malformed"),
		false,
	);
});

test("decision window blocks ordinary tool_call before execution", async () => {
	const harness = createHarness();
	await startIdle(harness);
	assert.equal(await harness.blockToolCall(), undefined);

	harness.openDecision();
	assert.deepEqual(await harness.blockToolCall(), {
		block: true,
		reason: DECISION_TOOL_BLOCK_REASON,
	});

	await settleResponse(harness, harness.answerContinue());
	assert.equal(await harness.blockToolCall(), undefined);
});

test("continued settle rearms exponential delay once and exhausts at max", async () => {
	const harness = createHarness({ config: { maxRetries: 2 } });
	await startIdle(harness);
	harness.openDecision();
	await settleResponse(harness, harness.answerContinue());

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
	await settleResponse(harness, harness.answerContinue());

	assert.equal(harness.controller.snapshot.exhausted, true);
	assert.equal(harness.controller.snapshot.attempt, 2);
	assert.equal(harness.controller.snapshot.idleTimer, null);
});

test("valid unlock folds without a turn and leaves one compact persisted result", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	const turnsBefore = harness.triggeredTurns;
	await settleResponse(
		harness,
		harness.answerUnlock("waiting for user", "job_done"),
	);

	assert.deepEqual(harness.sent.at(-1)?.options, {
		triggerTurn: false,
		deliverAs: "steer",
	});
	assert.equal(harness.triggeredTurns, turnsBefore);
	assert.deepEqual(
		harness.entries.filter(
			(entry) => entry.type !== "pi-continue-watchdog:status",
		),
		[
			{
				type: "pi-continue-watchdog:unlock",
				data: {
					reasonType: "JOB_DONE",
					reason: "waiting for user",
				},
			},
		],
	);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.deepEqual(harness.notifications, []);
});

test("Example 7: AI unlock retains typed entry data only; no transient notification", async () => {
	const harness = createHarness({
		config: { reasonTypes: ["NeedReview", "shipped"] },
	});
	await startIdle(harness);
	harness.openDecision();
	await settleResponse(
		harness,
		harness.answerUnlock("PR is open for human review.", "needreview"),
	);

	assert.deepEqual(
		harness.entries.filter(
			(entry) => entry.type !== "pi-continue-watchdog:status",
		),
		[
			{
				type: "pi-continue-watchdog:unlock",
				data: {
					reasonType: "NEEDREVIEW",
					reason: "PR is open for human review.",
				},
			},
		],
	);
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
			messages: [harness.answerInvalid("done")],
		});
		assert.equal(harness.sent.length, sentBefore);
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
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.deepEqual(harness.notifications.at(-1), {
		message:
			"Continue watchdog decision failed after 3 attempts: End the response with one valid watchdog XML decision block.",
		level: "warning",
	});
});

test("aborted decision response is not finalized by agent_end (abort path owns unlock)", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	const sentBefore = harness.sent.length;

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([text(continueXml())], "aborted")],
	});
	harness.streaming = false;
	await settleOnly(harness);

	// Without abort-outcome handler here, settle synthesizes missing/malformed.
	assert.match(
		harness.sent.at(-1)?.message.content ?? "",
		/previous decision response was invalid/,
	);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.sent.length, sentBefore + 1);
});

test("demotion, shutdown, stale timer, and send failures cleanly unlock", async () => {
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

	const sending = createHarness({ sendThrows: true });
	await startIdle(sending);
	sending.openDecision();
	assert.equal(sending.controller.snapshot.locked, false);

	stale.runtime.shutdown();
	assert.equal(timer.cleared, true);
});

test("external unlock after agent_end cancels pending continue before settle", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerContinue()],
	});
	const sentBefore = harness.sent.length;
	const turnsBefore = harness.triggeredTurns;

	harness.runtime.applyTransition(harness.controller.unlock(), undefined, {
		suppressNotify: true,
	});
	assert.equal(harness.controller.snapshot.locked, false);
	harness.runtime.clearOperationalPendingWork();

	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(harness.triggeredTurns, turnsBefore);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.idleTimer, null);
});

test("Examples 1-2: restart lock cycle clears an open decision, then locks and notifies once", async () => {
	const timeline: string[] = [];
	const harness = createHarness({
		onNotify: (message) => {
			timeline.push(
				`notify:${message}:locked=${harness.controller.snapshot.locked}`,
			);
		},
	});
	await startIdle(harness);
	harness.openDecision();
	harness.controller.recordInvalidDecision(1, "bad decision");
	assert.equal(harness.controller.snapshot.decisionOpen, true);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);

	await harness.runtime.restartLockCycle(harness.ctx, { notifyLocked: true });

	assert.deepEqual(timeline, ["notify:Continue watchdog locked:locked=true"]);
	assert.deepEqual(harness.notifications, [
		{ message: "Continue watchdog locked", level: undefined },
	]);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.exhausted, false);
	assert.equal(harness.controller.snapshot.decisionFailed, false);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.idleTimer?.delaySeconds, 3);
});

test("Example 2: restart from unlocked still performs silent unlock cleanup before fresh lock", async () => {
	const timeline: string[] = [];
	const harness = createHarness({
		onNotify: (message) => timeline.push(`notify:${message}`),
	});
	await startIdle(harness);
	assert.equal(harness.controller.snapshot.locked, false);

	await harness.runtime.restartLockCycle(harness.ctx, { notifyLocked: true });

	assert.deepEqual(timeline, ["notify:Continue watchdog locked"]);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.notifications, [
		{ message: "Continue watchdog locked", level: undefined },
	]);
});

test("manual lock after pending continue clears fold and rearms base idle delay", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);

	await harness.runtime.restartLockCycle(harness.ctx, { notifyLocked: true });
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.idleTimer?.delaySeconds, 3);
});

test("restart lock cycle cancels an old idle timer and reconciles one fresh base timer", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();
	const first = harness.clock.records[0];
	assert.ok(first);
	await harness.runtime.restartLockCycle(harness.ctx, { notifyLocked: true });
	assert.equal(first.cleared, true);
	assert.equal(harness.clock.records.at(-1)?.delayMs, 3000);
});

test("ordinary unlocked main agent_start silently locks; locked start preserves cycle and decision", async () => {
	const harness = createHarness();
	await startIdle(harness);
	assert.equal(harness.controller.snapshot.locked, false);

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);

	harness.streaming = false;
	await settleOnly(harness);
	const idleTimerIndex = harness.clock.records.findIndex(
		(record) => record.delayMs === 3000 && !record.cleared,
	);
	assert.ok(idleTimerIndex >= 0);
	harness.clock.fire(idleTimerIndex);
	const attemptBefore = harness.controller.snapshot.attempt;
	const decisionOpen = harness.controller.snapshot.decisionOpen;
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(harness.controller.snapshot.attempt, attemptBefore);
	assert.equal(harness.controller.snapshot.decisionOpen, decisionOpen);
});

test("false-idle settle schedules no deferred callback; later true settle reconciles", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.streaming = true;
	const before = harness.clock.records.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.clock.records.length, before);

	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.clock.records.at(-1)?.delayMs, 3000);
});

test("deferred settled wake is inert after later agent_start; next true settle works", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	const before = harness.clock.records.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	const deferred = harness.clock.records.length - 1;
	assert.ok(harness.clock.records.length > before);

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	harness.clock.fire(deferred);
	assert.equal(
		harness.sent.filter((entry) =>
			entry.message.content.includes("previous decision response was invalid"),
		).length,
		0,
	);

	harness.streaming = false;
	await settleOnly(harness);
	assert.match(
		harness.sent.at(-1)?.message.content ?? "",
		/previous decision response was invalid/,
	);
});

test("stale deferred settle is inert after later start+settle even when ctx is idle again", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.fire("agent_settled", { type: "agent_settled" });
	const firstDeferred = harness.clock.records.length - 1;

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	harness.streaming = false;
	await settleOnly(harness);
	const invalids = harness.sent.filter((entry) =>
		entry.message.content.includes("previous decision response was invalid"),
	);
	assert.equal(invalids.length, 1);

	harness.clock.fire(firstDeferred);
	assert.equal(
		harness.sent.filter((entry) =>
			entry.message.content.includes("previous decision response was invalid"),
		).length,
		1,
	);
});

test("duplicate true-idle settles schedule two wakes but only the latest acts", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();
	await harness.fire("agent_settled", { type: "agent_settled" });
	const firstDeferred = harness.clock.records.length - 1;
	await harness.fire("agent_settled", { type: "agent_settled" });
	const secondDeferred = harness.clock.records.length - 1;
	assert.notEqual(firstDeferred, secondDeferred);

	harness.clock.fire(firstDeferred);
	assert.equal(
		harness.sent.filter((entry) =>
			entry.message.content.includes("previous decision response was invalid"),
		).length,
		0,
	);
	harness.clock.fire(secondDeferred);
	assert.equal(
		harness.sent.filter((entry) =>
			entry.message.content.includes("previous decision response was invalid"),
		).length,
		1,
	);
});

test("decision settle without agent_end reasks twice then decision-fails without double count", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const sentBefore = harness.sent.length;
		harness.streaming = true;
		await harness.fire("agent_start", { type: "agent_start" });
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
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.deepEqual(harness.notifications.at(-1), {
		message:
			"Continue watchdog decision failed after 3 attempts: The decision response was malformed. End with the watchdog XML decision block.",
		level: "warning",
	});
});

test("pending valid continue keeps reconcile inert until fold delivery", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.openDecision();

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerContinue()],
	});
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
		reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"],
	};
	const hub = createObservableAgentHub();
	const clock = new FakeClock();
	const sentBy: string[] = [];

	function attach(sessionId: string, hasUI: boolean) {
		const handlers = new Map<string, Handler[]>();
		const controller = createLockDecisionController(config);
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
	assert.equal(clock.records.length, 1);
	assert.deepEqual(sentBy, []);

	await lastChild.emit("agent_settled");
	assert.equal(clock.records[1]?.delayMs, 3000);
	assert.equal(clock.records.length, 2);
	assert.deepEqual(sentBy, []);
	clock.fire(1);
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
		reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"],
	};

	function attach(sessionId: string, hasUI: boolean) {
		const handlers = new Map<string, Handler[]>();
		const holder = {
			controller: createLockDecisionController(config),
		};
		const pi = {
			on(event: string, handler: Handler): void {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			sendMessage(): void {},
			appendEntry(): void {},
		} as unknown as ExtensionAPI;
		const runtime = createDecisionRuntime({
			pi,
			hub,
			attachmentInstance: createHubAttachmentInstance(),
			controllerHolder: holder,
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
			holder,
			async start(): Promise<void> {
				for (const handler of handlers.get("session_start") ?? []) {
					await handler({ type: "session_start" } as never, ctx);
				}
			},
			async shutdown(): Promise<void> {
				for (const handler of handlers.get("session_shutdown") ?? []) {
					await handler({ type: "session_shutdown" } as never, ctx);
				}
				runtime.shutdown();
			},
		};
	}

	const first = attach("ui-1", true);
	const headless = attach("headless", false);
	await first.start();
	await headless.start();
	assert.equal(first.runtime.isCurrentMain(), true);
	assert.equal(headless.runtime.isCurrentMain(), false);

	await first.shutdown();
	// Runtime sync reclaims the remaining deterministic headless attachment.
	assert.equal(hub.snapshot.main?.sessionId, "headless");
	assert.equal(headless.runtime.isCurrentMain(), true);

	const second = attach("ui-2", true);
	await second.start();
	assert.equal(second.runtime.isCurrentMain(), true);
});

test("effective config loads before binding is reconciled and shutdown blocks late load", async () => {
	const hub = createObservableAgentHub();
	const clock = new FakeClock();
	let resolveLoad!: (value: {
		config: ContinueWatchdogConfig;
		diagnostics: [];
	}) => void;
	const loadPromise = new Promise<{
		config: ContinueWatchdogConfig;
		diagnostics: [];
	}>((resolve) => {
		resolveLoad = resolve;
	});
	const handlers = new Map<string, Handler[]>();
	const holder = {
		controller: null as ReturnType<typeof createLockDecisionController> | null,
	};
	const runtime = createDecisionRuntime({
		pi: {
			on(event: string, handler: Handler): void {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			sendMessage(): void {},
			appendEntry(): void {},
		} as unknown as ExtensionAPI,
		hub,
		attachmentInstance: createHubAttachmentInstance(),
		controllerHolder: holder,
		clock,
		loadConfig: async () => loadPromise,
	});
	runtime.registerLifecycle();
	const ctx = {
		hasUI: true,
		cwd: "/project",
		isIdle: () => true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "main" },
		ui: { notify(): void {} },
	} as unknown as ExtensionContext;

	const start = (async () => {
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ type: "session_start" } as never, ctx);
		}
	})();
	assert.equal(holder.controller, null);
	resolveLoad({
		config: {
			idleDelaySeconds: 4,
			maxRetries: 2,
			decisionPrompt: "Loaded decision.",
			continuePrompt: "Loaded continue.",
			reasonTypes: ["JOB_DONE"],
		},
		diagnostics: [],
	});
	await start;
	const loadedController = holder.controller as ReturnType<
		typeof createLockDecisionController
	> | null;
	assert.ok(loadedController);
	assert.equal(loadedController.snapshot.locked, false);
	assert.equal(runtime.config.idleDelaySeconds, 4);

	runtime.shutdown();
	assert.equal(holder.controller, null);
});
