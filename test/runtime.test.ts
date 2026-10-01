import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { ContinueWatchdogConfig } from "../src/config.js";
import { CONTINUATION_MESSAGE_TYPE } from "../src/context-fold.js";
import { createLockDecisionController } from "../src/controller.js";
import {
	createHubAttachmentInstance,
	createObservableAgentHub,
} from "../src/hub.js";
import type {
	DomainSnapshot,
	ProcessDomainCoordinator,
} from "../src/process-domain.js";
import {
	createDecisionRuntime,
	type DecisionRuntimeOptions,
	type RuntimeClock,
	type RuntimeTimerHandle,
} from "../src/runtime.js";
import {
	UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	type UnlockToolDetails,
	validateUnlockToolArguments,
} from "../src/unlock-tool.js";

interface SentMessage {
	readonly message: {
		readonly customType?: string;
		readonly content?: unknown;
		readonly details?: unknown;
	};
	readonly options?: { readonly triggerTurn?: boolean };
}

class FakeClock implements RuntimeClock {
	private nextId = 1;
	private timers = new Map<number, { at: number; run: () => void }>();
	nowMs = 1_000_000;

	now(): number {
		return this.nowMs;
	}

	setTimeout(callback: () => void, delayMs: number): RuntimeTimerHandle {
		const id = this.nextId++;
		this.timers.set(id, { at: this.nowMs + delayMs, run: callback });
		return { unref: () => {} };
	}

	clearTimeout(_handle: RuntimeTimerHandle): void {
		this.timers.delete(
			[...this.timers.entries()].find(([, timer]) => timer)?.[0] ?? -1,
		);
	}

	advance(ms: number): void {
		this.nowMs += ms;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= this.nowMs)
				.sort((left, right) => left[1].at - right[1].at)[0];
			if (due === undefined) return;
			this.timers.delete(due[0]);
			due[1].run();
		}
	}

	runAll(): void {
		for (let guard = 0; guard < 1000; guard += 1) {
			const earliest = [...this.timers.values()].sort(
				(left, right) => left.at - right.at,
			)[0];
			if (earliest === undefined) return;
			this.nowMs = Math.max(this.nowMs, earliest.at);
			earliest.run();
			// Clearing happens through clearTimeout by the coordinator; drop
			// fired timers conservatively by re-deriving below.
		}
	}
}

type Handler = (...args: unknown[]) => unknown;

interface RegisteredTool {
	readonly name: string;
	readonly definition: ToolDefinition<TSchema, UnlockToolDetails>;
}

interface Harness {
	readonly clock: FakeClock;
	readonly config: ContinueWatchdogConfig;
	readonly hub: ReturnType<typeof createObservableAgentHub>;
	readonly sent: SentMessage[];
	readonly notifications: Array<{ message: string; level?: string }>;
	readonly entries: Array<{ type: string; data: unknown }>;
	readonly hooks: Array<{ name: string; values?: unknown }>;
	readonly registeredTools: RegisteredTool[];
	readonly controller: ReturnType<typeof createLockDecisionController>;
	aborts: number;
	pendingMessages: boolean;
	branch: unknown[];
	ctx: ExtensionContext;
	runtime: ReturnType<typeof createDecisionRuntime>;
	/** `idle: false` makes ctx.isIdle() report busy during this event only. */
	fire(
		name: string,
		event: unknown,
		options?: { readonly idle?: boolean },
	): Promise<void>;
	setIdle(idle: boolean): Promise<void>;
	settle(): Promise<void>;
	advanceFence(ms: number): Promise<void>;
	eligibleIdle(): Promise<void>;
	/** Simulate Pi persisting/starting the latest sent continuation message. */
	startContinuation(): Promise<void>;
	registeredUnlockTool(): RegisteredTool | undefined;
	invokeUnlockTool(args: unknown): Promise<{
		readonly content: Array<{ type: string; text?: string }>;
		readonly terminate?: boolean;
		readonly details?: unknown;
	}>;
	unlock(): Promise<void>;
}

