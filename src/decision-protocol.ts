import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import type {
	ControllerTransition,
	LockDecisionController,
} from "./controller.js";
import type {
	DecisionToolCall,
	DecisionToolExecutor,
} from "./decision-tools.js";

/** The fixed re-ask budget is owned by the controller, not configuration. */
export const DECISION_INVALID_ATTEMPT_LIMIT = 3;

/** Minimal model-visible result recorded while the whole response is validated. */
export const DECISION_TOOL_RESULT_MESSAGE = "Decision recorded.";

/** Fixed neutral result for a tool call arriving after a cycle was finalized. */
export const STALE_DECISION_TOOL_RESULT_MESSAGE =
	"This pi-continue-watchdog decision response has already been finalized.";

export const NO_DECISION_TOOL_ERROR = "Call exactly one decision tool.";
export const MULTIPLE_DECISION_TOOLS_ERROR =
	"Call exactly one decision tool; multiple decision tools were called.";
export const UNKNOWN_DECISION_TOOL_ERROR =
	"Call exactly one decision tool; no extra or unknown tools are allowed.";
export const PROSE_DECISION_RESPONSE_ERROR =
	"Do not answer with prose; call exactly one decision tool.";
export const CONTINUE_ARGUMENTS_ERROR =
	"continue_watchdog must be called with an empty object.";
export const INVALID_UNLOCK_REASON_ERROR =
	"unlock_continue_watchdog requires a non-empty reason of at most 500 Unicode characters.";
export const UNSUPPORTED_DECISION_CONTENT_ERROR =
	"The decision response contains unsupported content. Call exactly one decision tool.";
export const MALFORMED_DECISION_RESPONSE_ERROR =
	"The decision response was malformed. Call exactly one decision tool.";
export const DECISION_TOOL_NOT_EXECUTED_ERROR =
	"The decision tool was not executed. Call exactly one decision tool.";
export const DECISION_TOOLS_MISMATCH_ERROR =
	"The executed decision tool did not match the decision response. Call exactly one decision tool.";

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
	| { readonly kind: "continue"; readonly toolCallId: string }
	| {
			readonly kind: "unlock";
			readonly toolCallId: string;
			readonly reason: string;
	  };

export type DecisionValidation =
	| { readonly valid: true; readonly decision: ValidDecision }
	| { readonly valid: false; readonly error: string };

export type DecisionProtocolOutcome =
	| "continue"
	| "unlock"
	| "reask"
	| "decision-failed"
	| "ignored";

export interface DecisionProtocolFinalization {
	readonly outcome: DecisionProtocolOutcome;
	readonly transition: ControllerTransition;
	readonly error?: string;
	/** Present only for a re-ask, before the runtime dispatches its hidden prompt. */
	readonly reaskPrompt?: string;
	readonly reason?: string;
	readonly notification?: string;
	/** Present for valid continue/unlock so runtime can persist a fold marker. */
	readonly toolCallId?: string;
	/** Response cycle that produced this finalization (valid and invalid outcomes). */
	readonly cycleId?: number;
}

export interface DecisionProtocolSessionOptions {
	readonly controller: LockDecisionController;
	readonly decisionId: number;
	/** The configured base hidden decision prompt, used only for invalid re-asks. */
	readonly decisionPrompt: string;
}

/**
 * Complete-response collector shared by the individual Pi decision tools.
 * Each tool execution is inert until `finalizeResponse()` validates the
 * completed assistant response as a whole.
 */
export interface DecisionProtocolSession extends DecisionToolExecutor {
	/** Monotonically increasing response-cycle token captured by runtime callbacks. */
	readonly currentCycleId: number;
	/**
	 * Finalize exactly one completed response for `cycleId`. A duplicate callback
	 * for the current cycle receives the same cached result; another cycle's
	 * callback is ignored without changing controller state.
	 */
	readonly finalizeResponse: (
		cycleId: number,
		response: DecisionResponse,
	) => DecisionProtocolFinalization;
	/**
	 * Acknowledge a cached re-ask. Runtime code must call this immediately before
	 * it dispatches that re-ask's hidden prompt, so a synchronous next response
	 * is collected in the new cycle rather than rejected as stale.
	 */
	readonly advanceAfterReask: (cycleId: number) => boolean;
}

