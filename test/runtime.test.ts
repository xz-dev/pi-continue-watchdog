import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type DomainFence,
	type DomainSnapshot,
	ProcessDomainFatalError,
} from "pi-process-domain";

import {
	CONTINUE_ENTRY_TYPE,
	HUMAN_UNLOCK_ENTRY_TYPE,
	type HumanUnlockEntry,
} from "../src/commands.js";
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
import type { ProcessDomainCoordinator } from "../src/process-domain.js";
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
	aborts: number;
	pendingMessages: boolean;
	ctx: ExtensionContext;
	runtime: ReturnType<typeof createDecisionRuntime>;
	streaming: boolean;
	triggeredTurns: number;
	fire(name: string, event: unknown): Promise<void>;
	fireInput(source: string, text?: string): Promise<unknown>;
	openDecision(options?: { readonly start?: boolean }): Promise<void>;
	startDecision(): Promise<void>;
	startUnrelatedRun(message?: unknown): Promise<void>;
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

function idleDomainSnapshot(generation = 1n): DomainSnapshot {
	return {
		domainId: "domain",
		brokerEpoch: "epoch",
		revision: generation,
		activityGeneration: generation,
		participants: 1,
		busyParticipants: 0,
		pendingSpawns: 0,
		allIdle: true,
		certain: true,
		fence: { brokerEpoch: "epoch", activityGeneration: generation },
	};
}

interface PendingConfirm {
	readonly fence: DomainFence;
	resolve(value: boolean): void;
}

