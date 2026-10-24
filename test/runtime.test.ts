import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import {
	AgentSession,
	AssistantMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { registerMainAbortUnlock } from "../src/abort-outcome.js";
import { registerMainUserAutoLock } from "../src/auto-lock.js";
import {
	HUMAN_UNLOCK_ENTRY_TYPE,
	type HumanUnlockEntry,
	handleUnlock,
	type MainCommandRuntime,
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
	parseDecisionFoldDetails,
} from "../src/context-fold.js";
import { createLockDecisionController } from "../src/controller.js";
import {
	buildDecisionFilePrompt,
	prepareDecisionArguments,
} from "../src/decision-protocol.js";
import {
	createHubAttachmentInstance,
	createObservableAgentHub,
	type HubAttachment,
} from "../src/hub.js";
import type { PrivateDecisionOptions } from "../src/private-decision.js";
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

import { formatContinueWatchdogEvent } from "../src/watchdog-event.js";
import {
	awaitPrivatePrompt,
	createPrivateDriver,
	type DriverReply,
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

	monotonicNow(): number {
		return this.currentTimeMs;
	}

	advance(delayMs: number): void {
		this.currentTimeMs += delayMs;
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
	readonly message?: Readonly<Record<string, unknown>> & {
		readonly role: string;
	};
}

interface Harness {
	readonly privateDriver: PrivateDriver;
	readonly activeTools: string[];
	thinkingLevel: string;
	readonly handlers: Map<string, Handler[]>;
	readonly handlerOptions: Map<string, unknown[]>;
	readonly clock: FakeClock;
	readonly widgets: Array<{ key: string; value: unknown }>;
	readonly widgetPlacements: Map<string, string | undefined>;
	readonly config: ContinueWatchdogConfig;
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly hub: ReturnType<typeof createObservableAgentHub>;
	readonly sent: SentMessage[];
	readonly sentUserMessages: Array<
		Parameters<ExtensionAPI["sendUserMessage"]>[0]
	>;
	readonly notifications: Array<{ message: string; level?: string }>;
	readonly entries: Array<{ type: string; data: unknown }>;
	readonly branch: BranchEntry[];
	readonly spliceAttempts: string[];
	aborts: number;
	registeredTools: string[];
	decisionToolDefinitions: unknown[];
	pendingMessages: boolean;
	ctx: ExtensionContext;
	runtime: ReturnType<typeof createDecisionRuntime>;
	streaming: boolean;
	triggeredTurns: number;
	fire(name: string, event: unknown): Promise<void>;
	fireInput(
		source: string,
		text?: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
	): Promise<unknown>;
	openDecision(options?: { readonly start?: boolean }): Promise<void>;
	startDecision(): Promise<void>;
	startUnrelatedRun(message?: unknown): Promise<void>;
	answerContinue(): DriverReply;
	answerWait(waitSeconds?: number, reason?: string): DriverReply;
	answerUnlock(reason?: string, reasonType?: string): DriverReply;
	answerInvalid(text?: string): DriverReply;
	answerRaw(args: unknown): DriverReply;
	respondPrivate(reply: DriverReply): Promise<void>;
	endMainMessage(message: unknown): Promise<unknown>;
	blockToolCall(): Promise<unknown>;
	unlock(): Promise<void>;
}

function assistant(content: unknown[], stopReason = "stop"): unknown {
	return { role: "assistant", content, stopReason };
}

function text(value: string): unknown {
	return { type: "text", text: value };
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
	waitSeconds = 300,
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

const activeHarnesses: Harness[] = [];
test.afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await harness.runtime.shutdown();
		// Always release scripted prompts, even when a failed cancellation assertion
		// exposed an orphaned child; assertions run before this fixture cleanup.
		for (const child of harness.privateDriver.children) {
			await child.abort();
			harness.privateDriver.respond({});
		}
		await Promise.all(
			harness.privateDriver.operations.map((operation) => operation.result),
		);
	}
});

function createHarness(options?: {
	readonly hub?: ReturnType<typeof createObservableAgentHub>;
	readonly clock?: FakeClock;
	readonly sessionId?: string;
	readonly attachmentInstance?: import("../src/hub.js").HubAttachmentInstance;
	readonly nativeAbortGate?: boolean;
	readonly nativeAutoLock?: boolean;
	readonly config?: Partial<ContinueWatchdogConfig>;
	readonly sendThrows?: boolean;
	readonly omitPersistedEvent?: (kind: string) => boolean;
	readonly fatalExit?: import("../src/fatal-exit.js").FatalExitAdapter;
	readonly onSend?: (message: SentMessage["message"]) => Error | undefined;
	readonly appendThrows?: boolean | string;
	readonly contextEntriesThrows?: boolean;
	readonly omitPersistedEntryTypes?: readonly string[];
	readonly onAppend?: (type: string) => void;
	readonly spliceBehavior?: "success" | "false" | "throw" | "absent";
	readonly branchThrows?: boolean;
	readonly onReadBranch?: () => void;
	readonly onHook?: (name: string) => void;
	readonly appendUnrelatedAssistantBeforeFold?: boolean;
	readonly hasUI?: boolean;
	readonly mode?: "tui" | "rpc" | "json" | "print";
	readonly onNotify?: (message: string) => void;
	readonly onWidget?: (key: string, value: unknown) => void;
	readonly executePrivateDecision?: typeof import("../src/private-decision.js").runPrivateDecision;
	/** Fake child's reported native session file; must exist for `available`. */
	readonly privateSessionFile?: string;
	readonly processDomain?: ProcessDomainCoordinator;
	readonly isIdle?: () => boolean;
	readonly reviewService?: import("../src/unlock-review.js").ReviewServiceLike;
	readonly wouldTriggerAutoCompaction?: (content: string) => boolean;
	readonly onCompact?: (options: {
		readonly onComplete?: () => void;
		readonly onError?: (error: Error) => void;
	}) => void;
}): Harness {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: options?.config?.idleDelaySeconds ?? 3,
		maxContinue: options?.config?.maxContinue ?? 3,
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
	const hub = options?.hub ?? createObservableAgentHub();
	const controller = createLockDecisionController(config);
	const holder = { controller };
	const handlers = new Map<string, Handler[]>();
	const handlerOptions = new Map<string, unknown[]>();
	const clock = options?.clock ?? new FakeClock();
	const sent: SentMessage[] = [];
	const sentUserMessages: Array<
		Parameters<ExtensionAPI["sendUserMessage"]>[0]
	> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const branch: BranchEntry[] = [];
	const spliceAttempts: string[] = [];
	const widgets: Array<{ key: string; value: unknown }> = [];
	const widgetPlacements = new Map<string, string | undefined>();
	const aborts = 0;
	const privateDriver = createPrivateDriver({
		sessionFile: options?.privateSessionFile,
	});
	let runtime: ReturnType<typeof createDecisionRuntime>;

	const harness = {
		privateDriver,
		activeTools: ["read"],
		thinkingLevel: "off",
		handlers,
		handlerOptions,
		clock,
		config,
		controller,
		hub,
		sent,
		sentUserMessages,
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
		registeredTools: [] as string[],
		decisionToolDefinitions: [] as unknown[],
	} as Harness;

	const pi = {
		getThinkingLevel: () => harness.thinkingLevel,
		getActiveTools: () => [...harness.activeTools],
		setActiveTools(names: string[]): void {
			harness.activeTools.splice(0, harness.activeTools.length, ...names);
		},
		events: {
			emit(_topic: string, envelope: { readonly name: string }): void {
				options?.onHook?.(envelope.name);
			},
		},
		on(name: string, handler: Handler, registrationOptions?: unknown): void {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			const registrations = handlerOptions.get(name) ?? [];
			registrations.push(registrationOptions);
			handlerOptions.set(name, registrations);
		},
		async sendUserMessage(
			content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
		): Promise<void> {
			sentUserMessages.push(content);
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
			const foldDetails = parseDecisionFoldDetails(message.details);
			const eventKind =
				foldDetails?.watchdogEvent?.kind ??
				foldDetails?.watchdogOutcome ??
				(message.details as { readonly kind?: string } | undefined)?.kind;
			if (
				(message.customType === DECISION_FOLD_MESSAGE_TYPE ||
					message.customType === "pi-continue-watchdog:event") &&
				!options?.omitPersistedEvent?.(eventKind ?? "")
				// This unit transport persists immediately. Async ordering has real-host probes.
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
		registerTool(definition: { readonly name: string }): void {
			harness.registeredTools.push(definition.name);
			if (!harness.activeTools.includes(definition.name))
				harness.activeTools.push(definition.name);
			harness.decisionToolDefinitions.push(definition);
		},
		appendEntry(type: string, data: HumanUnlockEntry): void {
			options?.onAppend?.(type);
			if (options?.appendThrows === true || options?.appendThrows === type) {
				throw new Error("append failed");
			}
			if (options?.omitPersistedEntryTypes?.includes(type)) return;
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
		cwd: process.cwd(),
		model: { provider: "fake", id: "local" },
		modelRegistry: {},
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
			getSessionId: () => options?.sessionId ?? "main",
			getSessionFile: () => undefined,
			getSessionDir: () => process.cwd(),
			getCwd: () => process.cwd(),
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => {
				options?.onReadBranch?.();
				if (options?.branchThrows) throw new Error("branch failed");
				return branch;
			},
			buildContextEntries: () => {
				if (options?.contextEntriesThrows)
					throw new Error("effective context failed");
				return branch;
			},
		},
		ui: {
			onTerminalInput() {
				return () => {};
			},
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
				options?.onWidget?.(key, value);
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
		attachmentInstance:
			options?.attachmentInstance ?? createHubAttachmentInstance(),
		controllerHolder: holder,
		injectedController: true,
		initialConfig: config,
		clock,
		createExchangeId: () => "exchange-1",
		reviewService: options?.reviewService,
		executePrivateDecision:
			options?.executePrivateDecision ?? privateDriver.execute,
	});
	if (options?.nativeAbortGate) {
		registerMainAbortUnlock(pi, {
			isCurrentMain: runtime.isCurrentMain,
			getMainClaim: runtime.getMainClaim,
			isCurrentMainClaim: runtime.isCurrentMainClaim,
			controller,
			clearOperationalPendingWork: runtime.clearOperationalPendingWork,
			retainErrorUnlock: runtime.retainErrorUnlock,
			consumeDecisionAbortSuppression: runtime.consumeDecisionAbortSuppression,
			applyEffect: runtime.applyEffect,
		});
	}
	runtime.registerLifecycle();
	if (options?.nativeAutoLock) {
		registerMainUserAutoLock(pi, {
			isCurrentMain: runtime.isCurrentMain,
			onMainUserMessageStart() {
				runtime.restartLockCycle(undefined, { notifyLocked: false });
			},
		});
	}

	harness.ctx = ctx;
	harness.runtime = runtime;
	activeHarnesses.push(harness);
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
	harness.fireInput = async (source, text = "user message", images) => {
		let result: unknown;
		for (const handler of handlers.get("input") ?? []) {
			result = await handler(
				{ type: "input", text, source, images } as never,
				ctx,
			);
		}
		return result;
	};
	harness.openDecision = async (openOptions) => {
		runtime.applyTransition(controller.lock(), undefined, {
			suppressNotify: true,
		});
		runtime.reconcileIdle();
		clock.fire(clock.records.length - 1);
		await Promise.resolve();
		await Promise.resolve();
		if (openOptions?.start !== false && privateDriver.current !== undefined) {
			await harness.startDecision();
		}
	};
	// Child prompts never emit parent lifecycle/context events.
	harness.startDecision = async () => {
		await awaitPrivatePrompt(privateDriver);
		for (
			let turn = 0;
			turn < 2000 && !privateDriver.awaitingResponse;
			turn += 1
		) {
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}
		assert.equal(privateDriver.awaitingResponse, true);
		assert.equal(harness.streaming, false);
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
	harness.answerContinue = () => ({ write: JSON.stringify(continueArgs()) });
	harness.answerWait = (
		waitSeconds = 300,
		reason = "Waiting for automation.",
	) => ({
		write: JSON.stringify(waitArgs(waitSeconds, reason)),
	});
	harness.answerUnlock = (
		reason = "All requested work is complete.",
		reasonType = "JOB_DONE",
	) => ({
		write: JSON.stringify(unlockArgs(reasonType, reason)),
	});
	harness.answerInvalid = (value = "I will wait.") => ({ write: value });
	harness.answerRaw = (args) => ({ write: JSON.stringify(args) });
	harness.respondPrivate = async (reply) => {
		const operation = privateDriver.current;
		assert.ok(operation, "expected private operation");
		const promptsBefore = privateDriver.children.reduce(
			(sum, child) => sum + child.prompts.length,
			0,
		);
		privateDriver.respond(reply);
		for (let turn = 0; turn < 2000; turn += 1) {
			if (operation.settled) {
				await settlePrivateDecision(privateDriver);
				return;
			}
			const prompts = privateDriver.children.reduce(
				(sum, child) => sum + child.prompts.length,
				0,
			);
			if (privateDriver.awaitingResponse && prompts > promptsBefore) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}
		assert.fail(
			"private response did not settle or reach its correction prompt",
		);
	};
	harness.endMainMessage = async (message: unknown) => {
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
	harness.unlock = async () => {
		const commandRuntime: MainCommandRuntime = {
			get controller() {
				return runtime.controller;
			},
			isCurrentMain: runtime.isCurrentMain,
			getTriggerStatus: runtime.getTriggerStatus,
			getMainClaim: runtime.getMainClaim,
			isCurrentMainClaim: runtime.isCurrentMainClaim,
			restartLockCycle: runtime.restartLockCycle,
			clearOperationalPendingWork: runtime.clearOperationalPendingWork,
			handleManualUnlock: runtime.handleManualUnlock,
			applyEffect: runtime.applyEffect,
			reconcileIdle: runtime.reconcileIdle,
		};
		await handleUnlock(pi, commandRuntime, "", ctx as never);
	};

	return harness;
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
	for (let turn = 0; turn < 2000; turn += 1) {
		if (check()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	assert.fail(message);
}

async function startIdle(harness: Harness): Promise<void> {
	await harness.fire("session_start", { type: "session_start" });
}

function mountStateStatusWidget(
	harness: Harness,
	options?: {
		readonly onRender?: () => void;
		readonly theme?: {
			fg(color: string, text: string): string;
			bg(color: string, text: string): string;
		};
	},
): {
	readonly renderRequests: () => number;
	render(width: number): string[];
	dispose(): void;
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
	) => { render(width: number): string[]; dispose(): void };
	const component = factory(
		{
			requestRender(): void {
				renderRequests += 1;
				options?.onRender?.();
			},
		},
		options?.theme ?? {
			fg: (_color, text) => text,
			bg: (_color, text) => text,
		},
	);
	return {
		renderRequests: () => renderRequests,
		render: (width) => component.render(width),
		dispose: () => component.dispose(),
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
	reply: DriverReply,
): Promise<void> {
	await harness.startDecision();
	await harness.respondPrivate(reply);
}

async function exhaustAfterOneContinue(harness: Harness): Promise<void> {
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	harness.streaming = false;
	await settleOnly(harness);
}

async function startAcceptedContinuation(
	harness: Harness,
	confirmStart = true,
): Promise<SentMessage> {
	await harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	const fold = harness.sent.at(-1);
	assert.equal(fold?.message.customType, DECISION_FOLD_MESSAGE_TYPE);
	assert.equal(
		parseDecisionFoldDetails(fold?.message.details)?.watchdogOutcome,
		"continue",
	);
	assert.ok(fold);
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	if (confirmStart) {
		await harness.fire("message_start", {
			type: "message_start",
			message: {
				role: "custom",
				...fold.message,
				timestamp: Date.now(),
			},
		});
	}
	return fold;
}

test("native continuation abort keeps unlock and output without Pi's abort notice", async () => {
	initTheme("dark", false);
	const harness = createHarness({ nativeAbortGate: true });
	await startIdle(harness);
	await startAcceptedContinuation(harness);
	const turnsBefore = harness.triggeredTurns;
	const attemptBefore = harness.controller.snapshot.attempt;
	const aborted = assistant([text("partial native output")], "aborted");
	const result = (await harness.endMainMessage(aborted)) as
		| DecisionMessageReplacement
		| undefined;
	const message = (result?.message ??
		aborted) as DecisionMessageReplacement["message"];
	const persisted = harness.branch.at(-1);
	assert.ok(persisted?.type === "message");
	(persisted as { message: unknown }).message = message;
	const rendered = new AssistantMessageComponent(message as never)
		.render(100)
		.join("\n");

	assert.equal(message.stopReason, "aborted", "Pi must still see a real abort");
	await harness.fire("message_end", { type: "message_end", message });
	await harness.fire("agent_end", { type: "agent_end", messages: [message] });
	harness.streaming = false;
	await settleOnly(harness);
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.deepEqual(harness.notifications, [
		{ message: "Continue watchdog unlocked", level: undefined },
	]);
	assert.equal(harness.aborts, 0, "an observed abort is not requested again");
	assert.equal(harness.triggeredTurns, turnsBefore);
	assert.equal(harness.controller.snapshot.attempt, attemptBefore);
	assert.deepEqual(harness.spliceAttempts, []);
	assert.match(rendered, /partial native output/);
	assert.doesNotMatch(rendered, /Operation aborted/);
	assert.deepEqual(
		stripVTControlCharacters(rendered)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
		["partial native output"],
	);
});
for (const scenario of [
	"tool-call",
	"steering",
	"follow-up",
	"compaction",
] as const) {
	test(`native continuation abort preserves Pi host control with ${scenario}`, async () => {
		// Resolve the exact agent-core used by the installed test host, not another copy.
		const hostRequire = createRequire(
			import.meta.resolve("@earendil-works/pi-coding-agent"),
		);
		const coreEntry = hostRequire.resolve(
			"@earendil-works/pi-agent-core/package.json",
		);
		const { runAgentLoop } = await import(
			new URL("./dist/agent-loop.js", pathToFileURL(coreEntry)).href
		);
		const harness = createHarness({ nativeAbortGate: true });
		await startIdle(harness);
		await startAcceptedContinuation(harness);
		const signal = new AbortController();
		signal.abort();
		let streams = 0;
		let turns = 0;
		let steeringPolls = 0;
		let dequeued = 0;
		let compactions = 0;
		const queued = { role: "user", content: "queued user work", timestamp: 1 };
		const message: Extract<MessageEndEvent["message"], { role: "assistant" }> =
			{
				role: "assistant",
				content: [{ type: "text", text: "partial native output" }],
				stopReason: "aborted",
				errorMessage: "Request was aborted",
				api: "openai-completions",
				provider: "local",
				model: "local",
				timestamp: 1,
				usage: {
					input: 95,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 95,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		if (scenario === "tool-call")
			message.content.push({
				type: "toolCall",
				id: "partial-call",
				name: "probe",
				arguments: {},
			});
		const model = {
			id: "local",
			provider: "local",
			api: "openai-completions",
			contextWindow: 100,
			maxTokens: 10,
		};
		const result = await runAgentLoop(
			[],
			{ systemPrompt: "", messages: [], tools: [] },
			{
				model,
				convertToLlm: (messages: unknown[]) => messages,
				getSteeringMessages: async () => {
					if (++steeringPolls === 2 && scenario === "steering") {
						dequeued++;
						return [queued];
					}
					return [];
				},
				getFollowUpMessages: async () => {
					if (scenario === "follow-up" && dequeued === 0) {
						dequeued++;
						return [queued];
					}
					return [];
				},
			},
			async (event: { type: string; message?: MessageEndEvent["message"] }) => {
				if (event.type === "turn_start") turns++;
				if (event.type === "message_start")
					await harness.fire("message_start", event);
				if (
					event.type === "message_end" &&
					event.message?.role === "assistant"
				) {
					const replacement = (await harness.endMainMessage(event.message)) as
						| DecisionMessageReplacement
						| undefined;
					if (replacement) Object.assign(event.message, replacement.message);
					const persisted = harness.branch.at(-1);
					assert.ok(persisted);
					(persisted as { message: unknown }).message = event.message;
				}
				if (event.type === "agent_end") await harness.fire("agent_end", event);
			},
			signal.signal,
			() => {
				const next = streams++ === 0 ? message : { ...message, content: [] };
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "error", error: next };
					},
					result: async () => next,
				};
			},
		);
		assert.equal(streams, 1, "abort must not open another provider stream");
		assert.equal(turns, 1, "abort must not open another host turn");
		assert.equal(dequeued, 0, "abort must not consume queued user work");
		assert.deepEqual(
			result,
			[message],
			"abort must not append tool results or queued messages",
		);
		if (scenario === "compaction") {
			const host = AgentSession.prototype as unknown as {
				_checkCompaction(this: unknown, message: unknown): Promise<boolean>;
			};
			const context = {
				settingsManager: {
					getCompactionSettings: () => ({
						enabled: true,
						reserveTokens: 10,
						keepRecentTokens: 5,
					}),
				},
				model,
				_modelForMessage: () => model,
				_findPersistedMessageEntryId: () => undefined,
				sessionManager: {
					getBranch: () => [],
					buildSessionProjection: () => ({ entries: [] }),
				},
				agent: { state: { messages: [] } },
				_runAutoCompaction: async () => {
					compactions++;
					return false;
				},
			};
			await host._checkCompaction.call(context, message);
			assert.equal(
				compactions,
				0,
				"abort must skip post-run threshold compaction",
			);
			await host._checkCompaction.call(context, {
				...message,
				stopReason: "stop",
			});
			assert.equal(
				compactions,
				1,
				"control: this usage crosses the compaction threshold",
			);
		}
		harness.streaming = false;
		await settleOnly(harness);
		await settleOnly(harness);
		assert.equal(harness.controller.snapshot.locked, false);
		assert.equal(harness.notifications.length, 1);
		assert.equal(
			harness.notifications[0]?.message,
			"Continue watchdog unlocked",
		);
		assert.equal(harness.aborts, 0);
		assert.deepEqual(harness.spliceAttempts, []);
	});
}

test("native TUI Escape cancels only an owned private decision and unlocks once", async () => {
	const harness = createHarness({ mode: "tui", hasUI: true });
	let listener:
		| Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0]
		| undefined;
	let unsubscribed = 0;
	harness.ctx.ui.onTerminalInput = (handler) => {
		listener = handler;
		return () => {
			unsubscribed++;
		};
	};
	await startIdle(harness);
	assert.ok(listener, "interactive private cancellation listener registered");
	assert.equal(
		listener("\u001b"),
		undefined,
		"ordinary idle Escape remains native",
	);
	await harness.openDecision();
	assert.equal(listener("x"), undefined, "ordinary input is never captured");
	harness.streaming = true;
	assert.equal(
		listener("\u001b"),
		undefined,
		"busy main Escape stays host-owned",
	);
	assert.equal(harness.privateDriver.children[0]?.aborted, false);
	harness.streaming = false;
	assert.deepEqual(listener("\u001b"), { consume: true });
	await harness.privateDriver.current?.result;
	assert.equal(harness.privateDriver.children[0]?.aborted, true);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.aborts, 0, "private Escape never aborts a parent run");
	assert.deepEqual(
		harness.notifications.map((entry) => entry.message),
		["Continue watchdog unlocked"],
	);
	assert.equal(
		listener("\u001b"),
		undefined,
		"repeated Escape cannot target old work",
	);
	await harness.runtime.shutdown();
	assert.equal(unsubscribed, 1);
	assert.equal(
		listener("\u001b"),
		undefined,
		"disposed listener has no authority",
	);
});

test("manual unlock aborts exact private child without aborting parent", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const child = harness.privateDriver.children[0];
	assert.ok(child);
	assert.equal(harness.streaming, false);
	assert.equal(harness.triggeredTurns, 0);
	await harness.unlock();
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(child.aborted, true);
	assert.equal(child.disposed, true);
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"cancelled",
	);
	assert.deepEqual(harness.notifications, [
		{ message: "Continue watchdog unlocked", level: undefined },
	]);
	assert.equal(
		harness.aborts,
		0,
		"private cancellation must not abort main session",
	);
	assert.equal(harness.runtime.consumeDecisionAbortSuppression(), false);
	assert.deepEqual(harness.spliceAttempts, []);
	assert.equal(
		harness.branch.some((entry) => entry.type === "message"),
		false,
	);
	assert.equal(
		harness.sent.some((entry) => entry.options?.triggerTurn),
		false,
	);
});

test("manual unlock aborts an exact active automated continuation but preserves ordinary runs", async () => {
	const continuation = createHarness({ spliceBehavior: "success" });
	await startIdle(continuation);
	await startAcceptedContinuation(continuation);
	const turnsBefore = continuation.triggeredTurns;

	await continuation.unlock();

	assert.equal(continuation.controller.snapshot.locked, false);
	assert.equal(continuation.aborts, 1);
	assert.equal(continuation.triggeredTurns, turnsBefore);
	const aborted = assistant([text("partial continuation output")], "aborted");
	const replacement = (await continuation.endMainMessage(
		aborted,
	)) as DecisionMessageReplacement;
	assert.deepEqual(replacement.message.content, []);
	assert.equal(replacement.message.stopReason, "stop");
	assert.equal(
		replacement.message.errorMessage,
		"pi-continue-watchdog:cancelled",
	);
	const persisted = continuation.branch.at(-1);
	assert.ok(persisted?.type === "message");
	(persisted as { message: unknown }).message = replacement.message;
	assert.equal(continuation.runtime.consumeDecisionAbortSuppression(), true);
	continuation.streaming = false;
	await settleOnly(continuation);
	assert.deepEqual(continuation.spliceAttempts, [persisted.id]);
	assert.equal(
		continuation.branch.some((entry) => entry.id === persisted.id),
		false,
	);

	const ordinary = createHarness();
	await startIdle(ordinary);
	ordinary.runtime.applyTransition(ordinary.controller.lock(), undefined, {
		suppressNotify: true,
	});
	await ordinary.startUnrelatedRun();
	await ordinary.unlock();
	assert.equal(ordinary.controller.snapshot.locked, false);
	assert.equal(ordinary.aborts, 0);
});

test("repeated unlock, ownership loss, and shutdown cannot retarget cancellation", async () => {
	const repeated = createHarness();
	await startIdle(repeated);
	await startAcceptedContinuation(repeated);
	await repeated.unlock();
	await repeated.unlock();
	assert.equal(repeated.aborts, 1);
	assert.deepEqual(repeated.notifications, [
		{ message: "Continue watchdog unlocked", level: undefined },
		{ message: "Continue watchdog unlocked", level: undefined },
	]);

	const demoted = createHarness({ hasUI: false });
	await startIdle(demoted);
	await startAcceptedContinuation(demoted);
	const usurper = demoted.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "replacement-main",
		hasUI: true,
	});
	assert.ok(usurper.mainClaim);
	await demoted.unlock();
	assert.equal(demoted.aborts, 0);

	const shutdown = createHarness();
	await startIdle(shutdown);
	await startAcceptedContinuation(shutdown);
	await shutdown.runtime.shutdown(shutdown.ctx);
	assert.equal(shutdown.runtime.consumeDecisionAbortSuppression(), false);
});