function fakeContext(overrides?: {
	pendingMessages?: () => boolean;
	branch?: () => unknown[];
}): ExtensionContext {
	return {
		cwd: "/project",
		mode: "tui",
		hasUI: false,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => (overrides?.branch?.() ?? []) as never,
			getLeafId: () => null,
		},
		isProjectTrusted: () => true,
		abort: () => {},
		ui: {
			notify: () => {},
			setWidget: () => {},
		},
		isIdle: () => true,
		pendingMessages: overrides?.pendingMessages ?? (() => false),
	} as unknown as ExtensionContext;
}

function createHarness(options?: {
	readonly config?: Partial<ContinueWatchdogConfig>;
	readonly maxRetries?: number;
	readonly fenceMs?: number;
	readonly isRootProcess?: boolean;
	readonly onSend?: (message: SentMessage["message"]) => undefined | Error;
	readonly jevWait?: DecisionRuntimeOptions["jevWait"];
}): Harness {
	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: 10,
		maxRetries: options?.maxRetries ?? 3,
		continuePrompt: "Continue compactly.",
		reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"],
		unlockShortcut: "alt+u",
		...options?.config,
	};
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController(config);
	const holder = { controller };
	const handlers = new Map<string, Handler[]>();
	const clock = new FakeClock();
	const sent: SentMessage[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const hooks: Array<{ name: string; values?: unknown }> = [];
	const registeredTools: RegisteredTool[] = [];
	let aborts = 0;

	const harness = {
		clock,
		config,
		hub,
		sent,
		notifications,
		entries,
		hooks,
		registeredTools,
		controller,
		pendingMessages: false,
		branch: [] as unknown[],
		get aborts() {
			return aborts;
		},
		set aborts(value: number) {
			aborts = value;
		},
	} as Harness;

	let ctx: ExtensionContext = fakeContext();

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
			const injected = options?.onSend?.(message);
			if (injected instanceof Error) throw injected;
			sent.push({ message, options: sendOptions });
		},
		appendEntry(type: string, data: unknown): void {
			entries.push({ type, data });
		},
		registerTool(definition: ToolDefinition<TSchema, UnlockToolDetails>) {
			registeredTools.push({ name: definition.name, definition });
		},
		sendUserMessage: async () => {},
		events: {
			emit(channel: string, data: unknown): void {
				if (channel === "pi:semantic-hook:v1") {
					const envelope = data as { name: string; values?: unknown };
					hooks.push({ name: envelope.name, values: envelope.values });
				}
			},
		},
	};

	const processDomain: ProcessDomainCoordinator = {
		get snapshot(): DomainSnapshot {
			return {
				domainId: "domain",
				domainEpoch: "epoch",
				activityGeneration: 1n,
				busyParticipants: 0,
				allIdle: true,
				fence: { domainEpoch: "epoch", activityGeneration: 1n },
			};
		},
		isRootProcess: options?.isRootProcess ?? true,
		attach: async () => {},
		reportIdle: async () => {},
		confirm: async () => true,
		subscribe: () => () => {},
		detach: async () => {},
	};

	const runtime = createDecisionRuntime({
		pi: pi as never,
		hub,
		processDomain,
		attachmentInstance: createHubAttachmentInstance(),
		controllerHolder: holder,
		injectedController: true,
		initialConfig: config,
		clock,
		// Never reach a real endpoint: no ambient keys unless a test injects them.
		jevWait: options?.jevWait ?? {
			env: {},
			fetchFn: async () => {
				throw new Error("unexpected jev request");
			},
		},
	});
	runtime.registerLifecycle();
	harness.runtime = runtime;
	harness.ctx = ctx;

	harness.fire = async (name, event, fireOptions) => {
		ctx = fakeContext({
			pendingMessages: () => harness.pendingMessages,
			branch: () => harness.branch,
		});
		if (fireOptions?.idle === false) {
			(ctx as unknown as { isIdle(): boolean }).isIdle = () => false;
		}
		harness.ctx = ctx;
		const list = handlers.get(name) ?? [];
		for (const handler of list) {
			await handler(event, ctx);
		}
		if (name === "message_start") {
			// extension.ts routes message_start through the runtime correlator.
			await runtime.handleMessageStart(
				event as { readonly message: unknown },
				ctx,
			);
		}
	};
	harness.setIdle = async (idle) => {
		// Simulate the public isIdle probe by swapping the context's isIdle.
		ctx = fakeContext({
			pendingMessages: () => harness.pendingMessages,
			branch: () => harness.branch,
		});
		(ctx as unknown as { isIdle(): boolean }).isIdle = () => idle;
		harness.ctx = ctx;
	};
	harness.settle = async () => {
		await harness.fire("agent_settled", {});
	};
	harness.advanceFence = async (ms) => {
		clock.advance(ms);
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
	};
	harness.eligibleIdle = async () => {
		await harness.fire("session_start", {});
		await harness.fire("agent_start", {});
		await harness.setIdle(true);
		await harness.settle();
		await harness.advanceFence(10_000);
	};
	harness.startContinuation = async () => {
		const latest = [...sent]
			.reverse()
			.find((entry) => entry.message.customType === CONTINUATION_MESSAGE_TYPE);
		assert.ok(latest, "no continuation was sent");
		await harness.fire("message_start", {
			message: {
				role: "custom",
				customType: CONTINUATION_MESSAGE_TYPE,
				details: latest.message.details,
			},
		});
	};
	harness.registeredUnlockTool = () =>
		registeredTools.find(
			(tool) => tool.name === UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
		);
	harness.invokeUnlockTool = async (args) => {
		const tool = harness.registeredUnlockTool();
		assert.ok(tool, "unlock tool not registered");
		const result = await tool.definition.execute(
			"call-1",
			args as never,
			undefined,
			undefined,
			harness.ctx as never,
		);
		return result as never;
	};
	harness.unlock = async () => {
		const claim = runtime.getMainClaim();
		assert.ok(claim, "expected a main claim");
		await runtime.handleManualUnlock(harness.ctx, claim);
	};
	return harness;
}

