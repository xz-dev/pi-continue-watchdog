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

type MessageStartHandler = (...args: unknown[]) => void;

interface Harness {
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly handlers: Map<string, MessageStartHandler>;
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
			// Automatic user work assigns the same state as lock, but its command-only
			// notification effect is intentionally not rendered at this seam.
			controller.onMainUserMessageStart();
		},
	};
}

function createHarness(): Harness {
	const hub = createObservableAgentHub();
	const controller = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	const handlers = new Map<string, MessageStartHandler>();
	const calls: string[] = [];
	const commandNames: string[] = [];
	const entryRendererTypes: string[] = [];
	let activeTools: string[] = [];
	const pi = {
		on(name: string, handler: MessageStartHandler): void {
			calls.push(name);
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
		registerEntryRenderer(customType: string): void {
			entryRendererTypes.push(customType);
		},
		registerCommand(name: string): void {
			commandNames.push(name);
		},
		appendEntry(): void {},
	} as unknown as ExtensionAPI;

	createContinueWatchdogExtension({ hub, controller })(pi);
	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart, "expected a session_start handler");
	sessionStart(
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
			const handler = handlers.get("message_start");
			assert.ok(handler, "expected a message_start handler");
			handler(event);
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

test("Example 1 RED: an actual main user message_start locks without a command notification", () => {
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
	assert.deepEqual(harness.entryRendererTypes, ["pi-continue-watchdog:unlock"]);
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
		idleTimer: null,
		decisionOpen: false,
	});
});

test("Example 1 RED: every actual main user start unconditionally resets exhausted and decision-failed cycles", () => {
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

test("Example 1 RED: assistant, custom, inherited, and hostile message shapes cannot auto-lock", () => {
	const harness = createHarness();
	const before = harness.controller.snapshot;

	for (const event of [
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "message_start", message: { role: "toolResult" } },
		{ type: "message_start", message: { role: "custom" } },
		{ type: "message_start", message: Object.create({ role: "user" }) },
		{
			type: "message_start",
			get message() {
				throw new Error("hostile");
			},
		},
		new Proxy(
			{ type: "message_start", message: { role: "user" } },
			{
				getOwnPropertyDescriptor(): never {
					throw new Error("hostile");
				},
			},
		),
	]) {
		assert.doesNotThrow(() => harness.fire(event));
	}

	assert.deepEqual(harness.controller.snapshot, before);
});

test("Example 1 RED: child, stale, and detached main handlers are inert while the elected main handler remains active", () => {
	const hub = createObservableAgentHub();
	const oldMain = bindMain(hub, "headless-main", false);
	const oldController = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	const oldHandlers = new Map<string, MessageStartHandler>();
	const oldPi = {
		on(name: string, handler: MessageStartHandler): void {
			oldHandlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	registerMainUserAutoLock(
		oldPi,
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
	const childPi = {
		on(_name: string, handler: MessageStartHandler): void {
			childPi.handler = handler;
		},
		handler: undefined as MessageStartHandler | undefined,
	} as unknown as ExtensionAPI & { handler?: MessageStartHandler };
	registerMainUserAutoLock(childPi, {
		isCurrentMain: () => false,
		onMainUserMessageStart: () => childController.onMainUserMessageStart(),
	});

	const electedMain = bindMain(hub, "ui-main", true);
	const electedController = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	const electedHandlers = new Map<string, MessageStartHandler>();
	const electedPi = {
		on(name: string, handler: MessageStartHandler): void {
			electedHandlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	registerMainUserAutoLock(
		electedPi,
		controllerBinding(electedController, hub, electedMain.attachment),
	);

	const event = userMessageStart();
	oldHandlers.get("message_start")?.(event);
	childPi.handler?.(event);
	assert.equal(oldController.snapshot.locked, false);
	assert.equal(childController.snapshot.locked, false);

	electedHandlers.get("message_start")?.(event);
	assert.equal(electedController.snapshot.locked, true);

	hub.detach(electedMain.attachment);
	electedController.unlock();
	electedHandlers.get("message_start")?.(event);
	assert.equal(electedController.snapshot.locked, false);

	const reclaimed = hub.reclaimMain(oldMain.attachment);
	assert.equal(reclaimed.applied, true);
	oldHandlers.get("message_start")?.(event);
	assert.equal(oldController.snapshot.locked, true);
});

test("Slice 8 RED: repeated actual user events invoke the main transition without a same-state short circuit", () => {
	const handlers = new Map<string, MessageStartHandler>();
	let calls = 0;
	const pi = {
		on(name: string, handler: MessageStartHandler): void {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	registerMainUserAutoLock(pi, {
		isCurrentMain: () => true,
		onMainUserMessageStart: () => {
			calls += 1;
		},
	});

	const handler = handlers.get("message_start");
	assert.ok(handler);
	handler(userMessageStart());
	handler(userMessageStart());
	assert.equal(calls, 2);
});
