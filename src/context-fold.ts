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

import { hasAtMostUnicodeCodePoints, isValidPrompt } from "./config.js";
import { MAX_WAIT_SECONDS } from "./decision-protocol.js";

export const DECISION_INQUIRY_NAMESPACE = "pi-continue-watchdog";
export const DECISION_PROTOCOL_VERSION = INQUIRY_PROTOCOL_VERSION;
export const DECISION_MESSAGE_TYPE = `${DECISION_INQUIRY_NAMESPACE}:inquiry`;
export const DECISION_FOLD_MESSAGE_TYPE = `${DECISION_INQUIRY_NAMESPACE}:inquiry-fold`;
export const CONTINUATION_MESSAGE_TYPE = "pi-continue-watchdog:continuation";
export const PREEMPTED_DECISION_ERROR = "pi-continue-watchdog:preempted";
export const INQUIRY_MARKER_ENTRY_TYPE = "pi-continue-watchdog:inquiry-marker";

export interface DecisionMessageDetails extends InquiryCorrelation {}

export type DecisionFoldOutcome =
	| "continue"
	| "wait"
	| "unlock"
	| "decision-failed"
	| "invalidated"
	| "preempted";

export type DecisionTerminalResult =
	| {
			readonly outcome: "continue";
			readonly reasonType: string;
			readonly reason: string;
	  }
	| {
			readonly outcome: "wait";
			readonly reason: string;
			readonly waitSeconds: number;
	  }
	| {
			readonly outcome: "unlock";
			readonly reasonType: string;
			readonly reason: string;
	  }
	| {
			readonly outcome: "decision-failed";
			readonly error: string;
	  }
	| { readonly outcome: "invalidated" }
	| { readonly outcome: "preempted" };

export interface DecisionFoldDetails extends InquiryCorrelation {
	readonly outcome: "remove" | "replace";
	readonly watchdogOutcome: DecisionFoldOutcome;
	readonly watchdogResult?: DecisionTerminalResult;
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
			readonly watchdogResult?: Extract<
				DecisionTerminalResult,
				{ readonly outcome: "continue" }
			>;
	  })
	| (DecisionFoldMessageBase & {
			readonly outcome: "wait";
			readonly watchdogResult?: Extract<
				DecisionTerminalResult,
				{ readonly outcome: "wait" }
			>;
	  })
	| (DecisionFoldMessageBase & {
			readonly outcome: "unlock";
			readonly watchdogResult?: Extract<
				DecisionTerminalResult,
				{ readonly outcome: "unlock" }
			>;
	  })
	| (DecisionFoldMessageBase & {
			readonly outcome: "decision-failed";
			readonly watchdogResult?: Extract<
				DecisionTerminalResult,
				{ readonly outcome: "decision-failed" }
			>;
	  })
	| (DecisionFoldMessageBase & {
			readonly outcome: "invalidated";
			readonly watchdogResult?: Extract<
				DecisionTerminalResult,
				{ readonly outcome: "invalidated" }
			>;
	  })
	| (DecisionFoldMessageBase & {
			readonly outcome: "preempted";
			readonly watchdogResult?: Extract<
				DecisionTerminalResult,
				{ readonly outcome: "preempted" }
			>;
	  });

export interface DecisionCustomMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: false;
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

const MAX_RESULT_TEXT_CODE_POINTS = 500;

function validNormalizedReasonType(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value === value.trim()
	);
}

function validNormalizedText(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim() &&
		hasAtMostUnicodeCodePoints(value, maximum)
	);
}

function parseDecisionTerminalResult(
	input: unknown,
	expectedOutcome: DecisionFoldOutcome,
): DecisionTerminalResult | undefined {
	if (!isObject(input) || input.outcome !== expectedOutcome) return undefined;
	switch (expectedOutcome) {
		case "continue":
		case "unlock":
			return validNormalizedReasonType(input.reasonType) &&
				validNormalizedText(input.reason, MAX_RESULT_TEXT_CODE_POINTS)
				? {
						outcome: expectedOutcome,
						reasonType: input.reasonType,
						reason: input.reason,
					}
				: undefined;
		case "wait":
			return validNormalizedText(input.reason, MAX_RESULT_TEXT_CODE_POINTS) &&
				typeof input.waitSeconds === "number" &&
				Number.isSafeInteger(input.waitSeconds) &&
				input.waitSeconds >= 1 &&
				input.waitSeconds <= MAX_WAIT_SECONDS
				? {
						outcome: "wait",
						reason: input.reason,
						waitSeconds: input.waitSeconds,
					}
				: undefined;
		case "decision-failed":
			return validNormalizedText(input.error, MAX_RESULT_TEXT_CODE_POINTS)
				? { outcome: "decision-failed", error: input.error }
				: undefined;
		case "invalidated":
		case "preempted":
			return Object.keys(input).length === 1
				? { outcome: expectedOutcome }
				: undefined;
	}
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
	const hasWatchdogResult = Object.hasOwn(input, "watchdogResult");
	const watchdogResult = parseDecisionTerminalResult(
		input.watchdogResult,
		watchdogOutcome,
	);
	if (hasWatchdogResult && watchdogResult === undefined) return undefined;
	return {
		...correlation,
		outcome: input.outcome,
		watchdogOutcome,
		...(watchdogResult === undefined ? {} : { watchdogResult }),
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

export function isCorrelatedInquiryAssistantMessage(input: unknown): boolean {
	return (
		isObject(input) &&
		input.role === "assistant" &&
		isObject(input.details) &&
		inquiryDetails(input.details.piInquiry) !== undefined
	);
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
		input.errorMessage !== PREEMPTED_DECISION_ERROR ||
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
	const watchdogResult =
		input.watchdogResult === undefined
			? undefined
			: parseDecisionTerminalResult(input.watchdogResult, input.outcome);
	if (
		!validExchangeId(input.exchangeId) ||
		!validCycleId(input.cycleId) ||
		(input.outcome === "continue" && !isValidPrompt(input.continuePrompt)) ||
		(input.watchdogResult !== undefined && watchdogResult === undefined)
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
			: inquiry.fold(input.cycleId);
	return {
		...message,
		details: {
			...message.details,
			watchdogOutcome: input.outcome,
			...(watchdogResult === undefined ? {} : { watchdogResult }),
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

export function foldDecisionContext<T extends object>(messages: T[]): T[] {
	return foldInquiryContext(messages, DECISION_INQUIRY_NAMESPACE);
}

export function registerDecisionContextFolding(pi: ExtensionAPI): void {
	pi.on("context", (event) => ({
		messages: foldDecisionContext(event.messages),
	}));
}