test("idle continuation: direct message, no inquiry", async () => {
	const harness = createHarness();
	await harness.eligibleIdle();
	const continuations = harness.sent.filter(
		(sent) => sent.message.customType === CONTINUATION_MESSAGE_TYPE,
	);
	assert.equal(continuations.length, 1);
	assert.equal(continuations[0].options?.triggerTurn, true);
	const body = String(continuations[0].message.content);
	assert.match(body, /Continue watchdog continued · /);
	assert.match(
		body,
		/You ended your turn without calling unlock_continue_watchdog/,
	);
	assert.match(body, /Continue compactly\./);
	assert.match(
		body,
		/monitor that task until it ends, or sleep for your estimated duration/,
	);
	assert.match(
		body,
		/call back and wake you, call unlock_continue_watchdog with reason_type WAIT_CALLBACK/,
	);
	assert.match(
		body,
		/check every task the user requested in this session, including earlier requests and not only the latest one/,
	);
	assert.match(body, /work is blocked without a user action/);
	assert.equal(harness.controller.snapshot.attempt, 1);
	assert.equal(harness.controller.snapshot.locked, true);
	// No inquiry prompt was ever sent.
	assert.equal(
		harness.sent.some((sent) =>
			String(sent.message.customType ?? "").endsWith(":inquiry"),
		),
		false,
	);
	// Pi's send is asynchronous: no hook until the message actually starts.
	assert.equal(
		harness.hooks.filter((hook) => hook.name === "watchdog-continued").length,
		0,
	);
	await harness.startContinuation();
	// watchdog-continued hook with empty values, exactly once.
	await harness.startContinuation();
	assert.deepEqual(
		harness.hooks.filter((hook) => hook.name === "watchdog-continued"),
		[{ name: "watchdog-continued", values: undefined }],
	);
});