function createFenceHarness(options?: {
	readonly reject?: "markBusy" | "markIdle" | "setInternalDecision";
}) {
	let snapshot = idleDomainSnapshot();
	let confirmResult = true;
	let deferred = false;
	const pendingConfirms: PendingConfirm[] = [];
	const internalDecisionMarks: boolean[] = [];
	const listeners = new Set<
		(value: DomainSnapshot, source: "local" | "domain") => void
	>();
	const domain: ProcessDomainCoordinator = {
		get snapshot() {
			return snapshot;
		},
		isRootProcess: true,
		async attach() {},
		async markBusy(_instance, markOptions) {
			if (options?.reject === "markBusy") throw new Error("markBusy failed");
			internalDecisionMarks.push(markOptions?.internalDecision ?? false);
		},
		async markIdle() {
			if (options?.reject === "markIdle") throw new Error("markIdle failed");
		},
		async setInternalDecision(_instance, internal) {
			if (options?.reject === "setInternalDecision") {
				throw new Error("setInternalDecision failed");
			}
			internalDecisionMarks.push(internal);
		},
		confirm(fence: DomainFence) {
			if (deferred) {
				return new Promise<boolean>((resolve) => {
					pendingConfirms.push({ fence, resolve });
				});
			}
			return confirmResult;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async detach() {},
	};
	return {
		domain,
		internalDecisionMarks,
		failConfirm(): void {
			confirmResult = false;
		},
		deferConfirm(): void {
			deferred = true;
		},
		setDeferred(value: boolean): void {
			deferred = value;
		},
		pendingConfirmCount(): number {
			return pendingConfirms.length;
		},
		resolvePendingConfirm(value: boolean): void {
			const pending = pendingConfirms.shift();
			assert.ok(pending, "expected a pending fence confirm");
			pending.resolve(value);
		},
		advanceFence(notify = true): void {
			snapshot = idleDomainSnapshot(snapshot.activityGeneration + 1n);
			if (notify) {
				for (const listener of listeners) listener(snapshot, "domain");
			}
		},
	};
}

function createHarness(options?: {
	readonly config?: Partial<ContinueWatchdogConfig>;
	readonly sendThrows?: boolean;
	readonly fatalExit?: import("../src/fatal-exit.js").FatalExitAdapter;
	readonly onSend?: (message: SentMessage["message"]) => Error | undefined;
	readonly appendThrows?: boolean | string;
	readonly onAppend?: (type: string) => void;
	readonly hasUI?: boolean;
	readonly onNotify?: (message: string) => void;
	readonly processDomain?: ProcessDomainCoordinator;
	readonly isIdle?: () => boolean;
	readonly wouldTriggerAutoCompaction?: (content: string) => boolean;
	readonly onCompact?: (options: {
		readonly onComplete?: () => void;
		readonly onError?: (error: Error) => void;
	}) => void;
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
	const aborts = 0;
	let runtime: ReturnType<typeof createDecisionRuntime>;
	let decisionStarted = false;
	let startedDecisionDetails: unknown = null;

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
		aborts,
		pendingMessages: false,
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
			if (options?.onSend) {
				const result = options.onSend(message);
				if (result instanceof Error) throw result;
			}
			if (options?.sendThrows) throw new Error("send failed");
			sent.push({
				message,
				options: sendOptions,
				streaming: harness.streaming,
			});
			if (
				message.customType === DECISION_MESSAGE_TYPE &&
				startedDecisionDetails !== message.details
			)
				decisionStarted = false;
			if (sendOptions?.triggerTurn && !harness.streaming) {
				harness.triggeredTurns += 1;
			}
		},
		appendEntry(type: string, data: HumanUnlockEntry): void {
			options?.onAppend?.(type);
			if (options?.appendThrows === true || options?.appendThrows === type) {
				throw new Error("append failed");
			}
			entries.push({ type, data });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: options?.hasUI ?? true,
		cwd: "/project",
		isIdle: () => options?.isIdle?.() ?? !harness.streaming,
		hasPendingMessages: () => harness.pendingMessages,
		wouldTriggerAutoCompaction: (content: string) =>
			options?.wouldTriggerAutoCompaction?.(content) ?? false,
		compact: (compactOptions: {
			onComplete?: () => void;
			onError?: (error: Error) => void;
		}) => options?.onCompact?.(compactOptions),
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
		abort(): void {
			harness.aborts += 1;
		},
	} as unknown as ExtensionContext;

	runtime = createDecisionRuntime({
		pi,
		hub,
		processDomain: options?.processDomain,
		fatalExit: options?.fatalExit,
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
		if (name === "message_start") {
			await runtime.handleMessageStart(event as { readonly message: unknown });
		}
		for (const handler of handlers.get(name) ?? []) {
			await handler(event as never, ctx);
		}
	};
	harness.fireInput = async (source, text = "user message") => {
		let result: unknown;
		for (const handler of handlers.get("input") ?? []) {
			result = await handler(
				{ type: "input", text, source, images: undefined } as never,
				ctx,
			);
		}
		return result;
	};
	harness.openDecision = async (openOptions) => {
		const sentBefore = harness.sent.length;
		runtime.applyTransition(controller.lock(), undefined, {
			suppressNotify: true,
		});
		runtime.reconcileIdle();
		clock.fire(clock.records.length - 1);
		if (
			openOptions?.start !== false &&
			harness.sent.length > sentBefore &&
			harness.sent.at(-1)?.message.customType === DECISION_MESSAGE_TYPE
		) {
			await harness.startDecision();
		}
	};
	harness.startDecision = async () => {
		if (decisionStarted) return;
		harness.streaming = true;
		await harness.fire("agent_start", { type: "agent_start" });
		const decision = [...harness.sent]
			.reverse()
			.find((entry) => entry.message.customType === DECISION_MESSAGE_TYPE);
		assert.ok(decision, "expected a dispatched watchdog decision");
		await harness.fire("message_start", {
			type: "message_start",
			message: {
				role: "custom",
				customType: decision.message.customType,
				content: [{ type: "text", text: decision.message.content }],
				display: decision.message.display,
				details: decision.message.details,
				timestamp: Date.now(),
			},
		});
		startedDecisionDetails = decision.message.details;
		decisionStarted = true;
	};
	harness.startUnrelatedRun = async (
		message = {
			role: "user",
			content: [text("unrelated user work")],
			timestamp: Date.now(),
		},
	) => {
		harness.streaming = true;
		await harness.fire("agent_start", { type: "agent_start" });
		await harness.fire("message_start", { type: "message_start", message });
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

function fatalSpy() {
	const errors: Error[] = [];
	return {
		errors,
		adapter: {
			fail(error: Error): void {
				errors.push(error);
			},
			completeShutdown(): void {},
		} satisfies import("../src/fatal-exit.js").FatalExitAdapter,
	};
}

function lifecycleDomain(options?: {
	readonly attachError?: Error;
	readonly emitAttachErrorBeforeReject?: boolean;
}) {
	let onFatal: ((error: Error) => void) | null = null;
	const base = createFenceHarness();
	const domain: ProcessDomainCoordinator = {
		...base.domain,
		async attach(_instance, attachOptions) {
			onFatal = attachOptions.onFatal;
			if (options?.attachError !== undefined) {
				if (options.emitAttachErrorBeforeReject) onFatal(options.attachError);
				throw options.attachError;
			}
		},
	};
	return {
		domain,
		emitFatal(error: Error): void {
			assert.ok(
				onFatal,
				"process domain must be attached before runtime failure",
			);
			onFatal(error);
		},
	};
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
	await harness.startDecision();
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

test("watchdog decision leaves compaction entirely to the host", async () => {
	let predicted = 0;
	let compacted = 0;
	const harness = createHarness({
		wouldTriggerAutoCompaction: () => {
			predicted += 1;
			return true;
		},
		onCompact: () => {
			compacted += 1;
		},
	});
	await startIdle(harness);
	await harness.openDecision();

	assert.equal(predicted, 0);
	assert.equal(compacted, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, true);
	assert.equal(harness.sent[0]?.message.customType, DECISION_MESSAGE_TYPE);
});

test("maximum configured decision prompt still opens and re-asks with generated XML suffix", async () => {
	const configuredPrompt = "x".repeat(MAX_PROMPT_CHARACTERS);
	const harness = createHarness({
		config: { decisionPrompt: configuredPrompt },
	});
	await startIdle(harness);
	await harness.openDecision();

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
	const activeTimer = harness.clock.records.at(-1);
	const timersAfterBind = harness.clock.records.length;
	assert.ok(activeTimer);

	harness.hub.markBusy(child);
	assert.equal(activeTimer.cleared, true);
	activeTimer.callback();
	assert.equal(harness.clock.records.length, timersAfterBind);
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
	const activeTimer = harness.clock.records.at(-1);
	const timersAfterBind = harness.clock.records.length;
	assert.ok(activeTimer);

	harness.hub.markBusy(child);
	assert.equal(activeTimer.cleared, true);
	harness.hub.markIdle(child);
	assert.equal(harness.clock.records.length, timersAfterBind + 1);
	assert.equal(harness.clock.records.at(-1)?.delayMs, 3000);
});

test("agent_end finalizes while streaming but settled alone dispatches continue", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	assert.deepEqual(harness.entries, []);
	assert.equal(harness.widgets.at(-1)?.key, "pi-continue-watchdog:status");
	assert.notEqual(harness.widgets.at(-1)?.value, undefined);
	const before = harness.sent.length;
	const turnsBefore = harness.triggeredTurns;

	await harness.startDecision();
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

test("continue entry persistence failure does not cancel an already dispatched continuation", async () => {
	const harness = createHarness({
		appendThrows: "pi-continue-watchdog:continue",
	});
	await startIdle(harness);
	await harness.openDecision();
	const sentBefore = harness.sent.length;

	await settleResponse(harness, harness.answerContinue());

	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.sent.length, sentBefore + 1);
	assert.equal(harness.triggeredTurns, 2);
	assert.deepEqual(harness.entries, []);
});

test("decision message_end hides XML, persists a context-excluded audit, and finalizes from the captured response", async () => {
	const harness = createHarness();
	await startIdle(harness);
	const answer = harness.answerUnlock("Waiting for approval.", "WAIT_USER");

	assert.equal(await harness.endDecisionMessage(answer), undefined);
	assert.deepEqual(harness.entries, []);

	await harness.openDecision();
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

	// The decision prompt itself already caused agent_start. At this point the
	// finalized replacement belongs to that submitted run; do not synthesize a
	// second start after message_end reset the submission phase.
	harness.streaming = true;
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
	await harness.openDecision();

	await harness.startDecision();
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
	await harness.openDecision();

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
	await harness.openDecision();
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
	await harness.openDecision();
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

	await harness.openDecision();
	assert.deepEqual(await harness.blockToolCall(), {
		block: true,
		reason: DECISION_TOOL_BLOCK_REASON,
	});

	await settleResponse(harness, harness.answerContinue());
	assert.equal(await harness.blockToolCall(), undefined);
});

test("continued settle rearms the fixed delay once and exhausts at max", async () => {
	const harness = createHarness({ config: { maxRetries: 2 } });
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	harness.streaming = false;
	await settleOnly(harness);
	const secondTimer = harness.clock.records.findIndex(
		(record, index) => index > 0 && record.delayMs === 3000 && !record.cleared,
	);
	assert.ok(secondTimer >= 0);
	harness.clock.fire(secondTimer);
	await settleResponse(harness, harness.answerContinue());

	assert.equal(harness.controller.snapshot.exhausted, true);
	assert.equal(harness.controller.snapshot.attempt, 2);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
});

test("valid unlock folds without a turn and leaves one compact persisted result", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
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
	await harness.openDecision();
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
	await harness.openDecision();

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const sentBefore = harness.sent.length;
		await harness.startDecision();
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
	await harness.openDecision();
	const sentBefore = harness.sent.length;

	await harness.startDecision();
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
	await harness.openDecision();

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
	assert.equal(harness.controller.snapshot.decisionOpen, false);
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
	await harness.openDecision();
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
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(
		harness.clock.records.some(
			(record) => record.delayMs === 3000 && !record.cleared,
		),
		true,
	);
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
	await harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);

	await harness.runtime.restartLockCycle(harness.ctx, { notifyLocked: true });
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.clock.records.at(-1)?.delayMs, 3000);
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
	await harness.openDecision();
	harness.streaming = false;
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
	await harness.openDecision();
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
	await harness.openDecision();
	await harness.startDecision();
	harness.streaming = false;
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
	await harness.openDecision();

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const sentBefore = harness.sent.length;
		await harness.startDecision();
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

test("stale fenced valid continue does not consume retry or exhaust", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({
		config: { maxRetries: 1 },
		processDomain: fence.domain,
	});
	await startIdle(harness);
	await harness.openDecision();
	await Promise.resolve();
	await Promise.resolve();
	await harness.endDecisionMessage(harness.answerContinue());
	fence.failConfirm();
	fence.advanceFence(false);
	await settleOnly(harness);

	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.exhausted, false);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(
		harness.sent.filter(
			(entry) => entry.message.customType === DECISION_FOLD_MESSAGE_TYPE,
		).length,
		0,
	);
});

test("domain uncertainty before unlock delivery defers the typed unlock", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	await Promise.resolve();
	await Promise.resolve();
	await harness.endDecisionMessage(harness.answerUnlock("wait", "WAIT_USER"));
	fence.advanceFence(true);
	await settleOnly(harness);

	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(
		harness.entries.some((entry) => entry.type === HUMAN_UNLOCK_ENTRY_TYPE),
		false,
	);
});

test("stale fenced valid unlock does not unlock", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	await Promise.resolve();
	await Promise.resolve();
	await harness.endDecisionMessage(harness.answerUnlock());
	fence.failConfirm();
	fence.advanceFence(false);
	await settleOnly(harness);

	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(
		harness.entries.some((entry) => entry.type === HUMAN_UNLOCK_ENTRY_TYPE),
		false,
	);
});

