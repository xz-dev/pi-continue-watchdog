import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

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
	/**
	 * Invalidate any pending decision finalization/timer before lock or unlock so
	 * a later settle cannot continue after the human command.
	 */
	prepareForLockStateChange(): void;
	applyEffect(
		effect: CommandRuntimeEffect,
		ctx: ExtensionCommandContext,
	): Promise<void> | void;
	/** Arm from the fresh lock state when the main attachment is already idle. */
	reconcileIdle?(): void;
}

interface StaticTextComponent {
	render(width: number): string[];
	invalidate(): void;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

function sanitizeTuiText(text: string): string {
	return Array.from(text, (character) =>
		character !== "\n" && /[\p{Cc}\p{Cs}]/u.test(character) ? "?" : character,
	).join("");
}

/**
 * Wrap terminal-safe text on grapheme boundaries using Pi's public terminal
 * width measurement. A grapheme wider than the current terminal falls back to
 * `?`, because it cannot be split without corrupting the user-provided reason.
 */
export function wrapTuiText(text: string, width: number): string[] {
	const maxWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
	const lines: string[] = [];

	for (const sourceLine of sanitizeTuiText(text).split("\n")) {
		let line = "";
		let lineWidth = 0;

		for (const { segment } of graphemeSegmenter.segment(sourceLine)) {
			const grapheme = visibleWidth(segment) <= maxWidth ? segment : "?";
			const graphemeWidth = visibleWidth(grapheme);
			if (lineWidth > 0 && lineWidth + graphemeWidth > maxWidth) {
				lines.push(line);
				line = "";
				lineWidth = 0;
			}
			line += grapheme;
			lineWidth += graphemeWidth;
		}

		lines.push(line);
	}

	return lines;
}

function createStaticTextComponent(
	text: string,
	theme?: Theme,
): StaticTextComponent {
	return {
		render(width: number): string[] {
			const lines = wrapTuiText(text, width);
			return theme === undefined
				? lines
				: lines.map((line) => theme.fg("success", line));
		},
		invalidate(): void {
			// This immutable component has no cached render state.
		},
	};
}

function getHumanUnlockReason(entry: unknown): string {
	if (typeof entry !== "object" || entry === null) return "";

	try {
		const data = (entry as { readonly data?: unknown }).data;
		if (typeof data !== "object" || data === null) return "";

		const reason = (data as { readonly reason?: unknown }).reason;
		return typeof reason === "string" && reason.length > 0 ? reason : "";
	} catch {
		return "";
	}
}

/**
 * Render a persisted custom entry. Pi custom entries are TUI-only and are not
 * added to LLM context; this renderer intentionally has no model-facing path.
 */
export function createHumanUnlockEntryRenderer(): EntryRenderer<HumanUnlockEntry> {
	return (entry, _options, theme) => {
		const reason = getHumanUnlockReason(entry);
		const text = reason
			? `✓ Watchdog unlocked · ${reason}`
			: "✓ Watchdog unlocked";
		return createStaticTextComponent(text, theme);
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
	runtime.prepareForLockStateChange();
	await applyControllerEffects(
		runtime.controller.lock().effects,
		runtime,
		ctx,
		undefined,
	);
	runtime.reconcileIdle?.();
}

async function handleUnlock(
	pi: ExtensionAPI,
	runtime: MainCommandRuntime,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!runtime.isCurrentMain()) return;
	runtime.prepareForLockStateChange();

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