test("no continuation after the agent unlocked through the tool", async () => {
	const harness = createHarness();
	await harness.fire("session_start", {});
	await harness.fire("agent_start", {});
	const result = await harness.invokeUnlockTool({
		reason_type: "job_done",
		reason: "All requested work is complete.",
	});
	assert.match(
		result.content.map((block) => block.text ?? "").join(""),
		/Continue watchdog unlocked · JOB_DONE/,
	);
	assert.equal(result.terminate, true);
	assert.equal(harness.controller.snapshot.locked, false);
	await harness.setIdle(true);
	await harness.settle();
	await harness.advanceFence(30_000);
	assert.equal(
		harness.sent.some(
			(sent) => sent.message.customType === CONTINUATION_MESSAGE_TYPE,
		),
		false,
	);
});

test("unlock tool publish at aggregate idle with reason fields", async () => {
	const harness = createHarness();
	await harness.fire("session_start", {});
	await harness.fire("agent_start", {});
	await harness.invokeUnlockTool({
		reason_type: "WAIT_USER",
		reason: "Need deploy approval.",
	});
	await harness.setIdle(true);
	await harness.settle();
	const ready = harness.hooks.find((hook) => hook.name === "user-ready");
	assert.ok(ready, "expected user-ready hook");
	assert.deepEqual(ready.values, {
		STOP_KIND: "AI_UNLOCK",
		REASON_TYPE: "WAIT_USER",
		REASON: "Need deploy approval.",
	});
});

test("unlock tool invalid arguments throw named errors and keep the lock", async () => {
	const harness = createHarness();
	await harness.fire("session_start", {});
	await harness.fire("agent_start", {});
	await assert.rejects(
		harness.invokeUnlockTool({ reason_type: "NOPE", reason: "x" }),
		/reason_type/,
	);
	await assert.rejects(
		harness.invokeUnlockTool({ reason_type: "JOB_DONE", reason: "   " }),
		/reason/,
	);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.hooks.length, 0);
});

test("unlock tool while unlocked returns informational result", async () => {
	const harness = createHarness();
	await harness.fire("session_start", {});
	await harness.fire("agent_start", {});
	await harness.invokeUnlockTool({
		reason_type: "JOB_DONE",
		reason: "Done.",
	});
	const second = await harness.invokeUnlockTool({
		reason_type: "JOB_DONE",
		reason: "Done again.",
	});
	assert.match(
		second.content.map((block) => block.text ?? "").join(""),
		/not locked|no unlock was needed/,
	);
	assert.equal(second.terminate, undefined);
});

test("exhaustion after maxRetries continuations", async () => {
	const harness = createHarness({ maxRetries: 2 });
	await harness.eligibleIdle();
	// First continuation consumed attempt 1; its run starts, then settles
	// without unlocking.
	await harness.startContinuation();
	await harness.setIdle(true);
	await harness.settle();
	await harness.advanceFence(10_000);
	await harness.startContinuation();
	assert.equal(harness.controller.snapshot.attempt, 2);
	assert.equal(harness.controller.snapshot.exhausted, true);
	const continuationCount = harness.sent.filter(
		(sent) => sent.message.customType === CONTINUATION_MESSAGE_TYPE,
	).length;
	assert.equal(continuationCount, 2);
	// Settle again: no third continuation, EXHAUSTED terminal.
	await harness.setIdle(true);
	await harness.settle();
	assert.equal(
		harness.sent.filter(
			(sent) => sent.message.customType === CONTINUATION_MESSAGE_TYPE,
		).length,
		2,
	);
	const exhausted = harness.hooks.find(
		(hook) =>
			hook.name === "user-ready" &&
			(hook.values as { STOP_KIND?: string } | undefined)?.STOP_KIND ===
				"EXHAUSTED",
	);
	assert.ok(exhausted, "expected EXHAUSTED user-ready");
	assert.equal(
		harness.sent.some(
			(sent) =>
				(sent.message.details as { kind?: string } | undefined)?.kind ===
				"exhausted",
		),
		true,
	);
});

test("continuation send failure rolls the attempt back", async () => {
	const harness = createHarness({
		onSend: (message) =>
			message.customType === CONTINUATION_MESSAGE_TYPE
				? new Error("send failed")
				: undefined,
	});
	await harness.eligibleIdle();
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.exhausted, false);
	assert.equal(
		harness.hooks.filter((h) => h.name === "watchdog-continued").length,
		0,
	);
});

