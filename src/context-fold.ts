import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	createInquiryRuntime,
	foldInquiryContext,
	INQUIRY_PROTOCOL_VERSION,
	type InquiryCorrelation,
	neutralizeInquiryAssistant,
} from "pi-extension-utils/pi-inquiry";

import {
	type ContinueWatchdogEvent,
	type DecisionFailedWatchdogEvent,
	parseWatchdogEvent,
	type UnlockWatchdogEvent,
	WATCHDOG_EVENT_MESSAGE_TYPE,
	type WaitWatchdogEvent,
	type WatchdogEvent,
} from "./watchdog-event.js";

export const DECISION_INQUIRY_NAMESPACE = "pi-continue-watchdog";
export const DECISION_PROTOCOL_VERSION = INQUIRY_PROTOCOL_VERSION;
export const DECISION_MESSAGE_TYPE = `${DECISION_INQUIRY_NAMESPACE}:inquiry`;
export const DECISION_FOLD_MESSAGE_TYPE = `${DECISION_INQUIRY_NAMESPACE}:inquiry-fold`;
export const CONTINUATION_MESSAGE_TYPE = "pi-continue-watchdog:continuation";
export const PREEMPTED_DECISION_ERROR = "pi-continue-watchdog:preempted";
export const CANCELLED_WATCHDOG_RUN_ERROR = "pi-continue-watchdog:cancelled";
export const INQUIRY_MARKER_ENTRY_TYPE = "pi-continue-watchdog:inquiry-marker";

export interface DecisionMessageDetails extends InquiryCorrelation {}

export type DecisionFoldOutcome =
	| "continue"
	| "wait"
	| "unlock"
	| "decision-failed"
	| "invalidated"
	| "preempted";

export interface DecisionFoldDetails extends InquiryCorrelation {
	readonly outcome: "remove" | "replace";
	readonly watchdogOutcome: DecisionFoldOutcome;
	readonly watchdogEvent?: WatchdogEvent;
	readonly replacement?: {
		readonly customType: string;
		readonly content: string;
		readonly details?: unknown;
	};
}

export interface DecisionPromptMessageInput {
	readonly exchangeId: string;
	readonly cycleId: number;
	readonly decisionPrompt: string;
}

type DecisionFoldMessageBase = {
	readonly exchangeId: string;
	readonly cycleId: number;
};

export type DecisionFoldMessageInput =
	| (DecisionFoldMessageBase & {
			readonly outcome: "continue";
			readonly continuePrompt: string;
			readonly watchdogEvent?: ContinueWatchdogEvent;
	  })
	| (DecisionFoldMessageBase & {
			readonly outcome: "wait";
			readonly eventContent?: string;
			readonly watchdogEvent?: WaitWatchdogEvent;
	  })
	| (DecisionFoldMessageBase & {
			readonly outcome: "unlock";
			readonly eventContent?: string;
			readonly watchdogEvent?: UnlockWatchdogEvent;
	  })
	| (DecisionFoldMessageBase & {
			readonly outcome: "decision-failed";
			readonly eventContent?: string;
			readonly watchdogEvent?: DecisionFailedWatchdogEvent;
	  })
	| (DecisionFoldMessageBase & { readonly outcome: "invalidated" })
	| (DecisionFoldMessageBase & { readonly outcome: "preempted" });

export interface DecisionCustomMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validExchangeId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 128 &&
		/^[A-Za-z0-9_-]+$/.test(value)
	);
}

