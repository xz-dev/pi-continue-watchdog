import { randomUUID } from "node:crypto";

import {
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	CONTINUE_ENTRY_TYPE,
	HUMAN_UNLOCK_ENTRY_TYPE,
	type HumanUnlockEntry,
	WATCHDOG_STATUS_ENTRY_TYPE,
	type WatchdogStatusEntry,
} from "./commands.js";
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
	buildDecisionPrompt,
	createDecisionProtocolSession,
	DECISION_TOOL_BLOCK_REASON,
	type DecisionProtocolPlan,
	type DecisionProtocolSession,
	type DecisionResponse,
	formatDecisionFailedNotification,
	normalizeAssistantDecisionResponse,
	validateDecisionResponse,
} from "./decision-protocol.js";
import type { FatalExitAdapter } from "./fatal-exit.js";
import type {
	HubAttachment,
	HubAttachmentInstance,
	HubMainClaim,
	ObservableAgentHub,
} from "./hub.js";
import type { ProcessDomainCoordinator } from "./process-domain.js";
import { createUserReadyEnvelope, emitSemanticHook } from "./semantic-hook.js";

export interface RuntimeControllerHolder {
	controller: LockDecisionController | null;
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
const WATCHDOG_STATUS_WIDGET_KEY = "pi-continue-watchdog:status";

/** Context-excluded persisted metadata for one model decision response. */
export const DECISION_AUDIT_ENTRY_TYPE = "pi-continue-watchdog:decision-audit";

export type DecisionAuditEntry =
	| {
			readonly version: 1;
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "continue";
	  }
	| {
			readonly version: 1;
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "unlock";
			readonly reasonType: string;
			readonly reason: string;
	  }
	| {
			readonly version: 1;
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "invalid";
			readonly error: string;
	  };

interface ActiveDecision {
	readonly decisionId: number;
	readonly exchangeId: string;
	readonly claim: HubMainClaim;
	readonly protocol: DecisionProtocolSession;
	readonly domainFence: import("pi-process-domain").DomainFence;
	invalidated: boolean;
	/** True while a public fire-and-forget dispatch awaits matching lifecycle. */
	dispatchPending: boolean;
	/** True only after Pi emits this decision's correlated custom message_start. */
	submitted: boolean;
}

interface PendingFinalization {
	readonly active: ActiveDecision;
	readonly cycleId: number;
	readonly plan: DecisionProtocolPlan;
}

interface ArmedTimer {
	readonly handle: RuntimeTimerHandle;
	readonly timerId: number;
	readonly claim: HubMainClaim;
	readonly domainFence: import("pi-process-domain").DomainFence;
}

type RuntimeContext = ExtensionCommandContext | ExtensionContext;

export interface DecisionRuntimeOptions {
	readonly pi: ExtensionAPI;
	readonly hub: ObservableAgentHub;
	readonly processDomain?: ProcessDomainCoordinator;
	readonly fatalExit?: FatalExitAdapter;
	readonly attachmentInstance: HubAttachmentInstance;
	readonly controllerHolder: RuntimeControllerHolder;
	readonly injectedController?: boolean;
	readonly initialConfig?: ContinueWatchdogConfig;
	readonly clock?: RuntimeClock;
	readonly createExchangeId?: () => string;
	readonly loadConfig?: typeof loadRuntimeConfig;
	readonly agentDir?: string;
}

export interface DecisionRuntime {
	readonly controller: LockDecisionController | null;
	readonly config: ContinueWatchdogConfig;
	isCurrentMain(): boolean;
	getMainClaim(): HubMainClaim | null;
	isCurrentMainClaim(claim: HubMainClaim): boolean;
	/**
	 * Drop in-flight decision finalization/timer work after a controller
	 * lock/unlock transition so a later settle cannot continue stale work.
	 */
	clearOperationalPendingWork(): void;
	/**
	 * Atomically consume the marker suppressing a watchdog decision aborted by
	 * user input. Returns true once; afterwards a later unrelated abort is never
	 * suppressed. Used by the abort-outcome path to avoid emitting an unlock.
	 */
	consumeDecisionAbortSuppression(): boolean;
	/**
	 * Start a fresh cycle through the full silent unlock-cleanup-lock sequence.
	 * The exact current-main claim is fenced across every re-entrant effect.
	 */
	restartLockCycle(
		ctx?: RuntimeContext,
		options?: { readonly notifyLocked?: boolean },
	): void;
	applyEffect(
		effect: Exclude<ControllerEffect, { kind: "notify" }>,
		ctx?: RuntimeContext,
	): void;
	applyTransition(
		transition: ControllerTransition,
		ctx?: RuntimeContext,
		options?: {
			readonly suppressNotify?: boolean;
			readonly claim?: HubMainClaim;
		},
	): void;
	reconcileIdle(): void;
	handleMessageStart(event: { readonly message: unknown }): Promise<void>;
	registerLifecycle(): void;
	shutdown(): Promise<void>;
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

function hasAssistantStopReason(message: unknown, stopReason: string): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { readonly stopReason?: unknown }).stopReason === stopReason
	);
}

function isAbortedAssistant(message: unknown): boolean {
	return hasAssistantStopReason(message, "aborted");
}

function isErroredAssistant(message: unknown): boolean {
	return hasAssistantStopReason(message, "error");
}

function originalErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return typeof error === "string" && error.trim().length > 0
		? error
		: "Unknown error";
}

