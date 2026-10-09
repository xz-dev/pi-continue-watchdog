import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { handleUnlock, type MainCommandRuntime } from "../src/commands.js";
import type { ContinueWatchdogConfig } from "../src/config.js";
import {
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_MESSAGE_TYPE,
} from "../src/context-fold.js";
import { createLockDecisionController } from "../src/controller.js";
import {
	buildDecisionPrompt,
	MISSING_DECISION_CALL_ERROR,
} from "../src/decision-protocol.js";
import {
	createHubAttachmentInstance,
	createObservableAgentHub,
} from "../src/hub.js";
import type {
	JudgeRequest,
	ReviewResult,
	ReviewService,
} from "../src/judgment-client.js";
import type { ProcessDomainCoordinator } from "../src/process-domain.js";
import {
	createDecisionRuntime,
	type RuntimeClock,
	type RuntimeTimerHandle,
	UNLOCK_REVIEW_ENTRY_TYPE,
} from "../src/runtime.js";
import {
	UNLOCK_REVIEW_PROJECTION_VERSION,
	UNLOCK_REVIEW_QUESTION_ID,
	type UnlockReviewProjection,
} from "../src/unlock-review.js";

interface TimerRecord {
	callback: () => void;
	delayMs: number;
	cleared: boolean;
	unrefCount: number;
}

class FakeClock implements RuntimeClock {
	readonly records: TimerRecord[] = [];
	private currentTimeMs = 0;

	setTimeout(callback: () => void, delayMs: number) {
		const record: TimerRecord & { unref(): void } = {
			callback,
			delayMs,
			cleared: false,
			unrefCount: 0,
			unref() {
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

const _EMPTY_PROJECTION: UnlockReviewProjection = {
	projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
	rows: [],
	gaps: [],
	sourceHeadId: null,
	compactionBoundaryId: null,
};

function reviewResult(
	choice: string,
	overrides: Partial<ReviewResult> = {},
): ReviewResult {
	return {
		answers: {
			[UNLOCK_REVIEW_QUESTION_ID]: {
				type: "choice",
				choice,
				probabilities: {},
				confidence: 1,
			},
		},
		dropped: [],
		backend: "classifier",
		model: "typesafe/jev-1.13",
		stopReason: "stop",
		reuse: { hits: 0, joined: 0, sent: 1 },
		progress: { stages: [] },
		diagnostics: {
			attempts: [
				{
					id: "fixture#1",
					ordinal: 1,
					phase: "end",
					outcome: "response",
					inputTokens: 10,
					outputTokens: 5,
					costUsd: 0.001,
				},
			],
			attemptCount: 1,
			usage: {
				inputTokens: { knownSum: 10, missing: 0 },
				outputTokens: { knownSum: 5, missing: 0 },
				costUsd: { knownSum: 0.001, missing: 0 },
			},
			observationCoverage: "complete",
		},
		unresolved: [],
		...overrides,
	};
}

interface CwTool {
	readonly execute: (
		toolCallId: string,
		args: unknown,
		options?: unknown,
		context?: { readonly toolCallId?: string },
	) => Promise<{
		readonly content: Array<{ type: string; text?: string }>;
		readonly details?: { readonly outcome?: string };
	}>;
}

interface HarnessHooks {
	readonly onAppend?: (type: string, data: unknown, harness: Harness) => void;
	readonly onSend?: (message: unknown, harness: Harness) => void;
	readonly onContext?: (harness: Harness) => void;
	readonly onWidget?: (value: unknown, harness: Harness) => void;
	readonly onBranch?: (harness: Harness) => void;
}

interface Harness {
	readonly sent: Array<{
		message: {
			customType: string;
			content: string;
			display: boolean;
			details: unknown;
		};
		options?: { triggerTurn?: boolean; deliverAs?: string };
		streaming?: boolean;
	}>;
	readonly entries: Array<{ type: string; data: unknown }>;
	readonly branch: Array<{
		id: string;
		type: string;
		customType?: string;
		data?: unknown;
		details?: unknown;
		message?: { role: string };
	}>;
	readonly clock: FakeClock;
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly notifications: Array<{ message: string; level?: string }>;
	readonly reviewCalls: JudgeRequest[];
	readonly signals: (AbortSignal | undefined)[];
	streaming: boolean;
	pendingMessages: boolean;
	triggeredTurns: number;
	cwTool: CwTool | null;
	readonly userMessages: unknown[];
	readonly runtime: ReturnType<typeof createDecisionRuntime>;
	loseOwnership(): void;
	fire(name: string, event: unknown): Promise<void>;
	openDecision(): Promise<void>;
	settle(message: unknown): Promise<void>;
	answer(
		reason?: string,
		reasonType?: string,
		action?: "unlock" | "continue",
	): unknown;
	answerInvalid(): unknown;
	unlock(): Promise<void>;
}

function createHarness(options?: {
	readonly config?: Partial<ContinueWatchdogConfig>;
	readonly reviewResult?: () => Promise<ReviewResult>;
	readonly reviewDelay?: boolean;
	readonly processDomain?: ProcessDomainCoordinator;
	readonly hooks?: HarnessHooks;
	/** Omit the injected service so real call-time discovery runs. */
	readonly noInjectedService?: boolean;
}): Harness {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: 3,
		maxRetries: 3,
		decisionPrompt: "Decide now.",
		continuePrompt: "Continue compactly.",
		reasonTypes: options?.config?.reasonTypes ?? [
			"JOB_DONE",
			"WAIT_USER",
			"JOB_BLOCKED",
		],
		continueReasonTypes: options?.config?.continueReasonTypes ?? [
			"WORK_REMAINS",
			"VERIFYING",
		],
		unlockShortcut: "alt+u",
		unlockReviewEnabled: options?.config?.unlockReviewEnabled ?? true,
	};
	const hub = createObservableAgentHub();
	const attachmentInstance = createHubAttachmentInstance();
	const controller = createLockDecisionController(config);
	const holder = { controller };
	const handlers = new Map<string, Handler[]>();
	const clock = new FakeClock();
	const sent: Harness["sent"] = [];
	const entries: Harness["entries"] = [];
	const branch: Harness["branch"] = [];
	const notifications: Harness["notifications"] = [];
	const reviewCalls: JudgeRequest[] = [];
	const signals: (AbortSignal | undefined)[] = [];
	const pendingResolvers: Array<() => void> = [];

	const reviewService: ReviewService = {
		version: 1,
		reviewVersion: 1,
		judge: async () => {
			throw new Error("judge must not be called");
		},
		availability: async () => {
			throw new Error("availability probe must not be called");
		},
		review: async (req, opts) => {
			reviewCalls.push(req);
			signals.push(opts?.signal);
			if (options?.reviewDelay) {
				await new Promise<void>((resolve) => pendingResolvers.push(resolve));
			}
			return (
				options?.reviewResult ?? (async () => reviewResult("supported"))
			)();
		},
	};

	const pi = {
		events: { emit(): void {} },
		on(name: string, handler: Handler): void {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		async sendUserMessage(message: unknown): Promise<void> {
			harness.userMessages.push(message);
		},
		sendMessage(
			message: Harness["sent"][number]["message"],
			sendOptions?: Harness["sent"][number]["options"],
		): void {
			options?.hooks?.onSend?.(message, harness);
			sent.push({
				message,
				options: sendOptions,
				streaming: harness.streaming,
			});
			if (
				message.customType === DECISION_FOLD_MESSAGE_TYPE ||
				message.customType === "pi-continue-watchdog:event"
			) {
				branch.push({
					id: `fold-${branch.length + 1}`,
					type: "custom_message",
					customType: message.customType,
					details: message.details,
				});
			}
			if (sendOptions?.triggerTurn && !harness.streaming)
				harness.triggeredTurns += 1;
		},
		registerTool(definition: { readonly name: string }): void {
			if (definition.name === "cw") harness.cwTool = definition as never;
		},
		appendEntry(type: string, data: unknown): void {
			options?.hooks?.onAppend?.(type, data, harness);
			entries.push({ type, data });
			branch.push({
				id: `custom-${branch.length + 1}`,
				type: "custom",
				customType: type,
				data,
			});
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/project",
		isIdle: () => !harness.streaming,
		hasPendingMessages: () => harness.pendingMessages,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => "main",
			getSessionFile: () => undefined,
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => {
				options?.hooks?.onBranch?.(harness);
				return branch;
			},
			buildContextEntries: () => {
				options?.hooks?.onContext?.(harness);
				return branch;
			},
		},
		ui: {
			notify(message: string, level?: string): void {
				notifications.push({ message, level });
			},
			setWidget(_key: string, value: unknown): void {
				options?.hooks?.onWidget?.(value, harness);
			},
		},
		abort(): void {},
	} as unknown as ExtensionContext;

	const runtime = createDecisionRuntime({
		pi,
		hub,
		attachmentInstance,
		controllerHolder: holder,
		injectedController: true,
		initialConfig: config,
		clock,
		createExchangeId: (() => {
			let n = 0;
			return () => `exchange-${++n}`;
		})(),
		...(options?.noInjectedService === true ? {} : { reviewService }),
		processDomain: options?.processDomain,
	});
	runtime.registerLifecycle();

	const harness: Harness = {
		sent,
		entries,
		branch,
		clock,
		controller,
		notifications,
		reviewCalls,
		signals,
		streaming: false,
		pendingMessages: false,
		triggeredTurns: 0,
		cwTool: null,
		userMessages: [],
		runtime,
		loseOwnership: () => {
			const bound = hub.bind({
				instance: attachmentInstance,
				sessionId: "main",
				hasUI: true,
			});
			hub.detach(bound.attachment);
		},
		fire: async (name, event) => {
			if (name === "message_start") {
				await runtime.handleMessageStart(event as { message: unknown }, ctx);
			}
			for (const handler of handlers.get(name) ?? [])
				await handler(event as never, ctx);
		},
		openDecision: async () => {
			await harness.fire("session_start", { type: "session_start" });
			runtime.applyTransition(controller.lock(), undefined, {
				suppressNotify: true,
			});
			runtime.reconcileIdle();
			clock.fire(clock.records.length - 1);
			await Promise.resolve();
			await Promise.resolve();
			harness.streaming = true;
			await harness.fire("agent_start", { type: "agent_start" });
			const decision = sent.at(-1);
			assert.equal(decision?.message.customType, DECISION_MESSAGE_TYPE);
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
					details: decision.message.details,
					timestamp: Date.now(),
				},
			});
			await harness.fire("context", {
				type: "context",
				messages: [
					{
						role: "custom",
						customType: decision.message.customType,
						content: [{ type: "text", text: decision.message.content }],
						details: decision.message.details,
						timestamp: Date.now(),
					},
				],
			});
		},
		settle: async (message) => {
			// message_end captures the plan; endDecisionMessage-equivalent: run
			// tool_call gate + cw execute for each toolCall block, then agent_end
			// and agent_settled finalize through deliverPending.
			const replaced = await (async () => {
				let result: unknown;
				for (const handler of handlers.get("message_end") ?? []) {
					result = await handler(
						{ type: "message_end", message } as never,
						ctx,
					);
				}
				return result;
			})();
			const dispatched =
				(replaced as { message?: { content?: unknown[] } } | undefined)
					?.message ?? (message as { content?: unknown[] });
			for (const block of (
				dispatched as { content?: Array<Record<string, unknown>> }
			).content ?? []) {
				if (block?.type !== "toolCall") continue;
				let gate: unknown;
				for (const handler of handlers.get("tool_call") ?? []) {
					gate = await handler(
						{
							type: "tool_call",
							toolCallId: block.id,
							toolName: block.name,
							input: block.arguments,
						} as never,
						ctx,
					);
				}
				if (
					gate !== null &&
					typeof gate === "object" &&
					(gate as { block?: boolean }).block === true
				)
					continue;
				if (block.name === "cw" && harness.cwTool) {
					await harness.cwTool.execute(
						String(block.id),
						block.arguments,
						undefined,
						{ toolCallId: String(block.id) },
					);
				}
			}
			await harness.fire("agent_end", {
				type: "agent_end",
				messages: [message],
			});
			harness.streaming = false;
			await harness.fire("agent_settled", { type: "agent_settled" });
			await Promise.resolve();
			await Promise.resolve();
		},
		answer: (reason = "Done.", reasonType = "JOB_DONE", action = "unlock") => ({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: `cw-${Math.random()}`,
					name: "cw",
					arguments: {
						action,
						reason_type: reasonType,
						reason_content: reason,
					},
				},
			],
			stopReason: "stop",
		}),
		answerInvalid: () => ({
			role: "assistant",
			content: [{ type: "text", text: "prose" }],
			stopReason: "stop",
		}),
		unlock: async () => {
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
		},
	};
	// Resolve any pending delayed reviews between macro-steps.
	(harness as Harness & { flushReviews(): void }).flushReviews = () => {
		for (const resolve of pendingResolvers.splice(0)) resolve();
	};
	return harness;
}

