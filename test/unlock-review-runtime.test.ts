import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
	buildSessionProjection,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { handleUnlock, type MainCommandRuntime } from "../src/commands.js";
import type { ContinueWatchdogConfig } from "../src/config.js";
import {
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_MESSAGE_TYPE,
} from "../src/context-fold.js";
import { createLockDecisionController } from "../src/controller.js";
import { buildDecisionFilePrompt } from "../src/decision-protocol.js";
import {
	createHubAttachmentInstance,
	createObservableAgentHub,
} from "../src/hub.js";
import type {
	JudgeRequest,
	JudgeResult,
	JudgmentService,
} from "../src/judgment-client.js";
import type { ProcessDomainCoordinator } from "../src/process-domain.js";
import {
	createDecisionRuntime,
	type RuntimeClock,
	type RuntimeTimerHandle,
	UNLOCK_REVIEW_ENTRY_TYPE,
} from "../src/runtime.js";
import { UNLOCK_REVIEW_QUESTION_ID } from "../src/unlock-review.js";
import {
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

const FIXTURE_USAGE = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
};

function reviewResult(
	choice: string,
	overrides: Partial<JudgeResult> = {},
): JudgeResult {
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
		usage: FIXTURE_USAGE,
		...overrides,
	};
}

interface HarnessHooks {
	readonly onAppend?: (type: string, data: unknown, harness: Harness) => void;
	readonly onContext?: (harness: Harness) => void;
	readonly onRender?: (harness: Harness) => void;
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
		message?: { role: string; content?: unknown[]; timestamp?: number };
	}>;
	readonly clock: FakeClock;
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly notifications: Array<{ message: string; level?: string }>;
	readonly reviewCalls: JudgeRequest[];
	readonly signals: (AbortSignal | undefined)[];
	readonly hooks: string[];
	streaming: boolean;
	pendingMessages: boolean;
	triggeredTurns: number;
	parentAborts: number;
	readonly driver: PrivateDriver;
	reviewPending: boolean;
	readonly userMessages: unknown[];
	readonly runtime: ReturnType<typeof createDecisionRuntime>;
	loseOwnership(): void;
	fire(name: string, event: unknown): Promise<void>;
	openDecision(): Promise<void>;
	settle(message: DriverReply): Promise<void>;
	answer(
		reason?: string,
		reasonType?: string,
		action?: "unlock" | "continue",
	): DriverReply;
	answerInvalid(): DriverReply;
	unlock(): Promise<void>;
	flushReviews(): void;
}

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.runtime.shutdown();
		harness.flushReviews();
	}
});

