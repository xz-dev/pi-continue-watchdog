import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

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
	createDecisionFoldMessage,
	createDecisionPromptMessage,
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_MESSAGE_TYPE,
	findDecisionAssistantEntryId,
	foldDecisionContext,
	INQUIRY_MARKER_ENTRY_TYPE,
	neutralizeDecisionAssistant,
} from "../src/context-fold.js";
import { createLockDecisionController } from "../src/controller.js";
import { DECISION_TOOL_BLOCK_REASON } from "../src/decision-protocol.js";
import {
	createHubAttachmentInstance,
	createObservableAgentHub,
} from "../src/hub.js";
import {
	type DomainFence,
	type DomainSnapshot,
	type ProcessDomainCoordinator,
	ProcessDomainFatalError,
} from "../src/process-domain.js";
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

interface DecisionMessageReplacement {
	readonly message: {
		readonly role: "assistant";
		readonly content: readonly unknown[];
		readonly stopReason?: string;
		readonly errorMessage?: string;
	};
}

interface SentMessage {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details: unknown;
	};
	options?: {
		triggerTurn?: boolean;
		deliverAs?: string;
		presentation?: "visible" | "hidden";
	};
	streaming: boolean;
}

interface BranchEntry {
	readonly id: string;
	readonly type: "custom" | "custom_message" | "message";
	readonly customType?: string;
	readonly data?: unknown;
	readonly details?: unknown;
	readonly message?: {
		readonly role: "assistant";
	};
}

interface Harness {
	readonly handlers: Map<string, Handler[]>;
	readonly handlerOptions: Map<string, unknown[]>;
	readonly clock: FakeClock;
	readonly widgets: Array<{ key: string; value: unknown }>;
	readonly widgetPlacements: Map<string, string | undefined>;
	readonly config: ContinueWatchdogConfig;
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly hub: ReturnType<typeof createObservableAgentHub>;
	readonly sent: SentMessage[];
	readonly notifications: Array<{ message: string; level?: string }>;
	readonly entries: Array<{ type: string; data: unknown }>;
	readonly branch: BranchEntry[];
	readonly spliceAttempts: string[];
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

function continueXml(
	reasonType = "WORK_REMAINS",
	reason = "Implementation work remains.",
): string {
	return `<watchdog><function>continue_watchdog</function><reason_type>${reasonType}</reason_type><reason_content>${reason}</reason_content></watchdog>`;
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
		domainEpoch: "epoch",
		activityGeneration: generation,
		busyParticipants: 0,
		allIdle: true,
		fence: { domainEpoch: "epoch", activityGeneration: generation },
	};
}

interface PendingConfirm {
	readonly fence: DomainFence;
	resolve(value: boolean): void;
}

