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
 * AssistantMessage content into this small, provider-independent shape before
 * protocol validation. It deliberately excludes tool results and timers.
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
	readonly prompt?: string;
	readonly reason?: string;
	readonly notification?: string;
}

export interface DecisionProtocolSessionOptions {
	readonly controller: LockDecisionController;
	readonly decisionId: number;
	/** The configured base hidden decision prompt, used only for invalid re-asks. */
	readonly decisionPrompt: string;
}

/**
 * Complete-response collector shared by the individual Pi decision tools.
 * Each tool execution is deliberately inert until `finalize()` validates the
 * completed assistant response as a whole.
 */
export interface DecisionProtocolSession extends DecisionToolExecutor {
	readonly finalize: (
		response: DecisionResponse,
	) => DecisionProtocolFinalization;
}

type OwnDataProperty =
	| { readonly kind: "missing" }
	| { readonly kind: "data"; readonly value: unknown }
	| { readonly kind: "non-data" };

interface RecordedDecisionToolCall {
	readonly kind: "continue" | "unlock";
	readonly toolCallId: string;
	readonly reason?: string | null;
}

function readOwnDataProperty(
	input: unknown,
	key: PropertyKey,
): OwnDataProperty {
	if (
		input === null ||
		(typeof input !== "object" && typeof input !== "function")
	) {
		return { kind: "missing" };
	}

	try {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (descriptor === undefined) return { kind: "missing" };
		if (!("value" in descriptor)) return { kind: "non-data" };
		return { kind: "data", value: descriptor.value };
	} catch {
		return { kind: "non-data" };
	}
}

function ownKeys(input: unknown): readonly PropertyKey[] | null {
	if (input === null || typeof input !== "object") return null;
	try {
		return Reflect.ownKeys(input);
	} catch {
		return null;
	}
}