function createHarness(options?: {
	readonly config?: Partial<ContinueWatchdogConfig>;
	readonly reviewResult?: () => Promise<JudgeResult>;
	readonly reviewDelay?: boolean;
	readonly processDomain?: ProcessDomainCoordinator;
	readonly hooks?: HarnessHooks;
	/** Capture emitted semantic-hook envelope names. */
	readonly onHook?: (name: string) => void;
	/** Omit the injected service so real call-time discovery runs. */
	readonly noInjectedService?: boolean;
}): Harness {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: 3,
		maxContinue: options?.config?.maxContinue ?? 3,
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
	const branch: Harness["branch"] = [
		{
			id: "source-root",
			type: "message",
			message: { role: "user", content: [], timestamp: 0 },
		},
	];
	const driver = createPrivateDriver();
	const notifications: Harness["notifications"] = [];
	const reviewCalls: JudgeRequest[] = [];
	const signals: (AbortSignal | undefined)[] = [];
	const pendingResolvers: Array<() => void> = [];

	const reviewService: JudgmentService = {
		version: 2,
		judge: async (req, opts) => {
			reviewCalls.push(req);
			harness.reviewPending = true;
			signals.push(opts?.signal);
			if (options?.reviewDelay) {
				await new Promise<void>((resolve) =>
					pendingResolvers.push(() => {
						harness.reviewPending = false;
						resolve();
					}),
				);
			}
			try {
				return await (
					options?.reviewResult ?? (async () => reviewResult("supported"))
				)();
			} finally {
				harness.reviewPending = false;
			}
		},
		availability: async () => {
			throw new Error("availability probe must not be called");
		},
	};

	const pi = {
		events: {
			emit(_topic: string, envelope: { readonly name: string }): void {
				harness.hooks.push(envelope.name);
				options?.onHook?.(envelope.name);
			},
		},
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
		getThinkingLevel: () => "off",
		registerTool(): never {
			assert.fail("private decisions must not register public tools");
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
		model: { provider: "fake", id: "local" },
		modelRegistry: {},
		isIdle: () => !harness.streaming,
		hasPendingMessages: () => harness.pendingMessages,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => "main",
			getSessionFile: () => undefined,
			getEntries: () => [...branch],
			getEntry: (id: string) => branch.find((entry) => entry.id === id),
			buildSessionProjection: () =>
				buildSessionProjection(branch as SessionEntry[]),
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
			onTerminalInput() {
				return () => {};
			},
			notify(message: string, level?: string): void {
				notifications.push({ message, level });
			},
			setWidget(_key: string, value: unknown): void {
				if (
					typeof value !== "function" ||
					options?.hooks?.onRender === undefined
				)
					return;
				const factory = value as (
					tui: { requestRender(): void },
					theme: {
						fg(color: string, text: string): string;
						bg(color: string, text: string): string;
					},
				) => unknown;
				factory(
					{ requestRender: () => options.hooks?.onRender?.(harness) },
					{
						fg: (_color, text) => text,
						bg: (_color, text) => text,
					},
				);
			},
		},
		abort(): void {
			harness.parentAborts += 1;
		},
	} as unknown as ExtensionContext;

	const runtime = createDecisionRuntime({
		pi,
		hub,
		attachmentInstance,
		controllerHolder: holder,
		injectedController: true,
		initialConfig: config,
		clock,
		executePrivateDecision: driver.execute,
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
		hooks: [],
		streaming: false,
		pendingMessages: false,
		triggeredTurns: 0,
		parentAborts: 0,
		driver,
		reviewPending: false,
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
			clock.fire(
				clock.records.findLastIndex(
					(record) => !record.cleared && record.delayMs === 10_000,
				),
			);
			for (let turn = 0; turn < 2000; turn += 1) {
				if (
					driver.awaitingResponse ||
					driver.current?.settled ||
					!controller.snapshot.decisionOpen
				)
					break;
				await new Promise<void>((resolve) => setTimeout(resolve, 1));
			}
			assert.ok(
				driver.awaitingResponse ||
					driver.current?.settled ||
					!controller.snapshot.decisionOpen,
			);
			assert.equal(
				harness.streaming,
				false,
				"private generation leaves parent idle",
			);
			assert.equal(
				sent.some((e) => e.message.customType === DECISION_MESSAGE_TYPE),
				false,
			);
		},
		settle: async (reply) => {
			driver.respond(reply);
			await drain(harness);
		},
		answer: (reason = "Done.", reasonType = "JOB_DONE", action = "unlock") => ({
			write: JSON.stringify({
				action,
				reason_type: reasonType,
				reason_content: reason,
			}),
		}),
		answerInvalid: () => ({ write: "{}" }),
		flushReviews: () => {
			for (const resolve of pendingResolvers.splice(0)) resolve();
		},
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
	harnesses.push(harness);
	return harness;
}

// Filesystem-backed child work needs event-loop turns, not synthetic parent lifecycle.
async function drain(harness: Harness): Promise<void> {
	for (let turn = 0; turn < 2000; turn += 1) {
		if (
			harness.driver.current?.settled ||
			harness.driver.awaitingResponse ||
			harness.reviewPending
		) {
			if (harness.driver.current?.settled)
				await settlePrivateDecision(harness.driver);
			assert.equal(
				harness.sent.some(
					(row) => row.message.customType === DECISION_MESSAGE_TYPE,
				),
				false,
				"private prompts never enter parent messages",
			);
			const parentHistory = JSON.stringify([harness.sent, harness.entries]);
			assert.equal(parentHistory.includes("watchdog_result_file"), false);
			for (const fork of harness.driver.forkInputs)
				assert.equal(parentHistory.includes(fork.resultFile), false);
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	assert.fail(
		"private decision did not reach next response/review/terminal boundary",
	);
}

async function flush(harness: Harness): Promise<void> {
	harness.flushReviews();
	await drain(harness);
}

function latestPrivatePrompt(harness: Harness) {
	const child = harness.driver.children.at(-1);
	assert.ok(child);
	return { content: child.prompts.at(-1) ?? "" };
}

async function expectPrivateResponsePending(harness: Harness): Promise<void> {
	assert.equal(harness.streaming, false);
	assert.equal(harness.driver.awaitingResponse, true);
}

async function openReconsideration(harness: Harness, reasonType = "JOB_DONE") {
	await harness.openDecision();
	await harness.settle(harness.answer("Original unlock claim.", reasonType));
	await flush(harness);
	const inquiry = latestPrivatePrompt(harness);
	assert.match(inquiry.content, /challenged/);
	assert.equal(harness.reviewCalls.length, 1);
	assert.equal(harness.driver.children.length, 1);
	assert.equal(harness.driver.children[0]?.fileStates.at(-1), "{}");
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
	await harness.settle(harness.answer("work", "WORK_REMAINS", "continue"));
	assert.equal(harness.reviewCalls.length, 0);
	assert.equal(harness.controller.snapshot.attempt, 1);
});

test("manual unlock cancels exact private child, never parent or review service", async () => {
	const harness = createHarness({ config: ENABLED });
	await harness.openDecision();
	const child = harness.driver.children[0];
	assert.ok(child);
	await harness.unlock();
	await settlePrivateDecision(harness.driver);
	assert.equal(child.aborted, true);
	assert.equal(child.disposed, true);
	assert.equal(harness.parentAborts, 0);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.reviewCalls.length, 0);
	assert.equal(harness.driver.children.length, 1);
	assert.equal(harness.triggeredTurns, 0);
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
	const cases: Array<[string, DriverReply | undefined]> = [
		["invalid", undefined],
		[
			"aborted",
			{
				stopReason: "aborted",
			},
		],
		[
			"terminal error",
			{
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

test("reviewed unlock publishes user-ready without waiting for another settle or input", async () => {
	// Regression: the async review settlement runs detached from any
	// agent_settled handler. Before the fix, the terminal user-ready hook
	// stayed pending until the next external input/hub event fired
	// syncHubState (observed as minutes-late notifications).
	for (const setup of [
		{
			label: "supported",
			result: () => Promise.resolve(reviewResult("supported")),
		},
		{
			label: "incomplete (service error)",
			result: () => Promise.reject(new Error("service down")),
		},
	] satisfies Array<{ label: string; result: () => Promise<JudgeResult> }>) {
		const hooks: string[] = [];
		const harness = createHarness({
			config: ENABLED,
			reviewResult: setup.result,
			onHook: (name) => hooks.push(name),
		});
		await harness.openDecision();
		await harness.settle(harness.answer());
		// Flush resolves the delayed review and lets the detached settlement
		// chain (deliverPending -> publish) run. No extra agent_settled and no
		// user input may be required.
		await flush(harness);
		await flush(harness);
		assert.equal(harness.controller.snapshot.locked, false, setup.label);
		assert.equal(
			hooks.filter((name) => name === "user-ready").length,
			1,
			setup.label,
		);
	}
});

test("a supported review releases the original unlock through the existing path", async () => {
	const harness = createHarness({ config: ENABLED });
	await harness.openDecision();
	await harness.settle(harness.answer("All done.", "JOB_DONE"));
	await flush(harness);
	// Extra idle notifications cannot duplicate committed candidate.
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
	// Service exception is incomplete, never a semantic approval.
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

test("v1 discovery remains incomplete and releases only the current original unlock", async () => {
	const key = Symbol.for("pi-llm-as-jev:service");
	const registry = globalThis as Record<symbol, unknown>;
	const previous = Object.getOwnPropertyDescriptor(registry, key);
	let calls = 0;
	Object.defineProperty(registry, key, {
		configurable: true,
		value: {
			version: 1,
			judge: async () => {
				calls++;
				throw new Error("Incompatible service must not run");
			},
		},
	});
	try {
		const harness = createHarness({ config: ENABLED, noInjectedService: true });
		await harness.openDecision();
		await harness.settle(harness.answer());
		await flush(harness);
		assert.equal(calls, 0);
		assert.equal(harness.controller.snapshot.locked, false);
		assert.equal(harness.driver.children.length, 1);
		const record = harness.entries.find(
			(e) => e.type === UNLOCK_REVIEW_ENTRY_TYPE,
		);
		assert.ok(record);
		assert.equal((record.data as { outcome?: string }).outcome, "incomplete");
		assert.equal(
			(record.data as { incompleteReason?: string }).incompleteReason,
			"incompatible",
		);
	} finally {
		if (previous === undefined) delete registry[key];
		else Object.defineProperty(registry, key, previous);
	}
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
	// Outer operation remains pending across same-child reconsideration.
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
	const reconsiderPrompt = latestPrivatePrompt(harness).content;
	assert.match(reconsiderPrompt, /challenged/i);
	assert.match(reconsiderPrompt, /JOB_DONE/);
	assert.equal(harness.driver.children.length, 1);
	assert.equal(harness.driver.children[0]?.prompts.length, 2);
	assert.equal(harness.driver.children[0]?.fileStates.at(-1), "{}");
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
	// Replacement file is written by same child; parent remains idle.
	await expectPrivateResponsePending(harness);
	await harness.settle(harness.answer("Still done.", "JOB_DONE"));
	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	await flush(harness);
	assert.equal(calls, 1, "reconsidered answer must not be reviewed again");
	assert.equal(harness.controller.snapshot.locked, false);
});

const CALLBACK_ENABLED = {
	...ENABLED,
	reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
} as const;

const enterReconsideration = expectPrivateResponsePending;

test("reviewed callback candidates commit one suspension, never an unlock", async () => {
	for (const result of [
		async () => reviewResult("supported"),
		async () => {
			throw new Error("service down");
		},
	]) {
		const harness = createHarness({
			config: CALLBACK_ENABLED,
			reviewResult: result,
		});
		await harness.openDecision();
		await harness.settle(
			harness.answer("Waiting for the child.", "WAIT_CALLBACK"),
		);
		await flush(harness);
		harness.streaming = false;
		await harness.fire("agent_settled", { type: "agent_settled" });
		await flush(harness);
		assert.equal(harness.reviewCalls.length, 1);
		assert.equal(harness.controller.snapshot.locked, true);
		assert.equal(harness.controller.snapshot.callbackSuspended, true);
		assert.equal(harness.controller.snapshot.attempt, 1);
	}
});

test("challenged callback reconsiders once; replacement decides the charge", async () => {
	for (const [replacement, locked, attempt, action] of [
		["JOB_DONE", false, 0, "unlock"],
		["WAIT_CALLBACK", true, 1, "unlock"],
		["WORK_REMAINS", true, 1, "continue"],
	] as const) {
		let calls = 0;
		const harness = createHarness({
			config: CALLBACK_ENABLED,
			reviewResult: async () => {
				calls += 1;
				return reviewResult("challenged");
			},
		});
		await harness.openDecision();
		await harness.settle(
			harness.answer("Waiting for the child.", "WAIT_CALLBACK"),
		);
		await flush(harness);
		// Proposing/reviewing spent nothing and did not suspend.
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(harness.controller.snapshot.callbackSuspended, false);
		await enterReconsideration(harness);
		await harness.settle(harness.answer("Reconsidered.", replacement, action));
		harness.streaming = false;
		await harness.fire("agent_settled", { type: "agent_settled" });
		await flush(harness);
		assert.equal(calls, 1, replacement);
		assert.equal(harness.controller.snapshot.locked, locked, replacement);
		assert.equal(harness.controller.snapshot.attempt, attempt, replacement);
		assert.equal(
			harness.controller.snapshot.callbackSuspended,
			replacement === "WAIT_CALLBACK",
			replacement,
		);
	}
});

test("disabled review and corrected responses commit callback without extra charges", async () => {
	const disabled = createHarness({
		config: { ...CALLBACK_ENABLED, unlockReviewEnabled: false },
	});
	await disabled.openDecision();
	await disabled.settle(disabled.answer("Waiting.", "WAIT_CALLBACK"));
	await flush(disabled);
	assert.equal(disabled.reviewCalls.length, 0);
	assert.equal(disabled.controller.snapshot.callbackSuspended, true);
	assert.equal(disabled.controller.snapshot.attempt, 1);

	// An invalid first response is corrected; only the final callback charges.
	const corrected = createHarness({
		config: CALLBACK_ENABLED,
		reviewResult: async () => reviewResult("supported"),
	});
	await corrected.openDecision();
	await corrected.settle(corrected.answerInvalid());
	await flush(corrected);
	assert.equal(corrected.controller.snapshot.attempt, 0);
	assert.equal(corrected.controller.snapshot.callbackSuspended, false);
	await enterReconsideration(corrected);
	await corrected.settle(corrected.answer("Waiting.", "WAIT_CALLBACK"));
	await flush(corrected);
	corrected.streaming = false;
	await corrected.fire("agent_settled", { type: "agent_settled" });
	await flush(corrected);
	assert.equal(corrected.controller.snapshot.callbackSuspended, true);
	assert.equal(corrected.controller.snapshot.attempt, 1);
	assert.equal(corrected.controller.snapshot.invalidDecisionAttempts, 0);
});

test("callback work during an in-flight callback review retires the candidate", async () => {
	const harness = createHarness({
		config: CALLBACK_ENABLED,
		reviewDelay: true,
	});
	await harness.openDecision();
	await harness.settle(harness.answer("Waiting.", "WAIT_CALLBACK"));
	assert.equal(harness.reviewCalls.length, 1);
	// Actual callback work starts while the review is still pending.
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
	harness.flushReviews();
	await flush(harness);
	harness.streaming = false;
	await harness.fire("agent_settled", { type: "agent_settled" });
	await flush(harness);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.callbackSuspended, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(
		harness.entries.filter((e) => e.type === "pi-continue-watchdog:ai-unlock")
			.length,
		0,
	);
});

test("user takeover during an in-flight review aborts it and blocks the fallback", async () => {
	const harness = createHarness({ config: ENABLED, reviewDelay: true });
	await harness.openDecision();
	await harness.settle(harness.answer());
	// Review in flight; user takes over before it resolves.
	await harness.unlock();
	// Resolve the delayed review: stale callback cannot publish or relock.
	harness.flushReviews();
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

test("manual unlock aborts an unbounded in-flight review; late settle is inert", async () => {
	// The consumer adds no outer timer: the service may legitimately wait
	// without a fixed total bound. Manual unlock must abort the request
	// immediately via the lifecycle-linked AbortController, and a late
	// settlement callback must never publish, relock, or charge.
	const abortStates: boolean[] = [];
	let resolveReview: ((result: JudgeResult) => void) | undefined;
	const harness = createHarness({
		config: ENABLED,
		reviewResult: () =>
			new Promise<JudgeResult>((resolve) => {
				resolveReview = resolve;
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
	const child = harness.driver.children[0];
	assert.ok(child);
	assert.equal(child.aborted, true);
	assert.ok(resolveReview);
	resolveReview(reviewResult("supported"));
	await settlePrivateDecision(harness.driver);
	assert.equal(child.disposed, true);
	assert.equal(
		harness.entries.some(
			(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
		),
		false,
	);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.parentAborts, 0);
});

// ---------- repair batch 1 regressions ----------

test("interactive input during idle pending-review retires the decision and proceeds normally (F1)", async () => {
	const harness = createHarness({ config: ENABLED, reviewDelay: true });
	await harness.openDecision();
	await harness.settle(harness.answer());
	await Promise.resolve();
	assert.equal(harness.reviewCalls.length, 1);
	// Private work never made parent busy.
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
	harness.flushReviews();
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
	// Snapshot-boundary manual unlock retires private source before review starts.
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
	armed = true;
	await harness.openDecision();
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
	let fired = false;
	const harness = createHarness({
		reviewResult: async () => reviewResult("challenged"),
		hooks: {
			onAppend(type, data, h) {
				if (
					!fired &&
					type === UNLOCK_REVIEW_ENTRY_TYPE &&
					(data as { outcome?: string }).outcome === "challenged"
				) {
					fired = true;
					h.runtime.restartLockCycle();
				}
			},
		},
	});
	await harness.openDecision();
	await harness.settle(harness.answer());
	await flush(harness);
	assert.equal(fired, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.driver.children.length, 1);
	assert.equal(harness.driver.children[0]?.prompts.length, 1);
	assert.equal(harness.driver.children[0]?.aborted, true);
	assert.equal(
		harness.entries.some(
			(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
		),
		false,
	);
});

test("reconsideration keeps fixed file contract and configured reason lists (F9)", async () => {
	const reasonTypes = ["CUSTOM_JOB_DONE_X7"];
	const continueReasonTypes = ["CUSTOM_WORK_REMAINS_X7"];
	const harness = createHarness({
		config: { unlockReviewEnabled: true, reasonTypes, continueReasonTypes },
		reviewResult: async () => reviewResult("challenged"),
	});
	const reconsideration = await openReconsideration(
		harness,
		"CUSTOM_JOB_DONE_X7",
	);
	const child = harness.driver.children[0];
	assert.ok(child);
	const input = harness.driver.forkInputs[0];
	assert.ok(input);
	assert.equal(child.prompts.length, 2);
	assert.ok(
		reconsideration.content.startsWith(
			buildDecisionFilePrompt(
				"Decide now.",
				reasonTypes,
				continueReasonTypes,
				input.resultFile,
			),
		),
	);
	for (const pattern of [
		/challenged/i,
		/CUSTOM_JOB_DONE_X7/,
		/CUSTOM_WORK_REMAINS_X7/,
		/assessment/i,
		/reason_content/i,
		/opinion, not new evidence/,
		/write/i,
	])
		assert.match(reconsideration.content, pattern);
	assert.doesNotMatch(reconsideration.content, /cw function|structured_output/);
	await harness.settle(harness.answerInvalid());
	const correction = latestPrivatePrompt(harness).content;
	assert.match(correction, /failed validation/i);
	assert.match(correction, /CUSTOM_JOB_DONE_X7/);
	assert.match(correction, /CUSTOM_WORK_REMAINS_X7/);
	assert.ok(correction.includes(JSON.stringify(input.resultFile)));
	assert.match(child.prompts[1] ?? "", /challenged/i);
	assert.equal(harness.driver.children.length, 1);
	await harness.settle(harness.answer("Still complete.", "CUSTOM_JOB_DONE_X7"));
	assert.equal(harness.reviewCalls.length, 1);
	assert.equal(harness.controller.snapshot.locked, false);
});

// Removed: main-query dispatch/unconsumed replay. Private prompts never cross
// that boundary. Retain cancellation, consumed format budget and no-fourth fences.
for (const consumed of [0, 1, 2]) {
	for (const external of ["pending-messages", "parent-work"] as const) {
		test(`F3-B1: ${external} after ${consumed} invalid replacements cancels exact child`, async () => {
			const harness = createHarness({
				reviewResult: async () => reviewResult("challenged"),
			});
			await openReconsideration(harness);
			for (let count = 0; count < consumed; count += 1)
				await harness.settle(harness.answerInvalid());
			assert.equal(
				harness.controller.snapshot.invalidDecisionAttempts,
				consumed,
			);
			const child = harness.driver.children[0];
			assert.ok(child);
			if (external === "pending-messages") harness.pendingMessages = true;
			else {
				harness.streaming = true;
				await harness.fire("agent_start", { type: "agent_start" });
			}
			// A late valid file must lose authority when real work appears.
			await harness.settle(harness.answer("Late result."));
			await flush(harness);
			assert.equal(child.aborted, true);
			assert.equal(child.disposed, true);
			assert.equal((await harness.driver.current?.result)?.kind, "cancelled");
			assert.equal(harness.controller.snapshot.attempt, 0);
			assert.equal(harness.controller.snapshot.locked, true);
			assert.equal(harness.reviewCalls.length, 1);
			assert.equal(harness.driver.children.length, 1);
			assert.equal(
				harness.entries.some(
					(e) => e.type === "pi-continue-watchdog:ai-unlock",
				),
				false,
			);
		});
	}
}

test("F3-B1: reconsideration consumes three invalid files, never a fourth or superseded unlock", async () => {
	const harness = createHarness({
		reviewResult: async () => reviewResult("challenged"),
	});
	await openReconsideration(harness);
	for (let count = 1; count <= 3; count += 1) {
		await harness.settle(harness.answerInvalid());
		assert.equal(harness.controller.snapshot.invalidDecisionAttempts, count);
		assert.equal(harness.controller.snapshot.decisionFailed, count === 3);
	}
	const child = harness.driver.children[0];
	assert.ok(child);
	assert.equal(
		child.prompts.length,
		4,
		"one initial plus three reconsideration responses",
	);
	assert.deepEqual(child.fileStates, ["{}", "{}", "{}", "{}"]);
	assert.match(child.prompts[2] ?? "", /failed validation/i);
	assert.doesNotMatch(child.prompts[2] ?? "", /cw function/);
	assert.equal(harness.driver.children.length, 1);
	assert.equal(harness.reviewCalls.length, 1);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.equal((await harness.driver.current?.result)?.kind, "decision-failed");
	assert.equal(harness.driver.current?.options.isCurrent(), false);
	assert.equal(child.disposed, true);
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(child.prompts.length, 4);
	assert.equal(
		harness.entries.some((e) => e.type === "pi-continue-watchdog:ai-unlock"),
		false,
	);
});

for (const action of ["unlock", "continue"] as const) {
	for (const consumed of [0, 2]) {
		test(`F3-B2: publication-only BUSY preserves valid ${action} after ${consumed} invalid responses once on genuine idle`, async () => {
			let armed = false;
			const harness = createHarness({
				config: ENABLED,
				reviewResult: async () => reviewResult("challenged"),
				hooks: {
					onBranch: (h) => {
						if (
							!armed &&
							h.driver.current?.settled &&
							h.controller.snapshot.decisionOpen
						) {
							armed = true;
							h.pendingMessages = true;
						}
					},
				},
			});
			await openReconsideration(harness);
			for (let count = 0; count < consumed; count += 1) {
				await expectPrivateResponsePending(harness);
				await harness.settle(harness.answerInvalid());
			}
			await expectPrivateResponsePending(harness);
			await harness.settle(
				harness.answer(
					"Already validated replacement.",
					action === "unlock" ? "JOB_DONE" : "WORK_REMAINS",
					action,
				),
			);
			await flush(harness);
			assert.equal(armed, true);
			const terminal = await harness.driver.current?.result;
			assert.equal(
				terminal?.kind,
				"decision",
				"BUSY occurred after private result settled",
			);
			assert.equal(harness.driver.children.length, 1);
			const inquiriesBefore = harness.driver.children.flatMap(
				(child) => child.prompts,
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
				harness.driver.children.flatMap((child) => child.prompts).length,
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
		let busy = false;
		const harness = createHarness({
			reviewResult: async () => reviewResult("challenged"),
			hooks: {
				onBranch: (h) => {
					if (
						armed &&
						h.driver.current?.settled &&
						h.controller.snapshot.decisionOpen
					) {
						busy = true;
						h.pendingMessages = true;
					}
				},
			},
		});
		await openReconsideration(harness);
		await expectPrivateResponsePending(harness);
		armed = true;
		await harness.settle(
			harness.answer("Original pending work.", "WORK_REMAINS", "continue"),
		);
		assert.equal(busy, true, "accepted result crossed BUSY boundary");
		assert.equal((await harness.driver.current?.result)?.kind, "decision");
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
			onRender: (h) => {
				if (!fired && h.controller.snapshot.attempt === 1) {
					fired = true;
					h.pendingMessages = true;
				}
			},
		},
	});
	await openReconsideration(harness);
	await expectPrivateResponsePending(harness);
	const original = harness.entries.find(
		(entry) => entry.type === "pi-continue-watchdog:private-decision",
	);
	assert.ok(original);
	await harness.settle(
		harness.answer(
			"Preserve accepted continuation.",
			"WORK_REMAINS",
			"continue",
		),
	);
	assert.equal(
		fired,
		true,
		"BUSY introduced only after valid private result commit",
	);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(
		harness.driver.children.flatMap((child) => child.prompts).length,
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
		(original.data as { exchangeId: string }).exchangeId,
	);
	assert.equal(harness.controller.snapshot.attempt, 1);
	const sent = harness.sent.length;
	await harness.fire("agent_settled", { type: "agent_settled" });
	await harness.fire("agent_settled", { type: "agent_settled" });
	assert.equal(harness.sent.length, sent);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(harness.reviewCalls.length, 1);
	assert.equal(
		harness.driver.children.flatMap((child) => child.prompts).length,
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
			onRender: (h) => {
				if (!uiBusy && h.controller.snapshot.attempt === 1) {
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
	await expectPrivateResponsePending(harness);
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
		harness.driver.children.flatMap((child) => child.prompts).length,
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
	await expectPrivateResponsePending(harness);
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
		harness.driver.children.flatMap((child) => child.prompts).length,
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
				onRender: (h) => {
					if (!fired && h.controller.snapshot.attempt === 1) {
						fired = true;
						h.pendingMessages = true;
					}
				},
			},
		});
		await openReconsideration(harness);
		await expectPrivateResponsePending(harness);
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
		harness.driver.children.flatMap((child) => child.prompts).length,
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
		harness.driver.children.flatMap((child) => child.prompts).length,
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
		harness.driver.children.flatMap((child) => child.prompts).length,
		1,
	);
});

for (const kind of [
	"null",
	"missing-answer",
	"dropped-answer",
	"wrong-type",
	"overflow",
] as const) {
	test(`F7 runtime: ${kind} falls back to current original unlock once`, async () => {
		const payload =
			kind === "null"
				? null
				: kind === "missing-answer"
					? { ...reviewResult("challenged"), answers: {} }
					: kind === "dropped-answer"
						? {
								...reviewResult("challenged"),
								answers: {},
								dropped: [UNLOCK_REVIEW_QUESTION_ID],
							}
						: kind === "wrong-type"
							? {
									...reviewResult("challenged"),
									answers: {
										[UNLOCK_REVIEW_QUESTION_ID]: {
											type: "bool",
											probability: 1,
										},
									},
								}
							: reviewResult("supported", {
									stopReason: "error",
									answers: {},
									contextOverflow: true,
								});
		const harness = createHarness({
			reviewResult: async () => payload as JudgeResult,
		});
		await harness.openDecision();
		await harness.settle(harness.answer("Original still-current unlock."));
		await flush(harness);
		await harness.fire("agent_settled", { type: "agent_settled" });
		assert.equal(harness.controller.snapshot.locked, false);
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(harness.reviewCalls.length, 1);
		assert.equal(
			harness.driver.children.flatMap((child) => child.prompts).length,
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
			reviewResult: async () => null as unknown as JudgeResult,
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
			harness.driver.children.flatMap((child) => child.prompts).length,
			1,
		);
	});
}

test("review association record carries service identity and scoped usage", async () => {
	const harness = createHarness({
		config: ENABLED,
		reviewResult: async () =>
			reviewResult("supported", {
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: {
						input: 0.01,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0.01,
					},
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
	assert.equal(data?.childSessionId, harness.driver.children[0]?.sessionId);
	const association = harness.entries.find(
		(entry) => entry.type === "pi-continue-watchdog:private-decision",
	);
	assert.ok(association);
	assert.equal(
		data?.exchangeId,
		(association.data as { exchangeId: string }).exchangeId,
	);
	assert.equal(data?.model, "typesafe/jev-1.13");
	assert.deepEqual(data?.usage, {
		input: 100,
		output: 50,
		totalTokens: 150,
		costTotal: 0.01,
	});
	assert.equal(Object.hasOwn(data, "attemptCount"), false);
	assert.equal(Object.hasOwn(data, "observationCoverage"), false);
});

test("review freezes parent macro evidence before private correction/reconsideration traffic", async () => {
	const harness = createHarness({
		reviewResult: async () => reviewResult("challenged"),
	});
	const texts = [
		"ORIGINAL_SCOPE",
		"PUBLIC_DELIVERY_REPORT",
		"LATER_PERMISSION_LIMIT",
	];
	const messages = texts.map((text, index) => ({
		role: index === 1 ? "assistant" : "user",
		content: [{ type: "text", text }],
		timestamp: index,
	}));
	for (const [index, message] of messages.entries()) {
		harness.branch.push({ id: `macro-${index}`, type: "message", message });
	}
	await harness.openDecision();
	// Projection must not alias mutable host entry objects after capture.
	messages[0].content[0].text = "MUTATED_AFTER_CAPTURE";
	await harness.settle({
		write: JSON.stringify({
			action: "unlock",
			reason_type: "UNKNOWN",
			reason_content: "PRIVATE_INVALID_BODY",
		}),
	});
	assert.equal(harness.reviewCalls.length, 0);
	assert.equal(harness.controller.snapshot.invalidDecisionAttempts, 1);
	await harness.settle(harness.answer("CANDIDATE_CLAIM_ONLY"));
	const request = harness.reviewCalls[0];
	assert.ok(request);
	const macro = request.state.macroSnapshot as {
		rows: Array<{ text: string }>;
	};
	assert.deepEqual(
		macro.rows.map((row) => row.text),
		texts,
	);
	const json = JSON.stringify(request);
	for (const privateValue of [
		"MUTATED_AFTER_CAPTURE",
		"PRIVATE_INVALID_BODY",
		"watchdog_result_file",
		harness.driver.forkInputs[0]?.resultFile ?? "missing-result-file",
	])
		assert.equal(json.includes(privateValue), false, privateValue);
	assert.equal(
		macro.rows.some((row) => row.text.includes("CANDIDATE_CLAIM_ONLY")),
		false,
	);
	assert.ok(json.includes("CANDIDATE_CLAIM_ONLY"));
	assert.match(
		latestPrivatePrompt(harness).content,
		/opinion, not new evidence/,
	);
	await harness.settle(
		harness.answer("Actual work remains.", "WORK_REMAINS", "continue"),
	);
	assert.equal(harness.reviewCalls.length, 1);
	assert.equal(harness.driver.children.length, 1);
	assert.equal(harness.driver.children[0]?.prompts.length, 3);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(harness.triggeredTurns, 1);
	assert.equal(
		harness.sent.some(
			(row) => row.message.customType === DECISION_MESSAGE_TYPE,
		),
		false,
	);
});

for (const action of ["continue", "callback"] as const) {
	test(`reviewed replacement ${action} spends last shared budget unit exactly once`, async () => {
		const harness = createHarness({
			config: { ...CALLBACK_ENABLED, maxContinue: 1 },
			reviewResult: async () => reviewResult("challenged"),
		});
		await openReconsideration(harness);
		assert.equal(harness.controller.snapshot.attempt, 0);
		assert.equal(harness.controller.snapshot.callbackSuspended, false);
		await harness.settle(
			harness.answer(
				"Final accepted work boundary.",
				action === "callback" ? "WAIT_CALLBACK" : "WORK_REMAINS",
				action === "callback" ? "unlock" : "continue",
			),
		);
		assert.equal(harness.controller.snapshot.attempt, 1);
		assert.equal(harness.controller.snapshot.exhausted, true);
		assert.equal(harness.controller.snapshot.locked, true);
		assert.equal(
			harness.controller.snapshot.callbackSuspended,
			action === "callback",
		);
		assert.equal(harness.triggeredTurns, action === "continue" ? 1 : 0);
		assert.equal(harness.reviewCalls.length, 1);
		assert.equal(harness.driver.children.length, 1);
		const publications = harness.sent.length;
		await harness.fire("agent_settled", { type: "agent_settled" });
		await harness.fire("agent_settled", { type: "agent_settled" });
		assert.equal(harness.controller.snapshot.attempt, 1);
		assert.equal(harness.sent.length, publications);
	});
}

test("manual unlock still aborts ordinary main continuation after private review completes", async () => {
	const harness = createHarness({
		reviewResult: async () => reviewResult("challenged"),
	});
	await openReconsideration(harness);
	await harness.settle(
		harness.answer("Continue ordinary work.", "WORK_REMAINS", "continue"),
	);
	assert.equal(harness.triggeredTurns, 1);
	const child = harness.driver.children[0];
	assert.ok(child);
	assert.equal(child.disposed, true);
	// This parent start represents published ordinary continuation, not child work.
	const continuation = harness.sent.find(
		(row) =>
			(row.message.details as { watchdogOutcome?: string }).watchdogOutcome ===
			"continue",
	);
	assert.ok(continuation);
	harness.streaming = true;
	await harness.fire("agent_start", { type: "agent_start" });
	await harness.fire("message_start", {
		type: "message_start",
		message: {
			role: "custom",
			customType: continuation.message.customType,
			content: [{ type: "text", text: continuation.message.content }],
			details: continuation.message.details,
			timestamp: 1,
		},
	});
	await harness.unlock();
	assert.equal(harness.parentAborts, 1);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.reviewCalls.length, 1);
});

test("non-owned source append during review cancels private file authority", async () => {
	const harness = createHarness({ reviewDelay: true });
	await harness.openDecision();
	await harness.settle(harness.answer("Stale original unlock."));
	assert.equal(harness.reviewCalls.length, 1);
	harness.branch.push({
		id: "new-public-source",
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text: "Changed scope." }],
			timestamp: 1,
		},
	});
	harness.flushReviews();
	const result = await settlePrivateDecision(harness.driver);
	assert.equal(result?.kind, "cancelled");
	assert.equal(harness.driver.children[0]?.aborted, true);
	assert.equal(harness.driver.children[0]?.disposed, true);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(
		harness.entries.some(
			(entry) => entry.type === "pi-continue-watchdog:ai-unlock",
		),
		false,
	);
	assert.equal(harness.parentAborts, 0);
});

test("optional private/review history failures never add responses, gate unlock or charge budget", async () => {
	for (const failedType of [
		"pi-continue-watchdog:private-decision",
		"pi-continue-watchdog:private-response",
		UNLOCK_REVIEW_ENTRY_TYPE,
	]) {
		const harness = createHarness({
			hooks: {
				onAppend(type) {
					if (type === failedType)
						throw new Error("optional history unavailable");
				},
			},
		});
		await harness.openDecision();
		await harness.settle(harness.answer());
		assert.equal(harness.reviewCalls.length, 1, failedType);
		assert.equal(harness.driver.children.length, 1, failedType);
		assert.equal(harness.driver.children[0]?.prompts.length, 1, failedType);
		assert.equal(harness.controller.snapshot.locked, false, failedType);
		assert.equal(harness.controller.snapshot.attempt, 0, failedType);
		assert.equal(
			harness.entries.filter(
				(row) => row.type === "pi-continue-watchdog:ai-unlock",
			).length,
			1,
			failedType,
		);
		assert.ok(
			harness.notifications.some((row) =>
				/history incomplete/i.test(row.message),
			),
			failedType,
		);
	}
});