test("cancel settlement retires identity before a later ordinary abort", async () => {
	const harness = createHarness({ spliceBehavior: "success" });
	await startIdle(harness);
	await startAcceptedContinuation(harness);
	await harness.unlock();
	await harness.fire("message_start", {
		type: "message_start",
		message: { role: "user", content: [text("queued during abort")] },
	});
	const cancelled = assistant([text("cancelled continuation")], "aborted");
	const replacement = (await harness.endMainMessage(
		cancelled,
	)) as DecisionMessageReplacement;
	assert.equal(
		replacement.message.errorMessage,
		"pi-continue-watchdog:cancelled",
	);
	harness.streaming = false;
	await settleOnly(harness);

	await harness.startUnrelatedRun();
	const ordinaryAbort = assistant([text("ordinary partial output")], "aborted");
	assert.equal(await harness.endMainMessage(ordinaryAbort), undefined);
	assert.equal(harness.runtime.consumeDecisionAbortSuppression(), false);
});

test("genuine user work starting inside a continuation lifecycle clears owned-run cancellation", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await startAcceptedContinuation(harness);
	await harness.fire("message_start", {
		type: "message_start",
		message: { role: "user", content: [text("steering user work")] },
	});

	await harness.unlock();

	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.aborts, 0);
});

test("continuation ownership fails closed on a non-matching first message", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await startAcceptedContinuation(harness, false);
	await harness.fire("message_start", {
		type: "message_start",
		message: { role: "user", content: [text("ordinary work")] },
	});

	await harness.unlock();

	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.aborts, 0);
});

test("idle arms one unref timer and opens one isolated private decision", async () => {
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
	await harness.startDecision();
	assert.equal(harness.privateDriver.children.length, 1);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
	assert.equal(
		harness.privateDriver.forkInputs[0]?.parent,
		harness.ctx.sessionManager,
	);
	assert.equal(harness.privateDriver.forkInputs[0]?.model, "fake/local:off");
	assert.equal(harness.streaming, false);
	assert.equal(harness.triggeredTurns, 0);
	assert.equal(harness.sent.length, 0);
	assert.deepEqual(harness.registeredTools, []);
});

test("trigger status reports real grace and active private state without mutation", async () => {
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
	const before = harness.controller.snapshot;
	assert.equal(harness.runtime.getTriggerStatus().blocker, "decision-open");
	assert.deepEqual(harness.controller.snapshot, before);
	assert.equal(harness.sent.length, 0);
	assert.equal(
		harness.entries.filter((entry) => entry.type === INQUIRY_MARKER_ENTRY_TYPE)
			.length,
		1,
	);
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
	assert.equal(harness.privateDriver.operations.length, 1);
});

test("maximum configured decision prompt opens and corrects inside same private child", async () => {
	const configuredPrompt = "x".repeat(MAX_PROMPT_CHARACTERS);
	const harness = createHarness({
		config: { decisionPrompt: configuredPrompt },
	});
	await startIdle(harness);
	await harness.openDecision();
	const child = harness.privateDriver.children[0];
	assert.ok(child);
	const firstPrompt = child.prompts[0];
	assert.equal(firstPrompt.startsWith(configuredPrompt), true);
	assert.equal(firstPrompt.length > MAX_PROMPT_CHARACTERS, true);
	assert.match(firstPrompt, /watchdog_result_file/);
	assert.doesNotMatch(firstPrompt, /cw function call/);
	await settleResponse(harness, harness.answerInvalid());
	const reask = child.prompts[1];
	assert.equal(reask.includes(configuredPrompt), true);
	assert.equal(reask.length > firstPrompt.length, true);
	assert.match(reask, /previous decision result failed validation/);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.privateDriver.children.length, 1);
	assert.deepEqual(child.fileStates, ["{}", "{}"]);
	assert.equal(harness.sent.length, 0);
});

test("no-history private prompt contains only file contract and configured guidance", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const input = harness.privateDriver.forkInputs[0];
	const prompt = harness.privateDriver.children[0]?.prompts[0] ?? "";
	assert.ok(input);
	assert.ok(
		prompt.startsWith(
			buildDecisionFilePrompt(
				harness.config.decisionPrompt,
				harness.config.reasonTypes,
				harness.config.continueReasonTypes,
				input.resultFile,
			),
		),
	);
	assert.equal(prompt.includes("Previous watchdog results"), false);
	assert.equal(prompt.includes("Source evidence"), false);
	assert.equal(harness.sent.length, 0);
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
		assert.equal(harness.privateDriver.operations.length, 1);
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
		"Continue Watchdog | idle (enabled · alt+u unlock) | asking in 10s",
	]);

	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | running (enabled · alt+u unlock) | root",
	]);

	const child = harness.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "local-child",
		hasUI: false,
		initialBusy: true,
	}).attachment;
	fence.setBusyParticipants(1);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | running (enabled · alt+u unlock) | root + 2 observed subagents",
	]);

	harness.streaming = false;
	await settleOnly(harness);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | running (enabled · alt+u unlock) | 2 observed subagents",
	]);

	harness.hub.markIdle(child);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | running (enabled · alt+u unlock) | 1 observed subagent",
	]);
	fence.setBusyParticipants(0);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | idle (enabled · alt+u unlock) | asking in 10s",
	]);
	assert.deepEqual(widget.render(20), ["CW | idle/on | T-10s"]);
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

test("state row ticks the countdown and switches to asking once the decision opens", async () => {
	const harness = createHarness();
	await startIdle(harness);
	const widget = mountStateStatusWidget(harness);
	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | idle (enabled · alt+u unlock) | asking in 10s",
	]);

	// Grace arms a 1s unref countdown ticker behind the fence timer.
	const graceTimer = harness.clock.records.length - 2;
	const tickTimer = harness.clock.records.length - 1;
	assert.equal(harness.clock.records[graceTimer]?.delayMs, 10_000);
	assert.equal(harness.clock.records[tickTimer]?.delayMs, 1_000);
	assert.equal(harness.clock.records[tickTimer]?.unrefCount, 1);

	harness.clock.fire(tickTimer);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | idle (enabled · alt+u unlock) | asking in 9s",
	]);
	// The ticker re-armed another second while the countdown continues.
	assert.equal(harness.clock.records.at(-1)?.delayMs, 1_000);

	// Fence expiry opens the decision; the row switches to "asking".
	harness.clock.fire(graceTimer);
	await harness.startDecision();
	assert.match(
		widget.render(160).join("").trimEnd(),
		/^Continue Watchdog \| waiting for model · 0s · attempt 1\/3 \| idle \(enabled · alt\+u unlock\) \| asking$/,
	);

	await harness.runtime.shutdown();
});

test("state row names the unlock command when the shortcut is disabled, and no hint while unlocked", async () => {
	const harness = createHarness({ config: { unlockShortcut: false } });
	await startIdle(harness);
	const widget = mountStateStatusWidget(harness);
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | idle (disabled) | none",
	]);

	harness.runtime.applyTransition(harness.controller.lock(), undefined, {
		suppressNotify: true,
	});
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | idle (enabled · /unlock-continue-watchdog) | asking in 10s",
	]);

	harness.runtime.applyTransition(harness.controller.unlock(), undefined, {
		suppressNotify: true,
	});
	assert.deepEqual(widget.render(120), [
		"Continue Watchdog | idle (disabled) | none",
	]);
	await harness.runtime.shutdown();
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

test("private progress row covers admission and idle-parent setup/model elapsed without a second panel", async () => {
	let release = () => {};
	const setup = new Promise<void>((resolve) => {
		release = resolve;
	});
	let harness: Harness;
	harness = createHarness({
		config: { unlockShortcut: "ctrl+x" },
		executePrivateDecision: async (options) => {
			await setup;
			return harness.privateDriver.execute(options);
		},
	});
	try {
		await startIdle(harness);
		await harness.openDecision({ start: false });
		const colors: string[] = [];
		const widget = mountStateStatusWidget(harness, {
			theme: {
				fg: (color, text) => {
					colors.push(color);
					return text;
				},
				bg: (color, text) => {
					colors.push(color);
					return text;
				},
			},
		});
		const admitted = widget.render(180).join("").trimEnd();
		assert.match(admitted, /preparing.*0s/);
		assert.match(admitted, /idle.*enabled.*ctrl\+x unlock/);
		assert.equal(harness.widgetPlacements.size, 1);
		assert.equal(
			harness.widgets.some(
				(widget) => widget.key === "pi-continue-watchdog:status",
			),
			false,
		);
		assert.deepEqual(colors.slice(-2).sort(), ["accent", "toolPendingBg"]);
		const entries = harness.entries.length;
		const requests = widget.renderRequests();
		harness.clock.advance(17_000);
		const tick = harness.clock.records.length - 1;
		assert.equal(harness.clock.records[tick].delayMs, 1000);
		assert.equal(harness.clock.records[tick].unrefCount, 1);
		harness.clock.fire(tick);
		assert.match(widget.render(180).join(""), /preparing.*18s/);
		assert.ok(widget.renderRequests() > requests);
		assert.equal(harness.entries.length, entries);
		assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
		release();
		await harness.startDecision();
		assert.match(widget.render(180).join(""), /waiting for model.*18s.*1\/3/);
		harness.clock.fire(harness.clock.records.length - 1);
		assert.match(widget.render(180).join(""), /waiting for model.*19s/);
		const modelEntries = harness.entries.length;
		const notifications = harness.notifications.length;
		for (let second = 0; second < 60; second += 1) {
			harness.clock.fire(harness.clock.records.length - 1);
		}
		assert.match(widget.render(180).join(""), /waiting for model.*79s/);
		assert.equal(harness.entries.length, modelEntries);
		assert.equal(harness.notifications.length, notifications);
		assert.equal(harness.sent.length, 0);
		await settleResponse(harness, harness.answerUnlock());
		assert.match(widget.render(180).join(""), /idle \(disabled\)/);
		assert.equal(colors.at(-1), "dim");
		assert.equal(harness.clock.records.at(-1)?.cleared, true);
	} finally {
		release();
	}
});

test("private progress row keeps correction 2/3 and publication on one elapsed origin", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const frames: string[] = [];
	const widget = mountStateStatusWidget(harness, {
		onRender: () => frames.push(widget.render(200).join("")),
	});
	harness.clock.advance(18_000);
	await settleResponse(harness, harness.answerInvalid("private invalid body"));
	assert.match(
		widget.render(200).join(""),
		/correcting.*waiting for model.*18s.*2\/3/,
	);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.ok(frames.some((frame) => frame.includes("validating")));
	assert.equal(
		frames.some((frame) => frame.includes("private invalid body")),
		false,
	);
	await settleResponse(harness, harness.answerContinue());
	assert.ok(
		frames.some(
			(frame) => frame.includes("publishing") && frame.includes("18s"),
		),
	);
	assert.equal(harness.privateDriver.children[0].prompts.length, 2);
	assert.equal(harness.triggeredTurns, 1);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.doesNotMatch(
		widget.render(200).join(""),
		/waiting for model|publishing|correcting/,
	);
});

