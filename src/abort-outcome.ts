import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
	ControllerEffect,
	ControllerTransition,
	LockDecisionController,
} from "./controller.js";
import type { HubMainClaim } from "./hub.js";

/**
 * Narrow main-run abort detector.
 *
 * Captures the current leaf boundary at main `agent_start`, then at
 * `agent_settled` inspects only the newly appended branch suffix through public
 * `ctx.sessionManager` APIs. Unlocks only when the terminal new assistant has
 * `stopReason === "aborted"`. Never infers abort from settle alone.
 */

export type TerminalAssistantOutcome =
	| "aborted"
	| "non-aborted"
	| "none"
	| "boundary-missing";

export type AbortUnlockRuntimeEffect = Exclude<
	ControllerEffect,
	{ readonly kind: "notify" }
>;

export interface MainAbortUnlockRuntime {
	/**
	 * Live ownership check for whether this attachment is currently main.
	 * Used only to decide whether to capture at `agent_start`.
	 */
	isCurrentMain(): boolean;
	/** Capture the current main claim (token + ownership generation). */
	getMainClaim(): HubMainClaim | null;
	/** True only when the stored claim still identifies the current main. */
	isCurrentMainClaim(claim: HubMainClaim): boolean;
	readonly controller: LockDecisionController | null;
	/**
	 * Drop pending decision finalization after the abort unlock transition so a
	 * later settle path cannot continue after abort unlock.
	 */
	clearOperationalPendingWork(): void;
	/**
	 * Atomically consume the marker suppressing a watchdog decision aborted by
	 * user input. When true, the abort unlock must be suppressed entirely (no
	 * unlock transition, no bare notification) because the user already took
	 * over the turn.
	 */
	consumeDecisionAbortSuppression?(): boolean;
	applyEffect(
		effect: AbortUnlockRuntimeEffect,
		ctx: ExtensionContext,
	): Promise<void> | void;
}

/** Structural session surface used by pure boundary helpers and tests. */
export interface BranchBoundarySession {
	getLeafId(): string | null;
	getBranch(): readonly BranchEntryView[];
}

/** Minimal branch entry shape for terminal-assistant inspection. */
export interface BranchEntryView {
	readonly id: string;
	readonly type: string;
	readonly message?: {
		readonly role?: string;
		readonly stopReason?: string;
	};
}

interface CapturedRun {
	readonly claim: HubMainClaim;
	readonly boundaryLeafId: string | null;
}

/** Capture the immutable current leaf ID as a run boundary. */
export function captureBranchBoundary(
	sessionManager: Pick<BranchBoundarySession, "getLeafId">,
): string | null {
	return sessionManager.getLeafId();
}

/**
 * Inspect only the newly appended suffix of the current branch after the
 * captured leaf boundary. The terminal new assistant is the last newly
 * appended `type: "message"` entry with `message.role === "assistant"`.
 */
export function inspectTerminalAssistantOutcome(
	sessionManager: Pick<BranchBoundarySession, "getBranch">,
	boundaryLeafId: string | null,
): TerminalAssistantOutcome {
	const branch = sessionManager.getBranch();
	let startIndex = 0;

	if (boundaryLeafId !== null) {
		const boundaryIndex = branch.findIndex(
			(entry) => entry.id === boundaryLeafId,
		);
		if (boundaryIndex === -1) return "boundary-missing";
		startIndex = boundaryIndex + 1;
	}

	let terminalStopReason: string | undefined;
	for (let i = startIndex; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message?.role === "assistant") {
			terminalStopReason = entry.message.stopReason;
		}
	}

	if (terminalStopReason === undefined) return "none";
	if (terminalStopReason === "aborted") return "aborted";
	return "non-aborted";
}

const UNLOCKED_NOTIFICATION = "Continue watchdog unlocked";

async function applyUnlockEffects(
	transition: ControllerTransition,
	runtime: MainAbortUnlockRuntime,
	ctx: ExtensionContext,
	claim: HubMainClaim,
): Promise<void> {
	for (const effect of transition.effects) {
		if (!runtime.isCurrentMainClaim(claim)) return;
		if (effect.kind === "notify") {
			// Reasonless abort unlock always uses the exact bare notification.
			if (effect.notification === "unlocked") {
				ctx.ui.notify(UNLOCKED_NOTIFICATION);
			}
			continue;
		}
		await runtime.applyEffect(effect, ctx);
	}
}

export interface MainAbortUnlockHandle {
	/** Discard any unconsumed capture (shutdown / reload / demotion cleanup). */
	clear(): void;
}

/**
 * Register the main-run abort unlock lifecycle on public `agent_start` and
 * `agent_settled` hooks. Child attachments with `isCurrentMain() === false`
 * never capture. A new main start supersedes any prior unconsumed capture.
 */
export function registerMainAbortUnlock(
	pi: ExtensionAPI,
	runtime: MainAbortUnlockRuntime,
): MainAbortUnlockHandle {
	let capture: CapturedRun | null = null;

	const clear = (): void => {
		capture = null;
	};

	pi.on("agent_start", (_event, ctx: ExtensionContext) => {
		if (!runtime.isCurrentMain()) {
			// Non-main attachments must never retain a boundary for a later
			// accidental settle after reclaim.
			clear();
			return;
		}

		const claim = runtime.getMainClaim();
		if (claim === null) {
			clear();
			return;
		}

		// A new start always supersedes any prior unconsumed capture.
		capture = {
			claim,
			boundaryLeafId: captureBranchBoundary(ctx.sessionManager),
		};
	});

	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		const active = capture;
		// Consume immediately so duplicate settle and concurrent paths are inert.
		capture = null;
		if (active === null) return;

		if (!runtime.isCurrentMainClaim(active.claim)) {
			return;
		}

		// A watchdog decision preempted by user input is not a user abort. Its
		// message_end replacement neutralizes the internal aborted assistant before
		// this settle inspection, so consume the one-shot marker before checking the
		// terminal outcome. A later unrelated abort must retain normal semantics.
		if (runtime.consumeDecisionAbortSuppression?.() === true) return;

		const outcome = inspectTerminalAssistantOutcome(
			ctx.sessionManager,
			active.boundaryLeafId,
		);
		if (outcome !== "aborted") return;

		const controller = runtime.controller;
		if (controller === null || !runtime.isCurrentMainClaim(active.claim))
			return;
		// Unlock first (locked=false authoritative), then operational cleanup,
		// restore tools, and bare notify last.
		const transition = controller.unlock();
		if (!runtime.isCurrentMainClaim(active.claim)) return;
		runtime.clearOperationalPendingWork();
		await applyUnlockEffects(transition, runtime, ctx, active.claim);
	});

	return { clear };
}
