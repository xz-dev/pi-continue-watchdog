import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	type InputEvent,
	type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { probePiAgentState } from "pi-extension-utils/pi-agent-state";
import {
	createInquiryRuntime,
	type InquiryAttemptHandle,
	type InquiryFoldMessage,
} from "pi-extension-utils/pi-inquiry";
import { PreemptTakeover } from "pi-extension-utils/preempt-takeover";

import {
	type ActivityGeneration,
	createActivityGraceCoordinator,
} from "./activity-grace.js";
import {
	AI_UNLOCK_ENTRY_TYPE,
	type AiUnlockEntry,
	WATCHDOG_STATUS_ENTRY_TYPE,
	type WatchdogStatusEntry,
} from "./commands.js";
import { BUILT_IN_CONFIG, type ContinueWatchdogConfig } from "./config.js";
import { type LoadedConfig, loadRuntimeConfig } from "./config-loader.js";
import {
	CANCELLED_WATCHDOG_RUN_ERROR,
	CONTINUATION_MESSAGE_TYPE,
	createDecisionFoldMessage,
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_INQUIRY_NAMESPACE,
	findCancelledContinuationAssistantEntryId,
	findDecisionAssistantEntryId,
	findPreemptedDecisionAssistantEntryIds,
	INQUIRY_MARKER_ENTRY_TYPE,
	markerDetails,
	neutralizeDecisionAssistant,
	PREEMPTED_DECISION_ERROR,
	parseDecisionFoldDetails,
} from "./context-fold.js";
import {
	type ControllerEffect,
	type ControllerTransition,
	createLockDecisionController,
	type LockDecisionController,
} from "./controller.js";
import {
	buildDecisionPrompt,
	buildDecisionReaskPrompt,
	createDecisionProtocolSession,
	DECISION_TOOL_BLOCK_REASON,
	DECISION_TOOL_NAME,
	type DecisionProtocolPlan,
	type DecisionProtocolSession,
	type DecisionValidation,
	formatDecisionFailedNotification,
	MALFORMED_DECISION_RESPONSE_ERROR,
	MISSING_DECISION_CALL_ERROR,
	normalizeAssistantDecisionResponse,
	validateDecisionArguments,
} from "./decision-protocol.js";
import {
	createDecisionToolDefinition,
	type DecisionToolHost,
	registerDecisionTool,
} from "./decision-tool.js";
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
	buildReviewSourceView,
	createReviewSourceMetadata,
	type ReviewAuditMetadata,
	type ReviewSourceMetadata,
	readReviewHistory,
} from "./review-context.js";
import {
	createUserReadyEnvelope,
	createWatchdogContinuedEnvelope,
	emitSemanticHook,
	type UserReadyValues,
} from "./semantic-hook.js";
import {
	buildUnlockReviewProjection,
	buildUnlockReviewRequest,
	discoverUnlockReviewService,
	type ReviewServiceLike,
	runUnlockReview,
	UNLOCK_REVIEW_PROJECTION_VERSION,
	type UnlockReviewCandidate,
	type UnlockReviewProjection,
	type UnlockReviewReport,
} from "./unlock-review.js";
import {
	createContinueWatchdogEvent,
	createDecisionFailedWatchdogEvent,
	createExhaustedWatchdogEvent,
	formatContinueWatchdogEvent,
	formatDecisionFailedWatchdogEvent,
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

const WATCHDOG_STATUS_WIDGET_KEY = "pi-continue-watchdog:status";
const WATCHDOG_STATE_WIDGET_KEY = "pi-continue-watchdog:state";

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
	protocol: DecisionProtocolSession;
	readonly domainFence: DomainFence;
	inquiry: InquiryAttemptHandle;
	aggregateGeneration: ActivityGeneration;
	invalidated: boolean;
	/** True while a public fire-and-forget dispatch awaits matching lifecycle. */
	dispatchPending: boolean;
	/** True only after Pi emits this decision's correlated custom message_start. */
	submitted: boolean;
	/** Review metadata recorded on the latest inquiry marker append, if any. */
	reviewMetadata: ReviewSourceMetadata | null;
	/** Persisted entry id of that marker, resolved post-append when readable. */
	markerEntryId: string | null;
	/** Persisted entry id of the correlated inquiry prompt record, if seen. */
	promptEntryId: string | null;
	/**
	 * Matching prompt observed at this extension's context callback. This is
	 * provisional evidence: Pi 0.85.1 can replace it in a later handler in the
	 * same emission. It does not satisfy the final-request consumption contract.
	 */
	contextConfirmed: boolean;
	/** Tool-call ids recorded from the finalized assistant batch before execution. */
	responseToolCallIds: ReadonlySet<string>;
	/** Result already staged by execute for the current attempt, once. */
	stagedResult: {
		readonly toolCallId: string;
		readonly validation: DecisionValidation;
	} | null;
	/**
	 * Exchange id of the initial decision inquiry this logical decision
	 * belongs to; a reconsideration carries the origin id so at most one
	 * semantic recheck can ever run for one logical decision.
	 */
	readonly logicalRootExchangeId: string;
	/** True when this inquiry is the single permitted semantic reconsideration. */
	readonly isReconsideration: boolean;
	/** Review disposition of the superseded candidate, for audit/history. */
	readonly challengedByReview?: UnlockReviewRecord;
	/** Challenge feedback text carried by this reconsideration inquiry. */
	readonly reconsiderationFeedback?: string;
}

interface PendingFinalization {
	readonly active: ActiveDecision;
	readonly cycleId: number;
	readonly plan: DecisionProtocolPlan;
	/**
	 * True when this unlock plan came from the semantic reconsideration
	 * inquiry; such a result is committed without another review.
	 */
	readonly reconsidered?: boolean;
	/** Set once the optional review (if any) reached a terminal disposition. */
	reviewSettled?: boolean;
	/** Terminal review disposition for audit/history; absent = not reviewed. */
	reviewDisposition?: "supported" | "challenged" | "incomplete";
}

/** One in-flight optional unlock review operation. */
interface PendingUnlockReview {
	readonly active: ActiveDecision;
	readonly cycleId: number;
	readonly plan: Extract<DecisionProtocolPlan, { readonly outcome: "unlock" }>;
	readonly abort: AbortController;
	/** Settled once the service call resolved and disposition was applied. */
	settled: boolean;
}

/** Versioned review association persisted on the owning session (custom entry). */
export interface UnlockReviewRecord {
	readonly version: 1;
	readonly projectionVersion: number;
	readonly exchangeId: string;
	readonly cycleId: number;
	readonly outcome: "supported" | "challenged" | "incomplete";
	readonly incompleteReason?: string;
	readonly backend?: string;
	readonly model?: string;
	readonly sourceHeadId?: string;
	readonly gaps?: number;
	readonly attemptCount?: number;
	readonly observationCoverage?: "complete" | "unavailable";
	readonly usage?: {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly costUsd: number;
		readonly missing: number;
	};
	readonly errorMessage?: string;
	readonly contextOverflow?: boolean;
	/** Exchange id of the replacement inquiry a challenge opened, once known. */
	readonly reconsiderExchangeId?: string;
}

export const UNLOCK_REVIEW_ENTRY_TYPE = "pi-continue-watchdog:unlock-review";

/**
 * Reconsideration feedback appended after the normal fixed decision prompt
 * following a definite challenge. It names the challenged claim,
 * distinguishes reviewer opinion from evidence, and re-asserts the unchanged
 * cw contract — the reviewer never authors the replacement verdict. The base
 * prompt must already contain the full configured reason lists, field limits
 * and assessment/delivery boundaries: appending challenge text after the
 * fixed contract keeps a custom decisionPrompt from silently dropping them.
 */
function buildReconsiderationFeedback(
	candidate: UnlockReviewCandidate,
): string {
	return (
		`An independent reviewer challenged your previous unlock decision ` +
		`(${JSON.stringify(candidate.reasonType)}: ${JSON.stringify(candidate.reason)}). ` +
		`The reviewer's challenge is an opinion, not new evidence and not a user decision; it may be wrong. ` +
		`Recheck the original user instructions, deliveries, tool envelopes and recorded human answers in this conversation. ` +
		`Then submit exactly one ${DECISION_TOOL_NAME} call under the same contract: keep unlock only if the stated stopping basis still holds on the evidence, otherwise choose an authorized continue. Do not let the reviewer's wording become your reason.`
	);
}

