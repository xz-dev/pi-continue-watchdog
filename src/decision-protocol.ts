import {
	buildXmlDocument,
	extractTrailingXml,
	parseTrailingXml,
} from "pi-extension-utils/xml";

import type {
	ControllerTransition,
	LockDecisionController,
} from "./controller.js";

/** The fixed re-ask budget is owned by the controller, not configuration. */
export const DECISION_INVALID_ATTEMPT_LIMIT = 3;

export const INVALID_DECISION_XML_ERROR =
	"End the response with one valid watchdog XML decision block.";
export const INVALID_CONTINUE_REASON_TYPE_ERROR =
	"continue_watchdog requires an allowed reason_type.";
export const INVALID_CONTINUE_REASON_ERROR =
	"continue_watchdog requires a non-empty reason_content of at most 500 Unicode characters.";
export const MISSING_CONTINUE_FIELDS_ERROR =
	"continue_watchdog requires reason_type and reason_content.";
export const INVALID_UNLOCK_REASON_TYPE_ERROR =
	"unlock_continue_watchdog requires an allowed reason_type.";
export const INVALID_UNLOCK_REASON_ERROR =
	"unlock_continue_watchdog requires a non-empty reason_content of at most 500 Unicode characters.";
export const MISSING_UNLOCK_FIELDS_ERROR =
	"unlock_continue_watchdog requires reason_type and reason_content.";
export const UNSUPPORTED_DECISION_CONTENT_ERROR =
	"The decision response contains unsupported content. End with the watchdog XML decision block.";
export const MALFORMED_DECISION_RESPONSE_ERROR =
	"The decision response was malformed. End with the watchdog XML decision block.";

/** Block reason returned for ordinary tool calls while a decision is open. */
export const DECISION_TOOL_BLOCK_REASON =
	"Do not call tools during the pi-continue-watchdog decision check. Answer from the existing conversation and end with exactly one watchdog XML decision block.";

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
			readonly kind: "unlock";
			readonly reasonType: string;
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
	/** Present only for a re-ask, before the runtime dispatches its automated prompt. */
	readonly reaskPrompt?: string;
	readonly reasonType?: string;
	readonly reason?: string;
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
}

/**
 * Complete-response collector for one controller-owned decision window.
 * Validates the final assistant XML answer; it neither sends messages nor folds
 * context nor owns timers.
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
 * Trim AI reasonType input, match case-insensitively against configured types,
 * and return the uppercase form of the matched configured entry.
 */