function validCycleId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validInquiryNamespace(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function inquiryDetails(input: unknown): InquiryCorrelation | undefined {
	if (!isObject(input)) return undefined;
	if (
		input.version !== INQUIRY_PROTOCOL_VERSION ||
		!validInquiryNamespace(input.namespace) ||
		!validExchangeId(input.inquiryId) ||
		!validCycleId(input.attempt)
	) {
		return undefined;
	}
	return {
		version: INQUIRY_PROTOCOL_VERSION,
		namespace: input.namespace,
		inquiryId: input.inquiryId,
		attempt: input.attempt,
	};
}

function decisionDetails(input: unknown): DecisionMessageDetails | undefined {
	const correlation = inquiryDetails(input);
	return correlation?.namespace === DECISION_INQUIRY_NAMESPACE
		? correlation
		: undefined;
}

function markerDetails(
	input: unknown,
): { exchangeId: string; cycleId: number } | undefined {
	if (
		!isObject(input) ||
		!validExchangeId(input.exchangeId) ||
		!validCycleId(input.cycleId)
	) {
		return undefined;
	}
	return { exchangeId: input.exchangeId, cycleId: input.cycleId };
}

export function parseDecisionFoldDetails(
	input: unknown,
): DecisionFoldDetails | undefined {
	const correlation = decisionDetails(input);
	if (correlation === undefined || !isObject(input)) return undefined;
	const watchdogOutcome = input.watchdogOutcome;
	if (
		watchdogOutcome !== "continue" &&
		watchdogOutcome !== "wait" &&
		watchdogOutcome !== "unlock" &&
		watchdogOutcome !== "decision-failed" &&
		watchdogOutcome !== "invalidated" &&
		watchdogOutcome !== "preempted"
	) {
		return undefined;
	}
	if (input.outcome !== "remove" && input.outcome !== "replace")
		return undefined;
	const watchdogEvent = parseWatchdogEvent(input.watchdogEvent);
	if (Object.hasOwn(input, "watchdogEvent") && watchdogEvent === undefined) {
		return undefined;
	}
	return {
		...correlation,
		outcome: input.outcome,
		watchdogOutcome,
		...(watchdogEvent === undefined ? {} : { watchdogEvent }),
		...(isObject(input.replacement)
			? {
					replacement: {
						customType: String(input.replacement.customType),
						content: String(input.replacement.content),
						...(Object.hasOwn(input.replacement, "details")
							? { details: input.replacement.details }
							: {}),
					},
				}
			: {}),
	};
}

function entryCorrelation(
	entry: SessionEntry,
): { exchangeId: string; cycleId: number } | undefined {
	if (
		entry.type === "custom_message" &&
		entry.customType === DECISION_MESSAGE_TYPE
	) {
		const details = decisionDetails(entry.details);
		return details === undefined
			? undefined
			: { exchangeId: details.inquiryId, cycleId: details.attempt };
	}
	if (
		entry.type === "custom" &&
		entry.customType === INQUIRY_MARKER_ENTRY_TYPE
	) {
		return markerDetails(entry.data);
	}
	return undefined;
}

function isPreemptedAssistant(
	input: unknown,
	exchangeId: string,
	cycleId: number,
): boolean {
	if (
		!isObject(input) ||
		input.role !== "assistant" ||
		input.stopReason !== "stop" ||
		(input.errorMessage !== PREEMPTED_DECISION_ERROR &&
			input.errorMessage !== CANCELLED_WATCHDOG_RUN_ERROR) ||
		!Array.isArray(input.content) ||
		input.content.length !== 0 ||
		!isObject(input.details) ||
		!isObject(input.details.piInquiry)
	) {
		return false;
	}
	const details = decisionDetails(input.details.piInquiry);
	return details?.inquiryId === exchangeId && details.attempt === cycleId;
}

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
		)
			continue;
		const details = markerDetails(entry.data);
		if (details?.exchangeId === exchangeId && details.cycleId === cycleId) {
			markerIndex = index;
			break;
		}
	}
	if (markerIndex < 0) return null;

	let decisionSeen = false;
	let foldSeen = false;
	let assistantId: string | null = null;
	for (let index = markerIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index];
		const boundary = entryCorrelation(entry);
		if (
			boundary !== undefined &&
			(boundary.exchangeId !== exchangeId || boundary.cycleId !== cycleId)
		)
			return null;
		if (entry?.type === "custom_message") {
			if (entry.customType === DECISION_MESSAGE_TYPE) {
				if (decisionSeen || foldSeen || boundary === undefined) return null;
				decisionSeen = true;
				continue;
			}
			if (entry.customType === DECISION_FOLD_MESSAGE_TYPE) {
				if (!decisionSeen || foldSeen) return null;
				const fold = parseDecisionFoldDetails(entry.details);
				if (
					fold?.inquiryId !== exchangeId ||
					fold.attempt !== cycleId ||
					fold.watchdogOutcome !== "preempted"
				)
					return null;
				foldSeen = true;
			}
			continue;
		}
		if (entry?.type !== "message" || entry.message?.role !== "assistant")
			continue;
		if (
			!decisionSeen ||
			!isPreemptedAssistant(entry.message, exchangeId, cycleId) ||
			assistantId !== null
		) {
			return null;
		}
		assistantId = entry.id;
		if (foldSeen) return assistantId;
	}
	return decisionSeen && foldSeen ? assistantId : null;
}