interface RecordedDecisionToolCall {
	readonly cycleId: number;
	readonly kind: "continue" | "unlock";
	readonly toolCallId: string;
	readonly reason?: string | null;
}

function isOrdinaryObject(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasExactlyOwnKeys(
	input: unknown,
	expectedKeys: readonly string[],
): boolean {
	if (!isOrdinaryObject(input)) return false;
	const keys = Object.keys(input);
	return (
		keys.length === expectedKeys.length &&
		expectedKeys.every((key) => keys.includes(key))
	);
}

/**
 * Trim and validate a model-provided unlock reason. Unlike human command input,
 * this never truncates: invalid model output must be re-asked.
 */
export function normalizeDecisionUnlockReason(reason: unknown): string | null {
	if (typeof reason !== "string") return null;
	const trimmed = reason.trim();
	if (trimmed.length === 0 || Array.from(trimmed).length > 500) return null;
	return trimmed;
}

function validateToolCall(
	content: DecisionToolCallContent,
): DecisionValidation {
	if (content.name === "continue_watchdog") {
		if (!hasExactlyOwnKeys(content.arguments, [])) {
			return { valid: false, error: CONTINUE_ARGUMENTS_ERROR };
		}
		return {
			valid: true,
			decision: { kind: "continue", toolCallId: content.toolCallId },
		};
	}

	if (content.name === "unlock_continue_watchdog") {
		if (!hasExactlyOwnKeys(content.arguments, ["reason"])) {
			return { valid: false, error: INVALID_UNLOCK_REASON_ERROR };
		}
		const normalizedReason = normalizeDecisionUnlockReason(
			(content.arguments as Record<string, unknown>).reason,
		);
		if (normalizedReason === null) {
			return { valid: false, error: INVALID_UNLOCK_REASON_ERROR };
		}
		return {
			valid: true,
			decision: {
				kind: "unlock",
				toolCallId: content.toolCallId,
				reason: normalizedReason,
			},
		};
	}

	return { valid: false, error: UNKNOWN_DECISION_TOOL_ERROR };
}

/**
 * Apply the exactly-one/no-prose decision protocol to a completed normalized
 * assistant response. Thinking blocks are ignored: they are not model prose.
 */
export function validateDecisionResponse(
	response: DecisionResponse,
): DecisionValidation {
	const toolCalls: DecisionToolCallContent[] = [];
	const content = response.content;
	if (!Array.isArray(content)) {
		return { valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR };
	}

	for (const block of content) {
		if (block === undefined || block.type === "thinking") continue;
		if (block.type === "text") {
			if (block.text.trim().length > 0) {
				return { valid: false, error: PROSE_DECISION_RESPONSE_ERROR };
			}
			continue;
		}
		if (block.type === "toolCall") {
			toolCalls.push(block);
			continue;
		}
		if (block.type === "malformed") {
			return { valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR };
		}
		return { valid: false, error: UNSUPPORTED_DECISION_CONTENT_ERROR };
	}

	if (toolCalls.length === 0) {
		return { valid: false, error: NO_DECISION_TOOL_ERROR };
	}
	if (
		toolCalls.some(
			(toolCall) =>
				toolCall.name !== "continue_watchdog" &&
				toolCall.name !== "unlock_continue_watchdog",
		)
	) {
		return { valid: false, error: UNKNOWN_DECISION_TOOL_ERROR };
	}
	if (toolCalls.length > 1) {
		return { valid: false, error: MULTIPLE_DECISION_TOOLS_ERROR };
	}
	const toolCall = toolCalls[0];
	if (toolCall === undefined) {
		return { valid: false, error: NO_DECISION_TOOL_ERROR };
	}
	return validateToolCall(toolCall);
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

/** Build the hidden immediate re-ask body from a safe fixed validator error. */
export function buildDecisionReaskPrompt(
	decisionPrompt: string,
	error: string,
): string {
	return `${decisionPrompt}\n\nYour previous decision response was invalid: ${error}\nCorrect it now: call exactly one decision tool and do not answer with prose.`;
}

/** Exact user-only warning text emitted by future runtime wiring on failure. */
export function formatDecisionFailedNotification(error: string): string {
	return `Continue watchdog decision failed after ${DECISION_INVALID_ATTEMPT_LIMIT} attempts: ${error}`;
}

function recordedDecisionToolResult(): AgentToolResult<{
	readonly kind: "decision-recorded";
}> {
	return {
		content: [{ type: "text", text: DECISION_TOOL_RESULT_MESSAGE }],
		details: { kind: "decision-recorded" },
		terminate: true,
	};
}

function staleDecisionToolResult(): AgentToolResult<{
	readonly kind: "stale-decision-tool";
}> {
	return {
		content: [{ type: "text", text: STALE_DECISION_TOOL_RESULT_MESSAGE }],
		details: { kind: "stale-decision-tool" },
		terminate: true,
	};
}

function matchesRecordedTool(
	decision: ValidDecision,
	cycleId: number,
	recorded: readonly RecordedDecisionToolCall[],
): string | null {
	if (recorded.length === 0) return DECISION_TOOL_NOT_EXECUTED_ERROR;
	const recordedCall = recorded[0];
	if (
		recorded.length !== 1 ||
		recordedCall === undefined ||
		recordedCall.cycleId !== cycleId ||
		recordedCall.kind !== decision.kind ||
		recordedCall.toolCallId !== decision.toolCallId ||
		(decision.kind === "unlock" && recordedCall.reason !== decision.reason)
	) {
		return DECISION_TOOLS_MISMATCH_ERROR;
	}
	return null;
}

/**
 * Create one stateful collector for a controller-owned decision window. The
 * collector bridges individual Pi tool executions to whole-assistant-message
 * validation; it neither sends messages nor folds context nor owns timers.
 */
export function createDecisionProtocolSession(
	options: DecisionProtocolSessionOptions,
): DecisionProtocolSession {
	let cycleId = 1;
	let recorded: RecordedDecisionToolCall[] = [];
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

	const onDecisionToolCall = (
		call: DecisionToolCall,
	): AgentToolResult<unknown> => {
		if (finalized !== null) return staleDecisionToolResult();
		recorded.push({
			cycleId,
			kind: call.kind,
			toolCallId: call.toolCallId,
			reason:
				call.kind === "unlock"
					? normalizeDecisionUnlockReason(call.reason)
					: undefined,
		});
		return recordedDecisionToolResult();
	};

	const finalizeResponse = (
		expectedCycleId: number,
		response: DecisionResponse,
	): DecisionProtocolFinalization => {
		if (expectedCycleId !== cycleId) return ignoredFinalization();
		if (finalized !== null) return finalized;

		const validation = validateDecisionResponse(response);
		if (!validation.valid) {
			finalized = finalizeInvalid(validation.error);
			return finalized;
		}

		const collectorError = matchesRecordedTool(
			validation.decision,
			cycleId,
			recorded,
		);
		if (collectorError !== null) {
			finalized = finalizeInvalid(collectorError);
			return finalized;
		}

		const transition =
			validation.decision.kind === "continue"
				? options.controller.recordValidContinue(options.decisionId)
				: options.controller.recordValidUnlock(options.decisionId);
		if (!transition.applied) {
			finalized = { outcome: "ignored", transition };
			return finalized;
		}
		if (validation.decision.kind === "continue") {
			finalized = {
				outcome: "continue",
				transition,
				toolCallId: validation.decision.toolCallId,
				cycleId,
			};
			return finalized;
		}
		finalized = {
			outcome: "unlock",
			transition,
			reason: validation.decision.reason,
			toolCallId: validation.decision.toolCallId,
			cycleId,
		};
		return finalized;
	};

	const advanceAfterReask = (expectedCycleId: number): boolean => {
		if (
			expectedCycleId !== cycleId ||
			finalized?.outcome !== "reask" ||
			!options.controller.snapshot.decisionOpen
		) {
			return false;
		}
		recorded = [];
		finalized = null;
		cycleId += 1;
		return true;
	};

	return {
		get currentCycleId(): number {
			return cycleId;
		},
		onDecisionToolCall,
		finalizeResponse,
		advanceAfterReask,
	};
}