export function normalizeDecisionUnlockReasonType(
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
 * Trim and validate a model-provided unlock reason. Unlike human command input,
 * this never truncates: invalid model output must be re-asked.
 */
export function normalizeDecisionUnlockReason(reason: unknown): string | null {
	if (typeof reason !== "string") return null;
	const trimmed = reason.trim();
	if (trimmed.length === 0 || Array.from(trimmed).length > 500) return null;
	return trimmed;
}

/**
 * Append the parser-critical XML contract to the configurable decision intent.
 * Keeping this suffix fixed prevents a custom decisionPrompt from accidentally
 * making every decision unparsable.
 */
export function buildDecisionPrompt(
	decisionPrompt: string,
	reasonTypes: readonly string[],
	continueReasonTypes: readonly string[],
): string {
	const allowedReasonTypes = JSON.stringify(reasonTypes);
	const allowedContinueReasonTypes = JSON.stringify(continueReasonTypes);
	const continueExample = buildXmlDocument("watchdog", [
		{ name: "function", value: "continue_watchdog" },
		{ name: "reason_type", value: continueReasonTypes[0] ?? "ALLOWED_TYPE" },
		{ name: "reason_content", value: "concise reason" },
	]);
	const unlockExample = buildXmlDocument("watchdog", [
		{ name: "function", value: "unlock_continue_watchdog" },
		{ name: "reason_type", value: reasonTypes[0] ?? "ALLOWED_TYPE" },
		{ name: "reason_content", value: "concise reason" },
	]);
	return `${decisionPrompt}\n\nUse only the existing conversation context and decide quickly. Do not make decisions on the user's behalf. Do not call tools. You may explain your decision first, or output only XML. In either case, output exactly one <watchdog>...</watchdog> XML block at the very end of your response. After surrounding whitespace is trimmed, </watchdog> must be the final text. Do not output multiple <watchdog>...</watchdog> blocks.\n\nTo continue, reason_type must exactly match one of this JSON list (case-insensitive after trimming): ${allowedContinueReasonTypes}. End with:\n${continueExample}\n\nTo unlock, reason_type must exactly match one of this JSON list (case-insensitive after trimming): ${allowedReasonTypes}. End with:\n${unlockExample}`;
}

interface ParsedWatchdogFields {
	readonly functionName: string;
	readonly reasonType?: string;
	readonly reasonContent?: string;
}

export function extractTrailingWatchdogXml(
	fullNonThinkingAssistantText: string,
): string | null {
	return extractTrailingXml(fullNonThinkingAssistantText, "watchdog");
}

/** Strict XML syntax is shared; watchdog-specific required fields stay local. */
export function parseWatchdogDecisionXml(
	raw: string,
):
	| { readonly ok: true; readonly fields: ParsedWatchdogFields }
	| { readonly ok: false } {
	const parsed = parseTrailingXml(raw, "watchdog");
	if (!parsed.valid) return { ok: false };
	const functionName = parsed.value.fields.get("function");
	if (functionName === undefined) return { ok: false };
	return {
		ok: true,
		fields: {
			functionName,
			reasonType: parsed.value.fields.get("reason_type"),
			reasonContent: parsed.value.fields.get("reason_content"),
		},
	};
}

function validateParsedFields(
	fields: ParsedWatchdogFields,
	reasonTypes: readonly string[],
	continueReasonTypes: readonly string[],
): DecisionValidation {
	if (fields.functionName.trim().toLowerCase() === "continue_watchdog") {
		if (fields.reasonType === undefined || fields.reasonContent === undefined) {
			return { valid: false, error: MISSING_CONTINUE_FIELDS_ERROR };
		}
		const normalizedType = normalizeDecisionUnlockReasonType(
			fields.reasonType,
			continueReasonTypes,
		);
		if (normalizedType === null) {
			return { valid: false, error: INVALID_CONTINUE_REASON_TYPE_ERROR };
		}
		const normalizedReason = normalizeDecisionUnlockReason(
			fields.reasonContent,
		);
		if (normalizedReason === null) {
			return { valid: false, error: INVALID_CONTINUE_REASON_ERROR };
		}
		return {
			valid: true,
			decision: {
				kind: "continue",
				reasonType: normalizedType,
				reason: normalizedReason,
			},
		};
	}
	if (fields.functionName.trim().toLowerCase() !== "unlock_continue_watchdog") {
		return { valid: false, error: INVALID_DECISION_XML_ERROR };
	}
	if (fields.reasonType === undefined || fields.reasonContent === undefined) {
		return { valid: false, error: MISSING_UNLOCK_FIELDS_ERROR };
	}
	const normalizedType = normalizeDecisionUnlockReasonType(
		fields.reasonType,
		reasonTypes,
	);
	if (normalizedType === null) {
		return { valid: false, error: INVALID_UNLOCK_REASON_TYPE_ERROR };
	}
	const normalizedReason = normalizeDecisionUnlockReason(fields.reasonContent);
	if (normalizedReason === null) {
		return { valid: false, error: INVALID_UNLOCK_REASON_ERROR };
	}
	return {
		valid: true,
		decision: {
			kind: "unlock",
			reasonType: normalizedType,
			reason: normalizedReason,
		},
	};
}

/**
 * Apply the XML decision protocol to a completed normalized assistant response.
 * Thinking blocks and blocked ordinary tool-call blocks are ignored.
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

	const textParts: string[] = [];
	for (const block of content) {
		if (block === undefined || block.type === "thinking") continue;
		if (block.type === "toolCall") continue;
		if (block.type === "text") {
			textParts.push(block.text);
			continue;
		}
		if (block.type === "malformed") {
			return { valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR };
		}
		return { valid: false, error: UNSUPPORTED_DECISION_CONTENT_ERROR };
	}

	const parsed = parseWatchdogDecisionXml(textParts.join(""));
	if (!parsed.ok) {
		return { valid: false, error: INVALID_DECISION_XML_ERROR };
	}
	return validateParsedFields(parsed.fields, reasonTypes, continueReasonTypes);
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
	return `${decisionPrompt}\n\nYour previous decision response was invalid: ${error}\nCorrect it now without calling tools. You may explain first, but the watchdog XML block must be at the very end of your response.`;
}

/** Exact user-only warning text emitted by future runtime wiring on failure. */
export function formatDecisionFailedNotification(error: string): string {
	return `Continue watchdog decision failed after ${DECISION_INVALID_ATTEMPT_LIMIT} attempts: ${error}`;
}

/**
 * Create one stateful collector for a controller-owned decision window. The
 * collector validates whole-assistant-message XML answers; it neither sends
 * messages nor folds context nor owns timers.
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
		return validation.decision.kind === "continue"
			? {
					outcome: "continue",
					cycleId,
					reasonType: validation.decision.reasonType,
					reason: validation.decision.reason,
				}
			: {
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

		const transition =
			plan.outcome === "continue"
				? options.controller.recordValidContinue(options.decisionId)
				: options.controller.recordValidUnlock(options.decisionId);
		if (!transition.applied) {
			finalized = { outcome: "ignored", transition };
			return finalized;
		}
		if (plan.outcome === "continue") {
			finalized = {
				outcome: "continue",
				transition,
				reasonType: plan.reasonType,
				reason: plan.reason,
				cycleId,
			};
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
