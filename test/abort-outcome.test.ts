import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import {
	type BranchEntryView,
	captureBranchBoundary,
	inspectTerminalAssistantOutcome,
	registerMainAbortUnlock,
} from "../src/abort-outcome.js";
import {
	type ControllerEffect,
	createLockDecisionController,
	type LockDecisionController,
} from "../src/controller.js";
import { createContinueWatchdogExtension } from "../src/extension.js";
import {
	createHubAttachmentInstance,
	createObservableAgentHub,
	type HubAttachment,
	type HubMainClaim,
	type ObservableAgentHub,
} from "../src/hub.js";

type LifecycleHandler = (
	event: unknown,
	ctx: ExtensionContext,
) => void | Promise<void>;

async function fireHandlers(
	handlers: Map<string, LifecycleHandler[]>,
	name: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	const list = handlers.get(name);
	assert.ok(list && list.length > 0, `expected ${name}`);
	for (const handler of list) await handler(event, ctx);
}

interface FakeSessionManager {
	leafId: string | null;
	branch: BranchEntryView[];
	getLeafId(): string | null;
	getBranch(): BranchEntryView[];
	append(entry: BranchEntryView): void;
}

function createSessionManager(
	initial: readonly BranchEntryView[] = [],
): FakeSessionManager {
	const branch: BranchEntryView[] = [...initial];
	return {
		leafId: branch.length > 0 ? branch[branch.length - 1].id : null,
		branch,
		getLeafId() {
			return this.leafId;
		},
		getBranch() {
			return [...this.branch];
		},
		append(entry) {
			this.branch.push(entry);
			this.leafId = entry.id;
		},
	};
}

function assistant(id: string, stopReason: string): BranchEntryView {
	return { type: "message", id, message: { role: "assistant", stopReason } };
}
function user(id: string): BranchEntryView {
	return { type: "message", id, message: { role: "user" } };
}
function custom(id: string): BranchEntryView {
	return { type: "custom", id };
}

function multiOn(handlers: Map<string, LifecycleHandler[]>): ExtensionAPI {
	return {
		on(name: string, handler: LifecycleHandler): void {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	} as unknown as ExtensionAPI;
}

function notifyCtx(
	sessionManager: FakeSessionManager,
	notifications: string[],
	timeline?: string[],
): ExtensionContext {
	return {
		hasUI: true,
		isIdle: () => true,
		sessionManager,
		ui: {
			notify(message: string): void {
				notifications.push(message);
				timeline?.push(`notify:${message}`);
			},
		} as ExtensionUIContext,
	} as unknown as ExtensionContext;
}

function makeController(): LockDecisionController {
	return createLockDecisionController({ idleDelaySeconds: 3, maxRetries: 1 });
}

function decisionId(controller: LockDecisionController): number {
	const timer = controller
		.onAllObservableIdle()
		.effects.find(
			(effect): effect is Extract<ControllerEffect, { kind: "armIdleTimer" }> =>
				effect.kind === "armIdleTimer",
		);
	assert.ok(timer);
	const decision = controller
		.beginDecision(timer.timerId)
		.effects.find(
			(
				effect,
			): effect is Extract<ControllerEffect, { kind: "openDecisionWindow" }> =>
				effect.kind === "openDecisionWindow",
		);
	assert.ok(decision);
	return decision.decisionId;
}

interface AbortHarness {
	readonly hub: ObservableAgentHub;
	readonly controller: LockDecisionController;
	readonly handlers: Map<string, LifecycleHandler[]>;
	readonly notifications: string[];
	readonly effects: ControllerEffect[];
	readonly timeline: string[];
	readonly sessionManager: FakeSessionManager;
	readonly attachment: HubAttachment;
	readonly claim: HubMainClaim;
	readonly ctx: ExtensionContext;
	start(): Promise<void>;
	settle(): Promise<void>;
	append(entry: BranchEntryView): void;
}

function createAbortHarness(
	options: {
		readonly locked?: boolean;
		readonly initialBranch?: readonly BranchEntryView[];
	} = {},
): AbortHarness {
	const hub = createObservableAgentHub();
	const controller = makeController();
	if (options.locked !== false) controller.lock();

	const bound = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "main",
		hasUI: true,
	});
	assert.ok(bound.attachment);
	assert.ok(bound.mainClaim);

	const handlers = new Map<string, LifecycleHandler[]>();
	const notifications: string[] = [];
	const effects: ControllerEffect[] = [];
	const timeline: string[] = [];
	const sessionManager = createSessionManager(options.initialBranch ?? []);

	registerMainAbortUnlock(multiOn(handlers), {
		isCurrentMain() {
			const claim = hub.mainClaimFor(bound.attachment);
			return claim !== null && hub.isCurrentMain(claim);
		},
		getMainClaim() {
			return hub.mainClaimFor(bound.attachment);
		},
		isCurrentMainClaim(claim) {
			return hub.isCurrentMain(claim);
		},
		controller,
		applyEffect(effect) {
			effects.push(effect);
			timeline.push(effect.kind);
		},
	});

	const ctx = notifyCtx(sessionManager, notifications, timeline);
	return {
		hub,
		controller,
		handlers,
		notifications,
		effects,
		timeline,
		sessionManager,
		attachment: bound.attachment,
		claim: bound.mainClaim,
		ctx,
		async start() {
			await fireHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		},
		async settle() {
			await fireHandlers(
				handlers,
				"agent_settled",
				{ type: "agent_settled" },
				ctx,
			);
		},
		append(entry) {
			sessionManager.append(entry);
		},
	};
}