test("stale fenced third invalid response preserves counts and permits retry", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	await Promise.resolve();
	await Promise.resolve();

	await settleResponse(harness, harness.answerInvalid());
	await settleResponse(harness, harness.answerInvalid());
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 2);

	await harness.endDecisionMessage(harness.answerInvalid());
	fence.failConfirm();
	fence.advanceFence(false);
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 2);
	assert.equal(harness.controller.snapshot.decisionFailed, false);
	assert.equal(harness.controller.snapshot.locked, true);

	// A later idle epoch remains eligible for a fresh decision attempt.
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records.at(-1)?.delayMs, 3000);
});

test("pending valid continue keeps reconcile inert until fold delivery", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerContinue()],
	});
	const timersAfterEnd = harness.clock.records.length;
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records.length, timersAfterEnd);
	assert.equal(harness.controller.snapshot.decisionOpen, true);

	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.equal(
		harness.clock.records.some(
			(record) => record.delayMs === 3000 && !record.cleared,
		),
		true,
	);
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
	runtime.applyTransition(loadedController.lock(), undefined, {
		suppressNotify: true,
	});
	runtime.reconcileIdle();
	assert.equal(clock.records.at(-1)?.delayMs, 4000);

	runtime.shutdown();
	assert.equal(holder.controller, null);
});

