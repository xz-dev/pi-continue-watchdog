import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, visibleWidth } from "@earendil-works/pi-tui";

import type { ControllerEffect, LockDecisionController } from "./controller.js";
import type { HubMainClaim } from "./hub.js";
import type {
	WatchdogTriggerBlocker,
	WatchdogTriggerStatus,
} from "./runtime.js";

/** Pi command names omit the slash used for interactive invocation. */
export const LOCK_CONTINUE_WATCHDOG_COMMAND = "lock-continue-watchdog";
export const UNLOCK_CONTINUE_WATCHDOG_COMMAND = "unlock-continue-watchdog";
export const STATUS_CONTINUE_WATCHDOG_COMMAND = "status-continue-watchdog";

export const LOCK_COMMAND_DESCRIPTION = "Lock the continue watchdog.";
export const UNLOCK_COMMAND_DESCRIPTION =
	"Unlock the continue watchdog (optional reason).";
export const STATUS_COMMAND_DESCRIPTION =
	"Show why the continue watchdog is waiting.";

/** Persisted TUI-only entry for every accepted automatic continue. */
export const CONTINUE_ENTRY_TYPE = "pi-continue-watchdog:continue";
export const CONTINUE_ENTRY_TEXT = "Continue watchdog continued";

/** Persistent lifecycle event rendered as a standard colored Pi-TUI box. */
export const WATCHDOG_STATUS_ENTRY_TYPE = "pi-continue-watchdog:status";

export type WatchdogStatusKind =
	| "checking"
	| "validation-error"
	| "other-error"
	| "decision-failed";

export interface WatchdogStatusEntry {
	readonly kind: WatchdogStatusKind;
	readonly exchangeId: string;
	readonly cycleId: number;
	readonly message: string;
}

/** Persisted custom-entry type for human-visible unlock reasons. */
export const HUMAN_UNLOCK_ENTRY_TYPE = "pi-continue-watchdog:unlock";

/**
 * Shared TUI-only unlock entry. Human unlocks set only `reason`.
 * AI unlocks set both `reasonType` (matched/uppercased type) and `reason`.
 */
export interface HumanUnlockEntry {
	readonly reason: string;
	readonly reasonType?: string;
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
	readonly controller: LockDecisionController | null;
	readonly isCurrentMain: () => boolean;
	readonly getTriggerStatus: () => WatchdogTriggerStatus;
	/** Capture and revalidate the exact current ownership generation. */
	readonly getMainClaim?: () => HubMainClaim | null;
	readonly isCurrentMainClaim?: (claim: HubMainClaim) => boolean;
	/** Own the exact-claim fenced unlock-cleanup-lock sequence for fresh cycles. */
	restartLockCycle(
		ctx: ExtensionCommandContext,
		options: { readonly notifyLocked: boolean },
	): Promise<void> | void;
	/** Invalidate pending runtime work after a direct human unlock. */
	clearOperationalPendingWork(): void;
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
				: lines.map((line) => theme.fg("toolOutput", line));
		},
		invalidate(): void {
			// This immutable component has no cached render state.
		},
	};
}

function getHumanUnlockFields(entry: unknown): {
	readonly reason: string;
	readonly reasonType: string;
} {
	if (typeof entry !== "object" || entry === null) {
		return { reason: "", reasonType: "" };
	}

	try {
		const data = (entry as { readonly data?: unknown }).data;
		if (typeof data !== "object" || data === null) {
			return { reason: "", reasonType: "" };
		}

		const fields = data as {
			readonly reason?: unknown;
			readonly reasonType?: unknown;
		};
		const reason =
			typeof fields.reason === "string" && fields.reason.length > 0
				? fields.reason
				: "";
		const reasonType =
			typeof fields.reasonType === "string" && fields.reasonType.length > 0
				? fields.reasonType
				: "";
		return { reason, reasonType };
	} catch {
		return { reason: "", reasonType: "" };
	}
}

