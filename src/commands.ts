import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import type { ControllerEffect, LockDecisionController } from "./controller.js";

/** Pi command names omit the slash used for interactive invocation. */
export const LOCK_CONTINUE_WATCHDOG_COMMAND = "lock-continue-watchdog";
export const UNLOCK_CONTINUE_WATCHDOG_COMMAND = "unlock-continue-watchdog";

export const LOCK_COMMAND_DESCRIPTION = "Lock the continue watchdog.";
export const UNLOCK_COMMAND_DESCRIPTION =
	"Unlock the continue watchdog (optional reason).";

/** Persisted custom-entry type for human-visible unlock reasons. */
export const HUMAN_UNLOCK_ENTRY_TYPE = "pi-continue-watchdog:unlock";

export interface HumanUnlockEntry {
	readonly reason: string;
}

/**
 * Notification effects are handled directly at the command's TUI boundary so an
 * unlock reason can be included in the exact user-visible notification. Every
 * other controller effect remains available to runtime wiring in source order.
 */
export type CommandRuntimeEffect = Exclude<
	ControllerEffect,
	{ readonly kind: "notify" }
>;

/**
 * Runtime seam owned by later lifecycle/timer wiring. Commands do not interpret
 * non-notification controller effects, so future timer and decision-tool effects
 * cannot be lost while this slice remains independently testable.
 */
export interface MainCommandRuntime {
	readonly controller: LockDecisionController;
	readonly isCurrentMain: () => boolean;
	applyEffect(
		effect: CommandRuntimeEffect,
		ctx: ExtensionCommandContext,
	): Promise<void> | void;
}

interface StaticTextComponent {
	render(width: number): string[];
	invalidate(): void;
}

function createStaticTextComponent(text: string): StaticTextComponent {
	return {
		render(_width: number): string[] {
			return text.split("\n");
		},
		invalidate(): void {
			// This immutable component has no cached render state.
		},
	};
}

function getHumanUnlockReason(entry: HumanUnlockEntry | undefined): string {
	return typeof entry?.reason === "string" && entry.reason.length > 0
		? entry.reason
		: "";
}

/**
 * Render a persisted custom entry. Pi custom entries are TUI-only and are not
 * added to LLM context; this renderer intentionally has no model-facing path.
 */
export function createHumanUnlockEntryRenderer(): EntryRenderer<HumanUnlockEntry> {
	return (entry) => {
		const reason = getHumanUnlockReason(entry.data);
		const text = reason
			? `Continue watchdog unlocked: ${reason}`
			: "Continue watchdog unlocked";
		return createStaticTextComponent(text);
	};
}

/**
 * Normalize the optional human command reason without applying AI decision-tool
 * validation. Human input may be multiline and is deliberately truncated rather
 * than rejected at 500 Unicode code points.
 */
export function normaliseHumanUnlockReason(args: string): string | undefined {
	const trimmed = args.trim();
	if (trimmed.length === 0) return undefined;

	const characters = Array.from(trimmed);
	return characters.slice(0, 500).join("");
}

function notificationFor(
	effect: Extract<ControllerEffect, { kind: "notify" }>,
): string {
	return effect.notification === "locked"
		? "Continue watchdog locked"
		: "Continue watchdog unlocked";
}

async function applyControllerEffects(
	effects: readonly ControllerEffect[],
	runtime: MainCommandRuntime,
	ctx: ExtensionCommandContext,
	unlockReason: string | undefined,
): Promise<void> {
	for (const effect of effects) {
		if (effect.kind === "notify") {
			const notification =
				effect.notification === "unlocked" && unlockReason !== undefined
					? `Continue watchdog unlocked: ${unlockReason}`
					: notificationFor(effect);
			ctx.ui.notify(notification);
			continue;
		}

		await runtime.applyEffect(effect, ctx);
	}
}

async function handleLock(
	runtime: MainCommandRuntime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!runtime.isCurrentMain()) return;
	await applyControllerEffects(
		runtime.controller.lock().effects,
		runtime,
		ctx,
		undefined,
	);
}

async function handleUnlock(
	pi: ExtensionAPI,
	runtime: MainCommandRuntime,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!runtime.isCurrentMain()) return;

	const reason = normaliseHumanUnlockReason(args);
	await applyControllerEffects(
		runtime.controller.unlock().effects,
		runtime,
		ctx,
		reason,
	);
	if (reason !== undefined) {
		// appendEntry writes a CustomEntry, which Pi excludes from LLM context.
		pi.appendEntry<HumanUnlockEntry>(HUMAN_UNLOCK_ENTRY_TYPE, { reason });
	}
}

/** Register human main-session commands and the TUI-only unlock-reason entry. */
export function createMainCommands(
	pi: ExtensionAPI,
	runtime: MainCommandRuntime,
): void {
	pi.registerEntryRenderer<HumanUnlockEntry>(
		HUMAN_UNLOCK_ENTRY_TYPE,
		createHumanUnlockEntryRenderer(),
	);
	pi.registerCommand(LOCK_CONTINUE_WATCHDOG_COMMAND, {
		description: LOCK_COMMAND_DESCRIPTION,
		handler: async (_args, ctx) => handleLock(runtime, ctx),
	});
	pi.registerCommand(UNLOCK_CONTINUE_WATCHDOG_COMMAND, {
		description: UNLOCK_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => handleUnlock(pi, runtime, args, ctx),
	});
}