function createExtensionHarness(controller: LockDecisionController): {
	readonly handlers: Map<string, LifecycleHandler[]>;
	readonly notifications: string[];
	readonly sessionManager: FakeSessionManager;
	readonly ctx: ExtensionContext;
} {
	const hub = createObservableAgentHub();
	const handlers = new Map<string, LifecycleHandler[]>();
	const notifications: string[] = [];
	const sessionManager = createSessionManager([user("u0")]);
	let activeTools: string[] = ["bash", "read"];

	const pi = {
		...multiOn(handlers),
		registerTool(tool: { readonly name: string }) {
			activeTools.push(tool.name);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(toolNames: string[]) {
			activeTools = [...toolNames];
		},
		registerEntryRenderer() {},
		registerCommand() {},
		appendEntry() {
			throw new Error("abort unlock must not append a reason entry");
		},
	} as unknown as ExtensionAPI;

	createContinueWatchdogExtension({ hub, controller })(pi);

	const ctx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "main",
			getLeafId: () => sessionManager.getLeafId(),
			getBranch: () => sessionManager.getBranch(),
		},
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;

	return { handlers, notifications, sessionManager, ctx };
}

test("pure: boundary capture and suffix terminal outcomes", () => {
	assert.equal(captureBranchBoundary({ getLeafId: () => null }), null);
	assert.equal(captureBranchBoundary({ getLeafId: () => "leaf-1" }), "leaf-1");

	const entries = [
		assistant("a0", "aborted"),
		user("u1"),
		assistant("a1", "stop"),
	];
	const sm = { getBranch: () => entries };
	assert.equal(inspectTerminalAssistantOutcome(sm, "u1"), "non-aborted");
	assert.equal(inspectTerminalAssistantOutcome(sm, "a0"), "non-aborted");
	assert.equal(inspectTerminalAssistantOutcome(sm, null), "non-aborted");
	assert.equal(
		inspectTerminalAssistantOutcome(sm, "missing"),
		"boundary-missing",
	);
	assert.equal(
		inspectTerminalAssistantOutcome(
			{ getBranch: () => [assistant("only", "aborted")] },
			null,
		),
		"aborted",
	);
	assert.equal(
		inspectTerminalAssistantOutcome({ getBranch: () => [] }, null),
		"none",
	);
	assert.equal(
		inspectTerminalAssistantOutcome(
			{ getBranch: () => [user("u0"), custom("c1")] },
			"u0",
		),
		"none",
	);
});

test("aborted terminal unlock restores tools then notifies bare text", async () => {
	const harness = createAbortHarness({ locked: true });
	harness.append(user("u0"));
	await harness.start();
	decisionId(harness.controller);
	assert.equal(harness.controller.snapshot.decisionOpen, true);

	harness.append(assistant("a1", "aborted"));
	await harness.settle();

	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.deepEqual(harness.notifications, ["Continue watchdog unlocked"]);
	assert.deepEqual(
		harness.effects.map((effect) => effect.kind),
		["restoreDecisionTools"],
	);
	assert.deepEqual(harness.timeline, [
		"restoreDecisionTools",
		"notify:Continue watchdog unlocked",
	]);
});

