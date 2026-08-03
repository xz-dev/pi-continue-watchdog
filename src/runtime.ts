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
import { createUserReadyEnvelope, emitSemanticHook } from "./semantic-hook.js";

export interface RuntimeControllerHolder {
	controller: LockDecisionController;
}

export interface RuntimeTimerHandle {
	unref?: () => void;
}

export interface RuntimeClock {
	setTimeout(callback: () => void, delayMs: number): RuntimeTimerHandle;
	clearTimeout(handle: RuntimeTimerHandle): void;
	now?(): number;
}

const nodeClock: RuntimeClock = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
};

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

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
	 * Drop in-flight decision finalization/timer/tools after a controller
	 * lock/unlock transition so a later settle cannot continue stale work.
	 */
	clearOperationalPendingWork(): void;
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
	const now = (): number => clock.now?.() ?? Date.now();
	const createExchangeId = options.createExchangeId ?? randomUUID;
	const loadConfig = options.loadConfig ?? loadRuntimeConfig;
	let config: ContinueWatchdogConfig = {
		...(options.initialConfig ?? BUILT_IN_CONFIG),
	};
	let attachment: HubAttachment | null = null;
	let ownedMain = false;
	let configReady = options.injectedController === true;
	let lifecycleGeneration = 0;
	/** Bumps on every agent_start so deferred settled wakes cannot outlive that run. */
	let agentActivityGeneration = 0;
	/** Bumps when a deferred settled-phase callback is scheduled; only the latest acts. */
	let settledCallbackGeneration = 0;
	let stopped = false;
	let armedTimer: ArmedTimer | null = null;
	let activeDecision: ActiveDecision | null = null;
	let pendingFinalization: PendingFinalization | null = null;
	/** Retained only for AI decision unlock until the next all-idle settle. */
	let pendingAiUnlockReason: string | null = null;
	/** At-most-once publication guard for the current aggregate-idle epoch. */
	let publishedForIdleEpoch = false;

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
	 * Invalidate runtime-local decision state after a controller transition.
	 * Does not change controller lock/cycle accounting.
	 */
	const clearOperationalPendingWork = (): void => {
		clearArmedTimer();
		restoreDecisionTools();
		activeDecision = null;
		pendingFinalization = null;
		// Human/abort unlock must not inherit a prior AI unlock publication intent.
		pendingAiUnlockReason = null;
	};

	const silentlyAbandonDecision = (): void => {
		// Unlock first so locked=false is authoritative, then clear runtime work.
		options.controllerHolder.controller.unlock();
		clearOperationalPendingWork();
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

		const deadline = Math.min(now() + delaySeconds * 1000, Number.MAX_VALUE);
		const schedule = (): void => {
			const delayMs = Math.min(
				Math.max(0, deadline - now()),
				MAX_TIMER_DELAY_MS,
			);
			const timer: ArmedTimer = {
				timerId,
				claim,
				handle: clock.setTimeout(() => {
					if (armedTimer !== timer) return;
					if (
						stopped ||
						!options.hub.isCurrentMain(timer.claim) ||
						!options.hub.snapshot.allObservableIdle ||
						options.controllerHolder.controller.snapshot.idleTimer?.id !==
							timer.timerId
					) {
						armedTimer = null;
						return;
					}
					if (now() < deadline) {
						schedule();
						return;
					}
					armedTimer = null;
					applyTransition(
						options.controllerHolder.controller.beginDecision(timer.timerId),
					);
				}, delayMs),
			};
			armedTimer = timer;
			timer.handle.unref?.();
		};

		schedule();
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
			!options.hub.snapshot.allObservableIdle ||
			pendingFinalization !== null
		) {
			return;
		}
		applyTransition(options.controllerHolder.controller.onAllObservableIdle());
	};

	/**
	 * Publish neutral `user-ready` at most once for the current all-idle epoch.
	 * Only AI decision unlock, exhausted, and decision-failed terminal states
	 * produce a signal. Ordinary unlocked idle never publishes by inference.
	 */
	const maybePublishUserReady = (): void => {
		if (
			stopped ||
			!configReady ||
			!isCurrentMain() ||
			!options.hub.snapshot.allObservableIdle ||
			pendingFinalization !== null ||
			publishedForIdleEpoch
		) {
			return;
		}

		let envelope = null as ReturnType<typeof createUserReadyEnvelope> | null;
		if (pendingAiUnlockReason !== null) {
			envelope = createUserReadyEnvelope({
				STOP_KIND: "AI_UNLOCK",
				REASON: pendingAiUnlockReason,
			});
			pendingAiUnlockReason = null;
		} else {
			const snapshot = options.controllerHolder.controller.snapshot;
			if (snapshot.locked && snapshot.exhausted) {
				envelope = createUserReadyEnvelope({ STOP_KIND: "EXHAUSTED" });
			} else if (snapshot.locked && snapshot.decisionFailed) {
				envelope = createUserReadyEnvelope({
					STOP_KIND: "DECISION_FAILED",
				});
			}
		}

		if (envelope === null) return;
		publishedForIdleEpoch = true;
		try {
			emitSemanticHook(options.pi.events, envelope);
		} catch {
			// Listener failures are contained by Pi's bus; emission itself must
			// never escape into controller/runtime control flow.
		}
	};

	const syncHubState = (): void => {
		ensureMain();
		const current = isCurrentMain();
		if (ownedMain && !current) {
			// Demotion: unlock first (preserve cycle accounting), then cleanup.
			applyTransition(options.controllerHolder.controller.unlock(), undefined, {
				suppressNotify: true,
			});
			clearOperationalPendingWork();
			publishedForIdleEpoch = false;
		}
		ownedMain = current;
		if (!current || !configReady) return;
		if (options.hub.snapshot.allObservableIdle) {
			reconcileIdle();
			maybePublishUserReady();
		} else {
			publishedForIdleEpoch = false;
			applyTransition(options.controllerHolder.controller.onObservableBusy());
		}
	};

	const unsubscribe = options.hub.subscribe(() => {
		if (!stopped) syncHubState();
	});

	/**
	 * Deliver a cached decision finalization. Returns true when a valid continue
	 * was dispatched so this settle stays intermediate and must not publish
	 * terminal `user-ready` yet.
	 */
	const deliverPending = (ctx: ExtensionContext): boolean => {
		const pending = pendingFinalization;
		if (
			pending === null ||
			activeDecision !== pending.active ||
			!options.hub.isCurrentMain(pending.active.claim)
		) {
			return false;
		}
		pendingFinalization = null;
		const { finalization, active, cycleId } = pending;

		if (finalization.outcome === "reask") {
			if (
				finalization.reaskPrompt === undefined ||
				!active.protocol.advanceAfterReask(cycleId)
			) {
				silentlyAbandonDecision();
				return false;
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
			// Re-ask is still an open decision cycle, not a terminal epoch.
			return false;
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
			return false;
		}

		if (
			(finalization.outcome !== "continue" &&
				finalization.outcome !== "unlock") ||
			finalization.toolCallId === undefined ||
			finalization.cycleId === undefined
		) {
			return false;
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
				return true;
			} catch {
				silentlyAbandonDecision();
				return false;
			}
		}

		const reason = finalization.reason ?? "";
		// Retain AI unlock publication intent until the authoritative all-idle settle.
		pendingAiUnlockReason = reason;
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
		// Controller already transitioned at agent_end; emit the reasoned TUI
		// notification once at settled delivery (not the generic unlock text).
		try {
			ctx.ui.notify(`Continue watchdog unlocked: ${reason}`);
		} catch {
			// Non-TUI hosts may reject notify; unlock state is already committed.
		}
		return false;
	};

	/**
	 * Idempotent finalization for the active current decision. Safe to call from
	 * agent_end and true-idle settle; no-ops when already finalized or inactive.
	 */
	const finalizeActiveDecision = (
		response: ReturnType<typeof normalizeAssistantDecisionResponse> | "missing",
	): void => {
		const active = activeDecision;
		if (
			active === null ||
			pendingFinalization !== null ||
			!options.hub.isCurrentMain(active.claim)
		) {
			return;
		}
		const cycleId = active.protocol.currentCycleId;
		pendingFinalization = {
			active,
			cycleId,
			finalization: active.protocol.finalizeResponse(
				cycleId,
				response === "missing"
					? { content: [{ type: "malformed" }] }
					: response,
			),
		};
	};

	const handleAgentEnd = (event: AgentEndEvent): void => {
		const assistant = terminalAssistant(event.messages);
		// Aborted terminal assistants are owned by the abort-outcome path.
		if (assistant !== undefined && isAbortedAssistant(assistant)) return;
		finalizeActiveDecision(
			assistant === undefined
				? "missing"
				: normalizeAssistantDecisionResponse(assistant),
		);
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
			// Invalidate any deferred settled wake from a previous run on this attachment.
			agentActivityGeneration += 1;
			if (isCurrentMain()) {
				const transition = options.controllerHolder.controller.ensureLocked();
				if (transition.applied) {
					// Fresh silent lock: controller first, then operational cleanup.
					clearOperationalPendingWork();
					applyTransition(transition, undefined, {
						suppressNotify: true,
					});
				}
				// Already locked: preserve cycle/decision; do not clear active work.
			}
			if (attachment !== null) options.hub.markBusy(attachment);
		});

		options.pi.on("agent_end", handleAgentEnd);

		options.pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
			// Only Pi's live idle truth may mark this attachment idle. Another
			// extension can start a nested run from an earlier settled handler.
			if (stopped || !ctx.isIdle()) return;

			if (attachment !== null) options.hub.markIdle(attachment);

			// Pi marks the session idle before emitting agent_settled. Defer the
			// wake check until every settled handler has returned so a later handler
			// can start a run without racing an eager triggerTurn from this handler.
			// Capture per-run and per-settle identity: a later agent_start or a newer
			// true-idle settle must leave this callback inert even if ctx is idle again.
			const settledClaim = getMainClaim();
			const settledLifecycleGeneration = lifecycleGeneration;
			const settledActivityGeneration = agentActivityGeneration;
			const settledToken = ++settledCallbackGeneration;
			const handle = clock.setTimeout(() => {
				// Later agent_start, a newer settle, session rebind, demotion, or nested
				// busy cancels this wake so no-result is not double-counted. Child busy
				// alone must not block delivery; publish still waits for aggregate idle.
				if (
					stopped ||
					settledLifecycleGeneration !== lifecycleGeneration ||
					settledActivityGeneration !== agentActivityGeneration ||
					settledToken !== settledCallbackGeneration ||
					settledClaim === null ||
					!options.hub.isCurrentMain(settledClaim) ||
					!ctx.isIdle()
				) {
					return;
				}

				// No agent_end / no pending finalization => one malformed no-result.
				finalizeActiveDecision("missing");
				const continued = deliverPending(ctx);
				// Explicit reconcile even when hub markIdle was a no-op edge.
				reconcileIdle();
				// Valid continue remains intermediate; wait for the next real idle epoch.
				if (!continued) maybePublishUserReady();
			}, 0);
			handle.unref?.();
		});
	};

	const shutdown = (): void => {
		if (stopped) return;
		stopped = true;
		lifecycleGeneration += 1;
		// Unlock first (preserve cycle accounting), then clear operational work.
		options.controllerHolder.controller.unlock();
		clearOperationalPendingWork();
		publishedForIdleEpoch = false;
		if (attachment !== null) options.hub.detach(attachment);
		attachment = null;
		ownedMain = false;
		unsubscribe();
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
		clearOperationalPendingWork,
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