test("private progress row retires a failed continuation send during BUSY without stopping the next countdown", async () => {
	let deferred = false;
	let sends = 0;
	const hooks: string[] = [];
	let harness: Harness;
	harness = createHarness({
		onHook: (name) => hooks.push(name),
		onSend(message) {
			if (
				parseDecisionFoldDetails(message.details)?.watchdogOutcome ===
				"continue"
			) {
				sends += 1;
				harness.pendingMessages = true;
				return new Error("continuation send failed while busy");
			}
			return undefined;
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	const colors: string[] = [];
	const widget = mountStateStatusWidget(harness, {
		onRender() {
			if (!deferred && harness.controller.snapshot.attempt === 1) {
				deferred = true;
				harness.pendingMessages = true;
			}
		},
		theme: {
			fg: (color, text) => {
				colors.push(color);
				return text;
			},
			bg: (color, text) => {
				colors.push(color);
				return text;
			},
		},
	});
	await settleResponse(harness, harness.answerContinue());
	assert.equal(deferred, true, "BUSY defers only after the accepted commit");
	assert.equal(harness.privateDriver.current?.settled, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(sends, 0);
	assert.match(widget.render(200).join(""), /publishing.*1\/3/);
	assert.deepEqual(colors.slice(-2).sort(), ["accent", "toolPendingBg"]);
	const tick = harness.clock.records.at(-1);
	assert.ok(tick);
	assert.equal(tick.delayMs, 1000);
	assert.equal(tick.cleared, false, "pending publication still needs progress");

	harness.pendingMessages = false;
	await settleOnly(harness);
	assert.equal(sends, 1);
	assert.equal(harness.controller.snapshot.attempt, 0, "failed send refunded");
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.triggeredTurns, 0);
	assert.deepEqual(hooks, []);
	assert.doesNotMatch(
		widget.render(200).join(""),
		/publishing|waiting for model/,
	);
	assert.equal(colors.at(-1), "dim");
	assert.equal(tick.cleared, true, "retired publication releases private tick");
	const requests = widget.renderRequests();
	const timers = harness.clock.records.length;
	tick.callback();
	assert.equal(widget.renderRequests(), requests);
	assert.equal(harness.clock.records.length, timers);

	harness.pendingMessages = false;
	await settleOnly(harness);
	harness.runtime.reconcileIdle();
	assert.match(widget.render(200).join(""), /asking in 10s/);
	assert.doesNotMatch(widget.render(200).join(""), /publishing/);
	const countdown = harness.clock.records.findLast(
		(record) => !record.cleared && record.delayMs === 10_000,
	);
	assert.ok(countdown, "ordinary idle fence remains armed");
	const display = harness.clock.records.findLastIndex(
		(record) => !record.cleared && record.delayMs === 1000,
	);
	assert.ok(display >= 0, "ordinary countdown retains its display tick");
	harness.clock.fire(display);
	assert.match(widget.render(200).join(""), /asking in 9s/);
	assert.equal(countdown.cleared, false);
	assert.equal(sends, 1, "retired continuation is not retried");
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.privateDriver.operations.length, 1);
});

test("private progress row stays live in idle-root review and labels one reconsideration", async () => {
	let release = () => {};
	const review = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reviews = 0;
	const harness = createHarness({
		config: { unlockReviewEnabled: true },
		reviewService: {
			async judge() {
				reviews += 1;
				await review;
				return {
					answers: {
						unlock_supported: {
							type: "choice",
							choice: "challenged",
							probabilities: {},
							confidence: 1,
						},
					},
					dropped: [],
					backend: "classifier",
					model: "test",
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				};
			},
		},
	});
	try {
		await startIdle(harness);
		await harness.openDecision();
		const widget = mountStateStatusWidget(harness);
		harness.privateDriver.respond(harness.answerUnlock());
		await waitFor(() => reviews === 1, "expected optional review");
		assert.match(widget.render(200).join(""), /reviewing.*0s.*1\/3/);
		assert.match(widget.render(200).join(""), /idle.*enabled/);
		const entries = harness.entries.length;
		harness.clock.advance(17_000);
		harness.clock.fire(harness.clock.records.length - 1);
		assert.match(widget.render(200).join(""), /reviewing.*18s/);
		assert.equal(harness.entries.length, entries);
		assert.equal(harness.streaming, false);
		release();
		await waitFor(
			() =>
				harness.privateDriver.children[0].prompts.length === 2 &&
				harness.privateDriver.awaitingResponse,
			"expected reconsideration",
		);
		assert.match(
			widget.render(200).join(""),
			/reconsidering.*waiting for model.*18s.*1\/3/,
		);
		await settleResponse(harness, harness.answerInvalid());
		assert.match(
			widget.render(200).join(""),
			/reconsidering.*correcting.*18s.*2\/3/,
		);
		await settleResponse(harness, harness.answerUnlock());
		assert.equal(reviews, 1);
		assert.equal(harness.privateDriver.children.length, 1);
		assert.equal(harness.privateDriver.children[0].prompts.length, 3);
		assert.doesNotMatch(widget.render(200).join(""), /reviewing|reconsidering/);
		assert.equal(harness.clock.records.at(-1)?.cleared, true);
	} finally {
		release();
	}
});

test("private progress row prioritizes stage across resize and redraws current theme", async () => {
	const harness = createHarness({ config: { unlockShortcut: "ctrl+x" } });
	await startIdle(harness);
	let light = false;
	const colors: string[] = [];
	const widget = mountStateStatusWidget(harness, {
		theme: {
			fg: (color, text) => {
				colors.push(color);
				return `\u001b[${light ? 30 : 97}m${text}\u001b[39m`;
			},
			bg: (color, text) => {
				colors.push(color);
				return `\u001b[${light ? 47 : 40}m${text}\u001b[49m`;
			},
		},
	});
	await harness.startUnrelatedRun();
	widget.render(180);
	assert.equal(colors.at(-1), "dim", "root activity is not private work");
	harness.streaming = false;
	await settleOnly(harness);
	harness.runtime.reconcileIdle();
	const grace = harness.clock.records.findLastIndex(
		(record) => !record.cleared && record.delayMs === 10_000,
	);
	harness.clock.fire(grace);
	await harness.startDecision();
	const wide = stripVTControlCharacters(widget.render(200).join("")).trimEnd();
	// Same order as Reflect: identity, then progress, then existing controls.
	assert.match(
		wide,
		/^Continue Watchdog \| waiting for model · \d+s · attempt 1\/3 \| idle \(enabled · ctrl\+x unlock\) \| asking$/,
	);
	assert.match(
		stripVTControlCharacters(widget.render(32).join("")),
		/^CW.*waiting for model/,
	);
	for (const width of [1, 5, 14, 32, 60, 100, 200]) {
		const lines = widget.render(width);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= width);
	}
	const dark = widget.render(200).join("");
	light = true;
	const bright = widget.render(200).join("");
	assert.notEqual(dark, bright);
	assert.equal(stripVTControlCharacters(bright).trimEnd(), wide);
	assert.ok(colors.includes("accent"));
	assert.ok(colors.includes("toolPendingBg"));
});

test("private progress row fences cancellation drain, stale callbacks and successor elapsed", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const widget = mountStateStatusWidget(harness);
	const old = harness.privateDriver.current;
	assert.ok(old);
	let release = () => {};
	const drain = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		harness.privateDriver.respond({
			write: JSON.stringify(continueArgs()),
			hold: drain,
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
		await harness.unlock();
		assert.match(widget.render(200).join(""), /cancelling/);
		harness.clock.advance(17_000);
		harness.clock.fire(harness.clock.records.length - 1);
		assert.match(widget.render(200).join(""), /cancelling.*18s/);
		harness.runtime.applyTransition(harness.controller.lock(), undefined, {
			suppressNotify: true,
		});
		const grace = harness.clock.records.findLastIndex(
			(record) => !record.cleared && record.delayMs === 10_000,
		);
		harness.clock.fire(grace);
		await waitFor(
			() =>
				harness.privateDriver.operations.length === 2 &&
				harness.privateDriver.awaitingResponse,
			"expected successor operation",
		);
		const successor = widget.render(200).join("");
		assert.match(successor, /waiting for model.*0s.*1\/3/);
		old.options.onProgress?.({
			stage: "correcting",
			inquiry: "initial",
			attempt: 3,
			limit: 3,
		});
		release();
		await old.result;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
		assert.equal(widget.render(200).join(""), successor);
		await settleResponse(harness, harness.answerUnlock());
		const requests = widget.renderRequests();
		for (const timer of harness.clock.records) timer.callback();
		assert.equal(
			widget.renderRequests(),
			requests,
			"retired ticks cannot redraw or restart",
		);
		assert.doesNotMatch(
			widget.render(200).join(""),
			/cancelling|waiting for model/,
		);
		assert.equal(harness.aborts, 0);
	} finally {
		release();
	}
});

test("private progress elapsed uses monotonic time, not wall-clock jumps or callback count", async () => {
	const clock = new FakeClock();
	const monotonic = clock.now.bind(clock);
	let wallOffset = 0;
	clock.now = () => monotonic() + wallOffset;
	const harness = createHarness({ clock });
	await startIdle(harness);
	await harness.openDecision();
	const widget = mountStateStatusWidget(harness);
	wallOffset = -60_000;
	clock.advance(17_000);
	clock.fire(clock.records.length - 1);
	assert.match(widget.render(180).join(""), /waiting for model.*18s/);
	wallOffset = 120_000;
	clock.advance(4_000);
	clock.fire(clock.records.length - 1);
	assert.match(widget.render(180).join(""), /waiting for model.*23s/);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(clock.records.at(-1)?.cleared, true);
});

test("private progress setup failure clears highlight and fences late observations", async () => {
	let reject = (_error: Error) => {};
	const setup = new Promise<never>((_resolve, fail) => {
		reject = fail;
	});
	let operation: PrivateDecisionOptions | undefined;
	const harness = createHarness({
		executePrivateDecision: (options) => {
			operation = options;
			return setup;
		},
	});
	try {
		await startIdle(harness);
		await harness.openDecision({ start: false });
		const widget = mountStateStatusWidget(harness);
		assert.match(widget.render(180).join(""), /preparing/);
		reject(new Error("setup failed"));
		await waitFor(
			() => !harness.controller.snapshot.locked,
			"setup failure did not settle",
		);
		assert.doesNotMatch(
			widget.render(180).join(""),
			/preparing|cancelling|waiting for model/,
		);
		assert.equal(harness.clock.records.at(-1)?.cleared, true);
		operation?.onProgress?.({
			stage: "waiting for model",
			inquiry: "initial",
			attempt: 1,
			limit: 3,
		});
		assert.doesNotMatch(widget.render(180).join(""), /waiting for model/);
		assert.equal(harness.triggeredTurns, 0);
	} finally {
		reject(new Error("cleanup"));
	}
});

test("private progress row replaces model waiting with content-free streaming activity", async () => {
	const secret = "watchdog-streaming-sentinel-do-not-render";
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const widget = mountStateStatusWidget(harness);
	assert.match(widget.render(200).join(""), /waiting for model/);

	const child = harness.privateDriver.children[0];
	assert.ok(child);
	const emit = child.emit.bind(child);
	const assistant = { role: "assistant" };
	emit({ type: "message_start", message: assistant });
	assert.match(widget.render(200).join(""), /waiting for model/);

	emit({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: secret },
	});
	// 41 chars so far (secret length) → "41" suffix, frame ⠙ (floor(41/24)=1).
	const thinking = widget.render(200).join("");
	assert.match(thinking, /thinking [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 41/);
	assert.doesNotMatch(thinking, new RegExp(secret));

	emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "x".repeat(1200) },
	});
	const writing = widget.render(200).join("");
	assert.match(writing, /writing/);
	assert.match(writing, /1\.2k/);
	assert.doesNotMatch(writing, /waiting for model/);
	assert.doesNotMatch(writing, new RegExp(secret));

	emit({ type: "message_end" });
	assert.match(widget.render(200).join(""), /waiting for model/);

	await settleResponse(harness, harness.answerInvalid());
	const correcting = widget.render(200).join("");
	assert.match(correcting, /correcting.*2\/3/);
	emit({ type: "message_start", message: assistant });
	emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "y".repeat(30) },
	});
	const correctingStream = widget.render(200).join("");
	assert.match(correctingStream, /correcting/);
	assert.match(correctingStream, /writing/);
	assert.doesNotMatch(correctingStream, /waiting for model/);

	await settleResponse(harness, harness.answerUnlock());
	assert.doesNotMatch(
		widget.render(200).join(""),
		/waiting for model|thinking|writing|correcting/,
	);
	// Late deltas from the finished child cannot repaint.
	emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "late" },
	});
	assert.doesNotMatch(widget.render(200).join(""), /writing|thinking/);
	assert.equal(
		JSON.stringify(
			harness.privateDriver.operations.map((o) => o.options),
		).includes(secret),
		false,
	);
});

test("private progress display failures cannot change validation or accepted publication", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const widget = mountStateStatusWidget(harness, {
		onRender: () => {
			throw new Error("redraw unavailable");
		},
		theme: {
			fg: () => {
				throw new Error("theme unavailable");
			},
			bg: () => {
				throw new Error("theme unavailable");
			},
		},
	});
	assert.deepEqual(widget.render(180), []);
	harness.clock.fire(harness.clock.records.length - 1);
	await settleResponse(harness, harness.answerInvalid());
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(harness.privateDriver.children[0].prompts.length, 2);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(
		harness.entries.filter(
			(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
		).length,
		1,
	);
	assert.equal(
		harness.entries.some(
			(entry) => entry.type === "pi-continue-watchdog:status",
		),
		false,
	);
	assert.equal(harness.clock.records.at(-1)?.cleared, true);
});

for (const replacement of ["session", "owner", "shutdown"] as const) {
	test(`private progress scope clears on ${replacement} replacement and stale component disposal is inert`, async () => {
		const attachmentInstance = createHubAttachmentInstance();
		const harness = createHarness({ attachmentInstance });
		await startIdle(harness);
		await harness.openDecision();
		const oldWidget = mountStateStatusWidget(harness);
		const widget = mountStateStatusWidget(harness);
		oldWidget.dispose();
		assert.match(widget.render(180).join(""), /waiting for model/);
		const old = harness.privateDriver.current;
		assert.ok(old);
		if (replacement === "session") {
			Object.assign(harness.ctx.sessionManager, {
				getSessionId: () => "replacement",
			});
			await harness.fire("session_start", { type: "session_start" });
		} else if (replacement === "owner") {
			const owner = harness.hub.bind({
				instance: attachmentInstance,
				sessionId: "main",
				hasUI: true,
			}).attachment;
			harness.hub.detach(owner);
		} else {
			await harness.runtime.shutdown();
		}
		assert.deepEqual(widget.render(180), []);
		assert.equal(harness.clock.records.at(-1)?.cleared, true);
		old.options.onProgress?.({
			stage: "correcting",
			inquiry: "initial",
			attempt: 3,
			limit: 3,
		});
		assert.deepEqual(widget.render(180), []);
		assert.equal(harness.controller.snapshot.attempt, 0);
	});
}

test("private completion publishes canonical continuation without parent model decision turn", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	assert.equal(harness.widgets.at(-1)?.key, "pi-continue-watchdog:state");
	assert.notEqual(harness.widgets.at(-1)?.value, undefined);
	assert.equal(harness.streaming, false);
	assert.equal(harness.sent.length, 0);
	await settleResponse(harness, harness.answerContinue());
	assert.equal(harness.sent.length, 1);
	assert.equal(harness.sent[0]?.message.customType, DECISION_FOLD_MESSAGE_TYPE);
	assert.deepEqual(harness.sent[0]?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
	const event = parseDecisionFoldDetails(
		harness.sent[0]?.message.details,
	)?.watchdogEvent;
	assert.ok(event?.kind === "continue");
	assert.equal(event.reasonType, "WORK_REMAINS");
	assert.equal(event.reason, "Implementation work remains.");
	assert.equal(
		harness.sent[0]?.message.content,
		formatContinueWatchdogEvent(event, harness.config.continuePrompt),
	);
	assert.equal(harness.triggeredTurns, 1);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(
		harness.branch.some(
			(entry) =>
				entry.customType === DECISION_MESSAGE_TYPE || entry.type === "message",
		),
		false,
	);
	assert.equal(harness.widgetPlacements.size, 1);
	assert.equal(
		harness.widgetPlacements.has("pi-continue-watchdog:state"),
		true,
	);
	assert.equal(
		harness.widgetPlacements.has("pi-continue-watchdog:status"),
		false,
	);
});

test("inquiry prompt carries the bounded source view and marker review metadata", async () => {
	const harness = createHarness();
	await startIdle(harness);
	// Seed effective-context evidence before the inquiry opens.
	harness.branch.push(
		{
			id: "user-1",
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "Deliver the deploy report." }],
			},
		},
		{
			id: "assistant-1",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Report delivered: all checks green." },
				],
			},
		},
	);
	await harness.openDecision({ start: false });

	await harness.startDecision();
	const prompt = harness.privateDriver.children[0]?.prompts[0] ?? "";
	// Supplement follows inherited context inside private prompt; main stays idle.
	assert.match(prompt, /Decide now\./);
	assert.match(prompt, /Source evidence \(bounded excerpts/);
	assert.match(prompt, /Deliver the deploy report\./);
	assert.match(prompt, /Report delivered: all checks green\./);
	assert.equal(harness.sent.length, 0);

	// The marker carries nested versioned review metadata on the same append.
	const marker = harness.entries.find(
		(entry) => entry.type === INQUIRY_MARKER_ENTRY_TYPE,
	);
	assert.ok(marker);
	const data = marker.data as Record<string, unknown>;
	assert.equal(data.version, 1);
	assert.equal(data.exchangeId, "exchange-1");
	const review = data.review as Record<string, unknown>;
	assert.ok(review, "expected nested review metadata on the marker");
	assert.equal(review.version, 1);
	assert.equal(review.projectionVersion, 1);
	assert.equal(typeof review.digest, "string");
	assert.ok(Array.isArray(review.selectedSources));
	const sources = review.selectedSources as Array<{
		id: string;
		provenance: string;
	}>;
	assert.ok(sources.some((source) => source.id === "user-1"));
	assert.ok(sources.some((source) => source.id === "assistant-1"));
	// Source references point at effective-context ids; no excerpt copy.
	assert.equal(JSON.stringify(review).includes("Report delivered"), false);
});

test("new effective source evidence invalidates private operation instead of re-projecting a correction", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.branch.push({
		id: "user-1",
		type: "message",
		message: { role: "user", content: [text("First request.")] },
	});
	await harness.openDecision();
	const child = harness.privateDriver.children[0];
	assert.ok(child);
	harness.branch.push({
		id: "user-2",
		type: "message",
		message: { role: "user", content: [text("Later request for the re-ask.")] },
	});
	await settleResponse(harness, harness.answerInvalid());
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"cancelled",
	);
	assert.equal(child.prompts.length, 1);
	assert.equal(child.aborted, true);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(
		harness.entries.filter((entry) => entry.type === INQUIRY_MARKER_ENTRY_TYPE)
			.length,
		1,
	);
	assert.equal(
		harness.sent.some((entry) => entry.options?.triggerTurn),
		false,
	);
});

test("private lifecycle audit carries bounded review association of its exchange", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.branch.push({
		id: "user-1",
		type: "message",
		message: { role: "user", content: [text("Do the work.")] },
	});
	await harness.openDecision();
	await settleResponse(harness, harness.answerUnlock("Done.", "JOB_DONE"));
	const audit = harness.entries.find(
		(entry) => entry.type === "pi-continue-watchdog:private-decision",
	);
	assert.ok(audit);
	const data = audit.data as Record<string, unknown>;
	const marker = harness.entries.find(
		(entry) => entry.type === INQUIRY_MARKER_ENTRY_TYPE,
	);
	assert.ok(marker);
	assert.deepEqual(
		data.review,
		(marker.data as Record<string, unknown>).review,
	);
	assert.equal(data.exchangeId, "exchange-1");
	assert.equal(
		data.childSessionId,
		harness.privateDriver.children[0]?.sessionId,
	);
	assert.equal(data.phase, "started");
	assert.equal(JSON.stringify(data.review).includes("Do the work."), false);
	assert.equal(harness.controller.snapshot.locked, false);
});

