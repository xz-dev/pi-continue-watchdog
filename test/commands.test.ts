import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import {
	type CommandRuntimeEffect,
	createHumanUnlockEntryRenderer,
	createMainCommands,
	HUMAN_UNLOCK_ENTRY_TYPE,
	LOCK_COMMAND_DESCRIPTION,
	LOCK_CONTINUE_WATCHDOG_COMMAND,
	type MainCommandRuntime,
	UNLOCK_COMMAND_DESCRIPTION,
	UNLOCK_CONTINUE_WATCHDOG_COMMAND,
} from "../src/commands.js";
import {
	type ControllerEffect,
	createLockDecisionController,
} from "../src/controller.js";

type RegisteredCommand = {
	readonly description: string | undefined;
	readonly handler: (
		args: string,
		ctx: ExtensionCommandContext,
	) => Promise<void>;
};

type HumanUnlockEntry = { readonly reason: string };

interface CommandHarness {
	readonly pi: ExtensionAPI;
	readonly runtime: MainCommandRuntime;
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly commands: Map<string, RegisteredCommand>;
	readonly entryRenderers: Map<
		string,
		(entry: { data?: HumanUnlockEntry }) => { render(width: number): string[] }
	>;
	readonly notifications: string[];
	readonly entries: Array<{
		customType: string;
		data: HumanUnlockEntry | undefined;
	}>;
	readonly effects: CommandRuntimeEffect[];
	readonly timeline: string[];
	setCurrentMain(current: boolean): void;
	invoke(name: string, args?: string): Promise<void>;
}

function createHarness(): CommandHarness {
	const commands = new Map<string, RegisteredCommand>();
	const entryRenderers = new Map<
		string,
		(entry: { data?: HumanUnlockEntry }) => { render(width: number): string[] }
	>();
	const notifications: string[] = [];
	const entries: Array<{
		customType: string;
		data: HumanUnlockEntry | undefined;
	}> = [];
	const effects: CommandRuntimeEffect[] = [];
	const timeline: string[] = [];
	const controller = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 1,
	});
	let currentMain = true;

	const pi = {
		registerCommand(name: string, definition: RegisteredCommand): void {
			commands.set(name, definition);
		},
		registerEntryRenderer(
			customType: string,
			renderer: (entry: { data?: HumanUnlockEntry }) => {
				render(width: number): string[];
			},
		): void {
			entryRenderers.set(customType, renderer);
		},
		appendEntry(customType: string, data?: HumanUnlockEntry): void {
			entries.push({ customType, data });
		},
		sendMessage(): never {
			throw new Error(
				"human unlock reason entries must not send model messages",
			);
		},
	} as unknown as ExtensionAPI;

	const runtime: MainCommandRuntime = {
		controller,
		isCurrentMain: () => currentMain,
		applyEffect: async (effect) => {
			effects.push(effect);
			timeline.push(effect.kind);
		},
	};

	createMainCommands(pi, runtime);

	const ctx = {
		ui: {
			notify(message: string): void {
				notifications.push(message);
				timeline.push(`notify:${message}`);
			},
		} as ExtensionUIContext,
	} as ExtensionCommandContext;

	return {
		pi,
		runtime,
		controller,
		commands,
		entryRenderers,
		notifications,
		entries,
		effects,
		timeline,
		setCurrentMain(current: boolean): void {
			currentMain = current;
		},
		async invoke(name: string, args = ""): Promise<void> {
			const command = commands.get(name);
			assert.ok(command, `expected /${name} to be registered`);
			await command.handler(args, ctx);
		},
	};
}