/** Format the muted TUI-only unlock history line. */
export function formatUnlockEntryText(
	reason: string,
	reasonType?: string,
): string {
	if (reasonType !== undefined && reasonType.length > 0 && reason.length > 0) {
		return `Continue watchdog unlocked · ${reasonType} · ${reason}`;
	}
	if (reason.length > 0) {
		return `Continue watchdog unlocked · ${reason}`;
	}
	return "Continue watchdog unlocked";
}

/**
 * Render a persisted custom entry. Pi custom entries are TUI-only and are not
 * added to LLM context; this renderer intentionally has no model-facing path.
 */
function getWatchdogStatusEntry(entry: unknown): WatchdogStatusEntry | null {
	if (typeof entry !== "object" || entry === null) return null;
	const data = (entry as { readonly data?: unknown }).data;
	if (typeof data !== "object" || data === null) return null;
	const value = data as Partial<WatchdogStatusEntry>;
	if (
		(value.kind !== "checking" &&
			value.kind !== "validation-error" &&
			value.kind !== "other-error" &&
			value.kind !== "decision-failed") ||
		typeof value.exchangeId !== "string" ||
		value.exchangeId.length === 0 ||
		typeof value.cycleId !== "number" ||
		!Number.isSafeInteger(value.cycleId) ||
		value.cycleId < 1 ||
		typeof value.message !== "string" ||
		value.message.length === 0
	) {
		return null;
	}
	return value as WatchdogStatusEntry;
}

export function createWatchdogStatusEntryRenderer(): EntryRenderer<WatchdogStatusEntry> {
	return (entry, _options, theme) => {
		const status = getWatchdogStatusEntry(entry);
		if (status === null) return undefined;
		const error = status.kind !== "checking";
		const title =
			status.kind === "checking"
				? `Continue watchdog · Checking ${status.cycleId}`
				: status.kind === "validation-error"
					? `Continue watchdog · Decision re-ask ${status.cycleId}`
					: status.kind === "decision-failed"
						? "Continue watchdog · Decision failed"
						: "Continue watchdog · Other error";
		const box = new Box(1, 1, (text) =>
			theme.bg(error ? "toolErrorBg" : "toolPendingBg", text),
		);
		box.addChild(
			new Text(
				`${theme.fg(error ? "warning" : "accent", title)}\n${theme.fg("toolOutput", status.message)}`,
				0,
				0,
			),
		);
		return box;
	};
}

export function createContinueEntryRenderer(): EntryRenderer<
	Record<string, never>
> {
	return (_entry, _options, theme) =>
		createStaticTextComponent(CONTINUE_ENTRY_TEXT, theme);
}