test("asynchronous send failure: unstarted continuation is rolled back without a hook", async () => {
	const harness = createHarness({ maxRetries: 2 });
	await harness.eligibleIdle();
	assert.equal(harness.controller.snapshot.attempt, 1);
	// Pi's fire-and-forget send failed: the run settles without the
	// continuation ever reaching message_start.
	await harness.setIdle(true);
	await harness.settle();
	// Settlement rolled the unstarted attempt back (it may immediately be
	// re-consumed by a new qualified continuation after the next fence).
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.exhausted, false);
	assert.equal(
		harness.hooks.filter((h) => h.name === "watchdog-continued").length,
		0,
	);
});

test("ownership demoted during send rolls the attempt back without a hook", async () => {
	let demote: (() => void) | null = null;
	const harness = createHarness({
		onSend: (message) => {
			if (message.customType === CONTINUATION_MESSAGE_TYPE) demote?.();
			return undefined;
		},
	});
	await harness.fire("session_start", {});
	demote = () => {
		const other = harness.hub.bind({
			instance: createHubAttachmentInstance(),
			sessionId: "other-session",
			hasUI: true,
			initialBusy: false,
		});
		harness.hub.reclaimMain(other.attachment);
	};
	await harness.fire("agent_start", {});
	await harness.setIdle(true);
	await harness.settle();
	await harness.advanceFence(10_000);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(
		harness.hooks.filter((h) => h.name === "watchdog-continued").length,
		0,
	);
});

test("unlock tool registers only once and the tool list stays stable", async () => {
	const harness = createHarness();
	await harness.fire("session_start", {});
	await harness.fire("agent_start", {});
	await harness.invokeUnlockTool({
		reason_type: "JOB_DONE",
		reason: "Done.",
	});
	// Re-acquire control / new runs never register a second tool.
	await harness.fire("agent_start", {});
	await harness.eligibleIdle();
	assert.equal(
		harness.registeredTools.filter(
			(tool) => tool.name === UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
		).length,
		1,
	);
});

test("child process does not register the tool", async () => {
	const harness = createHarness({ isRootProcess: false });
	await harness.fire("session_start", {});
	await harness.fire("agent_start", {});
	assert.equal(harness.registeredUnlockTool(), undefined);
});

test("manual unlock cancels a watchdog-owned continuation run", async () => {
	const harness = createHarness({ onSend: () => undefined });
	await harness.eligibleIdle();
	const continuation = harness.sent.find(
		(sent) => sent.message.customType === CONTINUATION_MESSAGE_TYPE,
	);
	assert.ok(continuation, "expected a continuation message");
	// The continuation custom message starts its Pi run: correlated message_start.
	await harness.fire("message_start", {
		message: {
			role: "custom",
			customType: CONTINUATION_MESSAGE_TYPE,
			details: continuation.message.details,
		},
	});
	const status = harness.runtime.getTriggerStatus();
	assert.equal(status.blocker, "continuation-in-flight");
	const before = harness.controller.snapshot.locked;
	assert.equal(before, true);
	let aborted = 0;
	(harness.ctx as unknown as { abort(): void }).abort = () => {
		aborted += 1;
	};
	await harness.unlock();
	// handleManualUnlock cancels the watchdog-owned run (abort + cleared
	// pending work); the controller unlock itself is owned by the command.
	assert.equal(aborted, 1);
	assert.equal(
		harness.runtime.getTriggerStatus().blocker,
		"continuation-in-flight",
	);
});

test("fresh cycle restart clears exhaustion and accounting", async () => {
	const harness = createHarness({ maxRetries: 1 });
	await harness.eligibleIdle();
	assert.equal(harness.controller.snapshot.exhausted, true);
	// A fresh cycle runs the full unlock-cleanup -> lock sequence (the same
	// sequence an actual main user message starts through extension wiring).
	harness.runtime.restartLockCycle(undefined, { notifyLocked: false });
	assert.equal(harness.controller.snapshot.locked, true);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.exhausted, false);
});

