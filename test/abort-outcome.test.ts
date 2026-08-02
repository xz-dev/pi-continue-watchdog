import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import {
	captureBranchBoundary,
	inspectTerminalAssistantOutcome,
	registerMainAbortUnlock,
} from "../src/abort-outcome.js";
import {
	type ControllerEffect,
	createLockDecisionController,
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

async function fireHandler(
	handlers: Map<string, LifecycleHandler>,
	name: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	const handler = handlers.get(name);
	assert.ok(handler, `expected ${name}`);
	await handler(event, ctx);
}

interface BranchEntry {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly message?: {
		readonly role: string;
		readonly stopReason?: string;
	};
}

interface FakeSessionManager {
	leafId: string | null;
	branch: BranchEntry[];
	getLeafId(): string | null;
	getBranch(): BranchEntry[];
	append(entry: BranchEntry): void;
}

function createSessionManager(
	initial: readonly BranchEntry[] = [],
): FakeSessionManager {
	const branch: BranchEntry[] = [...initial];
	return {
		leafId: branch.length > 0 ? branch[branch.length - 1]!.id : null,
		branch,
		getLeafId(): string | null {
			return this.leafId;
		},
		getBranch(): BranchEntry[] {
			// Return a fresh array so tests can assert the detector does not mutate
			// the session manager's branch storage.
			return [...this.branch];
		},
		append(entry: BranchEntry): void {
			this.branch.push(entry);
			this.leafId = entry.id;
		},
	};
}

function assistant(
	id: string,
	stopReason: string,
	parentId: string | null = null,
): BranchEntry {
	return {
		type: "message",
		id,
		parentId,
		message: { role: "assistant", stopReason },
	};
}

function user(id: string, parentId: string | null = null): BranchEntry {
	return {
		type: "message",
		id,
		parentId,
		message: { role: "user" },
	};
}

function custom(id: string, parentId: string | null = null): BranchEntry {
	return {
		type: "custom",
		id,
		parentId,
	};
}

interface AbortHarness {
	readonly hub: ObservableAgentHub;
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly handlers: Map<string, LifecycleHandler>;
	readonly notifications: string[];
	readonly effects: ControllerEffect[];
	readonly timeline: string[];
	readonly sessionManager: FakeSessionManager;
	readonly attachment: HubAttachment;
	readonly claim: HubMainClaim;
	readonly ctx: ExtensionContext;
	setCurrentMain(current: boolean): void;
	start(): Promise<void>;
	settle(): Promise<void>;
	append(entry: BranchEntry): void;
}

function decisionId(
	controller: ReturnType<typeof createLockDecisionController>,
): number {
	const timer = controller
		.onAllObservableIdle()
		.effects.find(
			(effect): effect is Extract<ControllerEffect, { kind: "armIdleTimer" }> =>
				effect.kind === "armIdleTimer",
		);
	assert.ok(timer, "expected an idle timer");
	const decision = controller
		.beginDecision(timer.timerId)
		.effects.find(
			(
				effect,
			): effect is Extract<ControllerEffect, { kind: "openDecisionWindow" }> =>
				effect.kind === "openDecisionWindow",
		);
	assert.ok(decision, "expected a decision window");
	return decision.decisionId;
}

function createAbortHarness(
	options: {
		readonly locked?: boolean;
		readonly initialBranch?: readonly BranchEntry[];
	} = {},
): AbortHarness {
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	if (options.locked !== false) {
		controller.lock();
	}

	const bound = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "main",
		hasUI: true,
	});
	assert.ok(bound.attachment);
	assert.ok(bound.mainClaim);

	const handlers = new Map<string, LifecycleHandler>();
	const notifications: string[] = [];
	const effects: ControllerEffect[] = [];
	const timeline: string[] = [];
	const sessionManager = createSessionManager(options.initialBranch ?? []);
	let forceMain: boolean | null = null;

	const pi = {
		on(name: string, handler: LifecycleHandler): void {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;

	registerMainAbortUnlock(pi, {
		isCurrentMain(): boolean {
			if (forceMain !== null) return forceMain;
			const claim = hub.mainClaimFor(bound.attachment!);
			return claim !== null && hub.isCurrentMain(claim);
		},
		getMainClaim(): HubMainClaim | null {
			return hub.mainClaimFor(bound.attachment!);
		},
		isCurrentMainClaim(claim: HubMainClaim): boolean {
			return hub.isCurrentMain(claim);
		},
		controller,
		applyEffect(effect): void {
			effects.push(effect);
			timeline.push(effect.kind);
		},
	});

	const ctx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager,
		ui: {
			notify(message: string): void {
				notifications.push(message);
				timeline.push(`notify:${message}`);
			},
		} as ExtensionUIContext,
	} as unknown as ExtensionContext;

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
		setCurrentMain(current: boolean): void {
			forceMain = current;
		},
		async start(): Promise<void> {
			await fireHandler(handlers, "agent_start", { type: "agent_start" }, ctx);
		},
		async settle(): Promise<void> {
			await fireHandler(
				handlers,
				"agent_settled",
				{ type: "agent_settled" },
				ctx,
			);
		},
		append(entry: BranchEntry): void {
			sessionManager.append(entry);
		},
	};
}

