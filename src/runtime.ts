import { randomUUID } from "node:crypto";

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { probePiAgentState } from "pi-extension-utils/pi-agent-state";

import {
	type ActivityGeneration,
	createActivityGraceCoordinator,
} from "./activity-grace.js";
import {
	WATCHDOG_STATUS_ENTRY_TYPE,
	type WatchdogStatusEntry,
} from "./commands.js";
import {
	BUILT_IN_CONFIG,
	BUILT_IN_JEV_WAIT_CHECK,
	type ContinueWatchdogConfig,
} from "./config.js";
import { type LoadedConfig, loadRuntimeConfig } from "./config-loader.js";
import {
	CANCELLED_WATCHDOG_RUN_ERROR,
	CONTINUATION_MESSAGE_TYPE,
} from "./context-fold.js";
import {
	type ControllerEffect,
	type ControllerTransition,
	createLockDecisionController,
	type LockDecisionController,
} from "./controller.js";
import type { FatalExitAdapter } from "./fatal-exit.js";
import type {
	HubAttachment,
	HubAttachmentInstance,
	HubMainClaim,
	ObservableAgentHub,
} from "./hub.js";
import {
	buildJevReason,
	classifyJevWait,
	finalAssistantText,
	type JevFetch,
	type JevVerdict,
	resolveJevEndpoint,
} from "./jev-wait-gate.js";
import {
	type DomainFence,
	isProcessDomainFatalError,
	type ProcessDomainCoordinator,
} from "./process-domain.js";
import {
	createUserReadyEnvelope,
	createWatchdogContinuedEnvelope,
	emitSemanticHook,
	type UserReadyValues,
} from "./semantic-hook.js";
import {
	createUnlockToolDefinition,
	MAX_UNLOCK_REVIEW_REJECTIONS,
	registerUnlockTool,
	reviewUnlockAttempt,
	type UnlockToolHost,
	unlockToolUserReadyValues,
} from "./unlock-tool.js";
import {
	createContinueWatchdogEvent,
	createExhaustedWatchdogEvent,
	formatContinueWatchdogEvent,
	formatExhaustedWatchdogEvent,
	WATCHDOG_EVENT_MESSAGE_TYPE,
} from "./watchdog-event.js";

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

const WATCHDOG_STATE_WIDGET_KEY = "pi-continue-watchdog:state";

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

/** True for the cancelled watchdog-owned continuation assistant. */
function isDirectContinuationAssistant(
	message: unknown,
	exchangeId: string,
): boolean {
	if (typeof message !== "object" || message === null) return false;
	const details = (message as { readonly details?: unknown }).details;
	if (typeof details !== "object" || details === null) return false;
	const continuation = (details as { readonly piContinuation?: unknown })
		.piContinuation;
	if (
		typeof continuation !== "object" ||
		continuation === null ||
		(continuation as { readonly exchangeId?: unknown }).exchangeId !==
			exchangeId
	)
		return false;
	return true;
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
	/** Fired once per control acquisition when the effective config is committed. */
	readonly onConfigReady?: (config: ContinueWatchdogConfig) => void;
	/** jev wait gate seams; defaults are global fetch and process.env. */
	readonly jevWait?: {
		readonly fetchFn?: JevFetch;
		readonly env?: Readonly<Record<string, string | undefined>>;
	};
}

/** Final assistant entry of the settled run (no user message after it). */
function latestAssistantEntry(
	ctx: ExtensionContext,
): { readonly id: string; readonly text: string } | null {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "message") continue;
		const role = (entry.message as { readonly role?: unknown }).role;
		if (role === "user") return null;
		if (role !== "assistant") continue;
		const text = finalAssistantText(entry.message);
		return text === undefined ? null : { id: entry.id, text };
	}
	return null;
}

export type WatchdogTriggerBlocker =
	| "not-main"
	| "config-loading"
	| "unlocked"
	| "exhausted"
	| "observable-agent-busy"
	| "local-agent-busy"
	| "pending-messages"
	| "continuation-in-flight";

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
	 * Drop in-flight continuation/timer work after a controller lock/unlock
	 * transition so a later settle cannot continue stale work.
	 */
	clearOperationalPendingWork(): void;
	/** Cancel only an exact watchdog-owned run during a human unlock. */
	handleManualUnlock(ctx: RuntimeContext, claim: HubMainClaim): void;
	/** Retain terminal-error unlock intent; publication waits for aggregate idle. */
	retainErrorUnlock(claim: HubMainClaim): void;
	/**
	 * Start a fresh cycle through the full silent unlock-cleanup-lock sequence.
	 * The exact current-main claim is fenced across every re-entrant effect.
	 */
	restartLockCycle(
		ctx?: RuntimeContext,
		options?: { readonly notifyLocked?: boolean },
	): void;
	applyEffect(effect: ControllerEffect, ctx?: RuntimeContext): void;
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

function originalErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return typeof error === "string" && error.trim().length > 0
		? error
		: "Unknown error";
}

/**
 * Compose one attachment's idle timer, unlock tool, direct continuation, and
 * Pi lifecycle. The process hub remains the only cross-attachment seam.
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
	let reviewCycleId = 0;
	let reviewRejections = 0;
	/** Binary AI lifecycle state: agent_start = busy, true agent_settled = idle. */
	let localAiBusy = true;
	let stopped = false;
	let watchdogOwnedRun: {
		readonly kind: "continuation";
		readonly claim: HubMainClaim;
		readonly exchangeId: string;
		phase: "pending-start" | "running";
		cancelRequested: boolean;
	} | null = null;
	let manualCancellation: {
		readonly kind: "continuation";
		readonly claim: HubMainClaim;
		readonly exchangeId: string;
	} | null = null;
	let decisionAssistantToSplice: {
		readonly kind: "continuation";
		readonly claim: HubMainClaim;
		readonly exchangeId: string;
	} | null = null;
	/** True from continuation send until its correlated message_start is seen. */
	let continuationDispatchPending = false;
	/** Retained for automatic unlock until the next all-idle settle. */
	let pendingUnlock: UserReadyValues | null = null;
	/** At-most-once semantic publication guard for the current aggregate-idle epoch. */
	let publishedForIdleEpoch = false;
	/** Retry exhaustion is persisted once per lock cycle, even across re-entrant activity. */
	let exhaustionEventPublished = false;
	let exhaustionEventPublicationInFlight = false;
	let stateStatusTui: { requestRender(): void } | null = null;
	let stateStatusWidgetRegistered = false;
	/** Distinguishes this runtime's synchronous hub report from child reports. */
	let publishingOwnHubObservation = false;
	/**
	 * At most one jev request per assistant entry id, shared by re-qualifications.
	 * Only started requests are cached, so a later key still enables the gate.
	 */
	// ponytail: session-lifetime map (one small promise per classified message); prune if sessions get huge.
	const jevClassifications = new Map<string, Promise<JevVerdict | null>>();
	/** Aborts the in-flight jev request on shutdown. */
	const jevAbort = new AbortController();

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

	const stateStatusProjection = (): {
		readonly activity: "idle" | "running";
		readonly enabled: boolean;
		readonly rootRunning: boolean;
		readonly busySubagents: number;
		readonly next: "continuing" | { readonly askInMs: number } | null;
	} | null => {
		const ctx = sessionContext;
		const claim = getMainClaim();
		const controller = currentController(claim);
		if (
			stopped ||
			ctx === null ||
			ctx.mode !== "tui" ||
			!ctx.hasUI ||
			claim === null ||
			!owns(claim) ||
			!configReady ||
			controller === null
		) {
			return null;
		}
		const rootRunning = localAiBusy;
		const localBusySubagents = Math.max(
			0,
			options.hub.snapshot.busyCount - (rootRunning ? 1 : 0),
		);
		const busySubagents =
			localBusySubagents +
			Math.max(0, options.processDomain?.snapshot.busyParticipants ?? 0);
		let next: "continuing" | { readonly askInMs: number } | null = null;
		if (continuationDispatchPending || watchdogOwnedRun !== null) {
			next = "continuing";
		} else {
			const grace = graceCoordinator.snapshot;
			if (grace.phase === "grace" && grace.deadlineMs !== null) {
				next = { askInMs: Math.max(0, grace.deadlineMs - now()) };
			}
		}
		return {
			activity: rootRunning || busySubagents > 0 ? "running" : "idle",
			enabled: controller.snapshot.locked,
			rootRunning,
			busySubagents,
			next,
		};
	};

	const stateStatusActors = (
		rootRunning: boolean,
		busySubagents: number,
		compact = false,
	): string => {
		if (compact) {
			if (rootRunning && busySubagents > 0) return `R+${busySubagents}`;
			if (rootRunning) return "R";
			return busySubagents > 0 ? `S${busySubagents}` : "-";
		}
		const subagents = `${busySubagents} observed subagent${busySubagents === 1 ? "" : "s"}`;
		if (rootRunning && busySubagents > 0) return `root + ${subagents}`;
		if (rootRunning) return "root";
		return busySubagents > 0 ? subagents : "none";
	};

	const nextLabel = (
		next: "continuing" | { readonly askInMs: number } | null,
		compact = false,
	): string => {
		if (next === "continuing") return "continuing";
		if (next === null) return "";
		const seconds = Math.ceil(next.askInMs / 1000);
		return compact ? `T-${seconds}s` : `continuing in ${seconds}s`;
	};

	const renderStateStatus = (
		width: number,
		theme: ExtensionContext["ui"]["theme"],
	): string[] => {
		const status = stateStatusProjection();
		if (status === null) return [];
		const safeWidth = Math.max(1, Math.floor(width));
		const third =
			status.next === null
				? stateStatusActors(status.rootRunning, status.busySubagents)
				: nextLabel(status.next);
		const thirdCompact =
			status.next === null
				? stateStatusActors(status.rootRunning, status.busySubagents, true)
				: nextLabel(status.next, true);
		const unlockHint = status.enabled
			? config.unlockShortcut === false
				? " · /unlock-continue-watchdog"
				: ` · ${config.unlockShortcut} unlock`
			: "";
		const full = `Continue Watchdog | ${status.activity} (${status.enabled ? "enabled" : "disabled"}${unlockHint}) | ${third}`;
		const compact = `CW | ${status.activity === "running" ? "run" : "idle"}/${status.enabled ? "on" : "off"} | ${thirdCompact}`;
		const line = visibleWidth(full) <= safeWidth ? full : compact;
		return [truncateToWidth(theme.fg("dim", line), safeWidth)];
	};

	const clearStateStatus = (): void => {
		const ctx = sessionContext;
		if (
			ctx !== null &&
			stateStatusWidgetRegistered &&
			typeof ctx.ui.setWidget === "function"
		) {
			try {
				ctx.ui.setWidget(WATCHDOG_STATE_WIDGET_KEY, undefined);
			} catch {
				// A stale host may reject cleanup during shutdown or demotion.
			}
		}
		stateStatusWidgetRegistered = false;
		stateStatusTui = null;
		stopStateStatusTick();
	};

	let stateStatusTick: RuntimeTimerHandle | null = null;
	const stopStateStatusTick = (): void => {
		if (stateStatusTick !== null) clock.clearTimeout(stateStatusTick);
		stateStatusTick = null;
	};
	const stateStatusCountdownActive = (): boolean =>
		stateStatusTui !== null && stateStatusProjection()?.next != null;
	const scheduleStateStatusTick = (): void => {
		if (stateStatusTick !== null) return;
		const handle = clock.setTimeout(function tick(): void {
			stateStatusTick = null;
			stateStatusTui?.requestRender();
			if (stateStatusCountdownActive()) {
				stateStatusTick = clock.setTimeout(tick, 1000);
				if (
					"unref" in stateStatusTick &&
					typeof stateStatusTick.unref === "function"
				) {
					stateStatusTick.unref();
				}
			}
		}, 1000);
		stateStatusTick = handle;
		if ("unref" in handle && typeof handle.unref === "function") {
			handle.unref();
		}
	};

	const refreshStateStatus = (): void => {
		const ctx = sessionContext;
		if (
			stateStatusProjection() === null ||
			ctx === null ||
			typeof ctx.ui.setWidget !== "function"
		) {
			stopStateStatusTick();
			clearStateStatus();
			return;
		}
		if (stateStatusCountdownActive()) scheduleStateStatusTick();
		else stopStateStatusTick();
		if (!stateStatusWidgetRegistered) {
			try {
				ctx.ui.setWidget(
					WATCHDOG_STATE_WIDGET_KEY,
					(tui, theme) => {
						stateStatusTui = tui;
						return {
							render: (width: number) => renderStateStatus(width, theme),
							invalidate() {},
							dispose() {
								stateStatusTui = null;
								stateStatusWidgetRegistered = false;
							},
						};
					},
					{ placement: "belowEditor" },
				);
				stateStatusWidgetRegistered = true;
			} catch {
				stateStatusWidgetRegistered = false;
				stateStatusTui = null;
			}
			return;
		}
		stateStatusTui?.requestRender();
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

	/**
	 * Invalidate runtime-local operational state after a controller transition.
	 * Does not change controller lock/cycle accounting.
	 */
	const clearOperationalPendingWork = (): void => {
		reviewCycleId += 1;
		localActivityGeneration += 1;
		continuationDispatchPending = false;
		if (manualCancellation === null) decisionAssistantToSplice = null;
		pendingUnlock = null;
		exhaustionEventPublished = false;
		exhaustionEventPublicationInFlight = false;
		observeAggregate();
	};

	const disableDomain = (): void => {
		if (domainFatal) return;
		domainFatal = true;
		domainReady = false;
		clearOperationalPendingWork();
	};

	const handleRuntimeDomainFailure = (): void => {
		disableDomain();
		observeAggregate();
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

	const spliceContinuationAssistant = (ctx: ExtensionContext): void => {
		const pending = decisionAssistantToSplice;
		decisionAssistantToSplice = null;
		if (pending === null) return;
		try {
			const spliceEntry = (options.pi as ExtensionAPI & Partial<SpliceEntryAPI>)
				.spliceEntry;
			if (typeof spliceEntry !== "function") return;
			const branch = ctx.sessionManager.getBranch();
			let spliceId: string | null = null;
			for (let index = branch.length - 1; index >= 0; index -= 1) {
				const entry = branch[index];
				if (
					entry?.type === "message" &&
					(entry.message as { readonly role?: unknown })?.role ===
						"assistant" &&
					(entry.message as { readonly errorMessage?: unknown })
						.errorMessage === CANCELLED_WATCHDOG_RUN_ERROR &&
					isDirectContinuationAssistant(entry.message, pending.exchangeId)
				) {
					spliceId = entry.id;
					break;
				}
			}
			if (spliceId !== null) spliceEntry.call(options.pi, spliceId);
		} catch {
			// Tree cleanup is best effort and never replaces message clearing/folding.
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

	const externalHubIdle = (): boolean => {
		const snapshot = options.hub.snapshot;
		const selfBusy =
			continuationDispatchPending && attachment !== null && !localIdle();
		return (
			snapshot.main !== null && snapshot.busyCount - (selfBusy ? 1 : 0) === 0
		);
	};

	const allIdleForClaim = (claim: HubMainClaim): boolean =>
		owns(claim) &&
		externalHubIdle() &&
		domainIdle() &&
		(localIdle() || continuationDispatchPending) &&
		!hasPendingMessages();

	let observeAggregate = (): void => {};
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

	const handleManualUnlock = (
		ctx: RuntimeContext,
		claim: HubMainClaim,
	): void => {
		if (!owns(claim)) return;
		let target: {
			readonly kind: "continuation";
			readonly claim: HubMainClaim;
			readonly exchangeId: string;
		} | null = null;
		if (
			watchdogOwnedRun !== null &&
			watchdogOwnedRun.phase === "running" &&
			!watchdogOwnedRun.cancelRequested &&
			owns(watchdogOwnedRun.claim)
		) {
			target = {
				kind: "continuation",
				claim: watchdogOwnedRun.claim,
				exchangeId: watchdogOwnedRun.exchangeId,
			};
			watchdogOwnedRun.cancelRequested = true;
		}
		clearOperationalPendingWork();
		if (target === null || !owns(target.claim)) return;
		manualCancellation = target;
		decisionAssistantToSplice = target;
		try {
			ctx.abort();
		} catch {
			// The correlated cancellation target remains authoritative for cleanup.
		}
	};

	/**
	 * Publish the automatic continuation for a qualified idle generation.
	 * Consumes one attempt, sends the visible continuation message, correlates
	 * the watchdog-owned run, and publishes the `watchdog-continued` hook.
	 * Rolls the attempt back when publication or ownership fails.
	 */
	const dispatchContinuation = (claim: HubMainClaim): void => {
		const controller = currentController(claim);
		if (controller === null || !owns(claim)) return;
		const transition = controller.recordAutomaticContinue();
		if (!transition.applied) return;

		const exchangeId = createExchangeId();
		const watchdogEvent = createContinueWatchdogEvent({
			occurredAtMs: now(),
		});
		const content = formatContinueWatchdogEvent(
			watchdogEvent,
			config.continuePrompt,
		);
		continuationDispatchPending = true;
		try {
			watchdogOwnedRun = {
				kind: "continuation",
				claim,
				exchangeId,
				phase: "pending-start",
				cancelRequested: false,
			};
			options.pi.sendMessage(
				{
					customType: CONTINUATION_MESSAGE_TYPE,
					content,
					display: true,
					details: {
						version: 1,
						exchangeId,
						generation: claim.generation,
						event: watchdogEvent,
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} catch (error) {
			watchdogOwnedRun = null;
			continuationDispatchPending = false;
			controller.rollbackAutomaticContinue();
			if (owns(claim)) {
				appendStatus({
					kind: "other-error",
					exchangeId,
					cycleId: transition.snapshot.attempt,
					message: originalErrorMessage(error),
				});
			}
			observeAggregate();
			return;
		}
		if (!owns(claim)) {
			// Ownership demoted across the send; the message is harmless steering,
			// but no hook may claim it and the demoted owner's attempt is undone.
			if (watchdogOwnedRun?.exchangeId === exchangeId) watchdogOwnedRun = null;
			continuationDispatchPending = false;
			controller.rollbackAutomaticContinue();
			return;
		}
		// Pi's sendMessage is fire-and-forget: persistence of a triggerTurn custom
		// message happens asynchronously on its message_start/message_end. The
		// `watchdog-continued` hook is therefore published only when that exact
		// correlated message starts (see handleMessageStart), never on the
		// synchronous return here.
		// The continuation turn is now the only local busy source; reconcile so
		// hosts/tests that have not yet delivered agent_start still see it.
		observeAggregate();
	};

	/** Publish the continuation hook once its correlated message is durable. */
	const publishContinuedHook = (claim: HubMainClaim): void => {
		if (!owns(claim)) return;
		try {
			emitSemanticHook(options.pi.events, createWatchdogContinuedEnvelope());
		} catch {
			// Listener failures never gate continuation.
		}
	};

	qualifyReady = (generation): void => {
		void (async () => {
			// Timer expiry performs a fresh official Pi query before any dispatch.
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
			const claim = stillQualified(ctx, generation);
			if (claim === null) return;
			const jevConfig = config.jevWaitCheck ?? BUILT_IN_JEV_WAIT_CHECK;
			const entry = jevConfig.enabled ? latestAssistantEntry(ctx) : null;
			if (entry === null) {
				dispatchContinuation(claim);
				return;
			}
			let request = jevClassifications.get(entry.id);
			if (request === undefined) {
				const endpoint = await resolveJevEndpoint(
					jevConfig,
					ctx.modelRegistry,
					options.jevWait?.env,
				).catch(() => undefined);
				// Credential lookup is async: never start a request for a state or
				// entry that is no longer current.
				if (
					stillQualified(ctx, generation) === null ||
					!owns(claim) ||
					latestAssistantEntry(ctx)?.id !== entry.id
				) {
					return;
				}
				// A concurrent qualification may have started the request meanwhile.
				request = jevClassifications.get(entry.id);
				if (request === undefined && endpoint !== undefined) {
					request = classifyJevWait(entry.text, {
						...endpoint,
						model: jevConfig.model,
						timeoutMs: jevConfig.timeoutMs,
						signal: jevAbort.signal,
						fetchFn: options.jevWait?.fetchFn,
					}).catch(() => null);
					jevClassifications.set(entry.id, request);
				}
			}
			const verdict = request === undefined ? null : await request;
			// Anything that changed during the await makes the verdict stale: activity,
			// ownership (part of the generation), lock, or the classified entry itself.
			if (
				stillQualified(ctx, generation) === null ||
				!owns(claim) ||
				(jevConfig.enabled && latestAssistantEntry(ctx)?.id !== entry.id)
			) {
				return;
			}
			if (
				verdict?.choice === "waiting_user" &&
				verdict.confidence >= jevConfig.confidenceThreshold
			) {
				const reason = buildJevReason(entry.text);
				if (
					reviewRejections > 0 &&
					reviewRejections < MAX_UNLOCK_REVIEW_REJECTIONS
				) {
					const review = await reviewUnlockAttempt(
						unlockToolHost,
						ctx,
						{ reasonType: "WAIT_USER", reason },
						undefined,
						() =>
							stillQualified(ctx, generation) !== null &&
							owns(claim) &&
							latestAssistantEntry(ctx)?.id === entry.id,
					);
					if (
						review.outcome === "stale" ||
						stillQualified(ctx, generation) === null ||
						!owns(claim) ||
						latestAssistantEntry(ctx)?.id !== entry.id
					)
						return;
					if (review.outcome === "rejected") {
						dispatchContinuation(claim);
						return;
					}
				}
				applyJevUnlock(ctx, claim, reason);
				return;
			}
			dispatchContinuation(claim);
		})();
	};

	/** Claim when the exact qualified generation still holds, else null. */
	const stillQualified = (
		ctx: ExtensionContext,
		generation: ActivityGeneration,
	): HubMainClaim | null => {
		if (sessionContext !== ctx || !probePiAgentState(ctx).idle) return null;
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
			return null;
		}
		return after.claim;
	};

	/**
	 * jev judged the final output to be a question for the user: unlock like the
	 * tool does (no attempt consumed) and publish user-ready now, because no
	 * later settle will arrive for this already-idle run.
	 */
	const applyJevUnlock = (
		ctx: ExtensionContext,
		claim: HubMainClaim,
		reason: string,
	): void => {
		const controller = currentController(claim);
		if (controller === null || !owns(claim)) return;
		if (!controller.recordAiUnlock().applied) return;
		pendingUnlock = {
			STOP_KIND: "AI_UNLOCK",
			REASON_TYPE: "WAIT_USER",
			REASON: reason,
		};
		publishedForIdleEpoch = false;
		localActivityGeneration += 1;
		observeAggregate();
		try {
			ctx.ui.notify(
				"Continue watchdog unlocked · WAIT_USER (jev: final output asks the user)",
			);
		} catch {
			// Hosts without notify still get the user-ready hook.
		}
		void maybePublishUserReady();
	};

	const applyEffect = (
		_effect: ControllerEffect,
		_ctx?: RuntimeContext,
	): void => {
		// The controller now emits only notify effects; retained for the
		// command/abort-outcome seams that apply transitions generically.
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
		if (transition.applied) {
			localActivityGeneration += 1;
			observeAggregate();
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
		else if (continuationDispatchPending || watchdogOwnedRun !== null)
			blocker = "continuation-in-flight";
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
			controller?.snapshot.locked === true && !controller.snapshot.exhausted;
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
			!continuationDispatchPending &&
			watchdogOwnedRun === null;
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
			notBeforeMs: 0,
		});
		refreshStateStatus();
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
		reviewRejections = 0;
		applyTransition(lockTransition, ctx, {
			suppressNotify: restartOptions?.notifyLocked !== true,
			claim,
		});
		if (stopIfStale(claim)) return;
		reconcileIdle();
	};

	/**
	 * Publish neutral `user-ready` at most once for the current all-idle epoch.
	 * Only AI unlock, error unlock, and exhaustion terminal states produce a
	 * signal. Ordinary unlocked idle never publishes by inference.
	 */
	const maybePublishUserReady = async (): Promise<void> => {
		if (
			stopped ||
			!configReady ||
			!isCurrentMain() ||
			!options.hub.snapshot.allObservableIdle ||
			!domainIdle() ||
			!localIdle() ||
			publishedForIdleEpoch
		) {
			return;
		}

		const claim = getMainClaim();
		const controller = currentController(claim);
		if (claim === null || controller === null) return;

		let envelope = null as ReturnType<typeof createUserReadyEnvelope> | null;
		const unlockIntent = pendingUnlock;
		if (unlockIntent !== null) {
			envelope = createUserReadyEnvelope(unlockIntent);
		} else {
			const snapshot = controller.snapshot;
			if (snapshot.locked && snapshot.exhausted) {
				envelope = createUserReadyEnvelope({ STOP_KIND: "EXHAUSTED" });
			}
		}

		if (envelope === null || !allIdleForClaim(claim)) return;
		if (options.processDomain !== undefined) {
			const publicationGeneration = localActivityGeneration;
			const snapshot = options.processDomain.snapshot;
			if (!snapshot.allIdle) return;
			try {
				if (!(await options.processDomain.confirm(snapshot.fence))) return;
			} catch {
				disableDomain();
				return;
			}
			if (!allIdleForClaim(claim)) return;
			// A lock-cycle reset (unlock or fresh lock) may have run while the
			// cross-process confirmation was pending. Require the exact captured
			// claim, controller, and local generation, then re-derive the terminal
			// envelope from live state before publishing.
			if (localActivityGeneration !== publicationGeneration) return;
			const liveController = currentController(claim);
			if (liveController !== controller) return;
			if (unlockIntent !== null) {
				if (pendingUnlock !== unlockIntent) return;
			} else {
				const live = liveController.snapshot;
				let liveEnvelope: ReturnType<typeof createUserReadyEnvelope> | null =
					null;
				if (live.locked && live.exhausted) {
					liveEnvelope = createUserReadyEnvelope({ STOP_KIND: "EXHAUSTED" });
				}
				if (
					liveEnvelope === null ||
					liveEnvelope.values?.STOP_KIND !== envelope.values?.STOP_KIND
				) {
					return;
				}
				envelope = liveEnvelope;
			}
			if (publishedForIdleEpoch) return;
		}
		if (envelope.values?.STOP_KIND === "EXHAUSTED") {
			if (!exhaustionEventPublished) {
				if (exhaustionEventPublicationInFlight) return;
				exhaustionEventPublicationInFlight = true;
				try {
					const exhaustedEvent = createExhaustedWatchdogEvent({
						occurredAtMs: now(),
					});
					options.pi.sendMessage(
						{
							customType: WATCHDOG_EVENT_MESSAGE_TYPE,
							content: formatExhaustedWatchdogEvent(exhaustedEvent),
							display: true,
							details: exhaustedEvent,
						},
						{ triggerTurn: false, deliverAs: "steer" },
					);
					if (!owns(claim)) return;
					exhaustionEventPublished = true;
				} catch {
					return;
				} finally {
					exhaustionEventPublicationInFlight = false;
				}
			}
			if (!allIdleForClaim(claim)) return;
			const live = currentController(claim)?.snapshot;
			if (live === undefined || !live.locked || !live.exhausted) return;
		}
		if (unlockIntent !== null) {
			if (pendingUnlock !== unlockIntent) return;
			pendingUnlock = null;
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
		watchdogOwnedRun = null;
		manualCancellation = null;
		decisionAssistantToSplice = null;
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

	/** Apply a validated AI unlock from the tool: controller transition, cleared
	 * pending continuation, and retained user-ready intent. Called from tool
	 * execute while the run is still live. */
	const applyAiUnlockFromTool = (call: {
		readonly reasonType: string;
		readonly reason: string;
	}): boolean => {
		const claim = getMainClaim();
		const controller = currentController(claim);
		if (claim === null || controller === null || !owns(claim)) return false;
		const transition = controller.recordAiUnlock();
		if (!transition.applied) return false;
		continuationDispatchPending = false;
		watchdogOwnedRun = null;
		decisionAssistantToSplice = null;
		pendingUnlock = unlockToolUserReadyValues(call);
		publishedForIdleEpoch = false;
		localActivityGeneration += 1;
		observeAggregate();
		return true;
	};

	const unlockToolHost: UnlockToolHost = {
		isCurrentMain,
		isLocked: () => currentController()?.snapshot.locked === true,
		applyAiUnlock: applyAiUnlockFromTool,
		reviewState: () =>
			isCurrentMain() && currentController()?.snapshot.locked === true
				? { cycleId: reviewCycleId, rejections: reviewRejections }
				: null,
		recordReviewRejection: (cycleId) => {
			if (
				cycleId !== reviewCycleId ||
				!isCurrentMain() ||
				currentController()?.snapshot.locked !== true ||
				reviewRejections >= MAX_UNLOCK_REVIEW_REJECTIONS
			)
				return null;
			return ++reviewRejections;
		},
		get jev() {
			return {
				config: config.jevWaitCheck ?? BUILT_IN_JEV_WAIT_CHECK,
				registry: sessionContext?.modelRegistry,
				env: options.jevWait?.env,
				fetchFn: options.jevWait?.fetchFn,
				signal: jevAbort.signal,
			};
		},
	};

	const acquireControl = (claim: HubMainClaim): void => {
		if (stopped || !options.hub.isCurrentMain(claim)) return;
		ownedClaim = claim;
		if (options.injectedController) {
			options.controllerHolder.controller = injectedController;
			configReady = injectedController !== null;
			if (configReady) {
				options.onConfigReady?.(config);
				registerRuntimeUnlockTool();
			}
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
			localActivityGeneration += 1;
			options.controllerHolder.controller =
				createLockDecisionController(config);
			configReady = true;
			registerRuntimeUnlockTool();
			for (const diagnosticItem of loaded.diagnostics) {
				if (!owns(claim)) {
					dropControl();
					return;
				}
				try {
					ctx.ui.notify(diagnosticItem.message, diagnosticItem.severity);
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
			if (owns(claim)) {
				options.onConfigReady?.(config);
				syncHubState();
			}
		})().finally(() => {
			if (ownedClaim === claim) configLoad = null;
		});
	};

	/** Register the unlock tool once per process, root processes only. */
	let unlockToolRegistered = false;
	const registerRuntimeUnlockTool = (): void => {
		if (unlockToolRegistered || !isRootProcess()) return;
		unlockToolRegistered = true;
		registerUnlockTool(
			options.pi,
			createUnlockToolDefinition(config, unlockToolHost),
		);
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

	/**
	 * Explicitly reclaim main when the hub has none. Detach never auto-promotes;
	 * remaining attachments elect the deterministic preferred candidate here.
	 */
	const ensureMain = (): void => {
		if (stopped || attachment === null) return;
		if (options.hub.snapshot.main !== null) return;
		options.hub.reclaimMain(attachment);
	};

	const unsubscribe = options.hub.subscribe(() => {
		if (stopped) return;
		if (!publishingOwnHubObservation) localActivityGeneration += 1;
		syncHubState();
	});

	const unsubscribeDomain = options.processDomain?.subscribe(
		(_snapshot, source) => {
			if (stopped || !domainReady || source === "local") return;
			syncHubState();
		},
	);

	const handleMessageStart = async (
		event: { readonly message: unknown },
		ctx?: ExtensionContext,
	): Promise<void> => {
		const message = event.message as {
			readonly role?: unknown;
			readonly customType?: unknown;
			readonly details?: {
				readonly exchangeId?: unknown;
				readonly generation?: unknown;
			};
		};
		if (ctx !== undefined) observeLiveState(ctx);
		const ownedRun = watchdogOwnedRun;
		if (
			ownedRun?.phase === "running" &&
			(message.role === "user" || message.role === "custom")
		) {
			// A foreign input can start inside the same Pi agent lifecycle, without a
			// new agent_start/agent_settled pair. From this message onward the active
			// run is no longer solely watchdog-owned, so a later manual unlock must
			// not abort it under stale continuation identity.
			watchdogOwnedRun = null;
			return;
		}
		if (ownedRun?.phase === "pending-start") {
			const isOwnContinuation =
				message.role === "custom" &&
				message.customType === CONTINUATION_MESSAGE_TYPE &&
				message.details?.exchangeId === ownedRun.exchangeId &&
				owns(ownedRun.claim);
			if (isOwnContinuation) {
				ownedRun.phase = "running";
				continuationDispatchPending = false;
				publishContinuedHook(ownedRun.claim);
				observeAggregate();
				return;
			}
			watchdogOwnedRun = null;
			continuationDispatchPending = false;
			observeAggregate();
			return;
		}
		if (continuationDispatchPending) {
			continuationDispatchPending = false;
			observeAggregate();
		}
	};

	/**
	 * Neutralize the aborted assistant of a manually cancelled watchdog-owned
	 * continuation run: empty content, cancelled marker, and a correlation the
	 * context fold can remove. Registered uninterruptible so abort settle still
	 * replaces the finalized message.
	 */
	const handleContinuationMessageEnd = (
		event: MessageEndEvent,
	): { readonly message: MessageEndEvent["message"] } | undefined => {
		const cancellation = manualCancellation;
		if (
			cancellation === null ||
			event.message.role !== "assistant" ||
			event.message.stopReason !== "aborted"
		)
			return undefined;
		const message = event.message as typeof event.message & {
			readonly details?: unknown;
		};
		const details =
			typeof message.details === "object" && message.details !== null
				? { ...(message.details as Record<string, unknown>) }
				: {};
		return {
			message: {
				...message,
				stopReason: "stop" as const,
				errorMessage: CANCELLED_WATCHDOG_RUN_ERROR,
				content: [],
				// The correlation rides on the replacement message; AssistantMessage
				// has no details field, but message_end replacements may carry extras.
				details: {
					...details,
					piContinuation: { exchangeId: cancellation.exchangeId },
				},
			} as MessageEndEvent["message"],
		};
	};

	const observeLiveState = (ctx = sessionContext): boolean => {
		if (ctx === null || stopped) return false;
		const { idle, busy } = probePiAgentState(ctx);
		localAiBusy = busy;
		localActivityGeneration += 1;
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
				try {
					await options.processDomain.attach(options.attachmentInstance, {
						getIdle: () =>
							sessionContext === null
								? false
								: probePiAgentState(sessionContext).idle,
						onFatal: (error) => {
							if (isProcessDomainFatalError(error)) {
								options.fatalExit?.fail(error, ctx);
								disableDomain();
								return;
							}
							handleRuntimeDomainFailure();
						},
					});
					domainAttached = true;
					domainReady = true;
				} catch (error) {
					const attachError =
						error instanceof Error ? error : new Error("process domain failed");
					disableDomain();
					if (isProcessDomainFatalError(attachError)) {
						options.fatalExit?.fail(attachError, ctx);
					}
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
		});

		options.pi.on("agent_start", async (_event, ctx) => {
			const claim = getMainClaim();
			const controller = currentController(claim);
			observeLiveState(ctx);
			if (claim !== null && controller !== null) {
				const transition = controller.ensureLocked();
				if (transition.applied) {
					reviewRejections = 0;
					// Fresh silent lock: controller first, then operational cleanup.
					clearOperationalPendingWork();
					applyTransition(transition, undefined, {
						suppressNotify: true,
						claim,
					});
				}
				// Already locked: preserve cycle; do not clear active work.
			}
		});

		options.pi.on("agent_end", (_event, ctx) => {
			observeLiveState(ctx);
		});

		// Tree navigation changes the branch without a turn: invalidate the current
		// qualification and re-arm the fence so an old-branch verdict cannot act.
		// Pi emits session_tree while its branch-summary controller is still set, so
		// ctx.isIdle() reads busy here; do not probe. The fence expiry re-probes.
		options.pi.on("session_tree", () => {
			reviewCycleId += 1;
			localActivityGeneration += 1;
			observeAggregate();
		});

		(options.pi as ExtensionAPI & Partial<UninterruptibleMessageEndAPI>).on(
			"message_end",
			handleContinuationMessageEnd,
			{
				uninterruptible: true,
			},
		);

		options.pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
			// A continuation still pending-start at settlement never became a run
			// (Pi's asynchronous send failed before its message_start): return the
			// attempt it consumed. No watchdog-continued hook was published for it.
			const unstarted = watchdogOwnedRun;
			if (unstarted?.phase === "pending-start") {
				currentController(unstarted.claim)?.rollbackAutomaticContinue();
			}
			watchdogOwnedRun = null;
			continuationDispatchPending = false;
			// manualCancellation belongs to the run whose abort produced this
			// authoritative settle. Foreign input may already have cleared active
			// ownership, so retirement cannot depend on watchdogOwnedRun still being
			// present. The independent splice target remains until presentation cleanup.
			if (manualCancellation !== null) {
				manualCancellation = null;
			}
			if (stopped || !observeLiveState(ctx)) return;

			if (!isCurrentMain() || options.controllerHolder.controller === null)
				return;

			if (decisionAssistantToSplice !== null && probePiAgentState(ctx).idle) {
				spliceContinuationAssistant(ctx);
			}

			if (probePiAgentState(ctx).idle) {
				await maybePublishUserReady();
				// A qualified aggregate-idle state may already arm the next
				// continuation; observeAggregate inside reconcileIdle covers it.
				reconcileIdle();
			}
		});
	};

	const shutdown = async (ctx = sessionContext ?? undefined): Promise<void> => {
		if (stopped) return;
		const detachedIdle = ctx === undefined ? true : probePiAgentState(ctx).idle;
		stopped = true;
		jevAbort.abort();
		lifecycleGeneration += 1;
		localActivityGeneration += 1;
		watchdogOwnedRun = null;
		manualCancellation = null;
		decisionAssistantToSplice = null;
		continuationDispatchPending = false;
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
		handleManualUnlock,
		retainErrorUnlock(claim): void {
			if (!owns(claim) || currentController(claim)?.snapshot.locked !== false)
				return;
			pendingUnlock = { STOP_KIND: "ERROR_UNLOCK" };
		},
		restartLockCycle,
		applyEffect,
		applyTransition,
		reconcileIdle,
		handleMessageStart,
		registerLifecycle,
		shutdown,
	};
}