test("history gap is reported once, attributed to the affected exchange", async () => {
	const harness = createHarness();
	await startIdle(harness);
	harness.branch.push({
		id: "user-1",
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "Work." }] },
	});
	// A published unlock whose response audit is missing: a genuine gap.
	const inquiry = {
		version: 1,
		namespace: "pi-continue-watchdog",
		inquiryId: "gap-exchange",
		attempt: 1,
	};
	harness.branch.push(
		{
			id: "gap-marker",
			type: "custom",
			customType: INQUIRY_MARKER_ENTRY_TYPE,
			data: {
				version: 1,
				exchangeId: "gap-exchange",
				cycleId: 1,
				review: { version: 1, projectionVersion: 1 },
			},
		},
		{
			id: "gap-prompt",
			type: "custom_message",
			customType: DECISION_MESSAGE_TYPE,
			details: inquiry,
		},
		{
			id: "gap-fold",
			type: "custom_message",
			customType: DECISION_FOLD_MESSAGE_TYPE,
			details: {
				...inquiry,
				outcome: "remove",
				watchdogOutcome: "continue",
			},
		},
		// A later legacy exchange without review metadata is not a gap.
		{
			id: "later-marker",
			type: "custom",
			customType: INQUIRY_MARKER_ENTRY_TYPE,
			data: { version: 1, exchangeId: "later-exchange", cycleId: 1 },
		},
	);
	const historyCards = () =>
		harness.entries.filter((entry) =>
			JSON.stringify(entry.data).includes("Review history incomplete: some"),
		);
	await harness.openDecision();
	// Correction uses same child and unchanged bounded source supplement.
	const invalid = harness.answerInvalid();
	await settleResponse(harness, invalid);
	assert.equal(
		harness.entries.filter((entry) => entry.type === INQUIRY_MARKER_ENTRY_TYPE)
			.length,
		1,
	);
	const cards = historyCards();
	assert.equal(cards.length, 1);
	assert.equal(
		(cards[0].data as { exchangeId?: string }).exchangeId,
		"gap-exchange",
	);
});

test("view-build failure reports unavailable supplement without blocking private dispatch", async () => {
	const harness = createHarness({ contextEntriesThrows: true });
	await startIdle(harness);
	await harness.openDecision();
	const prompt = harness.privateDriver.children[0]?.prompts[0] ?? "";
	assert.equal(prompt.includes("Source evidence"), false);
	const marker = harness.entries.find(
		(entry) => entry.type === INQUIRY_MARKER_ENTRY_TYPE,
	);
	assert.ok(marker);
	assert.equal(
		Object.hasOwn(marker.data as Record<string, unknown>, "review"),
		false,
	);
	assert.ok(
		harness.entries.some((entry) =>
			JSON.stringify(entry.data).includes("Review source view unavailable"),
		),
	);
	assert.equal(
		harness.privateDriver.forkInputs[0]?.parent,
		harness.ctx.sessionManager,
	);
	assert.equal(harness.sent.length, 0);
});

test("private audit persistence failure keeps published outcome behavior unchanged", async () => {
	const harness = createHarness({
		appendThrows: "pi-continue-watchdog:private-response",
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(harness.triggeredTurns, 1);
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.deepEqual(harness.notifications, [
		{ message: "Private decision history incomplete.", level: "warning" },
	]);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
});

test("review diagnostic reentrancy defers without leaving an open decision", async () => {
	let harness: Harness;
	harness = createHarness({
		contextEntriesThrows: true,
		onAppend(type) {
			if (type === "pi-continue-watchdog:status") harness.streaming = true;
		},
	});
	await startIdle(harness);
	await harness.openDecision({ start: false });
	assert.equal(harness.triggeredTurns, 0);
	assert.equal(
		harness.controller.snapshot.decisionOpen,
		false,
		JSON.stringify({
			entries: harness.entries,
			streaming: harness.streaming,
			snapshot: harness.controller.snapshot,
		}),
	);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
});

test("inquiry marker persists before first private child prompt", async () => {
	const timeline: string[] = [];
	const harness = createHarness({
		onAppend(type) {
			if (type === INQUIRY_MARKER_ENTRY_TYPE) timeline.push("marker");
		},
	});
	harness.privateDriver.onPrompt(() => timeline.push("private-prompt"));
	await startIdle(harness);
	await harness.openDecision();
	assert.deepEqual(timeline, ["marker", "private-prompt"]);
	assert.deepEqual(harness.entries[0], {
		type: INQUIRY_MARKER_ENTRY_TYPE,
		data: { version: 1, exchangeId: "exchange-1", cycleId: 1 },
	});
	assert.equal(harness.sent.length, 0);
});

test("optional inquiry marker failure warns without gating a private file decision", async () => {
	const harness = createHarness({ appendThrows: INQUIRY_MARKER_ENTRY_TYPE });
	// A qualified decision already has parent context, independently of its audit marker.
	harness.branch.push({
		id: "existing-source",
		type: "message",
		message: {
			role: "user",
			content: "Existing authorized task.",
			timestamp: 1,
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	assert.equal(harness.privateDriver.operations.length, 1);
	assert.equal(
		harness.sent.length,
		0,
		"no parent inquiry is sent after an audit failure",
	);
	assert.ok(
		harness.notifications.some(
			(notice) =>
				notice.level === "warning" &&
				notice.message === "Private decision history incomplete.",
		),
	);
	await settleResponse(
		harness,
		harness.answerUnlock("Delivery confirmed.", "JOB_DONE"),
	);
	assert.equal((await harness.privateDriver.current?.result)?.kind, "decision");
	assert.equal(harness.privateDriver.children.length, 1);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
	assert.equal(
		harness.sent.some((entry) => entry.options?.triggerTurn),
		false,
	);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
});

test("marker-boundary parent busy race defers private decision silently", async () => {
	let harness: Harness;
	harness = createHarness({
		onAppend(type) {
			if (type === INQUIRY_MARKER_ENTRY_TYPE) {
				harness.streaming = true;
				void harness.fire("agent_start", { type: "agent_start" });
			}
		},
	});
	await startIdle(harness);
	await harness.openDecision({ start: false });
	if (harness.privateDriver.current)
		await settlePrivateDecision(harness.privateDriver);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.privateDriver.children.length, 0);
	assert.equal(
		harness.entries.some(
			(entry) =>
				entry.type === "pi-continue-watchdog:status" &&
				(entry.data as { kind?: string }).kind === "other-error",
		),
		false,
	);
});

test("unrelated custom-entry persistence failures do not split continue evidence", async () => {
	const harness = createHarness({ appendThrows: "unrelated-entry" });
	await startIdle(harness);
	await harness.openDecision();
	const sentBefore = harness.sent.length;

	await settleResponse(harness, harness.answerContinue());

	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(harness.sent.length, sentBefore + 1);
	assert.equal(harness.triggeredTurns, 1);
	assert.equal(harness.sent.at(-1)?.message.display, true);
});

test("maximum configured guidance and unlock type survive shared publication", async () => {
	const maximumGuidance = "g".repeat(MAX_PROMPT_CHARACTERS);
	const continued = createHarness({
		config: { continuePrompt: maximumGuidance },
	});
	await startIdle(continued);
	await continued.openDecision();
	await settleResponse(continued, continued.answerContinue());
	const continueFold = continued.sent.findLast(
		(entry) => entry.message.customType === DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.ok(continueFold);
	assert.equal(continued.controller.snapshot.attempt, 1);
	assert.equal(continueFold.message.content.includes(maximumGuidance), true);

	const maximumReasonType = "T".repeat(MAX_PROMPT_CHARACTERS - 384);
	const unlocked = createHarness({
		config: { reasonTypes: [maximumReasonType] },
	});
	await startIdle(unlocked);
	await unlocked.openDecision();
	await settleResponse(unlocked, unlocked.answerUnlock("x", maximumReasonType));
	const unlockFold = unlocked.sent.findLast(
		(entry) => entry.message.customType === DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.ok(unlockFold);
	assert.equal(unlocked.controller.snapshot.locked, false);
	// The maximum unlock type survives into the quiet UI-only status entry;
	// the fold itself stays remove-only with no model-bound body.
	const statusEntries = unlocked.entries.filter(
		(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
	);
	assert.equal(statusEntries.length, 1);
	assert.equal(
		(statusEntries[0]?.data as { readonly reasonType?: string } | undefined)
			?.reasonType,
		maximumReasonType,
	);
});

test("the visible shared fold is the continue evidence and dispatch", async () => {
	const timeline: string[] = [];
	const harness = createHarness({
		onSend(message) {
			if (message.customType === DECISION_FOLD_MESSAGE_TYPE) {
				timeline.push(message.display ? "visible-shared-fold" : "hidden-fold");
			}
			return undefined;
		},
	});
	await startIdle(harness);
	await harness.openDecision();

	await settleResponse(harness, harness.answerContinue());

	assert.deepEqual(timeline, ["visible-shared-fold"]);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(harness.triggeredTurns, 1);
});

for (const spliceBehavior of [
	"success",
	"false",
	"throw",
	"absent",
	"branch-throw",
	"unrelated-assistant",
] as const) {
	test(`private decision needs no assistant splicing when splice API is ${spliceBehavior}`, async () => {
		let branchUnavailable = false;
		const harness = createHarness({
			spliceBehavior:
				spliceBehavior === "branch-throw" ||
				spliceBehavior === "unrelated-assistant"
					? "success"
					: spliceBehavior,
			onReadBranch() {
				if (branchUnavailable) throw new Error("branch unavailable");
			},
			onSend(message) {
				if (
					spliceBehavior === "branch-throw" &&
					message.customType === DECISION_FOLD_MESSAGE_TYPE
				)
					branchUnavailable = true;
				return undefined;
			},
			appendUnrelatedAssistantBeforeFold:
				spliceBehavior === "unrelated-assistant",
		});
		await startIdle(harness);
		await harness.openDecision();
		await settleResponse(
			harness,
			harness.answerUnlock("Waiting for approval.", "WAIT_USER"),
		);
		assert.equal(harness.controller.snapshot.locked, false);
		assert.deepEqual(harness.spliceAttempts, []);
		assert.equal(
			harness.branch.some(
				(entry) => entry.customType === DECISION_MESSAGE_TYPE,
			),
			false,
		);
		assert.equal(
			harness.branch.filter((entry) => entry.type === "message").length,
			spliceBehavior === "unrelated-assistant" ? 1 : 0,
		);
		const turns = harness.triggeredTurns;
		branchUnavailable = false;
		await settleOnly(harness);
		assert.equal(harness.triggeredTurns, turns);
		const fold = parseDecisionFoldDetails(harness.sent.at(-1)?.message.details);
		assert.equal(fold?.watchdogOutcome, "unlock");
		assert.equal(fold?.outcome, "remove");
		assert.equal(fold?.replacement, undefined);
		assert.equal(
			harness.entries.filter(
				(entry) => entry.type === "pi-continue-watchdog:private-response",
			).length,
			1,
		);
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

test("private continue leaves no assistant cleanup at later settled boundaries", async () => {
	const harness = createHarness({ spliceBehavior: "success" });
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.deepEqual(harness.spliceAttempts, []);
	assert.equal(
		harness.branch.some(
			(entry) =>
				entry.type === "message" || entry.customType === DECISION_MESSAGE_TYPE,
		),
		false,
	);
	const count = harness.sent.length;
	await settleOnly(harness);
	assert.deepEqual(harness.spliceAttempts, []);
	assert.equal(harness.sent.length, count);
});

test("private continue audit retains normalized validated candidate without file traffic", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerRaw(continueArgs("verifying", "Tests still need to run.")),
	);
	const audit = harness.entries.find(
		(entry) => entry.type === "pi-continue-watchdog:private-response",
	);
	assert.ok(audit);
	const data = audit.data as {
		version: number;
		sessionId: string;
		attempt: number;
		outcome: {
			kind: string;
			decision: { kind: string; reasonType: string; reason: string };
		};
	};
	assert.equal(data.version, 1);
	assert.equal(data.sessionId, harness.privateDriver.children[0]?.sessionId);
	assert.equal(data.attempt, 1);
	assert.equal(data.outcome.kind, "valid");
	assert.equal(data.outcome.decision.kind, "continue");
	assert.equal(data.outcome.decision.reasonType, "VERIFYING");
	assert.equal(data.outcome.decision.reason, "Tests still need to run.");
	assert.equal(
		JSON.stringify(harness.entries).includes(
			harness.privateDriver.forkInputs[0].resultFile,
		),
		false,
	);
	assert.equal(
		harness.branch.some((entry) => entry.type === "message"),
		false,
	);
});

test("private unlock persists context-excluded response and one quiet status, never parent assistant", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerUnlock("Waiting for approval.", "WAIT_USER"),
	);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(
		harness.entries.filter(
			(entry) => entry.type === "pi-continue-watchdog:private-response",
		).length,
		1,
	);
	assert.deepEqual(harness.entries.at(-1), {
		type: "pi-continue-watchdog:ai-unlock",
		data: {
			reasonType: "WAIT_USER",
			reason: "Waiting for approval.",
			exchangeId: "exchange-1",
			cycleId: 1,
		},
	});
	assert.equal(harness.sent.at(-1)?.message.display, false);
	assert.equal(
		harness.branch.some(
			(entry) =>
				entry.type === "message" || entry.customType === DECISION_MESSAGE_TYPE,
		),
		false,
	);
	assert.deepEqual(harness.notifications, []);
	const contextMessages = harness.branch
		.filter((entry) => entry.type === "custom_message")
		.map((entry) => ({
			role: "custom",
			customType: entry.customType,
			content: "",
			details: entry.details,
			timestamp: 1,
		}));
	assert.deepEqual(foldDecisionContext(contextMessages), []);
});

test("private generation remains provisional until its single prompt settles", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const before = harness.controller.snapshot;
	assert.equal(harness.privateDriver.current?.settled, false);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.controller.snapshot, before);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
	assert.equal(
		harness.entries.some(
			(entry) => entry.type === "pi-continue-watchdog:private-response",
		),
		false,
	);
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
	assert.equal(harness.triggeredTurns, 0);
});

test("each invalid JSON file response records safe private diagnostic and updates checking", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerInvalid("not JSON"));
	const audit = harness.entries.findLast(
		(entry) => entry.type === "pi-continue-watchdog:private-response",
	);
	assert.ok(audit);
	const data = audit.data as {
		attempt: number;
		outcome: { kind: string; error: string };
	};
	assert.equal(data.attempt, 1);
	assert.equal(data.outcome.kind, "invalid");
	assert.match(data.outcome.error, /JSON/);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.notEqual(harness.widgets.at(-1)?.value, undefined);
	assert.equal(harness.sent.length, 0);
});

test("private in-flight provider work consumes neither format nor continuation budget", async () => {
	const harness = createHarness({ nativeAbortGate: true });
	await startIdle(harness);
	await harness.openDecision();
	const before = harness.controller.snapshot;
	const entries = harness.entries.length;
	for (let turn = 0; turn < 3; turn += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(harness.controller.snapshot, before);
		assert.equal(harness.entries.length, entries);
		assert.equal(harness.sent.length, 0);
		assert.deepEqual(harness.notifications, []);
		assert.equal(harness.streaming, false);
	}
	await settleResponse(harness, harness.answerUnlock("Done.", "JOB_DONE"));
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
});

test("private terminal provider error unlocks without format correction or continuation", async () => {
	const harness = createHarness({ nativeAbortGate: true });
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, {
		stopReason: "error",
		errorMessage: "Connection error.",
	});
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"execution-error",
	);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
	assert.equal(harness.triggeredTurns, 0);
	assert.equal(
		harness.entries.filter(
			(entry) => entry.type === "pi-continue-watchdog:private-response",
		).length,
		0,
	);
	assert.ok(
		harness.entries.some((entry) =>
			JSON.stringify(entry.data).includes("Private decision execution failed"),
		),
	);
	await settleOnly(harness);
	assert.equal(harness.privateDriver.operations.length, 1);
});

test("private terminal provider error discloses the verified retained session path once", async (t) => {
	const dir = await mkdtemp("/var/tmp/watchdog-evidence-");
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sessionFile = join(dir, "child-session.jsonl");
	await writeFile(sessionFile, "{}", { mode: 0o600 });
	const harness = createHarness({ privateSessionFile: sessionFile });
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, {
		stopReason: "error",
		errorMessage: "Connection error with RAW_PROVIDER_BODY",
	});
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"execution-error",
	);
	assert.equal(harness.notifications.length, 1);
	const notice = harness.notifications[0];
	assert.equal(notice?.level, "warning");
	assert.match(
		notice?.message ?? "",
		new RegExp(
			`^Continue watchdog failed: the private decision inquiry ended in an execution error\\.\\nPrivate session JSONL retained: ${sessionFile}$`,
		),
	);
	assert.equal(notice?.message.includes("RAW_PROVIDER_BODY"), false);
	await settleOnly(harness);
	assert.equal(harness.notifications.length, 1);
	assert.equal(harness.controller.snapshot.locked, false);
});

test("private execution error before any session reports no retained evidence", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, { throw: new Error("provider gone") });
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"execution-error",
	);
	assert.equal(harness.notifications.length, 1);
	assert.match(
		harness.notifications[0]?.message ?? "",
		/No private session was created; nothing was retained\./,
	);
});

test("private execution error with unverifiable evidence reports the bounded reason", async (t) => {
	const dir = await mkdtemp("/var/tmp/watchdog-evidence-");
	t.after(() => rm(dir, { recursive: true, force: true }));
	const missing = join(dir, "deleted-session.jsonl");
	const harness = createHarness({ privateSessionFile: missing });
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, { throw: new Error("provider gone") });
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"execution-error",
	);
	assert.equal(harness.notifications.length, 1);
	assert.match(
		harness.notifications[0]?.message ?? "",
		/Private session evidence unavailable \(missing\)\./,
	);
	assert.equal(harness.notifications[0]?.message.includes(missing), false);
});

test("private decision-failed appends the retained session path to its one warning", async (t) => {
	const dir = await mkdtemp("/var/tmp/watchdog-evidence-");
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sessionFile = join(dir, "child-session.jsonl");
	await writeFile(sessionFile, "{}", { mode: 0o600 });
	const harness = createHarness({ privateSessionFile: sessionFile });
	await startIdle(harness);
	await harness.openDecision();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await settleResponse(harness, harness.answerInvalid());
	}
	assert.equal(harness.controller.snapshot.decisionFailed, true);
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"decision-failed",
	);
	assert.equal(harness.notifications.length, 1);
	const notice = harness.notifications[0];
	assert.equal(notice?.level, "warning");
	assert.match(notice?.message ?? "", /decision failed after 3 attempts/);
	assert.match(
		notice?.message ?? "",
		new RegExp(`\\nPrivate session JSONL retained: ${sessionFile}$`),
	);
	await settleOnly(harness);
	assert.equal(harness.notifications.length, 1);
	assert.equal(harness.privateDriver.children.length, 1);
});