function createFenceHarness(options?: { readonly rejectReport?: boolean }) {
	let snapshot = idleDomainSnapshot();
	let rejectReport = options?.rejectReport === true;
	let confirmResult = true;
	let deferred = false;
	const pendingConfirms: PendingConfirm[] = [];
	const reportedIdle: boolean[] = [];
	const listeners = new Set<
		(value: DomainSnapshot, source: "local" | "domain") => void
	>();
	const domain: ProcessDomainCoordinator = {
		get snapshot() {
			return snapshot;
		},
		isRootProcess: true,
		async attach() {},
		async reportIdle(_instance, idle) {
			reportedIdle.push(idle);
			if (!rejectReport) return;
			rejectReport = false;
			throw new Error("reportIdle failed");
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
		reportedIdle,
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
		setBusyParticipants(count: number, notify = true): void {
			const generation = snapshot.activityGeneration + 1n;
			snapshot = {
				...idleDomainSnapshot(generation),
				busyParticipants: count,
				allIdle: count === 0,
			};
			if (notify) {
				for (const listener of listeners) listener(snapshot, "domain");
			}
		},
		recover(): void {
			snapshot = idleDomainSnapshot(snapshot.activityGeneration + 1n);
			for (const listener of listeners) listener(snapshot, "domain");
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
	readonly spliceBehavior?: "success" | "false" | "throw" | "absent";
	readonly branchThrows?: boolean;
	readonly appendUnrelatedAssistantBeforeFold?: boolean;
	readonly hasUI?: boolean;
	readonly mode?: "tui" | "rpc" | "json" | "print";
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
		continueReasonTypes: options?.config?.continueReasonTypes ?? [
			"WORK_REMAINS",
			"VERIFYING",
			"WAIT_AUTOMATION",
		],
	};
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController(config);
	const holder = { controller };
	const handlers = new Map<string, Handler[]>();
	const handlerOptions = new Map<string, unknown[]>();
	const clock = new FakeClock();
	const sent: SentMessage[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const branch: BranchEntry[] = [];
	const spliceAttempts: string[] = [];
	const widgets: Array<{ key: string; value: unknown }> = [];
	const widgetPlacements = new Map<string, string | undefined>();
	const aborts = 0;
	let runtime: ReturnType<typeof createDecisionRuntime>;
	let decisionStarted = false;
	let startedDecisionDetails: unknown = null;

	const harness = {
		handlers,
		handlerOptions,
		clock,
		config,
		controller,
		hub,
		sent,
		notifications,
		entries,
		branch,
		spliceAttempts,
		widgets,
		widgetPlacements,
		aborts,
		pendingMessages: false,
		streaming: false,
		triggeredTurns: 0,
	} as Harness;

	const pi = {
		on(name: string, handler: Handler, registrationOptions?: unknown): void {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			const registrations = handlerOptions.get(name) ?? [];
			registrations.push(registrationOptions);
			handlerOptions.set(name, registrations);
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
			if (
				message.customType === DECISION_FOLD_MESSAGE_TYPE &&
				sendOptions?.triggerTurn === false
			) {
				if (options?.appendUnrelatedAssistantBeforeFold) {
					branch.push({
						id: `unrelated-${branch.length + 1}`,
						type: "message",
						message: { role: "assistant" },
					});
				}
				branch.push({
					id: `fold-${branch.length + 1}`,
					type: "custom_message",
					customType: message.customType,
					details: message.details,
				});
			}
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
			branch.push({
				id: `custom-${branch.length + 1}`,
				type: "custom",
				customType: type,
				data,
			});
		},
		...(options?.spliceBehavior === "absent"
			? {}
			: {
					spliceEntry(entryId: string): boolean | undefined {
						spliceAttempts.push(entryId);
						if (options?.spliceBehavior === "throw") {
							throw new Error("splice failed");
						}
						if (options?.spliceBehavior === "success") {
							const index = branch.findIndex((entry) => entry.id === entryId);
							if (index !== -1) branch.splice(index, 1);
						}
						return options?.spliceBehavior === "false" ? false : undefined;
					},
				}),
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: options?.mode ?? "tui",
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
		sessionManager: {
			getSessionId: () => "main",
			getBranch: () => {
				if (options?.branchThrows) throw new Error("branch failed");
				return branch;
			},
		},
		ui: {
			notify(message: string, level?: string): void {
				notifications.push({ message, level });
				options?.onNotify?.(message);
			},
			setWidget(
				key: string,
				value: unknown,
				widgetOptions?: { readonly placement?: string },
			): void {
				widgets.push({ key, value });
				if (value === undefined) widgetPlacements.delete(key);
				else widgetPlacements.set(key, widgetOptions?.placement);
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
			await runtime.handleMessageStart(
				event as { readonly message: unknown },
				ctx,
			);
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
		branch.push({
			id: `decision-${branch.length + 1}`,
			type: "custom_message",
			customType: decision.message.customType,
			details: decision.message.details,
		});
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
		if (
			message !== null &&
			typeof message === "object" &&
			"role" in message &&
			message.role === "assistant"
		) {
			branch.push({
				id: `assistant-${branch.length + 1}`,
				type: "message",
				message: { role: "assistant" },
			});
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

function mountStateStatusWidget(harness: Harness): {
	readonly renderRequests: () => number;
	render(width: number): string[];
} {
	const registration = [...harness.widgets]
		.reverse()
		.find(
			(widget) =>
				widget.key === "pi-continue-watchdog:state" &&
				typeof widget.value === "function",
		);
	assert.ok(registration, "expected state status widget registration");
	let renderRequests = 0;
	const factory = registration.value as (
		tui: { requestRender(): void },
		theme: {
			fg(color: string, text: string): string;
			bg(color: string, text: string): string;
		},
	) => { render(width: number): string[] };
	const component = factory(
		{
			requestRender(): void {
				renderRequests += 1;
			},
		},
		{
			fg: (_color, text) => text,
			bg: (_color, text) => text,
		},
	);
	return {
		renderRequests: () => renderRequests,
		render: (width) => component.render(width),
	};
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

/** agent_settled itself is the authoritative finalization boundary. */
async function settleOnly(harness: Harness): Promise<void> {
	await harness.fire("agent_settled", { type: "agent_settled" });
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

test("optional Reflect API pauses before ask and resumes after terminal decision", async () => {
	const calls: string[] = [];
	const symbol = Symbol.for("pi-reflect-watchdog.api.v1");
	const host = globalThis as typeof globalThis & {
		[symbol]?: { paused: boolean; pause(): void; resume(): void };
	};
	host[symbol] = {
		paused: false,
		pause() {
			calls.push("pause");
			this.paused = true;
		},
		resume() {
			calls.push("resume");
			this.paused = false;
		},
	};
	try {
		const harness = createHarness();
		await startIdle(harness);
		await harness.openDecision();
		assert.deepEqual(calls, ["pause"]);
		await harness.endDecisionMessage(harness.answerUnlock());
		await harness.fire("agent_end", {
			type: "agent_end",
			messages: [harness.answerUnlock()],
		});
		harness.streaming = false;
		await harness.fire("agent_settled", { type: "agent_settled" });
		assert.deepEqual(calls, ["pause", "resume"]);
		await harness.runtime.shutdown();
	} finally {
		delete host[symbol];
	}
});

test("domain invalidation resumes optional Reflect counting", async () => {
	const calls: string[] = [];
	const symbol = Symbol.for("pi-reflect-watchdog.api.v1");
	const host = globalThis as typeof globalThis & {
		[symbol]?: { paused: boolean; pause(): void; resume(): void };
	};
	host[symbol] = {
		paused: false,
		pause() {
			calls.push("pause");
			this.paused = true;
		},
		resume() {
			calls.push("resume");
			this.paused = false;
		},
	};
	try {
		const fence = createFenceHarness();
		const harness = createHarness({ processDomain: fence.domain });
		await startIdle(harness);
		await harness.openDecision();
		assert.deepEqual(calls, ["pause"]);
		fence.advanceFence();
		assert.deepEqual(calls, ["pause", "resume"]);
		await harness.runtime.shutdown();
	} finally {
		delete host[symbol];
	}
});

test("throwing optional Reflect API leaves decision flow unchanged", async () => {
	const symbol = Symbol.for("pi-reflect-watchdog.api.v1");
	const host = globalThis as typeof globalThis & {
		[symbol]?: { paused: boolean; pause(): void; resume(): void };
	};
	host[symbol] = {
		paused: false,
		pause() {
			throw new Error("peer failed");
		},
		resume() {
			throw new Error("peer failed");
		},
	};
	try {
		const harness = createHarness();
		await startIdle(harness);
		await harness.openDecision();
		assert.equal(
			harness.sent.at(-1)?.message.customType,
			DECISION_MESSAGE_TYPE,
		);
		await harness.runtime.shutdown();
	} finally {
		delete host[symbol];
	}
});

test("idle arms one unref timer and opens one visible decision-only window", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();

	assert.equal(harness.clock.records.length, 2);
	assert.equal(harness.clock.records[0]?.cleared, true);
	assert.equal(harness.clock.records[1]?.delayMs, 10_000);
	assert.equal(harness.clock.records[1]?.unrefCount, 1);
	harness.clock.fire(1);

	assert.equal(harness.sent[0]?.message.customType, DECISION_MESSAGE_TYPE);
	assert.equal(harness.sent[0]?.message.display, false);
	assert.deepEqual(harness.sent[0]?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
});

test("trigger status reports real runtime grace and finalization state without mutation", async () => {
	const harness = createHarness();
	await startIdle(harness);
	assert.equal(harness.runtime.getTriggerStatus().blocker, "unlocked");

	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();
	const waiting = harness.runtime.getTriggerStatus();
	assert.equal(waiting.blocker, null);
	assert.equal(waiting.gracePhase, "grace");
	assert.equal(waiting.graceRemainingMs, 10_000);
	assert.equal(waiting.observableBusyCount, 0);

	harness.clock.fire(harness.clock.records.length - 1);
	await harness.startDecision();
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [harness.answerContinue()],
	});
	const before = harness.controller.snapshot;
	const finalizing = harness.runtime.getTriggerStatus();
	assert.equal(finalizing.blocker, "decision-finalizing");
	assert.deepEqual(harness.controller.snapshot, before);
	assert.equal(harness.sent.length, 1);
	assert.deepEqual(harness.entries, [
		{
			type: INQUIRY_MARKER_ENTRY_TYPE,
			data: { version: 1, exchangeId: "exchange-1", cycleId: 1 },
		},
	]);
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

test("legacy idle delay config cannot alter the fixed ten-second fence", async () => {
	for (const idleDelaySeconds of [0, 0.5, Number.MAX_VALUE]) {
		const harness = createHarness({ config: { idleDelaySeconds } });
		await startIdle(harness);
		harness.runtime.applyTransition(harness.controller.lock(), undefined, {
			suppressNotify: true,
		});
		harness.runtime.reconcileIdle();

		const timer = harness.clock.records.at(-1);
		assert.equal(timer?.delayMs, 10_000);
		assert.equal(harness.sent.length, 0);
		timer?.callback();
		assert.equal(harness.sent[0]?.message.customType, DECISION_MESSAGE_TYPE);
	}
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
	assert.equal(harness.clock.records.at(-1)?.delayMs, 10_000);
});

test("TUI state row tracks enablement and currently running observable participants", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	assert.equal(
		harness.widgetPlacements.get("pi-continue-watchdog:state"),
		"belowEditor",
	);
	const widget = mountStateStatusWidget(harness);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | idle (disabled) | none",
	]);

	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | idle (enabled) | none",
	]);

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | running (enabled) | root",
	]);

	const child = harness.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "local-child",
		hasUI: false,
		initialBusy: true,
	}).attachment;
	fence.setBusyParticipants(1);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | running (enabled) | root + 2 observed subagents",
	]);

	harness.streaming = false;
	await settleOnly(harness);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | running (enabled) | 2 observed subagents",
	]);

	harness.hub.markIdle(child);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | running (enabled) | 1 observed subagent",
	]);
	fence.setBusyParticipants(0);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | idle (enabled) | none",
	]);
	assert.deepEqual(widget.render(18), ["CW | idle/on | -"]);
	const narrow = widget.render(14);
	assert.equal(narrow.length, 1);
	assert.equal(visibleWidth(narrow[0] ?? "") <= 14, true);
	assert.equal(widget.renderRequests() > 0, true);

	await harness.runtime.shutdown();
	assert.deepEqual(harness.widgets.at(-1), {
		key: "pi-continue-watchdog:state",
		value: undefined,
	});
});

