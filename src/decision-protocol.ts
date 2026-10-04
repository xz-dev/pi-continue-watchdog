import { hasAtMostUnicodeCodePoints } from "./config.js";
import type {
	ControllerTransition,
	LockDecisionController,
} from "./controller.js";

/** Public model-visible function name for watchdog decision results. */
export const DECISION_TOOL_NAME = "cw";

/** The fixed re-ask budget is owned by the controller, not configuration. */
export const DECISION_INVALID_ATTEMPT_LIMIT = 3;

/**
 * Hard limit for model-provided reason_content, in Unicode code points.
 * The prompt-stated guidance is derived as half of this value so the two
 * can never drift apart when the constant is edited.
 */
export const MAX_REASON_CHARACTERS = 1000;

/** Guidance limit stated in the decision prompt: always half the hard limit. */
export const REASON_GUIDANCE_CHARACTERS = MAX_REASON_CHARACTERS / 2;

export const MIN_WAIT_SECONDS = 1;
export const MAX_WAIT_SECONDS = 30 * 60;

export const INVALID_DECISION_ACTION_ERROR =
	"action must be one of continue, wait, or unlock (case-insensitive after trimming).";
export const MISSING_DECISION_FIELDS_ERROR =
	"The decision result requires a JSON object with action and reason_content.";
export const INVALID_CONTINUE_REASON_TYPE_ERROR = `continue requires reason_type matching one of the allowed continuation reason types for this project (case-insensitive after trimming).`;
export const INVALID_CONTINUE_REASON_ERROR = `continue requires a non-empty reason_content of at most ${MAX_REASON_CHARACTERS} Unicode characters.`;
export const MISSING_CONTINUE_FIELDS_ERROR =
	"continue requires reason_type and reason_content.";
export const INVALID_WAIT_REASON_ERROR = `wait requires a non-empty reason_content of at most ${MAX_REASON_CHARACTERS} Unicode characters.`;
export const INVALID_WAIT_SECONDS_ERROR = `wait requires an integer JSON number wait_seconds from ${MIN_WAIT_SECONDS} through ${MAX_WAIT_SECONDS}.`;
export const MISSING_WAIT_FIELDS_ERROR =
	"wait requires reason_content and wait_seconds.";
export const INVALID_WAIT_REASON_TYPE_ERROR =
	"wait does not use reason_type; use reason_content and wait_seconds only.";
export const INVALID_UNLOCK_REASON_TYPE_ERROR =
	"unlock requires reason_type matching one of the allowed unlock reason types for this project (case-insensitive after trimming).";
export const INVALID_UNLOCK_REASON_ERROR = `unlock requires a non-empty reason_content of at most ${MAX_REASON_CHARACTERS} Unicode characters.`;
export const MISSING_UNLOCK_FIELDS_ERROR =
	"unlock requires reason_type and reason_content.";
export const UNSUPPORTED_DECISION_CONTENT_ERROR =
	"The decision response contains unsupported content. Your entire response must be exactly one cw function call with nothing else.";
export const MALFORMED_DECISION_RESPONSE_ERROR =
	"The decision response was malformed. Your entire response must be exactly one cw function call.";
export const MISSING_DECISION_CALL_ERROR = `The decision response must submit exactly one ${DECISION_TOOL_NAME} function call.`;
export const MIXED_DECISION_CALLS_ERROR = `The decision response must contain exactly one ${DECISION_TOOL_NAME} call and no other tool calls.`;

/** Block reason returned for unrelated tool calls while a decision is open. */
export const DECISION_TOOL_BLOCK_REASON = `Do not call any other tool during the pi-continue-watchdog decision check. Submit your answer with exactly one ${DECISION_TOOL_NAME} function call and no other tool call.`;

/** Fixed guidance on the reserved function's delivery boundary. */
export const DECISION_DELIVERY_BOUNDARY = `The ${DECISION_TOOL_NAME} function submits a watchdog control result, not user-facing delivery. Answers, results, reports, and questions belong in the ordinary replies already delivered; reason_content never substitutes for a missing deliverable. reason_content is a control record for watchdog records and notifications, may be visible to the user, and must not be relied on as the user's answer.`;

export interface DecisionTextContent {
	readonly type: "text";
	readonly text: string;
}

export interface DecisionThinkingContent {
	readonly type: "thinking";
}

export interface DecisionToolCallContent {
	readonly type: "toolCall";
	readonly toolCallId: string;
	readonly name: string;
	readonly arguments: unknown;
}