test("local Pi busy before idle timer callback defers; next true settle rearms", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();
	const timer = harness.clock.records.at(-1);
	assert.ok(timer);
	assert.equal(timer.delayMs, 3000);

	// Local Pi becomes busy without any hub/domain edge (smallest scheduling window).
	harness.streaming = true;
	harness.clock.fire(harness.clock.records.length - 1);

	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.locked, true);

	// Next genuine true-idle settle re-arms and a fresh decision is sent.
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.sent.length, 0);
	const rearmed = [...harness.clock.records]
		.reverse()
		.find((record) => record.delayMs === 3000 && !record.cleared);
	assert.ok(rearmed);
	assert.equal(rearmed.delayMs, 3000);
	assert.equal(rearmed.cleared, false);

	// Let the freshly re-armed watchdog dispatch before supplying its response.
	harness.clock.fire(harness.clock.records.indexOf(rearmed));
	assert.equal(harness.sent.length, 1);
	await harness.startDecision();
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerContinue()],
	});
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.attempt, 1);
});

test("observed pending input invalidates grace and clearing starts a fresh full grace", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();
	const firstGrace = harness.clock.records.length - 1;
	assert.equal(harness.clock.records[firstGrace]?.delayMs, 3000);

	harness.pendingMessages = true;
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records[firstGrace]?.cleared, true);

	harness.pendingMessages = false;
	harness.runtime.reconcileIdle();
	const secondGrace = harness.clock.records.length - 1;
	assert.notEqual(secondGrace, firstGrace);
	assert.equal(harness.clock.records[secondGrace]?.delayMs, 3000);
	harness.clock.records[firstGrace]?.callback();
	assert.equal(harness.sent.length, 0);

	harness.clock.fire(secondGrace);
	assert.equal(harness.sent.length, 1);
});

