import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type MainUserAutoLockBinding,
	registerMainUserAutoLock,
} from "../src/auto-lock.js";
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
} from "../src/hub.js";

type LifecycleHandler = (...args: unknown[]) => void;

interface Harness {
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly handlers: Map<string, LifecycleHandler[]>;
	readonly calls: string[];
	readonly commandNames: string[];
	readonly entryRendererTypes: string[];
	fire(event: unknown): void;
}

function bindMain(
	hub: ReturnType<typeof createObservableAgentHub>,
	sessionId: string,
	hasUI: boolean,
): { readonly attachment: HubAttachment; readonly claim: HubMainClaim } {
	const bound = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId,
		hasUI,
	});
	assert.ok(bound.attachment, "expected a hub attachment");
	assert.ok(bound.mainClaim, "expected the attachment to own main");
	return { attachment: bound.attachment, claim: bound.mainClaim };
}

function controllerBinding(
	controller: ReturnType<typeof createLockDecisionController>,
	hub: ReturnType<typeof createObservableAgentHub>,
	attachment: HubAttachment,
): MainUserAutoLockBinding {
	return {
		isCurrentMain(): boolean {
			const claim = hub.mainClaimFor(attachment);
			return claim !== null && hub.isCurrentMain(claim);
		},
		onMainUserMessageStart(): void {
			controller.onMainUserMessageStart();
		},
	};
}

function createMultiHandlerPi(options?: {
	readonly handlers?: Map<string, LifecycleHandler[]>;
	readonly calls?: string[];
	readonly commandNames?: string[];
	readonly entryRendererTypes?: string[];
}): ExtensionAPI {
	const handlers = options?.handlers ?? new Map<string, LifecycleHandler[]>();
	const calls = options?.calls ?? [];
	const commandNames = options?.commandNames ?? [];
	const entryRendererTypes = options?.entryRendererTypes ?? [];
	let activeTools: string[] = [];
	return {
		on(name: string, handler: LifecycleHandler): void {
			calls.push(name);
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
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
		registerEntryRenderer(customType: string): void {
			entryRendererTypes.push(customType);
		},
		registerCommand(name: string): void {
			commandNames.push(name);
		},
		appendEntry(): void {},
	} as unknown as ExtensionAPI;
}

function fireHandlers(
	handlers: Map<string, LifecycleHandler[]>,
	name: string,
	...args: unknown[]
): void {
	const list = handlers.get(name);
	assert.ok(list && list.length > 0, `expected ${name} handler`);
	for (const handler of list) {
		handler(...args);
	}
}

function createHarness(): Harness {
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	const handlers = new Map<string, LifecycleHandler[]>();
	const calls: string[] = [];
	const commandNames: string[] = [];
	const entryRendererTypes: string[] = [];

	createContinueWatchdogExtension({ hub, controller })(
		createMultiHandlerPi({
			handlers,
			calls,
			commandNames,
			entryRendererTypes,
		}),
	);

	fireHandlers(
		handlers,
		"session_start",
		{ type: "session_start", reason: "startup" },
		{
			hasUI: true,
			isIdle: () => true,
			sessionManager: { getSessionId: () => "main" },
		},
	);

	return {
		controller,
		handlers,
		calls,
		commandNames,
		entryRendererTypes,
		fire(event: unknown): void {
			fireHandlers(handlers, "message_start", event);
		},
	};
}

function userMessageStart(): unknown {
	return { type: "message_start", message: { role: "user" } };
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

test("actual main user message_start locks without a command notification", () => {
	const harness = createHarness();

	assert.equal(
		harness.calls.filter((name) => name === "message_start").length,
		1,
	);
	assert.equal(harness.handlers.has("input"), false);
	assert.deepEqual(harness.commandNames, [
		"lock-continue-watchdog",
		"unlock-continue-watchdog",
	]);
	assert.deepEqual(harness.entryRendererTypes, [
		"pi-continue-watchdog:continue",
		"pi-continue-watchdog:unlock",
	]);
	assert.equal(harness.calls.filter((name) => name === "context").length, 1);
	assert.equal(harness.controller.snapshot.locked, false);

	harness.fire(userMessageStart());

	assert.deepEqual(harness.controller.snapshot, {
		locked: true,
		attempt: 0,
		exhausted: false,
		decisionFailed: false,
		invalidDecisionAttempts: 0,
		lastInvalidDecisionError: null,
		idleTimer: {
			id: 1,
			attempt: 0,
			delaySeconds: 3,
		},
		decisionOpen: false,
	});
});

test("Example 1: a new main user message performs silent unlock cleanup before fresh lock", () => {
	const harness = createHarness();
	const { controller } = harness;
	controller.lock();
	const openDecision = decisionId(controller);
	controller.recordInvalidDecision(openDecision, "invalid once");
	assert.equal(controller.snapshot.decisionOpen, true);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 1);

	const timeline: string[] = [];
	const unlock = controller.unlock.bind(controller);
	const lock = controller.lock.bind(controller);
	controller.unlock = () => {
		timeline.push(`unlock:locked=${controller.snapshot.locked}`);
		return unlock();
	};
	controller.lock = () => {
		timeline.push(`lock:locked=${controller.snapshot.locked}`);
		return lock();
	};

	harness.fire(userMessageStart());

	assert.deepEqual(timeline, ["unlock:locked=true", "lock:locked=false"]);
	assert.equal(controller.snapshot.locked, true);
	assert.equal(controller.snapshot.attempt, 0);
	assert.equal(controller.snapshot.exhausted, false);
	assert.equal(controller.snapshot.decisionFailed, false);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(controller.snapshot.decisionOpen, false);
});

test("every actual main user start resets exhausted and decision-failed cycles", () => {
	const harness = createHarness();
	const { controller } = harness;

	controller.lock();
	controller.recordValidContinue(decisionId(controller));
	assert.equal(controller.snapshot.exhausted, true);
	assert.equal(controller.snapshot.attempt, 1);
	harness.fire(userMessageStart());
	assert.equal(controller.snapshot.locked, true);
	assert.equal(controller.snapshot.attempt, 0);
	assert.equal(controller.snapshot.exhausted, false);

	controller.lock();
	const failedDecision = decisionId(controller);
	controller.recordInvalidDecision(failedDecision, "first");
	controller.recordInvalidDecision(failedDecision, "second");
	controller.recordInvalidDecision(failedDecision, "third");
	assert.equal(controller.snapshot.decisionFailed, true);
	harness.fire(userMessageStart());
	assert.equal(controller.snapshot.locked, true);
	assert.equal(controller.snapshot.attempt, 0);
	assert.equal(controller.snapshot.decisionFailed, false);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 0);
});