test("state row is absent outside an interactive root TUI", async () => {
	const rpc = createHarness({ mode: "rpc" });
	await startIdle(rpc);
	assert.equal(
		rpc.widgets.some((widget) => widget.key === "pi-continue-watchdog:state"),
		false,
	);
	await rpc.runtime.shutdown();

	const headless = createHarness({ hasUI: false });
	await startIdle(headless);
	assert.equal(
		headless.widgets.some(
			(widget) => widget.key === "pi-continue-watchdog:state",
		),
		false,
	);
	await headless.runtime.shutdown();
});

test("agent_end finalizes while streaming but settled alone dispatches continue", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	assert.deepEqual(harness.entries, [
		{
			type: INQUIRY_MARKER_ENTRY_TYPE,
			data: { version: 1, exchangeId: "exchange-1", cycleId: 1 },
		},
	]);
	assert.equal(harness.widgets.at(-1)?.key, "pi-continue-watchdog:status");
	assert.notEqual(harness.widgets.at(-1)?.value, undefined);
	const before = harness.sent.length;
	const turnsBefore = harness.triggeredTurns;

	await harness.startDecision();
	// Stock Pi emits assistant message_start inside the same confirmed inquiry run.
	// It is live-observed but must not be mistaken for foreign activity.
	await harness.fire("message_start", {
		type: "message_start",
		message: harness.answerContinue(),
	});
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
	assert.deepEqual(
		harness.entries.filter((entry) => entry.type !== INQUIRY_MARKER_ENTRY_TYPE),
		[
			{
				type: "pi-continue-watchdog:continue",
				data: {
					reasonType: "WORK_REMAINS",
					reason: "Implementation work remains.",
				},
			},
		],
	);
	assert.deepEqual(harness.widgets.at(-1), {
		key: "pi-continue-watchdog:status",
		value: undefined,
	});
});

test("inquiry marker is persisted before the decision prompt", async () => {
	const timeline: string[] = [];
	const harness = createHarness({
		onAppend(type) {
			if (type === INQUIRY_MARKER_ENTRY_TYPE) timeline.push("marker");
		},
		onSend(message) {
			if (message.customType === DECISION_MESSAGE_TYPE) timeline.push("prompt");
			return undefined;
		},
	});
	await startIdle(harness);
	await harness.openDecision({ start: false });

	assert.deepEqual(timeline, ["marker", "prompt"]);
	assert.deepEqual(harness.entries[0], {
		type: INQUIRY_MARKER_ENTRY_TYPE,
		data: { version: 1, exchangeId: "exchange-1", cycleId: 1 },
	});
});

test("inquiry marker persistence failure prevents decision dispatch", async () => {
	const harness = createHarness({ appendThrows: INQUIRY_MARKER_ENTRY_TYPE });
	await startIdle(harness);
	await harness.openDecision({ start: false });

	assert.equal(
		harness.sent.filter((entry) => entry.options?.triggerTurn === true).length,
		0,
	);
	assert.equal(harness.sent.at(-1)?.options?.triggerTurn, false);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
});

test("marker written before a send-time busy race still defers silently", async () => {
	let harness: Harness;
	harness = createHarness({
		onSend(message) {
			if (message.customType === DECISION_MESSAGE_TYPE) {
				harness.streaming = true;
				void harness.fire("agent_start", { type: "agent_start" });
				return new Error("busy");
			}
			return undefined;
		},
	});
	await startIdle(harness);
	await harness.openDecision({ start: false });

	assert.deepEqual(harness.entries, [
		{
			type: INQUIRY_MARKER_ENTRY_TYPE,
			data: { version: 1, exchangeId: "exchange-1", cycleId: 1 },
		},
	]);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(
		harness.entries.some(
			(entry) =>
				entry.type === "pi-continue-watchdog:status" &&
				(entry.data as { kind?: string }).kind === "other-error",
		),
		false,
	);
});