test("pending input appearing at grace expiry blocks dispatch until a fresh full grace", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();
	const firstGrace = harness.clock.records.length - 1;

	harness.pendingMessages = true;
	harness.clock.fire(firstGrace);
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);

	harness.pendingMessages = false;
	harness.runtime.reconcileIdle();
	const secondGrace = harness.clock.records.length - 1;
	assert.notEqual(secondGrace, firstGrace);
	assert.equal(harness.clock.records[secondGrace]?.delayMs, 3000);
});

test("rejected grace-expiry fence starts no decision and waits for a fresh generation", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	fence.failConfirm();
	harness.runtime.reconcileIdle();
	harness.clock.fire(harness.clock.records.length - 1);
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.attempt, 0);

	fence.advanceFence();
	const rearmed = [...harness.clock.records]
		.reverse()
		.find((record) => record.delayMs === 3000 && !record.cleared);
	assert.ok(rearmed);
});

test("stale rejected grace qualification leaves the newer generation deadline unchanged", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	fence.deferConfirm();
	harness.runtime.reconcileIdle();
	harness.clock.fire(harness.clock.records.length - 1);
	assert.equal(fence.pendingConfirmCount(), 1);

	fence.advanceFence();
	const newerTimer = harness.clock.records.at(-1);
	const timersBeforeStaleRejection = harness.clock.records.length;
	assert.ok(newerTimer);
	assert.equal(newerTimer.delayMs, 3000);
	assert.equal(newerTimer.cleared, false);

	fence.resolvePendingConfirm(false);
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(harness.clock.records.length, timersBeforeStaleRejection);
	assert.equal(newerTimer.cleared, false);
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
});

test("domain generation change during grace qualification makes the old callback inert", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	fence.deferConfirm();
	harness.runtime.reconcileIdle();
	harness.clock.fire(harness.clock.records.length - 1);
	assert.equal(fence.pendingConfirmCount(), 1);

	fence.advanceFence();
	fence.resolvePendingConfirm(true);
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	const rearmed = [...harness.clock.records]
		.reverse()
		.find((record) => record.delayMs === 3000 && !record.cleared);
	assert.ok(rearmed);
});

test("local Pi busy during deferred initial fence confirm defers without consuming attempts", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	fence.deferConfirm();
	harness.runtime.reconcileIdle();
	harness.clock.fire(harness.clock.records.length - 1);
	assert.equal(fence.pendingConfirmCount(), 1);
	assert.equal(harness.sent.length, 0);

	// Local Pi becomes busy while the fence confirm is in flight.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	fence.resolvePendingConfirm(true);
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.decisionFailed, false);
	assert.equal(harness.controller.snapshot.exhausted, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(
		harness.entries.some(
			(entry) =>
				entry.type === "pi-continue-watchdog:status" &&
				(entry.data as { kind?: string }).kind !== undefined,
		),
		false,
	);

	// The unrelated run's response must not be captured as the decision answer.
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerContinue()],
	});
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.sent.length, 0);
	const rearmed = [...harness.clock.records]
		.reverse()
		.find((record) => record.delayMs === 3000 && !record.cleared);
	assert.ok(rearmed);
	assert.equal(rearmed.delayMs, 3000);
});

test("timer confirm busy race clears intent and waits for the next full idle delay", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();
	const timer = harness.clock.records.at(-1);
	assert.ok(timer);
	fence.deferConfirm();
	harness.clock.fire(harness.clock.records.length - 1);
	assert.equal(fence.pendingConfirmCount(), 1);

	harness.streaming = true;
	fence.resolvePendingConfirm(true);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.locked, true);

	harness.streaming = false;
	await settleOnly(harness);
	const rearmed = [...harness.clock.records]
		.reverse()
		.find((record) => record.delayMs === 3000 && !record.cleared);
	assert.ok(rearmed);
	assert.equal(harness.controller.snapshot.attempt, 0);
});