test("non-user roles and missing messages are inert", () => {
	const harness = createHarness();
	const before = harness.controller.snapshot;

	for (const event of [
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "message_start", message: { role: "toolResult" } },
		{ type: "message_start", message: { role: "custom" } },
		{ type: "message_start" },
	]) {
		harness.fire(event);
	}

	assert.deepEqual(harness.controller.snapshot, before);
});

test("child, demoted, and detached handlers stay inert; reclaim restores main", () => {
	const hub = createObservableAgentHub();
	const oldMain = bindMain(hub, "headless-main", false);
	const oldController = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	const oldHandlers = new Map<string, LifecycleHandler[]>();
	registerMainUserAutoLock(
		createMultiHandlerPi({ handlers: oldHandlers }),
		controllerBinding(oldController, hub, oldMain.attachment),
	);

	const child = hub.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "child",
		hasUI: false,
	});
	assert.ok(child.attachment);
	const childController = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	const childHandlers = new Map<string, LifecycleHandler[]>();
	registerMainUserAutoLock(createMultiHandlerPi({ handlers: childHandlers }), {
		isCurrentMain: () => false,
		onMainUserMessageStart: () => childController.onMainUserMessageStart(),
	});

	const electedMain = bindMain(hub, "ui-main", true);
	const electedController = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	const electedHandlers = new Map<string, LifecycleHandler[]>();
	registerMainUserAutoLock(
		createMultiHandlerPi({ handlers: electedHandlers }),
		controllerBinding(electedController, hub, electedMain.attachment),
	);

	const event = userMessageStart();
	fireHandlers(oldHandlers, "message_start", event);
	fireHandlers(childHandlers, "message_start", event);
	assert.equal(oldController.snapshot.locked, false);
	assert.equal(childController.snapshot.locked, false);

	fireHandlers(electedHandlers, "message_start", event);
	assert.equal(electedController.snapshot.locked, true);

	hub.detach(electedMain.attachment);
	electedController.unlock();
	fireHandlers(electedHandlers, "message_start", event);
	assert.equal(electedController.snapshot.locked, false);

	const reclaimed = hub.reclaimMain(oldMain.attachment);
	assert.equal(reclaimed.applied, true);
	fireHandlers(oldHandlers, "message_start", event);
	assert.equal(oldController.snapshot.locked, true);
});

test("repeated actual user events invoke the main transition each time", () => {
	const handlers = new Map<string, LifecycleHandler[]>();
	let calls = 0;
	registerMainUserAutoLock(createMultiHandlerPi({ handlers }), {
		isCurrentMain: () => true,
		onMainUserMessageStart: () => {
			calls += 1;
		},
	});

	fireHandlers(handlers, "message_start", userMessageStart());
	fireHandlers(handlers, "message_start", userMessageStart());
	assert.equal(calls, 2);
});