test("already-unlocked abort still notifies bare text", async () => {
	const harness = createAbortHarness({ locked: false });
	await harness.start();
	harness.append(assistant("a1", "aborted"));
	await harness.settle();
	assert.equal(harness.controller.snapshot.locked, false);
	assert.deepEqual(harness.notifications, ["Continue watchdog unlocked"]);
});

test("non-aborted matrix and no-assistant / missing-boundary stay locked", async () => {
	for (const stopReason of ["stop", "error", "length", "toolUse"] as const) {
		const harness = createAbortHarness({ locked: true });
		await harness.start();
		harness.append(assistant(`a-${stopReason}`, stopReason));
		await harness.settle();
		assert.equal(harness.controller.snapshot.locked, true);
		assert.deepEqual(harness.notifications, []);
	}

	const stale = createAbortHarness({
		locked: true,
		initialBranch: [assistant("old-aborted", "aborted")],
	});
	await stale.start();
	await stale.settle();
	assert.equal(stale.controller.snapshot.locked, true);

	const noAssistant = createAbortHarness({
		locked: true,
		initialBranch: [assistant("old-aborted", "aborted")],
	});
	await noAssistant.start();
	noAssistant.append(user("u-new"));
	noAssistant.append(custom("c-new"));
	await noAssistant.settle();
	assert.equal(noAssistant.controller.snapshot.locked, true);

	const missing = createAbortHarness({
		locked: true,
		initialBranch: [user("u0")],
	});
	await missing.start();
	missing.sessionManager.branch = [assistant("rewritten", "aborted")];
	missing.sessionManager.leafId = "rewritten";
	await missing.settle();
	assert.equal(missing.controller.snapshot.locked, true);
});

test("duplicate settle does not notify twice", async () => {
	const harness = createAbortHarness({ locked: true });
	await harness.start();
	harness.append(assistant("a1", "aborted"));
	await harness.settle();
	await harness.settle();
	assert.deepEqual(harness.notifications, ["Continue watchdog unlocked"]);
});

test("demotion/detach/reclaim and child capture stay inert", async () => {
	const hub = createObservableAgentHub();
	const controller = makeController();
	controller.lock();
	const headless = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "headless-main",
		hasUI: false,
	});
	assert.ok(headless.attachment && headless.mainClaim);

	const handlers = new Map<string, LifecycleHandler[]>();
	const notifications: string[] = [];
	const sessionManager = createSessionManager();
	registerMainAbortUnlock(multiOn(handlers), {
		isCurrentMain() {
			const claim = hub.mainClaimFor(headless.attachment);
			return claim !== null && hub.isCurrentMain(claim);
		},
		getMainClaim() {
			return hub.mainClaimFor(headless.attachment);
		},
		isCurrentMainClaim(claim) {
			return hub.isCurrentMain(claim);
		},
		controller,
		applyEffect() {
			throw new Error("demoted settle must not apply effects");
		},
	});
	const ctx = notifyCtx(sessionManager, notifications);

	await fireHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
	sessionManager.append(assistant("a1", "aborted"));
	const usurper = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "ui-usurper",
		hasUI: true,
	});
	assert.ok(usurper.attachment && usurper.mainClaim);
	assert.equal(hub.isCurrentMain(headless.mainClaim), false);
	await fireHandlers(handlers, "agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(controller.snapshot.locked, true);

	hub.detach(usurper.attachment);
	assert.equal(hub.reclaimMain(headless.attachment).applied, true);
	await fireHandlers(handlers, "agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(controller.snapshot.locked, true);
	assert.deepEqual(notifications, []);

	const childController = makeController();
	childController.lock();
	const childHandlers = new Map<string, LifecycleHandler[]>();
	const childNotifications: string[] = [];
	const childSession = createSessionManager();
	registerMainAbortUnlock(multiOn(childHandlers), {
		isCurrentMain: () => false,
		getMainClaim: () => null,
		isCurrentMainClaim: () => false,
		controller: childController,
		applyEffect() {
			throw new Error("child must not apply effects");
		},
	});
	const childCtx = notifyCtx(childSession, childNotifications);
	await fireHandlers(
		childHandlers,
		"agent_start",
		{ type: "agent_start" },
		childCtx,
	);
	childSession.append(assistant("a1", "aborted"));
	await fireHandlers(
		childHandlers,
		"agent_settled",
		{ type: "agent_settled" },
		childCtx,
	);
	assert.equal(childController.snapshot.locked, true);
	assert.deepEqual(childNotifications, []);
});