test("provisional decision during confirm is not marked internal when an unrelated run starts", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	fence.deferConfirm();
	harness.runtime.reconcileIdle();
	harness.clock.fire(harness.clock.records.length - 1);
	assert.equal(fence.pendingConfirmCount(), 1);

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	// The unrelated run must not be branded an internal watchdog decision.
	assert.deepEqual(fence.internalDecisionMarks, [false]);

	fence.resolvePendingConfirm(true);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.locked, true);
});

test("pending decision agent_start is provisionally internal until message correlation", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision({ start: false });
	await Promise.resolve();
	await Promise.resolve();

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	assert.deepEqual(fence.internalDecisionMarks, [true]);
	assert.equal(harness.controller.snapshot.decisionOpen, true);

	await harness.fire("message_start", {
		type: "message_start",
		message: {
			role: "user",
			content: [text("foreign run")],
			timestamp: Date.now(),
		},
	});
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.locked, true);
});

test("re-ask delivery that races local busy does not consume another attempt", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	await Promise.resolve();
	await Promise.resolve();
	// Commit attempt 1 and enter re-ask delivery while still idle.
	await settleResponse(harness, harness.answerInvalid());
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.match(
		harness.sent.at(-1)?.message.content ?? "",
		/previous decision response was invalid/,
	);

	// Second invalid response: hold the re-ask delivery confirm in flight.
	fence.deferConfirm();
	const sentBefore = harness.sent.length;
	await harness.startDecision();
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerInvalid()],
	});
	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	const deferredSettle = harness.clock.records.length - 1;
	assert.equal(harness.clock.records[deferredSettle]?.delayMs, 0);
	harness.clock.fire(deferredSettle);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(fence.pendingConfirmCount(), 1);

	// Local Pi becomes busy while the re-ask confirm is pending; resolve stale true.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	fence.resolvePendingConfirm(true);
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.controller.snapshot.decisionFailed, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(
		harness.sent.filter((entry) =>
			entry.message.content.includes("previous decision response was invalid"),
		).length,
		1,
	);

	// A later true-idle settle can start a fresh decision.
	harness.streaming = false;
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerContinue()],
	});
	await settleOnly(harness);
	const rearmed = [...harness.clock.records]
		.reverse()
		.find((record) => record.delayMs === 3000 && !record.cleared);
	assert.ok(rearmed);
	assert.equal(rearmed.delayMs, 3000);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.locked, true);
});

test("accepted continue busy races roll back retry and defer without unlocking", async () => {
	const fence = createFenceHarness();
	const duringConfirm = createHarness({ processDomain: fence.domain });
	await startIdle(duringConfirm);
	await duringConfirm.openDecision();
	await Promise.resolve();
	await Promise.resolve();
	fence.deferConfirm();
	await duringConfirm.startDecision();
	await duringConfirm.fire("agent_end", {
		type: "agent_end",
		messages: [duringConfirm.answerContinue()],
	});
	duringConfirm.streaming = false;
	await duringConfirm.fire("agent_settled", { type: "agent_settled" });
	const deferred = duringConfirm.clock.records.length - 1;
	duringConfirm.clock.fire(deferred);
	await Promise.resolve();
	await Promise.resolve();
	// deliverPending first performs the common finalization fence, then the
	// accepted-continuation fence under test.
	assert.equal(fence.pendingConfirmCount(), 1);
	fence.resolvePendingConfirm(true);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(fence.pendingConfirmCount(), 1);
	duringConfirm.streaming = true;
	fence.resolvePendingConfirm(true);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(duringConfirm.controller.snapshot.attempt, 0);
	assert.equal(duringConfirm.controller.snapshot.locked, true);
	assert.equal(duringConfirm.triggeredTurns, 1);

	let sendBusy = false;
	const atSend = createHarness({
		isIdle: () => !sendBusy,
		onSend(message) {
			if (message.customType === DECISION_FOLD_MESSAGE_TYPE) {
				sendBusy = true;
				return new Error("busy");
			}
			return undefined;
		},
	});
	await startIdle(atSend);
	atSend.openDecision();
	await settleResponse(atSend, atSend.answerContinue());
	assert.equal(atSend.controller.snapshot.attempt, 0);
	assert.equal(atSend.controller.snapshot.locked, true);
	assert.equal(
		atSend.entries.filter(
			(entry) =>
				entry.type === "pi-continue-watchdog:status" ||
				entry.type === CONTINUE_ENTRY_TYPE,
		).length,
		0,
	);
});

