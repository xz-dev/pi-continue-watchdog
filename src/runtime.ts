import { randomUUID } from "node:crypto";

import {
	type AgentEndEvent,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { HUMAN_UNLOCK_ENTRY_TYPE, type HumanUnlockEntry } from "./commands.js";
import { BUILT_IN_CONFIG, type ContinueWatchdogConfig } from "./config.js";
import { type LoadedConfig, loadRuntimeConfig } from "./config-loader.js";
import {
	createDecisionFoldMessage,
	createDecisionPromptMessage,
} from "./context-fold.js";
import {
	type ControllerEffect,
	type ControllerTransition,
	createLockDecisionController,
	type LockDecisionController,
} from "./controller.js";
import {
	createDecisionProtocolSession,
	type DecisionProtocolFinalization,
	type DecisionProtocolSession,
	formatDecisionFailedNotification,
	normalizeAssistantDecisionResponse,
} from "./decision-protocol.js";
import type {
	DecisionToolActivation,
	DecisionToolCall,
} from "./decision-tools.js";
import type {
	HubAttachment,
	HubAttachmentInstance,
	HubMainClaim,
	ObservableAgentHub,
} from "./hub.js";

export interface RuntimeControllerHolder {
	controller: LockDecisionController;
}

export interface RuntimeTimerHandle {
	unref?: () => void;
}

export interface RuntimeClock {
	setTimeout(callback: () => void, delayMs: number): RuntimeTimerHandle;
	clearTimeout(handle: RuntimeTimerHandle): void;
}

const nodeClock: RuntimeClock = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface ActiveDecision {
	readonly decisionId: number;
	readonly exchangeId: string;
	readonly claim: HubMainClaim;
	readonly protocol: DecisionProtocolSession;
}

interface PendingFinalization {
	readonly active: ActiveDecision;
	readonly cycleId: number;
	readonly finalization: DecisionProtocolFinalization;
}

interface ArmedTimer {
	readonly handle: RuntimeTimerHandle;
	readonly timerId: number;
	readonly claim: HubMainClaim;
}

type RuntimeContext = ExtensionCommandContext | ExtensionContext;

export interface DecisionRuntimeOptions {
	readonly pi: ExtensionAPI;
	readonly hub: ObservableAgentHub;
	readonly attachmentInstance: HubAttachmentInstance;
	readonly controllerHolder: RuntimeControllerHolder;
	readonly decisionTools: DecisionToolActivation;
	readonly injectedController?: boolean;
	readonly initialConfig?: ContinueWatchdogConfig;
	readonly clock?: RuntimeClock;
	readonly createExchangeId?: () => string;
	readonly loadConfig?: typeof loadRuntimeConfig;
	readonly agentDir?: string;
}

export interface DecisionRuntime {
	readonly controller: LockDecisionController;
	readonly config: ContinueWatchdogConfig;
	isCurrentMain(): boolean;
	getMainClaim(): HubMainClaim | null;
	isCurrentMainClaim(claim: HubMainClaim): boolean;
	/**
	 * Drop any in-flight decision finalization/timer before an external lock
	 * transition so a later settle cannot continue after human unlock/lock/abort.
	 */
	prepareForLockStateChange(): void;
	applyEffect(
		effect: Exclude<ControllerEffect, { kind: "notify" }>,
		ctx?: RuntimeContext,
	): void;
	applyTransition(
		transition: ControllerTransition,
		ctx?: RuntimeContext,
		options?: { readonly suppressNotify?: boolean },
	): void;
	reconcileIdle(): void;
	executeDecisionTool(
		call: DecisionToolCall,
	): AgentToolResult<unknown> | Promise<AgentToolResult<unknown>>;
	registerLifecycle(): void;
	shutdown(): void;
}

function inactiveDecisionResult(): AgentToolResult<{
	readonly kind: "inactive-decision-runtime";
}> {
	return {
		content: [
			{
				type: "text",
				text: "The pi-continue-watchdog decision runtime is not active.",
			},
		],
		details: { kind: "inactive-decision-runtime" },
		terminate: true,
	};
}

function terminalAssistant(messages: readonly unknown[]): unknown | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (
			typeof message === "object" &&
			message !== null &&
			(message as { readonly role?: unknown }).role === "assistant"
		) {
			return message;
		}
	}
	return undefined;
}