async function flush(harness: Harness): Promise<void> {
	(harness as Harness & { flushReviews(): void }).flushReviews();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function latestInquiry(harness: Harness) {
	const inquiry = harness.sent.findLast(
		(entry) => entry.message.customType === DECISION_MESSAGE_TYPE,
	);
	assert.ok(inquiry);
	return inquiry.message;
}

async function authorizeLatestInquiry(harness: Harness): Promise<void> {
	const message = latestInquiry(harness);
	const wire = {
		role: "custom",
		customType: message.customType,
		content: [{ type: "text", text: message.content }],
		details: message.details,
		timestamp: Date.now(),
	};
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("message_start", { type: "message_start", message: wire });
	await harness.fire("context", { type: "context", messages: [wire] });
}

async function openReconsideration(harness: Harness, reasonType = "JOB_DONE") {
	await harness.openDecision();
	await harness.settle(harness.answer("Original unlock claim.", reasonType));
	await flush(harness);
	const inquiry = latestInquiry(harness);
	assert.match(inquiry.content, /challenged/);
	assert.equal(harness.reviewCalls.length, 1);
	return inquiry;
}

const ENABLED = { unlockReviewEnabled: true };
const DISABLED = { unlockReviewEnabled: false };

// ---------- 1.1 eligibility ----------

test("disabled config performs zero service discovery or requests", async () => {
	const harness = createHarness({ config: DISABLED });
	await harness.openDecision();
	await harness.settle(harness.answer());
	assert.equal(harness.reviewCalls.length, 0);
	assert.equal(harness.controller.snapshot.locked, false);
});

test("continue candidates never reach the service", async () => {
	const harness = createHarness({ config: ENABLED });
	await harness.openDecision();
	await harness.settle({
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "cw-1",
				name: "cw",
				arguments: {
					action: "continue",
					reason_type: "WORK_REMAINS",
					reason_content: "work",
				},
			},
		],
		stopReason: "stop",
	});
	assert.equal(harness.reviewCalls.length, 0);
	assert.equal(harness.controller.snapshot.attempt, 1);
});

test("manual unlock never reaches the service", async () => {
	const harness = createHarness({ config: ENABLED });
	await harness.openDecision();
	await harness.unlock();
	assert.equal(harness.reviewCalls.length, 0);
});

