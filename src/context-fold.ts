import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Stable persisted metadata version for decision exchanges and their fold marker. */
export const DECISION_PROTOCOL_VERSION = 1;

/** Hidden message that opens an automated decision-response cycle. */
export const DECISION_MESSAGE_TYPE = "pi-continue-watchdog:decision";

/** Hidden terminal record that makes a complete decision exchange foldable. */
export const DECISION_FOLD_MESSAGE_TYPE = "pi-continue-watchdog:decision-fold";

/** Model-bound compact replacement emitted only by the context hook. */
export const CONTINUATION_MESSAGE_TYPE = "pi-continue-watchdog:continuation";

const MAX_EXCHANGE_ID_LENGTH = 256;

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

type OwnDataProperty =
	| { readonly kind: "missing" }
	| { readonly kind: "data"; readonly value: unknown }
	| { readonly kind: "non-data" };

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
	readonly name: "continue_watchdog" | "unlock_continue_watchdog";
};

type ParsedToolResult = {
	readonly id: string;
	readonly name: "continue_watchdog" | "unlock_continue_watchdog";
};

type FoldedSegment<T extends object> = {
	readonly endIndex: number;
	readonly replacement: T | undefined;
};

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

function hasExactlyOwnStringKeys(
	input: unknown,
	expectedKeys: readonly string[],
): boolean {
	if (input === null || typeof input !== "object") return false;
	try {
		const keys = Reflect.ownKeys(input);
		return (
			keys.length === expectedKeys.length &&
			keys.every((key) => typeof key === "string" && expectedKeys.includes(key))
		);
	} catch {
		return false;
	}
}

function ownString(input: unknown, key: string): string | undefined {
	const value = readOwnDataProperty(input, key);
	return value.kind === "data" && typeof value.value === "string"
		? value.value
		: undefined;
}

function ownFiniteNumber(input: unknown, key: string): number | undefined {
	const value = readOwnDataProperty(input, key);
	return value.kind === "data" &&
		typeof value.value === "number" &&
		Number.isFinite(value.value)
		? value.value
		: undefined;
}

function validExchangeId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_EXCHANGE_ID_LENGTH
	);
}

function validCycleId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validToolCallId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function decisionDetails(input: unknown): DecisionMessageDetails | undefined {
	if (!hasExactlyOwnStringKeys(input, ["version", "exchangeId", "cycleId"])) {
		return undefined;
	}
	const version = readOwnDataProperty(input, "version");
	const exchangeId = ownString(input, "exchangeId");
	const cycleId = ownFiniteNumber(input, "cycleId");
	if (
		version.kind !== "data" ||
		version.value !== DECISION_PROTOCOL_VERSION ||
		!validExchangeId(exchangeId) ||
		!validCycleId(cycleId)
	) {
		return undefined;
	}
	return { version: DECISION_PROTOCOL_VERSION, exchangeId, cycleId };
}

function foldDetails(input: unknown): DecisionFoldDetails | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const outcome = ownString(input, "outcome");
	const expectedKeys =
		outcome === "continue"
			? [
					"version",
					"exchangeId",
					"cycleId",
					"outcome",
					"toolCallId",
					"continuePrompt",
				]
			: ["version", "exchangeId", "cycleId", "outcome", "toolCallId"];
	if (!hasExactlyOwnStringKeys(input, expectedKeys)) return undefined;

	const version = readOwnDataProperty(input, "version");
	const exchangeId = ownString(input, "exchangeId");
	const cycleId = ownFiniteNumber(input, "cycleId");
	const toolCallId = ownString(input, "toolCallId");
	if (
		version.kind !== "data" ||
		version.value !== DECISION_PROTOCOL_VERSION ||
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
	if (outcome !== "continue") return undefined;
	const continuePrompt = ownString(input, "continuePrompt");
	if (continuePrompt === undefined || continuePrompt.length === 0)
		return undefined;
	return {
		version: DECISION_PROTOCOL_VERSION,
		exchangeId,
		cycleId,
		outcome,
		toolCallId,
		continuePrompt,
	};
}

function parsePluginMessage(input: unknown): ParsedPluginMessage {
	const role = ownString(input, "role");
	if (role !== "custom") return { type: "unrelated" };
	const customType = ownString(input, "customType");
	if (
		customType !== DECISION_MESSAGE_TYPE &&
		customType !== DECISION_FOLD_MESSAGE_TYPE
	) {
		return { type: "unrelated" };
	}
	const details = readOwnDataProperty(input, "details");
	const timestamp = ownFiniteNumber(input, "timestamp");
	if (details.kind !== "data" || timestamp === undefined) {
		return { type: "invalid" };
	}
	if (customType === DECISION_MESSAGE_TYPE) {
		const parsed = decisionDetails(details.value);
		return parsed === undefined
			? { type: "invalid" }
			: { type: "decision", ...parsed };
	}

	const parsed = foldDetails(details.value);
	const content = ownString(input, "content");
	if (parsed === undefined || content === undefined) return { type: "invalid" };
	if (
		(parsed.outcome === "unlock" && content.length !== 0) ||
		(parsed.outcome === "continue" && content !== parsed.continuePrompt)
	) {
		return { type: "invalid" };
	}
	return parsed.outcome === "unlock"
		? { type: "fold", ...parsed, timestamp }
		: { type: "fold", ...parsed, timestamp };
}

