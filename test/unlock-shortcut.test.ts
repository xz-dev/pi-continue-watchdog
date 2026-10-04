import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BUILT_IN_CONFIG, type ContinueWatchdogConfig } from "../src/config.js";
import { createLockDecisionController } from "../src/controller.js";
import { createContinueWatchdogExtension } from "../src/extension.js";
import { createObservableAgentHub } from "../src/hub.js";

type LifecycleHandler = (
	event: unknown,
	ctx: ExtensionContext,
) => Promise<void> | void;

type ShortcutHandler = (ctx: ExtensionCommandContext) => Promise<void> | void;

interface ShortcutHarness {
	readonly shortcuts: Map<string, ShortcutHandler>;
	readonly commands: Map<string, ShortcutHandler>;
	readonly notifications: string[];
	readonly handlers: Map<string, LifecycleHandler[]>;
	readonly controller: ReturnType<typeof createLockDecisionController>;
	readonly ctx: ExtensionContext;
	readonly aborts: () => number;
	readonly fire: (name: string) => Promise<void>;
}

function createHarness(
	unlockShortcut: string | false,
	options?: { readonly locked?: boolean },
): ShortcutHarness {
	const hub = createObservableAgentHub();
	const handlers = new Map<string, LifecycleHandler[]>();
	const shortcuts = new Map<string, ShortcutHandler>();
	const commands = new Map<string, ShortcutHandler>();
	const notifications: string[] = [];
	let aborts = 0;
	const config: ContinueWatchdogConfig = {
		...BUILT_IN_CONFIG,
		unlockShortcut,
	};
	const controller = createLockDecisionController(config);
	if (options?.locked) controller.lock();

	const pi = {
		on(name: string, handler: LifecycleHandler): void {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(): void {},
		getActiveTools(): string[] {
			return ["bash", "read"];
		},
		setActiveTools(): void {},
		registerEntryRenderer(): void {},
		registerMessageRenderer(): void {},
		registerCommand(
			name: string,
			{
				handler,
			}: {
				readonly handler: (
					args: string,
					ctx: ExtensionCommandContext,
				) => Promise<void> | void;
			},
		): void {
			commands.set(name, (ctx) => handler("", ctx));
		},
		registerShortcut(
			key: string,
			{ handler }: { readonly handler: ShortcutHandler },
		): void {
			shortcuts.set(key, handler);
		},
		appendEntry(): void {},
	} as unknown as ExtensionAPI;

	createContinueWatchdogExtension({ hub, controller, config })(pi);

	const ctx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "main",
			getLeafId: () => "leaf",
			getBranch: () => [],
		},
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		abort(): void {
			aborts += 1;
		},
	} as unknown as ExtensionContext;

	const fire = async (name: string): Promise<void> => {
		for (const handler of handlers.get(name) ?? []) {
			await handler({ type: name }, ctx);
		}
	};

	return {
		shortcuts,
		commands,
		notifications,
		handlers,
		controller,
		ctx,
		aborts: () => aborts,
		fire,
	};
}

async function startSession(harness: ShortcutHarness): Promise<void> {
	await harness.fire("session_start");
}

test("unlock shortcut registers from the effective config with a discoverable description", async () => {
	const harness = createHarness("alt+u", { locked: true });
	await startSession(harness);
	assert.deepEqual([...harness.shortcuts.keys()], ["alt+u"]);
});

test("a custom configured key is the key that gets registered", async () => {
	const harness = createHarness("ctrl+k", { locked: true });
	await startSession(harness);
	assert.deepEqual([...harness.shortcuts.keys()], ["ctrl+k"]);
});

test("unlockShortcut: false disables registration while commands stay available", async () => {
	const harness = createHarness(false, { locked: true });
	await startSession(harness);
	assert.equal(harness.shortcuts.size, 0);
});

test("shortcut while locked performs the identical unlock as the command without a reason", async () => {
	const harness = createHarness("alt+u", { locked: true });
	await startSession(harness);
	assert.equal(harness.controller.snapshot.locked, true);

	const handler = harness.shortcuts.get("alt+u");
	assert.ok(handler);
	await handler(harness.ctx as unknown as ExtensionCommandContext);
	assert.equal(harness.controller.snapshot.locked, false);
	// Same unconditional notification the slash command produces.
	assert.deepEqual(harness.notifications, ["Continue watchdog unlocked"]);
});

test("shortcut while unlocked matches command behavior: unconditional unlock notification", async () => {
	const harness = createHarness("alt+u", { locked: false });
	await startSession(harness);
	const handler = harness.shortcuts.get("alt+u");
	assert.ok(handler);
	await handler(harness.ctx as unknown as ExtensionCommandContext);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.deepEqual(harness.notifications, ["Continue watchdog unlocked"]);
});

test("shortcut and slash command share ownership-aware cancellation while ordinary runs stay alive", async () => {
	for (const entrypoint of ["shortcut", "command"] as const) {
		const harness = createHarness("alt+u", { locked: true });
		await startSession(harness);
		const opened = harness.controller.beginDecision(0);
		assert.equal(opened.snapshot.decisionOpen, true);
		const invoke =
			entrypoint === "shortcut"
				? harness.shortcuts.get("alt+u")
				: harness.commands.get("unlock-continue-watchdog");
		assert.ok(invoke);
		await invoke(harness.ctx as unknown as ExtensionCommandContext);
		assert.equal(harness.controller.snapshot.locked, false);
		assert.equal(harness.aborts(), 0);
		assert.deepEqual(harness.notifications, ["Continue watchdog unlocked"]);
	}
});

test("shortcut during a pending decision clears the decision like the command", async () => {
	const harness = createHarness("alt+u", { locked: true });
	await startSession(harness);
	const opened = harness.controller.beginDecision(0);
	assert.equal(opened.snapshot.decisionOpen, true);

	const handler = harness.shortcuts.get("alt+u");
	assert.ok(handler);
	await handler(harness.ctx as unknown as ExtensionCommandContext);
	assert.equal(harness.controller.snapshot.locked, false);
	assert.equal(harness.controller.snapshot.decisionOpen, false);
	assert.deepEqual(harness.notifications, ["Continue watchdog unlocked"]);
});