test("continue entry persistence failure stops automatic continuation", async () => {
	const harness = createHarness({
		appendThrows: "pi-continue-watchdog:continue",
	});
	await startIdle(harness);
	await harness.openDecision();
	const sentBefore = harness.sent.length;

	await settleResponse(harness, harness.answerContinue());

	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(harness.triggeredTurns, 1);
	assert.deepEqual(
		harness.entries.filter((entry) => entry.type !== INQUIRY_MARKER_ENTRY_TYPE),
		[
			{
				type: "pi-continue-watchdog:status",
				data: {
					kind: "other-error",
					exchangeId: "exchange-1",
					cycleId: 1,
					message: "append failed",
				},
			},
		],
	);
});

test("continue evidence is persisted before automatic continuation dispatch", async () => {
	const timeline: string[] = [];
	const harness = createHarness({
		onAppend(type) {
			if (type === CONTINUE_ENTRY_TYPE) timeline.push("evidence");
		},
		onSend(message) {
			if (message.customType === DECISION_FOLD_MESSAGE_TYPE) {
				timeline.push("dispatch");
			}
			return undefined;
		},
	});
	await startIdle(harness);
	await harness.openDecision();

	await settleResponse(harness, harness.answerContinue());

	assert.deepEqual(timeline, ["evidence", "dispatch"]);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(harness.triggeredTurns, 2);
});

for (const spliceBehavior of [
	"success",
	"false",
	"throw",
	"absent",
	"branch-throw",
	"unrelated-assistant",
] as const) {
	test(`decision cleanup remains compatible when splice API is ${spliceBehavior}`, async () => {
		const harness = createHarness({
			spliceBehavior:
				spliceBehavior === "branch-throw" ||
				spliceBehavior === "unrelated-assistant"
					? "success"
					: spliceBehavior,
			branchThrows: spliceBehavior === "branch-throw",
			appendUnrelatedAssistantBeforeFold:
				spliceBehavior === "unrelated-assistant",
		});
		await startIdle(harness);
		await harness.openDecision();
		const answer = harness.answerUnlock("Waiting for approval.", "WAIT_USER");

		const replacement = (await harness.endDecisionMessage(
			answer,
		)) as DecisionMessageReplacement;
		assert.deepEqual(replacement.message.content, []);
		assert.equal(harness.spliceAttempts.length, 0);

		await harness.fire("agent_end", {
			type: "agent_end",
			messages: [answer],
		});
		harness.streaming = false;
		await settleOnly(harness);

		assert.equal(harness.controller.snapshot.locked, false);
		assert.deepEqual(replacement.message.content, []);
		assert.equal(
			harness.sent.at(-1)?.message.customType,
			DECISION_FOLD_MESSAGE_TYPE,
		);
		const fold = harness.sent.at(-1)?.message;
		assert.ok(fold);
		assert.deepEqual(
			harness.entries.filter(
				(entry) => entry.type === "pi-continue-watchdog:decision-audit",
			),
			[
				{
					type: "pi-continue-watchdog:decision-audit",
					data: {
						version: 1,
						exchangeId: "exchange-1",
						cycleId: 1,
						outcome: "unlock",
						reasonType: "WAIT_USER",
						reason: "Waiting for approval.",
					},
				},
			],
		);
		assert.deepEqual(harness.spliceAttempts, []);
		if (spliceBehavior === "success") {
			const decision = harness.branch.find(
				(entry) => entry.customType === DECISION_MESSAGE_TYPE,
			);
			assert.ok(decision);
			const messages = [
				{
					role: "custom",
					customType: decision.customType,
					content: "Decide now.",
					display: false,
					details: decision.details,
					timestamp: 1,
				},
				{
					role: "custom",
					...fold,
					timestamp: 2,
				},
			];
			assert.deepEqual(foldDecisionContext(messages), []);
		}
	});
}

function inquiryMarker(exchangeId: string, cycleId = 1) {
	return {
		type: "custom",
		id: `marker-${exchangeId}-${cycleId}`,
		parentId: "parent",
		customType: INQUIRY_MARKER_ENTRY_TYPE,
		data: { version: 1, exchangeId, cycleId },
		timestamp: "2026-01-01T00:00:00.000Z",
	};
}

function decisionEntry(exchangeId: string, cycleId = 1) {
	return {
		type: "custom_message",
		id: `decision-${exchangeId}-${cycleId}`,
		parentId: "parent",
		...createDecisionPromptMessage({
			exchangeId,
			cycleId,
			decisionPrompt: "Decide",
		}),
		timestamp: "2026-01-01T00:00:01.000Z",
	};
}

function preemptedFoldEntry(exchangeId: string, cycleId = 1) {
	return {
		type: "custom_message",
		id: `fold-${exchangeId}-${cycleId}`,
		parentId: "parent",
		...createDecisionFoldMessage({
			exchangeId,
			cycleId,
			outcome: "preempted",
		}),
		timestamp: "2026-01-01T00:00:02.000Z",
	};
}

function preemptedAssistantEntry(
	id = "assistant",
	exchangeId = "exchange-1",
	cycleId = 1,
) {
	return {
		type: "message",
		id,
		parentId: "parent",
		message: neutralizeDecisionAssistant(
			{
				role: "assistant",
				content: [],
				stopReason: "stop",
				errorMessage: "pi-continue-watchdog:preempted",
			},
			exchangeId,
			cycleId,
		),
		timestamp: "2026-01-01T00:00:03.000Z",
	};
}

test("preempted assistant lookup survives interleaved plugin entries", () => {
	const exchangeId = "exchange-1";
	const entries = [
		inquiryMarker(exchangeId),
		{ type: "custom", id: "plugin-before", customType: "other:state" },
		decisionEntry(exchangeId),
		{
			type: "custom_message",
			id: "plugin-message",
			customType: "other:message",
		},
		preemptedFoldEntry(exchangeId),
		{ type: "custom", id: "plugin-after", customType: "other:audit" },
		preemptedAssistantEntry(),
		{
			type: "custom_message",
			id: "later-plugin-message",
			customType: "other:later",
			details: { version: 1, exchangeId: "foreign", cycleId: 9 },
		},
		{ type: "message", id: "later-user", message: { role: "user" } },
	] as never;

	assert.equal(
		findDecisionAssistantEntryId(entries, exchangeId, 1),
		"assistant",
	);
});