function parseAssistantToolCalls(
	input: unknown,
): readonly ParsedToolCall[] | undefined {
	if (ownString(input, "role") !== "assistant") return undefined;
	const content = readOwnDataProperty(input, "content");
	if (content.kind !== "data" || !Array.isArray(content.value))
		return undefined;

	const calls: ParsedToolCall[] = [];
	for (const block of content.value) {
		const type = ownString(block, "type");
		if (type !== "toolCall") continue;
		const id = ownString(block, "id");
		const name = ownString(block, "name");
		if (
			!validToolCallId(id) ||
			(name !== "continue_watchdog" && name !== "unlock_continue_watchdog")
		) {
			return undefined;
		}
		calls.push({ id, name });
	}
	return calls;
}

function parseToolResult(input: unknown): ParsedToolResult | undefined {
	if (ownString(input, "role") !== "toolResult") return undefined;
	const id = ownString(input, "toolCallId");
	const name = ownString(input, "toolName");
	if (
		!validToolCallId(id) ||
		(name !== "continue_watchdog" && name !== "unlock_continue_watchdog")
	) {
		return undefined;
	}
	return { id, name };
}

function createContinuationMessage<T extends object>(
	marker: Extract<ParsedFoldMarker, { outcome: "continue" }>,
): T {
	return {
		role: "custom",
		customType: CONTINUATION_MESSAGE_TYPE,
		content: marker.continuePrompt,
		display: false,
		details: Object.freeze({
			version: DECISION_PROTOCOL_VERSION,
			exchangeId: marker.exchangeId,
			outcome: "continue" as const,
		}),
		timestamp: marker.timestamp,
	} as T;
}

function findFoldedSegment<T extends object>(
	messages: readonly T[],
	startIndex: number,
	start: ParsedDecisionMessage,
): FoldedSegment<T> | undefined {
	let cycleId = start.cycleId;
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
			continue;
		}
		if (pluginMessage.type === "fold") {
			if (
				pluginMessage.exchangeId !== start.exchangeId ||
				pluginMessage.cycleId !== cycleId ||
				!calls.has(pluginMessage.toolCallId) ||
				!results.has(pluginMessage.toolCallId) ||
				calls.size !== results.size
			) {
				return undefined;
			}
			const finalCall = calls.get(pluginMessage.toolCallId);
			const finalResult = results.get(pluginMessage.toolCallId);
			if (
				finalCall === undefined ||
				finalResult === undefined ||
				finalCall.name !== finalResult.name ||
				finalCall.name !==
					(pluginMessage.outcome === "continue"
						? "continue_watchdog"
						: "unlock_continue_watchdog")
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

		const role = ownString(message, "role");
		if (role === "assistant") {
			const assistantCalls = parseAssistantToolCalls(message);
			if (assistantCalls === undefined) return undefined;
			for (const call of assistantCalls) {
				if (calls.has(call.id)) return undefined;
				calls.set(call.id, call);
			}
			continue;
		}
		if (role === "toolResult") {
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

		// A decision response may contain only assistant/tool records and hidden
		// re-asks. A user or unrelated custom/system record is never safe to erase.
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
		typeof input.decisionPrompt !== "string" ||
		input.decisionPrompt.length === 0
	) {
		throw new TypeError("invalid decision prompt message input");
	}
	return Object.freeze({
		customType: DECISION_MESSAGE_TYPE,
		content: input.decisionPrompt,
		display: false,
		details: Object.freeze({
			version: DECISION_PROTOCOL_VERSION,
			exchangeId: input.exchangeId,
			cycleId: input.cycleId,
		}),
	});
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
		if (
			typeof input.continuePrompt !== "string" ||
			input.continuePrompt.length === 0
		) {
			throw new TypeError("invalid continue prompt");
		}
		return Object.freeze({
			customType: DECISION_FOLD_MESSAGE_TYPE,
			content: input.continuePrompt,
			display: false,
			details: Object.freeze({
				version: DECISION_PROTOCOL_VERSION,
				exchangeId: input.exchangeId,
				cycleId: input.cycleId,
				outcome: "continue" as const,
				toolCallId: input.toolCallId,
				continuePrompt: input.continuePrompt,
			}),
		});
	}
	return Object.freeze({
		customType: DECISION_FOLD_MESSAGE_TYPE,
		content: "",
		display: false,
		details: Object.freeze({
			version: DECISION_PROTOCOL_VERSION,
			exchangeId: input.exchangeId,
			cycleId: input.cycleId,
			outcome: "unlock" as const,
			toolCallId: input.toolCallId,
		}),
	});
}

/**
 * Non-destructively remove only complete, fully correlated plugin exchanges from
 * the array Pi is about to send to a model. Session records are never changed.
 * Any malformed or interleaved sequence fails closed by preserving raw messages.
 */
export function foldDecisionContext<T extends object>(messages: T[]): T[] {
	try {
		if (!Array.isArray(messages)) return messages;
		const folded: T[] = [];
		let changed = false;
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index];
			const pluginMessage = parsePluginMessage(message);
			if (pluginMessage.type !== "decision") {
				folded.push(message);
				continue;
			}
			const segment = findFoldedSegment(messages, index, pluginMessage);
			if (segment === undefined) {
				folded.push(message);
				continue;
			}
			if (segment.replacement !== undefined) folded.push(segment.replacement);
			index = segment.endIndex;
			changed = true;
		}
		return changed ? folded : messages;
	} catch {
		return messages;
	}
}

/** Register the public Pi context hook; no session entry is mutated or removed. */
export function registerDecisionContextFolding(pi: ExtensionAPI): void {
	pi.on("context", (event) => ({
		messages: foldDecisionContext(event.messages),
	}));
}