// Spy on the real call-time discovery registry used by the sealed client.
function withDiscoverySpy(run: () => Promise<void>): Promise<number> {
	const key = Symbol.for("pi-llm-as-jev:service");
	const registry = globalThis as Record<symbol, unknown>;
	const previous = Object.getOwnPropertyDescriptor(registry, key);
	let lookups = 0;
	Object.defineProperty(registry, key, {
		configurable: true,
		get() {
			lookups += 1;
			return undefined;
		},
	});
	return run()
		.then(() => lookups)
		.finally(() => {
			if (previous === undefined) delete registry[key];
			else Object.defineProperty(registry, key, previous);
		});
}

test("invalid, aborted and terminal-error decision responses perform no service lookup", async () => {
	const cases: Array<[string, unknown]> = [
		["invalid", undefined],
		[
			"aborted",
			{
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				stopReason: "aborted",
			},
		],
		[
			"terminal error",
			{
				role: "assistant",
				content: [{ type: "text", text: "provider failed" }],
				stopReason: "error",
			},
		],
	];
	for (const [label, message] of cases) {
		const harness = createHarness({ config: ENABLED, noInjectedService: true });
		const lookups = await withDiscoverySpy(async () => {
			await harness.openDecision();
			await harness.settle(message ?? harness.answerInvalid());
			await flush(harness);
		});
		assert.equal(lookups, 0, label);
		assert.equal(
			harness.entries.filter((e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE).length,
			0,
			label,
		);
		assert.equal(
			harness.notifications.some((n) =>
				n.message.includes("Unlock review skipped"),
			),
			false,
			label,
		);
	}
});

test("a valid AI unlock is the only path that performs real discovery", async () => {
	const harness = createHarness({ config: ENABLED, noInjectedService: true });
	const lookups = await withDiscoverySpy(async () => {
		await harness.openDecision();
		await harness.settle(harness.answer());
		await flush(harness);
	});
	assert.equal(lookups, 1);
});

// ---------- 2.x service contract ----------

test("a supported review releases the original unlock through the existing path", async () => {
	const harness = createHarness({ config: ENABLED });
	await harness.openDecision();
	await harness.settle(harness.answer("All done.", "JOB_DONE"));
	await flush(harness);
	// After the review resolves, another settle commits the still-current candidate.
	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	await flush(harness);
	assert.equal(harness.reviewCalls.length, 1);
	assert.equal(harness.controller.snapshot.locked, false);
	const reviewRecord = harness.entries.find(
		(e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE,
	);
	assert.ok(reviewRecord);
	assert.ok(reviewRecord);
	assert.equal(
		(reviewRecord.data as { outcome?: string }).outcome,
		"supported",
	);
});

test("an unavailable service yields an incomplete review and still releases the current unlock", async () => {
	const _harness = createHarness({ config: ENABLED });
	// Remove the injected service by pointing reviewService at a throwing one? We test
	// incomplete on service error instead — separate test covers absent via status.
	const unavailable = createHarness({
		config: ENABLED,
		reviewResult: async () => {
			throw new Error("service down");
		},
	});
	await unavailable.openDecision();
	await unavailable.settle(unavailable.answer());
	await flush(unavailable);
	unavailable.streaming = false;
	await unavailable.fire("agent_settled", { type: "agent_settled" });
	await flush(unavailable);
	assert.equal(unavailable.reviewCalls.length, 1);
	assert.equal(unavailable.controller.snapshot.locked, false);
	const record = unavailable.entries.find(
		(e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE,
	);
	assert.ok(record);
	assert.equal((record.data as { outcome?: string }).outcome, "incomplete");
	assert.equal(
		(record.data as { incompleteReason?: string }).incompleteReason,
		"error",
	);
});

test("enabled with no jev service: warns, skips review, and unlocks normally", async () => {
	const harness = createHarness({ config: ENABLED, noInjectedService: true });
	await harness.openDecision();
	await harness.settle(harness.answer());
	await flush(harness);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.reviewCalls.length, 0);
	const warnings = harness.notifications.filter(
		(n) => n.level === "warning" && n.message.includes("Unlock review skipped"),
	);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]?.message ?? "", /unavailable/);
	const records = harness.entries.filter(
		(e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE,
	);
	assert.equal(records.length, 1);
	const [record] = records;
	assert.ok(record);
	assert.equal(
		(record.data as { incompleteReason?: string }).incompleteReason,
		"unavailable",
	);
});

test("service error and abort map to incomplete, never approval", async () => {
	for (const stopReason of ["error", "aborted"] as const) {
		const harness = createHarness({
			config: ENABLED,
			reviewResult: async () =>
				reviewResult("supported", {
					stopReason,
					answers: {},
					errorMessage: "x",
				}),
		});
		await harness.openDecision();
		await harness.settle(harness.answer());
		await flush(harness);
		harness.streaming = false;
		await harness.fire("agent_settled", { type: "agent_settled" });
		await flush(harness);
		const record = harness.entries.find(
			(e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE,
		);
		assert.ok(record);
		assert.equal(
			(record.data as { outcome?: string }).outcome,
			"incomplete",
			stopReason,
		);
		assert.equal(
			(record.data as { incompleteReason?: string }).incompleteReason,
			stopReason,
		);
	}
});

test("insufficient_evidence and missing answers settle incomplete", async () => {
	for (const choice of ["insufficient_evidence"] as const) {
		const harness = createHarness({
			config: ENABLED,
			reviewResult: async () => reviewResult(choice),
		});
		await harness.openDecision();
		await harness.settle(harness.answer());
		await flush(harness);
		harness.streaming = false;
		await harness.fire("agent_settled", { type: "agent_settled" });
		await flush(harness);
		const record = harness.entries.find(
			(e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE,
		);
		assert.ok(record);
		assert.equal((record.data as { outcome?: string }).outcome, "incomplete");
		assert.equal(
			(record.data as { incompleteReason?: string }).incompleteReason,
			"insufficient-evidence",
		);
	}
	const missing = createHarness({
		config: ENABLED,
		reviewResult: async () => reviewResult("supported", { answers: {} }),
	});
	await missing.openDecision();
	await missing.settle(missing.answer());
	await flush(missing);
	missing.streaming = false;
	await missing.fire("agent_settled", { type: "agent_settled" });
	await flush(missing);
	const record = missing.entries.find(
		(e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE,
	);
	assert.ok(record);
	assert.equal(
		(record.data as { incompleteReason?: string }).incompleteReason,
		"malformed",
	);
});

// ---------- 3.x lifecycle ----------

test("a challenged unlock opens exactly one reconsideration and never republishes the old candidate", async () => {
	const harness = createHarness({
		config: ENABLED,
		reviewResult: async () => reviewResult("challenged"),
	});
	await harness.openDecision();
	await harness.settle(harness.answer("Done.", "JOB_DONE"));
	await flush(harness);
	// The challenge settles during settle() itself: the superseded candidate
	// is replaced by exactly one reconsideration inquiry in the same settle.
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, true);
	// The challenged candidate never published a quiet unlock status entry.
	assert.equal(
		harness.entries.filter((e) => e.type === "pi-continue-watchdog:ai-unlock")
			.length,
		0,
	);
	const reviewRecord = harness.entries.find(
		(e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE,
	);
	assert.ok(reviewRecord);
	assert.equal(
		(reviewRecord.data as { outcome?: string }).outcome,
		"challenged",
	);
	// The reconsideration prompt carries the challenge feedback.
	const reconsiderPrompt = harness.sent.findLast(
		(e) => e.message.customType === DECISION_MESSAGE_TYPE,
	);
	assert.ok(reconsiderPrompt);
	assert.match(reconsiderPrompt.message.content, /challenged/i);
	assert.match(reconsiderPrompt.message.content, /JOB_DONE/);
});

test("reconsidered unlock commits without a second review", async () => {
	let calls = 0;
	const harness = createHarness({
		config: ENABLED,
		reviewResult: async () => {
			calls += 1;
			return reviewResult("challenged");
		},
	});
	await harness.openDecision();
	await harness.settle(harness.answer("Done.", "JOB_DONE"));
	await flush(harness);
	// Reconsideration run: answer unlock again — committed directly, no second review.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	const second = harness.sent
		.filter((e) => e.message.customType === DECISION_MESSAGE_TYPE)
		.at(-1);
	assert.ok(second);
	await harness.fire("message_start", {
		type: "message_start",
		message: {
			role: "custom",
			customType: second.message.customType,
			content: [{ type: "text", text: second.message.content }],
			details: second.message.details,
			timestamp: Date.now(),
		},
	});
	await harness.fire("context", {
		type: "context",
		messages: [
			{
				role: "custom",
				customType: second.message.customType,
				content: [{ type: "text", text: second.message.content }],
				details: second.message.details,
				timestamp: Date.now(),
			},
		],
	});
	await harness.settle(harness.answer("Still done.", "JOB_DONE"));
	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	await flush(harness);
	assert.equal(calls, 1, "reconsidered answer must not be reviewed again");
	assert.equal(harness.controller.snapshot.locked, false);
});

test("user takeover during an in-flight review aborts it and blocks the fallback", async () => {
	const harness = createHarness({ config: ENABLED, reviewDelay: true });
	await harness.openDecision();
	await harness.settle(harness.answer());
	// Review in flight; user takes over before it resolves.
	await harness.unlock();
	// Resolve the delayed review: stale callback cannot publish or relock.
	(harness as Harness & { flushReviews(): void }).flushReviews();
	await flush(harness);
	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	await flush(harness);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(
		harness.entries.filter((e) => e.type === "pi-continue-watchdog:ai-unlock")
			.length,
		0,
	);
});

test("manual unlock while a never-settling review is in flight aborts it; late settle is inert", async () => {
	// The consumer adds no outer timer: the service may legitimately wait
	// without a fixed total bound. Manual unlock must abort the request
	// immediately via the lifecycle-linked AbortController, and a late
	// settlement callback must never publish, relock, or charge.
	const abortStates: boolean[] = [];
	const harness = createHarness({
		config: ENABLED,
		reviewResult: () =>
			new Promise<ReviewResult>(() => {
				/* never settles */
			}),
	});
	await harness.openDecision();
	await harness.settle(harness.answer());
	await Promise.resolve();
	assert.equal(harness.reviewCalls.length, 1);
	const signal = harness.signals.at(-1);
	assert.ok(signal);
	abortStates.push(signal.aborted);
	// Manual unlock is immediate even though the review never resolves.
	await harness.unlock();
	abortStates.push(signal.aborted);
	assert.deepEqual(abortStates, [false, true]);
	assert.equal(harness.controller.snapshot.locked, false);
	// No review record is appended for the aborted request.
	assert.equal(
		harness.entries.filter((e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE).length,
		0,
	);
});

// ---------- repair batch 1 regressions ----------

test("interactive input during idle pending-review retires the decision and proceeds normally (F1)", async () => {
	const harness = createHarness({ config: ENABLED, reviewDelay: true });
	await harness.openDecision();
	await harness.settle(harness.answer());
	await Promise.resolve();
	assert.equal(harness.reviewCalls.length, 1);
	// The original agent_settled already returned; host is idle again.
	assert.equal(harness.streaming, false);
	// A genuine interactive input must not be captured-and-stranded: the
	// pending review is aborted, the stale unlock candidate retires, and
	// the input proceeds as a normal fresh user turn (no `handled`).
	const signal = harness.signals.at(-1);
	assert.ok(signal);
	await harness.fire("input", {
		type: "input",
		source: "interactive",
		text: "New user task; resume now",
	});
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(signal.aborted, true, "review must be aborted by takeover");
	// The decision candidate is invalidated so a late service result is inert.
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	// The input itself was allowed to proceed: no capture-and-hold means the
	// runtime did not claim ownership of the user turn. We assert the same
	// observable signal: no synthetic reissue is needed because the input was
	// never swallowed.
	assert.equal(
		harness.userMessages.length,
		0,
		"input should not be captured for reissue",
	);
	// Late review resolution is inert: no unlock, no relock, no second inquiry.
	(harness as Harness & { flushReviews(): void }).flushReviews();
	await flush(harness);
	await harness.fire("agent_settled", { type: "agent_settled" });
	await flush(harness);
	assert.equal(
		harness.entries.filter((e) => e.type === "pi-continue-watchdog:ai-unlock")
			.length,
		0,
	);
});

test("reentrant buildContextEntries cancellation prevents stale review start (F2)", async () => {
	// A synchronous manual unlock fired from inside the snapshot boundary
	// must retire the candidate before the pending review is installed.
	let armed = false;
	let canceled = false;
	const harness = createHarness({
		config: ENABLED,
		reviewDelay: true,
		hooks: {
			onContext: (h) => {
				if (armed && !canceled) {
					canceled = true;
					void h.unlock();
				}
			},
		},
	});
	await harness.openDecision();
	armed = true;
	await harness.settle(harness.answer());
	await flush(harness);
	assert.equal(canceled, true);
	assert.equal(
		harness.reviewCalls.length,
		0,
		"no review request may start after the snapshot-boundary cancellation",
	);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(
		harness.entries.filter((e) => e.type === "pi-continue-watchdog:ai-unlock")
			.length,
		0,
	);
});

test("stale challenge cannot open work on a reentrantly replaced lock cycle (F2)", async () => {
	// challenge cleanup dispatches the old inquiry fold; a synchronous
	// restartLockCycle inside sendMessage must leave the stale challenge
	// unable to open exchange-2 on the replacement cycle.
	let armed = false;
	let fired = false;
	const harness = createHarness({
		config: ENABLED,
		reviewResult: async () => reviewResult("challenged"),
		hooks: {
			onSend: (message, h) => {
				if (
					armed &&
					!fired &&
					(message as { customType?: string }).customType ===
						"pi-continue-watchdog:inquiry-fold"
				) {
					fired = true;
					h.runtime.restartLockCycle();
				}
			},
		},
	});
	await harness.openDecision();
	armed = true;
	await harness.settle(harness.answer());
	await flush(harness);
	assert.equal(fired, true);
	assert.equal(
		harness.controller.snapshot.decisionOpen,
		false,
		"stale challenge must not open a decision in the replacement cycle",
	);
	assert.equal(
		harness.sent.filter((e) => e.message.customType === DECISION_MESSAGE_TYPE)
			.length,
		1,
		"only the initial inquiry was ever dispatched",
	);
});

test("reconsideration keeps the same fixed cw contract and configured reason lists (F9)", async () => {
	const customUnlock = ["CUSTOM_JOB_DONE_X7"];
	const customContinue = ["CUSTOM_WORK_REMAINS_X7"];
	const harness = createHarness({
		config: {
			unlockReviewEnabled: true,
			reasonTypes: customUnlock,
			continueReasonTypes: customContinue,
		},
		reviewResult: async () => reviewResult("challenged"),
	});
	await harness.openDecision();
	await harness.settle(harness.answer("Done.", "CUSTOM_JOB_DONE_X7"));
	await flush(harness);
	// The last decision-type dispatch is the reconsideration inquiry.
	const allDecisionDispatches = harness.sent.filter(
		(e) => e.message.customType === DECISION_MESSAGE_TYPE,
	);
	assert.equal(
		allDecisionDispatches.length,
		2,
		"initial + exactly one reconsideration inquiry",
	);
	const reconsideration = allDecisionDispatches[1];
	const content = reconsideration.message.content;
	// Challenge feedback is present.
	assert.match(content, /challenged/i);
	assert.match(content, /CUSTOM_JOB_DONE_X7/);
	// Fixed protocol guidance must still be present: configured reason lists,
	// field-size limit, assessment-first and delivery-boundary wording.
	assert.match(content, /CUSTOM_WORK_REMAINS_X7/);
	assert.match(content, /CUSTOM_JOB_DONE_X7/);
	assert.match(content, /assessment/i);
	assert.match(content, /reason_content/i);
	assert.match(content, /cw/i);
});

test("busy dispatch deferral preserves the one-reconsideration bound (F3)", async () => {
	// Defer the reconsideration inquiry dispatch once via pendingMessages,
	// then resume on genuine idle: the same semantic phase must resume
	// without a fresh initial inquiry and without a second review call.
	let deferred = false;
	const harness = createHarness({
		config: ENABLED,
		reviewResult: async () => reviewResult("challenged"),
		hooks: {
			onSend: (message, h) => {
				if (
					!deferred &&
					(message as { customType?: string }).customType ===
						DECISION_MESSAGE_TYPE &&
					String((message as { content?: string }).content).includes(
						"challenged",
					)
				) {
					deferred = true;
					h.pendingMessages = true;
				}
			},
		},
	});
	await harness.openDecision();
	await harness.settle(harness.answer("Done.", "JOB_DONE"));
	await flush(harness);
	assert.equal(deferred, true);
	assert.equal(harness.reviewCalls.length, 1);
	// The deferred inquiry never dispatched its turn while busy. Release.
	harness.pendingMessages = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	harness.clock.fire(harness.clock.records.length - 1);
	await Promise.resolve();
	await Promise.resolve();
	const inquiries = harness.sent.filter(
		(e) => e.message.customType === DECISION_MESSAGE_TYPE,
	);
	const lastInquiry = inquiries.at(-1);
	assert.ok(lastInquiry);
	assert.match(
		lastInquiry.message.content,
		/challenged/i,
		"resumed inquiry must carry the same challenge feedback",
	);
	// Initial inquiry + deferred reconsideration dispatch + resume reopen =
	// at most 3 total dispatches; the semantic bound is that only ONE
	// review ran and no fresh initial inquiry appeared in its place.
	assert.ok(
		inquiries.length <= 3,
		`expected at most 3 inquiry dispatches, got ${inquiries.length}`,
	);
	// Drive the resumed reconsideration to a valid unlock: it commits
	// directly, without a second service call.
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("message_start", {
		type: "message_start",
		message: {
			role: "custom",
			customType: lastInquiry.message.customType,
			content: [{ type: "text", text: lastInquiry.message.content }],
			details: lastInquiry.message.details,
			timestamp: Date.now(),
		},
	});
	await harness.fire("context", {
		type: "context",
		messages: [
			{
				role: "custom",
				customType: lastInquiry.message.customType,
				content: [{ type: "text", text: lastInquiry.message.content }],
				details: lastInquiry.message.details,
				timestamp: Date.now(),
			},
		],
	});
	await harness.settle(harness.answer("Still done.", "JOB_DONE"));
	await flush(harness);
	assert.equal(
		harness.reviewCalls.length,
		1,
		"deferred-then-resumed reconsidered unlock must not be re-reviewed",
	);
	assert.equal(harness.controller.snapshot.locked, false);
});

for (const gap of ["dispatch", "unconsumed"] as const) {
	for (const consumed of [1, 2]) {
		test(`F3-B1: ${consumed} consumed invalid replacements survive ${gap} deferral`, async () => {
			let deferred = false;
			const reasonTypes = ["SHIPPED", "NEEDS_INPUT"];
			const continueReasonTypes = ["DO_WORK", "VERIFY"];
			const harness = createHarness({
				config: { ...ENABLED, reasonTypes, continueReasonTypes },
				reviewResult: async () => reviewResult("challenged"),
				hooks: {
					onSend: (message, h) => {
						const prompt = message as {
							customType?: string;
							content?: string;
							details?: { attempt?: number };
						};
						if (
							gap === "dispatch" &&
							!deferred &&
							prompt.customType === DECISION_MESSAGE_TYPE &&
							prompt.content?.includes("challenged") &&
							prompt.details?.attempt === consumed + 1
						) {
							deferred = true;
							h.pendingMessages = true;
						}
					},
				},
			});
			const reconsideration = await openReconsideration(harness, "SHIPPED");
			const fixed = buildDecisionPrompt(
				"Decide now.",
				reasonTypes,
				continueReasonTypes,
			);
			assert.ok(reconsideration.content.startsWith(fixed));
			for (let count = 0; count < consumed; count += 1) {
				await authorizeLatestInquiry(harness);
				await harness.settle(harness.answerInvalid());
				await flush(harness);
			}
			if (gap === "unconsumed") {
				harness.pendingMessages = true;
				await harness.fire("agent_settled", { type: "agent_settled" });
			} else {
				assert.equal(deferred, true, "correction send crossed BUSY boundary");
			}
			assert.equal(harness.controller.snapshot.locked, true);
			assert.equal(harness.controller.snapshot.decisionOpen, false);
			assert.equal(
				harness.controller.snapshot.invalidDecisionAttempts,
				consumed,
			);
			assert.equal(harness.controller.snapshot.attempt, 0);

			harness.pendingMessages = false;
			await harness.fire("agent_settled", { type: "agent_settled" });
			harness.clock.fire(harness.clock.records.length - 1);
			await flush(harness);
			const resumed = latestInquiry(harness);
			assert.equal(
				(resumed.details as { attempt: number }).attempt,
				consumed + 1,
			);
			assert.ok(
				resumed.content.startsWith(reconsideration.content),
				"fixed contract, custom lists and exact original challenge survive together",
			);
			assert.ok(
				resumed.content.includes(
					`Your previous decision response was invalid: ${MISSING_DECISION_CALL_ERROR}`,
				),
			);
			assert.equal(
				harness.controller.snapshot.invalidDecisionAttempts,
				consumed,
			);
			for (let count = consumed + 1; count <= 3; count += 1) {
				await authorizeLatestInquiry(harness);
				await harness.settle(harness.answerInvalid());
				await flush(harness);
				assert.equal(
					harness.controller.snapshot.invalidDecisionAttempts,
					count,
				);
				assert.equal(harness.controller.snapshot.decisionFailed, count === 3);
			}
			const sentBeforeFourth = harness.sent.length;
			assert.equal(harness.controller.snapshot.decisionOpen, false);
			assert.equal(
				harness.sent.some(
					(entry) =>
						entry.message.customType === DECISION_MESSAGE_TYPE &&
						(entry.message.details as { attempt: number }).attempt > 3,
				),
				false,
				"no fourth correction dispatched",
			);
			// Replaying the last prompt cannot authorize a fourth valid result.
			await authorizeLatestInquiry(harness);
			await harness.settle(harness.answer("Stale fourth response.", "SHIPPED"));
			assert.equal(harness.sent.length, sentBeforeFourth);
			assert.equal(harness.controller.snapshot.locked, true);
			assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 3);
			assert.equal(harness.controller.snapshot.attempt, 0);
			assert.equal(harness.reviewCalls.length, 1);
			assert.equal(
				harness.entries.some(
					(e) => e.type === "pi-continue-watchdog:ai-unlock",
				),
				false,
			);
		});
	}
}

test("F3-B1: BUSY before invalid commit retains the consumed response and safe diagnostic", async () => {
	let armed = false;
	let deferred = false;
	const harness = createHarness({
		reviewResult: async () => reviewResult("challenged"),
		hooks: {
			onAppend: (type, data, h) => {
				if (
					armed &&
					!deferred &&
					type === "pi-continue-watchdog:decision-audit" &&
					(data as { outcome?: string }).outcome === "invalid"
				) {
					deferred = true;
					h.pendingMessages = true;
				}
			},
		},
	});
	await openReconsideration(harness);
	await authorizeLatestInquiry(harness);
	await harness.settle(harness.answerInvalid());
	await authorizeLatestInquiry(harness);
	armed = true;
	await harness.settle(harness.answerInvalid());
	assert.equal(deferred, true);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	const inquiriesBefore = harness.sent.filter(
		(e) => e.message.customType === DECISION_MESSAGE_TYPE,
	).length;
	harness.pendingMessages = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 2);
	assert.equal(
		harness.sent.filter((e) => e.message.customType === DECISION_MESSAGE_TYPE)
			.length,
		inquiriesBefore + 1,
	);
	assert.equal(
		(latestInquiry(harness).details as { attempt: number }).attempt,
		3,
	);
	assert.ok(
		latestInquiry(harness).content.includes(MISSING_DECISION_CALL_ERROR),
	);
	await authorizeLatestInquiry(harness);
	await harness.settle(harness.answerInvalid());
	assert.equal(harness.controller.snapshot.decisionFailed, true);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 3);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.reviewCalls.length, 1);
});

for (const action of ["unlock", "continue"] as const) {
	for (const consumed of [0, 2]) {
		test(`F3-B2: publication-only BUSY preserves valid ${action} after ${consumed} invalid responses once on genuine idle`, async () => {
			let armed = false;
			const harness = createHarness({
				config: ENABLED,
				reviewResult: async () => reviewResult("challenged"),
				hooks: {
					onAppend: (type, data, h) => {
						if (
							!armed &&
							type === "pi-continue-watchdog:decision-audit" &&
							(data as { outcome?: string }).outcome === action &&
							h.sent.some(
								(e) =>
									e.message.customType === DECISION_MESSAGE_TYPE &&
									e.message.content.includes("challenged"),
							)
						) {
							armed = true;
							h.pendingMessages = true;
						}
					},
				},
			});
			await openReconsideration(harness);
			for (let count = 0; count < consumed; count += 1) {
				await authorizeLatestInquiry(harness);
				await harness.settle(harness.answerInvalid());
			}
			await authorizeLatestInquiry(harness);
			await harness.settle(
				harness.answer(
					"Already validated replacement.",
					action === "unlock" ? "JOB_DONE" : "WORK_REMAINS",
					action,
				),
			);
			await flush(harness);
			assert.equal(armed, true);
			const inquiriesBefore = harness.sent.filter(
				(e) => e.message.customType === DECISION_MESSAGE_TYPE,
			).length;
			const triggeredBefore = harness.triggeredTurns;
			assert.equal(inquiriesBefore, 2 + consumed);
			assert.equal(
				harness.controller.snapshot.invalidDecisionAttempts,
				consumed,
			);
			assert.equal(harness.controller.snapshot.locked, true);
			assert.equal(
				harness.controller.snapshot.attempt,
				0,
				"no charge while waiting for publication",
			);
			assert.equal(
				harness.entries.some(
					(e) => e.type === "pi-continue-watchdog:ai-unlock",
				),
				false,
			);
			// Repeated BUSY settle is inert; clearing queue alone cannot publish.
			await harness.fire("agent_settled", { type: "agent_settled" });
			harness.pendingMessages = false;
			harness.runtime.reconcileIdle();
			await flush(harness);
			assert.equal(harness.controller.snapshot.attempt, 0);
			assert.equal(harness.controller.snapshot.locked, true);
			await harness.fire("agent_settled", { type: "agent_settled" });
			await flush(harness);
			assert.equal(harness.controller.snapshot.locked, action === "continue");
			assert.equal(
				harness.controller.snapshot.attempt,
				action === "continue" ? 1 : 0,
			);
			assert.equal(
				harness.triggeredTurns,
				triggeredBefore + (action === "continue" ? 1 : 0),
			);
			assert.equal(
				harness.sent.filter(
					(e) => e.message.customType === DECISION_MESSAGE_TYPE,
				).length,
				inquiriesBefore,
			);
			assert.equal(
				harness.entries.filter(
					(e) => e.type === "pi-continue-watchdog:ai-unlock",
				).length,
				action === "unlock" ? 1 : 0,
			);
			assert.equal(
				harness.sent.filter(
					(e) =>
						e.message.customType === DECISION_FOLD_MESSAGE_TYPE &&
						(e.message.details as { watchdogOutcome?: string })
							.watchdogOutcome === action,
				).length,
				1,
			);
			assert.equal(harness.reviewCalls.length, 1);
			const sentAfterPublication = harness.sent.length;
			await harness.fire("agent_settled", { type: "agent_settled" });
			await harness.fire("agent_settled", { type: "agent_settled" });
			assert.equal(
				harness.sent.length,
				sentAfterPublication,
				"no duplicate publication",
			);
			assert.equal(
				harness.controller.snapshot.attempt,
				action === "continue" ? 1 : 0,
			);
		});
	}
}

for (const cancel of [
	"manual",
	"restart",
	"takeover",
	"abort",
	"branch-retirement",
	"session-shutdown",
	"ownership",
] as const) {
	test(`F3-B2: ${cancel} in BUSY gap discards accepted pending plan`, async () => {
		let armed = false;
		const harness = createHarness({
			reviewResult: async () => reviewResult("challenged"),
			hooks: {
				onAppend: (type, data, h) => {
					if (
						armed &&
						type === "pi-continue-watchdog:decision-audit" &&
						(data as { outcome?: string }).outcome === "continue"
					)
						h.pendingMessages = true;
				},
			},
		});
		await openReconsideration(harness);
		await authorizeLatestInquiry(harness);
		armed = true;
		await harness.settle(
			harness.answer("Original pending work.", "WORK_REMAINS", "continue"),
		);
		assert.equal(harness.controller.snapshot.attempt, 0);
		if (cancel === "manual") await harness.unlock();
		else if (cancel === "restart") harness.runtime.restartLockCycle();
		else if (cancel === "abort") {
			harness.controller.unlock();
			harness.runtime.clearOperationalPendingWork();
		} else if (cancel === "branch-retirement") {
			// Same retirement seam used by lifecycle replacement, not native branch integration.
			harness.runtime.clearOperationalPendingWork();
			harness.branch.splice(0);
		} else if (cancel === "session-shutdown") await harness.runtime.shutdown();
		else if (cancel === "ownership") harness.loseOwnership();
		else
			await harness.fire("input", {
				type: "input",
				source: "interactive",
				text: "New task",
			});
		harness.pendingMessages = false;
		await harness.fire("agent_settled", { type: "agent_settled" });
		await flush(harness);
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(
			harness.sent.some(
				(e) =>
					e.message.customType === DECISION_FOLD_MESSAGE_TYPE &&
					(e.message.details as { watchdogOutcome?: string })
						.watchdogOutcome === "continue",
			),
			false,
		);
		assert.equal(
			harness.entries.some((e) => e.type === "pi-continue-watchdog:ai-unlock"),
			false,
		);
		assert.equal(harness.reviewCalls.length, 1);
	});
}

test("F3-B2 postcommit: UI BUSY retains accepted continuation until real idle", async () => {
	let fired = false;
	const harness = createHarness({
		reviewResult: async () => reviewResult("challenged"),
		hooks: {
			onWidget: (value, h) => {
				if (
					!fired &&
					value === undefined &&
					h.controller.snapshot.attempt === 1
				) {
					fired = true;
					h.pendingMessages = true;
				}
			},
		},
	});
	await openReconsideration(harness);
	await authorizeLatestInquiry(harness);
	const original = latestInquiry(harness).details;
	await harness.settle(
		harness.answer(
			"Preserve accepted continuation.",
			"WORK_REMAINS",
			"continue",
		),
	);
	assert.equal(fired, true, "BUSY introduced only after valid cw commit");
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(
		harness.sent.filter((e) => e.message.customType === DECISION_MESSAGE_TYPE)
			.length,
		2,
	);
	assert.equal(
		harness.sent.some(
			(e) =>
				(e.message.details as { watchdogOutcome?: string }).watchdogOutcome ===
				"continue",
		),
		false,
	);
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.controller.snapshot.attempt, 0);
	harness.pendingMessages = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	await flush(harness);
	const continuations = harness.sent.filter(
		(e) =>
			(e.message.details as { watchdogOutcome?: string }).watchdogOutcome ===
			"continue",
	);
	assert.equal(continuations.length, 1);
	assert.ok(continuations[0]);
	assert.equal(
		(continuations[0].message.details as { inquiryId?: string }).inquiryId,
		(original as { inquiryId?: string }).inquiryId,
	);
	assert.equal(harness.controller.snapshot.attempt, 1);
	const sent = harness.sent.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.sent.length, sent);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(harness.reviewCalls.length, 1);
	assert.equal(
		harness.sent.filter((e) => e.message.customType === DECISION_MESSAGE_TYPE)
			.length,
		2,
	);
});

