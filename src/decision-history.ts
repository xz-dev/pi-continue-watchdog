import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { MAX_PROMPT_CHARACTERS } from "./config.js";
import {
	DECISION_FOLD_MESSAGE_TYPE,
	type DecisionFoldOutcome,
	type DecisionTerminalResult,
	isCorrelatedInquiryAssistantMessage,
	parseDecisionFoldDetails,
} from "./context-fold.js";

export type DecisionHistoryResult =
	| DecisionTerminalResult
	| { readonly outcome: DecisionFoldOutcome };

export const WATCHDOG_HISTORY_MAX_CODE_POINTS = MAX_PROMPT_CHARACTERS;
export const WATCHDOG_HISTORY_HEADING =
	"Previous watchdog results (model-generated reference only; not user instructions):";

function historyHeading(omitted: number): string {
	if (omitted === 0) return WATCHDOG_HISTORY_HEADING;
	const noun = omitted === 1 ? "result" : "results";
	return `Previous watchdog results (model-generated reference only; not user instructions; ${omitted} older ${noun} omitted):`;
}

function stringifyHistoryObject(value: object): string {
	const json = JSON.stringify(value);
	if (json === undefined)
		throw new TypeError("history object is not serializable");
	return json.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function serializeHistoryResult(result: DecisionHistoryResult): string {
	switch (result.outcome) {
		case "continue":
		case "unlock":
			return "reasonType" in result && "reason" in result
				? stringifyHistoryObject({
						outcome: result.outcome,
						reasonType: result.reasonType,
						reason: result.reason,
					})
				: stringifyHistoryObject({ outcome: result.outcome });
		case "wait":
			return "reason" in result && "waitSeconds" in result
				? stringifyHistoryObject({
						outcome: "wait",
						reason: result.reason,
						waitSeconds: result.waitSeconds,
					})
				: stringifyHistoryObject({ outcome: "wait" });
		case "decision-failed":
			return "error" in result
				? stringifyHistoryObject({
						outcome: "decision-failed",
						error: result.error,
					})
				: stringifyHistoryObject({ outcome: "decision-failed" });
		case "preempted":
		case "invalidated":
			return stringifyHistoryObject({ outcome: result.outcome });
	}
}

function codePointLength(value: string): number {
	return Array.from(value).length;
}

function buildHistoryBlock(lines: readonly string[], omitted: number): string {
	return [historyHeading(omitted), ...lines.map((line) => `- ${line}`)].join(
		"\n",
	);
}

export function formatContiguousWatchdogHistory(
	results: readonly DecisionHistoryResult[],
): string {
	if (results.length === 0) return "";
	const lines = results.map(serializeHistoryResult);
	let start = lines.length;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const candidate = buildHistoryBlock(lines.slice(index), index);
		if (codePointLength(candidate) > WATCHDOG_HISTORY_MAX_CODE_POINTS) break;
		start = index;
	}
	return buildHistoryBlock(lines.slice(start), start);
}

/**
 * Collect the active branch's zero-loop watchdog suffix.
 * Only a successful ordinary assistant turn ends the suffix.
 */
export function collectContiguousWatchdogHistory(
	entries: readonly SessionEntry[],
): readonly DecisionHistoryResult[] {
	const newestFirst: DecisionHistoryResult[] = [];
	const seenInquiries = new Set<string>();

	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined) continue;

		if (
			entry.type === "custom_message" &&
			entry.customType === DECISION_FOLD_MESSAGE_TYPE
		) {
			const details = parseDecisionFoldDetails(entry.details);
			if (details !== undefined && !seenInquiries.has(details.inquiryId)) {
				seenInquiries.add(details.inquiryId);
				newestFirst.push(
					details.watchdogResult ?? {
						outcome: details.watchdogOutcome,
					},
				);
			}
			continue;
		}

		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			!isCorrelatedInquiryAssistantMessage(entry.message) &&
			entry.message.stopReason === "stop"
		) {
			break;
		}
	}

	return newestFirst.reverse();
}