test("pure: captureBranchBoundary reads getLeafId and rejects non-string values", () => {
	assert.equal(captureBranchBoundary({ getLeafId: () => null }), null);
	assert.equal(captureBranchBoundary({ getLeafId: () => "leaf-1" }), "leaf-1");
	assert.equal(captureBranchBoundary({ getLeafId: () => 42 }), undefined);
	assert.equal(captureBranchBoundary({}), undefined);
	assert.equal(
		captureBranchBoundary({
			getLeafId(): never {
				throw new Error("hostile");
			},
		}),
		undefined,
	);
});

test("pure: inspectTerminalAssistantOutcome only considers the post-boundary suffix", () => {
	const entries = [
		assistant("a0", "aborted"),
		user("u1", "a0"),
		assistant("a1", "stop", "u1"),
	];
	const sessionManager = {
		getBranch: () => entries,
	};

	assert.deepEqual(inspectTerminalAssistantOutcome(sessionManager, "u1"), {
		kind: "non-aborted",
		stopReason: "stop",
	});
	assert.deepEqual(inspectTerminalAssistantOutcome(sessionManager, "a0"), {
		kind: "non-aborted",
		stopReason: "stop",
	});
	assert.deepEqual(inspectTerminalAssistantOutcome(sessionManager, null), {
		kind: "non-aborted",
		stopReason: "stop",
	});
	assert.deepEqual(inspectTerminalAssistantOutcome(sessionManager, "missing"), {
		kind: "boundary-missing",
	});
	assert.deepEqual(
		inspectTerminalAssistantOutcome(
			{ getBranch: () => [assistant("only", "aborted")] },
			null,
		),
		{ kind: "aborted" },
	);
	assert.deepEqual(
		inspectTerminalAssistantOutcome({ getBranch: () => [] }, null),
		{ kind: "none" },
	);
});