function isCancelledWatchdogAssistant(
	input: unknown,
	exchangeId: string,
	cycleId: number,
): boolean {
	if (
		!isObject(input) ||
		input.role !== "assistant" ||
		input.stopReason !== "stop" ||
		input.errorMessage !== CANCELLED_WATCHDOG_RUN_ERROR ||
		!Array.isArray(input.content) ||
		input.content.length !== 0 ||
		!isObject(input.details) ||
		!isObject(input.details.piInquiry)
	) {
		return false;
	}
	const details = decisionDetails(input.details.piInquiry);
	return details?.inquiryId === exchangeId && details.attempt === cycleId;
}

export function findCancelledContinuationAssistantEntryId(
	entries: readonly SessionEntry[],
	exchangeId: string,
	cycleId: number,
): string | null {
	let foldSeen = false;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const boundary = entryCorrelation(entry);
		if (
			foldSeen &&
			boundary !== undefined &&
			(boundary.exchangeId !== exchangeId || boundary.cycleId !== cycleId)
		) {
			return null;
		}
		if (
			entry?.type === "custom_message" &&
			entry.customType === DECISION_FOLD_MESSAGE_TYPE
		) {
			const fold = parseDecisionFoldDetails(entry.details);
			if (
				fold?.inquiryId === exchangeId &&
				fold.attempt === cycleId &&
				fold.watchdogOutcome === "continue" &&
				fold.replacement?.customType === CONTINUATION_MESSAGE_TYPE
			) {
				foldSeen = true;
			}
			continue;
		}
		if (
			foldSeen &&
			entry?.type === "message" &&
			isCancelledWatchdogAssistant(entry.message, exchangeId, cycleId)
		) {
			return entry.id;
		}
	}
	return null;
}

export function findPreemptedDecisionAssistantEntryIds(
	entries: readonly SessionEntry[],
): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== INQUIRY_MARKER_ENTRY_TYPE
		)
			continue;
		const details = markerDetails(entry.data);
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

export function createDecisionPromptMessage(
	input: DecisionPromptMessageInput,
): DecisionCustomMessage {
	if (!validExchangeId(input.exchangeId) || !validCycleId(input.cycleId)) {
		throw new TypeError("invalid decision prompt message input");
	}
	return createInquiryRuntime(DECISION_INQUIRY_NAMESPACE, {
		inquiryId: input.exchangeId,
	}).prompt(input.decisionPrompt, input.cycleId);
}