export interface DecisionOtherContent {
	readonly type: "other" | "malformed";
}

export type DecisionResponseContent =
	| DecisionTextContent
	| DecisionThinkingContent
	| DecisionToolCallContent
	| DecisionOtherContent;

/**
 * Completed decision response abstraction. Runtime adapters convert Pi's
 * AssistantMessage content into this small shape before protocol validation.
 */
export interface DecisionResponse {
	readonly content: readonly DecisionResponseContent[];
}

export type ValidDecision =
	| {
			readonly kind: "continue";
			readonly reasonType: string;
			readonly reason: string;
	  }
	| {
			readonly kind: "wait";
			readonly reason: string;
			readonly waitSeconds: number;
	  }
	| {
			readonly kind: "unlock";
			readonly reasonType: string;
			readonly reason: string;
	  };

export type DecisionValidation =
	| { readonly valid: true; readonly decision: ValidDecision }
	| { readonly valid: false; readonly error: string };

export type DecisionProtocolOutcome =
	| "continue"
	| "wait"
	| "unlock"
	| "reask"
	| "decision-failed"
	| "ignored";

export interface DecisionProtocolFinalization {
	readonly outcome: DecisionProtocolOutcome;
	readonly transition: ControllerTransition;
	readonly error?: string;
	/** Present only for a re-ask, before the runtime dispatches its automated prompt. */
	readonly reaskPrompt?: string;
	readonly reasonType?: string;
	readonly reason?: string;
	readonly waitSeconds?: number;
	readonly acceptedAtMs?: number;
	readonly waitUntilMs?: number;
	readonly notification?: string;
	/** Response cycle that produced this finalization (valid and invalid outcomes). */
	readonly cycleId?: number;
}

/** A parsed response whose controller transition has not yet been committed. */
export type DecisionProtocolPlan =
	| {
			readonly outcome: "continue";
			readonly cycleId: number;
			readonly reasonType: string;
			readonly reason: string;
	  }
	| {
			readonly outcome: "wait";
			readonly cycleId: number;
			readonly reason: string;
			readonly waitSeconds: number;
	  }
	| {
			readonly outcome: "unlock";
			readonly cycleId: number;
			readonly reasonType: string;
			readonly reason: string;
	  }
	| {
			readonly outcome: "invalid";
			readonly cycleId: number;
			readonly error: string;
	  }
	| { readonly outcome: "ignored" };

export interface DecisionProtocolSessionOptions {
	readonly controller: LockDecisionController;
	readonly decisionId: number;
	/** The configured base automated decision prompt, used only for invalid re-asks. */
	readonly decisionPrompt: string;
	/** Effective allowed AI unlock reason types for this decision window. */
	readonly reasonTypes: readonly string[];
	/** Effective allowed automatic-continue reason types for this decision window. */
	readonly continueReasonTypes: readonly string[];
	/** Clock used to convert accepted wait seconds into an absolute timestamp. */
	readonly now?: () => number;
}

/**
 * Complete-response collector for one controller-owned decision window.
 * Validates the final assistant function-call answer; it neither sends
 * messages nor folds context nor owns timers.
 */
export interface DecisionProtocolSession {
	/** Monotonically increasing response-cycle token captured by runtime callbacks. */
	readonly currentCycleId: number;
	/** Parse and validate a response without changing controller state. */
	readonly planResponse: (
		cycleId: number,
		response: DecisionResponse,
	) => DecisionProtocolPlan;
	/** Commit a previously planned response exactly once. */
	readonly commitResponse: (
		cycleId: number,
		plan: DecisionProtocolPlan,
	) => DecisionProtocolFinalization;
	/** Convenience seam for callers that do not need pre-commit fencing. */
	readonly finalizeResponse: (
		cycleId: number,
		response: DecisionResponse,
	) => DecisionProtocolFinalization;
	/**
	 * Acknowledge a cached re-ask. Runtime code must call this immediately before
	 * it dispatches that re-ask's automated prompt, so a synchronous next response
	 * is collected in the new cycle rather than rejected as stale.
	 */
	readonly advanceAfterReask: (cycleId: number) => boolean;
	/** Undo a just-advanced re-ask when final prompt submission deferred busy. */
	readonly rollbackAfterReask: (previousCycleId: number) => boolean;
}

