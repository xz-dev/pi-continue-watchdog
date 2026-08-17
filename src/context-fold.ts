import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { isValidPrompt } from "./config.js";
import { PROCESS_DOMAIN_OBSERVATION_DETAILS } from "./run-activity.js";

/** Stable persisted metadata version for decision exchanges and their fold marker. */
export const DECISION_PROTOCOL_VERSION = 1;

/** Automated custom message that opens a decision-response cycle. */
export const DECISION_MESSAGE_TYPE = "pi-continue-watchdog:decision";

/** Terminal record that makes a complete decision exchange foldable. */
export const DECISION_FOLD_MESSAGE_TYPE = "pi-continue-watchdog:decision-fold";

/** Model-bound compact replacement emitted only by the context hook. */
export const CONTINUATION_MESSAGE_TYPE = "pi-continue-watchdog:continuation";

/** Internal persisted marker used to redact a decision that user input took over. */
export const PREEMPTED_DECISION_ERROR = "pi-continue-watchdog:preempted";

/** Context-excluded boundary written immediately before one decision prompt. */
export const INQUIRY_MARKER_ENTRY_TYPE = "pi-continue-watchdog:inquiry-marker";

export interface DecisionMessageDetails {
	readonly version: typeof DECISION_PROTOCOL_VERSION;
	readonly exchangeId: string;
	readonly cycleId: number;
	readonly "pi-process-domain"?: {
		readonly version: 1;
		readonly activity: "observation";
	};
}

export type DecisionFoldDetails =
	| {
			readonly version: typeof DECISION_PROTOCOL_VERSION;
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome:
				| "unlock"
				| "decision-failed"
				| "invalidated"
				| "preempted";
	  }
	| {
			readonly version: typeof DECISION_PROTOCOL_VERSION;
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "continue";
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
			readonly outcome:
				| "unlock"
				| "decision-failed"
				| "invalidated"
				| "preempted";
	  }
	| {
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "continue";
			readonly continuePrompt: string;
	  };

/** The sendMessage-compatible shape used by later decision-runtime wiring. */
export interface DecisionCustomMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details: unknown;
}

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
			readonly outcome:
				| "unlock"
				| "decision-failed"
				| "invalidated"
				| "preempted";
			readonly timestamp: number;
	  }
	| {
			readonly type: "fold";
			readonly exchangeId: string;
			readonly cycleId: number;
			readonly outcome: "continue";
			readonly continuePrompt: string;
			readonly timestamp: number;
	  };

type ParsedPluginMessage =
	| { readonly type: "unrelated" }
	| { readonly type: "invalid" }
	| ParsedDecisionMessage
	| ParsedFoldMarker;

type FoldedSegment<T extends object> = {
	readonly endIndex: number;
	readonly replacement: readonly T[];
};

type DecisionSegment<T extends object> =
	| { readonly kind: "folded"; readonly segment: FoldedSegment<T> }
	| { readonly kind: "aborted"; readonly endIndex: number }
	| { readonly kind: "incomplete" };

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

function entryDecisionDetails(
	entry: SessionEntry,
): DecisionMessageDetails | undefined {
	if (
		entry.type === "custom_message" &&
		entry.customType === DECISION_MESSAGE_TYPE
	) {
		return decisionDetails(entry.details);
	}
	if (
		entry.type !== "custom" ||
		entry.customType !== INQUIRY_MARKER_ENTRY_TYPE
	) {
		return undefined;
	}
	return decisionDetails(entry.data);
}

/** Locate one exact preempted assistant within its persisted inquiry boundary. */
export function findDecisionAssistantEntryId(
	entries: readonly SessionEntry[],
	exchangeId: string,
	cycleId: number,
): string | null {
	let markerIndex = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (
			entry?.type !== "custom" ||
			entry.customType !== INQUIRY_MARKER_ENTRY_TYPE
		) {
			continue;
		}
		const details = decisionDetails(entry.data);
		if (details?.exchangeId === exchangeId && details.cycleId === cycleId) {
			markerIndex = index;
			break;
		}
	}
	if (markerIndex === -1) return null;

	let decisionSeen = false;
	let foldSeen = false;
	let assistantId: string | null = null;
	for (let index = markerIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index];
		const boundary = entryDecisionDetails(entry);
		if (
			boundary !== undefined &&
			(boundary.exchangeId !== exchangeId || boundary.cycleId !== cycleId)
		) {
			return null;
		}
		if (entry?.type === "custom_message") {
			if (entry.customType === DECISION_MESSAGE_TYPE) {
				if (decisionSeen || foldSeen || boundary === undefined) return null;
				decisionSeen = true;
				continue;
			}
			if (entry.customType === DECISION_FOLD_MESSAGE_TYPE) {
				if (!decisionSeen || foldSeen) return null;
				const fold = foldDetails(entry.details);
				if (
					fold?.exchangeId !== exchangeId ||
					fold.cycleId !== cycleId ||
					fold.outcome !== "preempted"
				) {
					return null;
				}
				foldSeen = true;
			}
			continue;
		}
		if (entry?.type !== "message" || entry.message?.role !== "assistant") {
			continue;
		}
		if (
			!decisionSeen ||
			!isPreemptedAssistant(entry.message) ||
			assistantId !== null
		) {
			return null;
		}
		assistantId = entry.id;
		if (foldSeen) return assistantId;
	}
	return decisionSeen && foldSeen ? assistantId : null;
}