export function createDecisionFoldMessage(
	input: DecisionFoldMessageInput,
): DecisionCustomMessage {
	const suppliedEvent =
		"watchdogEvent" in input ? input.watchdogEvent : undefined;
	const watchdogEvent = parseWatchdogEvent(suppliedEvent);
	if (
		!validExchangeId(input.exchangeId) ||
		!validCycleId(input.cycleId) ||
		(suppliedEvent !== undefined &&
			(watchdogEvent === undefined || watchdogEvent.kind !== input.outcome))
	) {
		throw new TypeError("invalid decision fold message input");
	}
	const inquiry = createInquiryRuntime(DECISION_INQUIRY_NAMESPACE, {
		inquiryId: input.exchangeId,
	});
	const message =
		input.outcome === "continue"
			? inquiry.fold(input.cycleId, {
					customType: CONTINUATION_MESSAGE_TYPE,
					content: input.continuePrompt,
					details: {
						version: DECISION_PROTOCOL_VERSION,
						exchangeId: input.exchangeId,
						outcome: "continue",
					},
				})
			: input.outcome !== "invalidated" &&
					input.outcome !== "preempted" &&
					input.eventContent !== undefined
				? inquiry.fold(input.cycleId, {
						customType: WATCHDOG_EVENT_MESSAGE_TYPE,
						content: input.eventContent,
						details: watchdogEvent,
					})
				: inquiry.fold(input.cycleId);
	return {
		...message,
		display:
			input.outcome !== "invalidated" &&
			input.outcome !== "preempted" &&
			watchdogEvent !== undefined,
		details: {
			...message.details,
			watchdogOutcome: input.outcome,
			...(watchdogEvent === undefined ? {} : { watchdogEvent }),
		},
	};
}

export function neutralizeDecisionAssistant<T>(
	message: T,
	exchangeId: string,
	cycleId: number,
	options: { readonly stopReason?: "stop" | "aborted" } = {},
): T {
	const correlation = createInquiryRuntime(DECISION_INQUIRY_NAMESPACE, {
		inquiryId: exchangeId,
	}).correlation(cycleId);
	return neutralizeInquiryAssistant(message, correlation, options);
}

function decisionCorrelationKey(details: InquiryCorrelation): string {
	return `${details.inquiryId}\u0000${details.attempt}`;
}

function restoreDecisionFoldOrder<T extends object>(
	messages: T[],
	folded: T[],
): T[] {
	if (folded === messages) return folded;
	const originalPositions = new Map<object, number>();
	const foldPositions = new Map<string, number>();
	for (const [index, message] of messages.entries()) {
		originalPositions.set(message, index);
		if (!isObject(message) || message.customType !== DECISION_FOLD_MESSAGE_TYPE)
			continue;
		const details = parseDecisionFoldDetails(message.details);
		if (details?.outcome === "replace") {
			foldPositions.set(decisionCorrelationKey(details), index);
		}
	}
	return folded
		.map((message, index) => {
			const originalPosition = originalPositions.get(message);
			if (originalPosition !== undefined) {
				return { message, position: originalPosition, index };
			}
			const correlation =
				isObject(message) &&
				isObject(message.details) &&
				isObject(message.details.piInquiry)
					? decisionDetails(message.details.piInquiry)
					: undefined;
			return {
				message,
				position:
					correlation === undefined
						? messages.length + index
						: (foldPositions.get(decisionCorrelationKey(correlation)) ??
							messages.length + index),
				index,
			};
		})
		.sort((left, right) =>
			left.position === right.position
				? left.index - right.index
				: left.position - right.position,
		)
		.map(({ message }) => message);
}

export function foldDecisionContext<T extends object>(messages: T[]): T[] {
	const folded = restoreDecisionFoldOrder(
		messages,
		foldInquiryContext(messages, DECISION_INQUIRY_NAMESPACE),
	);
	const filtered = folded.filter((message) => {
		if (!isObject(message) || message.role !== "assistant") return true;
		if (message.errorMessage !== CANCELLED_WATCHDOG_RUN_ERROR) return true;
		if (!isObject(message.details) || !isObject(message.details.piInquiry))
			return true;
		return decisionDetails(message.details.piInquiry) === undefined;
	});
	return filtered.length === folded.length ? folded : filtered;
}

export function registerDecisionContextFolding(pi: ExtensionAPI): void {
	pi.on("context", (event) => ({
		messages: foldDecisionContext(event.messages),
	}));
}