test("supersede, terminal last assistant, and suffix-only inspection", async () => {
	const supersede = createAbortHarness({ locked: true });
	supersede.append(user("u0"));
	await supersede.start();
	supersede.append(assistant("a-old", "aborted"));
	supersede.append(user("u1"));
	await supersede.start();
	supersede.append(assistant("a-new", "stop"));
	await supersede.settle();
	assert.equal(supersede.controller.snapshot.locked, true);

	const earlier = createAbortHarness({ locked: true });
	await earlier.start();
	earlier.append(assistant("a-aborted", "aborted"));
	earlier.append(assistant("a-stop", "stop"));
	await earlier.settle();
	assert.equal(earlier.controller.snapshot.locked, true);

	const finalAborted = createAbortHarness({ locked: true });
	await finalAborted.start();
	finalAborted.append(assistant("a-stop", "stop"));
	finalAborted.append(custom("c1"));
	finalAborted.append(assistant("a-aborted", "aborted"));
	finalAborted.append(custom("c2"));
	await finalAborted.settle();
	assert.equal(finalAborted.controller.snapshot.locked, false);
	assert.deepEqual(finalAborted.notifications, ["Continue watchdog unlocked"]);

	const noStart = createAbortHarness({ locked: true });
	noStart.append(assistant("a1", "aborted"));
	await noStart.settle();
	assert.equal(noStart.controller.snapshot.locked, true);

	const initial = [assistant("old", "aborted")];
	const harness = createAbortHarness({ locked: true, initialBranch: initial });
	const branchBefore = harness.sessionManager.branch;
	await harness.start();
	harness.append(assistant("new-stop", "stop"));
	const beforeSettle = [...harness.sessionManager.branch];
	await harness.settle();
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.sessionManager.branch, beforeSettle);
	assert.equal(harness.sessionManager.branch, branchBefore);
});

test("extension registers hooks, clears on shutdown, and unlocks through settle", async () => {
	const shutdownController = makeController();
	shutdownController.lock();
	const shutdown = createExtensionHarness(shutdownController);
	assert.ok((shutdown.handlers.get("agent_start") ?? []).length > 0);
	assert.ok((shutdown.handlers.get("agent_settled") ?? []).length > 0);
	assert.ok((shutdown.handlers.get("session_start") ?? []).length > 0);
	assert.ok((shutdown.handlers.get("session_shutdown") ?? []).length > 0);

	await fireHandlers(
		shutdown.handlers,
		"session_start",
		{ type: "session_start", reason: "startup" },
		shutdown.ctx,
	);
	await fireHandlers(
		shutdown.handlers,
		"agent_start",
		{ type: "agent_start" },
		shutdown.ctx,
	);
	shutdown.sessionManager.append(assistant("a1", "aborted"));
	await fireHandlers(
		shutdown.handlers,
		"session_shutdown",
		{ type: "session_shutdown" },
		shutdown.ctx,
	);
	await fireHandlers(
		shutdown.handlers,
		"agent_settled",
		{ type: "agent_settled" },
		shutdown.ctx,
	);
	assert.equal(shutdownController.snapshot.locked, true);
	assert.deepEqual(shutdown.notifications, []);

	const unlockController = makeController();
	unlockController.lock();
	const unlock = createExtensionHarness(unlockController);
	await fireHandlers(
		unlock.handlers,
		"session_start",
		{ type: "session_start", reason: "startup" },
		unlock.ctx,
	);
	await fireHandlers(
		unlock.handlers,
		"agent_start",
		{ type: "agent_start" },
		unlock.ctx,
	);
	unlock.sessionManager.append(assistant("a1", "aborted"));
	await fireHandlers(
		unlock.handlers,
		"agent_settled",
		{ type: "agent_settled" },
		unlock.ctx,
	);
	assert.equal(unlockController.snapshot.locked, false);
	assert.deepEqual(unlock.notifications, ["Continue watchdog unlocked"]);
});