test("preempted assistant lookup rejects unmarked or cross-boundary assistants", () => {
	const exchangeId = "exchange-1";
	const unmarked = [
		inquiryMarker(exchangeId),
		decisionEntry(exchangeId),
		preemptedFoldEntry(exchangeId),
		{
			...preemptedAssistantEntry("unrelated-assistant"),
			message: { role: "assistant", content: [] },
		},
	] as never;
	assert.equal(findDecisionAssistantEntryId(unmarked, exchangeId, 1), null);

	const crossed = [
		inquiryMarker(exchangeId),
		decisionEntry(exchangeId),
		inquiryMarker("exchange-2"),
		preemptedFoldEntry(exchangeId),
		preemptedAssistantEntry(),
	] as never;
	assert.equal(findDecisionAssistantEntryId(crossed, exchangeId, 1), null);
});

test("preempted assistant lookup requires an exact inquiry marker and preempted fold", () => {
	const exchangeId = "exchange-1";
	const withoutMarker = [
		decisionEntry(exchangeId),
		preemptedFoldEntry(exchangeId),
		preemptedAssistantEntry(),
	] as never;
	assert.equal(
		findDecisionAssistantEntryId(withoutMarker, exchangeId, 1),
		null,
	);

	const wrongFold = [
		inquiryMarker(exchangeId),
		decisionEntry(exchangeId),
		{
			...preemptedFoldEntry(exchangeId),
			details: {
				version: 1,
				exchangeId,
				cycleId: 1,
				outcome: "unlock",
			},
		},
		preemptedAssistantEntry(),
	] as never;
	assert.equal(findDecisionAssistantEntryId(wrongFold, exchangeId, 1), null);
});

test("session start recovers exactly marked preempted assistants", async () => {
	const exchangeId = "exchange-1";
	const harness = createHarness({ spliceBehavior: "success" });
	(harness.branch as unknown[]).push(
		inquiryMarker(exchangeId),
		{ type: "custom", id: "other-before", customType: "other:before" },
		decisionEntry(exchangeId),
		preemptedFoldEntry(exchangeId),
		{ type: "custom", id: "other-after", customType: "other:after" },
		preemptedAssistantEntry("recovered-assistant"),
	);

	await startIdle(harness);

	assert.deepEqual(harness.spliceAttempts, ["recovered-assistant"]);
	assert.equal(
		harness.branch.some((entry) => entry.id === "recovered-assistant"),
		false,
	);
});

test("continue decision cleanup waits for the next settled boundary before splicing", async () => {
	const harness = createHarness({ spliceBehavior: "success" });
	await startIdle(harness);
	await harness.openDecision();
	const answer = harness.answerContinue();

	const replacement = (await harness.endDecisionMessage(
		answer,
	)) as DecisionMessageReplacement;
	assert.deepEqual(replacement.message.content, []);
	await harness.fire("agent_end", { type: "agent_end", messages: [answer] });
	harness.streaming = false;
	await settleOnly(harness);

	assert.deepEqual(harness.spliceAttempts, []);
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	harness.branch.push({
		id: `fold-${harness.branch.length + 1}`,
		type: "custom_message",
		customType: DECISION_FOLD_MESSAGE_TYPE,
		details: harness.sent.at(-1)?.message.details,
	});

	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.deepEqual(harness.spliceAttempts, []);
});

test("continue message_end audit retains only validated type and reason", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const answer = assistant([
		text(continueXml("verifying", "Tests still need to run.")),
	]);

	const replacement = (await harness.endDecisionMessage(
		answer,
	)) as DecisionMessageReplacement;
	assert.deepEqual(replacement.message.content, []);
	assert.deepEqual(harness.entries.at(-1), {
		type: "pi-continue-watchdog:decision-audit",
		data: {
			version: 1,
			exchangeId: "exchange-1",
			cycleId: 1,
			outcome: "continue",
			reasonType: "VERIFYING",
			reason: "Tests still need to run.",
		},
	});
});

test("decision message_end captures XML, clears its assistant, and persists a context-excluded audit", async () => {
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
	assert.equal(replacement.message.stopReason, "stop");
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
	// finalized response belongs to that submitted run; do not synthesize a
	// second start after message_end reset the submission phase.
	harness.streaming = true;
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [answer],
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
		message: createDecisionFoldMessage({
			exchangeId: "exchange-1",
			cycleId: 1,
			outcome: "unlock",
		}),
		options: { triggerTurn: false, deliverAs: "steer" },
		streaming: false,
	});
	assert.deepEqual(
		harness.entries.filter(
			(entry) =>
				entry.type !== "pi-continue-watchdog:status" &&
				entry.type !== INQUIRY_MARKER_ENTRY_TYPE,
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
	// The continuation turn has its own public start/settled lifecycle.
	const timersBeforeRearm = harness.clock.records.length;
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	harness.streaming = false;
	await settleOnly(harness);
	const secondTimer = harness.clock.records.findLastIndex(
		(record, index) => index >= timersBeforeRearm && record.delayMs === 10_000,
	);
	assert.ok(secondTimer >= 0);
	assert.equal(harness.clock.records[secondTimer]?.delayMs, 10_000);
	assert.equal(harness.clock.records[secondTimer]?.cleared, false);
	harness.clock.fire(secondTimer);
	await settleResponse(harness, harness.answerContinue());
	// The accepted continuation itself is intermediate; exhaustion is observed
	// when that continuation turn reaches its authoritative settled boundary.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	harness.streaming = false;
	await settleOnly(harness);

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
			(entry) =>
				entry.type !== "pi-continue-watchdog:status" &&
				entry.type !== INQUIRY_MARKER_ENTRY_TYPE,
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
			(entry) =>
				entry.type !== "pi-continue-watchdog:status" &&
				entry.type !== INQUIRY_MARKER_ENTRY_TYPE,
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
			assert.deepEqual(harness.sent.at(-1)?.options, {
				triggerTurn: true,
				deliverAs: "steer",
			});
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
			(record) => record.delayMs === 10_000 && !record.cleared,
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
	assert.equal(harness.clock.records.at(-1)?.delayMs, 10_000);
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
	assert.equal(harness.clock.records.at(-1)?.delayMs, 10_000);
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
		(record) => record.delayMs === 10_000 && !record.cleared,
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
	assert.equal(harness.clock.records.at(-1)?.delayMs, 10_000);
});

