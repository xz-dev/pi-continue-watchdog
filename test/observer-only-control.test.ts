import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { LoadedConfig } from "../src/config-loader.js";
import { createContinueWatchdogExtension } from "../src/extension.js";
import { createObservableAgentHub } from "../src/hub.js";
import type { RuntimeClock, RuntimeTimerHandle } from "../src/runtime.js";

interface TimerRecord extends RuntimeTimerHandle {
	readonly callback: () => void;
	readonly delayMs: number;
	cleared: boolean;
}

class FakeClock implements RuntimeClock {
	readonly records: TimerRecord[] = [];

	setTimeout(callback: () => void, delayMs: number): TimerRecord {
		const record = { callback, delayMs, cleared: false };
		this.records.push(record);
		return record;
	}

	clearTimeout(handle: RuntimeTimerHandle): void {
		(handle as TimerRecord).cleared = true;
	}
}

type Handler = (event: never, ctx: ExtensionContext) => unknown;

interface AttachmentHarness {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly clock: FakeClock;
	readonly notifications: Array<{
		readonly message: string;
		readonly level?: string;
	}>;
	readonly registeredTools: string[];
	readonly activeToolSets: string[][];
	readonly sentMessages: unknown[];
	readonly semanticHooks: unknown[];
	streaming: boolean;
	fire(name: string, event?: unknown): Promise<void>;
}

