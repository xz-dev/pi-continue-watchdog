import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isValidPrompt } from "./config.js";

/** Stable persisted metadata version for decision exchanges and their fold marker. */
export const DECISION_PROTOCOL_VERSION = 1;

/** Hidden message that opens an automated decision-response cycle. */
export const DECISION_MESSAGE_TYPE = "pi-continue-watchdog:decision";

/** Hidden terminal record that makes a complete decision exchange foldable. */
export const DECISION_FOLD_MESSAGE_TYPE = "pi-continue-watchdog:decision-fold";

/** Model-bound compact replacement emitted only by the context hook. */
export const CONTINUATION_MESSAGE_TYPE = "pi-continue-watchdog:continuation";

export interface DecisionMessageDetails {
	readonly version: typeof DECISION_PROTOCOL_VERSION;
	readonly exchangeId: string;
	readonly cycleId: number;
}

export type DecisionFoldDetails =
	| {
			readonly version: typeof DECISION_PROTOCOL_VERSION;
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "unlock";
			readonly toolCallId: string;
	  }
	| {
			readonly version: typeof DECISION_PROTOCOL_VERSION;
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "continue";
			readonly toolCallId: string;
			readonly continuePrompt: string;
	  };

export interface DecisionPromptMessageInput {
	readonly exchangeId: string;
	readonly cycleId: number;
	readonly decisionPrompt: string;
}

export type DecisionFoldMessageInput =
	| {
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "unlock";
			readonly toolCallId: string;
	  }
	| {
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "continue";
			readonly toolCallId: string;
			readonly continuePrompt: string;
	  };

/** The sendMessage-compatible shape used by later decision-runtime wiring. */
export interface DecisionCustomMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details: unknown;
}

type DecisionToolName = "continue_watchdog" | "unlock_continue_watchdog";

type ParsedDecisionMessage = {
	readonly type: "decision";
	readonly exchangeId: string;
	readonly cycleId: number;
};

type ParsedFoldMarker =
	| {
			readonly type: "fold";
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "unlock";
			readonly toolCallId: string;
			readonly timestamp: number;
	  }
	| {
			readonly type: "fold";
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "continue";
			readonly toolCallId: string;
			readonly continuePrompt: string;
			readonly timestamp: number;
	  };

type ParsedPluginMessage =
	| { readonly type: "unrelated" }
	| { readonly type: "invalid" }
	| ParsedDecisionMessage
	| ParsedFoldMarker;

type ParsedToolCall = {
	readonly id: string;
	readonly name: DecisionToolName;
};

type ParsedToolResult = {
	readonly id: string;
	readonly name: DecisionToolName;
};