function isOrdinaryObject(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Trim AI reason-type input, match case-insensitively against configured types,
 * and return the uppercase form of the matched configured entry.
 */
export function normalizeDecisionReasonType(
	reasonType: unknown,
	reasonTypes: readonly string[],
): string | null {
	if (typeof reasonType !== "string") return null;
	const trimmed = reasonType.trim();
	if (trimmed.length === 0) return null;
	const needle = trimmed.toLowerCase();
	for (const entry of reasonTypes) {
		if (entry.toLowerCase() === needle) {
			return entry.toUpperCase();
		}
	}
	return null;
}

/**
 * Trim and validate a model-provided decision reason. Unlike human command
 * input, this never truncates: invalid model output must be re-asked.
 */
export function normalizeDecisionReason(reason: unknown): string | null {
	if (typeof reason !== "string") return null;
	const trimmed = reason.trim();
	if (
		trimmed.length === 0 ||
		!hasAtMostUnicodeCodePoints(trimmed, MAX_REASON_CHARACTERS)
	)
		return null;
	return trimmed;
}

/** Integer JSON number wait duration within the accepted bounds. */
export function normalizeWaitSeconds(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
	return value >= MIN_WAIT_SECONDS && value <= MAX_WAIT_SECONDS ? value : null;
}

/**
 * Validate one raw function-call argument object against the decision JSON
 * contract. Called only for an authorized current decision attempt.
 */
export function validateDecisionArguments(
	args: unknown,
	reasonTypes: readonly string[],
	continueReasonTypes: readonly string[],
): DecisionValidation {
	if (!isOrdinaryObject(args)) {
		return { valid: false, error: MISSING_DECISION_FIELDS_ERROR };
	}
	const action = args.action;
	if (typeof action !== "string") {
		return { valid: false, error: INVALID_DECISION_ACTION_ERROR };
	}
	const normalizedAction = action.trim().toLowerCase();
	if (normalizedAction === "continue") {
		if (args.reason_type === undefined || args.reason_content === undefined) {
			return { valid: false, error: MISSING_CONTINUE_FIELDS_ERROR };
		}
		const reasonType = normalizeDecisionReasonType(
			args.reason_type,
			continueReasonTypes,
		);
		if (reasonType === null) {
			return { valid: false, error: INVALID_CONTINUE_REASON_TYPE_ERROR };
		}
		const reason = normalizeDecisionReason(args.reason_content);
		if (reason === null) {
			return { valid: false, error: INVALID_CONTINUE_REASON_ERROR };
		}
		return {
			valid: true,
			decision: { kind: "continue", reasonType, reason },
		};
	}
	if (normalizedAction === "wait") {
		if (args.reason_content === undefined || args.wait_seconds === undefined) {
			return { valid: false, error: MISSING_WAIT_FIELDS_ERROR };
		}
		if (args.reason_type !== undefined) {
			return { valid: false, error: INVALID_WAIT_REASON_TYPE_ERROR };
		}
		const reason = normalizeDecisionReason(args.reason_content);
		if (reason === null) {
			return { valid: false, error: INVALID_WAIT_REASON_ERROR };
		}
		const waitSeconds = normalizeWaitSeconds(args.wait_seconds);
		if (waitSeconds === null) {
			return { valid: false, error: INVALID_WAIT_SECONDS_ERROR };
		}
		return { valid: true, decision: { kind: "wait", reason, waitSeconds } };
	}
	if (normalizedAction === "unlock") {
		if (args.reason_type === undefined || args.reason_content === undefined) {
			return { valid: false, error: MISSING_UNLOCK_FIELDS_ERROR };
		}
		const reasonType = normalizeDecisionReasonType(
			args.reason_type,
			reasonTypes,
		);
		if (reasonType === null) {
			return { valid: false, error: INVALID_UNLOCK_REASON_TYPE_ERROR };
		}
		const reason = normalizeDecisionReason(args.reason_content);
		if (reason === null) {
			return { valid: false, error: INVALID_UNLOCK_REASON_ERROR };
		}
		return { valid: true, decision: { kind: "unlock", reasonType, reason } };
	}
	return { valid: false, error: INVALID_DECISION_ACTION_ERROR };
}

/**
 * Append the parser-critical function-call contract to the configurable
 * decision intent. Keeping this suffix fixed prevents a custom decisionPrompt
 * from accidentally making every decision unparsable.
 */
export function buildDecisionPrompt(
	decisionPrompt: string,
	reasonTypes: readonly string[],
	continueReasonTypes: readonly string[],
): string {
	const allowedReasonTypes = JSON.stringify(reasonTypes);
	const allowedContinueReasonTypes = JSON.stringify(continueReasonTypes);
	const configuredReasonType = (builtIn: string): string | null => {
		const match = reasonTypes.find(
			(reasonType) => reasonType.toLowerCase() === builtIn.toLowerCase(),
		);
		return match === undefined ? null : match.toUpperCase();
	};
	const waitUserType = configuredReasonType("WAIT_USER");
	const jobDoneType = configuredReasonType("JOB_DONE");
	const jobBlockedType = configuredReasonType("JOB_BLOCKED");
	const waitCallbackType = configuredReasonType("WAIT_CALLBACK");
	const waitUserGuidance =
		waitUserType === null
			? "choose the allowed reason_type value that represents required user action"
			: `the default reason_type is ${waitUserType}`;
	const jobDoneGuidance =
		jobDoneType === null
			? "choose the allowed reason_type value that represents completed work"
			: `the default reason_type is ${jobDoneType}`;
	const jobBlockedGuidance =
		jobBlockedType === null
			? "choose the allowed reason_type value that represents a non-user blocker"
			: `the default reason_type is ${jobBlockedType}`;
	const callbackGuidance =
		waitCallbackType === null
			? "the allowed reason_type that represents waiting for a callback, when configured"
			: `${waitCallbackType}, when you are waiting for another agent or program to call back and wake this session rather than for elapsed time`;
	const continueExample = JSON.stringify({
		action: "continue",
		reason_type: continueReasonTypes[0] ?? "ALLOWED_TYPE",
		reason_content: "concise reason",
	});
	const waitExample = JSON.stringify({
		action: "wait",
		reason_content: "Waiting for automation.",
		wait_seconds: 300,
	});
	const unlockExample = JSON.stringify({
		action: "unlock",
		reason_type: reasonTypes[0] ?? "ALLOWED_TYPE",
		reason_content: "concise reason",
	});
	return `${decisionPrompt}

Use only the existing conversation context and decide quickly. Do not make decisions on the user's behalf. Your entire response must be exactly one ${DECISION_TOOL_NAME} function call and no other tool call; express your reasoning inside its fields, above all reason_content. reason_content must be non-empty and at most ${REASON_GUIDANCE_CHARACTERS} Unicode characters.

First reconcile the user's outstanding requests with the latest ordinary assistant response and relevant tool results. Exclude work already delivered, cancelled, or superseded; preserve genuinely unfinished earlier requests. Earlier plans and watchdog reasons are not proof that work remains. A final response or stop marker alone is not proof of completion: compare actual deliverables with the requests. Before claiming that the user has not been answered, check whether the latest ordinary assistant response already answers the question. For continue, identify the specific missing deliverable and an authorized next action; do not repeat an already-delivered answer or invent optional follow-up work.

${DECISION_DELIVERY_BOUNDARY}

Choose the outcome using these rules in order:
1. If all requested work is complete, submit unlock. For reason_type, ${jobDoneGuidance}.
2. Submit continue only if at least one concrete requested and authorized next action can be performed immediately for a still-incomplete deliverable without additional user input or approval. reason_content must name that immediately executable action, not a user-blocked action. Unfinished work alone is not sufficient reason to continue.
3. If no concrete next action can proceed without additional user input, approval, confirmation, authorization, credentials, or another user action, submit unlock. For reason_type, ${waitUserGuidance}. Existing permission already granted this session is not missing permission; never ask again for permission the user already gave.
4. If no authorized action can be performed now and progress only requires temporary external automation or elapsed time and no user action is required, submit wait with an integer wait_seconds from ${MIN_WAIT_SECONDS} through ${MAX_WAIT_SECONDS}.
5. If you are waiting for another agent or program to call back and wake this session instead of elapsed time, submit unlock with reason_type ${callbackGuidance}.
6. Otherwise, if work cannot proceed for a blocker that is neither user action nor a temporary external wait, submit unlock. For reason_type, ${jobBlockedGuidance}.

Call the reserved function ${DECISION_TOOL_NAME} with exactly one JSON object:
- To continue: {"action":"continue","reason_type":"...","reason_content":"..."} where reason_type must exactly match one of this JSON list (case-insensitive after trimming): ${allowedContinueReasonTypes}. Example: ${continueExample}
- To unlock: {"action":"unlock","reason_type":"...","reason_content":"..."} where reason_type must exactly match one of this JSON list (case-insensitive after trimming): ${allowedReasonTypes}. Example: ${unlockExample}
- To wait: {"action":"wait","reason_content":"...","wait_seconds":300} with no reason_type. Example: ${waitExample}

Submit exactly one ${DECISION_TOOL_NAME} call for this decision; do not call ${DECISION_TOOL_NAME} again later during ordinary work.`;
}

/**
 * Apply the function-call decision protocol to a completed normalized
 * assistant response. Thinking blocks are ignored. The response must contain
 * exactly one reserved-function call and no other tool call; text and any
 * other content make the whole response invalid.
 */
export function validateDecisionResponse(
	response: DecisionResponse,
	reasonTypes: readonly string[],
	continueReasonTypes: readonly string[],
): DecisionValidation {
	const content = response.content;
	if (!Array.isArray(content)) {
		return { valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR };
	}

	let reservedCall: DecisionToolCallContent | null = null;
	for (const block of content) {
		if (block === undefined || block.type === "thinking") continue;
		if (block.type === "toolCall") {
			if (block.name === DECISION_TOOL_NAME) {
				if (reservedCall !== null) {
					return { valid: false, error: MIXED_DECISION_CALLS_ERROR };
				}
				reservedCall = block;
				continue;
			}
			return { valid: false, error: MIXED_DECISION_CALLS_ERROR };
		}
		if (block.type === "text") {
			if (block.text.trim().length === 0) continue;
			// Text (including any old XML decision document) is never a result
			// transport; the response lacks its reserved function call.
			return { valid: false, error: MISSING_DECISION_CALL_ERROR };
		}
		if (block.type === "malformed") {
			return { valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR };
		}
		return { valid: false, error: UNSUPPORTED_DECISION_CONTENT_ERROR };
	}

	if (reservedCall === null) {
		return { valid: false, error: MISSING_DECISION_CALL_ERROR };
	}
	return validateDecisionArguments(
		reservedCall.arguments,
		reasonTypes,
		continueReasonTypes,
	);
}

function malformedResponse(): DecisionResponse {
	return { content: [{ type: "malformed" }] };
}

function normalizeAssistantContentBlock(
	input: unknown,
): DecisionResponseContent {
	if (!isOrdinaryObject(input) || typeof input.type !== "string") {
		return { type: "malformed" };
	}

	switch (input.type) {
		case "thinking":
			return { type: "thinking" };
		case "text":
			return typeof input.text === "string"
				? { type: "text", text: input.text }
				: { type: "malformed" };
		case "toolCall": {
			if (typeof input.id !== "string" || typeof input.name !== "string") {
				return { type: "malformed" };
			}
			if (!Object.hasOwn(input, "arguments")) {
				return { type: "malformed" };
			}
			return {
				type: "toolCall",
				toolCallId: input.id,
				name: input.name,
				arguments: input.arguments,
			};
		}
		default:
			return { type: "other" };
	}
}

/**
 * Convert Pi's completed AssistantMessage structural shape without importing Pi
 * internals. Non-assistant or malformed values become a fixed validation failure.
 */
export function normalizeAssistantDecisionResponse(
	message: unknown,
): DecisionResponse {
	if (!isOrdinaryObject(message)) return malformedResponse();
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return malformedResponse();
	}

	const normalized: DecisionResponseContent[] = [];
	for (const block of message.content) {
		normalized.push(normalizeAssistantContentBlock(block));
	}
	return { content: normalized };
}