/** Recover every exactly bounded preempted assistant on the active branch. */
export function findPreemptedDecisionAssistantEntryIds(
	entries: readonly SessionEntry[],
): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== INQUIRY_MARKER_ENTRY_TYPE
		) {
			continue;
		}
		const details = decisionDetails(entry.data);
		if (details === undefined) continue;
		const id = findDecisionAssistantEntryId(
			entries,
			details.exchangeId,
			details.cycleId,
		);
		if (id !== null && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

function foldDetails(input: unknown): DecisionFoldDetails | undefined {
	if (!isObject(input)) return undefined;
	const exchangeId = input.exchangeId;
	const cycleId = input.cycleId;
	const outcome = input.outcome;
	if (
		input.version !== DECISION_PROTOCOL_VERSION ||
		!validExchangeId(exchangeId) ||
		!validCycleId(cycleId)
	) {
		return undefined;
	}
	if (
		outcome === "unlock" ||
		outcome === "decision-failed" ||
		outcome === "invalidated" ||
		outcome === "preempted"
	) {
		return {
			version: DECISION_PROTOCOL_VERSION,
			exchangeId,
			cycleId,
			outcome,
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
		continuePrompt: input.continuePrompt,
	};
}

function pluginExchangeId(input: unknown): string | undefined {
	if (!isObject(input)) return undefined;
	if (
		input.role !== "custom" ||
		(input.customType !== DECISION_MESSAGE_TYPE &&
			input.customType !== DECISION_FOLD_MESSAGE_TYPE) ||
		!isObject(input.details) ||
		!validExchangeId(input.details.exchangeId)
	) {
		return undefined;
	}
	return input.details.exchangeId;
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
		return parsed === undefined || content.trim().length === 0
			? { type: "invalid" }
			: { type: "decision", ...parsed };
	}

	const parsed = foldDetails(input.details);
	if (parsed === undefined) return { type: "invalid" };
	if (parsed.outcome === "continue") {
		return content === parsed.continuePrompt
			? { type: "fold", ...parsed, timestamp }
			: { type: "invalid" };
	}
	return content.length === 0
		? { type: "fold", ...parsed, timestamp }
		: { type: "invalid" };
}

function isAbortedAssistant(input: unknown): boolean {
	return (
		isObject(input) &&
		input.role === "assistant" &&
		input.stopReason === "aborted"
	);
}

function isPreemptedAssistant(input: unknown): boolean {
	return (
		isObject(input) &&
		input.role === "assistant" &&
		input.stopReason === "stop" &&
		input.errorMessage === PREEMPTED_DECISION_ERROR &&
		Array.isArray(input.content) &&
		input.content.length === 0
	);
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

/**
 * A foldable exchange may contain re-ask decision prompts, assistant answers
 * (including blocked ordinary tool calls), and tool results. User/system or
 * unrelated custom messages fail closed so raw context is retained.
 */
function findDecisionSegment<T extends object>(
	messages: readonly T[],
	startIndex: number,
	start: ParsedDecisionMessage,
): DecisionSegment<T> {
	let cycleId = start.cycleId;
	const preserved: T[] = [];

	for (let index = startIndex + 1; index < messages.length; index += 1) {
		const message = messages[index];
		const pluginMessage = parsePluginMessage(message);
		if (pluginMessage.type === "invalid") return { kind: "incomplete" };

		if (pluginMessage.type === "decision") {
			if (
				pluginMessage.exchangeId !== start.exchangeId ||
				pluginMessage.cycleId !== cycleId + 1
			) {
				return { kind: "incomplete" };
			}
			cycleId = pluginMessage.cycleId;
			continue;
		}

		if (pluginMessage.type === "fold") {
			if (
				pluginMessage.exchangeId !== start.exchangeId ||
				pluginMessage.cycleId !== cycleId
			) {
				return { kind: "incomplete" };
			}
			let endIndex = index;
			if (pluginMessage.outcome === "preempted") {
				for (let tail = index + 1; tail < messages.length; tail += 1) {
					const trailing = messages[tail];
					if (isPreemptedAssistant(trailing)) {
						endIndex = tail;
						break;
					}
					const trailingPlugin = parsePluginMessage(trailing);
					if (trailingPlugin.type !== "unrelated") break;
					if (!isObject(trailing) || trailing.role !== "custom") break;
					preserved.push(trailing);
					endIndex = tail;
				}
			}
			return {
				kind: "folded",
				segment: {
					endIndex,
					replacement: [
						...preserved,
						...(pluginMessage.outcome === "continue"
							? [createContinuationMessage<T>(pluginMessage)]
							: []),
					],
				},
			};
		}

		if (!isObject(message)) return { kind: "incomplete" };
		if (message.role === "custom") {
			preserved.push(message);
			continue;
		}
		if (message.role === "assistant") {
			if (isPreemptedAssistant(message)) continue;
			if (isAbortedAssistant(message)) {
				return { kind: "aborted", endIndex: index };
			}
			continue;
		}
		if (message.role === "toolResult") {
			// Blocked ordinary tool results stay inside the foldable exchange.
			continue;
		}

		// User, system, or unrelated custom messages terminate this incomplete
		// segment, but do not prevent later independently correlated exchanges
		// from being folded.
		return { kind: "incomplete" };
	}

	return { kind: "incomplete" };
}

/**
 * Build an automated decision custom message with exact persisted correlation data.
 * This only creates the public sendMessage payload; the runtime decides delivery.
 */
export function createDecisionPromptMessage(
	input: DecisionPromptMessageInput,
): DecisionCustomMessage {
	if (
		!validExchangeId(input.exchangeId) ||
		!validCycleId(input.cycleId) ||
		typeof input.decisionPrompt !== "string" ||
		input.decisionPrompt.trim().length === 0
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
			...PROCESS_DOMAIN_OBSERVATION_DETAILS,
		},
	};
}

/**
 * Build the terminal record that permits a later model-context fold.
 * It is persisted with the raw session, so reloads need no external fold state.
 */
export function createDecisionFoldMessage(
	input: DecisionFoldMessageInput,
): DecisionCustomMessage {
	if (!validExchangeId(input.exchangeId) || !validCycleId(input.cycleId)) {
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
			outcome: input.outcome,
		},
	};
}