type FoldedSegment<T extends object> = {
	readonly endIndex: number;
	readonly replacement: T | undefined;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function validExchangeId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validCycleId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validToolCallId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isDecisionToolName(value: unknown): value is DecisionToolName {
	return value === "continue_watchdog" || value === "unlock_continue_watchdog";
}

/**
 * Pi sendMessage accepts a content string; after reload, custom messages use a
 * single text block. Accept either normal shape for plugin records.
 */
function customContentText(input: unknown): string | undefined {
	if (!isObject(input)) return undefined;
	const content = input.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const block = content[0];
	if (
		!isObject(block) ||
		block.type !== "text" ||
		typeof block.text !== "string"
	) {
		return undefined;
	}
	return block.text;
}

function decisionDetails(input: unknown): DecisionMessageDetails | undefined {
	if (!isObject(input)) return undefined;
	const exchangeId = input.exchangeId;
	const cycleId = input.cycleId;
	if (
		input.version !== DECISION_PROTOCOL_VERSION ||
		!validExchangeId(exchangeId) ||
		!validCycleId(cycleId)
	) {
		return undefined;
	}
	return {
		version: DECISION_PROTOCOL_VERSION,
		exchangeId,
		cycleId,
	};
}

function foldDetails(input: unknown): DecisionFoldDetails | undefined {
	if (!isObject(input)) return undefined;
	const exchangeId = input.exchangeId;
	const cycleId = input.cycleId;
	const toolCallId = input.toolCallId;
	const outcome = input.outcome;
	if (
		input.version !== DECISION_PROTOCOL_VERSION ||
		!validExchangeId(exchangeId) ||
		!validCycleId(cycleId) ||
		!validToolCallId(toolCallId)
	) {
		return undefined;
	}
	if (outcome === "unlock") {
		return {
			version: DECISION_PROTOCOL_VERSION,
			exchangeId,
			cycleId,
			outcome,
			toolCallId,
		};
	}
	if (outcome !== "continue" || !isValidPrompt(input.continuePrompt)) {
		return undefined;
	}
	return {
		version: DECISION_PROTOCOL_VERSION,
		exchangeId,
		cycleId,
		outcome,
		toolCallId,
		continuePrompt: input.continuePrompt,
	};
}

function parsePluginMessage(input: unknown): ParsedPluginMessage {
	if (!isObject(input) || input.role !== "custom") return { type: "unrelated" };
	const customType = asString(input.customType);
	if (
		customType !== DECISION_MESSAGE_TYPE &&
		customType !== DECISION_FOLD_MESSAGE_TYPE
	) {
		return { type: "unrelated" };
	}

	const timestamp = asFiniteNumber(input.timestamp);
	const content = customContentText(input);
	if (timestamp === undefined || content === undefined)
		return { type: "invalid" };

	if (customType === DECISION_MESSAGE_TYPE) {
		const parsed = decisionDetails(input.details);
		return parsed === undefined || !isValidPrompt(content)
			? { type: "invalid" }
			: { type: "decision", ...parsed };
	}

	const parsed = foldDetails(input.details);
	if (parsed === undefined) return { type: "invalid" };
	if (parsed.outcome === "unlock") {
		return content.length === 0
			? { type: "fold", ...parsed, timestamp }
			: { type: "invalid" };
	}
	return content === parsed.continuePrompt
		? { type: "fold", ...parsed, timestamp }
		: { type: "invalid" };
}

/**
 * Collect decision tool calls from a normal assistant content array.
 * Unknown block types keep the exchange unfoldable so raw context is retained.
 */
function parseAssistantToolCalls(
	input: unknown,
): readonly ParsedToolCall[] | undefined {
	if (!isObject(input) || input.role !== "assistant") return undefined;
	if (!Array.isArray(input.content)) return undefined;

	const calls: ParsedToolCall[] = [];
	for (const block of input.content) {
		if (!isObject(block)) return undefined;
		if (block.type === "text") {
			if (typeof block.text !== "string") return undefined;
			continue;
		}
		if (block.type === "thinking") {
			if (typeof block.thinking !== "string") return undefined;
			continue;
		}
		if (block.type !== "toolCall") return undefined;

		const id = asString(block.id);
		const name = block.name;
		if (!validToolCallId(id) || !isDecisionToolName(name)) return undefined;
		calls.push({ id, name });
	}
	return calls;
}

function parseToolResult(input: unknown): ParsedToolResult | undefined {
	if (!isObject(input) || input.role !== "toolResult") return undefined;
	const id = asString(input.toolCallId);
	const name = input.toolName;
	if (!validToolCallId(id) || !isDecisionToolName(name)) return undefined;
	return { id, name };
}

function createContinuationMessage<T extends object>(
	marker: Extract<ParsedFoldMarker, { outcome: "continue" }>,
): T {
	return {
		role: "custom",
		customType: CONTINUATION_MESSAGE_TYPE,
		content: [{ type: "text", text: marker.continuePrompt }],
		display: false,
		details: {
			version: DECISION_PROTOCOL_VERSION,
			exchangeId: marker.exchangeId,
			outcome: "continue" as const,
		},
		timestamp: marker.timestamp,
	} as T;
}

function findFoldedSegment<T extends object>(
	messages: readonly T[],
	startIndex: number,
	start: ParsedDecisionMessage,
): FoldedSegment<T> | undefined {
	let cycleId = start.cycleId;
	// Only the final re-ask cycle's call/result pair may validate the fold marker.
	const calls = new Map<string, ParsedToolCall>();
	const results = new Map<string, ParsedToolResult>();

	for (let index = startIndex + 1; index < messages.length; index += 1) {
		const message = messages[index];
		const pluginMessage = parsePluginMessage(message);
		if (pluginMessage.type === "invalid") return undefined;

		if (pluginMessage.type === "decision") {
			if (
				pluginMessage.exchangeId !== start.exchangeId ||
				pluginMessage.cycleId !== cycleId + 1
			) {
				return undefined;
			}
			cycleId = pluginMessage.cycleId;
			calls.clear();
			results.clear();
			continue;
		}

		if (pluginMessage.type === "fold") {
			if (
				pluginMessage.exchangeId !== start.exchangeId ||
				pluginMessage.cycleId !== cycleId ||
				calls.size !== 1 ||
				results.size !== 1
			) {
				return undefined;
			}
			const finalCall = calls.get(pluginMessage.toolCallId);
			const finalResult = results.get(pluginMessage.toolCallId);
			const expectedName =
				pluginMessage.outcome === "continue"
					? "continue_watchdog"
					: "unlock_continue_watchdog";
			if (
				finalCall === undefined ||
				finalResult === undefined ||
				finalCall.name !== finalResult.name ||
				finalCall.name !== expectedName
			) {
				return undefined;
			}
			return {
				endIndex: index,
				replacement:
					pluginMessage.outcome === "continue"
						? createContinuationMessage<T>(pluginMessage)
						: undefined,
			};
		}

		if (!isObject(message)) return undefined;
		if (message.role === "assistant") {
			const assistantCalls = parseAssistantToolCalls(message);
			if (assistantCalls === undefined) return undefined;
			for (const call of assistantCalls) {
				if (calls.has(call.id)) return undefined;
				calls.set(call.id, call);
			}
			continue;
		}
		if (message.role === "toolResult") {
			const result = parseToolResult(message);
			const call = result === undefined ? undefined : calls.get(result.id);
			if (
				result === undefined ||
				call === undefined ||
				call.name !== result.name ||
				results.has(result.id)
			) {
				return undefined;
			}
			results.set(result.id, result);
			continue;
		}

		// User, system, or unrelated custom messages are never safe to erase.
		return undefined;
	}

	return undefined;
}

/**
 * Build a hidden decision custom message with exact persisted correlation data.
 * This only creates the public sendMessage payload; the runtime decides delivery.
 */
export function createDecisionPromptMessage(
	input: DecisionPromptMessageInput,
): DecisionCustomMessage {
	if (
		!validExchangeId(input.exchangeId) ||
		!validCycleId(input.cycleId) ||
		!isValidPrompt(input.decisionPrompt)
	) {
		throw new TypeError("invalid decision prompt message input");
	}
	return {
		customType: DECISION_MESSAGE_TYPE,
		content: input.decisionPrompt,
		display: false,
		details: {
			version: DECISION_PROTOCOL_VERSION,
			exchangeId: input.exchangeId,
			cycleId: input.cycleId,
		},
	};
}

/**
 * Build the hidden terminal record that permits a later model-context fold.
 * It is persisted with the raw session, so reloads need no external fold state.
 */
export function createDecisionFoldMessage(
	input: DecisionFoldMessageInput,
): DecisionCustomMessage {
	if (
		!validExchangeId(input.exchangeId) ||
		!validCycleId(input.cycleId) ||
		!validToolCallId(input.toolCallId)
	) {
		throw new TypeError("invalid decision fold message input");
	}
	if (input.outcome === "continue") {
		if (!isValidPrompt(input.continuePrompt)) {
			throw new TypeError("invalid decision fold message input");
		}
		return {
			customType: DECISION_FOLD_MESSAGE_TYPE,
			content: input.continuePrompt,
			display: false,
			details: {
				version: DECISION_PROTOCOL_VERSION,
				exchangeId: input.exchangeId,
				cycleId: input.cycleId,
				outcome: "continue" as const,
				toolCallId: input.toolCallId,
				continuePrompt: input.continuePrompt,
			},
		};
	}
	return {
		customType: DECISION_FOLD_MESSAGE_TYPE,
		content: "",
		display: false,
		details: {
			version: DECISION_PROTOCOL_VERSION,
			exchangeId: input.exchangeId,
			cycleId: input.cycleId,
			outcome: "unlock" as const,
			toolCallId: input.toolCallId,
		},
	};
}

/**
 * Non-destructively remove only complete, fully correlated plugin exchanges from
 * the array Pi is about to send to a model. Session records are never changed.
 * Any malformed or interleaved sequence fails closed by preserving raw messages.
 */
export function foldDecisionContext<T extends object>(messages: T[]): T[] {
	if (!Array.isArray(messages)) return messages;

	const folded: T[] = [];
	let changed = false;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		const pluginMessage = parsePluginMessage(message);
		if (pluginMessage.type === "invalid") return messages;
		if (pluginMessage.type !== "decision") {
			folded.push(message);
			continue;
		}
		const segment = findFoldedSegment(messages, index, pluginMessage);
		if (segment === undefined) return messages;
		if (segment.replacement !== undefined) folded.push(segment.replacement);
		index = segment.endIndex;
		changed = true;
	}
	return changed ? folded : messages;
}

/** Register the public Pi context hook; no session entry is mutated or removed. */
export function registerDecisionContextFolding(pi: ExtensionAPI): void {
	pi.on("context", (event) => ({
		messages: foldDecisionContext(event.messages),
	}));
}