function isPlainObject(input: unknown): input is Record<PropertyKey, unknown> {
	if (input === null || typeof input !== "object") return false;
	try {
		const prototype = Object.getPrototypeOf(input);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function isWhitespaceOnlyText(content: DecisionTextContent): boolean {
	return content.text.trim().length === 0;
}

function getToolCallArgumentValue(
	argumentsValue: unknown,
	key: string,
): OwnDataProperty {
	if (!isPlainObject(argumentsValue)) return { kind: "non-data" };
	return readOwnDataProperty(argumentsValue, key);
}

function hasExactlyOwnKeys(
	input: unknown,
	expectedKeys: readonly string[],
): boolean {
	if (!isPlainObject(input)) return false;
	const keys = ownKeys(input);
	if (keys === null || keys.length !== expectedKeys.length) return false;
	return keys.every(
		(key) => typeof key === "string" && expectedKeys.includes(key),
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
		const reason = getToolCallArgumentValue(content.arguments, "reason");
		const normalizedReason =
			reason.kind === "data"
				? normalizeDecisionUnlockReason(reason.value)
				: null;
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
 * assistant response. Thinking blocks are intentionally ignored: they are not
 * model prose and Pi treats them as private reasoning content.
 */
export function validateDecisionResponse(
	response: DecisionResponse,
): DecisionValidation {
	const toolCalls: DecisionToolCallContent[] = [];

	for (const content of response.content) {
		if (content.type === "thinking") continue;
		if (content.type === "text") {
			if (!isWhitespaceOnlyText(content)) {
				return { valid: false, error: PROSE_DECISION_RESPONSE_ERROR };
			}
			continue;
		}
		if (content.type === "toolCall") {
			toolCalls.push(content);
			continue;
		}
		if (content.type === "malformed") {
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
	const content: readonly DecisionResponseContent[] = Object.freeze([
		{ type: "malformed" },
	]);
	return Object.freeze({ content });
}

function normalizeAssistantContentBlock(
	input: unknown,
): DecisionResponseContent {
	const type = readOwnDataProperty(input, "type");
	if (type.kind !== "data" || typeof type.value !== "string") {
		return { type: "malformed" };
	}
	if (type.value === "thinking") return { type: "thinking" };
	if (type.value === "text") {
		const text = readOwnDataProperty(input, "text");
		return text.kind === "data" && typeof text.value === "string"
			? { type: "text", text: text.value }
			: { type: "malformed" };
	}
	if (type.value !== "toolCall") return { type: "other" };

	const id = readOwnDataProperty(input, "id");
	const name = readOwnDataProperty(input, "name");
	const argumentsValue = readOwnDataProperty(input, "arguments");
	if (
		id.kind !== "data" ||
		typeof id.value !== "string" ||
		name.kind !== "data" ||
		typeof name.value !== "string" ||
		argumentsValue.kind !== "data"
	) {
		return { type: "malformed" };
	}
	return {
		type: "toolCall",
		toolCallId: id.value,
		name: name.value,
		arguments: argumentsValue.value,
	};
}

/**
 * Convert Pi's completed AssistantMessage structural shape without importing Pi
 * internals. The runtime can pass its public AgentMessage directly; non-assistant
 * or malformed values become a fixed validation failure rather than throwing or
 * exposing arbitrary provider data in a later re-ask.
 */
export function normalizeAssistantDecisionResponse(
	message: unknown,
): DecisionResponse {
	const role = readOwnDataProperty(message, "role");
	const content = readOwnDataProperty(message, "content");
	if (
		role.kind !== "data" ||
		role.value !== "assistant" ||
		content.kind !== "data" ||
		!Array.isArray(content.value)
	) {
		return malformedResponse();
	}

	const normalized: DecisionResponseContent[] = [];
	for (const block of content.value) {
		normalized.push(normalizeAssistantContentBlock(block));
	}
	return Object.freeze({ content: Object.freeze(normalized) });
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

function matchesRecordedTool(
	decision: ValidDecision,
	recorded: readonly RecordedDecisionToolCall[],
): string | null {
	if (recorded.length === 0) return DECISION_TOOL_NOT_EXECUTED_ERROR;
	const recordedCall = recorded[0];
	if (
		recorded.length !== 1 ||
		recordedCall === undefined ||
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
 * collector is intentionally the only Slice 6 bridge from individual Pi tool
 * executions to whole-assistant-message validation; it neither sends messages
 * nor folds context nor owns any timer or TUI effect.
 */
export function createDecisionProtocolSession(
	options: DecisionProtocolSessionOptions,
): DecisionProtocolSession {
	let recorded: RecordedDecisionToolCall[] = [];
	let finalized: DecisionProtocolFinalization | null = null;

	const onDecisionToolCall = (
		call: DecisionToolCall,
	): AgentToolResult<unknown> => {
		if (finalized === null) {
			recorded.push({
				kind: call.kind,
				toolCallId: call.toolCallId,
				reason:
					call.kind === "unlock"
						? normalizeDecisionUnlockReason(call.reason)
						: undefined,
			});
		}
		return recordedDecisionToolResult();
	};

	const finalize = (
		response: DecisionResponse,
	): DecisionProtocolFinalization => {
		if (finalized !== null) return finalized;

		const validation = validateDecisionResponse(response);
		if (!validation.valid) {
			const transition = options.controller.recordInvalidDecision(
				options.decisionId,
				validation.error,
			);
			recorded = [];
			if (!transition.applied) {
				finalized = Object.freeze({ outcome: "ignored", transition });
				return finalized;
			}
			if (transition.snapshot.decisionFailed) {
				finalized = Object.freeze({
					outcome: "decision-failed",
					transition,
					error: validation.error,
					notification: formatDecisionFailedNotification(validation.error),
				});
				return finalized;
			}
			return Object.freeze({
				outcome: "reask",
				transition,
				error: validation.error,
				prompt: buildDecisionReaskPrompt(
					options.decisionPrompt,
					validation.error,
				),
			});
		}

		const collectorError = matchesRecordedTool(validation.decision, recorded);
		if (collectorError !== null) {
			const transition = options.controller.recordInvalidDecision(
				options.decisionId,
				collectorError,
			);
			recorded = [];
			if (!transition.applied) {
				finalized = Object.freeze({ outcome: "ignored", transition });
				return finalized;
			}
			if (transition.snapshot.decisionFailed) {
				finalized = Object.freeze({
					outcome: "decision-failed",
					transition,
					error: collectorError,
					notification: formatDecisionFailedNotification(collectorError),
				});
				return finalized;
			}
			return Object.freeze({
				outcome: "reask",
				transition,
				error: collectorError,
				prompt: buildDecisionReaskPrompt(
					options.decisionPrompt,
					collectorError,
				),
			});
		}

		const transition =
			validation.decision.kind === "continue"
				? options.controller.recordValidContinue(options.decisionId)
				: options.controller.recordValidUnlock(options.decisionId);
		if (!transition.applied) {
			finalized = Object.freeze({ outcome: "ignored", transition });
			return finalized;
		}
		if (validation.decision.kind === "continue") {
			finalized = Object.freeze({ outcome: "continue", transition });
			return finalized;
		}
		finalized = Object.freeze({
			outcome: "unlock",
			transition,
			reason: validation.decision.reason,
		});
		return finalized;
	};

	return Object.freeze({ onDecisionToolCall, finalize });
}