/**
 * Non-destructively remove complete, fully correlated plugin exchanges and
 * canonical aborted decision pairs from the array Pi is about to send to a
 * model. Session records are never changed. Ambiguous exchanges fail closed
 * locally without disabling later independent folds.
 */
export function foldDecisionContext<T extends object>(messages: T[]): T[] {
	if (!Array.isArray(messages)) return messages;

	const folded: T[] = [];
	const incompleteExchangeIds = new Set<string>();
	let changed = false;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		const pluginMessage = parsePluginMessage(message);
		if (pluginMessage.type === "invalid") {
			const exchangeId = pluginExchangeId(message);
			if (exchangeId !== undefined) incompleteExchangeIds.add(exchangeId);
			folded.push(message);
			continue;
		}
		if (pluginMessage.type !== "decision") {
			folded.push(message);
			continue;
		}
		if (incompleteExchangeIds.has(pluginMessage.exchangeId)) {
			folded.push(message);
			continue;
		}
		const result = findDecisionSegment(messages, index, pluginMessage);
		if (result.kind === "folded") {
			folded.push(...result.segment.replacement);
			index = result.segment.endIndex;
			changed = true;
			continue;
		}
		if (result.kind === "aborted") {
			index = result.endIndex;
			changed = true;
			continue;
		}

		// Preserve an ambiguous/incomplete exchange locally. A later cycle with
		// the same correlation id remains raw, while independent exchanges can
		// still fold normally.
		incompleteExchangeIds.add(pluginMessage.exchangeId);
		folded.push(message);
	}
	return changed ? folded : messages;
}

/** Register the public Pi context hook; no session entry is mutated or removed. */
export function registerDecisionContextFolding(pi: ExtensionAPI): void {
	pi.on("context", (event) => ({
		messages: foldDecisionContext(event.messages),
	}));
}