test("authoritative settled finalizes directly without a competing zero-delay wake", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	harness.streaming = false;
	const timersBefore = harness.clock.records.length;
	await harness.fire("agent_settled", { type: "agent_settled" });

	assert.equal(harness.clock.records.length, timersBefore);
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

test("duplicate true-idle reports replace the full ten-second candidate", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	await harness.fire("agent_settled", { type: "agent_settled" });
	const first = harness.clock.records.at(-1);
	assert.equal(first?.delayMs, 10_000);

	await harness.fire("agent_settled", { type: "agent_settled" });
	const second = harness.clock.records.at(-1);
	assert.notEqual(first, second);
	assert.equal(first?.cleared, true);
	assert.equal(second?.delayMs, 10_000);
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

test("submitted decision invalidated by domain activity still redacts its assistant", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision({ start: false });
	await Promise.resolve();
	await Promise.resolve();
	await harness.startDecision();
	fence.advanceFence();

	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.deepEqual(
		harness.sent.at(-1)?.message,
		createDecisionFoldMessage({
			exchangeId: "exchange-1",
			cycleId: 1,
			outcome: "invalidated",
		}),
	);

	const answer = harness.answerUnlock();
	await harness.fire("message_start", {
		type: "message_start",
		message: answer,
	});
	const replacement = (await harness.endDecisionMessage(
		answer,
	)) as DecisionMessageReplacement;
	assert.deepEqual(replacement.message.content, []);
	assert.equal(
		harness.entries.some(
			(entry) => entry.type === "pi-continue-watchdog:decision-audit",
		),
		false,
	);
	assert.equal(
		harness.entries.some((entry) => entry.type === HUMAN_UNLOCK_ENTRY_TYPE),
		false,
	);

	await harness.fire("agent_end", { type: "agent_end", messages: [answer] });
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(
		await harness.endDecisionMessage(assistant([text("ordinary response")])),
		undefined,
	);
});

test("uncorrelated quarantine releases before an unrelated run", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision({ start: false });
	await Promise.resolve();
	await Promise.resolve();
	fence.advanceFence();

	// agent_start observes the stale provisional interval before exact correlation.
	// decision custom input can correlate the quarantine to this run.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("message_start", {
		type: "message_start",
		message: {
			role: "user",
			content: [text("ordinary user work")],
			timestamp: Date.now(),
		},
	});
	const ordinary = assistant([text("ordinary response")]);
	await harness.fire("message_start", {
		type: "message_start",
		message: ordinary,
	});
	assert.equal(await harness.endDecisionMessage(ordinary), undefined);
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
	const staleFolds = harness.sent.filter(
		(entry) => entry.message.customType === DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.equal(staleFolds.length, 1);
	assert.equal(staleFolds[0]?.options?.triggerTurn, false);
});

test("domain busy fence before unlock delivery defers the typed unlock", async () => {
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
	assert.equal(harness.clock.records.at(-1)?.delayMs, 10_000);
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
			(record) => record.delayMs === 10_000 && !record.cleared,
		),
		true,
	);
});

test("foreign message activity cancels and neutralizes a submitted inquiry", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await harness.startDecision();

	await harness.fire("message_start", {
		type: "message_start",
		message: {
			role: "user",
			content: [text("foreign work")],
			timestamp: Date.now(),
		},
	});
	const replacement = (await harness.endDecisionMessage(
		harness.answerContinue(),
	)) as DecisionMessageReplacement;

	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.deepEqual(replacement.message.content, []);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.sent.at(-1)?.options?.triggerTurn, false);
});

test("same-process child activity cancels a submitted inquiry immediately", async () => {
	const harness = createHarness();
	await startIdle(harness);
	const child = harness.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "active-child",
		hasUI: false,
		initialBusy: false,
	}).attachment;
	await harness.openDecision();
	await harness.startDecision();
	const foldsBefore = harness.sent.filter(
		(entry) => entry.message.customType === DECISION_FOLD_MESSAGE_TYPE,
	).length;

	harness.hub.markBusy(child);

	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(
		harness.sent.filter(
			(entry) => entry.message.customType === DECISION_FOLD_MESSAGE_TYPE,
		).length,
		foldsBefore + 1,
	);
	assert.equal(harness.sent.at(-1)?.options?.triggerTurn, false);
});

test("child completion only makes aggregate idle; exactly one inquiry comes from main", async () => {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: 3,
		maxRetries: 2,
		decisionPrompt: "Decide now.",
		continuePrompt: "Continue compactly.",
		reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"],
		continueReasonTypes: ["WORK_REMAINS", "VERIFYING", "WAIT_AUTOMATION"],
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
	assert.equal(clock.records.length, 0);
	assert.deepEqual(sentBy, []);

	await firstChild.emit("agent_settled");
	assert.equal(clock.records.length, 0);
	assert.deepEqual(sentBy, []);

	await lastChild.emit("agent_settled");
	assert.equal(clock.records[0]?.delayMs, 10_000);
	assert.equal(clock.records.length, 1);
	assert.deepEqual(sentBy, []);
	clock.fire(0);
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
		continueReasonTypes: ["WORK_REMAINS", "VERIFYING", "WAIT_AUTOMATION"],
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
			continueReasonTypes: ["WORK_REMAINS", "VERIFYING", "WAIT_AUTOMATION"],
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
	assert.equal(clock.records.at(-1)?.delayMs, 10_000);

	runtime.shutdown();
	assert.equal(holder.controller, null);
});

test("timer expiry rechecks live Pi state even without an earlier activity event", async () => {
	let liveIdle = true;
	const harness = createHarness({ isIdle: () => liveIdle });
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();
	const timer = harness.clock.records.at(-1);
	assert.ok(timer);

	// The wake-time public query is authoritative even if no event arrived first.
	liveIdle = false;
	harness.clock.fire(harness.clock.records.length - 1);

	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
});