function createAttachmentHarness(options: {
	readonly sessionId: string;
	readonly hasUI: boolean;
}): AttachmentHarness {
	const handlers = new Map<string, Handler[]>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const registeredTools: string[] = [];
	const activeToolSets: string[][] = [];
	const sentMessages: unknown[] = [];
	const semanticHooks: unknown[] = [];
	const clock = new FakeClock();
	const events = new EventEmitter();
	events.on("pi:semantic-hook:v1", (event) => semanticHooks.push(event));
	let activeTools = ["read", "bash"];

	const harness = {
		clock,
		notifications,
		registeredTools,
		activeToolSets,
		sentMessages,
		semanticHooks,
		streaming: false,
	} as AttachmentHarness;

	const pi = {
		events,
		on(name: string, handler: Handler): void {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(tool: { readonly name: string }): void {
			registeredTools.push(tool.name);
			activeTools.push(tool.name);
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(names: string[]): void {
			activeTools = [...names];
			activeToolSets.push([...names]);
		},
		registerEntryRenderer(): void {},
		registerCommand(): void {},
		appendEntry(): void {},
		sendMessage(message: unknown): void {
			sentMessages.push(message);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: options.hasUI,
		cwd: `/project/${options.sessionId}`,
		isIdle: () => !harness.streaming,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => options.sessionId,
			getLeafId: () => null,
			getBranch: () => [],
		},
		ui: {
			notify(message: string, level?: string): void {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;

	Object.assign(harness, {
		pi,
		ctx,
		async fire(name: string, event: unknown = { type: name }): Promise<void> {
			for (const handler of handlers.get(name) ?? []) {
				await handler(event as never, ctx);
			}
		},
	});
	return harness;
}

const CONFIG: LoadedConfig = {
	config: {
		idleDelaySeconds: 3,
		maxRetries: 2,
		decisionPrompt: "Decide now.",
		continuePrompt: "Continue now.",
		reasonTypes: ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"],
		continueReasonTypes: ["WORK_REMAINS", "VERIFYING", "WAIT_AUTOMATION"],
	},
	diagnostics: [],
};

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

test("UI main alone loads effective config; a shared-hub headless observer does not", async () => {
	const hub = createObservableAgentHub();
	const main = createAttachmentHarness({ sessionId: "main", hasUI: true });
	const child = createAttachmentHarness({ sessionId: "child", hasUI: false });
	let mainLoads = 0;
	let childLoads = 0;

	createContinueWatchdogExtension({
		hub,
		clock: main.clock,
		loadConfig: async () => {
			mainLoads += 1;
			return CONFIG;
		},
	})(main.pi);
	createContinueWatchdogExtension({
		hub,
		clock: child.clock,
		loadConfig: async () => {
			childLoads += 1;
			return {
				...CONFIG,
				diagnostics: [
					{ source: "child", message: "observer config must stay unread" },
				],
			};
		},
	})(child.pi);

	await main.fire("session_start");
	await child.fire("session_start");

	assert.equal(mainLoads, 1);
	assert.equal(childLoads, 0);
	assert.deepEqual(child.notifications, []);
});

test("a non-main attachment only observes lifecycle and creates no control-plane effects", async () => {
	const hub = createObservableAgentHub();
	const main = createAttachmentHarness({ sessionId: "main", hasUI: true });
	const child = createAttachmentHarness({ sessionId: "child", hasUI: false });

	createContinueWatchdogExtension({
		hub,
		clock: main.clock,
		loadConfig: async () => CONFIG,
	})(main.pi);
	createContinueWatchdogExtension({
		hub,
		clock: child.clock,
		loadConfig: async () => CONFIG,
	})(child.pi);
	await main.fire("session_start");
	await child.fire("session_start");

	child.streaming = true;
	await child.fire("agent_start");
	assert.equal(hub.snapshot.busyCount, 1);
	child.streaming = false;
	await child.fire("agent_settled");
	assert.equal(hub.snapshot.busyCount, 0);

	assert.deepEqual(child.registeredTools, []);
	assert.deepEqual(child.activeToolSets, []);
	assert.deepEqual(child.sentMessages, []);
	assert.deepEqual(child.semanticHooks, []);
	assert.deepEqual(child.notifications, []);
	assert.equal(child.clock.records.length, 0);
});

test("detaching main lazily promotes the observer, while the old main stays inert", async () => {
	const hub = createObservableAgentHub();
	const main = createAttachmentHarness({ sessionId: "main", hasUI: true });
	const child = createAttachmentHarness({ sessionId: "child", hasUI: false });
	let childLoads = 0;

	createContinueWatchdogExtension({
		hub,
		clock: main.clock,
		loadConfig: async () => CONFIG,
	})(main.pi);
	createContinueWatchdogExtension({
		hub,
		clock: child.clock,
		loadConfig: async () => {
			childLoads += 1;
			return CONFIG;
		},
	})(child.pi);
	await main.fire("session_start");
	await child.fire("session_start");
	assert.equal(childLoads, 0);

	await main.fire("session_shutdown");
	await flushAsyncWork();
	assert.equal(hub.snapshot.main?.sessionId, "child");
	assert.equal(childLoads, 1);

	child.streaming = true;
	await child.fire("agent_start");
	child.streaming = false;
	await child.fire("agent_settled");
	assert.ok(
		child.clock.records.some(
			(record) => record.delayMs === 10_000 && !record.cleared,
		),
		"promoted observer must own the fixed inquiry fence",
	);

	const oldMainTimers = main.clock.records.length;
	await main.fire("agent_start");
	await main.fire("agent_settled");
	assert.equal(main.clock.records.length, oldMainTimers);
	assert.deepEqual(main.sentMessages, []);
});

test("config completion after demotion or shutdown is discarded without effects", async (t) => {
	await t.test("demotion", async () => {
		const hub = createObservableAgentHub();
		const headless = createAttachmentHarness({
			sessionId: "headless-first",
			hasUI: false,
		});
		const ui = createAttachmentHarness({ sessionId: "ui", hasUI: true });
		let resolveHeadless: ((loaded: LoadedConfig) => void) | undefined;
		const pendingConfig = new Promise<LoadedConfig>((resolve) => {
			resolveHeadless = resolve;
		});

		createContinueWatchdogExtension({
			hub,
			clock: headless.clock,
			loadConfig: async () => pendingConfig,
		})(headless.pi);
		createContinueWatchdogExtension({
			hub,
			clock: ui.clock,
			loadConfig: async () => CONFIG,
		})(ui.pi);

		const pendingStart = headless.fire("session_start");
		await flushAsyncWork();
		await ui.fire("session_start");
		resolveHeadless?.({
			...CONFIG,
			diagnostics: [
				{ source: "stale", message: "must not escape after demotion" },
			],
		});
		await pendingStart;

		assert.equal(hub.snapshot.main?.sessionId, "ui");
		assert.deepEqual(headless.notifications, []);
		assert.deepEqual(headless.registeredTools, []);
		assert.deepEqual(headless.activeToolSets, []);
		assert.deepEqual(headless.sentMessages, []);
		assert.equal(headless.clock.records.length, 0);
	});

	await t.test("shutdown", async () => {
		const hub = createObservableAgentHub();
		const attachment = createAttachmentHarness({
			sessionId: "headless-main",
			hasUI: false,
		});
		let resolveConfig: ((loaded: LoadedConfig) => void) | undefined;
		const pendingConfig = new Promise<LoadedConfig>((resolve) => {
			resolveConfig = resolve;
		});
		createContinueWatchdogExtension({
			hub,
			clock: attachment.clock,
			loadConfig: async () => pendingConfig,
		})(attachment.pi);

		const pendingStart = attachment.fire("session_start");
		await flushAsyncWork();
		await attachment.fire("session_shutdown");
		resolveConfig?.({
			...CONFIG,
			diagnostics: [
				{ source: "stale", message: "must not escape after shutdown" },
			],
		});
		await pendingStart;

		assert.equal(hub.snapshot.attachmentCount, 0);
		assert.deepEqual(attachment.notifications, []);
		assert.deepEqual(attachment.registeredTools, []);
		assert.deepEqual(attachment.activeToolSets, []);
		assert.deepEqual(attachment.sentMessages, []);
		assert.equal(attachment.clock.records.length, 0);
	});
});

test("first config diagnostic notify demotion drops control before later diagnostics", async () => {
	const hub = createObservableAgentHub();
	const headless = createAttachmentHarness({
		sessionId: "headless-main",
		hasUI: false,
	});
	let demotedDuringFirst = false;
	const originalNotify = headless.ctx.ui.notify.bind(headless.ctx.ui);
	headless.ctx.ui.notify = (
		message: string,
		level?: "error" | "warning" | "info",
	): void => {
		originalNotify(message, level);
		if (message === "first diagnostic" && !demotedDuringFirst) {
			demotedDuringFirst = true;
			// Synchronous UI bind demotes this claim mid-diagnostic loop.
			const ui = createAttachmentHarness({ sessionId: "ui", hasUI: true });
			createContinueWatchdogExtension({
				hub,
				clock: ui.clock,
				loadConfig: async () => CONFIG,
			})(ui.pi);
			// Fire without awaiting so demotion is fully synchronous for the
			// still-running headless config-completion path.
			void ui.fire("session_start");
		}
	};

	createContinueWatchdogExtension({
		hub,
		clock: headless.clock,
		loadConfig: async () => ({
			...CONFIG,
			diagnostics: [
				{ source: "global", message: "first diagnostic" },
				{ source: "project", message: "second diagnostic" },
			],
		}),
	})(headless.pi);

	await headless.fire("session_start");
	await flushAsyncWork();

	assert.equal(demotedDuringFirst, true);
	assert.equal(hub.snapshot.main?.sessionId, "ui");
	assert.deepEqual(headless.notifications, [
		{ message: "first diagnostic", level: "warning" },
	]);
	assert.deepEqual(headless.registeredTools, []);
	assert.deepEqual(headless.activeToolSets, []);
	assert.deepEqual(headless.sentMessages, []);
	assert.equal(headless.clock.records.length, 0);

	// Demoted headless must not keep control after a later busy/idle cycle.
	headless.streaming = true;
	await headless.fire("agent_start");
	headless.streaming = false;
	await headless.fire("agent_settled");
	assert.equal(headless.clock.records.length, 0);
	assert.deepEqual(headless.sentMessages, []);
});