export function createHumanUnlockEntryRenderer(): EntryRenderer<HumanUnlockEntry> {
	return (entry, _options, theme) => {
		const { reason, reasonType } = getHumanUnlockFields(entry);
		const text = formatUnlockEntryText(
			reason,
			reasonType.length > 0 ? reasonType : undefined,
		);
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
	claim: HubMainClaim | null,
): Promise<void> {
	for (const effect of effects) {
		if (
			claim !== null &&
			runtime.isCurrentMainClaim !== undefined &&
			!runtime.isCurrentMainClaim(claim)
		) {
			return;
		}
		if (effect.kind === "notify") {
			// A reason is persisted as the sole visible unlock output below.
			if (effect.notification === "unlocked" && unlockReason !== undefined) {
				continue;
			}
			ctx.ui.notify(notificationFor(effect));
			continue;
		}

		await runtime.applyEffect(effect, ctx);
	}
}

function currentControllerClaim(runtime: MainCommandRuntime): {
	readonly controller: LockDecisionController;
	readonly claim: HubMainClaim | null;
} | null {
	if (!runtime.isCurrentMain()) return null;
	const controller = runtime.controller;
	if (controller === null) return null;
	const claim = runtime.getMainClaim?.() ?? null;
	if (
		claim !== null &&
		runtime.isCurrentMainClaim !== undefined &&
		!runtime.isCurrentMainClaim(claim)
	) {
		return null;
	}
	return { controller, claim };
}

const BLOCKER_TEXT: Readonly<Record<WatchdogTriggerBlocker, string>> = {
	"not-main": "not main",
	"config-loading": "config loading",
	unlocked: "unlocked",
	exhausted: "retry limit exhausted",
	"decision-failed": "decision failed",
	"domain-uncertain": "process domain uncertain",
	"observable-agent-busy": "observable agent busy",
	"local-agent-busy": "local agent busy",
	"pending-messages": "pending messages",
	"decision-open": "decision open",
	"decision-finalizing": "decision finalizing",
};

export function formatWatchdogTriggerStatus(
	status: WatchdogTriggerStatus,
): string {
	const lines = [
		"Continue watchdog status",
		`Main: ${status.main ? "yes" : "no"}`,
		`Lock: ${
			status.locked === null
				? "unavailable"
				: status.locked
					? "locked"
					: "unlocked"
		}`,
		`Attempt: ${status.attempt ?? "unavailable"}/${status.maxRetries}`,
		`Trigger: ${
			status.blocker === null
				? "eligible"
				: `blocked · ${BLOCKER_TEXT[status.blocker]}`
		}`,
		`Grace: ${
			status.gracePhase === "grace" && status.graceRemainingMs !== null
				? `waiting · ${Math.ceil(status.graceRemainingMs / 1000)}s remaining`
				: status.gracePhase
		}`,
		`Busy: observable ${status.observableBusyCount}, domain ${
			status.domainBusyParticipants ?? "unavailable"
		}, pending spawns ${status.domainPendingSpawns ?? "unavailable"}`,
	];
	return lines.join("\n");
}

async function handleLock(
	runtime: MainCommandRuntime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	await runtime.restartLockCycle(ctx, { notifyLocked: true });
}

function handleStatus(
	runtime: MainCommandRuntime,
	ctx: ExtensionCommandContext,
): void {
	ctx.ui.notify(formatWatchdogTriggerStatus(runtime.getTriggerStatus()));
}

async function handleUnlock(
	pi: ExtensionAPI,
	runtime: MainCommandRuntime,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const control = currentControllerClaim(runtime);
	if (control === null) return;
	// Unlock first (locked=false authoritative), then cleanup, effects, notify last.
	const transition = control.controller.unlock();
	if (
		control.claim !== null &&
		runtime.isCurrentMainClaim !== undefined &&
		!runtime.isCurrentMainClaim(control.claim)
	) {
		return;
	}
	runtime.clearOperationalPendingWork();

	const reason = normaliseHumanUnlockReason(args);
	await applyControllerEffects(
		transition.effects,
		runtime,
		ctx,
		reason,
		control.claim,
	);
	if (
		reason !== undefined &&
		(control.claim === null ||
			runtime.isCurrentMainClaim === undefined ||
			runtime.isCurrentMainClaim(control.claim))
	) {
		// appendEntry writes a CustomEntry, which Pi excludes from LLM context.
		pi.appendEntry<HumanUnlockEntry>(HUMAN_UNLOCK_ENTRY_TYPE, { reason });
	}
}

/** Register human main-session commands and the TUI-only unlock-reason entry. */
export function createMainCommands(
	pi: ExtensionAPI,
	runtime: MainCommandRuntime,
): void {
	pi.registerEntryRenderer<WatchdogStatusEntry>(
		WATCHDOG_STATUS_ENTRY_TYPE,
		createWatchdogStatusEntryRenderer(),
	);
	pi.registerEntryRenderer<Record<string, never>>(
		CONTINUE_ENTRY_TYPE,
		createContinueEntryRenderer(),
	);
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
	pi.registerCommand(STATUS_CONTINUE_WATCHDOG_COMMAND, {
		description: STATUS_COMMAND_DESCRIPTION,
		handler: async (_args, ctx) => handleStatus(runtime, ctx),
	});
}