/** Build the immediate re-ask body from a safe fixed validator error. */
export function buildDecisionReaskPrompt(
	decisionPrompt: string,
	error: string,
): string {
	return `${decisionPrompt}

Your previous decision response was invalid: ${error}
Correct it now. Your entire response must be exactly one ${DECISION_TOOL_NAME} function call with the corrected JSON arguments and no other tool call.`;
}

/** Exact user-only warning text emitted by future runtime wiring on failure. */
export function formatDecisionFailedNotification(error: string): string {
	return `Continue watchdog decision failed after ${DECISION_INVALID_ATTEMPT_LIMIT} attempts: ${error}`;
}

/**
 * Create one stateful collector for a controller-owned decision window. The
 * collector validates whole-assistant-message function-call answers; it neither
 * sends messages nor folds context nor owns timers.
 */
export function createDecisionProtocolSession(
	options: DecisionProtocolSessionOptions,
): DecisionProtocolSession {
	let cycleId = 1;
	let finalized: DecisionProtocolFinalization | null = null;

	const ignoredFinalization = (): DecisionProtocolFinalization => ({
		outcome: "ignored",
		transition: {
			applied: false,
			snapshot: options.controller.snapshot,
			effects: [],
		},
	});

	const finalizeInvalid = (error: string): DecisionProtocolFinalization => {
		const transition = options.controller.recordInvalidDecision(
			options.decisionId,
			error,
		);
		if (!transition.applied) {
			return { outcome: "ignored", transition };
		}
		if (transition.snapshot.decisionFailed) {
			return {
				outcome: "decision-failed",
				transition,
				error,
				notification: formatDecisionFailedNotification(error),
				cycleId,
			};
		}
		return {
			outcome: "reask",
			transition,
			error,
			reaskPrompt: buildDecisionReaskPrompt(options.decisionPrompt, error),
			cycleId,
		};
	};

	const planResponse = (
		expectedCycleId: number,
		response: DecisionResponse,
	): DecisionProtocolPlan => {
		if (expectedCycleId !== cycleId || finalized !== null) {
			return { outcome: "ignored" };
		}
		const validation = validateDecisionResponse(
			response,
			options.reasonTypes,
			options.continueReasonTypes,
		);
		if (!validation.valid) {
			return { outcome: "invalid", cycleId, error: validation.error };
		}
		if (validation.decision.kind === "continue") {
			return {
				outcome: "continue",
				cycleId,
				reasonType: validation.decision.reasonType,
				reason: validation.decision.reason,
			};
		}
		if (validation.decision.kind === "wait") {
			return {
				outcome: "wait",
				cycleId,
				reason: validation.decision.reason,
				waitSeconds: validation.decision.waitSeconds,
			};
		}
		return {
			outcome: "unlock",
			cycleId,
			reasonType: validation.decision.reasonType,
			reason: validation.decision.reason,
		};
	};

	const commitResponse = (
		expectedCycleId: number,
		plan: DecisionProtocolPlan,
	): DecisionProtocolFinalization => {
		if (expectedCycleId !== cycleId) return ignoredFinalization();
		if (finalized !== null) return finalized;
		if (plan.outcome === "ignored" || plan.cycleId !== cycleId) {
			return ignoredFinalization();
		}
		if (plan.outcome === "invalid") {
			finalized = finalizeInvalid(plan.error);
			return finalized;
		}

		if (plan.outcome === "continue") {
			const transition = options.controller.recordValidContinue(
				options.decisionId,
			);
			if (!transition.applied) {
				finalized = { outcome: "ignored", transition };
				return finalized;
			}
			finalized = {
				outcome: "continue",
				transition,
				reasonType: plan.reasonType,
				reason: plan.reason,
				cycleId,
			};
			return finalized;
		}
		if (plan.outcome === "wait") {
			const acceptedAtMs = options.now?.() ?? Date.now();
			const waitUntilMs = Math.ceil(acceptedAtMs + plan.waitSeconds * 1_000);
			const transition = options.controller.recordValidWait(
				options.decisionId,
				waitUntilMs,
			);
			if (!transition.applied) {
				finalized = { outcome: "ignored", transition };
				return finalized;
			}
			finalized = {
				outcome: "wait",
				transition,
				reason: plan.reason,
				waitSeconds: plan.waitSeconds,
				acceptedAtMs,
				waitUntilMs,
				cycleId,
			};
			return finalized;
		}
		const transition = options.controller.recordValidUnlock(options.decisionId);
		if (!transition.applied) {
			finalized = { outcome: "ignored", transition };
			return finalized;
		}
		finalized = {
			outcome: "unlock",
			transition,
			reasonType: plan.reasonType,
			reason: plan.reason,
			cycleId,
		};
		return finalized;
	};

	const finalizeResponse = (
		expectedCycleId: number,
		response: DecisionResponse,
	): DecisionProtocolFinalization =>
		commitResponse(expectedCycleId, planResponse(expectedCycleId, response));

	const advanceAfterReask = (expectedCycleId: number): boolean => {
		if (
			expectedCycleId !== cycleId ||
			finalized?.outcome !== "reask" ||
			!options.controller.snapshot.decisionOpen
		) {
			return false;
		}
		finalized = null;
		cycleId += 1;
		return true;
	};

	const rollbackAfterReask = (previousCycleId: number): boolean => {
		if (cycleId !== previousCycleId + 1 || finalized !== null) return false;
		cycleId = previousCycleId;
		return true;
	};

	return {
		get currentCycleId(): number {
			return cycleId;
		},
		planResponse,
		commitResponse,
		finalizeResponse,
		advanceAfterReask,
		rollbackAfterReask,
	};
}