test("F3-B2 postcommit: a second readiness race refunds reapply without replacing intent", async () => {
	let uiBusy = false;
	let branchBusy = false;
	let armed = false;
	const harness = createHarness({
		reviewResult: async () => reviewResult("challenged"),
		hooks: {
			onWidget: (value, h) => {
				if (
					!uiBusy &&
					value === undefined &&
					h.controller.snapshot.attempt === 1
				) {
					uiBusy = true;
					h.pendingMessages = true;
				}
			},
			onBranch: (h) => {
				if (armed && !branchBusy && h.controller.snapshot.attempt === 1) {
					branchBusy = true;
					h.pendingMessages = true;
				}
			},
		},
	});
	await openReconsideration(harness);
	await authorizeLatestInquiry(harness);
	await harness.settle(
		harness.answer("Same intent.", "WORK_REMAINS", "continue"),
	);
	armed = true;
	harness.pendingMessages = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(branchBusy, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	harness.pendingMessages = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(
		harness.sent.filter(
			(e) =>
				(e.message.details as { watchdogOutcome?: string }).watchdogOutcome ===
				"continue",
		).length,
		1,
	);
	assert.equal(
		harness.sent.filter((e) => e.message.customType === DECISION_MESSAGE_TYPE)
			.length,
		2,
	);
	assert.equal(harness.reviewCalls.length, 1);
});

test("F3-B2 postcommit: unchanged process fence false-confirm retains accepted continuation", async () => {
	let harness: Harness;
	let held = false;
	let confirmedAfterCommit = 0;
	const fence = { domainEpoch: "fixture", activityGeneration: 0n };
	const domain: ProcessDomainCoordinator = {
		isRootProcess: true,
		snapshot: {
			domainId: "fixture",
			...fence,
			fence,
			busyParticipants: 0,
			allIdle: true,
		},
		attach: async () => {},
		reportIdle: async () => {},
		detach: async () => {},
		subscribe: () => () => {},
		confirm: async () => {
			if (harness?.controller.snapshot.attempt === 1 && !held) {
				held = true;
				confirmedAfterCommit += 1;
				return false;
			}
			return true;
		},
	};
	harness = createHarness({
		processDomain: domain,
		reviewResult: async () => reviewResult("challenged"),
	});
	await openReconsideration(harness);
	await authorizeLatestInquiry(harness);
	await harness.settle(
		harness.answer("Await confirmation.", "WORK_REMAINS", "continue"),
	);
	assert.equal(confirmedAfterCommit, 1);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(
		harness.sent.some(
			(e) =>
				(e.message.details as { watchdogOutcome?: string }).watchdogOutcome ===
				"continue",
		),
		false,
	);
	await harness.fire("agent_settled", { type: "agent_settled" });
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(
		harness.sent.filter(
			(e) =>
				(e.message.details as { watchdogOutcome?: string }).watchdogOutcome ===
				"continue",
		).length,
		1,
	);
	assert.equal(
		harness.sent.filter((e) => e.message.customType === DECISION_MESSAGE_TYPE)
			.length,
		2,
	);
	assert.equal(harness.reviewCalls.length, 1);
});

for (const cancel of [
	"manual",
	"restart-ABA",
	"takeover",
	"branch-retirement",
	"session-shutdown",
	"ownership",
] as const) {
	test(`F3-B2 postcommit: ${cancel} discards unsent accepted intent`, async () => {
		let fired = false;
		const harness = createHarness({
			reviewResult: async () => reviewResult("challenged"),
			hooks: {
				onWidget: (value, h) => {
					if (
						!fired &&
						value === undefined &&
						h.controller.snapshot.attempt === 1
					) {
						fired = true;
						h.pendingMessages = true;
					}
				},
			},
		});
		await openReconsideration(harness);
		await authorizeLatestInquiry(harness);
		await harness.settle(
			harness.answer(
				"Must not survive replacement.",
				"WORK_REMAINS",
				"continue",
			),
		);
		assert.equal(fired, true);
		assert.equal(harness.controller.snapshot.attempt, 0);
		if (cancel === "manual") await harness.unlock();
		else if (cancel === "restart-ABA") {
			harness.runtime.restartLockCycle();
			// Same numeric accepted count, but different lock cycle/provenance.
			const opened = harness.controller
				.beginDecision(0)
				.effects.find((effect) => effect.kind === "openDecisionWindow");
			assert.ok(opened?.kind === "openDecisionWindow");
			harness.controller.recordValidContinue(opened.decisionId);
			harness.controller.rollbackValidContinue();
		} else if (cancel === "takeover")
			await harness.fire("input", { source: "rpc", text: "New task" });
		else if (cancel === "branch-retirement") {
			harness.runtime.clearOperationalPendingWork();
			harness.branch.splice(0);
		} else if (cancel === "session-shutdown") await harness.runtime.shutdown();
		else harness.loseOwnership();
		harness.pendingMessages = false;
		await harness.fire("agent_settled", { type: "agent_settled" });
		await flush(harness);
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(
			harness.sent.some(
				(e) =>
					(e.message.details as { watchdogOutcome?: string })
						.watchdogOutcome === "continue",
			),
			false,
		);
		assert.equal(harness.reviewCalls.length, 1);
	});
}

test("F5 runtime: captured fixed request excludes native private bodies and source identities", async () => {
	const harness = createHarness();
	const publicMessage = {
		role: "user",
		content: [{ type: "text", text: "PUBLIC_COMPLETE_SCOPE" }],
		timestamp: 0,
	};
	const excluded = {
		role: "bashExecution",
		command: "EXCLUDED_COMMAND_BODY",
		output: "EXCLUDED_OUTPUT_BODY",
		excludeFromContext: true,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	};
	harness.branch.push(
		{ id: "public-scope", type: "message", message: publicMessage },
		{ id: "EXCLUDED_NATIVE_ID", type: "message", message: excluded },
	);
	await harness.openDecision();
	await harness.settle(harness.answer());
	await flush(harness);
	assert.equal(harness.reviewCalls.length, 1);
	const json = JSON.stringify(harness.reviewCalls[0]);
	for (const secret of [
		"EXCLUDED_NATIVE_ID",
		"EXCLUDED_COMMAND_BODY",
		"EXCLUDED_OUTPUT_BODY",
	])
		assert.equal(json.includes(secret), false, secret);
	assert.ok(json.includes("PUBLIC_COMPLETE_SCOPE"));
	assert.equal(harness.controller.snapshot.locked, false);
});

test("F5 runtime: unsupported content skips legal challenge and publishes current original once", async () => {
	const harness = createHarness({
		reviewResult: async () => reviewResult("challenged"),
	});
	const message = {
		role: "user",
		content: [
			{ type: "text", text: "public request" },
			{ type: "image", data: "PRIVATE_IMAGE_BYTES", mimeType: "image/png" },
		],
		timestamp: 0,
	};
	harness.branch.push({ id: "unavailable-media", type: "message", message });
	await harness.openDecision();
	await harness.settle(harness.answer("Original current candidate."));
	await flush(harness);
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.reviewCalls.length, 0);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(
		harness.sent.filter(
			(row) => row.message.customType === DECISION_MESSAGE_TYPE,
		).length,
		1,
	);
	assert.equal(
		harness.entries.filter(
			(row) => row.type === "pi-continue-watchdog:ai-unlock",
		).length,
		1,
	);
	const record = harness.entries.find(
		(row) => row.type === UNLOCK_REVIEW_ENTRY_TYPE,
	);
	assert.ok(record);
	const data = record.data as {
		outcome?: string;
		incompleteReason?: string;
		attemptCount?: number;
		usage?: unknown;
		observationCoverage?: string;
	};
	assert.equal(data.outcome, "incomplete");
	assert.equal(data.incompleteReason, "insufficient-evidence");
	assert.equal(data.attemptCount, undefined);
	assert.equal(data.usage, undefined);
	assert.equal(data.observationCoverage, undefined);
});