function armDecision(
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

test("Slice 4 RED: registers the exact human command names, descriptions, and TUI-only unlock entry renderer", () => {
	const harness = createHarness();

	assert.deepEqual(
		[...harness.commands.keys()],
		[LOCK_CONTINUE_WATCHDOG_COMMAND, UNLOCK_CONTINUE_WATCHDOG_COMMAND],
	);
	assert.equal(
		harness.commands.get(LOCK_CONTINUE_WATCHDOG_COMMAND)?.description,
		"Lock the continue watchdog.",
	);
	assert.equal(
		harness.commands.get(UNLOCK_CONTINUE_WATCHDOG_COMMAND)?.description,
		"Unlock the continue watchdog (optional reason).",
	);
	assert.equal(LOCK_COMMAND_DESCRIPTION, "Lock the continue watchdog.");
	assert.equal(
		UNLOCK_COMMAND_DESCRIPTION,
		"Unlock the continue watchdog (optional reason).",
	);
	assert.equal(harness.entryRenderers.has(HUMAN_UNLOCK_ENTRY_TYPE), true);
});

test("Examples 2-3 RED: same-state human lock/unlock are unconditional and notify exactly", async () => {
	const harness = createHarness();

	await harness.invoke(LOCK_CONTINUE_WATCHDOG_COMMAND);
	await harness.invoke(LOCK_CONTINUE_WATCHDOG_COMMAND);
	assert.equal(harness.controller.snapshot.locked, true);
	assert.deepEqual(harness.notifications, [
		"Continue watchdog locked",
		"Continue watchdog locked",
	]);

	await harness.invoke(UNLOCK_CONTINUE_WATCHDOG_COMMAND);
	await harness.invoke(UNLOCK_CONTINUE_WATCHDOG_COMMAND);
	assert.deepEqual(harness.notifications, [
		"Continue watchdog locked",
		"Continue watchdog locked",
		"Continue watchdog unlocked",
		"Continue watchdog unlocked",
	]);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.deepEqual(harness.entries, []);
});

test("Examples 2-3 RED: command transitions reset exhausted or decision-failed state and dispatch every pending effect before notification", async () => {
	const harness = createHarness();

	await harness.invoke(LOCK_CONTINUE_WATCHDOG_COMMAND);
	const exhaustedDecision = armDecision(harness.controller);
	harness.controller.recordValidContinue(exhaustedDecision);
	assert.equal(harness.controller.snapshot.exhausted, true);
	await harness.invoke(LOCK_CONTINUE_WATCHDOG_COMMAND);
	assert.equal(harness.controller.snapshot.attempt, 0);
	assert.equal(harness.controller.snapshot.exhausted, false);

	const failedDecision = armDecision(harness.controller);
	harness.controller.recordInvalidDecision(failedDecision, "first");
	harness.controller.recordInvalidDecision(failedDecision, "second");
	harness.controller.recordInvalidDecision(failedDecision, "third");
	assert.equal(harness.controller.snapshot.decisionFailed, true);
	await harness.invoke(LOCK_CONTINUE_WATCHDOG_COMMAND);
	assert.equal(harness.controller.snapshot.decisionFailed, false);

	const pendingTimer = harness.controller
		.onAllObservableIdle()
		.effects.find(
			(effect): effect is Extract<ControllerEffect, { kind: "armIdleTimer" }> =>
				effect.kind === "armIdleTimer",
		);
	assert.ok(pendingTimer);
	harness.timeline.splice(0);
	harness.effects.splice(0);
	await harness.invoke(UNLOCK_CONTINUE_WATCHDOG_COMMAND);
	assert.deepEqual(harness.effects, [
		{ kind: "cancelIdleTimer", timerId: pendingTimer.timerId },
	]);
	assert.deepEqual(harness.timeline, [
		"cancelIdleTimer",
		"notify:Continue watchdog unlocked",
	]);

	await harness.invoke(LOCK_CONTINUE_WATCHDOG_COMMAND);
	const openDecisionId = armDecision(harness.controller);
	harness.timeline.splice(0);
	harness.effects.splice(0);
	await harness.invoke(UNLOCK_CONTINUE_WATCHDOG_COMMAND);
	assert.deepEqual(harness.effects, [
		{ kind: "restoreDecisionTools", decisionId: openDecisionId },
	]);
	assert.deepEqual(harness.timeline, [
		"restoreDecisionTools",
		"notify:Continue watchdog unlocked",
	]);
});

test("Example 3 RED: blank reason appends no entry, while a trimmed reason notifies and persists TUI-only data", async () => {
	const harness = createHarness();

	await harness.invoke(UNLOCK_CONTINUE_WATCHDOG_COMMAND, " \n\t ");
	assert.deepEqual(harness.notifications, ["Continue watchdog unlocked"]);
	assert.equal(harness.entries.length, 0);

	await harness.invoke(
		UNLOCK_CONTINUE_WATCHDOG_COMMAND,
		"  Waiting for input  ",
	);
	assert.deepEqual(harness.notifications, [
		"Continue watchdog unlocked",
		"Continue watchdog unlocked: Waiting for input",
	]);
	assert.deepEqual(harness.entries, [
		{
			customType: "pi-continue-watchdog:unlock",
			data: { reason: "Waiting for input" },
		},
	]);

	const renderer = harness.entryRenderers.get(HUMAN_UNLOCK_ENTRY_TYPE);
	assert.ok(renderer);
	const rendered = renderer({ data: harness.entries[0].data }).render(10_000);
	assert.equal(
		rendered.join("\n"),
		"Continue watchdog unlocked: Waiting for input",
	);
});

test("Example 3 RED: human reason truncation is code-point safe at 500 Unicode characters", async () => {
	const harness = createHarness();
	const emoji = "🙂";
	const suppliedReason = `  ${emoji.repeat(501)}tail  `;

	await harness.invoke(UNLOCK_CONTINUE_WATCHDOG_COMMAND, suppliedReason);

	const reason = emoji.repeat(500);
	assert.equal(Array.from(harness.entries[0].data?.reason ?? "").length, 500);
	assert.equal(harness.entries[0].data?.reason, reason);
	assert.deepEqual(harness.notifications, [
		`Continue watchdog unlocked: ${reason}`,
	]);
});

test("Example 3 RED: human reason preserves internal multiline content", async () => {
	const harness = createHarness();
	const reason = "wait for a reply\nthen continue only with approval";

	await harness.invoke(UNLOCK_CONTINUE_WATCHDOG_COMMAND, ` \n${reason}\n `);

	assert.equal(harness.entries[0].data?.reason, reason);
	assert.equal(
		harness.notifications[0],
		`Continue watchdog unlocked: ${reason}`,
	);
	const renderer = createHumanUnlockEntryRenderer();
	assert.equal(
		renderer({ data: { reason } } as never, { expanded: false }, {} as never)
			?.render(10_000)
			.join("\n"),
		`Continue watchdog unlocked: ${reason}`,
	);
});

test("Slice 4 RED: stale or demoted command handlers are inert", async () => {
	const harness = createHarness();
	await harness.invoke(LOCK_CONTINUE_WATCHDOG_COMMAND);
	const before = harness.controller.snapshot;
	harness.setCurrentMain(false);

	await harness.invoke(LOCK_CONTINUE_WATCHDOG_COMMAND);
	await harness.invoke(UNLOCK_CONTINUE_WATCHDOG_COMMAND, "do not persist");

	assert.deepEqual(harness.controller.snapshot, before);
	assert.deepEqual(harness.notifications, ["Continue watchdog locked"]);
	assert.deepEqual(harness.entries, []);
	assert.deepEqual(harness.effects, []);
});