test("real user input silently preempts a submitted decision and extension input stays inert", async () => {
	for (const source of ["interactive", "rpc"] as const) {
		const harness = createHarness();
		await startIdle(harness);
		await harness.openDecision();
		await harness.startDecision();
		assert.equal(harness.controller.snapshot.decisionOpen, true);
		assert.equal(harness.aborts, 0);

		assert.deepEqual(await harness.fireInput(source), { action: "continue" });
		assert.equal(harness.aborts, 1);
		assert.equal(harness.controller.snapshot.locked, true);
		assert.equal(harness.controller.snapshot.decisionOpen, false);
		assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);

		const replacement = (await harness.endDecisionMessage(
			assistant([], "aborted"),
		)) as DecisionMessageReplacement;
		assert.deepEqual(replacement.message.content, []);
		assert.equal(
			(replacement.message as { stopReason?: string }).stopReason,
			"stop",
		);
		assert.equal(harness.runtime.consumeDecisionAbortSuppression(), true);
		assert.equal(harness.runtime.consumeDecisionAbortSuppression(), false);
		assert.deepEqual(harness.notifications, []);
	}

	const extension = createHarness();
	await startIdle(extension);
	extension.openDecision();
	await extension.startDecision();
	assert.equal(await extension.fireInput("extension"), undefined);
	assert.equal(extension.aborts, 0);
	assert.equal(extension.controller.snapshot.decisionOpen, true);
});

test("provider retry agent_start preserves a confirmed internal decision classification", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	await Promise.resolve();
	await Promise.resolve();
	await harness.startDecision();
	const confirmedMarks = [...fence.internalDecisionMarks];
	assert.equal(confirmedMarks.at(-1), true);
	assert.equal(harness.controller.snapshot.decisionOpen, true);

	await harness.fire("agent_start", { type: "agent_start" });

	assert.deepEqual(fence.internalDecisionMarks, [...confirmedMarks, true]);
	assert.equal(harness.controller.snapshot.decisionOpen, true);
});

test("agent_end before correlated message_start defers a ghost decision without re-ask", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision({ start: false });
	assert.equal(harness.sent.length, 1);

	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerInvalid()],
	});

	assert.equal(
		harness.sent.filter((entry) =>
			entry.message.content.includes("previous decision response was invalid"),
		).length,
		0,
	);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.locked, true);
});

test("fire-and-forget ghost decision send is deferred instead of becoming a malformed re-ask", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision({ start: false });
	assert.equal(harness.sent.length, 1);

	// Production Pi's public sendMessage returns before its triggerTurn can reject
	// as busy. The racing user run emits agent_start, but its public message_start
	// does not match the watchdog exchange and therefore defers the ghost send.
	await harness.startUnrelatedRun();
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerContinue()],
	});
	harness.streaming = false;
	await settleOnly(harness);

	assert.equal(
		harness.sent.filter((entry) =>
			entry.message.content.includes("previous decision response was invalid"),
		).length,
		0,
	);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.decisionFailed, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(
		harness.entries.some(
			(entry) =>
				entry.type === "pi-continue-watchdog:status" &&
				((entry.data as { kind?: string }).kind === "validation-error" ||
					(entry.data as { kind?: string }).kind === "decision-failed"),
		),
		false,
	);
});