interface InquiryMarkerEntry {
	readonly version: 1;
	readonly exchangeId: string;
	readonly cycleId: number;
	/** Nested versioned review metadata; absent on legacy markers. */
	readonly review?: ReturnType<typeof createReviewSourceMetadata>;
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

type WatchdogOwnedRun = {
	readonly kind: "continuation";
	readonly claim: HubMainClaim;
	readonly exchangeId: string;
	readonly cycleId: number;
	phase: "pending-start" | "running";
	cancelRequested: boolean;
};

type CancellationTarget = {
	readonly kind: "decision" | "continuation";
	readonly claim: HubMainClaim;
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
	/** Fired once per control acquisition when the effective config is committed. */
	readonly onConfigReady?: (config: ContinueWatchdogConfig) => void;
	/**
	 * Test seam: deterministic review service override. Production callers
	 * leave this unset so call-time `getJudgmentService()` discovery runs.
	 */
	readonly reviewService?: import("./unlock-review.js").ReviewServiceLike;
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
	/** Cancel only an exact watchdog-owned run during a human unlock. */
	handleManualUnlock(ctx: RuntimeContext, claim: HubMainClaim): void;
	/** Retain terminal-error unlock intent; publication waits for aggregate idle. */
	retainErrorUnlock(claim: HubMainClaim): void;
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

/**
 * Re-present the argument snapshot a staged verdict already validated,
 * preserving the accepted input identity — action kind, matched configured
 * reason spelling, and trimmed reason — so planResponse revalidates exactly
 * what execute accepted for this attempt instead of reconstructing arguments
 * from the uppercase outcome representation.
 */
function stagedVerdictArguments(validation: DecisionValidation): unknown {
	if (!validation.valid) return null;
	const decision = validation.decision;
	return {
		action: decision.kind,
		reason_type: decision.matchedReasonType,
		reason_content: decision.reason,
	};
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
		readonly plan: DecisionProtocolPlan;
	} | null = null;
	let decisionAssistantToSplice: CancellationTarget | null = null;
	let watchdogOwnedRun: WatchdogOwnedRun | null = null;
	let manualCancellation: CancellationTarget | null = null;
	let pendingFinalization: PendingFinalization | null = null;
	let pendingContinuationPublication: {
		readonly active: ActiveDecision;
		readonly cycleId: number;
		confirmed: (() => boolean | undefined) | null;
		charged: boolean;
		sending: boolean;
		readonly publicationCycle: number;
		readonly lifecycleGeneration: number;
		readonly generation: ActivityGeneration;
		readonly message: Parameters<ExtensionAPI["sendMessage"]>[0];
		readonly watchdogEvent: ReturnType<typeof createContinueWatchdogEvent>;
		readonly controller: LockDecisionController;
		readonly attempt: number;
		readonly body: string;
		readonly reasonType: string;
		readonly reason: string;
	} | null = null;
	/**
	 * User takeover capture shared from pi-extension-utils. 0.85.1 aborts
	 * asynchronously and drops queued steering, so the watchdog re-issues the
	 * takeover as a fresh turn after the preempted decision settles. The
	 * shared guard prevents the re-issued prompt from re-entering this
	 * capture path (re-entrancy guard).
	 */
	const pendingTakeover = new PreemptTakeover();
	let pendingTakeoverImages: InputEvent["images"];
	/** Retried until Pi accepts the exact correlated remove-fold. */
	let pendingInquiryCleanup: InquiryFoldMessage | null = null;
	/** Retained for automatic unlock until the next all-idle settle. */
	let pendingUnlock: UserReadyValues | null = null;
	/** Shared non-triggering events require a correlated branch receipt. */
	type SharedPublication = {
		readonly claim: HubMainClaim;
		readonly controller: LockDecisionController | null;
		readonly cycle: number;
		readonly message: Parameters<ExtensionAPI["sendMessage"]>[0];
		receipt: (() => boolean | undefined) | null;
		sending: boolean;
	};
	let publicationCycle = 0;
	let pendingTerminalPublication: {
		readonly publication: SharedPublication;
		readonly values: UserReadyValues;
		readonly active?: ActiveDecision;
		readonly content?: string;
		/**
		 * Quiet AI-unlock second artifact: the UI-only status entry. Publication
		 * completes only after the correlated remove-fold receipt AND this new
		 * branch entry are both confirmed; neither substitutes for the other.
		 */
		readonly statusEntry?: {
			readonly data: AiUnlockEntry;
			receipt: (() => boolean | undefined) | null;
			/**
			 * In-flight guard, mirroring SharedPublication.sending: a
			 * synchronous reentry (for example a hub state report triggered
			 * from inside appendEntry) must not create a second receipt or
			 * append a second status while the current confirmation is still
			 * executing.
			 */
			sending: boolean;
		};
	} | null = null;
	/** At-most-once semantic publication guard for the current aggregate-idle epoch. */
	let publishedForIdleEpoch = false;
	/** Retry exhaustion is persisted once per lock cycle, even across re-entrant activity. */
	let exhaustionEventPublished = false;
	let exhaustionEventPublicationInFlight = false;
	let activeStatus: WatchdogStatusEntry | null = null;
	let statusTui: { requestRender(): void } | null = null;
	let statusWidgetRegistered = false;
	let stateStatusTui: { requestRender(): void } | null = null;
	let stateStatusWidgetRegistered = false;
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

	const stateStatusProjection = (): {
		readonly activity: "idle" | "running";
		readonly enabled: boolean;
		readonly rootRunning: boolean;
		readonly busySubagents: number;
		readonly decision: "asking" | { readonly askInMs: number } | null;
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
		let decision: "asking" | { readonly askInMs: number } | null = null;
		if (
			activeDecision !== null ||
			selfDecisionRun.kind !== "none" ||
			pendingFinalization !== null
		) {
			decision = "asking";
		} else {
			const grace = graceCoordinator.snapshot;
			if (grace.phase === "grace" && grace.deadlineMs !== null) {
				decision = { askInMs: Math.max(0, grace.deadlineMs - now()) };
			}
		}
		return {
			activity: rootRunning || busySubagents > 0 ? "running" : "idle",
			enabled: controller.snapshot.locked,
			rootRunning,
			busySubagents,
			decision,
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

	const decisionLabel = (
		decision: "asking" | { readonly askInMs: number } | null,
		compact = false,
	): string => {
		if (decision === "asking") return "asking";
		if (decision === null) return "";
		const seconds = Math.ceil(decision.askInMs / 1000);
		return compact ? `T-${seconds}s` : `asking in ${seconds}s`;
	};

	const renderStateStatus = (
		width: number,
		theme: ExtensionContext["ui"]["theme"],
	): string[] => {
		const status = stateStatusProjection();
		if (status === null) return [];
		const safeWidth = Math.max(1, Math.floor(width));
		const third =
			status.decision === null
				? stateStatusActors(status.rootRunning, status.busySubagents)
				: decisionLabel(status.decision);
		const thirdCompact =
			status.decision === null
				? stateStatusActors(status.rootRunning, status.busySubagents, true)
				: decisionLabel(status.decision, true);
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
		stateStatusTui !== null && stateStatusProjection()?.decision != null;
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
		watchdogOutcome: "invalidated" | "preempted" = "invalidated",
	): InquiryFoldMessage | null => {
		const fold = active.inquiry.cancel();
		if (fold === null) return null;
		pendingInquiryCleanup = {
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
		const previousPublicationCycle = publicationCycle;
		publicationCycle += 1;
		pendingUnlockReview?.abort.abort();
		pendingUnlockReview = null;
		deferredReconsideration = undefined;
		const terminalDecision = pendingTerminalPublication?.active;
		pendingTerminalPublication = null;
		if (terminalDecision !== undefined) {
			retainInquiryCleanup(terminalDecision);
			retryInquiryCleanup();
		}
		const publication = pendingContinuationPublication;
		if (
			publication?.charged &&
			publication.publicationCycle === previousPublicationCycle &&
			publication.lifecycleGeneration === lifecycleGeneration &&
			owns(publication.active.claim) &&
			options.controllerHolder.controller === publication.controller &&
			(publication.confirmed === null || publication.confirmed() === false) &&
			publicationCycle === previousPublicationCycle + 1 &&
			options.controllerHolder.controller === publication.controller &&
			publication.controller.snapshot.attempt === publication.attempt &&
			!publication.controller.snapshot.decisionOpen
		) {
			publication.controller.rollbackValidContinue();
		}
		pendingContinuationPublication = null;
		localActivityGeneration += 1;
		if (activeDecision !== null) {
			retainInquiryCleanup(activeDecision);
			retryInquiryCleanup();
		}
		activeDecision = null;
		selfDecisionRun = { kind: "none" };
		if (manualCancellation === null) {
			suppressDecisionAbort = false;
			decisionAssistantToSplice = null;
		}
		capturedDecisionResponse = null;
		pendingFinalization = null;
		pendingContinuationPublication = null;
		clearLiveStatus();
		// Human/abort unlock must not inherit automatic terminal publication intent.
		pendingUnlock = null;
		exhaustionEventPublished = false;
		exhaustionEventPublicationInFlight = false;
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
			const branch = ctx.sessionManager.getBranch();
			const entryId =
				pending.kind === "continuation"
					? findCancelledContinuationAssistantEntryId(
							branch,
							pending.exchangeId,
							pending.cycleId,
						)
					: findDecisionAssistantEntryId(
							branch,
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

	/** Exact submitted decision or running continuation, excluding other cancellation paths. */
	const isCurrentWatchdogOwnedRun = (): boolean => {
		if (stopped || quarantinedDecision !== null || suppressDecisionAbort)
			return false;
		return (
			(activeDecision !== null &&
				!activeDecision.invalidated &&
				activeDecision.submitted &&
				owns(activeDecision.claim)) ||
			(watchdogOwnedRun?.phase === "running" &&
				!watchdogOwnedRun.cancelRequested &&
				owns(watchdogOwnedRun.claim))
		);
	};

	/**
	 * Local guard. Final-request authority itself rests on the accepted
	 * production seams: correlated-run matching plus the recorded batch
	 * identity at message_end, enforced with the fold/projection pipeline.
	 * External scheduling, authentic consumption metadata, and durable I/O
	 * remain explicit external assumptions, not local guarantees.
	 */
	const currentConsumedDecision = (): ActiveDecision | null => {
		const active = activeDecision;
		return !stopped &&
			active !== null &&
			!active.invalidated &&
			active.submitted &&
			active.contextConfirmed &&
			quarantinedDecision === null &&
			owns(active.claim) &&
			selfDecisionRun.kind === "confirmed" &&
			selfRunFor(active)
			? active
			: null;
	};

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
		if (active.invalidated || activeDecision !== active) return;
		const pending = pendingFinalization;
		// BUSY delays committing an already-consumed plan in its real window;
		// generation/ownership replacement still takes the invalidation path.
		if (
			cleanupOutcome === undefined &&
			active.isReconsideration &&
			pending?.active === active &&
			pending.cycleId === active.protocol.currentCycleId &&
			pending.plan.outcome !== "ignored" &&
			currentConsumedDecision() === active &&
			activeGenerationCurrent(active) &&
			options.controllerHolder.controller?.snapshot.decisionOpen === true
		) {
			return;
		}
		// Do not preserve a phase across a lifecycle/currentness replacement.
		if (
			cleanupOutcome === "preempted" ||
			!activeGenerationCurrent(active) ||
			!owns(active.claim)
		) {
			deferredReconsideration = undefined;
		}
		if (pendingUnlockReview?.active === active) {
			pendingUnlockReview.abort.abort();
			pendingUnlockReview = null;
		}
		if (
			cleanupOutcome === undefined &&
			activeGenerationCurrent(active) &&
			owns(active.claim) &&
			active.isReconsideration &&
			active.challengedByReview !== undefined &&
			active.reconsiderationFeedback !== undefined &&
			deferredReconsideration === undefined
		) {
			// Controller count is consumed responses, not dispatched attempt ids.
			const controllerSnapshot = options.controllerHolder.controller?.snapshot;
			const sameWindow = controllerSnapshot?.decisionOpen === true;
			deferredReconsideration = {
				feedback: active.reconsiderationFeedback,
				rootExchangeId: active.logicalRootExchangeId,
				challengedBy: active.challengedByReview,
				claim: active.claim,
				resumeCycleId: sameWindow
					? controllerSnapshot.invalidDecisionAttempts + 1
					: active.protocol.currentCycleId,
				invalidAttempts: sameWindow
					? controllerSnapshot.invalidDecisionAttempts
					: 0,
				lastInvalidError: sameWindow
					? controllerSnapshot.lastInvalidDecisionError
					: null,
			};
		}
		if (
			cleanupOutcome === undefined &&
			active.contextConfirmed &&
			(active.submitted || selfRunFor(active))
		) {
			quarantinedDecision = {
				exchangeId: active.exchangeId,
				cycleId: active.protocol.currentCycleId,
				inputObserved: active.submitted,
			};
		}
		active.invalidated = true;
		retainInquiryCleanup(active, cleanupOutcome ?? "invalidated");
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

	const handleManualUnlock = (
		ctx: RuntimeContext,
		claim: HubMainClaim,
	): void => {
		if (!owns(claim)) return;
		let target: CancellationTarget | null = null;
		const active = activeDecision;
		if (active?.submitted && owns(active.claim)) {
			target = {
				kind: "decision",
				claim: active.claim,
				exchangeId: active.exchangeId,
				cycleId: active.protocol.currentCycleId,
			};
			active.invalidated = true;
			retainInquiryCleanup(active, "preempted");
			activeDecision = null;
		} else if (
			watchdogOwnedRun?.phase === "running" &&
			!watchdogOwnedRun.cancelRequested &&
			owns(watchdogOwnedRun.claim)
		) {
			target = {
				kind: "continuation",
				claim: watchdogOwnedRun.claim,
				exchangeId: watchdogOwnedRun.exchangeId,
				cycleId: watchdogOwnedRun.cycleId,
			};
			watchdogOwnedRun.cancelRequested = true;
		}
		clearOperationalPendingWork();
		if (target === null || !owns(target.claim)) return;
		manualCancellation = target;
		decisionAssistantToSplice = target;
		suppressDecisionAbort = true;
		try {
			ctx.abort();
		} catch {
			// The correlated cancellation target remains authoritative for cleanup.
		}
		retryInquiryCleanup();
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

	let pendingUnlockReview: PendingUnlockReview | null = null;
	// A deferred reconsideration dispatch retains its semantic phase and
	// remaining format allowance. Valid pending publication stays in its
	// original consumed window; lifecycle replacement discards both.
	let deferredReconsideration:
		| {
				readonly feedback: string;
				readonly rootExchangeId: string;
				readonly challengedBy: UnlockReviewRecord;
				readonly claim: HubMainClaim;
				/** Cycle the resumed window re-enters at (retry same attempt). */
				readonly resumeCycleId: number;
				/** Already-charged invalid responses; restored after reopen. */
				readonly invalidAttempts: number;
				/** Last safe validator diagnostic for the deferred correction. */
				readonly lastInvalidError: string | null;
		  }
		| undefined;
	let pendingReconsiderationForOpen:
		| {
				readonly feedback: string;
				readonly rootExchangeId: string;
				readonly challengedBy: UnlockReviewRecord;
				readonly resumeCycleId?: number;
				readonly invalidAttempts?: number;
				readonly lastInvalidError?: string | null;
		  }
		| undefined;

	// A missing/incompatible service is reported once per runtime; other skips each time.
	let reviewUnavailableWarned = false;
	const warnReviewSkipped = (
		ctx: ExtensionContext,
		reason: string | undefined,
	): void => {
		const missing = reason === "unavailable" || reason === "incompatible";
		if (missing && reviewUnavailableWarned) return;
		if (missing) reviewUnavailableWarned = true;
		try {
			ctx.ui.notify(
				missing
					? `Unlock review skipped: pi-llm-as-jev review service is ${reason}. Unlocking without review.`
					: `Unlock review skipped (${reason ?? "incomplete"}). Unlocking without review.`,
				"warning",
			);
		} catch {
			// Non-TUI hosts may reject notify; the warning never gates the unlock.
		}
	};

	const reportReviewHistory = (ctx: ExtensionContext): void => {
		try {
			const history = readReviewHistory(ctx.sessionManager);
			const claim = getMainClaim();
			if (history.diagnostic !== undefined && claim !== null && owns(claim))
				appendStatus({
					kind: "other-error",
					exchangeId: history.records.at(-1)?.exchangeId ?? "recovery",
					cycleId: history.records.at(-1)?.cycleId ?? 0,
					message:
						"Review history incomplete: some native records or source associations are unavailable.",
				});
		} catch {
			// Diagnostic reads never restore authority or gate execution.
		}
	};

	/**
	 * Append one versioned review-association entry on the owning session.
	 * Optional persistence: failures disclose via bounded diagnostics and
	 * never relock, charge budget, or gate the outcome path.
	 */
	const appendUnlockReviewRecord = (
		recordCtx: ExtensionContext,
		record: UnlockReviewRecord,
	): void => {
		if (record.outcome === "incomplete")
			warnReviewSkipped(recordCtx, record.incompleteReason);
		try {
			options.pi.appendEntry<UnlockReviewRecord>(
				UNLOCK_REVIEW_ENTRY_TYPE,
				record,
			);
		} catch {
			try {
				appendStatus({
					kind: "other-error",
					exchangeId: record.exchangeId,
					cycleId: record.cycleId,
					message: "Unlock review history incomplete.",
				});
			} catch {
				// Diagnostics never gate execution.
			}
		}
	};

	/**
	 * Apply a settled service report to its pending review. Runs only inside
	 * deliverPending's guards: lifecycle invalidation aborts the in-flight
	 * request, and a stale settle that lands anyway cannot publish, relock,
	 * or charge the replacement cycle.
	 */
	const applyReviewOutcome = (
		ctx: ExtensionContext,
		state: PendingUnlockReview,
		projection: UnlockReviewProjection,
		report: UnlockReviewReport,
	): void => {
		const { active, cycleId, plan } = state;
		const recordBase = {
			version: 1 as const,
			projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
			exchangeId: active.exchangeId,
			cycleId,
			...(report.backend === undefined ? {} : { backend: report.backend }),
			...(report.model === undefined ? {} : { model: report.model }),
			...(projection.sourceHeadId === null
				? {}
				: { sourceHeadId: projection.sourceHeadId }),
			...(projection.gaps.length === 0 ? {} : { gaps: projection.gaps.length }),
			...(report.attemptCount === undefined
				? {}
				: { attemptCount: report.attemptCount }),
			...(report.observationCoverage === undefined
				? {}
				: { observationCoverage: report.observationCoverage }),
			...(report.usage === undefined ? {} : { usage: report.usage }),
			...(report.errorMessage === undefined
				? {}
				: { errorMessage: report.errorMessage }),
			...(report.contextOverflow === true ? { contextOverflow: true } : {}),
		};
		const pending = pendingFinalization;
		// Stale callback fence: the logical decision may have been replaced,
		// invalidated, or already committed. Only a still-current candidate
		// with the same pending finalization may proceed.
		if (
			pending === null ||
			pending.active !== active ||
			pending.cycleId !== cycleId ||
			active.invalidated ||
			currentConsumedDecision() !== active
		) {
			return;
		}
		pending.reviewSettled = true;
		if (report.outcome.kind === "challenged") {
			pending.reviewDisposition = "challenged";
			const record: UnlockReviewRecord = {
				...recordBase,
				outcome: "challenged",
			};
			openReconsideration(ctx, active, plan, record);
			return;
		}
		pending.reviewDisposition =
			report.outcome.kind === "supported" ? "supported" : "incomplete";
		appendUnlockReviewRecord(ctx, {
			...recordBase,
			outcome: report.outcome.kind === "supported" ? "supported" : "incomplete",
			...(report.outcome.kind === "incomplete"
				? { incompleteReason: report.outcome.reason }
				: {}),
		});
		// The still-current original candidate proceeds through the unchanged
		// commit path; incomplete is recorded, never relabelled as approval.
		void deliverPending(ctx);
	};

	/**
	 * A definite challenge supersedes the initial candidate without
	 * committing it and opens at most one separately owned reconsideration
	 * inquiry bound to the same logical decision.
	 */
	const openReconsideration = (
		ctx: ExtensionContext,
		active: ActiveDecision,
		plan: Extract<DecisionProtocolPlan, { readonly outcome: "unlock" }>,
		reviewRecord: UnlockReviewRecord,
	): void => {
		const claim = active.claim;
		const controller = options.controllerHolder.controller;
		if (
			controller === null ||
			!owns(claim) ||
			active.invalidated ||
			currentConsumedDecision() !== active
		)
			return;
		// The superseded initial candidate never commits. Close this decision
		// window without attempts, then begin the replacement inquiry under
		// the same lock cycle; only an accepted durable continuation may spend
		// continuation budget.
		pendingFinalization = null;
		// Capture the local generation before any external boundary: manual
		// unlock, takeover or restartLockCycle all run
		// clearOperationalPendingWork which bumps localActivityGeneration, so a
		// mismatch after the boundary proves this challenge is stale for the
		// replacement cycle.
		const challengeGeneration = localActivityGeneration;
		const reconsideration = {
			feedback: buildReconsiderationFeedback({
				action: "unlock",
				reasonType: plan.reasonType,
				reason: plan.reason,
			}),
			rootExchangeId: active.logicalRootExchangeId,
			challengedBy: reviewRecord,
		};
		// Retire the old phase BEFORE the reentrant fold dispatch: a user
		// takeover, manual unlock or lock-cycle restart inside sendMessage must
		// find no live review candidate and no usable challenge state. After the
		// boundary the exact fences are rechecked; ownership alone is not proof
		// the decision epoch survived.
		const fold = active.inquiry.cancel();
		active.invalidated = true;
		activeDecision = null;
		selfDecisionRun = { kind: "none" };
		if (fold !== null) {
			pendingInquiryCleanup = {
				...fold,
				details: {
					...fold.details,
					watchdogOutcome: "invalidated" as const,
				} as InquiryFoldMessage["details"],
			};
			retryInquiryCleanup();
		}
		// Exact post-boundary fences: a restartLockCycle or takeover fired from
		// the cleanup boundary must leave this stale challenge unable to open,
		// charge, publish or unlock on the replacement cycle.
		const liveController = options.controllerHolder.controller;
		const stillCurrent =
			liveController === controller &&
			owns(claim) &&
			!stopped &&
			isCurrentMain() &&
			liveController !== null &&
			// Any lifecycle replacement after the boundary bumps the local
			// generation; a mismatch strands the stale challenge.
			localActivityGeneration === challengeGeneration &&
			pendingFinalization === null &&
			activeDecision === null &&
			pendingUnlockReview === null;
		if (!stillCurrent) {
			// Old candidate never commits; the lock cycle stays under whatever
			// terminal state the boundary callback produced.
			return;
		}
		applyTransition(
			controller.invalidateDecision(active.decisionId),
			undefined,
			{ claim },
		);
		const transition = controller.beginDecision(now());
		if (!transition.applied) {
			// Cannot open the replacement inquiry: the superseded candidate is
			// never released; the lock cycle stays under existing accounting.
			silentlyAbandonDecision();
			return;
		}
		pendingReconsiderationForOpen = reconsideration;
		applyTransition(transition, undefined, { claim });
		pendingReconsiderationForOpen = undefined;
		const newActive: ActiveDecision | null =
			activeDecision as ActiveDecision | null;
		if (newActive !== null && owns(claim)) {
			const opened: ActiveDecision = newActive;
			appendUnlockReviewRecord(ctx, {
				...reviewRecord,
				reconsiderExchangeId: opened.exchangeId,
			});
		}
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

		if (!allIdleForClaim(active.claim)) {
			if (sendOptions?.deferOnBusy !== false) deferDecisionOnBusy(active);
			return false;
		}
		active.dispatchPending = true;
		active.submitted = false;
		const ctx = sessionContext;
		if (ctx !== null) reportReviewHistory(ctx);
		const review = (() => {
			if (ctx === null) return null;
			try {
				const view = buildReviewSourceView(
					ctx.sessionManager.buildContextEntries(),
				);
				// An empty evidence selection adds no model-facing supplement and
				// leaves the marker in its legacy shape; a failed projection takes
				// the same path so dispatch is never blocked by review data.
				if (view.selected.length === 0) return null;
				const metadata = createReviewSourceMetadata(view, {
					sessionId: ctx.sessionManager.getSessionId(),
					sessionFile: ctx.sessionManager.getSessionFile(),
				});
				return { prompt: `${decisionPrompt}\n\n${view.text}`, metadata };
			} catch {
				if (owns(active.claim))
					appendStatus({
						kind: "other-error",
						exchangeId: active.exchangeId,
						cycleId,
						message:
							"Review source view unavailable; native conversation retained.",
					});
				return null;
			}
		})();
		// Diagnostic appends can be reentrant, just like other status effects.
		if (
			active.invalidated ||
			(ctx !== null && !probePiAgentState(ctx).idle) ||
			!activeGenerationCurrent(active) ||
			!allIdleForClaim(active.claim)
		) {
			active.dispatchPending = false;
			if (sendOptions?.deferOnBusy !== false) deferDecisionOnBusy(active);
			return false;
		}
		try {
			options.pi.appendEntry<InquiryMarkerEntry>(INQUIRY_MARKER_ENTRY_TYPE, {
				version: 1,
				exchangeId: active.exchangeId,
				cycleId,
				...(review === null ? {} : { review: review.metadata }),
			});
			active.reviewMetadata = review?.metadata ?? null;
			active.markerEntryId = null;
			active.promptEntryId = null;
			if (ctx !== null) {
				try {
					for (const entry of ctx.sessionManager.getBranch().toReversed()) {
						if (
							entry.type === "custom" &&
							entry.customType === INQUIRY_MARKER_ENTRY_TYPE
						) {
							const correlation = markerDetails(entry.data);
							if (
								correlation?.exchangeId !== active.exchangeId ||
								correlation.cycleId !== cycleId
							)
								continue;
							active.markerEntryId = entry.id;
							break;
						}
					}
				} catch {
					// Optional association id stays unresolved.
				}
			}
		} catch (error) {
			active.dispatchPending = false;
			throw error;
		}
		try {
			const prompt = active.inquiry.prompt(
				review === null ? decisionPrompt : review.prompt,
			);
			if (!active.inquiry.markSent()) {
				return false;
			}
			options.pi.sendMessage(prompt, {
				triggerTurn: true,
				deliverAs: "steer",
			});
			if (hasPendingMessages() || !activeGenerationCurrent(active)) {
				if (sendOptions?.deferOnBusy !== false) deferDecisionOnBusy(active);
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

	const openDecision = (
		decisionId: number,
		reconsideration?: {
			readonly feedback: string;
			readonly rootExchangeId: string;
			readonly challengedBy: UnlockReviewRecord;
			readonly resumeCycleId?: number;
			readonly invalidAttempts?: number;
			readonly lastInvalidError?: string | null;
		},
	): void => {
		// Exact claim fence for this open attempt — not a live re-lookup later.
		const claim = getMainClaim();
		const controller = currentController(claim);
		if (claim === null || controller === null || !owns(claim)) {
			silentlyAbandonDecision();
			return;
		}
		const stillOwns = (): boolean => owns(claim);

		// A deferred semantic reconsideration resumes the same phase through
		// any open path — busy dispatch, correction or final-publication
		// deferral all re-enter here with no explicit reconsideration arg.
		// Lifecycle replacement has already cleared deferredReconsideration.
		if (
			reconsideration === undefined &&
			deferredReconsideration !== undefined
		) {
			const deferred = deferredReconsideration;
			deferredReconsideration = undefined;
			if (
				deferred.claim.attachmentId === claim.attachmentId &&
				deferred.claim.generation === claim.generation &&
				owns(claim) &&
				controller === options.controllerHolder.controller
			) {
				reconsideration = {
					feedback: deferred.feedback,
					rootExchangeId: deferred.rootExchangeId,
					challengedBy: deferred.challengedBy,
					resumeCycleId: deferred.resumeCycleId,
					invalidAttempts: deferred.invalidAttempts,
					lastInvalidError: deferred.lastInvalidError,
				};
			}
		}

		// Keep ordinary active tools and system prompt unchanged. Decision answers
		// are final function-call text, not temporary decision tools.
		// Both inquiry kinds share the same fixed protocol guidance; a
		// reconsideration only appends discrete challenge feedback after the
		// unchanged reason lists, field limits and assessment/delivery rules.
		const decisionPrompt =
			buildDecisionPrompt(
				config.decisionPrompt,
				config.reasonTypes,
				config.continueReasonTypes,
			) +
			(reconsideration === undefined ? "" : `\n\n${reconsideration.feedback}`);
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
			...(reconsideration?.resumeCycleId === undefined
				? {}
				: {
						initialCycleId: reconsideration.resumeCycleId,
						invalidAttempts: reconsideration.invalidAttempts,
						lastInvalidError: reconsideration.lastInvalidError,
					}),
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
			reviewMetadata: null,
			markerEntryId: null,
			promptEntryId: null,
			contextConfirmed: false,
			responseToolCallIds: new Set<string>(),
			stagedResult: null,
			logicalRootExchangeId: reconsideration?.rootExchangeId ?? exchangeId,
			isReconsideration: reconsideration !== undefined,
			...(reconsideration === undefined
				? {}
				: {
						challengedByReview: reconsideration.challengedBy,
						reconsiderationFeedback: reconsideration.feedback,
					}),
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
				reconsideration?.lastInvalidError == null
					? decisionPrompt
					: buildDecisionReaskPrompt(
							decisionPrompt,
							reconsideration.lastInvalidError,
						),
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
				openDecision(effect.decisionId, pendingReconsiderationForOpen);
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
	): ActiveDecision | null => {
		const claim = applyOptions?.claim ?? getMainClaim();
		if (claim === null || !options.hub.isCurrentMain(claim)) return null;
		let opened: ActiveDecision | null = null;
		for (const effect of transition.effects) {
			if (!options.hub.isCurrentMain(claim)) return opened;
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
			if (effect.kind === "openDecisionWindow") {
				openDecision(effect.decisionId, pendingReconsiderationForOpen);
				opened = activeDecision;
			} else {
				applyEffect(effect, ctx);
			}
		}
		if (transition.applied) {
			localActivityGeneration += 1;
			observeAggregate();
		}
		const latestGeneration = graceCoordinator.snapshot.generation;
		if (opened !== null && latestGeneration !== null) {
			opened.aggregateGeneration = latestGeneration;
		}
		return opened;
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
		else if (
			pendingFinalization !== null ||
			pendingContinuationPublication?.confirmed === null
		)
			blocker = "decision-finalizing";
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
			pendingContinuationPublication?.confirmed !== null &&
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
		refreshStateStatus();
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
				const transition = controller.beginDecision(now());
				if (!transition.applied) {
					readyGeneration = null;
					return;
				}
				applyTransition(transition, undefined, {
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
	 * Only automatic unlock, exhausted, and decision-failed terminal states
	 * produce a signal. Ordinary unlocked idle never publishes by inference.
	 */
	const maybePublishUserReady = async (): Promise<void> => {
		confirmTerminalPublication();
		if (
			pendingTerminalPublication !== null ||
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
				} else if (live.locked && live.decisionFailed) {
					liveEnvelope = createUserReadyEnvelope({
						STOP_KIND: "DECISION_FAILED",
					});
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
					pendingTerminalPublication = {
						publication: createSharedPublication(claim, {
							customType: WATCHDOG_EVENT_MESSAGE_TYPE,
							content: formatExhaustedWatchdogEvent(exhaustedEvent),
							display: true,
							details: exhaustedEvent,
						}),
						values: { STOP_KIND: "EXHAUSTED" },
					};
					confirmTerminalPublication();
					if (!exhaustionEventPublished) return;
				} catch {
					return;
				} finally {
					exhaustionEventPublicationInFlight = false;
				}
			}
			if (!allIdleForClaim(claim)) return;
			const live = currentController(claim)?.snapshot;
			if (live === undefined || !live.locked || !live.exhausted) {
				return;
			}
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
		suppressDecisionAbort = false;
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

	/** Check attempt and recorded call identity before validating arguments. */
	const submitDecisionResult = (call: {
		readonly toolCallId: string;
		readonly argumentsValue: unknown;
	}): ReturnType<DecisionToolHost["submitDecisionResult"]> => {
		const active = currentConsumedDecision();
		if (
			active === null ||
			pendingFinalization !== null ||
			!active.responseToolCallIds.has(call.toolCallId)
		) {
			return { outcome: "unauthorized" };
		}
		if (active.stagedResult !== null) {
			return { outcome: "duplicate" };
		}
		// Own inquiry activity makes the main run busy by design; do not require
		// global idle here. Fresh ownership and activity are rechecked at
		// settlement before any committed effect.
		const validation = validateDecisionArguments(
			call.argumentsValue,
			config.reasonTypes,
			config.continueReasonTypes,
		);
		active.stagedResult = {
			toolCallId: call.toolCallId,
			validation,
		};
		return {
			outcome: "staged",
			validation: validation.valid
				? { valid: true }
				: { valid: false, error: validation.error },
		};
	};

	// Presentation-only ownership evidence: exact recorded call identity of the
	// current owned decision attempt. Renderers use this to hide owned internal
	// traffic; unauthorized ordinary calls never match and stay visible.
	const isOwnedDecisionCall = (toolCallId: string): boolean => {
		const active = activeDecision;
		return (
			active !== null &&
			!active.invalidated &&
			owns(active.claim) &&
			active.responseToolCallIds.has(toolCallId)
		);
	};

	const decisionToolHost: DecisionToolHost = {
		submitDecisionResult,
		isOwnedDecisionCall,
	};

	/**
	 * Register the reserved decision function in the root process only. The
	 * same named declaration is refreshed only when an existing lifecycle
	 * config load changes its effective reason constraints; equal effective
	 * constraints keep the original declaration, and no phase transition ever
	 * adds, removes, or swaps tools. Re-registration of the same name updates
	 * the shared declaration while preserving its active membership.
	 */
	let decisionToolConstraints: string | null = null;
	const registerRuntimeDecisionTool = (): void => {
		if (!isRootProcess()) return;
		const constraints = JSON.stringify([
			config.reasonTypes,
			config.continueReasonTypes,
		]);
		if (decisionToolConstraints === constraints) return;
		// Only an actual replacement preserves pre-refresh active membership
		// (the allowlisted native refresh would otherwise reactivate a
		// registered-but-disabled `cw`). Initial registration keeps the native
		// membership behavior unchanged.
		const replacing = decisionToolConstraints !== null;
		decisionToolConstraints = constraints;
		registerDecisionTool(
			options.pi,
			createDecisionToolDefinition(
				decisionToolHost,
				config.reasonTypes,
				config.continueReasonTypes,
			),
			replacing ? { preserveActiveMembership: true } : undefined,
		);
	};

	const acquireControl = (claim: HubMainClaim): void => {
		if (stopped || !options.hub.isCurrentMain(claim)) return;
		ownedClaim = claim;
		if (options.injectedController) {
			options.controllerHolder.controller = injectedController;
			configReady = injectedController !== null;
			if (configReady) {
				options.onConfigReady?.(config);
				registerRuntimeDecisionTool();
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
			readyGeneration = null;
			localActivityGeneration += 1;
			options.controllerHolder.controller =
				createLockDecisionController(config);
			configReady = true;
			registerRuntimeDecisionTool();
			for (const diagnostic of loaded.diagnostics) {
				if (!owns(claim)) {
					dropControl();
					return;
				}
				try {
					ctx.ui.notify(
						diagnostic.message,
						diagnostic.severity === "error" ? "error" : "warning",
					);
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
		if (pendingUnlockReview?.active === active) {
			pendingUnlockReview.abort.abort();
			pendingUnlockReview = null;
		}
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

	const createSharedPublication = (
		claim: HubMainClaim,
		message: Parameters<ExtensionAPI["sendMessage"]>[0],
	): SharedPublication => ({
		claim,
		controller: currentController(claim),
		cycle: publicationCycle,
		message,
		receipt: null,
		sending: false,
	});

	const sharedPublicationCurrent = (pending: SharedPublication): boolean =>
		pending.controller !== null &&
		owns(pending.claim) &&
		publicationCycle === pending.cycle &&
		currentController(pending.claim) === pending.controller;

	/** Retry only confirmed absence; retain unknown receipts without duplicate sends. */
	const publishSharedMessage = (pending: SharedPublication): boolean => {
		const ctx = sessionContext;
		if (ctx === null || pending.sending || !sharedPublicationCurrent(pending))
			return false;
		pending.sending = true;
		try {
			if (pending.receipt !== null) {
				const receipt = pending.receipt();
				if (!sharedPublicationCurrent(pending)) return false;
				if (receipt !== false) return receipt === true;
			}
			if (!allIdleForClaim(pending.claim)) return false;
			pending.receipt = observeBranchPublication(
				ctx,
				pending.message.customType,
				(details) => isDeepStrictEqual(details, pending.message.details),
			);
			if (!sharedPublicationCurrent(pending) || !allIdleForClaim(pending.claim))
				return false;
			options.pi.sendMessage(pending.message, {
				triggerTurn: false,
				deliverAs: "steer",
			});
			const receipt = pending.receipt();
			return receipt === true && sharedPublicationCurrent(pending);
		} catch {
			// Preserve any receipt: a thrown callback need not mean append failed.
			const receipt = pending.receipt?.();
			return receipt === true && sharedPublicationCurrent(pending);
		} finally {
			pending.sending = false;
		}
	};

	const confirmTerminalPublication = (): void => {
		const pending = pendingTerminalPublication;
		if (pending === null) return;
		const snapshot = pending.publication.controller?.snapshot;
		const terminalCurrent =
			pending.values.STOP_KIND === "AI_UNLOCK"
				? snapshot?.locked === false
				: snapshot?.locked === true &&
					(pending.values.STOP_KIND === "DECISION_FAILED"
						? snapshot.decisionFailed
						: snapshot.exhausted);
		if (!terminalCurrent || !sharedPublicationCurrent(pending.publication)) {
			pendingTerminalPublication = null;
			return;
		}
		if (
			!publishSharedMessage(pending.publication) ||
			pendingTerminalPublication !== pending
		)
			return;
		// The live inquiry completes with removal semantics: a quiet AI unlock
		// has no model-bound replacement body. Exhaustion and decision failure
		// keep their existing shared outcome events.
		pending.active?.inquiry.complete(
			pending.content === undefined
				? undefined
				: { customType: WATCHDOG_EVENT_MESSAGE_TYPE, content: pending.content },
		);
		if (
			pendingTerminalPublication !== pending ||
			!sharedPublicationCurrent(pending.publication)
		)
			return;
		// Second artifact: the UI-only unlock status entry. Confirm the remove
		// fold first, then this entry; the terminal intent stays pending until
		// both are durably observed, retrying only confirmed absence.
		const status = pending.statusEntry;
		if (status !== undefined) {
			if (!confirmUnlockStatusEntry(pending, status)) return;
			if (pendingTerminalPublication !== pending) return;
		}
		pendingTerminalPublication = null;
		if (pending.values.STOP_KIND === "EXHAUSTED")
			exhaustionEventPublished = true;
		else pendingUnlock = pending.values;
	};

	/**
	 * Publish and confirm the quiet AI-unlock status entry. Returns true only
	 * when a new correlated branch entry of the exact kind is observed. A void
	 * appendEntry return is not persistence evidence; retry only a confirmed
	 * absence while the current claim and cycle still hold.
	 */
	const confirmUnlockStatusEntry = (
		pending: NonNullable<typeof pendingTerminalPublication>,
		status: NonNullable<
			NonNullable<typeof pendingTerminalPublication>["statusEntry"]
		>,
	): boolean => {
		const ctx = sessionContext;
		if (
			ctx === null ||
			status.sending ||
			!sharedPublicationCurrent(pending.publication)
		)
			return false;
		status.sending = true;
		try {
			if (status.receipt !== null) {
				const receipt = status.receipt();
				if (!sharedPublicationCurrent(pending.publication)) return false;
				if (receipt !== false) return receipt === true;
			}
			if (!allIdleForClaim(pending.publication.claim)) return false;
			status.receipt = observeBranchEntryPublication(
				ctx,
				AI_UNLOCK_ENTRY_TYPE,
				(entry) => {
					if (typeof entry !== "object" || entry === null) return false;
					const record = entry as {
						readonly type?: unknown;
						readonly data?: unknown;
					};
					return (
						record.type === "custom" &&
						record.data !== undefined &&
						isDeepStrictEqual(record.data, status.data)
					);
				},
			);
			if (
				!sharedPublicationCurrent(pending.publication) ||
				!allIdleForClaim(pending.publication.claim)
			)
				return false;
			options.pi.appendEntry<AiUnlockEntry>(AI_UNLOCK_ENTRY_TYPE, status.data);
			const receipt = status.receipt();
			return receipt === true && sharedPublicationCurrent(pending.publication);
		} catch {
			// Preserve any receipt: a thrown callback need not mean append failed.
			const receipt = status.receipt?.();
			return receipt === true && sharedPublicationCurrent(pending.publication);
		} finally {
			status.sending = false;
		}
	};

	/** A new public branch entry of an exact custom-entry kind, observed on the
	 * active branch, acknowledges TUI-only entry publication. */
	const observeBranchEntryPublication = (
		ctx: ExtensionContext,
		customType: string,
		matches: (entry: unknown) => boolean,
	): (() => boolean | undefined) => {
		const previousIds = new Set(
			ctx.sessionManager.getBranch().map((entry) => entry.id),
		);
		return () => {
			try {
				return ctx.sessionManager
					.getBranch()
					.some(
						(entry) =>
							!previousIds.has(entry.id) &&
							entry.type === "custom" &&
							entry.customType === customType &&
							matches(entry),
					);
			} catch {
				// An unavailable read is not evidence that publication failed.
				return undefined;
			}
		};
	};

	/** A new public branch entry, not sendMessage's void return, acknowledges publication. */
	const observeBranchPublication = (
		ctx: ExtensionContext,
		customType: string,
		matches: (details: unknown) => boolean,
	): (() => boolean | undefined) => {
		const previousIds = new Set(
			ctx.sessionManager.getBranch().map((entry) => entry.id),
		);
		return () => {
			try {
				return ctx.sessionManager
					.getBranch()
					.some(
						(entry) =>
							!previousIds.has(entry.id) &&
							entry.type === "custom_message" &&
							entry.customType === customType &&
							matches(entry.details),
					);
			} catch {
				// An unavailable read is not evidence that publication failed.
				return undefined;
			}
		};
	};

	const observeOutcomePublication = (
		ctx: ExtensionContext,
		active: ActiveDecision,
		cycleId: number,
		watchdogEvent: unknown,
	): (() => boolean | undefined) =>
		observeBranchPublication(ctx, DECISION_FOLD_MESSAGE_TYPE, (value) => {
			const details = parseDecisionFoldDetails(value);
			return (
				details?.inquiryId === active.exchangeId &&
				details.attempt === cycleId &&
				isDeepStrictEqual(details.watchdogEvent, watchdogEvent)
			);
		});

	const confirmContinuationPublication = (settled = false): void => {
		const pending = pendingContinuationPublication;
		if (pending === null || pending.confirmed === null || pending.sending)
			return;
		if (
			!owns(pending.active.claim) ||
			options.controllerHolder.controller !== pending.controller ||
			publicationCycle !== pending.publicationCycle ||
			lifecycleGeneration !== pending.lifecycleGeneration ||
			watchdogOwnedRun?.exchangeId !== pending.active.exchangeId ||
			watchdogOwnedRun.cycleId !== pending.cycleId
		) {
			pendingContinuationPublication = null;
			return;
		}
		const confirmed = pending.confirmed();
		if (pendingContinuationPublication !== pending) return;
		if (confirmed !== true) {
			if (confirmed === false && settled) {
				pendingContinuationPublication = null;
				if (
					options.controllerHolder.controller === pending.controller &&
					pending.controller.snapshot.attempt === pending.attempt &&
					!pending.controller.snapshot.decisionOpen
				) {
					pending.controller.rollbackValidContinue();
				}
				retainInquiryCleanup(pending.active);
				retryInquiryCleanup();
			}
			return;
		}
		if (pendingContinuationPublication === pending) {
			pendingContinuationPublication = null;
			pending.active.inquiry.complete({
				customType: CONTINUATION_MESSAGE_TYPE,
				content: pending.body,
			});
		}
		if (
			!owns(pending.active.claim) ||
			options.controllerHolder.controller !== pending.controller ||
			publicationCycle !== pending.publicationCycle ||
			lifecycleGeneration !== pending.lifecycleGeneration
		)
			return;
		try {
			emitSemanticHook(
				options.pi.events,
				createWatchdogContinuedEnvelope({
					REASON_TYPE: pending.reasonType,
					REASON: pending.reason,
				}),
			);
		} catch {
			// Listener failures cannot undo a persisted continuation.
		}
	};

	/** Send only a not-yet-sent accepted continuation under its original fences. */
	const sendPendingContinuation = async (
		ctx: ExtensionContext,
	): Promise<boolean> => {
		const pending = pendingContinuationPublication;
		if (pending === null || pending.confirmed !== null || pending.sending)
			return false;
		const ledgerCurrent = (): boolean =>
			pendingContinuationPublication === pending &&
			owns(pending.active.claim) &&
			options.controllerHolder.controller === pending.controller &&
			publicationCycle === pending.publicationCycle &&
			lifecycleGeneration === pending.lifecycleGeneration &&
			pending.controller.snapshot.locked &&
			!pending.controller.snapshot.decisionOpen &&
			!pending.controller.snapshot.decisionFailed &&
			pending.controller.snapshot.attempt ===
				pending.attempt - (pending.charged ? 0 : 1);
		const current = (): boolean => {
			const fence = options.processDomain?.snapshot.fence;
			return (
				ledgerCurrent() &&
				!stopped &&
				!pending.active.invalidated &&
				localActivityGeneration ===
					pending.generation.localActivityGeneration &&
				sameActivityGeneration(
					graceCoordinator.snapshot.generation,
					pending.generation,
				) &&
				(fence === undefined ||
					(fence.domainEpoch === pending.active.domainFence.domainEpoch &&
						fence.activityGeneration ===
							pending.active.domainFence.activityGeneration))
			);
		};
		const refund = (): void => {
			if (
				pending.charged &&
				ledgerCurrent() &&
				pending.controller.rollbackValidContinue().applied
			)
				pending.charged = false;
		};
		const discard = (): false => {
			refund();
			if (pendingContinuationPublication === pending) {
				pendingContinuationPublication = null;
				pending.active.invalidated = true;
				if (selfRunFor(pending.active)) selfDecisionRun = { kind: "none" };
			}
			return false;
		};
		const defer = (): false => {
			if (!current()) return discard();
			refund();
			if (!pending.active.isReconsideration) {
				pending.active.invalidated = true;
				if (pendingContinuationPublication === pending)
					pendingContinuationPublication = null;
			}
			return false;
		};
		pending.sending = true;
		try {
			if (!current()) return discard();
			if (!allIdleForClaim(pending.active.claim)) return defer();
			if (!current()) return discard();
			if (options.processDomain !== undefined) {
				let confirmed = false;
				try {
					confirmed = await options.processDomain.confirm(
						pending.active.domainFence,
					);
				} catch {
					disableDomain();
					return false;
				}
				if (!current()) return discard();
				if (!confirmed || !allIdleForClaim(pending.active.claim))
					return defer();
			}
			if (!current()) return discard();
			if (!allIdleForClaim(pending.active.claim)) return defer();
			if (!current()) return discard();
			if (!pending.charged) {
				if (
					!pending.controller.reapplyValidContinue(pending.attempt - 1).applied
				)
					return discard();
				pending.charged = true;
			}
			const failSend = (): false => {
				if (!ledgerCurrent()) return false;
				refund();
				pendingContinuationPublication = null;
				watchdogOwnedRun = null;
				pending.active.invalidated = true;
				if (!allIdleForClaim(pending.active.claim)) return false;
				if (
					!owns(pending.active.claim) ||
					options.controllerHolder.controller !== pending.controller ||
					publicationCycle !== pending.publicationCycle ||
					lifecycleGeneration !== pending.lifecycleGeneration
				)
					return false;
				retainInquiryCleanup(pending.active);
				retryInquiryCleanup();
				if (
					owns(pending.active.claim) &&
					options.controllerHolder.controller === pending.controller &&
					publicationCycle === pending.publicationCycle &&
					lifecycleGeneration === pending.lifecycleGeneration
				)
					silentlyAbandonDecision();
				return false;
			};
			let receipt: () => boolean | undefined;
			try {
				receipt = observeOutcomePublication(
					ctx,
					pending.active,
					pending.cycleId,
					pending.watchdogEvent,
				);
			} catch {
				return failSend();
			}
			if (!current()) return discard();
			if (!allIdleForClaim(pending.active.claim)) return defer();
			if (!current()) return discard();
			pending.confirmed = receipt;
			watchdogOwnedRun = {
				kind: "continuation",
				claim: pending.active.claim,
				exchangeId: pending.active.exchangeId,
				cycleId: pending.cycleId,
				phase: "pending-start",
				cancelRequested: false,
			};
			try {
				options.pi.sendMessage(pending.message, {
					triggerTurn: true,
					deliverAs: "steer",
				});
			} catch {
				return failSend();
			}
			if (
				pendingContinuationPublication !== pending ||
				!owns(pending.active.claim)
			)
				return false;
			reconcileIdle();
			return true;
		} finally {
			pending.sending = false;
		}
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
			currentConsumedDecision() !== pending.active ||
			pending.active.invalidated
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

		// Optional AI-unlock review: only a current, valid, initial unlock
		// candidate from a non-reconsideration inquiry is eligible, exactly
		// once per logical decision, before its effect is committed. Every
		// other outcome and a reconsidered result skip this branch entirely.
		if (
			plan.outcome === "unlock" &&
			config.unlockReviewEnabled &&
			!active.isReconsideration &&
			pending.reconsidered !== true &&
			active.logicalRootExchangeId === active.exchangeId &&
			pending.reviewSettled !== true
		) {
			if (pendingUnlockReview === null) {
				const service: ReviewServiceLike | undefined = options.reviewService;
				const discovery =
					service !== undefined
						? ({ status: "available", service } as const)
						: discoverUnlockReviewService();
				if (discovery.status !== "available") {
					pending.reviewSettled = true;
					pending.reviewDisposition = "incomplete";
					appendUnlockReviewRecord(ctx, {
						version: 1,
						projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
						exchangeId: active.exchangeId,
						cycleId,
						outcome: "incomplete",
						incompleteReason: discovery.status,
					});
				} else {
					let snapshotEntries: ReturnType<
						typeof ctx.sessionManager.buildContextEntries
					>;
					try {
						snapshotEntries = ctx.sessionManager.buildContextEntries();
					} catch {
						pending.reviewSettled = true;
						pending.reviewDisposition = "incomplete";
						appendUnlockReviewRecord(ctx, {
							version: 1,
							projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
							exchangeId: active.exchangeId,
							cycleId,
							outcome: "incomplete",
							incompleteReason: "error",
							errorMessage: "macro snapshot projection failed",
						});
						return deliverPending(ctx);
					}
					// Synchronous snapshot call can be reentrant: a host callback
					// may have demoted, unlocked or replaced the lock cycle. Recheck
					// exact fences before installing a new pending review.
					if (
						pendingFinalization !== pending ||
						active.invalidated ||
						currentConsumedDecision() !== active ||
						!readyToFinalize()
					) {
						return false;
					}
					let projection: UnlockReviewProjection;
					try {
						projection = buildUnlockReviewProjection(snapshotEntries);
					} catch {
						pending.reviewSettled = true;
						pending.reviewDisposition = "incomplete";
						appendUnlockReviewRecord(ctx, {
							version: 1,
							projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
							exchangeId: active.exchangeId,
							cycleId,
							outcome: "incomplete",
							incompleteReason: "error",
							errorMessage: "macro snapshot projection failed",
						});
						return deliverPending(ctx);
					}
					const request = buildUnlockReviewRequest(projection, {
						action: "unlock",
						reasonType: plan.reasonType,
						reason: plan.reason,
					});
					const reviewState: PendingUnlockReview = {
						active,
						cycleId,
						plan,
						abort: new AbortController(),
						settled: false,
					};
					pendingUnlockReview = reviewState;
					void (async () => {
						const report = await runUnlockReview(
							discovery.service,
							request,
							reviewState.abort.signal,
						);
						if (reviewState.settled) return;
						reviewState.settled = true;
						if (pendingUnlockReview === reviewState) pendingUnlockReview = null;
						applyReviewOutcome(ctx, reviewState, projection, report);
					})();
					// The pending review is one business operation per logical
					// decision; settlement callbacks re-enter via applyReviewOutcome.
					return false;
				}
			}
			if (pendingUnlockReview !== null) return false;
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

		if (currentConsumedDecision() !== active) return false;
		const controllerAtCommit = options.controllerHolder.controller;
		const publicationCycleAtCommit = publicationCycle;
		const lifecycleAtCommit = lifecycleGeneration;
		const controllerBeforeCommit = controllerAtCommit?.snapshot;
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
			// A fresh attempt requires its own consumption evidence: reset the
			// recorded batch identity, staged result, and context confirmation.
			active.responseToolCallIds = new Set<string>();
			active.stagedResult = null;
			active.contextConfirmed = false;
			try {
				if (
					!sendDecisionPrompt(
						active,
						active.protocol.currentCycleId,
						finalization.reaskPrompt,
						{ deferOnBusy: false },
					)
				) {
					if (!active.isReconsideration) {
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
					}
					// A reconsideration response already consumed its format slot;
					// failure to send the next prompt cannot replenish that slot.
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
		if (finalization.outcome !== "continue") clearLiveStatus();
		if (stopIfStale(claim)) return false;

		if (finalization.outcome === "decision-failed") {
			activeDecision = null;
			capturedDecisionResponse = null;
			if (finalization.cycleId === undefined) return false;
			const error = finalization.error ?? "Continue watchdog decision failed.";
			const watchdogEvent = createDecisionFailedWatchdogEvent({
				occurredAtMs: now(),
				error,
			});
			const eventContent = formatDecisionFailedWatchdogEvent(watchdogEvent);
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
					message: error,
				})
			) {
				silentlyAbandonDecision();
				return false;
			}
			if (stopIfStale(claim)) return false;
			pendingTerminalPublication = {
				publication: createSharedPublication(
					claim,
					createDecisionFoldMessage({
						exchangeId: active.exchangeId,
						cycleId: finalization.cycleId,
						outcome: "decision-failed",
						eventContent,
						watchdogEvent,
					}),
				),
				values: { STOP_KIND: "DECISION_FAILED" },
				active,
			};
			confirmTerminalPublication();
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
			const finalCycleId = finalization.cycleId;
			const reasonType = finalization.reasonType;
			const reason = finalization.reason;
			if (
				controllerAtCommit === null ||
				typeof reasonType !== "string" ||
				reasonType.length === 0 ||
				typeof reason !== "string" ||
				reason.length === 0
			)
				return false;
			const watchdogEvent = createContinueWatchdogEvent({
				occurredAtMs: now(),
				reasonType,
				reason,
			});
			const body = formatContinueWatchdogEvent(
				watchdogEvent,
				config.continuePrompt,
			);
			pendingContinuationPublication = {
				active,
				cycleId: finalCycleId,
				controller: controllerAtCommit,
				attempt: finalization.transition.snapshot.attempt,
				publicationCycle: publicationCycleAtCommit,
				lifecycleGeneration: lifecycleAtCommit,
				generation: active.aggregateGeneration,
				confirmed: null,
				charged: true,
				sending: false,
				body,
				reasonType,
				reason,
				watchdogEvent,
				message: createDecisionFoldMessage({
					exchangeId: active.exchangeId,
					cycleId: finalCycleId,
					outcome: "continue",
					continuePrompt: body,
					watchdogEvent,
				}),
			};
			activeDecision = null;
			capturedDecisionResponse = null;
			clearLiveStatus();
			return sendPendingContinuation(ctx);
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
		// Quiet AI unlock: the persisted fold is remove-only (no model-bound
		// replacement), and the human-visible outcome is one UI-only status
		// entry excluded from model context by the host. No shared unlock body
		// is sent to the model.
		pendingTerminalPublication = {
			publication: createSharedPublication(
				claim,
				createDecisionFoldMessage({
					exchangeId: active.exchangeId,
					cycleId: finalization.cycleId,
					outcome: "unlock",
				}),
			),
			values: {
				STOP_KIND: "AI_UNLOCK",
				REASON_TYPE: reasonType,
				REASON: reason,
			},
			active,
			statusEntry: {
				data: {
					reasonType,
					reason,
					exchangeId: active.exchangeId,
					cycleId: finalization.cycleId,
				},
				receipt: null,
				sending: false,
			},
		};
		confirmTerminalPublication();
		stopIfStale(claim);
		// The quiet status is the sole visible reasoned automatic-unlock output.
		return false;
	};

	/**
	 * Idempotent finalization for the active current decision. Safe to call from
	 * agent_end and true-idle settle; no-ops when already finalized or inactive.
	 */
	const finalizeActiveDecision = (
		response:
			| ReturnType<typeof normalizeAssistantDecisionResponse>
			| "missing"
			| { readonly preplanned: DecisionProtocolPlan },
	): void => {
		const active = currentConsumedDecision();
		if (active === null || pendingFinalization !== null) return;
		const cycleId = active.protocol.currentCycleId;
		pendingFinalization = {
			active,
			cycleId,
			plan:
				typeof response === "object" && "preplanned" in response
					? response.preplanned
					: active.protocol.planResponse(
							cycleId,
							response === "missing"
								? { content: [{ type: "malformed" }] }
								: response,
						),
			// A reconsidered unlock is committed directly: the single permitted
			// review already ran for this logical decision.
			reconsidered: active.isReconsideration,
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
		const cancellation = manualCancellation;
		if (
			cancellation !== null &&
			event.message.role === "assistant" &&
			isAbortedAssistant(event.message)
		) {
			return {
				message: neutralizeDecisionAssistant(
					{
						...event.message,
						stopReason: "stop" as const,
						errorMessage: CANCELLED_WATCHDOG_RUN_ERROR,
					},
					cancellation.exchangeId,
					cancellation.cycleId,
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
		if (
			event.message.role === "assistant" &&
			isAbortedAssistant(event.message) &&
			isCurrentWatchdogOwnedRun()
		) {
			// Preserve Pi's abort control (tools, queues and compaction) and the
			// existing unlock gate. Empty text falls back to `Operation aborted`;
			// a nonempty blank renders no text, leaving only the host's spacing.
			return {
				message: {
					...event.message,
					content: activeDecision === null ? event.message.content : [],
					errorMessage: " ",
				},
			};
		}
		const active = currentConsumedDecision();
		if (
			active === null ||
			pendingFinalization !== null ||
			event.message.role !== "assistant" ||
			isErroredAssistant(event.message)
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
		if (
			capturedDecisionResponse?.active === active &&
			capturedDecisionResponse.cycleId === cycleId
		) {
			// A response already owns this attempt. Never replace its outcome with
			// a native follow-up or repeated callback before settlement.
			return {
				message: {
					...active.inquiry.neutralize(event.message),
					content: [],
					stopReason: "stop" as const,
				},
			};
		}
		const captured = active.inquiry.capture(event.message);
		if (captured === null) return undefined;
		// Preflight the complete response batch before any of its tools run:
		// exactly one reserved cw call and no other tool call. Tool-call identity
		// is recorded here so execute(toolCallId, ...) can correlate to this
		// message and attempt; replayed identifiers from other runs never match.
		const toolCalls = (event.message.content ?? []).filter(
			(
				block,
			): block is Extract<
				(typeof event.message.content)[number],
				{ readonly type: "toolCall" }
			> =>
				typeof block === "object" &&
				block !== null &&
				(block as { readonly type?: unknown }).type === "toolCall",
		);
		const call = toolCalls[0];
		const batchValid =
			toolCalls.length === 1 &&
			call?.name === DECISION_TOOL_NAME &&
			typeof call.id === "string" &&
			call.id.length > 0 &&
			call.arguments !== null &&
			typeof call.arguments === "object" &&
			!Array.isArray(call.arguments) &&
			event.message.stopReason !== "length" &&
			event.message.content.every(
				(block) =>
					block.type === "toolCall" ||
					block.type === "thinking" ||
					(block.type === "text" && block.text.trim() === ""),
			);
		active.responseToolCallIds = new Set(
			batchValid ? toolCalls.map((call) => call.id) : [],
		);
		const staged = active.stagedResult;
		// The response plan comes from the staged validation when execute already
		// ran for the one authorized call; zero, mixed, or duplicate calls make
		// the whole response invalid.
		const plan: DecisionProtocolPlan =
			event.message.stopReason === "length"
				? {
						outcome: "invalid",
						cycleId,
						error: MALFORMED_DECISION_RESPONSE_ERROR,
					}
				: staged !== null && batchValid
					? staged.validation.valid
						? active.protocol.planResponse(cycleId, {
								content: [
									{
										type: "toolCall",
										toolCallId: staged.toolCallId,
										name: DECISION_TOOL_NAME,
										arguments: stagedVerdictArguments(staged.validation),
									},
								],
							})
						: { outcome: "invalid", cycleId, error: staged.validation.error }
					: active.protocol.planResponse(
							cycleId,
							normalizeAssistantDecisionResponse(event.message),
						);
		capturedDecisionResponse = { active, cycleId, plan };
		// The current prompt's run is over; the recorded batch identity now guards
		// which calls may still submit for this attempt. `submitted` stays true so
		// the correlated run's own execute handlers remain authorized until
		// settlement; a later unrelated run cannot match the recorded ids.
		active.dispatchPending = false;

		let audit: DecisionAuditEntry;
		if (plan.outcome === "invalid") {
			audit = {
				version: 1,
				exchangeId: active.exchangeId,
				cycleId,
				outcome: "invalid",
				error: plan.error,
			};
		} else if (plan.outcome === "continue") {
			audit = {
				version: 1,
				exchangeId: active.exchangeId,
				cycleId,
				outcome: "continue",
				reasonType: plan.reasonType,
				reason: plan.reason,
			};
		} else if (plan.outcome === "unlock") {
			audit = {
				version: 1,
				exchangeId: active.exchangeId,
				cycleId,
				outcome: "unlock",
				reasonType: plan.reasonType,
				reason: plan.reason,
			};
		} else {
			// Ignored plans (stale cycle) keep no audit record.
			return {
				message: {
					...active.inquiry.neutralize(event.message),
					content:
						toolCalls.length === 0
							? []
							: (event.message.content ?? []).filter(
									(block) =>
										block.type === "toolCall" || block.type === "thinking",
								),
				},
			};
		}
		try {
			const review: ReviewAuditMetadata | undefined =
				active.reviewMetadata === null
					? undefined
					: {
							version: 1,
							...(active.markerEntryId === null
								? {}
								: { markerEntryId: active.markerEntryId }),
							...(active.promptEntryId === null
								? {}
								: { promptEntryId: active.promptEntryId }),
							...(active.reviewMetadata.sourceHeadId === null
								? {}
								: { sourceHeadId: active.reviewMetadata.sourceHeadId }),
							sourceDigest: active.reviewMetadata.digest,
						};
			const record: DecisionAuditEntry & {
				readonly review?: ReviewAuditMetadata;
			} = review === undefined ? audit : { ...audit, review };
			options.pi.appendEntry<DecisionAuditEntry>(
				DECISION_AUDIT_ENTRY_TYPE,
				record,
			);
		} catch {
			// Optional diagnostics do not retry, relock, or gate publication.
			if (owns(active.claim))
				appendStatus({
					kind: "other-error",
					exchangeId: active.exchangeId,
					cycleId,
					message: "Review history incomplete: response audit unavailable.",
				});
		}

		// Invalid owned transports end here, before native schema/unknown-tool
		// and length fast paths can bypass tool_call and request another reply.
		// A batch-shape failure and a payload-invalid singleton are stopped the
		// same way: no executable calls, a normal stop, and the captured
		// diagnostic charged once at settlement — never a native schema-error
		// follow-up or an unbudgeted ordinary retry. Only valid plans retain
		// their executable call and required thinking for dispatch.
		const executable = batchValid && plan.outcome !== "invalid";
		return {
			message: {
				...active.inquiry.neutralize(event.message),
				...(executable ? {} : { stopReason: "stop" as const }),
				content: executable
					? event.message.content.filter(
							(block) => block.type === "toolCall" || block.type === "thinking",
						)
					: [],
			},
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
		if (active === null || currentConsumedDecision() !== active) return;
		const assistant = terminalAssistant(event.messages);
		// Aborts are owned by the abort-outcome path. Provider errors remain
		// provisional because Pi may automatically retry within the same run;
		// only a successful response or the final settled no-result may consume a
		// decision attempt.
		if (assistant !== undefined && isAbortedAssistant(assistant)) return;
		if (assistant !== undefined && isErroredAssistant(assistant)) return;
		const captured = capturedDecisionResponse;
		if (
			captured !== null &&
			captured.active === activeDecision &&
			captured.cycleId === activeDecision.protocol.currentCycleId
		) {
			capturedDecisionResponse = null;
			// A valid preflight verdict must have been submitted through the
			// reserved function; a response whose call never executed counts as a
			// missing result, which is invalid.
			const plan =
				captured.plan.outcome !== "invalid" &&
				captured.plan.outcome !== "ignored" &&
				captured.active.stagedResult === null
					? {
							outcome: "invalid" as const,
							cycleId: captured.cycleId,
							error: MISSING_DECISION_CALL_ERROR,
						}
					: captured.plan;
			finalizeActiveDecision({ preplanned: plan });
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
		if (
			pendingContinuationPublication?.confirmed === null &&
			(message.role === "user" || message.role === "custom")
		) {
			clearOperationalPendingWork();
		}
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
		}
		if (ownedRun?.phase === "pending-start") {
			const fold =
				message.role === "custom" &&
				message.customType === DECISION_FOLD_MESSAGE_TYPE
					? parseDecisionFoldDetails(message.details)
					: undefined;
			if (
				fold?.inquiryId === ownedRun.exchangeId &&
				fold.attempt === ownedRun.cycleId &&
				fold.watchdogOutcome === "continue" &&
				fold.replacement?.customType === CONTINUATION_MESSAGE_TYPE &&
				owns(ownedRun.claim)
			) {
				ownedRun.phase = "running";
				return;
			}
			watchdogOwnedRun = null;
		}
		const active = activeDecision;
		if (active === null || active.invalidated || !owns(active.claim)) return;
		const isCurrentDecision = active.inquiry.matchesPrompt(message);
		if (
			active.submitted &&
			!isCurrentDecision &&
			(message.role === "user" || message.role === "custom")
		) {
			deferDecisionOnBusy(
				active,
				active.isReconsideration ? "preempted" : undefined,
			);
			return;
		}
		if (!active.dispatchPending) return;
		if (!isCurrentDecision) {
			deferDecisionOnBusy(
				active,
				active.isReconsideration ? "preempted" : undefined,
			);
			return;
		}
		active.dispatchPending = false;
		active.submitted = true;
		// The observed persisted prompt id, when the host surfaces the entry id,
		// enriches the optional audit association without a second append.
		const promptEntryId = (message as { readonly id?: unknown }).id;
		if (typeof promptEntryId === "string") active.promptEntryId = promptEntryId;
		selfDecisionRun = {
			kind: "confirmed",
			exchangeId: active.exchangeId,
			cycleId: active.protocol.currentCycleId,
		};
		observeAggregate();
	};

	/**
	 * Replace provisional context evidence for each observed projection. Exact
	 * metadata prevents reuse across attempts, but a later Pi context handler
	 * can still remove this message without notifying us. This observer alone
	 * is not proof of final provider-request consumption.
	 */
	const handleContextProjection = (event: {
		readonly messages?: unknown;
	}): void => {
		if (stopped) return;
		confirmContinuationPublication();
		const active = activeDecision;
		if (
			active === null ||
			active.invalidated ||
			!active.submitted ||
			!options.hub.isCurrentMain(active.claim) ||
			selfDecisionRun.kind !== "confirmed" ||
			selfDecisionRun.exchangeId !== active.exchangeId ||
			selfDecisionRun.cycleId !== active.protocol.currentCycleId
		) {
			return;
		}
		const messages = event.messages;
		active.contextConfirmed =
			Array.isArray(messages) &&
			messages.some((message) => active.inquiry.matchesPrompt(message));
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
			// Recover review history once from the host-selected active ancestry:
			// audit/history data only, never restored locks, ownership, counters,
			// timers, dispatch, or staged actions. A read failure or unsupported
			// record stays diagnostic; nothing is repaired, migrated, or staged.
			reportReviewHistory(ctx);
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

		// Observe the local projection before tools run. Registration order does
		// not make this the host's final projection; that acceptance gap remains.
		options.pi.on("context", handleContextProjection);

		// Capture the complete public input payload before aborting the owned
		// inquiry; Pi 0.85.1 may drop steering queued into an aborted run.
		// Reissue it once after settlement, without reading private queues.
		options.pi.on("input", (event, ctx) => {
			const active = activeDecision;
			if (event.source !== "interactive" && event.source !== "rpc") {
				observeLiveState(ctx);
				return;
			}
			if (pendingContinuationPublication?.confirmed === null)
				clearOperationalPendingWork();
			deferredReconsideration = undefined;
			selfDecisionRun = { kind: "none" };
			observeLiveState(ctx);
			// A re-issued takeover must pass through untouched so it becomes the
			// fresh user turn instead of being captured again.
			if (pendingTakeover.isReissuedTakeover(event.text)) {
				return { action: "continue" };
			}
			if (
				active === null ||
				active.invalidated ||
				!active.submitted ||
				!owns(active.claim)
			) {
				return { action: "continue" };
			}
			// Idle pending-review phase: the original agent_settled already
			// returned and no watchdog-owned run remains. Capturing the input
			// would strand it until a settle that never arrives, so abort the
			// in-flight review, retire the pending unlock, and let this exact
			// input proceed normally as a fresh user turn. localIdle() was just
			// refreshed by observeLiveState above; a live submitted run keeps
			// the capture-and-reissue path below.
			if (localIdle() && !active.dispatchPending) {
				if (pendingUnlockReview?.active === active) {
					pendingUnlockReview.abort.abort();
					pendingUnlockReview = null;
				}
				deferDecisionOnBusy(active, "preempted");
				return { action: "continue" };
			}
			// Swallow the raw takeover so 0.85.1's async abort cannot strand it as
			// steering inside the hidden decision run; re-issue after settle. A
			// second takeover before the first settles supersedes it (the newest
			// user intent wins) rather than throwing on the shared single slot.
			if (pendingTakeover.hasPending) pendingTakeover.clear();
			pendingTakeover.capture(event.text);
			pendingTakeoverImages = event.images?.map((image) => ({ ...image }));
			suppressDecisionAbort = true;
			decisionAssistantToSplice = {
				kind: "decision",
				claim: active.claim,
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
			return { action: "handled" };
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

		// While a decision is confirmed, only the reserved result function may
		// execute. Unrelated tools are blocked before side effects; a malformed
		// batch (zero, duplicate, or mixed calls) additionally terminates so no
		// follow-up model request runs for a response counted once as invalid.
		options.pi.on("tool_call", (event, ctx) => {
			const toolCallId = (event as { readonly toolCallId?: unknown })
				.toolCallId;
			const toolName = (event as { readonly toolName?: unknown }).toolName;
			observeLiveState(ctx, {
				preserveGeneration: selfDecisionRun.kind !== "none",
			});
			if (quarantinedDecision !== null) {
				return {
					block: true,
					reason: DECISION_TOOL_BLOCK_REASON,
					terminate: true,
				};
			}
			const active = currentConsumedDecision();
			if (active === null || pendingFinalization !== null) return;
			// The batch shape is recorded at message_end before any tool runs.
			// Exactly one authorized cw call executes; every other recorded call,
			// including extra cw calls, is part of a malformed batch.
			const recorded = active.responseToolCallIds;
			const authorizedCall =
				recorded.size === 1 &&
				recorded.has(typeof toolCallId === "string" ? toolCallId : "") &&
				toolName === DECISION_TOOL_NAME;
			if (authorizedCall) return;
			return {
				block: true,
				reason: DECISION_TOOL_BLOCK_REASON,
				terminate: true,
			};
		});

		// Pi treats normal execute returns as successful. Project the error flag
		// only for our current staged invalid call; do not trust public details.
		options.pi.on("tool_result", (event) => {
			const active = currentConsumedDecision();
			if (
				event.toolName === DECISION_TOOL_NAME &&
				active?.stagedResult?.toolCallId === event.toolCallId &&
				!active.stagedResult.validation.valid
			) {
				return { isError: true };
			}
		});

		options.pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
			retryInquiryCleanup();
			confirmContinuationPublication(true);
			watchdogOwnedRun = null;
			// manualCancellation belongs to the run whose abort produced this
			// authoritative settle. Foreign input may already have cleared active
			// ownership, so retirement cannot depend on watchdogOwnedRun still being
			// present. The independent splice target remains until presentation cleanup.
			if (manualCancellation !== null) {
				manualCancellation = null;
				suppressDecisionAbort = false;
			}
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
			if (active !== null && !active.contextConfirmed && !active.invalidated) {
				// A displayed/queued prompt is not a consumed decision response.
				// Release it without a correction charge; fresh idle can retry entry.
				deferDecisionOnBusy(active);
			} else {
				finalizeActiveDecision("missing");
			}
			const continued =
				(await sendPendingContinuation(ctx)) || (await deliverPending(ctx));
			if (!continued && probePiAgentState(ctx).idle)
				spliceDecisionAssistant(ctx);
			if (!continued) await maybePublishUserReady();

			// Re-issue a captured takeover as a fresh user turn now that the
			// preempted decision has settled. The shared guard lets this exact
			// text through when it re-enters the input hook.
			if (probePiAgentState(ctx).idle) {
				const takeover = pendingTakeover.takeForReissue();
				if (takeover !== null) {
					const images = pendingTakeoverImages;
					pendingTakeoverImages = undefined;
					await options.pi.sendUserMessage(
						images?.length
							? [{ type: "text", text: takeover }, ...images]
							: takeover,
					);
				}
			}
		});
	};

	const shutdown = async (ctx = sessionContext ?? undefined): Promise<void> => {
		if (stopped) return;
		const detachedIdle = ctx === undefined ? true : probePiAgentState(ctx).idle;
		stopped = true;
		lifecycleGeneration += 1;
		localActivityGeneration += 1;
		quarantinedDecision = null;
		watchdogOwnedRun = null;
		manualCancellation = null;
		decisionAssistantToSplice = null;
		suppressDecisionAbort = false;
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