test("pure: malformed branch arrays fail closed without length/index probes escaping", () => {
	const aborted = assistant("a1", "aborted");

	const lengthTrap = new Proxy([aborted], {
		getOwnPropertyDescriptor(target, key) {
			if (key === "length") throw new Error("length trap");
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	});
	const indexTrap = new Proxy([aborted], {
		getOwnPropertyDescriptor(target, key) {
			if (key === "0") throw new Error("index trap");
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	});
	const getTrap = new Proxy([aborted], {
		get(_target, key) {
			if (key === "length" || key === "0") {
				throw new Error("get trap must not be required");
			}
			return Reflect.get(_target, key as PropertyKey, _target);
		},
	});
	const { proxy: revokedProxy, revoke } = Proxy.revocable([aborted], {});
	revoke();

	const sparse = [aborted];
	sparse.length = 2;
	const accessor = [] as unknown[];
	Object.defineProperty(accessor, "0", {
		get() {
			throw new Error("must not invoke branch accessor");
		},
		configurable: true,
	});
	accessor.length = 1;
	const iteratorHostile = Object.assign([aborted], {
		[Symbol.iterator](): Iterator<never> {
			throw new Error("must not iterate getBranch result");
		},
	});

	const invalidBranches: readonly unknown[] = [
		lengthTrap,
		indexTrap,
		revokedProxy,
		sparse,
		accessor,
		{ 0: aborted, length: 1 },
		null,
		"not-an-array",
	];
	for (const branch of invalidBranches) {
		assert.doesNotThrow(() =>
			inspectTerminalAssistantOutcome({ getBranch: () => branch }, null),
		);
		assert.deepEqual(
			inspectTerminalAssistantOutcome({ getBranch: () => branch }, null),
			{ kind: "invalid" },
		);
	}

	// Descriptor-based snapshot may still succeed when only `get` is hostile;
	// that path must not throw and must not spuriously unlock from a trap.
	assert.doesNotThrow(() =>
		inspectTerminalAssistantOutcome({ getBranch: () => getTrap }, null),
	);
	assert.deepEqual(
		inspectTerminalAssistantOutcome({ getBranch: () => getTrap }, null),
		{ kind: "aborted" },
	);
	assert.doesNotThrow(() =>
		inspectTerminalAssistantOutcome({ getBranch: () => iteratorHostile }, null),
	);
	assert.deepEqual(
		inspectTerminalAssistantOutcome({ getBranch: () => iteratorHostile }, null),
		{ kind: "aborted" },
	);
});

test("pure: every inspected branch entry requires an own string id", () => {
	const missingPrefixId = {
		type: "message",
		parentId: null,
		message: { role: "user" },
	};
	const abortedSuffix = assistant("a1", "aborted");
	assert.deepEqual(
		inspectTerminalAssistantOutcome(
			{ getBranch: () => [missingPrefixId, abortedSuffix] },
			null,
		),
		{ kind: "invalid" },
	);
	assert.deepEqual(
		inspectTerminalAssistantOutcome(
			{
				getBranch: () => [user("u0"), missingPrefixId, abortedSuffix],
			},
			"u0",
		),
		{ kind: "invalid" },
	);

	const missingSuffixId = {
		type: "message",
		parentId: "u0",
		message: { role: "assistant", stopReason: "aborted" },
	};
	assert.deepEqual(
		inspectTerminalAssistantOutcome(
			{ getBranch: () => [user("u0"), missingSuffixId] },
			"u0",
		),
		{ kind: "invalid" },
	);

	const nonStringId = {
		type: "message",
		id: 42,
		parentId: null,
		message: { role: "assistant", stopReason: "aborted" },
	};
	assert.deepEqual(
		inspectTerminalAssistantOutcome({ getBranch: () => [nonStringId] }, null),
		{ kind: "invalid" },
	);

	const getterId = Object.defineProperty(
		{
			type: "message",
			parentId: null,
			message: { role: "assistant", stopReason: "aborted" },
		},
		"id",
		{
			get() {
				throw new Error("must not invoke id getter");
			},
			enumerable: true,
			configurable: true,
		},
	);
	assert.doesNotThrow(() =>
		inspectTerminalAssistantOutcome({ getBranch: () => [getterId] }, null),
	);
	assert.deepEqual(
		inspectTerminalAssistantOutcome({ getBranch: () => [getterId] }, null),
		{ kind: "invalid" },
	);
});

test("Example 4: aborted terminal assistant unlocks, notifies, restores, and appends no reason entry", async () => {
	const harness = createAbortHarness({ locked: true });
	harness.append(user("u0"));
	await harness.start();
	assert.equal(harness.controller.snapshot.locked, true);

	// Force a decision window so unlock must restore tools before notifying.
	decisionId(harness.controller);
	assert.equal(harness.controller.snapshot.decisionOpen, true);

	harness.append(assistant("a1", "aborted", "u0"));
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

test("Example 4: already-unlocked abort still notifies with the exact bare text", async () => {
	const harness = createAbortHarness({ locked: false });
	assert.equal(harness.controller.snapshot.locked, false);
	await harness.start();
	harness.append(assistant("a1", "aborted"));
	await harness.settle();
	assert.equal(harness.controller.snapshot.locked, false);
	assert.deepEqual(harness.notifications, ["Continue watchdog unlocked"]);
});

test("Example 4: natural stop, error, length, and toolUse do not unlock or notify", async () => {
	for (const stopReason of ["stop", "error", "length", "toolUse"] as const) {
		const harness = createAbortHarness({ locked: true });
		await harness.start();
		harness.append(assistant(`a-${stopReason}`, stopReason));
		await harness.settle();
		assert.equal(
			harness.controller.snapshot.locked,
			true,
			`expected still locked for ${stopReason}`,
		);
		assert.deepEqual(harness.notifications, []);
		assert.deepEqual(harness.effects, []);
	}
});

test("Example 4: stale pre-boundary aborted assistant is ignored; no new assistant is a no-op", async () => {
	const harness = createAbortHarness({
		locked: true,
		initialBranch: [assistant("old-aborted", "aborted")],
	});
	await harness.start();
	// Boundary is old-aborted. No new assistant after the boundary.
	await harness.settle();
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.notifications, []);

	const harness2 = createAbortHarness({
		locked: true,
		initialBranch: [assistant("old-aborted", "aborted")],
	});
	await harness2.start();
	harness2.append(user("u-new", "old-aborted"));
	harness2.append(custom("c-new", "u-new"));
	await harness2.settle();
	assert.equal(harness2.controller.snapshot.locked, true);
	assert.deepEqual(harness2.notifications, []);
});

test("Example 4: duplicate settle for the same aborted run does not notify twice", async () => {
	const harness = createAbortHarness({ locked: true });
	await harness.start();
	harness.append(assistant("a1", "aborted"));
	await harness.settle();
	await harness.settle();
	assert.deepEqual(harness.notifications, ["Continue watchdog unlocked"]);
	assert.equal(harness.controller.snapshot.locked, false);
});

test("Example 4: demoted/detached settle discards capture and does not unlock", async () => {
	// Use a headless main so a later UI attachment can atomically demote it.
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	controller.lock();

	const headless = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "headless-main",
		hasUI: false,
	});
	assert.ok(headless.attachment);
	assert.ok(headless.mainClaim);

	const handlers = new Map<string, LifecycleHandler>();
	const notifications: string[] = [];
	const sessionManager = createSessionManager();

	registerMainAbortUnlock(
		{
			on(name: string, handler: LifecycleHandler): void {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI,
		{
			isCurrentMain(): boolean {
				const claim = hub.mainClaimFor(headless.attachment!);
				return claim !== null && hub.isCurrentMain(claim);
			},
			getMainClaim(): HubMainClaim | null {
				return hub.mainClaimFor(headless.attachment!);
			},
			isCurrentMainClaim(claim: HubMainClaim): boolean {
				return hub.isCurrentMain(claim);
			},
			controller,
			applyEffect(): void {
				throw new Error("demoted settle must not apply effects");
			},
		},
	);

	const ctx = {
		sessionManager,
		ui: {
			notify(message: string): void {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;

	await fireHandler(handlers, "agent_start", { type: "agent_start" }, ctx);
	sessionManager.append(assistant("a1", "aborted"));

	const usurper = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "ui-usurper",
		hasUI: true,
	});
	assert.ok(usurper.attachment);
	assert.ok(usurper.mainClaim);
	assert.equal(hub.isCurrentMain(headless.mainClaim), false);

	await fireHandler(handlers, "agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(controller.snapshot.locked, true);
	assert.deepEqual(notifications, []);

	// Reclaim must not process the already-consumed capture.
	hub.detach(usurper.attachment);
	const reclaimed = hub.reclaimMain(headless.attachment);
	assert.equal(reclaimed.applied, true);
	await fireHandler(handlers, "agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(controller.snapshot.locked, true);
	assert.deepEqual(notifications, []);
});

test("Example 4: child start/settle is inert", async () => {
	const hub = createObservableAgentHub();
	const main = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "main",
		hasUI: true,
	});
	assert.ok(main.attachment);

	const childController = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	childController.lock();
	const handlers = new Map<string, LifecycleHandler>();
	const notifications: string[] = [];
	const sessionManager = createSessionManager();

	registerMainAbortUnlock(
		{
			on(name: string, handler: LifecycleHandler): void {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI,
		{
			isCurrentMain: () => false,
			getMainClaim: () => null,
			isCurrentMainClaim: () => false,
			controller: childController,
			applyEffect(): void {
				throw new Error("child must not apply effects");
			},
		},
	);

	const ctx = {
		sessionManager,
		ui: {
			notify(message: string): void {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;

	await fireHandler(handlers, "agent_start", { type: "agent_start" }, ctx);
	sessionManager.append(assistant("a1", "aborted"));
	await fireHandler(handlers, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(childController.snapshot.locked, true);
	assert.deepEqual(notifications, []);
});

test("Example 4: missing boundary after branch switch fails closed", async () => {
	const harness = createAbortHarness({
		locked: true,
		initialBranch: [user("u0")],
	});
	await harness.start();
	// Simulate branch switch / compaction rewrite that drops the captured leaf.
	harness.sessionManager.branch = [assistant("rewritten", "aborted")];
	harness.sessionManager.leafId = "rewritten";
	await harness.settle();
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.notifications, []);
});

test("Example 4: terminal new assistant is the last new assistant message", async () => {
	const harness = createAbortHarness({ locked: true });
	await harness.start();
	harness.append(assistant("a-aborted", "aborted"));
	harness.append(assistant("a-stop", "stop", "a-aborted"));
	await harness.settle();
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.notifications, []);

	const harness2 = createAbortHarness({ locked: true });
	await harness2.start();
	harness2.append(assistant("a-stop", "stop"));
	harness2.append(custom("c1", "a-stop"));
	harness2.append(assistant("a-aborted", "aborted", "c1"));
	harness2.append(custom("c2", "a-aborted"));
	await harness2.settle();
	assert.equal(harness2.controller.snapshot.locked, false);
	assert.deepEqual(harness2.notifications, ["Continue watchdog unlocked"]);
});

test("Example 4: malformed and proxy entries do not throw or unlock", async () => {
	const harness = createAbortHarness({ locked: true });
	await harness.start();

	const hostile = new Proxy(
		{ type: "message", id: "hostile", parentId: null },
		{
			getOwnPropertyDescriptor(): never {
				throw new Error("hostile descriptor");
			},
		},
	);
	harness.sessionManager.branch = [
		...harness.sessionManager.branch,
		hostile as unknown as BranchEntry,
	];
	harness.sessionManager.leafId = "hostile";

	await assert.doesNotReject(async () => harness.settle());
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.notifications, []);

	const harness2 = createAbortHarness({ locked: true });
	await harness2.start();
	harness2.sessionManager.branch = [
		{
			type: "message",
			id: "bad",
			parentId: null,
			message: Object.create({ role: "assistant", stopReason: "aborted" }),
		} as BranchEntry,
	];
	harness2.sessionManager.leafId = "bad";
	await assert.doesNotReject(async () => harness2.settle());
	assert.equal(harness2.controller.snapshot.locked, true);
	assert.deepEqual(harness2.notifications, []);
});

test("Example 4: hostile getBranch arrays and missing entry ids neither throw nor unlock", async () => {
	const aborted = assistant("a1", "aborted");

	const cases: Array<() => unknown> = [
		() =>
			new Proxy([aborted], {
				getOwnPropertyDescriptor(target, key) {
					if (key === "length") throw new Error("length trap");
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
			}),
		() =>
			new Proxy([aborted], {
				getOwnPropertyDescriptor(target, key) {
					if (key === "0") throw new Error("index trap");
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
			}),
		() => {
			const { proxy, revoke } = Proxy.revocable([aborted], {});
			revoke();
			return proxy;
		},
		() => [
			{ type: "message", parentId: null, message: { role: "user" } },
			aborted,
		],
		() => [
			{
				type: "message",
				parentId: null,
				message: { role: "assistant", stopReason: "aborted" },
			},
		],
	];

	for (const makeBranch of cases) {
		const harness = createAbortHarness({ locked: true });
		await harness.start();
		harness.sessionManager.getBranch = () => makeBranch() as BranchEntry[];
		await assert.doesNotReject(async () => harness.settle());
		assert.equal(harness.controller.snapshot.locked, true);
		assert.deepEqual(harness.notifications, []);
	}
});

test("Example 4: a new agent_start supersedes the prior capture", async () => {
	const harness = createAbortHarness({ locked: true });
	harness.append(user("u0"));
	await harness.start();
	// First run would have aborted, but a new start supersedes before settle.
	harness.append(assistant("a-old", "aborted", "u0"));
	harness.append(user("u1", "a-old"));
	await harness.start();
	harness.append(assistant("a-new", "stop", "u1"));
	await harness.settle();
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.notifications, []);
});

test("Example 4: only newly appended suffix is inspected and branch storage is not mutated", async () => {
	const initial = [assistant("old", "aborted")];
	const harness = createAbortHarness({ locked: true, initialBranch: initial });
	const branchBefore = harness.sessionManager.branch;
	await harness.start();
	harness.append(assistant("new-stop", "stop", "old"));
	const snapshotBeforeSettle = [...harness.sessionManager.branch];
	await harness.settle();
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.sessionManager.branch, snapshotBeforeSettle);
	assert.equal(harness.sessionManager.branch, branchBefore);
});

test("Example 4: agent_settled without a prior start is inert", async () => {
	const harness = createAbortHarness({ locked: true });
	harness.append(assistant("a1", "aborted"));
	await harness.settle();
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.notifications, []);
});

test("Example 4: extension registers agent_start and agent_settled and clears capture on shutdown", async () => {
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	controller.lock();

	const handlers = new Map<string, LifecycleHandler>();
	const notifications: string[] = [];
	const sessionManager = createSessionManager([user("u0")]);
	let activeTools: string[] = [];

	const pi = {
		on(name: string, handler: LifecycleHandler): void {
			handlers.set(name, handler);
		},
		registerTool(tool: { readonly name: string }): void {
			activeTools.push(tool.name);
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(toolNames: string[]): void {
			activeTools = [...toolNames];
		},
		registerEntryRenderer(): void {},
		registerCommand(): void {},
		appendEntry(): void {
			throw new Error("abort unlock must not append a reason entry");
		},
	} as unknown as ExtensionAPI;

	createContinueWatchdogExtension({ hub, controller })(pi);

	assert.equal(handlers.has("agent_start"), true);
	assert.equal(handlers.has("agent_settled"), true);
	assert.equal(handlers.has("session_start"), true);
	assert.equal(handlers.has("session_shutdown"), true);

	const ctx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "main",
			getLeafId: () => sessionManager.getLeafId(),
			getBranch: () => sessionManager.getBranch(),
		},
		ui: {
			notify(message: string): void {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;

	await fireHandler(
		handlers,
		"session_start",
		{ type: "session_start", reason: "startup" },
		ctx,
	);
	await fireHandler(handlers, "agent_start", { type: "agent_start" }, ctx);
	sessionManager.append(assistant("a1", "aborted", "u0"));

	// Shutdown clears capture before a late settle can fire.
	await fireHandler(
		handlers,
		"session_shutdown",
		{ type: "session_shutdown" },
		ctx,
	);
	await fireHandler(handlers, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(controller.snapshot.locked, true);
	assert.deepEqual(notifications, []);
});

test("Example 4: integrated extension unlock path notifies through settle ctx.ui", async () => {
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	controller.lock();

	const handlers = new Map<string, LifecycleHandler>();
	const notifications: string[] = [];
	const sessionManager = createSessionManager([user("u0")]);
	let activeTools: string[] = ["bash", "read"];

	const pi = {
		on(name: string, handler: LifecycleHandler): void {
			handlers.set(name, handler);
		},
		registerTool(tool: { readonly name: string }): void {
			activeTools.push(tool.name);
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(toolNames: string[]): void {
			activeTools = [...toolNames];
		},
		registerEntryRenderer(): void {},
		registerCommand(): void {},
		appendEntry(): void {
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
			notify(message: string): void {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;

	await fireHandler(
		handlers,
		"session_start",
		{ type: "session_start", reason: "startup" },
		ctx,
	);
	await fireHandler(handlers, "agent_start", { type: "agent_start" }, ctx);
	sessionManager.append(assistant("a1", "aborted", "u0"));
	await fireHandler(handlers, "agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(controller.snapshot.locked, false);
	assert.deepEqual(notifications, ["Continue watchdog unlocked"]);
});
