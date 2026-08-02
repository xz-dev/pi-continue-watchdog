import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { registerMainAbortUnlock } from "./abort-outcome.js";
import { registerMainUserAutoLock } from "./auto-lock.js";
import { createMainCommands } from "./commands.js";
import { BUILT_IN_CONFIG } from "./config.js";
import { registerDecisionContextFolding } from "./context-fold.js";
import {
	type ControllerEffect,
	createLockDecisionController,
	type LockDecisionController,
} from "./controller.js";
import {
	createDecisionToolActivation,
	type DecisionToolActivation,
} from "./decision-tools.js";
import {
	createHubAttachmentInstance,
	getProcessObservableAgentHub,
	type HubAttachment,
	type HubMainClaim,
	type ObservableAgentHub,
} from "./hub.js";

/** Dependencies supplied only by focused lifecycle tests. */
export interface ContinueWatchdogExtensionOptions {
	readonly hub?: ObservableAgentHub;
	/** Optional lifecycle-test controller; normal installs create a fresh runtime controller. */
	readonly controller?: LockDecisionController;
}

/**
 * Register one attachment's public Pi lifecycle wiring.
 *
 * Lock state is intentionally per extension attachment. The process hub supplies
 * the separately-owned, generation-validated main claim that guards its use.
 */
export function createContinueWatchdogExtension(
	options: ContinueWatchdogExtensionOptions = {},
): (pi: ExtensionAPI) => void {
	const hub = options.hub ?? getProcessObservableAgentHub();
	const attachmentInstance = createHubAttachmentInstance();
	const controller =
		options.controller ?? createLockDecisionController(BUILT_IN_CONFIG);
	let attachment: HubAttachment | null = null;
	let decisionTools: DecisionToolActivation;

	const isCurrentMain = (): boolean => {
		if (attachment === null) return false;
		const currentClaim: HubMainClaim | null = hub.mainClaimFor(attachment);
		return currentClaim !== null && hub.isCurrentMain(currentClaim);
	};

	const applyEffect = (
		effect: Exclude<ControllerEffect, { readonly kind: "notify" }>,
		_ctx?: ExtensionCommandContext | ExtensionContext,
	): void => {
		// Timer and decision runtime orchestration land in Slice 10. Preserve the
		// active-tool cleanup effect now so a later decision window cannot strand
		// its pair merely because a main user message or abort unlock reset it.
		if (effect.kind === "restoreDecisionTools") {
			decisionTools.restoreDecisionTools();
		}
	};

	const decisionResult = (): AgentToolResult<{
		readonly kind: "inactive-decision-runtime";
	}> => ({
		content: [
			{
				type: "text",
				text: "The pi-continue-watchdog decision runtime is not active.",
			},
		],
		details: { kind: "inactive-decision-runtime" },
		terminate: true,
	});

	return (pi: ExtensionAPI): void => {
		decisionTools = createDecisionToolActivation(pi, {
			isCurrentMain,
			getContinuePrompt: () => BUILT_IN_CONFIG.continuePrompt,
			executeContinue: async () => decisionResult(),
			executeUnlock: async () => decisionResult(),
		});
		createMainCommands(pi, {
			controller,
			isCurrentMain,
			applyEffect,
		});
		registerDecisionContextFolding(pi);

		registerMainUserAutoLock(pi, {
			isCurrentMain,
			onMainUserMessageStart(): void {
				const transition = controller.onMainUserMessageStart();
				for (const effect of transition.effects) {
					// Automatic user work deliberately does not reuse the human
					// /lock command notification. It still consumes every runtime
					// effect that this slice has an implementation for.
					if (effect.kind !== "notify") applyEffect(effect);
				}
			},
		});

		const abortUnlock = registerMainAbortUnlock(pi, {
			isCurrentMain,
			getMainClaim(): HubMainClaim | null {
				if (attachment === null) return null;
				return hub.mainClaimFor(attachment);
			},
			isCurrentMainClaim(claim: HubMainClaim): boolean {
				return hub.isCurrentMain(claim);
			},
			controller,
			applyEffect,
		});

		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			const bound = hub.bind({
				instance: attachmentInstance,
				sessionId: ctx.sessionManager.getSessionId(),
				hasUI: ctx.hasUI,
				initialBusy: !ctx.isIdle(),
			});
			attachment = bound.attachment;

			// Registered definitions are active by default in Pi. Remove them for
			// every attached session before its next model request; only a later
			// decision window may make them model-visible.
			decisionTools.initializeDecisionToolsInactive();
		});

		pi.on("session_shutdown", () => {
			abortUnlock.clear();
			decisionTools.restoreDecisionTools();
			if (attachment !== null) hub.detach(attachment);
			attachment = null;
		});
	};
}

export default function registerContinueWatchdogExtension(
	pi: ExtensionAPI,
): void {
	// Pi may invoke one cached module export for multiple same-process sessions.
	// Allocate all attachment/controller state per ExtensionAPI activation.
	createContinueWatchdogExtension()(pi);
}