test("agent_start before idle timer callback defers; next true settle rearms", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.reconcileIdle();
	const timer = harness.clock.records.at(-1);
	assert.ok(timer);
	assert.equal(timer.delayMs, 10_000);

	// One binary lifecycle edge covers tool execution, model output, and waiting.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
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
		.find((record) => record.delayMs === 10_000 && !record.cleared);
	assert.ok(rearmed);
	assert.equal(rearmed.delayMs, 10_000);
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
	assert.equal(harness.clock.records[firstGrace]?.delayMs, 10_000);

	harness.pendingMessages = true;
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records[firstGrace]?.cleared, true);

	harness.pendingMessages = false;
	harness.runtime.reconcileIdle();
	const secondGrace = harness.clock.records.length - 1;
	assert.notEqual(secondGrace, firstGrace);
	assert.equal(harness.clock.records[secondGrace]?.delayMs, 10_000);
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
	assert.equal(harness.clock.records[secondGrace]?.delayMs, 10_000);
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
	const rejectedGrace = harness.clock.records.length - 1;
	harness.clock.fire(rejectedGrace);
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(
		harness.clock.records.length,
		rejectedGrace + 1,
		"the rejected authoritative generation stays consumed",
	);

	fence.advanceFence();
	const rearmed = [...harness.clock.records]
		.reverse()
		.find((record) => record.delayMs === 10_000 && !record.cleared);
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
	assert.equal(newerTimer.delayMs, 10_000);
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
		.find((record) => record.delayMs === 10_000 && !record.cleared);
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
		.find((record) => record.delayMs === 10_000 && !record.cleared);
	assert.ok(rearmed);
	assert.equal(rearmed.delayMs, 10_000);
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
	await harness.fire("agent_start", { type: "agent_start" });
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
		.find((record) => record.delayMs === 10_000 && !record.cleared);
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
	// Cross-process business data is only the live idle boolean.
	assert.equal(fence.reportedIdle.at(-1), false);

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
	assert.equal(fence.reportedIdle.at(-1), false);
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
	const settling = harness.fire("agent_settled", { type: "agent_settled" });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(fence.pendingConfirmCount(), 1);

	// Local Pi becomes busy while the re-ask confirm is pending; resolve stale true.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	fence.resolvePendingConfirm(true);
	await settling;

	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.controller.snapshot.decisionFailed, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.sent.length, sentBefore + 1);
	assert.deepEqual(harness.sent.at(-1)?.options, {
		triggerTurn: false,
		deliverAs: "steer",
	});
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
		.find((record) => record.delayMs === 10_000 && !record.cleared);
	assert.ok(rearmed);
	assert.equal(rearmed.delayMs, 10_000);
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
	const settling = duringConfirm.fire("agent_settled", {
		type: "agent_settled",
	});
	await Promise.resolve();
	await Promise.resolve();
	// deliverPending first performs the common finalization fence, then the
	// accepted-continuation fence under test.
	assert.equal(fence.pendingConfirmCount(), 1);
	fence.resolvePendingConfirm(true);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(fence.pendingConfirmCount(), 1);
	await duringConfirm.startUnrelatedRun();
	fence.resolvePendingConfirm(true);
	await settling;
	assert.equal(duringConfirm.controller.snapshot.attempt, 0);
	assert.equal(duringConfirm.controller.snapshot.locked, true);
	assert.equal(duringConfirm.triggeredTurns, 1);

	let atSend: Harness;
	atSend = createHarness({
		onSend(message) {
			if (message.customType === DECISION_FOLD_MESSAGE_TYPE) {
				atSend.streaming = true;
				void atSend.fire("agent_start", { type: "agent_start" });
				void atSend.runtime.handleMessageStart({
					message: {
						role: "user",
						content: [text("unrelated user work")],
						timestamp: Date.now(),
					},
				});
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
	assert.deepEqual(
		atSend.entries.filter(
			(entry) =>
				entry.type === "pi-continue-watchdog:status" ||
				entry.type === CONTINUE_ENTRY_TYPE,
		),
		[
			{
				type: CONTINUE_ENTRY_TYPE,
				data: {
					reasonType: "WORK_REMAINS",
					reason: "Implementation work remains.",
				},
			},
		],
	);
});

test("decision message cleanup is registered as uninterruptible terminal work", () => {
	const harness = createHarness();
	const messageEndOptions = harness.handlerOptions.get("message_end");
	assert.ok(messageEndOptions);
	assert.deepEqual(messageEndOptions.at(-1), { uninterruptible: true });
});

test("real user input silently preempts a submitted decision and extension input stays inert", async () => {
	for (const source of ["interactive", "rpc"] as const) {
		const harness = createHarness({ spliceBehavior: "success" });
		await startIdle(harness);
		await harness.openDecision();
		await harness.startDecision();
		assert.equal(harness.controller.snapshot.decisionOpen, true);
		assert.equal(harness.aborts, 0);
		assert.deepEqual(harness.entries[0], {
			type: INQUIRY_MARKER_ENTRY_TYPE,
			data: {
				version: 1,
				exchangeId: "exchange-1",
				cycleId: 1,
			},
		});
		const sentBefore = harness.sent.length;

		assert.deepEqual(await harness.fireInput(source, "user takeover"), {
			action: "continue",
		});
		assert.equal(harness.aborts, 1);
		assert.equal(harness.controller.snapshot.locked, true);
		assert.equal(harness.controller.snapshot.decisionOpen, false);
		assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
		assert.equal(harness.sent.length, sentBefore + 1);
		assert.deepEqual(harness.sent.at(-1), {
			message: createDecisionFoldMessage({
				exchangeId: "exchange-1",
				cycleId: 1,
				outcome: "preempted",
			}),
			options: { triggerTurn: false, deliverAs: "steer" },
			streaming: true,
		});
		assert.equal(
			harness.sent.some((entry) => entry.message.content === "user takeover"),
			false,
		);

		const abortedDecision = assistant([], "aborted");
		const abortReplacement = (await harness.endDecisionMessage(
			abortedDecision,
		)) as {
			readonly message: {
				readonly content: readonly unknown[];
				readonly stopReason?: string;
			};
		};
		assert.deepEqual(abortReplacement.message.content, []);
		assert.equal(abortReplacement.message.stopReason, "stop");
		assert.equal(
			(abortReplacement.message as { readonly errorMessage?: string })
				.errorMessage,
			"pi-continue-watchdog:preempted",
		);
		const persistedDecision = harness.branch.at(-1);
		assert.ok(persistedDecision?.type === "message");
		(persistedDecision as { message: unknown }).message =
			abortReplacement.message;
		assert.equal(harness.runtime.consumeDecisionAbortSuppression(), true);
		assert.equal(harness.runtime.consumeDecisionAbortSuppression(), false);
		assert.deepEqual(harness.notifications, []);

		harness.streaming = false;
		await harness.fire("agent_settled", { type: "agent_settled" });
		assert.deepEqual(harness.spliceAttempts, ["assistant-4"]);
		assert.equal(
			harness.branch.some((entry) => entry.id === "assistant-4"),
			false,
		);
	}

	const extension = createHarness();
	await startIdle(extension);
	extension.openDecision();
	await extension.startDecision();
	assert.equal(await extension.fireInput("extension"), undefined);
	assert.equal(extension.aborts, 0);
	assert.equal(extension.controller.snapshot.decisionOpen, true);
});

test("preemption retries a failed cleanup fold and leaves no model context residue", async () => {
	let cleanupAttempts = 0;
	const harness = createHarness({
		onSend(message) {
			if (message.customType !== DECISION_FOLD_MESSAGE_TYPE) return undefined;
			cleanupAttempts += 1;
			return cleanupAttempts === 1
				? new Error("cleanup unavailable")
				: undefined;
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	await harness.startDecision();

	assert.deepEqual(await harness.fireInput("interactive", "take over once"), {
		action: "continue",
	});
	assert.equal(cleanupAttempts, 1);
	assert.equal(harness.aborts, 1);
	assert.equal(
		harness.sent.some((entry) => entry.message.content === "take over once"),
		false,
	);

	const neutralized = (await harness.endDecisionMessage(
		assistant([text("private partial XML")], "aborted"),
	)) as DecisionMessageReplacement;
	assert.equal(cleanupAttempts, 2);
	const cleanup = harness.sent.at(-1);
	assert.equal(cleanup?.message.customType, DECISION_FOLD_MESSAGE_TYPE);
	assert.equal(cleanup?.options?.triggerTurn, false);

	const prompt = harness.sent.find(
		(entry) => entry.message.customType === DECISION_MESSAGE_TYPE,
	);
	assert.ok(prompt);
	const providerContext = foldDecisionContext([
		{
			role: "custom",
			...prompt.message,
			content: [{ type: "text", text: prompt.message.content }],
			timestamp: 1,
		},
		{
			role: "custom",
			...cleanup?.message,
			content: [{ type: "text", text: cleanup?.message.content ?? "" }],
			timestamp: 2,
		},
		{ ...neutralized.message, timestamp: 3 },
	]);
	assert.deepEqual(providerContext, []);
});

test("preempted decision cleanup stays idempotent after another handler tags the assistant", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	assert.deepEqual(await harness.fireInput("interactive", "take over"), {
		action: "continue",
	});

	const replacement = (await harness.endDecisionMessage({
		role: "assistant",
		content: [text("private partial")],
		stopReason: "stop",
		errorMessage: "pi-continue-watchdog:preempted",
	})) as DecisionMessageReplacement;
	assert.deepEqual(replacement.message.content, []);
	assert.equal(replacement.message.stopReason, "stop");
	assert.equal(
		replacement.message.errorMessage,
		"pi-continue-watchdog:preempted",
	);
});

test("ordinary aborted decision assistant is cleared without being reclassified as user takeover", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await harness.startDecision();
	const replacement = (await harness.endDecisionMessage(
		assistant([text("partial private watchdog answer")], "aborted"),
	)) as DecisionMessageReplacement;
	assert.deepEqual(replacement.message.content, []);
	assert.equal(replacement.message.stopReason, "aborted");
	assert.equal(replacement.message.errorMessage, undefined);
	assert.equal(harness.runtime.consumeDecisionAbortSuppression(), false);
	assert.equal(harness.aborts, 0);
	assert.equal(harness.controller.snapshot.locked, true);
});

test("provider retry agent_start preserves a confirmed internal decision classification", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	await Promise.resolve();
	await Promise.resolve();
	await harness.startDecision();
	const reportsBeforeRetry = fence.reportedIdle.length;
	assert.equal(fence.reportedIdle.at(-1), false);
	assert.equal(harness.controller.snapshot.decisionOpen, true);

	await harness.fire("agent_start", { type: "agent_start" });

	assert.equal(fence.reportedIdle.length, reportsBeforeRetry + 1);
	assert.equal(fence.reportedIdle.at(-1), false);
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
	// Busy at the final send boundary: only agent_start changes the binary AI
	// state. The stock busy error must defer without unlock or error cards.
	let busy: Harness;
	busy = createHarness({
		onSend(message) {
			if (message.customType === DECISION_MESSAGE_TYPE) {
				busy.streaming = true;
				void busy.fire("agent_start", { type: "agent_start" });
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

	assert.equal(
		busy.sent.filter((entry) => entry.options?.triggerTurn === true).length,
		0,
	);
	assert.deepEqual(busy.sent.at(-1)?.options, {
		triggerTurn: false,
		deliverAs: "steer",
	});
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

test("runtime live-state report rejection fails closed without domain uncertainty", async () => {
	const fence = createFenceHarness({ rejectReport: true });
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(fence.domain.snapshot.allIdle, true);
	assert.deepEqual(fence.reportedIdle, [false]);
});

for (const code of [
	"INVALID_DECLARATION",
	"AUTHENTICATION_FAILED",
	"CONNECTION_UNAVAILABLE",
] as const) {
	test(`initial process-domain ${code} failure exits this watchdog instance`, async () => {
		const fatal = fatalSpy();
		const domain = lifecycleDomain({
			attachError: new ProcessDomainFatalError(code, "private startup details"),
			emitAttachErrorBeforeReject: true,
		});
		const harness = createHarness({
			processDomain: domain.domain,
			fatalExit: fatal.adapter,
		});

		await startIdle(harness);
		assert.equal(fatal.errors.length, 1);
		assert.equal((fatal.errors[0] as ProcessDomainFatalError).code, code);
		harness.runtime.reconcileIdle();
		assert.equal(harness.clock.records.length, 0);
	});
}

test("runtime transport rejection disables watchdog without exiting Pi", async () => {
	const fatal = fatalSpy();
	const domain = lifecycleDomain();
	const harness = createHarness({
		processDomain: domain.domain,
		fatalExit: fatal.adapter,
	});
	await startIdle(harness);

	domain.emitFatal(
		new ProcessDomainFatalError(
			"CONNECTION_UNAVAILABLE",
			"participant transport is not current",
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