test("failed reconsideration discloses the same single child's session", async (t) => {
	const dir = await mkdtemp("/var/tmp/watchdog-evidence-");
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sessionFile = join(dir, "child-session.jsonl");
	await writeFile(sessionFile, "{}", { mode: 0o600 });
	const harness = createHarness({
		privateSessionFile: sessionFile,
		config: { unlockReviewEnabled: true },
		reviewService: {
			async judge() {
				return {
					answers: {
						unlock_supported: {
							type: "choice",
							choice: "challenged",
							probabilities: {},
							confidence: 1,
						},
					},
					dropped: [],
					backend: "classifier",
					model: "test",
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				};
			},
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerUnlock());
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await settleResponse(harness, harness.answerInvalid());
	}
	const result = await harness.privateDriver.current?.result;
	assert.equal(result?.kind, "decision-failed");
	if (result?.kind === "decision-failed")
		assert.equal(result.reconsidered, true);
	assert.equal(harness.controller.snapshot.decisionFailed, true);
	assert.equal(harness.privateDriver.children.length, 1);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 4);
	assert.equal(harness.notifications.length, 1);
	assert.match(
		harness.notifications[0]?.message ?? "",
		new RegExp(`\\nPrivate session JSONL retained: ${sessionFile}$`),
	);
});

test("a session notice that cannot notify still completes failure recovery", async (t) => {
	const dir = await mkdtemp("/var/tmp/watchdog-evidence-");
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sessionFile = join(dir, "child-session.jsonl");
	await writeFile(sessionFile, "{}", { mode: 0o600 });
	const harness = createHarness({
		privateSessionFile: sessionFile,
		onNotify: () => {
			throw new Error("notify exploded");
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, { throw: new Error("provider gone") });
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"execution-error",
	);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.privateDriver.children[0]?.disposed, true);
	assert.ok(
		harness.entries.some((entry) =>
			JSON.stringify(entry.data).includes("Private decision execution failed"),
		),
	);
});

test("private invalid-file audit never retains raw malformed output", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerInvalid("private malformed watchdog answer"),
	);
	assert.equal(
		JSON.stringify(harness.entries).includes("private malformed"),
		false,
	);
	assert.equal(
		harness.entries.filter(
			(entry) => entry.type === "pi-continue-watchdog:private-response",
		).length,
		1,
	);
	assert.equal(
		harness.branch.some((entry) => entry.type === "message"),
		false,
	);
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
});

test("parent assistant JSON cannot authorize private outcome", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const answer = assistant([text(JSON.stringify(unlockArgs()))]);
	assert.equal(await harness.endMainMessage(answer), undefined);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.privateDriver.current?.settled, false);
	assert.equal(
		harness.entries.some(
			(entry) => entry.type === "pi-continue-watchdog:private-response",
		),
		false,
	);
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"cancelled",
	);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
});

test("private pending inquiries preserve ordinary parent tools and assistant output", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision({ start: false });
	await harness.startDecision();
	assert.equal(await harness.blockToolCall(), undefined);
	const answer = assistant([text("Ordinary work is still in progress.")]);
	assert.equal(await harness.endMainMessage(answer), undefined);
	await harness.fire("agent_end", { type: "agent_end", messages: [answer] });
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.decisionFailed, false);
	assert.equal(harness.controller.snapshot.locked, true);
});

test("legacy parent inquiry context grants no private response authority", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await harness.fire("context", {
		type: "context",
		messages: [
			{
				role: "custom",
				...createDecisionPromptMessage({
					exchangeId: "foreign",
					cycleId: 1,
					decisionPrompt: "stale decision",
				}),
				timestamp: 1,
			},
		],
	});
	assert.equal(harness.privateDriver.current?.settled, false);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.registeredTools, []);
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
});

test("parent context projection cannot consume private file response", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await harness.fire("context", { type: "context", messages: [] });
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.privateDriver.current?.settled, false);
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(harness.controller.snapshot.locked, false);
});

test("exact private file owner supplies one terminal result", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const operation = harness.privateDriver.current;
	assert.ok(operation);
	await settleResponse(harness, harness.answerUnlock());
	const result = await operation.result;
	assert.equal(result.kind, "decision");
	assert.ok("sessionId" in result);
	assert.equal(result.sessionId, harness.privateDriver.children[0]?.sessionId);
	assert.equal(harness.controller.snapshot.locked, false);
	const sent = harness.sent.length;
	await settleOnly(harness);
	assert.equal(harness.sent.length, sent);
	assert.equal(
		harness.entries.filter(
			(entry) => entry.type === "pi-continue-watchdog:private-response",
		).length,
		1,
	);
});

test("private runner duplicate-write diagnostic counts once without accepting file", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, {
		...harness.answerUnlock(),
		attemptError: "Duplicate writes rejected before execution.",
	});
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 2);
	assert.equal(harness.sent.length, 0);
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.privateDriver.children.length, 1);
});

test("private runner malformed-transport diagnostics do not execute main tools", async () => {
	for (const error of [
		"Invalid write arguments.",
		"Unknown tool rejected.",
		"Mixed tool batch rejected.",
		"Truncated response.",
	]) {
		const harness = createHarness();
		await startIdle(harness);
		await harness.openDecision();
		await settleResponse(harness, { attemptError: error });
		assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(harness.controller.snapshot.locked, true);
		assert.equal(harness.privateDriver.children[0]?.prompts.length, 2);
		assert.equal(harness.sent.length, 0);
		assert.deepEqual(harness.registeredTools, []);
	}
});

test("private decision never blocks ordinary parent tool_call", async () => {
	const harness = createHarness();
	await startIdle(harness);
	assert.equal(await harness.blockToolCall(), undefined);
	await harness.openDecision();
	assert.equal(await harness.blockToolCall(), undefined);
	assert.deepEqual(harness.registeredTools, []);
	await settleResponse(harness, harness.answerContinue());
	assert.equal(await harness.blockToolCall(), undefined);
});

test("continued settle rearms the fixed delay once and exhausts at max", async () => {
	const harness = createHarness({ config: { maxContinue: 2 } });
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
	const exhaustedEvents = harness.sent.filter(
		(entry) => entry.message.customType === "pi-continue-watchdog:event",
	);
	assert.equal(exhaustedEvents.length, 1);
	assert.equal(exhaustedEvents[0]?.message.display, true);
	assert.match(
		exhaustedEvents[0]?.message.content ?? "",
		/Continue watchdog exhausted · /,
	);
	assert.deepEqual(exhaustedEvents[0]?.options, {
		triggerTurn: false,
		deliverAs: "steer",
	});
});

test("an unreadable receipt does not refund an already persisted outcome", async () => {
	for (const outcome of ["continue"] as const) {
		let sent = false;
		const harness = createHarness({
			onSend(message) {
				if (
					parseDecisionFoldDetails(message.details)?.watchdogOutcome === outcome
				)
					sent = true;
				return undefined;
			},
			onReadBranch() {
				if (sent) throw new Error("receipt temporarily unavailable");
			},
		});
		await startIdle(harness);
		await harness.openDecision();
		await settleResponse(harness, harness.answerContinue());
		assert.ok(
			harness.branch.some(
				(entry) =>
					parseDecisionFoldDetails(entry.details)?.watchdogOutcome === outcome,
			),
		);
		await harness.fire("context", { type: "context", messages: [] });
		harness.runtime.clearOperationalPendingWork();
		assert.equal(harness.controller.snapshot.attempt, 1, outcome);
	}
});

test("exhaustion event is one-shot under same-idle publication re-entry", async () => {
	let harness: Harness;
	let reentered = false;
	harness = createHarness({
		config: { maxContinue: 1 },
		onSend(message) {
			if (
				!reentered &&
				(message.details as { readonly kind?: unknown } | undefined)?.kind ===
					"exhausted"
			) {
				reentered = true;
				void harness.fire("agent_settled", { type: "agent_settled" });
			}
			return undefined;
		},
	});

	await exhaustAfterOneContinue(harness);
	await Promise.resolve();
	assert.equal(reentered, true);
	assert.equal(
		harness.sent.filter(
			(entry) =>
				(entry.message.details as { readonly kind?: unknown } | undefined)
					?.kind === "exhausted",
		).length,
		1,
	);
});

test("successful exhaustion publication survives a busy re-entrant edge", async () => {
	let harness: Harness;
	let interrupted = false;
	harness = createHarness({
		config: { maxContinue: 1 },
		onSend(message) {
			if (
				!interrupted &&
				(message.details as { readonly kind?: unknown } | undefined)?.kind ===
					"exhausted"
			) {
				interrupted = true;
				harness.streaming = true;
				void harness.fire("agent_start", { type: "agent_start" });
			}
			return undefined;
		},
	});

	await exhaustAfterOneContinue(harness);
	assert.equal(interrupted, true);
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(
		harness.sent.filter(
			(entry) =>
				(entry.message.details as { readonly kind?: unknown } | undefined)
					?.kind === "exhausted",
		).length,
		1,
	);
});

test("retired wait submission consumes no attempt, arms no deadline, and re-asks once", async () => {
	const harness = createHarness({ config: { maxContinue: 1 } });
	await startIdle(harness);
	await harness.openDecision();
	const sentBefore = harness.sent.length;
	await settleResponse(harness, harness.answerWait(300, "Waiting for CI."));

	// One invalid response: no attempt, no deadline, no wait fold, no timer.
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.exhausted, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(
		harness.sent.some(
			(entry) =>
				parseDecisionFoldDetails(entry.message.details)?.watchdogOutcome ===
				"wait",
		),
		false,
	);
	assert.equal(
		harness.clock.records.some(
			(record) => record.delayMs === 300_000 && !record.cleared,
		),
		false,
	);
	// Correction stays in child; no main dispatch.
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 2);
});

test("three retired wait submissions decision-fail and request no fourth response", async () => {
	const hooks: string[] = [];
	const harness = createHarness({ onHook: (name) => hooks.push(name) });
	await startIdle(harness);
	await harness.openDecision();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await settleResponse(harness, harness.answerWait(60, `wait ${attempt}`));
	}
	assert.equal(harness.controller.snapshot.decisionFailed, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(hooks.includes("watchdog-waiting"), false);
	assert.ok(hooks.includes("user-ready"));
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 3);
	assert.equal(harness.privateDriver.children.length, 1);
	await settleOnly(harness);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 3);
	assert.equal(harness.privateDriver.operations.length, 1);
});

test("valid unlock folds remove-only and leaves one quiet UI-only status", async () => {
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
	// The fold is remove-only: no model-bound replacement body or unlock event.
	const fold = parseDecisionFoldDetails(harness.sent.at(-1)?.message.details);
	assert.equal(fold?.watchdogOutcome, "unlock");
	assert.equal(fold?.outcome, "remove");
	assert.equal(fold?.replacement, undefined);
	assert.equal(fold?.watchdogEvent, undefined);
	assert.equal(harness.sent.at(-1)?.message.display, false);
	// Exactly one quiet UI-only status entry carries the typed outcome.
	const statusEntries = harness.entries.filter(
		(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
	);
	assert.deepEqual(statusEntries, [
		{
			type: "pi-continue-watchdog:ai-unlock",
			data: {
				reasonType: "JOB_DONE",
				reason: "waiting for user",
				exchangeId: "exchange-1",
				cycleId: 1,
			},
		},
	]);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.deepEqual(harness.notifications, []);
});

test("Example 7: AI unlock persists typed entry data only; no transient notification", async () => {
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
				entry.type !== INQUIRY_MARKER_ENTRY_TYPE &&
				entry.type !== "pi-continue-watchdog:private-decision" &&
				entry.type !== "pi-continue-watchdog:private-response" &&
				entry.type !== "pi-continue-watchdog:ai-unlock",
		),
		[],
	);
	assert.deepEqual(
		harness.entries.filter(
			(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
		),
		[
			{
				type: "pi-continue-watchdog:ai-unlock",
				data: {
					reasonType: "NEEDREVIEW",
					reason: "PR is open for human review.",
					exchangeId: "exchange-1",
					cycleId: 1,
				},
			},
		],
	);
	assert.deepEqual(harness.notifications, []);
});

test("terminal publication requires receipts and recovers without model work or duplicate records", async () => {
	for (const kind of ["unlock", "decision-failed", "exhausted"]) {
		for (const fault of ["absent", "unreadable"]) {
			let failing = true;
			let unreadable = false;
			const hooks: string[] = [];
			const eventKind = (details: unknown) => {
				const fold = parseDecisionFoldDetails(details);
				return (
					fold?.watchdogEvent?.kind ??
					fold?.watchdogOutcome ??
					(details as { kind?: string } | undefined)?.kind
				);
			};
			const harness = createHarness({
				config: { maxContinue: 1 },
				omitPersistedEvent: (value) =>
					failing && fault === "absent" && value === kind,
				onSend(message) {
					if (
						failing &&
						fault === "unreadable" &&
						eventKind(message.details) === kind
					)
						unreadable = true;
					return undefined;
				},
				onReadBranch() {
					if (unreadable) throw new Error("receipt unavailable");
				},
				onHook: (name) => hooks.push(name),
			});
			await startIdle(harness);
			await harness.openDecision();
			if (kind === "unlock")
				await settleResponse(harness, harness.answerUnlock());
			else if (kind === "decision-failed") {
				for (let i = 0; i < 3; i++)
					await settleResponse(harness, harness.answerInvalid());
			} else {
				// Exhaustion arrives after the final continuation settles.
				await settleResponse(harness, harness.answerContinue());
				harness.streaming = true;
				await harness.fire("agent_start", { type: "agent_start" });
				harness.streaming = false;
				await settleOnly(harness);
			}
			const label = `${kind}/${fault}`;
			assert.equal(hooks.includes("user-ready"), false, label);
			assert.equal(
				harness.controller.snapshot.locked,
				kind !== "unlock",
				label,
			);
			assert.equal(
				harness.controller.snapshot.decisionFailed,
				kind === "decision-failed",
				label,
			);
			const before = harness.controller.snapshot;
			const turns = harness.triggeredTurns;
			const original = harness.sent.find(
				(entry) => eventKind(entry.message.details) === kind,
			);
			assert.ok(original, label);
			failing = false;
			unreadable = false;
			await settleOnly(harness);
			await settleOnly(harness);
			assert.deepEqual(harness.controller.snapshot, before, label);
			assert.equal(harness.triggeredTurns, turns, label);
			assert.equal(
				hooks.filter((name) => name === "user-ready").length,
				1,
				label,
			);
			if (kind === "unlock") {
				// Two ordered artifacts: one remove-only fold and one quiet
				// UI-only status entry; no model-bound unlock event exists.
				assert.equal(
					harness.branch.filter(
						(entry) =>
							entry.type === "custom_message" &&
							eventKind(entry.details) === "unlock",
					).length,
					1,
					label,
				);
				const statusEntries = harness.branch.filter(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "pi-continue-watchdog:ai-unlock",
				);
				assert.equal(statusEntries.length, 1, label);
			} else {
				assert.equal(
					harness.branch.filter(
						(entry) =>
							entry.type === "custom_message" &&
							eventKind(entry.details) === kind,
					).length,
					1,
					label,
				);
			}
			const attempts = harness.sent.filter(
				(entry) => eventKind(entry.message.details) === kind,
			);
			assert.ok(
				attempts.every(
					(entry) => entry.message.content === original.message.content,
				),
				label,
			);
			if (fault === "unreadable") assert.equal(attempts.length, 1, label);
		}
	}
});

test("resets invalidate unreadable terminal records without stale signals", async () => {
	for (const kind of ["unlock", "decision-failed", "exhausted"]) {
		for (const reset of ["unlock", "fresh-cycle", "demote"]) {
			let unreadable = false;
			const hooks: string[] = [];
			const harness = createHarness({
				hasUI: false,
				config: { maxContinue: 1 },
				onSend(message) {
					const fold = parseDecisionFoldDetails(message.details);
					const eventKind =
						fold?.watchdogEvent?.kind ??
						fold?.watchdogOutcome ??
						(message.details as { kind?: string } | undefined)?.kind;
					if (eventKind === kind) unreadable = true;
					return undefined;
				},
				onReadBranch() {
					if (unreadable) throw new Error("receipt unavailable");
				},
				onHook: (name) => hooks.push(name),
			});
			await startIdle(harness);
			await harness.openDecision();
			if (kind === "unlock")
				await settleResponse(harness, harness.answerUnlock());
			else if (kind === "decision-failed") {
				for (let i = 0; i < 3; i++)
					await settleResponse(harness, harness.answerInvalid());
			} else {
				await settleResponse(harness, harness.answerContinue());
				harness.streaming = true;
				await harness.fire("agent_start", { type: "agent_start" });
				harness.streaming = false;
				await settleOnly(harness);
			}
			assert.equal(hooks.includes("user-ready"), false, `${kind}/${reset}`);
			if (reset === "unlock") await harness.unlock();
			else if (reset === "fresh-cycle") harness.runtime.restartLockCycle();
			else
				harness.hub.bind({
					instance: createHubAttachmentInstance(),
					sessionId: "replacement",
					hasUI: true,
					initialBusy: false,
				});
			unreadable = false;
			await settleOnly(harness);
			assert.equal(hooks.includes("user-ready"), false, `${kind}/${reset}`);
		}
	}
});

test("receipt-read re-entry cannot publish an old terminal intent in a fresh cycle", async () => {
	let resetOnRead = false;
	const hooks: string[] = [];
	let harness: Harness;
	harness = createHarness({
		onSend(message) {
			if (
				parseDecisionFoldDetails(message.details)?.watchdogOutcome === "unlock"
			)
				resetOnRead = true;
			return undefined;
		},
		onReadBranch() {
			if (resetOnRead) {
				resetOnRead = false;
				harness.runtime.restartLockCycle();
			}
		},
		onHook: (name) => hooks.push(name),
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.deepEqual(hooks, []);
});

test("AI unlock publication failure never relocks the controller", async () => {
	const harness = createHarness({
		onSend(message) {
			const outcome = (
				message.details as { readonly watchdogOutcome?: unknown } | undefined
			)?.watchdogOutcome;
			return outcome === "unlock"
				? new Error("unlock publication failed")
				: undefined;
		},
	});
	await startIdle(harness);
	await harness.openDecision();

	await settleResponse(
		harness,
		harness.answerUnlock("Waiting for approval.", "WAIT_USER"),
	);

	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(
		harness.entries.some(
			(entry) => entry.type === "pi-continue-watchdog:unlock",
		),
		false,
	);
});

test("invalid private decisions correct after settled response and third failure stays stopped", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await settleResponse(
			harness,
			harness.answerInvalid("private invalid body"),
		);
		assert.equal(harness.controller.snapshot.invalidDecisionAttempts, attempt);
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(
			harness.privateDriver.children[0]?.prompts.length,
			Math.min(attempt + 1, 3),
		);
		if (attempt < 3) {
			assert.match(
				harness.privateDriver.children[0]?.prompts[attempt] ?? "",
				/previous decision result failed validation/,
			);
			assert.equal(harness.sent.length, 0);
		}
	}
	assert.equal(harness.controller.snapshot.decisionFailed, true);
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.equal(harness.sent.at(-1)?.message.display, true);
	assert.match(
		harness.sent.at(-1)?.message.content ?? "",
		/Continue watchdog decision failed/,
	);
	const fold = parseDecisionFoldDetails(harness.sent.at(-1)?.message.details);
	assert.equal(fold?.watchdogEvent?.kind, "decision-failed");
	assert.equal(
		fold?.replacement?.content,
		harness.sent.at(-1)?.message.content,
	);
	assert.deepEqual(harness.sent.at(-1)?.options, {
		triggerTurn: false,
		deliverAs: "steer",
	});
	assert.equal(
		JSON.stringify(harness.entries).includes("private invalid body"),
		false,
	);
	assert.equal(
		harness.sent.at(-1)?.message.content.includes("private invalid body"),
		false,
	);
	assert.match(
		harness.notifications.at(-1)?.message ?? "",
		/decision failed after 3 attempts/,
	);
	assert.equal(harness.notifications.at(-1)?.level, "warning");
	await settleOnly(harness);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 3);
});