test("status blocker reflects continuation-in-flight", async () => {
	const harness = createHarness();
	await harness.fire("session_start", {});
	await harness.fire("agent_start", {});
	const idleStatus = harness.runtime.getTriggerStatus();
	assert.equal(idleStatus.blocker, null);
});

test("validateUnlockToolArguments case-insensitive type normalization", () => {
	const result = validateUnlockToolArguments(
		{ reason_type: "job_done", reason: "Complete." },
		["JOB_DONE", "WAIT_USER"],
	);
	assert.ok(!("error" in result));
	assert.equal(result.reasonType, "JOB_DONE");
	const custom = validateUnlockToolArguments(
		{ reason_type: "needreview", reason: "Review." },
		["NeedReview"],
	);
	assert.ok(!("error" in custom));
	assert.equal(custom.reasonType, "NEEDREVIEW");
});

test("reason over 1000 code points is rejected", () => {
	const long = "a".repeat(1001);
	const result = validateUnlockToolArguments(
		{ reason_type: "JOB_DONE", reason: long },
		["JOB_DONE"],
	);
	assert.ok("error" in result);
});

function assistantEntry(id: string, text: string, stopReason = "stop") {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			stopReason,
			content: [{ type: "text", text }],
		},
	};
}

function jevResponse(choice: string, confidence: number): Response {
	return new Response(
		JSON.stringify({ answers: { waiting_user: { choice, confidence } } }),
	);
}