function isAbortedAssistant(message: unknown): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { readonly stopReason?: unknown }).stopReason === "aborted"
	);
}

/**
 * Compose one attachment's idle timer, decision protocol, and Pi lifecycle.
 * The process hub remains the only cross-attachment coordination seam.
 */
export function createDecisionRuntime(
	options: DecisionRuntimeOptions,
): DecisionRuntime {
	const clock = options.clock ?? nodeClock;
	const createExchangeId = options.createExchangeId ?? randomUUID;
	const loadConfig = options.loadConfig ?? loadRuntimeConfig;
	let config: ContinueWatchdogConfig = {
		...(options.initialConfig ?? BUILT_IN_CONFIG),
	};
	let attachment: HubAttachment | null = null;
	let ownedMain = false;
	let configReady = options.injectedController === true;
	let lifecycleGeneration = 0;
	let stopped = false;
	let armedTimer: ArmedTimer | null = null;
	let activeDecision: ActiveDecision | null = null;
	let pendingFinalization: PendingFinalization | null = null;

	const getMainClaim = (): HubMainClaim | null =>
		attachment === null ? null : options.hub.mainClaimFor(attachment);

	const isCurrentMain = (): boolean => {
		const claim = getMainClaim();
		return claim !== null && options.hub.isCurrentMain(claim);
	};

	const clearArmedTimer = (timerId?: number): void => {
		if (armedTimer === null) return;
		if (timerId !== undefined && armedTimer.timerId !== timerId) return;
		clock.clearTimeout(armedTimer.handle);
		armedTimer = null;
	};

	const restoreDecisionTools = (): void => {
		try {
			options.decisionTools.restoreDecisionTools();
		} catch {
			// Cleanup remains best effort if Pi rejects an active-tool update.
		}
	};

	/**
	 * Invalidate runtime-local decision state before an external controller
	 * transition. Does not unlock the controller itself.
	 */
	const prepareForLockStateChange = (): void => {
		clearArmedTimer();
		restoreDecisionTools();
		activeDecision = null;
		pendingFinalization = null;
	};

	const silentlyAbandonDecision = (): void => {
		const transition = options.controllerHolder.controller.unlock();
		for (const effect of transition.effects) {
			if (effect.kind === "cancelIdleTimer") clearArmedTimer(effect.timerId);
		}
		clearArmedTimer();
		restoreDecisionTools();
		activeDecision = null;
		pendingFinalization = null;
	};

	/**
	 * Explicitly reclaim main when the hub has none. Detach never auto-promotes;
	 * remaining attachments elect the deterministic preferred candidate here.
	 */
	const ensureMain = (): void => {
		if (stopped || attachment === null) return;
		if (options.hub.snapshot.main !== null) return;
		options.hub.reclaimMain(attachment);
	};

	const sendDecisionPrompt = (
		active: ActiveDecision,
		cycleId: number,
		decisionPrompt: string,
	): void => {
		options.pi.sendMessage(
			createDecisionPromptMessage({
				exchangeId: active.exchangeId,
				cycleId,
				decisionPrompt,
			}),
			{ triggerTurn: true, deliverAs: "steer" },
		);
	};

	const openDecision = (decisionId: number): void => {
		const claim = getMainClaim();
		let activated = false;
		try {
			activated =
				claim !== null &&
				options.hub.isCurrentMain(claim) &&
				options.decisionTools.activateDecisionTools();
		} catch {
			activated = false;
		}
		if (claim === null || !activated) {
			silentlyAbandonDecision();
			return;
		}

		const active: ActiveDecision = {
			decisionId,
			exchangeId: createExchangeId(),
			claim,
			protocol: createDecisionProtocolSession({
				controller: options.controllerHolder.controller,
				decisionId,
				decisionPrompt: config.decisionPrompt,
			}),
		};
		activeDecision = active;
		try {
			sendDecisionPrompt(
				active,
				active.protocol.currentCycleId,
				config.decisionPrompt,
			);
		} catch {
			silentlyAbandonDecision();
		}
	};

	const armIdleTimer = (timerId: number, delaySeconds: number): void => {
		const claim = getMainClaim();
		if (claim === null || !options.hub.isCurrentMain(claim)) return;
		clearArmedTimer();

		const timer: ArmedTimer = {
			timerId,
			claim,
			handle: clock.setTimeout(() => {
				if (armedTimer !== timer) return;
				armedTimer = null;
				if (
					stopped ||
					!options.hub.isCurrentMain(timer.claim) ||
					!options.hub.snapshot.allObservableIdle ||
					options.controllerHolder.controller.snapshot.idleTimer?.id !==
						timer.timerId
				) {
					return;
				}
				applyTransition(
					options.controllerHolder.controller.beginDecision(timer.timerId),
				);
			}, delaySeconds * 1000),
		};
		armedTimer = timer;
		timer.handle.unref?.();
	};

	const applyEffect = (
		effect: Exclude<ControllerEffect, { kind: "notify" }>,
		_ctx?: RuntimeContext,
	): void => {
		switch (effect.kind) {
			case "armIdleTimer":
				armIdleTimer(effect.timerId, effect.delaySeconds);
				break;
			case "cancelIdleTimer":
				clearArmedTimer(effect.timerId);
				break;
			case "openDecisionWindow":
				openDecision(effect.decisionId);
				break;
			case "restoreDecisionTools":
				restoreDecisionTools();
				if (activeDecision?.decisionId === effect.decisionId) {
					activeDecision = null;
					pendingFinalization = null;
				}
				break;
			case "reaskDecision":
			case "decisionFailed":
				// Final decision effects are delivered only after agent_settled.
				break;
		}
	};

	const applyTransition = (
		transition: ControllerTransition,
		ctx?: RuntimeContext,
		applyOptions?: { readonly suppressNotify?: boolean },
	): void => {
		for (const effect of transition.effects) {
			if (effect.kind === "notify") {
				if (!applyOptions?.suppressNotify && ctx !== undefined) {
					ctx.ui.notify(
						effect.notification === "locked"
							? "Continue watchdog locked"
							: "Continue watchdog unlocked",
					);
				}
				continue;
			}
			applyEffect(effect, ctx);
		}
	};

	const reconcileIdle = (): void => {
		if (
			stopped ||
			!configReady ||
			!isCurrentMain() ||
			!options.hub.snapshot.allObservableIdle
		) {
			return;
		}
		applyTransition(options.controllerHolder.controller.onAllObservableIdle());
	};

	const syncHubState = (): void => {
		ensureMain();
		const current = isCurrentMain();
		if (ownedMain && !current) {
			applyTransition(options.controllerHolder.controller.unlock(), undefined, {
				suppressNotify: true,
			});
			clearArmedTimer();
			restoreDecisionTools();
			activeDecision = null;
			pendingFinalization = null;
		}
		ownedMain = current;
		if (!current || !configReady) return;
		if (options.hub.snapshot.allObservableIdle) {
			reconcileIdle();
		} else {
			applyTransition(options.controllerHolder.controller.onObservableBusy());
		}
	};

	const unsubscribe = options.hub.subscribe(() => {
		if (!stopped) syncHubState();
	});

	const deliverPending = (ctx: ExtensionContext): void => {
		const pending = pendingFinalization;
		if (
			pending === null ||
			activeDecision !== pending.active ||
			!options.hub.isCurrentMain(pending.active.claim)
		) {
			return;
		}
		pendingFinalization = null;
		const { finalization, active, cycleId } = pending;

		if (finalization.outcome === "reask") {
			if (
				finalization.reaskPrompt === undefined ||
				!active.protocol.advanceAfterReask(cycleId)
			) {
				silentlyAbandonDecision();
				return;
			}
			try {
				sendDecisionPrompt(
					active,
					active.protocol.currentCycleId,
					finalization.reaskPrompt,
				);
			} catch {
				silentlyAbandonDecision();
			}
			return;
		}

		restoreDecisionTools();
		activeDecision = null;

		if (finalization.outcome === "decision-failed") {
			ctx.ui.notify(
				finalization.notification ??
					formatDecisionFailedNotification(
						finalization.error ?? "Invalid decision.",
					),
				"warning",
			);
			return;
		}

		if (
			(finalization.outcome !== "continue" &&
				finalization.outcome !== "unlock") ||
			finalization.toolCallId === undefined ||
			finalization.cycleId === undefined
		) {
			return;
		}

		if (finalization.outcome === "continue") {
			try {
				options.pi.sendMessage(
					createDecisionFoldMessage({
						exchangeId: active.exchangeId,
						cycleId: finalization.cycleId,
						outcome: "continue",
						toolCallId: finalization.toolCallId,
						continuePrompt: config.continuePrompt,
					}),
					{ triggerTurn: true, deliverAs: "steer" },
				);
			} catch {
				silentlyAbandonDecision();
			}
			return;
		}

		const reason = finalization.reason ?? "";
		try {
			options.pi.sendMessage(
				createDecisionFoldMessage({
					exchangeId: active.exchangeId,
					cycleId: finalization.cycleId,
					outcome: "unlock",
					toolCallId: finalization.toolCallId,
				}),
				{ triggerTurn: false, deliverAs: "steer" },
			);
			try {
				options.pi.appendEntry<HumanUnlockEntry>(HUMAN_UNLOCK_ENTRY_TYPE, {
					reason,
				});
			} catch {
				// The state is already unlocked; a TUI-only history entry is optional.
			}
		} catch {
			// The controller is already unlocked and must not be re-armed.
		}
	};

	const handleAgentEnd = (event: AgentEndEvent): void => {
		const active = activeDecision;
		if (
			active === null ||
			pendingFinalization !== null ||
			!options.hub.isCurrentMain(active.claim)
		) {
			return;
		}
		const assistant = terminalAssistant(event.messages);
		if (assistant === undefined || isAbortedAssistant(assistant)) return;
		const cycleId = active.protocol.currentCycleId;
		pendingFinalization = {
			active,
			cycleId,
			finalization: active.protocol.finalizeResponse(
				cycleId,
				normalizeAssistantDecisionResponse(assistant),
			),
		};
	};

	const registerLifecycle = (): void => {
		options.pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			const generation = ++lifecycleGeneration;
			const bound = options.hub.bind({
				instance: options.attachmentInstance,
				sessionId: ctx.sessionManager.getSessionId(),
				hasUI: ctx.hasUI,
				initialBusy: !ctx.isIdle(),
			});
			attachment = bound.attachment;
			options.decisionTools.initializeDecisionToolsInactive();

			if (!options.injectedController) {
				const loaded: LoadedConfig = await loadConfig({
					cwd: ctx.cwd,
					trusted: ctx.isProjectTrusted(),
					agentDir: options.agentDir ?? getAgentDir(),
				});
				if (
					stopped ||
					generation !== lifecycleGeneration ||
					attachment !== bound.attachment
				) {
					return;
				}
				config = { ...loaded.config };
				options.controllerHolder.controller =
					createLockDecisionController(config);
				for (const diagnostic of loaded.diagnostics) {
					try {
						ctx.ui.notify(diagnostic.message, "warning");
					} catch {
						// Configuration remains usable when a non-TUI host rejects notify.
					}
				}
			}
			configReady = true;
			syncHubState();
		});

		options.pi.on("agent_start", () => {
			if (attachment !== null) options.hub.markBusy(attachment);
		});

		options.pi.on("agent_end", handleAgentEnd);

		options.pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
			if (attachment !== null) options.hub.markIdle(attachment);
			deliverPending(ctx);
		});
	};

	const shutdown = (): void => {
		if (stopped) return;
		stopped = true;
		lifecycleGeneration += 1;
		clearArmedTimer();
		restoreDecisionTools();
		activeDecision = null;
		pendingFinalization = null;
		if (attachment !== null) options.hub.detach(attachment);
		attachment = null;
		ownedMain = false;
		unsubscribe();
		options.controllerHolder.controller.unlock();
	};

	return {
		get controller(): LockDecisionController {
			return options.controllerHolder.controller;
		},
		get config(): ContinueWatchdogConfig {
			return { ...config };
		},
		isCurrentMain,
		getMainClaim,
		isCurrentMainClaim: (claim) => options.hub.isCurrentMain(claim),
		prepareForLockStateChange,
		applyEffect,
		applyTransition,
		reconcileIdle,
		executeDecisionTool(call) {
			const active = activeDecision;
			if (
				active === null ||
				!options.hub.isCurrentMain(active.claim) ||
				!options.decisionTools.isActive()
			) {
				return inactiveDecisionResult();
			}
			return active.protocol.onDecisionToolCall(call);
		},
		registerLifecycle,
		shutdown,
	};
}