test("private aborted response is cancellation, never malformed format response", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, {
		stopReason: "aborted",
		errorMessage: "aborted mid-decision",
	});
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"cancelled",
	);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
	assert.equal(harness.aborts, 0);
	assert.deepEqual(harness.notifications, []);
	assert.equal(
		harness.sent.some((entry) => entry.options?.triggerTurn),
		false,
	);
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
	await sending.openDecision();
	await settleResponse(sending, sending.answerContinue());
	assert.equal(sending.controller.snapshot.locked, false);

	stale.runtime.shutdown();
	assert.equal(timer.cleared, true);
});

test("external unlock invalidates normalized private continue before publication", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	fence.deferConfirm();
	harness.privateDriver.respond(harness.answerContinue());
	await waitFor(
		() => fence.pendingConfirmCount() === 1,
		"continue never reached finalization fence",
	);
	assert.equal((await harness.privateDriver.current?.result)?.kind, "decision");
	const sentBefore = harness.sent.length;
	const turnsBefore = harness.triggeredTurns;
	harness.runtime.applyTransition(harness.controller.unlock(), undefined, {
		suppressNotify: true,
	});
	harness.runtime.clearOperationalPendingWork();
	fence.resolvePendingConfirm(true);
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(harness.triggeredTurns, turnsBefore);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
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

test("ordinary main agent_start silently locks and invalidates active private decision", async () => {
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
	await harness.startDecision();
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(harness.controller.snapshot.attempt, attemptBefore);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(harness.privateDriver.children[0]?.aborted, true);
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

test("private result finalizes directly without zero-delay parent settlement wake", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const timersBefore = harness.clock.records.length;
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(harness.clock.records.length, timersBefore);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(
		harness.clock.records.some((record) => record.delayMs === 0),
		false,
	);
});

test("stale idle timer stays inert after private response cancellation and later ordinary settle", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const stale = harness.clock.records[0];
	assert.ok(stale);
	await harness.startUnrelatedRun();
	await settlePrivateDecision(harness.privateDriver);
	harness.streaming = false;
	await settleOnly(harness);
	const before = harness.controller.snapshot;
	const operations = harness.privateDriver.operations.length;
	stale.callback();
	assert.deepEqual(harness.controller.snapshot, before);
	assert.equal(harness.privateDriver.operations.length, operations);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
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

test("three normally settled private responses without writes fail once, no fourth response", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await settleResponse(harness, {});
		assert.equal(harness.controller.snapshot.invalidDecisionAttempts, attempt);
	}
	assert.equal(harness.controller.snapshot.decisionFailed, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 3);
	assert.deepEqual(harness.privateDriver.children[0]?.fileStates, [
		"{}",
		"{}",
		"{}",
	]);
	assert.equal(harness.notifications.length, 1);
	await settleOnly(harness);
	await settleOnly(harness);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 3);
	assert.equal(harness.notifications.length, 1);
});

test("domain activity cancels submitted private child without parent assistant residue", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	const child = harness.privateDriver.children[0];
	assert.ok(child);
	fence.advanceFence();
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(child.aborted, true);
	assert.equal(child.disposed, true);
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"cancelled",
	);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(
		harness.entries.some(
			(entry) =>
				entry.type === "pi-continue-watchdog:private-response" ||
				entry.type === HUMAN_UNLOCK_ENTRY_TYPE,
		),
		false,
	);
	assert.equal(
		harness.sent.some((entry) => entry.options?.triggerTurn),
		false,
	);
	assert.equal(
		harness.branch.some(
			(entry) =>
				entry.type === "message" || entry.customType === DECISION_MESSAGE_TYPE,
		),
		false,
	);
	assert.equal(
		await harness.endMainMessage(assistant([text("ordinary response")])),
		undefined,
	);
});

test("subagent activity invalidating a submitted decision is disclosed once", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	const cards = () =>
		harness.entries.filter((entry) =>
			JSON.stringify(entry.data).includes("invalidated by subagent activity"),
		);
	await startIdle(harness);
	// Activity before the prompt is submitted wastes no response: stay quiet.
	await harness.openDecision({ start: false });
	await Promise.resolve();
	await Promise.resolve();
	fence.advanceFence();
	assert.equal(cards().length, 0);
	await harness.openDecision({ start: false });
	await Promise.resolve();
	await Promise.resolve();
	await harness.startDecision();
	fence.advanceFence();
	fence.advanceFence();
	assert.equal(cards().length, 1);
	assert.deepEqual(cards()[0].data, {
		kind: "other-error",
		exchangeId: "exchange-1",
		cycleId: 1,
		message:
			"Decision check invalidated by subagent activity; its answer was discarded. The check will run again when all agents are idle.",
	});
});

test("uncorrelated quarantine releases before an unrelated run", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision({ start: false });
	await Promise.resolve();
	await Promise.resolve();
	fence.advanceFence();

	// Cancelled private operation never claims or rewrites later ordinary work.
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
	assert.equal(await harness.endMainMessage(ordinary), undefined);
});

for (const change of [
	"source-branch",
	"source-session",
	"model",
	"thinking",
	"owner",
	"shutdown",
] as const) {
	test(`private file result loses authority after ${change} replacement`, async () => {
		const harness = createHarness({ hasUI: false });
		await startIdle(harness);
		await harness.openDecision();
		const child = harness.privateDriver.children[0];
		assert.ok(child);
		await settleResponse(harness, {
			...harness.answerContinue(),
			effect: async () => {
				if (change === "source-branch")
					harness.branch.splice(0, harness.branch.length, {
						id: "replacement-root",
						type: "message",
						message: { role: "user", content: [text("Replacement branch.")] },
					});
				else if (change === "source-session")
					Object.assign(harness.ctx.sessionManager, {
						getSessionId: () => "replacement-session",
					});
				else if (change === "model")
					Object.assign(harness.ctx, {
						model: { ...harness.ctx.model, id: "replacement-model" },
					});
				else if (change === "thinking") harness.thinkingLevel = "high";
				else if (change === "owner")
					harness.hub.bind({
						instance: createHubAttachmentInstance(),
						sessionId: "new-ui-owner",
						hasUI: true,
					});
				else await harness.runtime.shutdown();
			},
		});
		assert.equal(
			(await harness.privateDriver.current?.result)?.kind,
			"cancelled",
		);
		assert.equal(child.aborted, true);
		assert.equal(child.disposed, true);
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
		assert.equal(
			harness.sent.some((entry) => entry.options?.triggerTurn),
			false,
		);
		assert.equal(
			harness.entries.some(
				(entry) =>
					entry.type === "pi-continue-watchdog:private-response" ||
					entry.type === "pi-continue-watchdog:ai-unlock",
			),
			false,
		);
	});
}

test("stale fenced valid private continue does not consume retry or exhaust", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({
		config: { maxContinue: 1 },
		processDomain: fence.domain,
	});
	await startIdle(harness);
	await harness.openDecision();
	fence.deferConfirm();
	harness.privateDriver.respond(harness.answerContinue());
	await waitFor(
		() => fence.pendingConfirmCount() === 1,
		"private candidate never reached publication fence",
	);
	fence.advanceFence(false);
	fence.resolvePendingConfirm(false);
	const result = await settlePrivateDecision(harness.privateDriver);
	assert.equal(result?.kind, "decision");
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.triggeredTurns, 0);
	assert.equal(harness.controller.snapshot.exhausted, false);
});

test("domain busy before private unlock publication defers typed unlock", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	fence.deferConfirm();
	harness.privateDriver.respond(harness.answerUnlock("wait", "WAIT_USER"));
	await waitFor(
		() => fence.pendingConfirmCount() === 1,
		"unlock candidate never reached publication fence",
	);
	fence.setBusyParticipants(1);
	fence.resolvePendingConfirm(false);
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(
		harness.entries.some(
			(entry) =>
				entry.type === "pi-continue-watchdog:ai-unlock" ||
				entry.type === HUMAN_UNLOCK_ENTRY_TYPE,
		),
		false,
	);
});

test("stale fenced valid private unlock does not unlock", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({
		config: { maxContinue: 1 },
		processDomain: fence.domain,
	});
	await startIdle(harness);
	await harness.openDecision();
	fence.deferConfirm();
	harness.privateDriver.respond(harness.answerUnlock());
	await waitFor(
		() => fence.pendingConfirmCount() === 1,
		"private candidate never reached publication fence",
	);
	fence.advanceFence(false);
	fence.resolvePendingConfirm(false);
	const result = await settlePrivateDecision(harness.privateDriver);
	assert.equal(result?.kind, "decision");
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.triggeredTurns, 0);
	assert.equal(
		harness.entries.some(
			(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
		),
		false,
	);
});

test("stale fenced third invalid private response preserves counts and permits retry", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerInvalid());
	await settleResponse(harness, harness.answerInvalid());
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 2);
	fence.deferConfirm();
	harness.privateDriver.respond(harness.answerInvalid());
	await waitFor(
		() => fence.pendingConfirmCount() === 1,
		"third invalid response never reached publication fence",
	);
	fence.advanceFence(false);
	fence.resolvePendingConfirm(false);
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 2);
	assert.equal(harness.controller.snapshot.decisionFailed, false);
	assert.equal(harness.controller.snapshot.locked, true);
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records.at(-1)?.delayMs, 10_000);
});

test("pending valid private continue keeps reconcile inert until fold publication", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	fence.deferConfirm();
	harness.privateDriver.respond(harness.answerContinue());
	await waitFor(
		() => fence.pendingConfirmCount() === 1,
		"continue candidate never reached publication fence",
	);
	const timers = harness.clock.records.length;
	harness.runtime.reconcileIdle();
	assert.equal(harness.clock.records.length, timers);
	assert.equal(harness.controller.snapshot.decisionOpen, true);
	assert.equal(harness.triggeredTurns, 0);
	fence.setDeferred(false);
	fence.resolvePendingConfirm(true);
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(
		harness.sent.at(-1)?.message.customType,
		DECISION_FOLD_MESSAGE_TYPE,
	);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(harness.triggeredTurns, 1);
});

const presentationOnlyContents: readonly unknown[] = [
	"",
	" \n ",
	[],
	[text("")],
	[text(" \n ")],
];

// Preserve the remote fix's phase coverage at the new private transport seams,
// rather than reintroducing retired main-session prompt/context lifecycles.
for (const phase of [
	"before-private-prompt",
	"awaiting-private-response",
	"pending-private-publication",
] as const) {
	for (const [index, content] of presentationOnlyContents.entries()) {
		test(`presentation-only row ${index} ${phase} preserves exactly one owned decision`, async () => {
			const fence = createFenceHarness();
			const harness = createHarness({ processDomain: fence.domain });
			await startIdle(harness);
			await harness.openDecision({ start: false });
			if (phase !== "before-private-prompt") await harness.startDecision();
			if (phase === "pending-private-publication") {
				fence.deferConfirm();
				harness.privateDriver.respond(harness.answerUnlock());
				await waitFor(
					() => fence.pendingConfirmCount() === 1,
					"unlock did not reach its real publication fence",
				);
			}
			await harness.fire("message_start", {
				type: "message_start",
				message: {
					role: "custom",
					customType: "other-plugin:timing",
					content,
					display: true,
					timestamp: Date.now(),
				},
			});
			assert.equal(harness.controller.snapshot.decisionOpen, true);
			if (phase === "pending-private-publication") {
				fence.setDeferred(false);
				fence.resolvePendingConfirm(true);
				await settlePrivateDecision(harness.privateDriver);
			} else {
				await settleResponse(harness, harness.answerUnlock());
			}
			assert.equal(harness.privateDriver.children.length, 1);
			assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
			assert.equal(harness.privateDriver.operations.length, 1);
			assert.equal(harness.controller.snapshot.locked, false);
			assert.equal(
				harness.entries.filter(
					(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
				).length,
				1,
			);
			assert.equal(harness.triggeredTurns, 0);
		});
	}
}

test("whitespace-only and image-bearing custom messages classify by content", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await harness.fire("message_start", {
		type: "message_start",
		message: {
			role: "custom",
			customType: "other-plugin:status",
			content: [text("   \n  ")],
			display: true,
			timestamp: Date.now(),
		},
	});
	assert.equal(harness.controller.snapshot.decisionOpen, true);
	await harness.fire("message_start", {
		type: "message_start",
		message: {
			role: "custom",
			customType: "other-plugin:attach",
			content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			display: true,
			timestamp: Date.now(),
		},
	});
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.privateDriver.children[0]?.aborted, true);
});

for (const [index, content] of presentationOnlyContents.entries()) {
	test(`presentation-only user row ${index} stays inert through both registered handlers`, async () => {
		const harness = createHarness({ nativeAutoLock: true });
		await startIdle(harness);
		await harness.openDecision();
		await harness.fire("message_start", {
			type: "message_start",
			message: { role: "user", content, timestamp: Date.now() },
		});
		assert.equal(harness.controller.snapshot.decisionOpen, true);
		await settleResponse(harness, harness.answerUnlock());
		assert.equal(harness.privateDriver.children.length, 1);
		assert.equal(harness.controller.snapshot.locked, false);
	});
}

test("nonempty, image and malformed user content still preempt through both handlers", async () => {
	for (const content of [
		"new work",
		[text("new work")],
		[{ type: "image", data: "AAAA", mimeType: "image/png" }],
		undefined,
		null,
		[null],
		[{ type: "text", text: 42 }],
	]) {
		const harness = createHarness({ nativeAutoLock: true });
		await startIdle(harness);
		await harness.openDecision();
		await harness.fire("message_start", {
			type: "message_start",
			message: { role: "user", content, timestamp: Date.now() },
		});
		await settlePrivateDecision(harness.privateDriver);
		assert.equal(harness.controller.snapshot.decisionOpen, false);
		assert.equal(harness.privateDriver.children[0]?.aborted, true);
	}
});

for (const [withTiming, becomesBusy] of [
	[false, false],
	[true, false],
	[true, true],
] as const) {
	test(`accepted continuation publication follows host idle state (timing=${withTiming}, busy=${becomesBusy})`, async () => {
		const fence = createFenceHarness();
		let hostBusy = false;
		const harness = createHarness({
			processDomain: fence.domain,
			isIdle: () => !harness.streaming && !hostBusy,
		});
		await startIdle(harness);
		await harness.openDecision();
		fence.deferConfirm();
		harness.privateDriver.respond(harness.answerContinue());
		await waitFor(
			() => fence.pendingConfirmCount() === 1,
			"continue did not reach its real publication fence",
		);
		const reportsBefore = fence.reportedIdle.length;
		if (withTiming) {
			hostBusy = becomesBusy;
			await harness.fire("message_start", {
				type: "message_start",
				message: {
					role: "custom",
					customType: "timing",
					content: "",
					timestamp: Date.now(),
				},
			});
		}
		assert.equal(harness.streaming, false);
		assert.equal(harness.ctx.isIdle(), !becomesBusy);
		if (withTiming) assert.equal(fence.reportedIdle.at(-1), !becomesBusy);
		else
			assert.equal(
				fence.reportedIdle.length,
				reportsBefore,
				"private settlement does not invent a parent lifecycle report",
			);
		fence.setDeferred(false);
		fence.resolvePendingConfirm(true);
		await settlePrivateDecision(harness.privateDriver);
		assert.equal(harness.controller.snapshot.attempt, becomesBusy ? 0 : 1);
		const folds = harness.sent.filter(
			(entry) => entry.message.customType === DECISION_FOLD_MESSAGE_TYPE,
		);
		assert.deepEqual(
			folds.map(
				(entry) =>
					parseDecisionFoldDetails(entry.message.details)?.watchdogOutcome,
			),
			becomesBusy ? [] : ["continue"],
		);
	});
}

test("presentation-only row before continuation correlation preserves cancellation ownership", async () => {
	const harness = createHarness();
	await startIdle(harness);
	const fold = await startAcceptedContinuation(harness, false);
	await harness.fire("message_start", {
		type: "message_start",
		message: {
			role: "custom",
			customType: "timing",
			content: "",
			timestamp: Date.now(),
		},
	});
	await harness.fire("message_start", {
		type: "message_start",
		message: { role: "custom", ...fold.message, timestamp: Date.now() },
	});
	await harness.unlock();
	assert.equal(harness.aborts, 1);
});

test("foreign parent message cancels exact submitted private child without rewriting parent output", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const child = harness.privateDriver.children[0];
	await harness.fire("message_start", {
		type: "message_start",
		message: { role: "user", content: [text("foreign work")], timestamp: 1 },
	});
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(child?.aborted, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(
		await harness.endMainMessage(assistant([text("ordinary output")])),
		undefined,
	);
	assert.equal(
		harness.sent.some((entry) => entry.options?.triggerTurn),
		false,
	);
});

test("same-process external child activity cancels exact private operation immediately", async () => {
	const harness = createHarness();
	await startIdle(harness);
	const external = harness.hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "active-child",
		hasUI: false,
		initialBusy: false,
	}).attachment;
	await harness.openDecision();
	const child = harness.privateDriver.children[0];
	assert.ok(child);
	harness.hub.markBusy(external);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.locked, true);
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(child.aborted, true);
	assert.equal(child.disposed, true);
	assert.equal(harness.aborts, 0);
	assert.equal(
		harness.sent.some((entry) => entry.options?.triggerTurn),
		false,
	);
});

test("external child completion only makes aggregate idle; one private inquiry belongs to main", async () => {
	const hub = createObservableAgentHub();
	const clock = new FakeClock();
	const main = createHarness({ hub, clock, sessionId: "main", hasUI: true });
	const first = createHarness({
		hub,
		clock,
		sessionId: "child-a",
		hasUI: false,
	});
	const last = createHarness({
		hub,
		clock,
		sessionId: "child-b",
		hasUI: false,
	});
	for (const harness of [main, first, last]) {
		harness.streaming = true;
		await startIdle(harness);
	}
	main.runtime.applyTransition(main.controller.lock(), undefined, {
		suppressNotify: true,
	});
	main.streaming = false;
	await settleOnly(main);
	assert.equal(clock.records.length, 0);
	first.streaming = false;
	await settleOnly(first);
	assert.equal(clock.records.length, 0);
	last.streaming = false;
	await settleOnly(last);
	assert.equal(clock.records.length, 1);
	assert.equal(clock.records[0]?.delayMs, 10_000);
	clock.fire(0);
	await main.startDecision();
	assert.equal(main.privateDriver.operations.length, 1);
	assert.equal(first.privateDriver.operations.length, 0);
	assert.equal(last.privateDriver.operations.length, 0);
	assert.deepEqual(main.sent, []);
	assert.deepEqual(first.sent, []);
	assert.deepEqual(last.sent, []);
});