async function flush(): Promise<void> {
	for (let index = 0; index < 10; index += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function jevHarness(
	respond: () => Promise<Response> | Response,
	onSend?: (message: SentMessage["message"]) => undefined | Error,
) {
	const calls: Array<{ url: string; body: string; signal?: AbortSignal }> = [];
	const harness = createHarness({
		jevWait: {
			env: { TYPESAFE_API_KEY: "ts-key" },
			fetchFn: async (url, init) => {
				calls.push({
					url,
					body: String(init.body),
					signal: init.signal ?? undefined,
				});
				return respond();
			},
		},
		onSend,
	});
	return { harness, calls };
}

const continuationCount = (harness: Harness): number =>
	harness.sent.filter(
		(sent) => sent.message.customType === CONTINUATION_MESSAGE_TYPE,
	).length;

test("jev gate: no key means zero requests and an unchanged continuation", async () => {
	let fetches = 0;
	const harness = createHarness({
		jevWait: {
			env: {},
			fetchFn: async () => {
				fetches += 1;
				return jevResponse("waiting_user", 1);
			},
		},
	});
	harness.branch = [assistantEntry("a1", "Which one?")];
	await harness.eligibleIdle();
	await flush();
	assert.equal(fetches, 0);
	assert.equal(continuationCount(harness), 1);
	assert.equal(harness.controller.snapshot.attempt, 1);
});

test("jev gate: a text-less final message makes no request", async () => {
	const { harness, calls } = jevHarness(() => jevResponse("waiting_user", 1));
	harness.branch = [
		assistantEntry("a1", "   "),
		// A tool-only final turn has no text blocks.
		{
			type: "message",
			id: "a2",
			message: { role: "assistant", stopReason: "toolUse", content: [] },
		},
	];
	await harness.eligibleIdle();
	await flush();
	assert.equal(calls.length, 0);
	assert.equal(continuationCount(harness), 1);
});

test("jev gate: confident waiting verdict unlocks as WAIT_USER without an attempt", async () => {
	const { harness, calls } = jevHarness(() =>
		jevResponse("waiting_user", 0.93),
	);
	harness.branch = [
		assistantEntry("a1", "Done with A.\n\nShould I use Postgres or SQLite?"),
	];
	await harness.eligibleIdle();
	await flush();
	assert.equal(calls.length, 1);
	assert.match(calls[0].body, /Should I use Postgres or SQLite\?/);
	assert.equal(calls[0].body.includes("ts-key"), false);
	assert.equal(continuationCount(harness), 0);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.attempt, 0);
	const ready = harness.hooks.filter((hook) => hook.name === "user-ready");
	assert.deepEqual(ready, [
		{
			name: "user-ready",
			values: {
				STOP_KIND: "AI_UNLOCK",
				REASON_TYPE: "WAIT_USER",
				REASON:
					"jev model judged the final output to be a question for the user: Should I use Postgres or SQLite?",
			},
		},
	]);
	// No further continuation once unlocked.
	await harness.advanceFence(30_000);
	assert.equal(continuationCount(harness), 0);
});

test("jev gate: low confidence, not-waiting, and failures continue", async () => {
	for (const respond of [
		() => jevResponse("waiting_user", 0.5),
		() => jevResponse("not_waiting", 0.99),
		() => jevResponse("unclear", 0.99),
		() => new Response("boom", { status: 500 }),
	]) {
		const { harness, calls } = jevHarness(respond);
		harness.branch = [assistantEntry("a1", "Which one?")];
		await harness.eligibleIdle();
		await flush();
		assert.equal(calls.length, 1);
		assert.equal(continuationCount(harness), 1);
		assert.equal(harness.controller.snapshot.attempt, 1);
		assert.equal(
			harness.hooks.some((hook) => hook.name === "user-ready"),
			false,
		);
	}
});

test("jev gate: a verdict made stale by new activity is dropped; the entry is classified once", async () => {
	let release: (response: Response) => void = () => {};
	const { harness, calls } = jevHarness(
		() =>
			new Promise<Response>((resolve) => {
				release = resolve;
			}),
	);
	harness.branch = [assistantEntry("a1", "Which one?")];
	await harness.eligibleIdle();
	await flush();
	assert.equal(calls.length, 1);
	// Another extension starts a turn during the request, which then settles.
	await harness.fire("agent_start", {});
	await harness.settle();
	await harness.advanceFence(10_000);
	await flush();
	// Re-qualification reuses the in-flight classification for the same entry.
	assert.equal(calls.length, 1);
	release(jevResponse("not_waiting", 0.99));
	await flush();
	// Only the still-current qualification acts on the verdict.
	assert.equal(continuationCount(harness), 1);
	assert.equal(harness.controller.snapshot.attempt, 1);
});

test("jev gate: manual unlock or a new lock cycle during the request wins", async () => {
	for (const interrupt of ["unlock", "restart"] as const) {
		let release: (response: Response) => void = () => {};
		const { harness } = jevHarness(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);
		harness.branch = [assistantEntry("a1", "Which one?")];
		await harness.eligibleIdle();
		await flush();
		if (interrupt === "unlock") await harness.unlock();
		else harness.runtime.restartLockCycle();
		release(jevResponse("waiting_user", 0.99));
		await flush();
		assert.equal(continuationCount(harness), 0);
		assert.equal(
			harness.hooks.some((hook) => hook.name === "user-ready"),
			false,
		);
		assert.equal(harness.controller.snapshot.attempt, 0);
	}
});

test("jev gate: shutdown aborts the in-flight request without dispatch or unlock", async () => {
	const { harness, calls } = jevHarness(() => new Promise<Response>(() => {}));
	harness.branch = [assistantEntry("a1", "Which one?")];
	await harness.eligibleIdle();
	await flush();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].signal?.aborted, false);
	await harness.runtime.shutdown();
	assert.equal(calls[0].signal?.aborted, true);
	await flush();
	assert.equal(continuationCount(harness), 0);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(
		harness.hooks.some((hook) => hook.name === "user-ready"),
		false,
	);
});

test("jev gate: tree navigation during the request drops the old verdict and classifies the new entry", async () => {
	const releases: Array<(response: Response) => void> = [];
	const { harness, calls } = jevHarness(
		() =>
			new Promise<Response>((resolve) => {
				releases.push(resolve);
			}),
	);
	harness.branch = [assistantEntry("a1", "Status: all good.")];
	await harness.eligibleIdle();
	await flush();
	assert.equal(calls.length, 1);
	// Navigate to another branch whose final message asks the user.
	harness.branch = [assistantEntry("b1", "Approve deleting data?")];
	// Real Pi emits session_tree while its branch-summary controller is still
	// set, so ctx.isIdle() reports busy inside the event; no settle follows.
	await harness.fire("session_tree", {}, { idle: false });
	assert.notEqual(
		harness.runtime.getTriggerStatus().blocker,
		"local-agent-busy",
	);
	releases[0](jevResponse("not_waiting", 0.99));
	await flush();
	assert.equal(continuationCount(harness), 0);
	assert.equal(harness.controller.snapshot.attempt, 0);
	// The re-armed fence classifies the new branch's entry.
	await harness.advanceFence(10_000);
	await flush();
	assert.equal(calls.length, 2);
	assert.match(calls[1].body, /Approve deleting data\?/);
	releases[1](jevResponse("waiting_user", 0.95));
	await flush();
	assert.equal(continuationCount(harness), 0);
	assert.equal(harness.controller.snapshot.locked, false);
});