test("send-time busy TOCTOU defers silently; idle send failure still fail-closed", async () => {
	// Busy at the final send boundary: the hook flips local idle and throws the
	// stock busy error; the watchdog must defer without unlock or error cards.
	let busyHookStreaming = false;
	const busy = createHarness({
		isIdle: () => !busyHookStreaming,
		onSend(message) {
			if (message.customType === DECISION_MESSAGE_TYPE) {
				busyHookStreaming = true;
				return new Error(
					"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
				);
			}
			return undefined;
		},
	});
	await startIdle(busy);
	busy.runtime.applyTransition(busy.controller.lock(), undefined, {
		suppressNotify: true,
	});
	busy.runtime.reconcileIdle();
	const timer = busy.clock.records.at(-1);
	assert.ok(timer);
	busy.clock.fire(busy.clock.records.length - 1);

	assert.equal(busy.sent.length, 0);
	assert.equal(busy.controller.snapshot.decisionOpen, false);
	assert.equal(busy.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(busy.controller.snapshot.locked, true);
	assert.equal(
		busy.entries.filter(
			(entry) =>
				entry.type === "pi-continue-watchdog:status" &&
				(entry.data as { kind?: string }).kind === "other-error",
		).length,
		0,
	);

	// Genuine idle send failure keeps the existing fail-closed unlock behavior.
	const idle = createHarness({ sendThrows: true });
	await startIdle(idle);
	idle.runtime.applyTransition(idle.controller.lock(), undefined, {
		suppressNotify: true,
	});
	idle.runtime.reconcileIdle();
	const idleTimer = idle.clock.records.at(-1);
	assert.ok(idleTimer);
	idle.clock.fire(idle.clock.records.length - 1);
	assert.equal(idle.controller.snapshot.locked, false);
	assert.equal(
		idle.entries.some(
			(entry) =>
				entry.type === "pi-continue-watchdog:status" &&
				(entry.data as { kind?: string }).kind === "other-error",
		),
		true,
	);
});

test("runtime process-domain write rejection disables watchdog without escaping", async () => {
	for (const operation of [
		"markBusy",
		"markIdle",
		"setInternalDecision",
	] as const) {
		const fence = createFenceHarness({ reject: operation });
		const harness = createHarness({ processDomain: fence.domain });
		await startIdle(harness);

		if (operation === "markBusy") {
			harness.streaming = true;
			await harness.fire("agent_start", { type: "agent_start" });
		} else if (operation === "markIdle") {
			harness.streaming = true;
			await harness.fire("agent_start", { type: "agent_start" });
			harness.streaming = false;
			await harness.fire("agent_settled", { type: "agent_settled" });
		} else {
			await harness.openDecision({ start: false });
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(harness.sent.length, 1);
			await harness.startDecision();
		}

		const timersAfterFailure = harness.clock.records.length;
		harness.runtime.reconcileIdle();
		if (operation === "setInternalDecision") {
			assert.equal(harness.controller.snapshot.decisionOpen, false);
			assert.equal(harness.aborts, 1);
			assert.deepEqual(await harness.blockToolCall(), {
				block: true,
				reason: DECISION_TOOL_BLOCK_REASON,
			});
			const replacement = (await harness.endDecisionMessage(
				assistant([text("untrusted failed-domain output")]),
			)) as DecisionMessageReplacement;
			assert.deepEqual(replacement.message.content, []);
			assert.equal(
				harness.sent.at(-1)?.message.customType,
				DECISION_FOLD_MESSAGE_TYPE,
			);
			await harness.fire("agent_end", {
				type: "agent_end",
				messages: [assistant([], "aborted")],
			});
			assert.deepEqual(await harness.blockToolCall(), {
				block: true,
				reason: DECISION_TOOL_BLOCK_REASON,
			});
			harness.streaming = false;
			await harness.fire("agent_settled", { type: "agent_settled" });
			assert.equal(await harness.blockToolCall(), undefined);
		}
		assert.equal(harness.clock.records.length, timersAfterFailure);
	}
});

test("initial process-domain authentication failure exits this watchdog instance", async () => {
	const fatal = fatalSpy();
	const domain = lifecycleDomain({
		attachError: new ProcessDomainFatalError(
			"AUTHENTICATION_FAILED",
			"wrong key",
		),
		emitAttachErrorBeforeReject: true,
	});
	const harness = createHarness({
		processDomain: domain.domain,
		fatalExit: fatal.adapter,
	});

	await startIdle(harness);
	assert.equal(fatal.errors.length, 1);
	assert.equal(
		(fatal.errors[0] as ProcessDomainFatalError).code,
		"AUTHENTICATION_FAILED",
	);
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records.length, 0);
});

test("initial non-auth process-domain failure disables watchdog without exiting Pi", async () => {
	const fatal = fatalSpy();
	const domain = lifecycleDomain({
		attachError: new ProcessDomainFatalError("LEASE_REJECTED", "join rejected"),
	});
	const harness = createHarness({
		processDomain: domain.domain,
		fatalExit: fatal.adapter,
	});

	await startIdle(harness);
	assert.equal(fatal.errors.length, 0);
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records.length, 0);
});

test("runtime lease rejection disables watchdog without exiting Pi", async () => {
	const fatal = fatalSpy();
	const domain = lifecycleDomain();
	const harness = createHarness({
		processDomain: domain.domain,
		fatalExit: fatal.adapter,
	});
	await startIdle(harness);

	domain.emitFatal(
		new ProcessDomainFatalError(
			"LEASE_REJECTED",
			"participant lease is not current",
		),
	);
	assert.equal(fatal.errors.length, 0);
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records.length, 0);
});

test("runtime authentication failure after attach never exits Pi", async () => {
	const fatal = fatalSpy();
	const domain = lifecycleDomain();
	const harness = createHarness({
		processDomain: domain.domain,
		fatalExit: fatal.adapter,
	});
	await startIdle(harness);

	domain.emitFatal(
		new ProcessDomainFatalError(
			"AUTHENTICATION_FAILED",
			"runtime reconnect rejected",
		),
	);
	assert.equal(fatal.errors.length, 0);
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records.length, 0);
});
