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
import { probePiAgentState } from "pi-extension-utils/pi-agent-state";
import {
	createInquiryRuntime,
	type InquiryAttemptHandle,
	type InquiryFoldMessage,
} from "pi-extension-utils/pi-inquiry";

import {
	type ActivityGeneration,
	createActivityGraceCoordinator,
} from "./activity-grace.js";
import {
	CONTINUE_ENTRY_TYPE,
	type ContinueEntry,
	HUMAN_UNLOCK_ENTRY_TYPE,
	type HumanUnlockEntry,
	WATCHDOG_STATUS_ENTRY_TYPE,
	type WatchdogStatusEntry,
} from "./commands.js";
import { BUILT_IN_CONFIG, type ContinueWatchdogConfig } from "./config.js";
import { type LoadedConfig, loadRuntimeConfig } from "./config-loader.js";
import {
	createDecisionFoldMessage,
	DECISION_INQUIRY_NAMESPACE,
	findDecisionAssistantEntryId,
	findPreemptedDecisionAssistantEntryIds,
	INQUIRY_MARKER_ENTRY_TYPE,
	neutralizeDecisionAssistant,
	PREEMPTED_DECISION_ERROR,
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
import {
	type DomainFence,
	isProcessDomainFatalError,
	type ProcessDomainCoordinator,
} from "./process-domain.js";
import {
	createUserReadyEnvelope,
	createWatchdogContinuedEnvelope,
	emitSemanticHook,
} from "./semantic-hook.js";

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

const WATCHDOG_STATUS_WIDGET_KEY = "pi-continue-watchdog:status";

/** Context-excluded persisted metadata for one model decision response. */
export const DECISION_AUDIT_ENTRY_TYPE = "pi-continue-watchdog:decision-audit";

export type DecisionAuditEntry =
	| {
			readonly version: 1;
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "continue";
			readonly reasonType: string;
			readonly reason: string;
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
	readonly domainFence: DomainFence;
	inquiry: InquiryAttemptHandle;
	aggregateGeneration: ActivityGeneration;
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

interface InquiryMarkerEntry {
	readonly version: 1;
	readonly exchangeId: string;
	readonly cycleId: number;
}

interface SpliceEntryAPI {
	spliceEntry(entryId: string): void;
}

interface UninterruptibleMessageEndAPI {
	on(
		event: "message_end",
		handler: (
			event: MessageEndEvent,
			ctx: ExtensionContext,
		) => { readonly message: MessageEndEvent["message"] } | undefined,
		options: { readonly uninterruptible: true },
	): void;
}

type SelfDecisionRun =
	| { readonly kind: "none" }
	| {
			readonly kind: "provisional" | "confirmed";
			readonly exchangeId: string;
			readonly cycleId: number;
	  };

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

export type WatchdogTriggerBlocker =
	| "not-main"
	| "config-loading"
	| "unlocked"
	| "exhausted"
	| "decision-failed"
	| "observable-agent-busy"
	| "local-agent-busy"
	| "pending-messages"
	| "decision-open"
	| "decision-finalizing";

export interface WatchdogTriggerStatus {
	readonly main: boolean;
	readonly locked: boolean | null;
	readonly attempt: number | null;
	readonly maxRetries: number;
	readonly blocker: WatchdogTriggerBlocker | null;
	readonly gracePhase: "blocked" | "grace" | "ready";
	readonly graceRemainingMs: number | null;
	readonly observableBusyCount: number;
	readonly domainBusyParticipants: number | null;
}

export interface DecisionRuntime {
	readonly controller: LockDecisionController | null;
	readonly config: ContinueWatchdogConfig;
	getTriggerStatus(): WatchdogTriggerStatus;
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
	handleMessageStart(
		event: { readonly message: unknown },
		ctx?: ExtensionContext,
	): Promise<void>;
	registerLifecycle(): void;
	shutdown(ctx?: ExtensionContext): Promise<void>;
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

function isPreemptedAssistant(message: unknown): boolean {
	return (
		hasAssistantStopReason(message, "stop") &&
		typeof message === "object" &&
		message !== null &&
		(message as { readonly errorMessage?: unknown }).errorMessage ===
			PREEMPTED_DECISION_ERROR
	);
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
	let ownedClaim: HubMainClaim | null = null;
	let sessionContext: ExtensionContext | null = null;
	let configLoad: Promise<void> | null = null;
	let configReady = options.injectedController === true;
	let lifecycleGeneration = 0;
	let localActivityGeneration = 0;
	/** Binary AI lifecycle state: agent_start = busy, true agent_settled = idle. */
	let localAiBusy = true;
	let stopped = false;
	let activeDecision: ActiveDecision | null = null;
	let selfDecisionRun: SelfDecisionRun = { kind: "none" };
	/** Suppress an aborted internal decision after user takeover or domain failure. */
	let suppressDecisionAbort = false;
	/** Keep one failed-domain decision turn quarantined until its lifecycle ends. */
	let quarantinedDecision: {
		readonly exchangeId: string;
		readonly cycleId: number;
		inputObserved: boolean;
	} | null = null;
	let capturedDecisionResponse: {
		readonly active: ActiveDecision;
		readonly cycleId: number;
		readonly response: DecisionResponse;
	} | null = null;
	let decisionAssistantToSplice: {
		readonly exchangeId: string;
		readonly cycleId: number;
	} | null = null;
	let pendingFinalization: PendingFinalization | null = null;
	/** Retried until Pi accepts the exact correlated remove-fold. */
	let pendingInquiryCleanup: InquiryFoldMessage | null = null;
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
	/** Distinguishes this runtime's synchronous hub report from child reports. */
	let publishingOwnHubObservation = false;

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

	const domainIdle = (): boolean =>
		options.processDomain?.snapshot.allIdle ??
		options.hub.snapshot.allObservableIdle;

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

	const retainInquiryCleanup = (
		active: ActiveDecision,
		watchdogOutcome?: "invalidated" | "preempted",
	): InquiryFoldMessage | null => {
		const fold = active.inquiry.cancel();
		if (fold === null) return null;
		pendingInquiryCleanup =
			watchdogOutcome === undefined
				? fold
				: {
						...fold,
						details: {
							...fold.details,
							watchdogOutcome,
						} as InquiryFoldMessage["details"],
					};
		return pendingInquiryCleanup;
	};

	const retryInquiryCleanup = (): void => {
		const cleanup = pendingInquiryCleanup;
		if (cleanup === null) return;
		try {
			options.pi.sendMessage(cleanup, {
				triggerTurn: false,
				deliverAs: "steer",
			});
			if (pendingInquiryCleanup === cleanup) pendingInquiryCleanup = null;
		} catch {
			// The same idempotent remove-fold is retried at terminal public events.
		}
	};

	/**
	 * Invalidate runtime-local decision state after a controller transition.
	 * Does not change controller lock/cycle accounting.
	 */
	const clearOperationalPendingWork = (): void => {
		localActivityGeneration += 1;
		if (activeDecision !== null) {
			retainInquiryCleanup(activeDecision);
			retryInquiryCleanup();
		}
		activeDecision = null;
		selfDecisionRun = { kind: "none" };
		suppressDecisionAbort = false;
		capturedDecisionResponse = null;
		decisionAssistantToSplice = null;
		pendingFinalization = null;
		clearLiveStatus();
		// Human/abort unlock must not inherit a prior AI unlock publication intent.
		pendingAiUnlock = null;
		observeAggregate();
	};

	const disableDomain = (): void => {
		if (domainFatal) return;
		const active = activeDecision;
		const quarantine =
			active !== null &&
			localAiBusy &&
			(active.dispatchPending || active.submitted);
		if (quarantine && active !== null) {
			quarantinedDecision = {
				exchangeId: active.exchangeId,
				cycleId: active.protocol.currentCycleId,
				inputObserved: active.submitted,
			};
		}
		if (active !== null) invalidateActiveDecision(true);
		domainFatal = true;
		domainReady = false;
		clearOperationalPendingWork();
		if (quarantine) {
			// The trigger turn already started. Abort it and retain both tool blocking
			// and assistant hiding until its agent lifecycle actually ends.
			suppressDecisionAbort = true;
			try {
				sessionContext?.abort();
			} catch {
				// Quarantine remains authoritative when host abort is unavailable.
			}
		}
	};

	const handleRuntimeDomainFailure = (): void => {
		const active = activeDecision;
		const shouldAbort =
			localAiBusy &&
			(quarantinedDecision !== null ||
				(active !== null && (active.dispatchPending || active.submitted)));
		invalidateActiveDecision(true);
		observeAggregate();
		if (!shouldAbort || suppressDecisionAbort) return;
		suppressDecisionAbort = true;
		try {
			sessionContext?.abort();
		} catch {
			// Quarantine remains authoritative when host abort is unavailable.
		}
	};

	const domainWrite = async (
		operation: () => Promise<void>,
	): Promise<boolean> => {
		if (!domainReady || domainFatal || options.processDomain === undefined)
			return false;
		try {
			await operation();
			return true;
		} catch {
			handleRuntimeDomainFailure();
			return false;
		}
	};

	/** Last live public Pi activity observation for this attachment. */
	const localIdle = (): boolean => !localAiBusy;
	/** Public queued-message signal present in every supported upstream Pi. */
	const hasPendingMessages = (): boolean =>
		sessionContext === null
			? false
			: probePiAgentState(sessionContext).pendingMessages;

	const spliceDecisionAssistant = (ctx: ExtensionContext): void => {
		const pending = decisionAssistantToSplice;
		decisionAssistantToSplice = null;
		if (pending === null) return;

		try {
			const spliceEntry = (options.pi as ExtensionAPI & Partial<SpliceEntryAPI>)
				.spliceEntry;
			if (typeof spliceEntry !== "function") return;
			const entryId = findDecisionAssistantEntryId(
				ctx.sessionManager.getBranch(),
				pending.exchangeId,
				pending.cycleId,
			);
			if (entryId !== null) spliceEntry.call(options.pi, entryId);
		} catch {
			// Tree cleanup is best effort and never replaces message clearing/folding.
		}
	};

	const recoverPreemptedDecisionAssistants = (ctx: ExtensionContext): void => {
		try {
			const spliceEntry = (options.pi as ExtensionAPI & Partial<SpliceEntryAPI>)
				.spliceEntry;
			if (typeof spliceEntry !== "function" || !probePiAgentState(ctx).idle)
				return;
			for (const entryId of findPreemptedDecisionAssistantEntryIds(
				ctx.sessionManager.getBranch(),
			)) {
				spliceEntry.call(options.pi, entryId);
			}
		} catch {
			// Resume recovery is best effort; context folding remains authoritative.
		}
	};

	const sameActivityGeneration = (
		left: ActivityGeneration | null,
		right: ActivityGeneration,
	): boolean =>
		left !== null &&
		left.domainEpoch === right.domainEpoch &&
		left.activityGeneration === right.activityGeneration &&
		left.ownershipGeneration === right.ownershipGeneration &&
		left.localActivityGeneration === right.localActivityGeneration;

	const selfRunFor = (active: ActiveDecision): boolean =>
		selfDecisionRun.kind !== "none" &&
		selfDecisionRun.exchangeId === active.exchangeId &&
		selfDecisionRun.cycleId === active.protocol.currentCycleId;

	const externalHubIdle = (): boolean => {
		const snapshot = options.hub.snapshot;
		const selfBusy =
			selfDecisionRun.kind !== "none" && attachment !== null && !localIdle();
		return (
			snapshot.main !== null && snapshot.busyCount - (selfBusy ? 1 : 0) === 0
		);
	};

	const allIdleForClaim = (claim: HubMainClaim): boolean =>
		owns(claim) &&
		externalHubIdle() &&
		domainIdle() &&
		(localIdle() || selfDecisionRun.kind !== "none") &&
		!hasPendingMessages() &&
		selfDecisionRun.kind !== "provisional";

	let observeAggregate = (): void => {};
	let readyGeneration: ActivityGeneration | null = null;
	let qualifyReady = (_generation: ActivityGeneration): void => {};
	const createGraceCoordinator = () =>
		createActivityGraceCoordinator({
			clock: {
				setTimeout: (callback, delayMs) => clock.setTimeout(callback, delayMs),
				clearTimeout: (handle) => clock.clearTimeout(handle),
				now,
			},
			onReady: (generation) => qualifyReady(generation),
		});
	let graceCoordinator = createGraceCoordinator();

	/**
	 * Defer an open decision because local Pi became busy (user input took over or
	 * an unrelated run started). Stay locked, close the decision window, consume
	 * no continue/invalid retry, append no error card, and recover after the next
	 * genuine agent_settled.
	 */
	const deferDecisionOnBusy = (
		active: ActiveDecision,
		cleanupOutcome?: "preempted",
		deferCleanupSend = false,
	): void => {
		if (active.invalidated) return;
		if (
			cleanupOutcome === undefined &&
			(active.submitted || selfRunFor(active))
		) {
			quarantinedDecision = {
				exchangeId: active.exchangeId,
				cycleId: active.protocol.currentCycleId,
				inputObserved: active.submitted,
			};
		}
		active.invalidated = true;
		retainInquiryCleanup(active, cleanupOutcome);
		if (!deferCleanupSend) retryInquiryCleanup();
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
		selfDecisionRun = { kind: "none" };
		localActivityGeneration += 1;
		observeAggregate();
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
		if (
			active.invalidated ||
			!activeGenerationCurrent(active) ||
			hasPendingMessages()
		)
			return false;
		if (!allIdleForClaim(active.claim)) {
			// A transactional re-ask caller rolls accounting back before deferring.
			if (sendOptions?.deferOnBusy !== false) deferDecisionOnBusy(active);
			return false;
		}

		active.dispatchPending = true;
		active.submitted = false;
		try {
			options.pi.appendEntry<InquiryMarkerEntry>(INQUIRY_MARKER_ENTRY_TYPE, {
				version: 1,
				exchangeId: active.exchangeId,
				cycleId,
			});
		} catch (error) {
			active.dispatchPending = false;
			throw error;
		}
		try {
			const prompt = active.inquiry.prompt(decisionPrompt);
			if (!active.inquiry.markSent()) return false;
			options.pi.sendMessage(prompt, {
				triggerTurn: true,
				deliverAs: "steer",
			});
			if (hasPendingMessages() || !activeGenerationCurrent(active)) {
				deferDecisionOnBusy(active);
				return false;
			}
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
			config.continueReasonTypes,
		);
		const domainFence = options.processDomain?.snapshot.fence ?? {
			domainEpoch: "local",
			activityGeneration: 0n,
		};
		const exchangeId = createExchangeId();
		const protocol = createDecisionProtocolSession({
			controller,
			decisionId,
			decisionPrompt,
			reasonTypes: config.reasonTypes,
			continueReasonTypes: config.continueReasonTypes,
		});
		const active: ActiveDecision = {
			decisionId,
			exchangeId,
			claim,
			domainFence,
			inquiry: createInquiryRuntime(DECISION_INQUIRY_NAMESPACE, {
				inquiryId: exchangeId,
			}).attempt(protocol.currentCycleId),
			aggregateGeneration: readyGeneration ??
				graceCoordinator.snapshot.generation ?? {
					domainEpoch: domainFence.domainEpoch,
					activityGeneration: domainFence.activityGeneration,
					ownershipGeneration: claim.generation,
					localActivityGeneration,
				},
			invalidated: false,
			dispatchPending: false,
			submitted: false,
			protocol,
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

	const applyEffect = (
		effect: Exclude<ControllerEffect, { kind: "notify" }>,
		_ctx?: RuntimeContext,
	): void => {
		if (currentController() === null) return;
		switch (effect.kind) {
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
		let opened: ActiveDecision | null = null;
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
			if (effect.kind === "openDecisionWindow") opened = activeDecision;
		}
		if (transition.applied) {
			localActivityGeneration += 1;
			observeAggregate();
		}
		const latestGeneration = graceCoordinator.snapshot.generation;
		if (opened !== null && latestGeneration !== null) {
			opened.aggregateGeneration = latestGeneration;
		}
	};

	const getTriggerStatus = (): WatchdogTriggerStatus => {
		const claim = getMainClaim();
		const controller = currentController(claim);
		const controllerSnapshot = controller?.snapshot;
		const domain = options.processDomain?.snapshot;
		const pendingMessages = hasPendingMessages();
		let blocker: WatchdogTriggerBlocker | null = null;
		if (claim === null || !owns(claim)) blocker = "not-main";
		else if (!configReady || controllerSnapshot === undefined)
			blocker = "config-loading";
		else if (!controllerSnapshot.locked) blocker = "unlocked";
		else if (controllerSnapshot.exhausted) blocker = "exhausted";
		else if (controllerSnapshot.decisionFailed) blocker = "decision-failed";
		else if (pendingFinalization !== null) blocker = "decision-finalizing";
		else if (
			controllerSnapshot.decisionOpen ||
			activeDecision !== null ||
			selfDecisionRun.kind !== "none"
		)
			blocker = "decision-open";
		else if (pendingMessages) blocker = "pending-messages";
		else if (!localIdle()) blocker = "local-agent-busy";
		else if (!externalHubIdle() || domain?.allIdle === false)
			blocker = "observable-agent-busy";

		const grace = graceCoordinator.snapshot;
		return {
			main: claim !== null && owns(claim),
			locked: controllerSnapshot?.locked ?? null,
			attempt: controllerSnapshot?.attempt ?? null,
			maxRetries: config.maxRetries,
			blocker,
			gracePhase: grace.phase,
			graceRemainingMs:
				grace.phase === "grace" && grace.deadlineMs !== null
					? Math.max(0, Math.ceil(grace.deadlineMs - now()))
					: null,
			observableBusyCount: options.hub.snapshot.busyCount,
			domainBusyParticipants: domain?.busyParticipants ?? null,
		};
	};

	const aggregateInput = (): {
		readonly allIdle: boolean;
		readonly generation: ActivityGeneration;
		readonly claim: HubMainClaim | null;
		readonly fence: DomainFence;
	} => {
		const claim = getMainClaim();
		const controller = currentController(claim);
		const domain = options.processDomain?.snapshot;
		const fence = domain?.fence ?? {
			domainEpoch: "local",
			activityGeneration: 0n,
		};
		const controllerEligible =
			controller?.snapshot.locked === true &&
			!controller.snapshot.exhausted &&
			!controller.snapshot.decisionFailed &&
			!controller.snapshot.decisionOpen;
		const pendingMessages = hasPendingMessages();
		const allIdle =
			!stopped &&
			configReady &&
			claim !== null &&
			owns(claim) &&
			(domain === undefined
				? options.hub.snapshot.allObservableIdle
				: domain.allIdle) &&
			externalHubIdle() &&
			localIdle() &&
			!pendingMessages &&
			controllerEligible &&
			activeDecision === null &&
			pendingFinalization === null &&
			pendingInquiryCleanup === null &&
			selfDecisionRun.kind === "none";
		return {
			allIdle,
			generation: {
				domainEpoch: fence.domainEpoch,
				activityGeneration: fence.activityGeneration,
				ownershipGeneration: claim?.generation ?? 0,
				localActivityGeneration,
			},
			claim,
			fence,
		};
	};

	observeAggregate = (): void => {
		const input = aggregateInput();
		graceCoordinator.update({
			allIdle: input.allIdle,
			generation: input.generation,
		});
	};

	qualifyReady = (generation): void => {
		void (async () => {
			// Timer expiry performs a fresh official Pi query before any decision logic.
			const ctx = sessionContext;
			if (ctx === null || !probePiAgentState(ctx).idle) return;
			const before = aggregateInput();
			if (
				!before.allIdle ||
				before.claim === null ||
				!sameActivityGeneration(
					graceCoordinator.snapshot.generation,
					generation,
				)
			) {
				return;
			}
			if (options.processDomain !== undefined) {
				let confirmed = false;
				try {
					confirmed = await options.processDomain.confirm(before.fence);
				} catch {
					disableDomain();
					return;
				}
				if (!confirmed) {
					if (
						graceCoordinator.snapshot.phase !== "ready" ||
						!sameActivityGeneration(
							graceCoordinator.snapshot.generation,
							generation,
						)
					) {
						return;
					}
					graceCoordinator.invalidate();
					return;
				}
			}
			if (!probePiAgentState(ctx).idle) return;
			const after = aggregateInput();
			if (
				!after.allIdle ||
				after.claim === null ||
				!sameActivityGeneration(after.generation, generation) ||
				!sameActivityGeneration(
					graceCoordinator.snapshot.generation,
					generation,
				) ||
				graceCoordinator.snapshot.phase !== "ready"
			) {
				return;
			}
			readyGeneration = generation;
			const controller = currentController(after.claim);
			if (controller !== null) {
				applyTransition(controller.beginDecision(), undefined, {
					claim: after.claim,
				});
			}
			readyGeneration = null;
		})();
	};

	const reconcileIdle = (): void => observeAggregate();

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
			if (!snapshot.allIdle) return;
			try {
				if (!(await options.processDomain.confirm(snapshot.fence))) return;
			} catch {
				disableDomain();
				return;
			}
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
			graceCoordinator.dispose();
			graceCoordinator = createGraceCoordinator();
			readyGeneration = null;
			localActivityGeneration += 1;
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
			observeAggregate();
		}
	};

	const unsubscribe = options.hub.subscribe(() => {
		if (stopped) return;
		if (!publishingOwnHubObservation) {
			localActivityGeneration += 1;
			invalidateActiveDecision(true);
		}
		syncHubState();
	});

	function invalidateActiveDecision(force = false): void {
		const active = activeDecision;
		const controller = options.controllerHolder.controller;
		if (active === null || active.invalidated || controller === null) return;
		const snapshot = options.processDomain?.snapshot;
		if (
			!force &&
			snapshot !== undefined &&
			snapshot.fence.domainEpoch === active.domainFence.domainEpoch &&
			snapshot.fence.activityGeneration ===
				active.domainFence.activityGeneration
		) {
			return;
		}
		if (active.submitted || selfRunFor(active)) {
			// Invalidating the decision rejects its outcome, but an assistant run that
			// has already started still belongs to this internal exchange. Retain only
			// its redaction identity until message_end/agent_settled so stale XML cannot
			// enter TUI history or session persistence. `selfRunFor` covers the narrow
			// agent_start -> correlated message_start interval.
			quarantinedDecision = {
				exchangeId: active.exchangeId,
				cycleId: active.protocol.currentCycleId,
				inputObserved: active.submitted,
			};
		}
		active.invalidated = true;
		const fold = retainInquiryCleanup(active, "invalidated");
		localActivityGeneration += 1;
		selfDecisionRun = { kind: "none" };
		capturedDecisionResponse = null;
		decisionAssistantToSplice = null;
		pendingFinalization = null;
		clearLiveStatus();
		applyTransition(
			controller.invalidateDecision(active.decisionId),
			undefined,
			{
				claim: active.claim,
			},
		);
		if (fold !== null) retryInquiryCleanup();
		observeAggregate();
	}

	const unsubscribeDomain = options.processDomain?.subscribe(
		(_snapshot, source) => {
			if (stopped || !domainReady || source === "local") return;
			invalidateActiveDecision();
			syncHubState();
		},
	);

	const activeGenerationCurrent = (active: ActiveDecision): boolean => {
		const current = graceCoordinator.snapshot.generation;
		return (
			current !== null &&
			sameActivityGeneration(current, active.aggregateGeneration)
		);
	};

	const withDecisionFence = async (
		active: ActiveDecision,
		effect: () => void,
	): Promise<boolean> => {
		if (!activeGenerationCurrent(active) || !allIdleForClaim(active.claim))
			return false;
		if (options.processDomain !== undefined) {
			let confirmed = false;
			try {
				confirmed = await options.processDomain.confirm(active.domainFence);
			} catch {
				disableDomain();
				return false;
			}
			if (!confirmed) {
				invalidateActiveDecision(true);
				return false;
			}
		}
		observeAggregate();
		if (!activeGenerationCurrent(active) || !allIdleForClaim(active.claim))
			return false;
		effect();
		return activeGenerationCurrent(active) && allIdleForClaim(active.claim);
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
			activeGenerationCurrent(active) &&
			owns(active.claim) &&
			domainIdle() &&
			externalHubIdle() &&
			localIdle() &&
			!hasPendingMessages();
		if (!readyToFinalize()) {
			deferDecisionOnBusy(active);
			return false;
		}
		// Exact claim carried by this decision exchange — not a live re-lookup.
		const claim = active.claim;
		if (options.processDomain !== undefined) {
			if (!readyToFinalize()) return false;
			let confirmed = false;
			try {
				confirmed = await options.processDomain.confirm(active.domainFence);
			} catch {
				disableDomain();
				return false;
			}
			if (!confirmed) {
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
			deferDecisionOnBusy(active);
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
			if (!readyToFinalize()) return false;
		}

		const controllerBeforeCommit =
			options.controllerHolder.controller?.snapshot;
		pendingFinalization = null;
		const finalization = active.protocol.commitResponse(cycleId, plan);

		if (finalization.outcome === "reask") {
			if (stopIfStale(claim)) return false;
			if (!readyToFinalize()) {
				// Local Pi became busy after this invalid response was committed but
				// before the re-ask could dispatch. Defer the whole exchange so the
				// next settle cannot re-commit or consume another attempt.
				deferDecisionOnBusy(active);
				return false;
			}
			if (
				stopIfStale(claim) ||
				!readyToFinalize() ||
				finalization.reaskPrompt === undefined ||
				!active.protocol.advanceAfterReask(cycleId)
			) {
				silentlyAbandonDecision();
				return false;
			}
			if (stopIfStale(claim) || !readyToFinalize()) {
				deferDecisionOnBusy(active);
				return false;
			}
			active.inquiry.complete();
			active.inquiry = createInquiryRuntime(DECISION_INQUIRY_NAMESPACE, {
				inquiryId: active.exchangeId,
			}).attempt(active.protocol.currentCycleId);
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
				active.inquiry.complete();
			} catch {
				retainInquiryCleanup(active);
				retryInquiryCleanup();
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
			const reasonType = finalization.reasonType;
			const reason = finalization.reason;
			if (
				typeof reasonType !== "string" ||
				reasonType.length === 0 ||
				typeof reason !== "string" ||
				reason.length === 0
			) {
				return false;
			}
			const deferAcceptedContinue = (): false => {
				options.controllerHolder.controller?.rollbackValidContinue();
				active.invalidated = true;
				clearLiveStatus();
				return false;
			};
			if (stopIfStale(claim)) return false;
			if (!allIdleForClaim(claim)) return deferAcceptedContinue();
			if (options.processDomain !== undefined) {
				let confirmed = false;
				try {
					confirmed = await options.processDomain.confirm(active.domainFence);
				} catch {
					disableDomain();
					return false;
				}
				if (!confirmed) return deferAcceptedContinue();
				if (!allIdleForClaim(claim)) return deferAcceptedContinue();
			}
			if (!allIdleForClaim(claim)) return deferAcceptedContinue();
			try {
				options.pi.appendEntry<ContinueEntry>(CONTINUE_ENTRY_TYPE, {
					reasonType,
					reason,
				});
			} catch (error) {
				options.controllerHolder.controller?.rollbackValidContinue();
				appendStatus({
					kind: "other-error",
					exchangeId: active.exchangeId,
					cycleId: finalCycleId,
					message: originalErrorMessage(error),
				});
				// No automatic continuation without durable visible evidence.
				silentlyAbandonDecision();
				return false;
			}
			if (stopIfStale(claim)) return false;
			try {
				emitSemanticHook(
					options.pi.events,
					createWatchdogContinuedEnvelope({
						REASON_TYPE: reasonType,
						REASON: reason,
					}),
				);
			} catch {
				// Listener failures never gate continuation.
			}
			if (stopIfStale(claim)) return false;
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
				active.inquiry.complete({
					customType: "pi-continue-watchdog:continuation",
					content: config.continuePrompt,
				});
			} catch {
				if (!allIdleForClaim(claim)) return deferAcceptedContinue();
				retainInquiryCleanup(active);
				retryInquiryCleanup();
				silentlyAbandonDecision();
				return false;
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
			active.inquiry.complete();
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
			retainInquiryCleanup(active);
			retryInquiryCleanup();
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

	const handleDecisionMessageEnd = (
		event: MessageEndEvent,
		ctx?: ExtensionContext,
	) => {
		if (ctx !== undefined) {
			retryInquiryCleanup();
			observeLiveState(ctx, {
				preserveGeneration: selfDecisionRun.kind !== "none",
			});
		}
		if (quarantinedDecision !== null && event.message.role === "assistant") {
			return {
				message: neutralizeDecisionAssistant(
					{
						...event.message,
						...(isAbortedAssistant(event.message)
							? { stopReason: "stop" as const }
							: {}),
					},
					quarantinedDecision.exchangeId,
					quarantinedDecision.cycleId,
				),
			};
		}
		// Suppress the aborted assistant of a watchdog decision preempted by user
		// input so the TUI does not show `Operation aborted` for the internal run.
		// The TUI renders abort text from `stopReason`, so neutralize both fields;
		// this only ever applies to the watchdog's own preempted internal turn.
		if (
			event.message.role === "assistant" &&
			((suppressDecisionAbort && isAbortedAssistant(event.message)) ||
				isPreemptedAssistant(event.message)) &&
			decisionAssistantToSplice !== null
		) {
			return {
				message: neutralizeDecisionAssistant(
					{
						...event.message,
						stopReason: "stop" as const,
						errorMessage: PREEMPTED_DECISION_ERROR,
					},
					decisionAssistantToSplice.exchangeId,
					decisionAssistantToSplice.cycleId,
				),
			};
		}
		const active = activeDecision;
		if (
			active === null ||
			!active.submitted ||
			pendingFinalization !== null ||
			event.message.role !== "assistant" ||
			isErroredAssistant(event.message) ||
			!options.hub.isCurrentMain(active.claim)
		) {
			return undefined;
		}
		if (isAbortedAssistant(event.message)) {
			return {
				message: {
					...event.message,
					content: [],
				},
			};
		}
		const cycleId = active.protocol.currentCycleId;
		const captured = active.inquiry.capture(event.message);
		if (captured === null) return undefined;
		const response = normalizeAssistantDecisionResponse({
			...event.message,
			content: [{ type: "text", text: captured }],
		});
		capturedDecisionResponse = { active, cycleId, response };
		// The current prompt's run is over; until the next prompt (re-ask,
		// continue, or fold) is actually sent, an unrelated run must not be
		// misattributed as this decision's answer.
		active.dispatchPending = false;
		active.submitted = false;

		const validation = validateDecisionResponse(
			response,
			config.reasonTypes,
			config.continueReasonTypes,
		);
		const audit: DecisionAuditEntry = validation.valid
			? validation.decision.kind === "continue"
				? {
						version: 1,
						exchangeId: active.exchangeId,
						cycleId,
						outcome: "continue",
						reasonType: validation.decision.reasonType,
						reason: validation.decision.reason,
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
			message: active.inquiry.neutralize(event.message),
		};
	};

	const handleAgentEnd = (event: AgentEndEvent): void => {
		if (quarantinedDecision !== null) {
			// Keep blocking and hiding until authoritative agent_settled. Some hosts
			// emit message_end after agent_end, so clearing here could leak output.
			return;
		}
		const active = activeDecision;
		if (active?.dispatchPending && !active.submitted && !active.invalidated) {
			// A foreign run may end before the correlated decision message_start is
			// observed. It cannot supply or consume the watchdog decision response.
			deferDecisionOnBusy(active);
			return;
		}
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

	const handleMessageStart = async (
		event: { readonly message: unknown },
		ctx?: ExtensionContext,
	): Promise<void> => {
		const message = event.message as {
			readonly role?: unknown;
			readonly customType?: unknown;
			readonly details?: {
				readonly inquiryId?: unknown;
				readonly attempt?: unknown;
			};
		};
		const current = activeDecision;
		if (ctx !== undefined) {
			observeLiveState(ctx, {
				preserveGeneration:
					current?.inquiry.matchesPrompt(message) === true ||
					(current !== null && selfRunFor(current)),
			});
		}
		if (quarantinedDecision !== null) {
			// Once the exact custom input has correlated this quarantine to a Pi run,
			// retain it across every assistant/tool-result message until agent_settled.
			// Before correlation, fail closed on the first non-matching input so an
			// unrelated run can never have its assistant redacted.
			if (quarantinedDecision.inputObserved) return;
			const matchesQuarantine =
				message.role === "custom" &&
				message.customType === "pi-continue-watchdog:inquiry" &&
				message.details?.inquiryId === quarantinedDecision.exchangeId &&
				message.details?.attempt === quarantinedDecision.cycleId;
			if (matchesQuarantine) quarantinedDecision.inputObserved = true;
			else quarantinedDecision = null;
			return;
		}
		const active = activeDecision;
		if (active === null || active.invalidated || !owns(active.claim)) return;
		const isCurrentDecision = active.inquiry.matchesPrompt(message);
		if (
			active.submitted &&
			!isCurrentDecision &&
			(message.role === "user" || message.role === "custom")
		) {
			deferDecisionOnBusy(active);
			return;
		}
		if (!active.dispatchPending) return;
		if (!isCurrentDecision) {
			deferDecisionOnBusy(active);
			return;
		}
		active.dispatchPending = false;
		active.submitted = true;
		selfDecisionRun = {
			kind: "confirmed",
			exchangeId: active.exchangeId,
			cycleId: active.protocol.currentCycleId,
		};
		observeAggregate();
	};

	const observeLiveState = (
		ctx = sessionContext,
		observationOptions?: { readonly preserveGeneration?: boolean },
	): boolean => {
		if (ctx === null || stopped) return false;
		retryInquiryCleanup();
		const { idle, busy } = probePiAgentState(ctx);
		localAiBusy = busy;
		if (!observationOptions?.preserveGeneration) localActivityGeneration += 1;
		if (attachment !== null) {
			publishingOwnHubObservation = true;
			try {
				if (idle) options.hub.markIdle(attachment);
				else options.hub.markBusy(attachment);
			} finally {
				publishingOwnHubObservation = false;
			}
		} else {
			observeAggregate();
		}
		if (domainReady && !domainFatal && options.processDomain !== undefined) {
			void domainWrite(
				() =>
					options.processDomain?.reportIdle(options.attachmentInstance, idle) ??
					Promise.resolve(),
			);
		}
		return idle;
	};

	const registerLifecycle = (): void => {
		options.pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			++lifecycleGeneration;
			localActivityGeneration += 1;
			sessionContext = ctx;
			localAiBusy = probePiAgentState(ctx).busy;
			if (options.processDomain !== undefined) {
				let initialAttachComplete = false;
				let initialDomainExitRequested = false;
				const exitForInitialDomainFailure = (error: Error): boolean => {
					if (
						initialAttachComplete ||
						initialDomainExitRequested ||
						!isProcessDomainFatalError(error)
					) {
						return false;
					}
					initialDomainExitRequested = true;
					options.fatalExit?.fail(error, ctx);
					return true;
				};
				try {
					await options.processDomain.attach(options.attachmentInstance, {
						getIdle: () =>
							sessionContext === null
								? false
								: probePiAgentState(sessionContext).idle,
						onFatal: (error) => {
							if (exitForInitialDomainFailure(error)) {
								disableDomain();
								return;
							}
							handleRuntimeDomainFailure();
						},
					});
					initialAttachComplete = true;
					domainAttached = true;
					domainReady = true;
				} catch (error) {
					const attachError =
						error instanceof Error ? error : new Error("process domain failed");
					disableDomain();
					exitForInitialDomainFailure(attachError);
					return;
				}
			}
			if (stopped || domainFatal) return;
			const bound = options.hub.bind({
				instance: options.attachmentInstance,
				sessionId: ctx.sessionManager.getSessionId(),
				hasUI: ctx.hasUI,
				initialBusy: localAiBusy,
			});
			attachment = bound.attachment;
			syncHubState();
			await configLoad;
			if (!stopped && probePiAgentState(ctx).idle)
				recoverPreemptedDecisionAssistants(ctx);
		});

		options.pi.on("agent_start", async (_event, ctx) => {
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
			const provisionalInternal =
				active !== null &&
				!active.invalidated &&
				owns(active.claim) &&
				((active.dispatchPending && !active.submitted) ||
					(active.submitted && selfRunFor(active)));
			if (provisionalInternal && active !== null) {
				selfDecisionRun = {
					kind: active.submitted ? "confirmed" : "provisional",
					exchangeId: active.exchangeId,
					cycleId: active.protocol.currentCycleId,
				};
			} else {
				selfDecisionRun = { kind: "none" };
			}
			observeLiveState(ctx, { preserveGeneration: provisionalInternal });
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
		});

		// A real user input (interactive or RPC) that arrives while a submitted
		// watchdog decision is running must preempt it. Pi keeps the original user
		// message queued when we return `continue`; do not re-send it. Abort only
		// the watchdog decision, neutralize its aborted assistant, and persist a
		// foldable preempted marker. Extension-injected messages never preempt.
		options.pi.on("input", (event, ctx) => {
			const active = activeDecision;
			if (event.source !== "interactive" && event.source !== "rpc") {
				observeLiveState(ctx);
				return;
			}
			selfDecisionRun = { kind: "none" };
			observeLiveState(ctx);
			if (
				active === null ||
				active.invalidated ||
				!active.submitted ||
				!owns(active.claim)
			) {
				return { action: "continue" };
			}
			suppressDecisionAbort = true;
			decisionAssistantToSplice = {
				exchangeId: active.exchangeId,
				cycleId: active.protocol.currentCycleId,
			};
			deferDecisionOnBusy(active, "preempted", true);
			try {
				ctx.abort();
			} catch {
				// The handle is already terminal even when host abort fails.
			}
			retryInquiryCleanup();
			return { action: "continue" };
		});

		(options.pi as ExtensionAPI & Partial<UninterruptibleMessageEndAPI>).on(
			"message_end",
			handleDecisionMessageEnd,
			{
				uninterruptible: true,
			},
		);
		options.pi.on("agent_end", (event, ctx) => {
			observeLiveState(ctx, {
				preserveGeneration: selfDecisionRun.kind !== "none",
			});
			handleAgentEnd(event);
		});

		// While a decision is open, block ordinary tools before execution. The
		// agent loop continues so the final assistant XML can still be validated.
		options.pi.on("tool_call", (_event, ctx) => {
			observeLiveState(ctx, {
				preserveGeneration: selfDecisionRun.kind !== "none",
			});
			if (quarantinedDecision !== null) {
				return {
					block: true,
					reason: DECISION_TOOL_BLOCK_REASON,
				};
			}
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
			retryInquiryCleanup();
			const preserveGeneration = selfDecisionRun.kind !== "none";
			if (stopped || !observeLiveState(ctx, { preserveGeneration })) return;

			if (quarantinedDecision !== null) {
				quarantinedDecision = null;
				suppressDecisionAbort = false;
			}
			const spliceBeforeNextTurn = decisionAssistantToSplice;
			if (selfDecisionRun.kind === "provisional") {
				const pending = activeDecision;
				selfDecisionRun = { kind: "none" };
				if (pending !== null) deferDecisionOnBusy(pending);
			}
			if (!isCurrentMain() || options.controllerHolder.controller === null)
				return;

			if (
				spliceBeforeNextTurn !== null &&
				probePiAgentState(ctx).idle &&
				pendingFinalization === null &&
				decisionAssistantToSplice === spliceBeforeNextTurn
			) {
				spliceDecisionAssistant(ctx);
			}

			const active = activeDecision;
			if (active?.dispatchPending && !active.submitted && !active.invalidated) {
				deferDecisionOnBusy(active);
			} else {
				finalizeActiveDecision("missing");
			}
			const continued = await deliverPending(ctx);
			if (!continued && probePiAgentState(ctx).idle)
				spliceDecisionAssistant(ctx);
			if (!continued) await maybePublishUserReady();
		});
	};

	const shutdown = async (ctx = sessionContext ?? undefined): Promise<void> => {
		if (stopped) return;
		const detachedIdle =
			ctx === undefined ? true : probePiAgentState(ctx).idle;
		stopped = true;
		lifecycleGeneration += 1;
		localActivityGeneration += 1;
		quarantinedDecision = null;
		graceCoordinator.dispose();
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
			try {
				await options.processDomain.detach(
					options.attachmentInstance,
					detachedIdle,
				);
			} catch {
				// Runtime coordination is already disabled and local teardown is complete.
			}
		}
	};

	return {
		get controller(): LockDecisionController | null {
			return options.controllerHolder.controller;
		},
		get config(): ContinueWatchdogConfig {
			return { ...config };
		},
		getTriggerStatus,
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