test("shared hub reclaims main after UI shutdown then prefers a new UI bind", async () => {
	const hub = createObservableAgentHub();
	const clock = new FakeClock();
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: 3,
		maxContinue: 2,
		decisionPrompt: "Decide now.",
		continuePrompt: "Continue compactly.",
		reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"],
		continueReasonTypes: ["WORK_REMAINS", "VERIFYING"],
		unlockShortcut: "alt+u",
		unlockReviewEnabled: false,
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
			registerTool(): void {},
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
			registerTool(): void {},
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
			maxContinue: 2,
			decisionPrompt: "Loaded decision.",
			continuePrompt: "Loaded continue.",
			reasonTypes: ["JOB_DONE"],
			continueReasonTypes: ["WORK_REMAINS", "VERIFYING"],
			unlockShortcut: "alt+u",
			unlockReviewEnabled: false,
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
	assert.equal(harness.privateDriver.operations.length, 1);
	await settleResponse(harness, harness.answerContinue());
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
	assert.equal(harness.privateDriver.operations.length, 1);
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
		messages: [assistant([text("ordinary parent response")])],
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

test("parent agent_start during private generation is external work, never provisionally internal", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	assert.equal(fence.reportedIdle.at(-1), false);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.locked, true);
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(harness.privateDriver.children[0]?.aborted, true);
	assert.equal(harness.aborts, 0);
});

test("private correction racing parent busy retains consumed count without another response", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerInvalid());
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 2);
	// External work arrives while correction is parked, before another response.
	await harness.startUnrelatedRun();
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.controller.snapshot.decisionFailed, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 2);
	assert.equal(harness.triggeredTurns, 0);
	harness.streaming = false;
	await settleOnly(harness);
	assert.ok(
		harness.clock.records.some(
			(record) => record.delayMs === 10_000 && !record.cleared,
		),
	);
});

test("accepted continue busy races roll back retry and defer without unlocking", async () => {
	const fence = createFenceHarness();
	const duringConfirm = createHarness({ processDomain: fence.domain });
	await startIdle(duringConfirm);
	await duringConfirm.openDecision();
	await Promise.resolve();
	await Promise.resolve();
	fence.deferConfirm();
	duringConfirm.privateDriver.respond(duringConfirm.answerContinue());
	await waitFor(
		() => fence.pendingConfirmCount() === 1,
		"continue never reached finalization fence",
	);
	// deliverPending first performs the common finalization fence, then the
	// accepted-continuation fence under test.
	assert.equal(fence.pendingConfirmCount(), 1);
	fence.resolvePendingConfirm(true);
	await waitFor(
		() => fence.pendingConfirmCount() === 1,
		"continue never reached acceptance fence",
	);
	await duringConfirm.startUnrelatedRun();
	fence.resolvePendingConfirm(true);
	await settlePrivateDecision(duringConfirm.privateDriver);
	assert.equal(duringConfirm.controller.snapshot.attempt, 0);
	assert.equal(duringConfirm.controller.snapshot.locked, true);
	assert.equal(duringConfirm.triggeredTurns, 0);

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
	await atSend.openDecision();
	await settleResponse(atSend, atSend.answerContinue());
	assert.equal(atSend.controller.snapshot.attempt, 0);
	assert.equal(atSend.controller.snapshot.locked, true);
	assert.deepEqual(
		atSend.entries.filter(
			(entry) => entry.type === "pi-continue-watchdog:status",
		),
		[],
	);
});

test("decision message cleanup is registered as uninterruptible terminal work", () => {
	const harness = createHarness();
	const messageEndOptions = harness.handlerOptions.get("message_end");
	assert.ok(messageEndOptions);
	assert.deepEqual(messageEndOptions.at(-1), { uninterruptible: true });
});

test("real user input cancels private decision without parent replay", async () => {
	for (const source of ["interactive", "rpc"] as const) {
		const harness = createHarness();
		await startIdle(harness);
		await harness.openDecision();
		assert.equal(harness.controller.snapshot.decisionOpen, true);
		assert.deepEqual(await harness.fireInput(source, "user takeover"), {
			action: "continue",
		});
		await settlePrivateDecision(harness.privateDriver);
		assert.equal(harness.privateDriver.children[0]?.aborted, true);
		assert.equal(harness.aborts, 0);
		assert.equal(harness.controller.snapshot.locked, true);
		assert.equal(harness.controller.snapshot.decisionOpen, false);
		assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
		assert.equal(
			harness.sent.some((entry) => entry.options?.triggerTurn),
			false,
		);
		assert.equal(harness.runtime.consumeDecisionAbortSuppression(), false);
		assert.deepEqual(harness.sentUserMessages, []);
		assert.deepEqual(harness.notifications, []);
		await settleOnly(harness);
		await settleOnly(harness);
		assert.deepEqual(harness.sentUserMessages, []);
	}
});

test("extension-source input remains inert for active private decision", async () => {
	const extension = createHarness();
	await startIdle(extension);
	await extension.openDecision();
	await extension.fireInput("extension");
	assert.equal(extension.aborts, 0);
	assert.equal(extension.privateDriver.children[0]?.aborted, false);
	assert.equal(extension.controller.snapshot.decisionOpen, true);
	assert.equal(extension.controller.snapshot.invalidDecisionAttempts, 0);
});

test("takeover leaves complete text and image payload to Pi without copying or replay", async () => {
	for (const prompt of ["Inspect this image.", ""]) {
		const harness = createHarness();
		await startIdle(harness);
		await harness.openDecision();
		const image = {
			type: "image" as const,
			data: "encoded-image",
			mimeType: "image/png",
		};
		const images = [image];
		assert.deepEqual(await harness.fireInput("rpc", prompt, images), {
			action: "continue",
		});
		assert.deepEqual(images, [
			{ type: "image", data: "encoded-image", mimeType: "image/png" },
		]);
		await settlePrivateDecision(harness.privateDriver);
		assert.equal(harness.privateDriver.children[0]?.aborted, true);
		await settleOnly(harness);
		await settleOnly(harness);
		assert.deepEqual(harness.sentUserMessages, []);
		assert.equal(harness.aborts, 0);
	}
});

test("private runner validation diagnostic never rewrites foreign cw tool results", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const event = {
		type: "tool_result",
		toolName: "cw",
		toolCallId: "foreign-cw",
		input: {},
		content: [],
		details: { outcome: "invalid" },
		isError: false,
	};
	let result: unknown;
	for (const handler of harness.handlers.get("tool_result") ?? [])
		result = await handler(event as never, harness.ctx);
	assert.equal(result, undefined);
	assert.equal(event.isError, false);
	assert.deepEqual(harness.registeredTools, []);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
});

test("private preemption needs no cleanup fold and leaves no main model residue", async () => {
	let cleanupAttempts = 0;
	const harness = createHarness({
		onSend(message) {
			if (message.customType === DECISION_FOLD_MESSAGE_TYPE) {
				cleanupAttempts += 1;
				return new Error("cleanup unavailable");
			}
			return undefined;
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	assert.deepEqual(await harness.fireInput("interactive", "take over once"), {
		action: "continue",
	});
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(cleanupAttempts, 0);
	assert.equal(harness.aborts, 0);
	assert.equal(harness.privateDriver.children[0]?.aborted, true);
	assert.equal(
		harness.branch.some(
			(entry) =>
				entry.type === "message" || entry.customType === DECISION_MESSAGE_TYPE,
		),
		false,
	);
	assert.deepEqual(harness.sentUserMessages, []);
	assert.equal(harness.sent.length, 0);
});

test("private preemption does not claim another handler-tagged parent assistant", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	assert.deepEqual(await harness.fireInput("interactive", "take over"), {
		action: "continue",
	});
	await settlePrivateDecision(harness.privateDriver);
	const parent = {
		role: "assistant",
		content: [text("ordinary partial")],
		stopReason: "stop",
		errorMessage: "pi-continue-watchdog:preempted",
	};
	assert.equal(await harness.endMainMessage(parent), undefined);
	assert.deepEqual(parent.content, [text("ordinary partial")]);
	assert.deepEqual(harness.spliceAttempts, []);
});

test("native private abort stays child-local and never becomes user takeover", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, {
		stopReason: "aborted",
		errorMessage: "partial private watchdog answer",
	});
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"cancelled",
	);
	assert.equal(
		harness.branch.some((entry) => entry.type === "message"),
		false,
	);
	assert.equal(
		JSON.stringify(harness.entries).includes("partial private watchdog answer"),
		false,
	);
	assert.equal(harness.runtime.consumeDecisionAbortSuppression(), false);
	assert.equal(harness.aborts, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.sentUserMessages, []);
	assert.deepEqual(harness.notifications, []);
});

test("private responses never report child generation as parent process-domain busy", async () => {
	const fence = createFenceHarness();
	const harness = createHarness({ processDomain: fence.domain });
	await startIdle(harness);
	await harness.openDecision();
	const reports = fence.reportedIdle.length;
	assert.equal(harness.streaming, false);
	assert.equal(fence.domain.snapshot.allIdle, true);
	await settleResponse(harness, harness.answerInvalid());
	assert.equal(fence.reportedIdle.length, reports);
	assert.equal(harness.controller.snapshot.decisionOpen, true);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 2);
	assert.equal(harness.hub.snapshot.attachmentCount, 1);
});

test("unrelated parent agent_end invalidates private operation without format correction", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([text("ordinary response")])],
	});
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(
		(await harness.privateDriver.current?.result)?.kind,
		"cancelled",
	);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
	assert.equal(harness.privateDriver.children[0]?.aborted, true);
	assert.equal(
		harness.sent.some((entry) => entry.options?.triggerTurn),
		false,
	);
});

test("unrelated parent run cancels private generation without ghost main decision send", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await harness.startUnrelatedRun();
	await settlePrivateDecision(harness.privateDriver);
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(harness.privateDriver.children[0]?.aborted, true);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(harness.controller.snapshot.decisionFailed, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(
		harness.entries.some(
			(entry) =>
				entry.type === "pi-continue-watchdog:status" &&
				["validation-error", "decision-failed"].includes(
					(entry.data as { kind: string }).kind,
				),
		),
		false,
	);
	assert.equal(
		harness.sent.some((entry) => entry.options?.triggerTurn),
		false,
	);
});

test("private response busy race defers silently; idle execution failure stays fail-closed", async () => {
	const busy = createHarness();
	await startIdle(busy);
	await busy.openDecision();
	await settleResponse(busy, {
		...busy.answerUnlock(),
		effect: () => busy.startUnrelatedRun(),
	});
	assert.equal(busy.controller.snapshot.locked, true);
	assert.equal(busy.controller.snapshot.decisionOpen, false);
	assert.equal(busy.controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(
		busy.entries.some(
			(entry) =>
				entry.type === "pi-continue-watchdog:status" &&
				(entry.data as { kind?: string }).kind === "other-error",
		),
		false,
	);
	assert.equal(
		busy.sent.some((entry) => entry.options?.triggerTurn),
		false,
	);
	const idle = createHarness();
	await startIdle(idle);
	await idle.openDecision();
	await settleResponse(idle, { throw: new Error("private provider failed") });
	assert.equal(idle.controller.snapshot.locked, false);
	assert.equal(idle.controller.snapshot.attempt, 0);
	assert.equal(idle.controller.snapshot.invalidDecisionAttempts, 0);
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

test("retired wait is one invalid response with no timer, retry charge, or waiting hook", async () => {
	const hooks: string[] = [];
	const harness = createHarness({ onHook: (name) => hooks.push(name) });
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerWait(60, "Waiting for CI."));
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(hooks.includes("watchdog-waiting"), false);
	// No wait deadline timer is armed; only the fixed idle fence may remain.
	const waitTimers = harness.clock.records.filter(
		(record) => !record.cleared && record.delayMs !== 10_000,
	);
	assert.equal(waitTimers.length, 0);
});

test("WAIT_CALLBACK retains the lock, spends one unit, and stays quiet until callback work", async () => {
	const hooks: string[] = [];
	const harness = createHarness({
		config: {
			reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
		},
		onHook: (name) => hooks.push(name),
	});
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerUnlock("Waiting for the subagent callback.", "WAIT_CALLBACK"),
	);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.callbackSuspended, true);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(hooks.filter((name) => name === "user-ready").length, 1);
	const status = harness.entries.find(
		(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
	);
	assert.equal(
		(status?.data as { effect?: string } | undefined)?.effect,
		"callback-suspended",
	);
	// Same remove-only fold as an actual unlock: the exchange and its human-only
	// status leave model/summary input through the existing projection paths.
	const fold = parseDecisionFoldDetails(
		harness.sent.findLast(
			(entry) => entry.message.customType === DECISION_FOLD_MESSAGE_TYPE,
		)?.message.details,
	);
	assert.equal(fold?.outcome, "remove");
	assert.equal(fold?.watchdogOutcome, "unlock");
	assert.equal(fold?.replacement, undefined);
	assert.equal(
		harness.sent.some(
			(entry) => entry.message.customType === "pi-continue-watchdog:event",
		),
		false,
	);
	// Idle observations and elapsed time arm no inquiry fence or timer.
	await settleOnly(harness);
	const sentBefore = harness.sent.length;
	for (const record of harness.clock.records.filter((r) => !r.cleared)) {
		harness.clock.advance(record.delayMs);
		record.callback();
	}
	await settleOnly(harness);
	assert.equal(harness.sent.length, sentBefore);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(
		harness.clock.records.filter(
			(record) => !record.cleared && record.delayMs !== 10_000,
		).length,
		0,
	);
	assert.equal(
		harness.runtime.getTriggerStatus().blocker,
		"callback-suspended",
	);
	// A notice-only callback (displayed, no triggered turn) does not resume.
	const notice = {
		role: "custom",
		customType: "subagent-notify",
		content: [{ type: "text", text: "child finished" }],
		display: true,
		timestamp: Date.now(),
	};
	await harness.fire("message_start", {
		type: "message_start",
		message: notice,
	});
	await harness.fire("message_end", { type: "message_end", message: notice });
	harness.runtime.reconcileIdle();
	await settleOnly(harness);
	assert.equal(harness.controller.snapshot.callbackSuspended, true);
	assert.equal(harness.sent.length, sentBefore);
	// A known wake text starts work: same cycle, no new unit, no reset.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("message_start", {
		type: "message_start",
		message: {
			role: "user",
			content: [{ type: "text", text: "New intercom message above." }],
			timestamp: Date.now(),
		},
	});
	assert.equal(harness.controller.snapshot.callbackSuspended, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 1);
	await harness.fire("agent_end", {
		type: "agent_end",
		messages: [assistant([text("read the child result")])],
	});
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(hooks.filter((name) => name === "user-ready").length, 1);
	// Allowance remains: settled callback work re-arms the ordinary idle fence.
	assert.equal(
		harness.runtime.getTriggerStatus().blocker === "callback-suspended",
		false,
	);
	const fence = harness.clock.records.findLast(
		(record) => record.delayMs === 10_000 && !record.cleared,
	);
	assert.ok(fence, "expected the ordinary idle fence after callback work");
});

async function suspendForCallback(harness: Harness): Promise<void> {
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerUnlock("Waiting for the subagent callback.", "WAIT_CALLBACK"),
	);
	assert.equal(harness.controller.snapshot.callbackSuspended, true);
}

const CALLBACK_REASONS = {
	reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
};