test("F5/F6 runtime: reentrant replacement during zero-call incomplete admission is inert", async () => {
	let invalidated = false;
	const harness = createHarness({
		reviewResult: async () => reviewResult("challenged"),
		hooks: {
			onAppend(type, data, h) {
				if (
					!invalidated &&
					type === UNLOCK_REVIEW_ENTRY_TYPE &&
					(data as { outcome?: string }).outcome === "incomplete"
				) {
					invalidated = true;
					h.runtime.restartLockCycle();
				}
			},
		},
	});
	const message = {
		role: "user",
		content: [
			{ type: "image", data: "PRIVATE_IMAGE_BYTES", mimeType: "image/png" },
		],
		timestamp: 0,
	};
	harness.branch.push({
		id: "unavailable-public-media",
		type: "message",
		message,
	});
	await harness.openDecision();
	await harness.settle(harness.answer());
	await flush(harness);
	assert.equal(invalidated, true);
	assert.equal(harness.reviewCalls.length, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(
		harness.entries.some(
			(row) => row.type === "pi-continue-watchdog:ai-unlock",
		),
		false,
	);
	assert.equal(
		harness.sent.filter(
			(row) => row.message.customType === DECISION_MESSAGE_TYPE,
		).length,
		1,
	);
});

test("F4 runtime: captured whole ordered fixed snapshot survives overflow fallback", async () => {
	const harness = createHarness({
		reviewResult: async () =>
			reviewResult("supported", {
				stopReason: "error",
				answers: {},
				contextOverflow: true,
			}),
	});
	const texts = [
		"EARLY_AUTHORITY",
		`MIDDLE_FULL_DELIVERY${"z".repeat(10_000)}`,
		"LATE_PERMISSION_LIMIT",
	];
	for (const [index, text] of texts.entries()) {
		const message = {
			role: index === 1 ? "assistant" : "user",
			content: [{ type: "text", text }],
			timestamp: 0,
			stopReason: "stop",
		};
		harness.branch.push({ id: `public-${index}`, type: "message", message });
	}
	await harness.openDecision();
	await harness.settle(harness.answer("Original unlock under current scope."));
	await flush(harness);
	assert.equal(harness.reviewCalls.length, 1);
	const actual = harness.reviewCalls[0];
	assert.ok(actual);
	assert.equal(actual.evidence, undefined);
	const snapshot = actual.state.macroSnapshot as { rows: { text: string }[] };
	assert.deepEqual(
		snapshot.rows.map((row) => row.text),
		texts,
	);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(
		harness.entries.filter(
			(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
		).length,
		1,
	);
	assert.equal(
		harness.sent.filter(
			(entry) => entry.message.customType === DECISION_MESSAGE_TYPE,
		).length,
		1,
	);
});

for (const kind of [
	"null",
	"missing-unresolved",
	"unobserved",
	"bad-usage",
	"overflow",
] as const) {
	test(`F7 runtime: ${kind} falls back to current original unlock once`, async () => {
		const payload =
			kind === "null"
				? null
				: kind === "missing-unresolved"
					? { ...reviewResult("challenged"), unresolved: undefined }
					: kind === "unobserved"
						? { ...reviewResult("challenged"), diagnostics: undefined }
						: kind === "bad-usage"
							? {
									...reviewResult("challenged"),
									diagnostics: {
										...reviewResult("challenged").diagnostics,
										usage: null,
									},
								}
							: reviewResult("supported", {
									stopReason: "error",
									answers: {},
									contextOverflow: true,
								});
		const harness = createHarness({
			reviewResult: async () => payload as ReviewResult,
		});
		await harness.openDecision();
		await harness.settle(harness.answer("Original still-current unlock."));
		await flush(harness);
		await harness.fire("agent_settled", { type: "agent_settled" });
		assert.equal(harness.controller.snapshot.locked, false);
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(harness.reviewCalls.length, 1);
		assert.equal(
			harness.sent.filter((e) => e.message.customType === DECISION_MESSAGE_TYPE)
				.length,
			1,
		);
		assert.equal(
			harness.entries.filter((e) => e.type === "pi-continue-watchdog:ai-unlock")
				.length,
			1,
		);
		const record = harness.entries.find(
			(e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE,
		);
		assert.ok(record);
		assert.equal((record.data as { outcome?: string }).outcome, "incomplete");
	});
}

for (const cancel of ["manual", "restart"] as const) {
	test(`F7 runtime: late malformed result after ${cancel} cannot affect replacement`, async () => {
		const harness = createHarness({
			reviewDelay: true,
			reviewResult: async () => null as unknown as ReviewResult,
		});
		await harness.openDecision();
		await harness.settle(harness.answer());
		assert.equal(harness.reviewCalls.length, 1);
		if (cancel === "manual") await harness.unlock();
		else harness.runtime.restartLockCycle();
		await flush(harness);
		await harness.fire("agent_settled", { type: "agent_settled" });
		assert.equal(harness.controller.snapshot.locked, cancel === "restart");
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(harness.reviewCalls.length, 1);
		assert.equal(
			harness.entries.some((e) => e.type === "pi-continue-watchdog:ai-unlock"),
			false,
		);
		assert.equal(
			harness.sent.filter((e) => e.message.customType === DECISION_MESSAGE_TYPE)
				.length,
			1,
		);
	});
}

test("review association record carries service identity and accounting", async () => {
	const harness = createHarness({
		config: ENABLED,
		reviewResult: async () =>
			reviewResult("supported", {
				diagnostics: {
					attempts: [
						{
							id: "fixture#1",
							ordinal: 1,
							phase: "end",
							outcome: "response",
							inputTokens: 100,
							outputTokens: 0,
							costUsd: 0.01,
						},
						{
							id: "fixture#2",
							ordinal: 2,
							phase: "end",
							outcome: "response",
							inputTokens: 0,
							outputTokens: 50,
						},
						{
							id: "fixture#3",
							ordinal: 3,
							phase: "end",
							outcome: "response",
							costUsd: 0,
						},
					],
					attemptCount: 3,
					usage: {
						inputTokens: { knownSum: 100, missing: 1 },
						outputTokens: { knownSum: 50, missing: 1 },
						costUsd: { knownSum: 0.01, missing: 1 },
					},
					observationCoverage: "complete",
				},
			}),
	});
	await harness.openDecision();
	await harness.settle(harness.answer());
	await flush(harness);
	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	await flush(harness);
	const record = harness.entries.find(
		(e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE,
	);
	assert.ok(record);
	const data = record?.data as Record<string, unknown>;
	assert.equal(data?.backend, "classifier");
	assert.equal(data?.model, "typesafe/jev-1.13");
	assert.equal(data?.attemptCount, 3);
	assert.equal((data?.usage as { missing?: number })?.missing, 3);
});