function assistantErrorMessage(message: unknown): string {
	if (typeof message !== "object" || message === null) return "Unknown error";
	return originalErrorMessage(
		(message as { readonly errorMessage?: unknown }).errorMessage,
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
	const injectedController = options.injectedController
		? options.controllerHolder.controller
		: null;
	let config: ContinueWatchdogConfig = {
		...(options.initialConfig ?? BUILT_IN_CONFIG),
	};
	let attachment: HubAttachment | null = null;
	let domainAttached = false;
	let domainReady = options.processDomain === undefined;
	let domainFatal = false;
	/** The current busy run was confirmed as an internal watchdog decision. */
	let domainInternalDecision = false;
	let ownedClaim: HubMainClaim | null = null;
	let sessionContext: ExtensionContext | null = null;
	let configLoad: Promise<void> | null = null;
	let configReady = options.injectedController === true;
	let lifecycleGeneration = 0;
	/** Bumps on every agent_start so deferred settled wakes cannot outlive that run. */
	let agentActivityGeneration = 0;
	/** Bumps on real user input so an in-flight compaction gate cannot overtake it. */
	let userInputGeneration = 0;
	/** Bumps when a deferred settled-phase callback is scheduled; only the latest acts. */
	let settledCallbackGeneration = 0;
	let stopped = false;
	let armedTimer: ArmedTimer | null = null;
	let activeDecision: ActiveDecision | null = null;
	/** Suppress the aborted assistant of a watchdog decision preempted by user input. */
	let suppressDecisionAbort = false;
	let capturedDecisionResponse: {
		readonly active: ActiveDecision;
		readonly cycleId: number;
		readonly response: DecisionResponse;
	} | null = null;
	let pendingFinalization: PendingFinalization | null = null;
	/** Retained only for AI decision unlock until the next all-idle settle. */
	let pendingAiUnlock: {
		readonly reasonType: string;
		readonly reason: string;
	} | null = null;
	/** At-most-once publication guard for the current aggregate-idle epoch. */
	let publishedForIdleEpoch = false;
	let activeStatus: WatchdogStatusEntry | null = null;
	let statusTui: { requestRender(): void } | null = null;
	let statusWidgetRegistered = false;

	const isRootProcess = (): boolean =>
		domainReady &&
		!domainFatal &&
		(options.processDomain?.isRootProcess ?? true);

	const getMainClaim = (): HubMainClaim | null =>
		!isRootProcess() || attachment === null
			? null
			: options.hub.mainClaimFor(attachment);

	const owns = (claim: HubMainClaim): boolean =>
		!stopped && isRootProcess() && options.hub.isCurrentMain(claim);

	const domainIdle = (): boolean => {
		if (options.processDomain === undefined) {
			return options.hub.snapshot.allObservableIdle;
		}
		const snapshot = options.processDomain.snapshot;
		return snapshot.certain && snapshot.allIdle;
	};

	const isCurrentMain = (): boolean => {
		const claim = getMainClaim();
		return claim !== null && owns(claim);
	};

	const currentController = (
		claim?: HubMainClaim | null,
	): LockDecisionController | null => {
		const controller = options.controllerHolder.controller;
		if (controller === null) return null;
		const effectiveClaim = claim ?? getMainClaim();
		return effectiveClaim !== null && options.hub.isCurrentMain(effectiveClaim)
			? controller
			: null;
	};

	const clearArmedTimer = (timerId?: number): void => {
		if (armedTimer === null) return;
		if (timerId !== undefined && armedTimer.timerId !== timerId) return;
		clock.clearTimeout(armedTimer.handle);
		armedTimer = null;
	};

	const renderLiveStatus = (
		width: number,
		theme: ExtensionContext["ui"]["theme"],
	): string[] => {
		const status = activeStatus;
		if (status === null) return [];
		const safeWidth = Math.max(1, Math.floor(width));
		const styleLine = (content: string): string => {
			const clipped = visibleWidth(content) <= safeWidth ? content : "…";
			const padding = " ".repeat(
				Math.max(0, safeWidth - visibleWidth(clipped)),
			);
			return theme.bg("toolPendingBg", clipped + padding);
		};
		const detail = `Attempt ${status.cycleId} · waiting for model`;
		return [
			styleLine(""),
			styleLine(` ${theme.fg("accent", "Continue watchdog checking")} `),
			styleLine(` ${theme.fg("toolOutput", detail)} `),
			styleLine(""),
		];
	};

	const showLiveStatus = (status: WatchdogStatusEntry): string | null => {
		activeStatus = status;
		const ctx = sessionContext;
		if (ctx === null || !ctx.hasUI || typeof ctx.ui.setWidget !== "function") {
			return null;
		}
		if (!statusWidgetRegistered) {
			try {
				ctx.ui.setWidget(
					WATCHDOG_STATUS_WIDGET_KEY,
					(tui, theme) => {
						statusTui = tui;
						return {
							render: (width: number) => renderLiveStatus(width, theme),
							invalidate() {},
							dispose() {
								statusTui = null;
								statusWidgetRegistered = false;
							},
						};
					},
					{ placement: "belowEditor" },
				);
				statusWidgetRegistered = true;
			} catch (error) {
				statusWidgetRegistered = false;
				statusTui = null;
				return originalErrorMessage(error);
			}
			return null;
		}
		statusTui?.requestRender();
		return null;
	};

	const clearLiveStatus = (): void => {
		activeStatus = null;
		const ctx = sessionContext;
		if (
			ctx !== null &&
			statusWidgetRegistered &&
			typeof ctx.ui.setWidget === "function"
		) {
			try {
				ctx.ui.setWidget(WATCHDOG_STATUS_WIDGET_KEY, undefined);
			} catch {
				// A stale host may reject cleanup during shutdown or demotion.
			}
		}
		statusWidgetRegistered = false;
		statusTui = null;
	};

	const appendStatus = (status: WatchdogStatusEntry): boolean => {
		try {
			options.pi.appendEntry<WatchdogStatusEntry>(
				WATCHDOG_STATUS_ENTRY_TYPE,
				status,
			);
			return true;
		} catch {
			return false;
		}
	};

	const checkingStatus = (active: ActiveDecision): WatchdogStatusEntry => ({
		kind: "checking",
		exchangeId: active.exchangeId,
		cycleId: active.protocol.currentCycleId,
		message: "Continue watchdog checking",
	});

	/**
	 * Invalidate runtime-local decision state after a controller transition.
	 * Does not change controller lock/cycle accounting.
	 */
	const clearOperationalPendingWork = (): void => {
		clearArmedTimer();
		activeDecision = null;
		domainInternalDecision = false;
		suppressDecisionAbort = false;
		capturedDecisionResponse = null;
		pendingFinalization = null;
		clearLiveStatus();
		// Human/abort unlock must not inherit a prior AI unlock publication intent.
		pendingAiUnlock = null;
	};
	/** Pi's same-runtime authoritative idle truth. */
	const localIdle = (): boolean => sessionContext?.isIdle() === true;
	/** Public queued-message signal present in every supported upstream Pi. */
	const hasPendingMessages = (): boolean => {
		const pending = sessionContext?.hasPendingMessages;
		return typeof pending === "function" && pending.call(sessionContext);
	};

	const allIdleForClaim = (claim: HubMainClaim): boolean =>
		owns(claim) &&
		options.hub.snapshot.allObservableIdle &&
		domainIdle() &&
		localIdle() &&
		!hasPendingMessages();

	/**
	 * Defer an open decision because local Pi became busy (user input took over or
	 * an unrelated run started). Stay locked, close the decision window, consume
	 * no continue/invalid retry, append no error card, and recover after the next
	 * genuine agent_settled.
	 */
	const deferDecisionOnBusy = (active: ActiveDecision): void => {
		if (active.invalidated) return;
		active.invalidated = true;
		const controller = options.controllerHolder.controller;
		capturedDecisionResponse = null;
		pendingFinalization = null;
		clearLiveStatus();
		if (controller !== null) {
			applyTransition(
				controller.invalidateDecision(active.decisionId),
				undefined,
				{
					claim: active.claim,
				},
			);
		}
		activeDecision = null;
		// suppressDecisionAbort is owned by the user-takeover input hook and is
		// intentionally not cleared here.
	};

	/**
	 * Atomically consume the suppression marker for the watchdog decision that user
	 * input preempted. True only once; afterwards the marker is clear so a later
	 * unrelated user abort is never suppressed.
	 */
	const consumeDecisionAbortSuppression = (): boolean => {
		if (!suppressDecisionAbort) return false;
		suppressDecisionAbort = false;
		return true;
	};

	const silentlyAbandonDecision = (): void => {
		// Unlock first so locked=false is authoritative, then clear runtime work.
		options.controllerHolder.controller?.unlock();
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
		sendOptions?: { readonly deferOnBusy?: boolean },
	): boolean => {
		if (active.invalidated) return false;
		if (!allIdleForClaim(active.claim)) {
			// A transactional re-ask caller rolls accounting back before deferring.
			if (sendOptions?.deferOnBusy !== false) deferDecisionOnBusy(active);
			return false;
		}

		active.dispatchPending = true;
		active.submitted = false;
		try {
			options.pi.sendMessage(
				createDecisionPromptMessage({
					exchangeId: active.exchangeId,
					cycleId,
					decisionPrompt,
				}),
				{ triggerTurn: true, deliverAs: "steer" },
			);
			return true;
		} catch (error) {
			active.dispatchPending = false;
			if (!allIdleForClaim(active.claim)) {
				// Final TOCTOU: Pi or an observable child became busy. Silent defer.
				if (sendOptions?.deferOnBusy !== false) deferDecisionOnBusy(active);
				return false;
			}
			// Genuine dispatch failure while still idle: fail closed with evidence.
			throw error;
		}
	};

	const openDecision = (decisionId: number): void => {
		// Exact claim fence for this open attempt — not a live re-lookup later.
		const claim = getMainClaim();
		const controller = currentController(claim);
		if (claim === null || controller === null || !owns(claim)) {
			silentlyAbandonDecision();
			return;
		}
		const stillOwns = (): boolean => owns(claim);

		// Keep ordinary active tools and system prompt unchanged. Decision answers
		// are final XML text, not temporary decision tools.
		const decisionPrompt = buildDecisionPrompt(
			config.decisionPrompt,
			config.reasonTypes,
		);
		const domainFence = options.processDomain?.snapshot.fence ?? {
			brokerEpoch: "local",
			activityGeneration: BigInt(options.hub.snapshot.revision),
		};
		const active: ActiveDecision = {
			decisionId,
			exchangeId: createExchangeId(),
			claim,
			domainFence,
			invalidated: false,
			dispatchPending: false,
			submitted: false,
			protocol: createDecisionProtocolSession({
				controller,
				decisionId,
				decisionPrompt,
				reasonTypes: config.reasonTypes,
			}),
		};
		activeDecision = active;
		try {
			if (!stillOwns()) {
				silentlyAbandonDecision();
				return;
			}
			if (!allIdleForClaim(claim)) {
				deferDecisionOnBusy(active);
				return;
			}
			const status = checkingStatus(active);
			const widgetError = showLiveStatus(status);
			if (widgetError !== null) {
				appendStatus({
					kind: "other-error",
					exchangeId: active.exchangeId,
					cycleId: active.protocol.currentCycleId,
					message: widgetError,
				});
				silentlyAbandonDecision();
				return;
			}
			if (!allIdleForClaim(claim)) {
				deferDecisionOnBusy(active);
				return;
			}
			if (options.processDomain !== undefined) {
				const processDomain = options.processDomain;
				void (async () => {
					try {
						const confirmed = await processDomain.confirm(active.domainFence);
						if (
							!confirmed ||
							active.invalidated ||
							activeDecision !== active ||
							!allIdleForClaim(active.claim)
						) {
							invalidateActiveDecision();
							return;
						}
						sendDecisionPrompt(
							active,
							active.protocol.currentCycleId,
							decisionPrompt,
						);
					} catch (error) {
						if (stillOwns() && localIdle()) {
							appendStatus({
								kind: "other-error",
								exchangeId: active.exchangeId,
								cycleId: active.protocol.currentCycleId,
								message: originalErrorMessage(error),
							});
						}
						silentlyAbandonDecision();
					}
				})();
				return;
			}
			sendDecisionPrompt(
				active,
				active.protocol.currentCycleId,
				decisionPrompt,
			);
			// A demotion that lands during/after send must not leave a live exchange.
			if (!stillOwns()) {
				silentlyAbandonDecision();
			}
		} catch (error) {
			if (stillOwns() && localIdle()) {
				appendStatus({
					kind: "other-error",
					exchangeId: active.exchangeId,
					cycleId: active.protocol.currentCycleId,
					message: originalErrorMessage(error),
				});
			}
			silentlyAbandonDecision();
		}
	};

	const compactBeforeDecision = (
		claim: HubMainClaim,
		timerId: number,
		domainFence: import("pi-process-domain").DomainFence,
	): boolean | Promise<boolean> => {
		const ctx = sessionContext;
		const controller = currentController(claim);
		if (
			ctx === null ||
			controller === null ||
			controller.snapshot.idleTimer?.id !== timerId ||
			!allIdleForClaim(claim)
		) {
			return false;
		}
		const decisionPrompt = buildDecisionPrompt(
			config.decisionPrompt,
			config.reasonTypes,
		);
		const predict = (
			ctx as ExtensionContext & {
				wouldTriggerAutoCompaction?: (content: string) => boolean;
			}
		).wouldTriggerAutoCompaction;
		try {
			if (predict === undefined || !predict(decisionPrompt)) return true;
		} catch {
			return false;
		}
		const inputGeneration = userInputGeneration;

		return (async () => {
			const compacted = await new Promise<boolean>((resolve) => {
				try {
					ctx.compact({
						onComplete: () => resolve(true),
						onError: () => resolve(false),
					});
				} catch {
					resolve(false);
				}
			});
			if (
				!compacted ||
				userInputGeneration !== inputGeneration ||
				!allIdleForClaim(claim)
			)
				return false;
			if (
				options.processDomain !== undefined &&
				!(await options.processDomain.confirm(domainFence))
			) {
				return false;
			}
			return userInputGeneration === inputGeneration && allIdleForClaim(claim);
		})();
	};

	const armIdleTimer = (timerId: number, delaySeconds: number): void => {
		const claim = getMainClaim();
		if (
			claim === null ||
			currentController(claim) === null ||
			!domainIdle() ||
			!localIdle()
		)
			return;
		const domainFence = options.processDomain?.snapshot.fence ?? {
			brokerEpoch: "local",
			activityGeneration: BigInt(options.hub.snapshot.revision),
		};
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
				domainFence,
				handle: clock.setTimeout(async () => {
					if (armedTimer !== timer) return;
					const controller = currentController(timer.claim);
					if (
						stopped ||
						controller === null ||
						!options.hub.snapshot.allObservableIdle ||
						!domainIdle() ||
						controller.snapshot.idleTimer?.id !== timer.timerId
					) {
						armedTimer = null;
						return;
					}
					if (!localIdle()) {
						// The local lifecycle edge has not reached the aggregate hub yet.
						// Clear the controller timer intent now so the next authoritative
						// agent_settled can arm a fresh full delay.
						armedTimer = null;
						applyTransition(controller.onObservableBusy(), undefined, {
							claim: timer.claim,
						});
						return;
					}
					if (now() < deadline) {
						schedule();
						return;
					}
					if (
						options.processDomain !== undefined &&
						!(await options.processDomain.confirm(timer.domainFence))
					) {
						armedTimer = null;
						applyTransition(controller.onObservableBusy(), undefined, {
							claim: timer.claim,
						});
						return;
					}
					const confirmedController = currentController(timer.claim);
					if (
						armedTimer !== timer ||
						confirmedController === null ||
						confirmedController.snapshot.idleTimer?.id !== timer.timerId ||
						!allIdleForClaim(timer.claim)
					) {
						if (armedTimer === timer) armedTimer = null;
						if (
							confirmedController !== null &&
							confirmedController.snapshot.idleTimer?.id === timer.timerId
						) {
							applyTransition(
								confirmedController.onObservableBusy(),
								undefined,
								{ claim: timer.claim },
							);
						}
						return;
					}
					const beginAfterGate = (compacted: boolean): void => {
						const readyController = currentController(timer.claim);
						if (armedTimer !== timer) return;
						if (
							!compacted ||
							readyController === null ||
							!allIdleForClaim(timer.claim) ||
							readyController.snapshot.idleTimer?.id !== timer.timerId
						) {
							armedTimer = null;
							if (
								readyController !== null &&
								readyController.snapshot.idleTimer?.id === timer.timerId
							) {
								applyTransition(readyController.onObservableBusy(), undefined, {
									claim: timer.claim,
								});
								if (allIdleForClaim(timer.claim)) reconcileIdle();
							}
							return;
						}
						armedTimer = null;
						applyTransition(
							readyController.beginDecision(timer.timerId),
							undefined,
							{ claim: timer.claim },
						);
					};
					try {
						const gate = compactBeforeDecision(
							timer.claim,
							timer.timerId,
							timer.domainFence,
						);
						if (typeof gate === "boolean") {
							beginAfterGate(gate);
							return;
						}
						beginAfterGate(await gate);
					} catch {
						beginAfterGate(false);
					}
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
		if (currentController() === null) return;
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
				// Historical effect name: closes the decision window; no tool swap.
				if (activeDecision?.decisionId === effect.decisionId) {
					activeDecision = null;
					capturedDecisionResponse = null;
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
		applyOptions?: {
			readonly suppressNotify?: boolean;
			readonly claim?: HubMainClaim;
		},
	): void => {
		const claim = applyOptions?.claim ?? getMainClaim();
		if (claim === null || !options.hub.isCurrentMain(claim)) return;
		for (const effect of transition.effects) {
			if (!options.hub.isCurrentMain(claim)) return;
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
		const claim = getMainClaim();
		const controller = currentController(claim);
		if (
			stopped ||
			!configReady ||
			claim === null ||
			controller === null ||
			!options.hub.snapshot.allObservableIdle ||
			!domainIdle() ||
			!localIdle() ||
			pendingFinalization !== null
		) {
			return;
		}
		applyTransition(controller.onAllObservableIdle(), undefined, { claim });
	};

	/**
	 * Fresh lock is deliberately a real unlock followed by cleanup and a new
	 * lock. Capturing one claim prevents either a command or message_start from
	 * transferring control to a replacement main halfway through the sequence.
	 */
	const restartLockCycle = (
		ctx?: RuntimeContext,
		restartOptions?: { readonly notifyLocked?: boolean },
	): void => {
		const claim = getMainClaim();
		const controller = currentController(claim);
		if (claim === null || controller === null || !owns(claim)) return;

		const unlockTransition = controller.unlock();
		if (stopIfStale(claim)) return;

		clearOperationalPendingWork();
		if (stopIfStale(claim)) return;

		applyTransition(unlockTransition, ctx, {
			suppressNotify: true,
			claim,
		});
		if (stopIfStale(claim)) return;

		const lockTransition = controller.lock();
		if (stopIfStale(claim)) return;
		applyTransition(lockTransition, ctx, {
			suppressNotify: restartOptions?.notifyLocked !== true,
			claim,
		});
		if (stopIfStale(claim)) return;
		reconcileIdle();
	};

	/**
	 * Publish neutral `user-ready` at most once for the current all-idle epoch.
	 * Only AI decision unlock, exhausted, and decision-failed terminal states
	 * produce a signal. Ordinary unlocked idle never publishes by inference.
	 */
	const maybePublishUserReady = async (): Promise<void> => {
		if (
			stopped ||
			!configReady ||
			!isCurrentMain() ||
			!options.hub.snapshot.allObservableIdle ||
			!domainIdle() ||
			!localIdle() ||
			pendingFinalization !== null ||
			publishedForIdleEpoch
		) {
			return;
		}

		const claim = getMainClaim();
		const controller = currentController(claim);
		if (claim === null || controller === null) return;

		let envelope = null as ReturnType<typeof createUserReadyEnvelope> | null;
		const aiUnlockIntent = pendingAiUnlock;
		if (aiUnlockIntent !== null) {
			envelope = createUserReadyEnvelope({
				STOP_KIND: "AI_UNLOCK",
				REASON_TYPE: aiUnlockIntent.reasonType,
				REASON: aiUnlockIntent.reason,
			});
		} else {
			const snapshot = controller.snapshot;
			if (snapshot.locked && snapshot.exhausted) {
				envelope = createUserReadyEnvelope({ STOP_KIND: "EXHAUSTED" });
			} else if (snapshot.locked && snapshot.decisionFailed) {
				envelope = createUserReadyEnvelope({
					STOP_KIND: "DECISION_FAILED",
				});
			}
		}

		if (envelope === null || !allIdleForClaim(claim)) return;
		if (options.processDomain !== undefined) {
			const snapshot = options.processDomain.snapshot;
			if (!snapshot.certain || !snapshot.allIdle) return;
			if (!(await options.processDomain.confirm(snapshot.fence))) return;
			if (!allIdleForClaim(claim)) return;
		}
		if (aiUnlockIntent !== null) {
			if (pendingAiUnlock !== aiUnlockIntent) return;
			pendingAiUnlock = null;
		}
		publishedForIdleEpoch = true;
		try {
			emitSemanticHook(options.pi.events, envelope);
		} catch {
			// Listener failures are contained by Pi's bus; emission itself must
			// never escape into controller/runtime control flow.
		}
	};

	const dropControl = (): void => {
		// Ownership has already been invalidated by the hub before cleanup starts.
		// Safe to call again after re-entrant demotion — every step is idempotent.
		settledCallbackGeneration += 1;
		options.controllerHolder.controller?.unlock();
		clearOperationalPendingWork();
		options.controllerHolder.controller = null;
		configReady = false;
		configLoad = null;
		ownedClaim = null;
		publishedForIdleEpoch = false;
	};

	/**
	 * After an ownership-dependent external/re-entrant call, stop further work if
	 * the captured claim is no longer current. Ensures local control cleanup when
	 * demotion did not already drop us via the hub subscription.
	 */
	const stopIfStale = (claim: HubMainClaim): boolean => {
		if (owns(claim)) return false;
		if (ownedClaim !== null) dropControl();
		else clearOperationalPendingWork();
		return true;
	};

	const acquireControl = (claim: HubMainClaim): void => {
		if (stopped || !options.hub.isCurrentMain(claim)) return;
		ownedClaim = claim;
		if (options.injectedController) {
			options.controllerHolder.controller = injectedController;
			configReady = injectedController !== null;
			syncHubState();
			return;
		}
		if (configReady && options.controllerHolder.controller !== null) {
			syncHubState();
			return;
		}
		if (configLoad !== null || sessionContext === null) return;

		const ctx = sessionContext;
		const generation = lifecycleGeneration;
		configLoad = (async () => {
			const loaded: LoadedConfig = await loadConfig({
				cwd: ctx.cwd,
				trusted: ctx.isProjectTrusted(),
				agentDir: options.agentDir ?? getAgentDir(),
			});
			if (
				stopped ||
				generation !== lifecycleGeneration ||
				attachment === null ||
				ownedClaim !== claim ||
				!options.hub.isCurrentMain(claim)
			) {
				return;
			}
			config = { ...loaded.config };
			options.controllerHolder.controller =
				createLockDecisionController(config);
			configReady = true;
			for (const diagnostic of loaded.diagnostics) {
				if (!owns(claim)) {
					dropControl();
					return;
				}
				try {
					ctx.ui.notify(diagnostic.message, "warning");
				} catch {
					// Configuration remains usable when a non-TUI host rejects notify.
				}
				// Revalidate after notify: a synchronous demotion must not emit later
				// diagnostics or continue into control-plane sync.
				if (!owns(claim)) {
					dropControl();
					return;
				}
			}
			if (owns(claim)) syncHubState();
		})().finally(() => {
			if (ownedClaim === claim) configLoad = null;
		});
	};

	const syncHubState = (): void => {
		ensureMain();
		const claim = getMainClaim();
		if (ownedClaim !== null && !options.hub.isCurrentMain(ownedClaim)) {
			dropControl();
		}
		if (claim === null) return;
		if (ownedClaim === null) {
			acquireControl(claim);
			return;
		}
		const controller = currentController(claim);
		if (!configReady || controller === null) return;
		if (options.hub.snapshot.allObservableIdle && domainIdle()) {
			reconcileIdle();
			void maybePublishUserReady();
		} else {
			publishedForIdleEpoch = false;
			applyTransition(controller.onObservableBusy(), undefined, { claim });
		}
	};

	const unsubscribe = options.hub.subscribe(() => {
		if (!stopped) syncHubState();
	});

	const invalidateActiveDecision = (force = false): void => {
		const active = activeDecision;
		const controller = options.controllerHolder.controller;
		if (active === null || active.invalidated || controller === null) return;
		const snapshot = options.processDomain?.snapshot;
		if (
			!force &&
			snapshot?.certain &&
			snapshot.fence.brokerEpoch === active.domainFence.brokerEpoch &&
			snapshot.fence.activityGeneration ===
				active.domainFence.activityGeneration
		) {
			return;
		}
		active.invalidated = true;
		capturedDecisionResponse = null;
		pendingFinalization = null;
		clearLiveStatus();
		applyTransition(
			controller.invalidateDecision(active.decisionId),
			undefined,
			{
				claim: active.claim,
			},
		);
		try {
			options.pi.sendMessage(
				createDecisionFoldMessage({
					exchangeId: active.exchangeId,
					cycleId: active.protocol.currentCycleId,
					outcome: "invalidated",
				}),
				{ triggerTurn: false, deliverAs: "steer" },
			);
		} catch {
			// Context folding is best effort; no external watchdog outcome is emitted.
		}
	};

	const unsubscribeDomain = options.processDomain?.subscribe(() => {
		if (stopped || !domainReady) return;
		if (domainInternalDecision) {
			// A confirmed internal decision run may mark this participant busy while
			// preserving its original decision fence through finalization.
			syncHubState();
			return;
		}
		invalidateActiveDecision();
		syncHubState();
	});

	const withDecisionFence = async (
		active: ActiveDecision,
		effect: () => void,
	): Promise<boolean> => {
		if (!allIdleForClaim(active.claim)) return false;
		if (
			options.processDomain !== undefined &&
			!(await options.processDomain.confirm(active.domainFence))
		) {
			invalidateActiveDecision(true);
			return false;
		}
		if (!allIdleForClaim(active.claim)) return false;
		effect();
		return allIdleForClaim(active.claim);
	};

	/**
	 * Deliver a cached decision finalization. Returns true when a valid continue
	 * was dispatched so this settle stays intermediate and must not publish
	 * terminal `user-ready` yet.
	 *
	 * Captures the decision exchange claim and revalidates it immediately before
	 * and after every ownership-dependent external/re-entrant call so a
	 * synchronous demotion cannot continue into later messages, UI, or entries.
	 */
	const deliverPending = async (ctx: ExtensionContext): Promise<boolean> => {
		const pending = pendingFinalization;
		if (
			pending === null ||
			activeDecision !== pending.active ||
			!owns(pending.active.claim)
		) {
			return false;
		}
		const { active, cycleId, plan } = pending;
		if (active.invalidated) {
			pendingFinalization = null;
			invalidateActiveDecision();
			return false;
		}
		const readyToFinalize = (): boolean =>
			plan.outcome === "unlock"
				? owns(active.claim) && localIdle()
				: allIdleForClaim(active.claim);
		if (!readyToFinalize()) {
			if (plan.outcome !== "unlock") deferDecisionOnBusy(active);
			return false;
		}
		// Exact claim carried by this decision exchange — not a live re-lookup.
		const claim = active.claim;
		if (options.processDomain !== undefined && plan.outcome !== "unlock") {
			if (!readyToFinalize()) return false;
			if (!(await options.processDomain.confirm(active.domainFence))) {
				invalidateActiveDecision(true);
				return false;
			}
			if (!readyToFinalize()) {
				deferDecisionOnBusy(active);
				return false;
			}
		}
		// Local Pi and every observable attachment must still be idle to finalize;
		// a busy race must not commit an invalid response or dispatch a re-ask.
		if (!readyToFinalize()) {
			if (plan.outcome !== "unlock") deferDecisionOnBusy(active);
			return false;
		}
		// Invalid re-asks have re-entrant status/UI work before dispatch. Keep the
		// plan uncommitted through that work so an aggregate-busy edge consumes no
		// invalid-attempt budget and can be retried at the next genuine idle settle.
		if (plan.outcome === "invalid") {
			const status = checkingStatus(active);
			const widgetError = showLiveStatus(status);
			if (widgetError !== null) {
				appendStatus({
					kind: "other-error",
					exchangeId: active.exchangeId,
					cycleId,
					message: widgetError,
				});
				silentlyAbandonDecision();
				return false;
			}
			if (!allIdleForClaim(claim)) return false;
		}

		const controllerBeforeCommit =
			options.controllerHolder.controller?.snapshot;
		pendingFinalization = null;
		const finalization = active.protocol.commitResponse(cycleId, plan);

		if (finalization.outcome === "reask") {
			if (stopIfStale(claim)) return false;
			if (!allIdleForClaim(claim)) {
				// Local Pi became busy after this invalid response was committed but
				// before the re-ask could dispatch. Defer the whole exchange so the
				// next settle cannot re-commit or consume another attempt.
				deferDecisionOnBusy(active);
				return false;
			}
			if (
				stopIfStale(claim) ||
				!allIdleForClaim(claim) ||
				finalization.reaskPrompt === undefined ||
				!active.protocol.advanceAfterReask(cycleId)
			) {
				silentlyAbandonDecision();
				return false;
			}
			if (stopIfStale(claim) || !allIdleForClaim(claim)) {
				deferDecisionOnBusy(active);
				return false;
			}
			try {
				if (
					!sendDecisionPrompt(
						active,
						active.protocol.currentCycleId,
						finalization.reaskPrompt,
						{ deferOnBusy: false },
					)
				) {
					const cycleRolledBack = active.protocol.rollbackAfterReask(cycleId);
					const controllerRolledBack =
						controllerBeforeCommit !== undefined &&
						options.controllerHolder.controller?.rollbackInvalidDecision(
							active.decisionId,
							controllerBeforeCommit.invalidDecisionAttempts,
							controllerBeforeCommit.lastInvalidDecisionError,
						).applied === true;
					if (!cycleRolledBack || !controllerRolledBack) {
						silentlyAbandonDecision();
						return false;
					}
					deferDecisionOnBusy(active);
					return false;
				}
			} catch (error) {
				if (owns(claim)) {
					appendStatus({
						kind: "other-error",
						exchangeId: active.exchangeId,
						cycleId: active.protocol.currentCycleId,
						message: originalErrorMessage(error),
					});
				}
				silentlyAbandonDecision();
				return false;
			}
			if (stopIfStale(claim)) return false;
			appendStatus({
				kind: "validation-error",
				exchangeId: active.exchangeId,
				cycleId,
				message: finalization.error ?? "Invalid watchdog decision response.",
			});
			// Re-ask is still an open decision cycle, not a terminal epoch.
			return false;
		}

		if (stopIfStale(claim)) return false;
		clearLiveStatus();
		if (stopIfStale(claim)) return false;

		if (finalization.outcome === "decision-failed") {
			activeDecision = null;
			capturedDecisionResponse = null;
			if (finalization.cycleId === undefined) return false;
			if (
				options.processDomain !== undefined &&
				!(await withDecisionFence(active, () => {}))
			)
				return false;
			if (
				!appendStatus({
					kind: "decision-failed",
					exchangeId: active.exchangeId,
					cycleId: finalization.cycleId,
					message: finalization.error ?? "Continue watchdog decision failed.",
				})
			) {
				silentlyAbandonDecision();
				return false;
			}
			if (stopIfStale(claim)) return false;
			try {
				options.pi.sendMessage(
					createDecisionFoldMessage({
						exchangeId: active.exchangeId,
						cycleId: finalization.cycleId,
						outcome: "decision-failed",
					}),
					{ triggerTurn: false, deliverAs: "steer" },
				);
			} catch {
				// Fold is best effort; decision-failed state remains authoritative.
			}
			if (stopIfStale(claim)) return false;
			try {
				ctx.ui.notify(
					finalization.notification ??
						formatDecisionFailedNotification(
							finalization.error ?? "Invalid decision.",
						),
					"warning",
				);
			} catch {
				// Non-TUI hosts may reject notify; decision-failed is already final.
			}
			stopIfStale(claim);
			return false;
		}

		if (
			(finalization.outcome !== "continue" &&
				finalization.outcome !== "unlock") ||
			finalization.cycleId === undefined
		) {
			return false;
		}

		if (finalization.outcome === "continue") {
			activeDecision = null;
			capturedDecisionResponse = null;
			const finalCycleId = finalization.cycleId;
			const deferAcceptedContinue = (): false => {
				options.controllerHolder.controller?.rollbackValidContinue();
				active.invalidated = true;
				clearLiveStatus();
				return false;
			};
			if (stopIfStale(claim)) return false;
			if (!allIdleForClaim(claim)) return deferAcceptedContinue();
			if (options.processDomain !== undefined) {
				if (!(await options.processDomain.confirm(active.domainFence))) {
					return deferAcceptedContinue();
				}
				if (!allIdleForClaim(claim)) return deferAcceptedContinue();
			}
			if (!allIdleForClaim(claim)) return deferAcceptedContinue();
			try {
				options.pi.sendMessage(
					createDecisionFoldMessage({
						exchangeId: active.exchangeId,
						cycleId: finalCycleId,
						outcome: "continue",
						continuePrompt: config.continuePrompt,
					}),
					{ triggerTurn: true, deliverAs: "steer" },
				);
			} catch {
				if (!allIdleForClaim(claim)) return deferAcceptedContinue();
				silentlyAbandonDecision();
				return false;
			}
			// Persist accepted-continuation evidence only after dispatch succeeds, so a
			// busy send rollback cannot leave a false `continued` card.
			try {
				options.pi.appendEntry(CONTINUE_ENTRY_TYPE, {});
			} catch {
				// Dispatch has already succeeded; history persistence is best effort.
			}
			// Demotion after a successful send still must not claim intermediate continue.
			if (stopIfStale(claim)) return false;
			// The continuation turn is now the only local busy source; reconcile the
			// next retry from the controller state for hosts/tests that have not yet
			// delivered its agent_start event.
			reconcileIdle();
			return true;
		}

		activeDecision = null;
		capturedDecisionResponse = null;
		// Valid AI unlock must carry both fields; never invent empty fallbacks.
		const reasonType =
			typeof finalization.reasonType === "string" &&
			finalization.reasonType.length > 0
				? finalization.reasonType
				: null;
		const reason =
			typeof finalization.reason === "string" && finalization.reason.length > 0
				? finalization.reason
				: null;
		if (reasonType === null || reason === null) {
			stopIfStale(claim);
			return false;
		}
		if (stopIfStale(claim)) return false;
		// Retain AI unlock publication intent before asynchronous publication
		// fencing. The controller is already terminally unlocked; if Pi becomes busy,
		// the next genuine idle epoch publishes the typed intent exactly once.
		pendingAiUnlock = { reasonType, reason };
		try {
			options.pi.sendMessage(
				createDecisionFoldMessage({
					exchangeId: active.exchangeId,
					cycleId: finalization.cycleId,
					outcome: "unlock",
				}),
				{ triggerTurn: false, deliverAs: "steer" },
			);
			if (stopIfStale(claim)) return false;
			try {
				options.pi.appendEntry<HumanUnlockEntry>(HUMAN_UNLOCK_ENTRY_TYPE, {
					reasonType,
					reason,
				});
			} catch {
				// The state is already unlocked; a TUI-only history entry is optional.
			}
			stopIfStale(claim);
		} catch {
			// The controller is already unlocked and must not be re-armed.
			stopIfStale(claim);
		}
		// The persisted TUI-only entry is the sole visible reasoned unlock output.
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
			plan: active.protocol.planResponse(
				cycleId,
				response === "missing"
					? { content: [{ type: "malformed" }] }
					: response,
			),
		};
	};

	const handleDecisionMessageEnd = (event: MessageEndEvent) => {
		// Suppress the aborted assistant of a watchdog decision preempted by user
		// input so the TUI does not show `Operation aborted` for the internal run.
		// The TUI renders abort text from `stopReason`, so neutralize both fields;
		// this only ever applies to the watchdog's own preempted internal turn.
		if (
			suppressDecisionAbort &&
			event.message.role === "assistant" &&
			isAbortedAssistant(event.message)
		) {
			return {
				message: {
					...event.message,
					content: [],
					stopReason: "stop" as const,
				},
			};
		}
		const active = activeDecision;
		if (
			active === null ||
			!active.submitted ||
			pendingFinalization !== null ||
			event.message.role !== "assistant" ||
			isAbortedAssistant(event.message) ||
			isErroredAssistant(event.message) ||
			!options.hub.isCurrentMain(active.claim)
		) {
			return undefined;
		}
		const cycleId = active.protocol.currentCycleId;
		const response = normalizeAssistantDecisionResponse(event.message);
		capturedDecisionResponse = { active, cycleId, response };
		// The current prompt's run is over; until the next prompt (re-ask,
		// continue, or fold) is actually sent, an unrelated run must not be
		// misattributed as this decision's answer.
		active.dispatchPending = false;
		active.submitted = false;

		const validation = validateDecisionResponse(response, config.reasonTypes);
		const audit: DecisionAuditEntry = validation.valid
			? validation.decision.kind === "continue"
				? {
						version: 1,
						exchangeId: active.exchangeId,
						cycleId,
						outcome: "continue",
					}
				: {
						version: 1,
						exchangeId: active.exchangeId,
						cycleId,
						outcome: "unlock",
						reasonType: validation.decision.reasonType,
						reason: validation.decision.reason,
					}
			: {
					version: 1,
					exchangeId: active.exchangeId,
					cycleId,
					outcome: "invalid",
					error: validation.error,
				};
		try {
			options.pi.appendEntry<DecisionAuditEntry>(
				DECISION_AUDIT_ENTRY_TYPE,
				audit,
			);
		} catch {
			// Audit persistence is optional; context hiding must still succeed.
		}

		return {
			message: {
				...event.message,
				content: [],
			},
		};
	};

	const handleAgentEnd = (event: AgentEndEvent): void => {
		const assistant = terminalAssistant(event.messages);
		// Aborts are owned by the abort-outcome path. Provider errors remain
		// provisional because Pi may automatically retry within the same run;
		// only a successful response or the final settled no-result may consume a
		// decision attempt.
		if (assistant !== undefined && isAbortedAssistant(assistant)) return;
		if (assistant !== undefined && isErroredAssistant(assistant)) {
			const active = activeDecision;
			if (active !== null && owns(active.claim)) {
				if (
					!appendStatus({
						kind: "other-error",
						exchangeId: active.exchangeId,
						cycleId: active.protocol.currentCycleId,
						message: assistantErrorMessage(assistant),
					}) ||
					!owns(active.claim)
				) {
					silentlyAbandonDecision();
				}
			}
			return;
		}
		const captured = capturedDecisionResponse;
		if (
			captured !== null &&
			captured.active === activeDecision &&
			captured.cycleId === activeDecision.protocol.currentCycleId
		) {
			capturedDecisionResponse = null;
			finalizeActiveDecision(captured.response);
			return;
		}
		finalizeActiveDecision(
			assistant === undefined
				? "missing"
				: normalizeAssistantDecisionResponse(assistant),
		);
	};

	const handleMessageStart = async (event: {
		readonly message: unknown;
	}): Promise<void> => {
		const active = activeDecision;
		if (
			active === null ||
			active.invalidated ||
			!active.dispatchPending ||
			!owns(active.claim)
		) {
			return;
		}
		const message = event.message as {
			readonly role?: unknown;
			readonly customType?: unknown;
			readonly details?: {
				readonly exchangeId?: unknown;
				readonly cycleId?: unknown;
			};
		};
		const isCurrentDecision =
			message.role === "custom" &&
			message.customType === "pi-continue-watchdog:decision" &&
			message.details?.exchangeId === active.exchangeId &&
			message.details?.cycleId === active.protocol.currentCycleId;
		if (!isCurrentDecision) {
			deferDecisionOnBusy(active);
			return;
		}
		active.dispatchPending = false;
		active.submitted = true;
		domainInternalDecision = true;
		if (domainReady && !domainFatal && options.processDomain !== undefined) {
			await options.processDomain.setInternalDecision(
				options.attachmentInstance,
				true,
			);
		}
	};

	const registerLifecycle = (): void => {
		options.pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			++lifecycleGeneration;
			sessionContext = ctx;
			if (options.processDomain !== undefined) {
				try {
					await options.processDomain.attach(options.attachmentInstance, {
						initialBusy: !ctx.isIdle(),
						onFatal: (error) => {
							domainFatal = true;
							options.fatalExit?.fail(error, ctx);
						},
					});
					domainAttached = true;
					domainReady = true;
				} catch (error) {
					domainFatal = true;
					options.fatalExit?.fail(
						error instanceof Error ? error : new Error("process domain failed"),
						ctx,
					);
					return;
				}
			}
			if (stopped || domainFatal) return;
			const bound = options.hub.bind({
				instance: options.attachmentInstance,
				sessionId: ctx.sessionManager.getSessionId(),
				hasUI: ctx.hasUI,
				initialBusy: !ctx.isIdle(),
			});
			attachment = bound.attachment;
			syncHubState();
			await configLoad;
		});

		options.pi.on("agent_start", async () => {
			// Invalidate any deferred settled wake from a previous run on this attachment.
			agentActivityGeneration += 1;
			const claim = getMainClaim();
			const controller = currentController(claim);
			// A run that starts before the watchdog decision was actually submitted is
			// unrelated work (for example a compaction resume during fence confirm).
			// Defer the provisional decision so this run is never captured as the
			// decision answer and never marked internal in the process domain.
			const active = activeDecision;
			if (
				active !== null &&
				!active.invalidated &&
				!active.dispatchPending &&
				!active.submitted
			) {
				deferDecisionOnBusy(active);
			}
			if (claim !== null && controller !== null) {
				const transition = controller.ensureLocked();
				if (transition.applied) {
					// Fresh silent lock: controller first, then operational cleanup.
					clearOperationalPendingWork();
					applyTransition(transition, undefined, {
						suppressNotify: true,
						claim,
					});
				}
				// Already locked: preserve cycle/decision; do not clear active work.
			}
			if (attachment !== null) options.hub.markBusy(attachment);
			if (domainReady && !domainFatal && options.processDomain !== undefined) {
				domainInternalDecision = false;
				await options.processDomain.markBusy(options.attachmentInstance, {
					internalDecision: false,
				});
			}
		});

		// A real user input (interactive or RPC) that arrives while a submitted
		// internal watchdog decision is running must preempt it: Pi keeps the user
		// message queued (we return `continue`), and we abort the internal decision
		// so the queued user turn takes over promptly. Extension-injected messages
		// never preempt the watchdog. The suppressed aborted assistant is the
		// watchdog's own response only; normal user aborts are unaffected.
		options.pi.on("input", (event) => {
			const active = activeDecision;
			if (event.source !== "interactive" && event.source !== "rpc") {
				return;
			}
			userInputGeneration += 1;
			if (
				active === null ||
				active.invalidated ||
				!active.submitted ||
				!owns(active.claim)
			) {
				return;
			}
			const shouldAbort = active.submitted;
			if (shouldAbort) suppressDecisionAbort = true;
			deferDecisionOnBusy(active);
			if (shouldAbort) {
				try {
					sessionContext?.abort();
				} catch {
					// Abort is best effort; the decision was already deferred so the next
					// settle will not misattribute this run.
				}
			}
			return { action: "continue" };
		});

		options.pi.on("message_end", handleDecisionMessageEnd);
		options.pi.on("agent_end", handleAgentEnd);

		// While a decision is open, block ordinary tools before execution. The
		// agent loop continues so the final assistant XML can still be validated.
		options.pi.on("tool_call", (_event) => {
			const active = activeDecision;
			if (
				active === null ||
				pendingFinalization !== null ||
				!options.hub.isCurrentMain(active.claim)
			) {
				return;
			}
			return {
				block: true,
				reason: DECISION_TOOL_BLOCK_REASON,
			};
		});

		options.pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
			// Only Pi's live idle truth may mark this attachment idle. Another
			// extension can start a nested run from an earlier settled handler.
			if (stopped || !ctx.isIdle()) return;

			if (attachment !== null) options.hub.markIdle(attachment);
			domainInternalDecision = false;
			if (domainReady && !domainFatal && options.processDomain !== undefined) {
				await options.processDomain.markIdle(options.attachmentInstance);
			}
			if (!isCurrentMain() || options.controllerHolder.controller === null)
				return;

			// Pi marks the session idle before emitting agent_settled. Defer the
			// wake check until every settled handler has returned so a later handler
			// can start a run without racing an eager triggerTurn from this handler.
			// Capture per-run and per-settle identity: a later agent_start or a newer
			// true-idle settle must leave this callback inert even if ctx is idle again.
			const settledClaim = getMainClaim();
			const settledLifecycleGeneration = lifecycleGeneration;
			const settledActivityGeneration = agentActivityGeneration;
			const settledToken = ++settledCallbackGeneration;
			const handle = clock.setTimeout(async () => {
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

				const active = activeDecision;
				if (
					active?.dispatchPending &&
					!active.submitted &&
					!active.invalidated
				) {
					// Public sendMessage is fire-and-forget. If no matching agent_start ever
					// confirmed dispatch, a later settle belongs to other Pi work and must
					// not be converted into a malformed decision response.
					deferDecisionOnBusy(active);
				} else {
					// A confirmed decision run that settled without agent_end is malformed.
					finalizeActiveDecision("missing");
				}
				const continued = await deliverPending(ctx);
				// Explicit reconcile even when hub markIdle was a no-op edge.
				reconcileIdle();
				// Valid continue remains intermediate; wait for the next real idle epoch.
				if (!continued) await maybePublishUserReady();
			}, 0);
			handle.unref?.();
		});
	};

	const shutdown = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		lifecycleGeneration += 1;
		const detached = attachment;
		if (detached !== null) options.hub.detach(detached);
		// Hub ownership invalidation happens before local cleanup effects.
		dropControl();
		attachment = null;
		sessionContext = null;
		unsubscribe();
		unsubscribeDomain?.();
		if (domainAttached && options.processDomain !== undefined) {
			domainAttached = false;
			await options.processDomain.detach(options.attachmentInstance);
		}
	};

	return {
		get controller(): LockDecisionController | null {
			return options.controllerHolder.controller;
		},
		get config(): ContinueWatchdogConfig {
			return { ...config };
		},
		isCurrentMain,
		getMainClaim,
		isCurrentMainClaim: (claim) => options.hub.isCurrentMain(claim),
		clearOperationalPendingWork,
		consumeDecisionAbortSuppression,
		restartLockCycle,
		applyEffect,
		applyTransition,
		reconcileIdle,
		handleMessageStart,
		registerLifecycle,
		shutdown,
	};
}