test("private progress row retires WAIT_CALLBACK publication when ordinary work resumes", async () => {
	const hooks: string[] = [];
	const harness = createHarness({
		config: CALLBACK_REASONS,
		omitPersistedEntryTypes: ["pi-continue-watchdog:ai-unlock"],
		onHook: (name) => hooks.push(name),
	});
	await startIdle(harness);
	await harness.openDecision();
	const colors: string[] = [];
	const widget = mountStateStatusWidget(harness, {
		theme: {
			fg: (color, text) => {
				colors.push(color);
				return text;
			},
			bg: (color, text) => {
				colors.push(color);
				return text;
			},
		},
	});
	await settleResponse(
		harness,
		harness.answerUnlock("Waiting for the callback.", "WAIT_CALLBACK"),
	);
	assert.equal(harness.privateDriver.current?.settled, true);
	assert.equal(harness.controller.snapshot.callbackSuspended, true);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.match(widget.render(200).join(""), /publishing.*1\/3/);
	assert.deepEqual(colors.slice(-2).sort(), ["accent", "toolPendingBg"]);
	const sent = harness.sent.length;
	assert.equal(sent, 1, "only the remove-fold persisted; status is pending");
	assert.deepEqual(hooks, []);
	const tick = harness.clock.records.at(-1);
	assert.ok(tick);
	assert.equal(tick.delayMs, 1000);
	assert.equal(tick.cleared, false);

	await harness.startUnrelatedRun();
	assert.equal(harness.controller.snapshot.callbackSuspended, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 1, "resume costs no unit");
	assert.match(widget.render(200).join(""), /running.*root/);
	assert.doesNotMatch(
		widget.render(200).join(""),
		/publishing|waiting for model/,
	);
	assert.equal(colors.at(-1), "dim");
	assert.equal(tick.cleared, true, "root work needs no private display tick");
	const requests = widget.renderRequests();
	const timers = harness.clock.records.length;
	tick.callback();
	assert.equal(widget.renderRequests(), requests);
	assert.equal(harness.clock.records.length, timers);

	harness.streaming = false;
	await settleOnly(harness);
	await settleOnly(harness);
	harness.runtime.reconcileIdle();
	assert.match(widget.render(200).join(""), /asking in 10s/);
	assert.doesNotMatch(widget.render(200).join(""), /publishing/);
	assert.ok(
		harness.clock.records.some(
			(record) => !record.cleared && record.delayMs === 10_000,
		),
		"ordinary idle fence remains armed",
	);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(
		harness.sent.length,
		sent,
		"retired publication is not replayed",
	);
	assert.deepEqual(hooks, [], "retired waiting signal is not emitted");
	assert.equal(harness.triggeredTurns, 0);
	assert.equal(harness.privateDriver.operations.length, 1);
	assert.equal(
		harness.entries.some(
			(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
		),
		false,
	);
});

test("manual unlock and actual ordinary work end callback suspension", async () => {
	const manual = createHarness({ config: CALLBACK_REASONS });
	await suspendForCallback(manual);
	await manual.unlock();
	assert.equal(manual.controller.snapshot.locked, false);
	assert.equal(manual.controller.snapshot.callbackSuspended, false);

	const human = createHarness({ config: CALLBACK_REASONS });
	await suspendForCallback(human);
	human.streaming = true;
	await human.fire("agent_start", { type: "agent_start" });
	await human.fire("message_start", {
		type: "message_start",
		message: { role: "user", content: "Do something else.", timestamp: 1 },
	});
	// Fresh-cycle reset for genuine user text is owned by auto-lock (tested there).
	assert.equal(human.controller.snapshot.locked, true);
	assert.equal(human.controller.snapshot.callbackSuspended, false);
});

test("restart, shutdown, and history reopen never restore or signal a suspension", async () => {
	// A fresh lock cycle (session replacement / restart) clears suspension.
	const restarted = createHarness({ config: CALLBACK_REASONS });
	await suspendForCallback(restarted);
	restarted.runtime.restartLockCycle();
	assert.equal(restarted.controller.snapshot.callbackSuspended, false);
	assert.equal(restarted.controller.snapshot.attempt, 0);

	// Shutdown: late lifecycle events publish nothing and dispatch nothing.
	const hooks: string[] = [];
	const stopped = createHarness({
		config: CALLBACK_REASONS,
		onHook: (name) => hooks.push(name),
	});
	await suspendForCallback(stopped);
	const sentBefore = stopped.sent.length;
	const hooksBefore = hooks.length;
	await stopped.runtime.shutdown();
	await stopped.fire("agent_start", { type: "agent_start" });
	await settleOnly(stopped);
	assert.equal(stopped.sent.length, sentBefore);
	assert.equal(hooks.length, hooksBefore);

	// History reopen: the suspension record is audit only.
	const reopenedHooks: string[] = [];
	const reopened = createHarness({
		config: CALLBACK_REASONS,
		onHook: (name) => reopenedHooks.push(name),
	});
	reopened.branch.push(...stopped.branch);
	assert.ok(
		reopened.branch.some(
			(entry) =>
				(entry as { customType?: string; type?: string }).customType ===
					"pi-continue-watchdog:ai-unlock" ||
				(entry as { type?: string }).type === "pi-continue-watchdog:ai-unlock",
		),
		"history carries the callback-suspended record",
	);
	await startIdle(reopened);
	await settleOnly(reopened);
	assert.equal(reopened.controller.snapshot.locked, false);
	assert.equal(reopened.controller.snapshot.callbackSuspended, false);
	assert.equal(reopened.controller.snapshot.attempt, 0);
	assert.deepEqual(reopenedHooks, []);
});

test("callback work before private candidate publication retires waiting signal and charge", async () => {
	const hooks: string[] = [];
	const fence = createFenceHarness();
	const harness = createHarness({
		config: CALLBACK_REASONS,
		processDomain: fence.domain,
		onHook: (name) => hooks.push(name),
	});
	await startIdle(harness);
	await harness.openDecision();
	fence.deferConfirm();
	harness.privateDriver.respond(
		harness.answerUnlock("Waiting.", "WAIT_CALLBACK"),
	);
	await waitFor(
		() => fence.pendingConfirmCount() === 1,
		"callback candidate never reached finalization fence",
	);
	assert.equal((await harness.privateDriver.current?.result)?.kind, "decision");
	await harness.startUnrelatedRun({
		role: "user",
		content: [text("New intercom message above.")],
		timestamp: 1,
	});
	fence.resolvePendingConfirm(true);
	await settlePrivateDecision(harness.privateDriver);
	assert.equal(harness.controller.snapshot.callbackSuspended, false);
	harness.streaming = false;
	await settleOnly(harness);
	assert.equal(hooks.includes("user-ready"), false);
	assert.equal(harness.controller.snapshot.callbackSuspended, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.locked, true);
});

test("AI unlock status-entry publication failures keep the unlock without fallback or premature hook", async () => {
	for (const fault of ["absent", "unreadable", "throws"] as const) {
		const hooks: string[] = [];
		let statusUnreadable = false;
		const harness = createHarness({
			hasUI: false,
			onHook: (name) => hooks.push(name),
			onAppend(type) {
				if (fault === "unreadable" && type === "pi-continue-watchdog:ai-unlock")
					statusUnreadable = true;
			},
			onReadBranch() {
				if (statusUnreadable) throw new Error("branch read failed");
			},
			// Sabotage only the quiet status entry: the remove-only fold still
			// persists, so exactly the second artifact is unconfirmed.
			...(fault === "absent"
				? { omitPersistedEntryTypes: ["pi-continue-watchdog:ai-unlock"] }
				: {}),
			...(fault === "throws"
				? { appendThrows: "pi-continue-watchdog:ai-unlock" }
				: {}),
		});
		await startIdle(harness);
		await harness.openDecision();
		await settleResponse(harness, harness.answerUnlock());
		const label = `status/${fault}`;

		// The unlock itself is committed and never relocks.
		assert.equal(harness.controller.snapshot.locked, false, label);
		// No model-bound fallback unlock body was published.
		assert.equal(
			harness.sent.some(
				(entry) =>
					entry.message.customType === "pi-continue-watchdog:event" &&
					(entry.message.details as { kind?: string } | undefined)?.kind ===
						"unlock",
			),
			false,
			label,
		);
		// The terminal hook stays gated behind the confirmed status receipt.
		assert.equal(hooks.includes("user-ready"), false, label);

		// A throwing append is retried on later confirmations by the same
		// retained-intent path proven by the unreadable branch; both stay gated
		// behind a confirmed new-branch-entry receipt.
		// Confirmed-absence and unreadable receipts retain the pending intent
		// without duplicate sends; a later healthy confirmation completes it.
		if (fault === "absent" || fault === "unreadable") {
			const before = harness.sent.length;
			if (fault === "unreadable") statusUnreadable = false;
			await settleOnly(harness);
			// Absent stays absent in this harness (append still suppressed), so
			// its intent remains pending with no duplicate fold sends.
			if (fault === "absent") {
				assert.equal(harness.sent.length, before, label);
				assert.equal(hooks.includes("user-ready"), false, label);
			} else {
				const statusCount = harness.entries.filter(
					(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
				).length;
				assert.equal(statusCount, 1, label);
				assert.equal(
					hooks.filter((name) => name === "user-ready").length,
					1,
					label,
				);
			}
		}
	}
});

test("callback status publication failures keep the charged suspension without fallback or premature hook", async () => {
	for (const fault of ["absent", "unreadable", "throws", "busy"] as const) {
		const hooks: string[] = [];
		let statusUnreadable = false;
		const harness = createHarness({
			hasUI: false,
			config: CALLBACK_REASONS,
			onHook: (name) => hooks.push(name),
			onAppend(type) {
				if (fault === "unreadable" && type === "pi-continue-watchdog:ai-unlock")
					statusUnreadable = true;
			},
			onReadBranch() {
				if (statusUnreadable) throw new Error("branch read failed");
			},
			...(fault === "absent"
				? { omitPersistedEntryTypes: ["pi-continue-watchdog:ai-unlock"] }
				: {}),
			...(fault === "throws"
				? { appendThrows: "pi-continue-watchdog:ai-unlock" }
				: {}),
		});
		await startIdle(harness);
		await harness.openDecision();
		// Aggregate busy: an observable child stays busy across publication.
		let child: HubAttachment | null = null;
		await settleResponse(harness, {
			...harness.answerUnlock("Waiting for the child.", "WAIT_CALLBACK"),
			effect() {
				if (fault === "busy")
					child = harness.hub.bind({
						instance: createHubAttachmentInstance(),
						sessionId: "busy-child",
						hasUI: false,
						initialBusy: true,
					}).attachment;
			},
		});
		const label = `callback-status/${fault}`;
		if (child !== null) {
			// Busy before the guarded commit defers the result: no charge/signal.
			assert.equal(harness.controller.snapshot.locked, true, label);
			assert.equal(harness.controller.snapshot.callbackSuspended, false, label);
			assert.equal(harness.controller.snapshot.attempt, 0, label);
			assert.equal(hooks.includes("user-ready"), false, label);
			harness.hub.markIdle(child);
			await settleOnly(harness);
			assert.equal(harness.controller.snapshot.attempt, 0, label);
			assert.equal(harness.controller.snapshot.callbackSuspended, false, label);
			assert.equal(hooks.includes("user-ready"), false, label);
			assert.ok(
				harness.clock.records.some(
					(record) => record.delayMs === 10_000 && !record.cleared,
				),
				"deferred result re-arms the ordinary idle fence",
			);
			continue;
		}
		assert.equal(harness.controller.snapshot.locked, true, label);
		assert.equal(harness.controller.snapshot.callbackSuspended, true, label);
		assert.equal(harness.controller.snapshot.attempt, 1, label);
		assert.equal(
			harness.sent.some(
				(entry) => entry.message.customType === "pi-continue-watchdog:event",
			),
			false,
			label,
		);
		assert.equal(hooks.includes("user-ready"), false, label);
		// Repeated confirmations never refund or charge again.
		if (fault === "unreadable") statusUnreadable = false;
		await settleOnly(harness);
		await settleOnly(harness);
		assert.equal(harness.controller.snapshot.attempt, 1, label);
		assert.equal(harness.controller.snapshot.callbackSuspended, true, label);
		const signals = hooks.filter((name) => name === "user-ready").length;
		assert.equal(signals, fault === "unreadable" ? 1 : 0, label);
	}
});

test("aggregate busy after an accepted callback suspension defers only its signal", async () => {
	const hooks: string[] = [];
	let harnessRef: Harness | null = null;
	let child: HubAttachment | null = null;
	const harness = createHarness({
		config: CALLBACK_REASONS,
		onHook: (name) => hooks.push(name),
		// The quiet status append happens after the guarded commit; a child
		// becoming busy there races the status/hook confirmation.
		onAppend(type) {
			if (type !== "pi-continue-watchdog:ai-unlock" || child !== null) return;
			assert.ok(harnessRef);
			child = harnessRef.hub.bind({
				instance: createHubAttachmentInstance(),
				sessionId: "late-busy-child",
				hasUI: false,
				initialBusy: true,
			}).attachment;
		},
	});
	harnessRef = harness;
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerUnlock("Waiting for the child.", "WAIT_CALLBACK"),
	);
	assert.ok(child, "busy child bound after commit");
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.callbackSuspended, true);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(hooks.includes("user-ready"), false);
	harness.hub.markIdle(child);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await settleOnly(harness);
	await settleOnly(harness);
	assert.equal(hooks.filter((name) => name === "user-ready").length, 1);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(harness.controller.snapshot.callbackSuspended, true);
});

test("UI-only status publication resists synchronous same-idle reentry", async () => {
	// R3 regression: appendEntry can reenter terminal confirmation
	// synchronously (for example a hub state report triggered while the
	// status append is still in flight). The in-flight guard must hold the
	// reentry off so exactly one status entry is appended for the outcome.
	let harnessRef: Harness;
	let entered = false;
	const hooks: string[] = [];
	const harness = createHarness({
		hasUI: true,
		onHook: (name) => hooks.push(name),
		onAppend(type) {
			if (type === "pi-continue-watchdog:ai-unlock" && !entered) {
				entered = true;
				harnessRef.hub.bind({
					instance: createHubAttachmentInstance(),
					sessionId: "reentrant-child",
					hasUI: false,
					initialBusy: false,
				});
			}
		},
	});
	harnessRef = harness;
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerUnlock());

	const statuses = harness.entries.filter(
		(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
	);
	assert.equal(entered, true, "the reentry path actually executed");
	assert.equal(statuses.length, 1, "one status despite synchronous reentry");
	assert.deepEqual(statuses, [
		{
			type: "pi-continue-watchdog:ai-unlock",
			data: {
				reasonType: "JOB_DONE",
				reason: "All requested work is complete.",
				exchangeId: "exchange-1",
				cycleId: 1,
			},
		},
	]);
	// At most one user-ready hook fires for the single outcome.
	assert.ok(
		hooks.filter((name) => name.includes("user")).length <= 1,
		"at most one user-ready hook",
	);
	assert.equal(harness.controller.snapshot.locked, false);
});

test("private file prompt and validation derive effective custom constraints without registration", async () => {
	const harness = createHarness({
		config: {
			reasonTypes: ["NeedReview", "shipped"],
			continueReasonTypes: ["verifying", "NeedReview"],
		},
	});
	await startIdle(harness);
	await harness.openDecision();
	const prompt = harness.privateDriver.children[0]?.prompts[0] ?? "";
	assert.match(prompt, /NeedReview/);
	assert.match(prompt, /shipped/);
	assert.match(prompt, /verifying/);
	assert.deepEqual(harness.registeredTools, []);
	await settleResponse(
		harness,
		harness.answerUnlock("Old default not configured.", "JOB_DONE"),
	);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.controller.snapshot.locked, true);
	await settleResponse(
		harness,
		harness.answerUnlock("PR ready.", "needreview"),
	);
	assert.equal(harness.controller.snapshot.locked, false);
	const status = harness.entries.find(
		(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
	);
	assert.equal(
		(status?.data as { reasonType?: string } | undefined)?.reasonType,
		"NEEDREVIEW",
	);
	assert.deepEqual(harness.registeredTools, []);
});

test("private decision phases never register public tools and use distinct owned files", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerContinue());
	await harness.openDecision();
	await settleResponse(harness, harness.answerUnlock());
	assert.deepEqual(harness.registeredTools, []);
	assert.deepEqual(harness.decisionToolDefinitions, []);
	assert.equal(harness.privateDriver.children.length, 2);
	assert.notEqual(
		harness.privateDriver.children[0]?.sessionId,
		harness.privateDriver.children[1]?.sessionId,
	);
	assert.notEqual(
		harness.privateDriver.forkInputs[0]?.resultFile,
		harness.privateDriver.forkInputs[1]?.resultFile,
	);
});

test("changed effective constraints reload on ownership reclaim without public declaration", async () => {
	// Main-handoff reload changes file policy, never public tool registry.
	const hub = createObservableAgentHub();
	const clock = new FakeClock();
	const handlers = new Map<string, Handler[]>();
	const holder = {
		controller: null as ReturnType<typeof createLockDecisionController> | null,
	};
	const registered: unknown[] = [];
	const configs = [
		{
			idleDelaySeconds: 3,
			maxContinue: 3,
			decisionPrompt: "Decide now.",
			continuePrompt: "Continue compactly.",
			reasonTypes: ["JOB_DONE"],
			continueReasonTypes: ["WORK_REMAINS"],
			unlockShortcut: "alt+u" as const,
			unlockReviewEnabled: false,
		},
		{
			idleDelaySeconds: 3,
			maxContinue: 3,
			decisionPrompt: "Decide now.",
			continuePrompt: "Continue compactly.",
			reasonTypes: ["NeedReview"],
			continueReasonTypes: ["verifying"],
			unlockShortcut: "alt+u" as const,
			unlockReviewEnabled: false,
		},
	];
	let loadCount = 0;
	const instance = createHubAttachmentInstance();
	const runtime = createDecisionRuntime({
		pi: {
			on(event: string, handler: Handler): void {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			sendMessage(): void {},
			appendEntry(): void {},
			registerTool(definition: { readonly name: string }): void {
				registered.push(definition);
			},
		} as unknown as ExtensionAPI,
		hub,
		attachmentInstance: instance,
		controllerHolder: holder,
		clock,
		loadConfig: async () => ({
			config: configs[Math.min(loadCount++, configs.length - 1)],
			diagnostics: [],
		}),
	});
	runtime.registerLifecycle();
	const ctx = {
		hasUI: false,
		cwd: "/project",
		isIdle: () => true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "main" },
		ui: { notify(): void {} },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" } as never, ctx);
	}
	assert.equal(registered.length, 0);
	assert.deepEqual(runtime.config.reasonTypes, ["JOB_DONE"]);

	// A UI usurper demotes the attachment; a same-runtime reclaim loads a new
	// lifecycle config and refreshes only the same named declaration.
	const usurper = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "usurper",
		hasUI: true,
	});
	assert.ok(usurper.mainClaim);
	hub.detach(usurper.attachment);
	// The runtime's own attachment identity was bound at session_start; a
	// probe bind on the same instance returns it unchanged.
	const attachment = hub.bind({
		instance,
		sessionId: "main",
		hasUI: true,
	}).attachment;
	hub.reclaimMain(attachment);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(registered.length, 0);
	assert.deepEqual(runtime.config.reasonTypes, ["NeedReview"]);
	assert.deepEqual(runtime.config.continueReasonTypes, ["verifying"]);

	// A second demote/reclaim cycle loads the same config a third time — equal
	// effective constraints emit no further registration.
	const usurper2 = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "usurper-2",
		hasUI: true,
	});
	assert.ok(usurper2.mainClaim);
	hub.detach(usurper2.attachment);
	hub.reclaimMain(attachment);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(
		registered.length,
		0,
		"constraint reload never registers public tools",
	);
	runtime.shutdown();
});

test("private runtime leaves foreign cw and disabled tool membership untouched", async () => {
	const harness = createHarness();
	const foreign = { name: "cw", execute: () => "foreign" };
	const definitions = harness.decisionToolDefinitions;
	definitions.push(foreign);
	assert.deepEqual(harness.activeTools, ["read"]);
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(harness, harness.answerUnlock());
	assert.deepEqual(harness.registeredTools, []);
	assert.deepEqual(definitions, [foreign]);
	assert.equal(foreign.execute(), "foreign");
	assert.deepEqual(
		harness.activeTools,
		["read"],
		"disabled foreign cw must stay disabled",
	);
});

test("invalid private singleton JSON payload records one safe format error", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerRaw({
			reason_type: "JOB_DONE",
			reason_content: "No action.",
		}),
	);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	const audit = harness.entries.findLast(
		(entry) => entry.type === "pi-continue-watchdog:private-response",
	);
	assert.equal(
		(audit?.data as { outcome?: { kind?: string } })?.outcome?.kind,
		"invalid",
	);
	assert.equal(JSON.stringify(audit).includes("No action."), false);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 2);
	assert.equal(harness.sent.length, 0);
});

test("invalid private action enum counts one response with only explicit correction", async () => {
	for (const action of ["bogus", "wait"]) {
		const harness = createHarness();
		await startIdle(harness);
		await harness.openDecision();
		await settleResponse(
			harness,
			harness.answerRaw({
				action,
				reason_type: "JOB_DONE",
				reason_content: "x",
			}),
		);
		assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
		assert.equal(harness.privateDriver.children[0]?.prompts.length, 2);
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(harness.sent.length, 0);
	}
});

test("compatible mixed-case JSON input keeps preparation and accepted normalization", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	const args = {
		action: " UNLOCK ",
		reason_type: " job_done ",
		reason_content: " All done. ",
	};
	assert.deepEqual(
		prepareDecisionArguments(
			args,
			harness.config.reasonTypes,
			harness.config.continueReasonTypes,
		),
		{ action: "unlock", reason_type: "JOB_DONE", reason_content: "All done." },
	);
	await settleResponse(harness, harness.answerRaw(args));
	assert.equal(harness.controller.snapshot.locked, false);
	const status = harness.entries.find(
		(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
	);
	assert.equal(
		(status?.data as { reason?: string } | undefined)?.reason,
		"All done.",
	);
	assert.equal(
		(status?.data as { reasonType?: string } | undefined)?.reasonType,
		"JOB_DONE",
	);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 1);
});

test("valid private correction after invalid payload executes once in same child", async () => {
	const harness = createHarness();
	await startIdle(harness);
	await harness.openDecision();
	await settleResponse(
		harness,
		harness.answerRaw({
			action: "bogus",
			reason_type: "JOB_DONE",
			reason_content: "x",
		}),
	);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(
		harness.privateDriver.current?.settled,
		false,
		"invalid candidate cannot settle the outer handoff",
	);
	assert.match(
		harness.privateDriver.children[0]?.prompts[1] ?? "",
		/previous decision result failed validation/,
	);
	assert.match(
		harness.privateDriver.children[0]?.prompts[1] ?? "",
		/action must be one of continue or unlock/,
	);
	await settleResponse(harness, harness.answerUnlock());
	assert.equal(
		harness.privateDriver.operations.length,
		1,
		"one outer terminal operation",
	);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.privateDriver.children.length, 1);
	assert.equal(harness.privateDriver.children[0]?.prompts.length, 2);
	assert.deepEqual(harness.privateDriver.children[0]?.fileStates, ["{}", "{}"]);
	assert.equal(
		harness.entries.filter(
			(entry) => entry.type === "pi-continue-watchdog:private-response",
		).length,
		2,
	);
	assert.equal(
		harness.entries.filter(
			(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
		).length,
		1,
	);
	assert.equal(harness.triggeredTurns, 0);
});