test("jev gate: revisiting an entry reuses its classification (A -> B -> A)", async () => {
	// Failed sends roll back, so every entry can qualify again.
	const { harness, calls } = jevHarness(
		() => jevResponse("not_waiting", 0.99),
		(message) =>
			message.customType === CONTINUATION_MESSAGE_TYPE
				? new Error("send failed")
				: undefined,
	);
	const a = assistantEntry("a1", "Report A.");
	const b = assistantEntry("b1", "Report B.");
	harness.branch = [a];
	await harness.eligibleIdle();
	await flush();
	for (const branch of [[b], [a]]) {
		harness.branch = branch;
		await harness.fire("session_tree", {}, { idle: false });
		await harness.advanceFence(10_000);
		await flush();
	}
	assert.equal(calls.length, 2);
	assert.equal(
		calls.filter((call) => call.body.includes("Report A.")).length,
		1,
	);
});

test("jev gate: a key that appears later still enables the gate for the same entry", async () => {
	const env: Record<string, string | undefined> = {};
	const calls: string[] = [];
	const harness = createHarness({
		jevWait: {
			env,
			fetchFn: async (_url, init) => {
				calls.push(String(init.body));
				return jevResponse("waiting_user", 0.99);
			},
		},
		onSend: (message) =>
			message.customType === CONTINUATION_MESSAGE_TYPE
				? new Error("send failed")
				: undefined,
	});
	harness.branch = [assistantEntry("a1", "Which one?")];
	await harness.eligibleIdle();
	await flush();
	assert.equal(calls.length, 0);
	env.TYPESAFE_API_KEY = "late-key";
	await harness.fire("agent_end", {});
	await harness.advanceFence(10_000);
	await flush();
	assert.equal(calls.length, 1);
	assert.equal(harness.controller.snapshot.locked, false);
});

test("jev gate: invalidation during a delayed credential lookup sends nothing", async () => {
	for (const interrupt of ["unlock", "navigate"] as const) {
		let resolveKey: ((key: string) => void) | null = null;
		let fetches = 0;
		const harness = createHarness({
			jevWait: {
				env: {},
				fetchFn: async () => {
					fetches += 1;
					return jevResponse("waiting_user", 0.99);
				},
			},
		});
		harness.branch = [assistantEntry("a1", "Which one?")];
		await harness.fire("session_start", {});
		// Delayed Pi credential lookup.
		(
			harness.ctx as unknown as {
				modelRegistry: {
					getApiKeyForProvider(provider: string): Promise<string | undefined>;
				};
			}
		).modelRegistry = {
			getApiKeyForProvider: (provider) =>
				provider === "typesafe"
					? new Promise((resolve) => {
							resolveKey = resolve;
						})
					: Promise.resolve(undefined),
		};
		await harness.fire("agent_start", {});
		await harness.setIdle(true);
		await harness.settle();
		await harness.advanceFence(10_000);
		await flush();
		if (interrupt === "unlock") {
			await harness.unlock();
		} else {
			harness.branch = [assistantEntry("b1", "Other question?")];
			await harness.fire("session_tree", {}, { idle: false });
		}
		assert.ok(resolveKey, "credential lookup was not reached");
		(resolveKey as (key: string) => void)("late-key");
		await flush();
		assert.equal(fetches, 0, interrupt);
		assert.equal(continuationCount(harness), 0, interrupt);
	}
});
