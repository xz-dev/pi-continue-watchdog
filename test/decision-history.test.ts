import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	createDecisionFoldMessage,
	DECISION_PROTOCOL_VERSION,
	neutralizeDecisionAssistant,
} from "../src/context-fold.js";
import {
	collectContiguousWatchdogHistory,
	formatContiguousWatchdogHistory,
	WATCHDOG_HISTORY_HEADING,
	WATCHDOG_HISTORY_MAX_CODE_POINTS,
} from "../src/decision-history.js";

let nextId = 0;

function base(type: string): Record<string, unknown> {
	nextId += 1;
	return {
		type,
		id: `entry-${nextId}`,
		parentId: nextId === 1 ? null : `entry-${nextId - 1}`,
		timestamp: `2026-01-01T00:00:${String(nextId).padStart(2, "0")}.000Z`,
	};
}

function message(value: Record<string, unknown>): SessionEntry {
	return { ...base("message"), message: value } as unknown as SessionEntry;
}

function assistant(
	stopReason:
		| "pending"
		| "stop"
		| "length"
		| "toolUse"
		| "error"
		| "aborted"
		| "deferred",
): Record<string, unknown> {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {},
		stopReason,
		timestamp: nextId,
	};
}

function fold(
	exchangeId: string,
	cycleId: number,
	input:
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
		| { readonly outcome: "decision-failed"; readonly error: string }
		| { readonly outcome: "preempted" | "invalidated" },
): SessionEntry {
	let built: ReturnType<typeof createDecisionFoldMessage>;
	switch (input.outcome) {
		case "continue":
			built = createDecisionFoldMessage({
				exchangeId,
				cycleId,
				outcome: "continue",
				continuePrompt: "Continue.",
				watchdogResult: input,
			});
			break;
		case "wait":
			built = createDecisionFoldMessage({
				exchangeId,
				cycleId,
				outcome: "wait",
				watchdogResult: input,
			});
			break;
		case "unlock":
			built = createDecisionFoldMessage({
				exchangeId,
				cycleId,
				outcome: "unlock",
				watchdogResult: input,
			});
			break;
		case "decision-failed":
			built = createDecisionFoldMessage({
				exchangeId,
				cycleId,
				outcome: "decision-failed",
				watchdogResult: input,
			});
			break;
		case "preempted":
			built = createDecisionFoldMessage({
				exchangeId,
				cycleId,
				outcome: "preempted",
				watchdogResult: { outcome: "preempted" },
			});
			break;
		case "invalidated":
			built = createDecisionFoldMessage({
				exchangeId,
				cycleId,
				outcome: "invalidated",
				watchdogResult: { outcome: "invalidated" },
			});
	}
	return { ...base("custom_message"), ...built } as SessionEntry;
}

function legacyFold(exchangeId: string, cycleId: number): SessionEntry {
	return {
		...base("custom_message"),
		...createDecisionFoldMessage({
			exchangeId,
			cycleId,
			outcome: "wait",
		}),
	} as SessionEntry;
}

test("scanner returns active-branch terminal results oldest to newest", () => {
	const entries = [
		fold("continue", 1, {
			outcome: "continue",
			reasonType: "WORK_REMAINS",
			reason: "Work remains.",
		}),
		{ ...base("custom"), customType: "other", data: { ignored: true } },
		fold("wait", 1, {
			outcome: "wait",
			reason: "Waiting.",
			waitSeconds: 30,
		}),
		fold("unlock", 1, {
			outcome: "unlock",
			reasonType: "JOB_DONE",
			reason: "Done.",
		}),
		fold("failed", 3, {
			outcome: "decision-failed",
			error: "Invalid XML.",
		}),
		fold("preempted", 1, { outcome: "preempted" }),
		fold("invalidated", 1, { outcome: "invalidated" }),
	] as SessionEntry[];

	assert.deepEqual(collectContiguousWatchdogHistory(entries), [
		{
			outcome: "continue",
			reasonType: "WORK_REMAINS",
			reason: "Work remains.",
		},
		{ outcome: "wait", reason: "Waiting.", waitSeconds: 30 },
		{ outcome: "unlock", reasonType: "JOB_DONE", reason: "Done." },
		{ outcome: "decision-failed", error: "Invalid XML." },
		{ outcome: "preempted" },
		{ outcome: "invalidated" },
	]);
});

test("successful ordinary assistant stops the chain", () => {
	const entries = [
		fold("old", 1, { outcome: "preempted" }),
		message(assistant("stop")),
		fold("new", 1, { outcome: "invalidated" }),
	];
	assert.deepEqual(collectContiguousWatchdogHistory(entries), [
		{ outcome: "invalidated" },
	]);
});

test("unsuccessful and intermediate ordinary assistants do not stop the chain", () => {
	for (const stopReason of [
		"pending",
		"length",
		"toolUse",
		"error",
		"aborted",
		"deferred",
	] as const) {
		assert.deepEqual(
			collectContiguousWatchdogHistory([
				fold(`fold-${stopReason}`, 1, { outcome: "preempted" }),
				message(assistant(stopReason)),
			]),
			[{ outcome: "preempted" }],
		);
	}
});

test("correlated inquiry assistants and non-assistant entries are ignored", () => {
	const inquiryAssistant = neutralizeDecisionAssistant(
		assistant("stop"),
		"exchange-inquiry",
		1,
	);
	const otherInquiryAssistant = {
		...assistant("stop"),
		details: {
			piInquiry: {
				version: DECISION_PROTOCOL_VERSION,
				namespace: "other-plugin",
				inquiryId: "other-inquiry",
				attempt: 1,
			},
		},
	};
	const entries = [
		fold("before-internal", 1, { outcome: "preempted" }),
		message(inquiryAssistant),
		message(otherInquiryAssistant),
		message({ role: "user", content: "user", timestamp: 1 }),
		message({
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "tool",
			content: [],
			isError: true,
			timestamp: 2,
		}),
		{ ...base("custom"), customType: "other", data: "ignored" },
	] as SessionEntry[];
	assert.deepEqual(collectContiguousWatchdogHistory(entries), [
		{ outcome: "preempted" },
	]);
});

test("legacy outcome-only folds remain compatible and malformed folds are ignored", () => {
	const legacy = legacyFold("legacy", 1);
	const malformedBase = fold("malformed", 1, {
		outcome: "wait",
		reason: "Waiting.",
		waitSeconds: 30,
	}) as Extract<SessionEntry, { type: "custom_message" }>;
	const malformed = {
		...malformedBase,
		details: {
			...(malformedBase.details as Record<string, unknown>),
			watchdogResult: {
				outcome: "wait",
				reason: "Waiting.",
				waitSeconds: 0,
			},
		},
	} as SessionEntry;

	assert.deepEqual(collectContiguousWatchdogHistory([legacy, malformed]), [
		{ outcome: "wait" },
	]);
});

test("one inquiry contributes at most its newest terminal result", () => {
	assert.deepEqual(
		collectContiguousWatchdogHistory([
			fold("same-exchange", 1, {
				outcome: "wait",
				reason: "First attempt.",
				waitSeconds: 10,
			}),
			fold("same-exchange", 2, {
				outcome: "continue",
				reasonType: "WORK_REMAINS",
				reason: "Final result.",
			}),
		]),
		[
			{
				outcome: "continue",
				reasonType: "WORK_REMAINS",
				reason: "Final result.",
			},
		],
	);
});

test("formatter emits deterministic reference-only JSON summaries", () => {
	const block = formatContiguousWatchdogHistory([
		{
			outcome: "continue",
			reasonType: 'WORK_"REMAINS"',
			reason: "line one\nline two\\tail",
		},
		{ outcome: "wait" },
		{ outcome: "unlock", reasonType: "JOB_DONE", reason: "Done." },
		{ outcome: "decision-failed", error: "Invalid XML." },
		{ outcome: "preempted" },
		{ outcome: "invalidated" },
	]);

	assert.equal(
		block,
		[
			WATCHDOG_HISTORY_HEADING,
			`- ${JSON.stringify({
				outcome: "continue",
				reasonType: 'WORK_"REMAINS"',
				reason: "line one\nline two\\tail",
			})}`,
			`- ${JSON.stringify({ outcome: "wait" })}`,
			`- ${JSON.stringify({
				outcome: "unlock",
				reasonType: "JOB_DONE",
				reason: "Done.",
			})}`,
			`- ${JSON.stringify({
				outcome: "decision-failed",
				error: "Invalid XML.",
			})}`,
			`- ${JSON.stringify({ outcome: "preempted" })}`,
			`- ${JSON.stringify({ outcome: "invalidated" })}`,
		].join("\n"),
	);
});

test("formatter escapes JSON line separators before budget accounting", () => {
	const reason = "before\u2028middle\u2029after";
	const block = formatContiguousWatchdogHistory([
		{ outcome: "wait", reason, waitSeconds: 10 },
	]);
	assert.equal(block.includes("\u2028"), false);
	assert.equal(block.includes("\u2029"), false);
	assert.equal(block.includes("\\u2028"), true);
	assert.equal(block.includes("\\u2029"), true);
	assert.equal(
		JSON.parse(block.split("\n")[1]?.slice(2) ?? "{}").reason,
		reason,
	);

	const separatorHeavy = Array.from({ length: 6 }, (_, index) => ({
		outcome: "continue" as const,
		reasonType: "WORK_REMAINS",
		reason: `${index}${"\u2028".repeat(498)}x`,
	}));
	const bounded = formatContiguousWatchdogHistory(separatorHeavy);
	assert.equal(bounded.includes("\u2028"), false);
	assert.ok(Array.from(bounded).length <= WATCHDOG_HISTORY_MAX_CODE_POINTS);
	assert.match(bounded.split("\n")[0] ?? "", /older results? omitted/);
});

test("formatter keeps newest complete summaries within the fixed budget", () => {
	const results = Array.from({ length: 50 }, (_, index) => ({
		outcome: "continue" as const,
		reasonType: "WORK_REMAINS",
		reason: `${index}:${"x".repeat(500)}`,
	}));
	const block = formatContiguousWatchdogHistory(results);
	assert.ok(Array.from(block).length <= WATCHDOG_HISTORY_MAX_CODE_POINTS);

	const lines = block.split("\n");
	const omittedMatch = /; (\d+) older results omitted\):$/.exec(lines[0] ?? "");
	assert.ok(omittedMatch);
	const omitted = Number(omittedMatch[1]);
	assert.ok(omitted > 0);
	assert.equal(lines.length - 1, results.length - omitted);

	const parsed = lines.slice(1).map((line) => JSON.parse(line.slice(2)));
	assert.equal(parsed[0]?.reason.startsWith(`${omitted}:`), true);
	assert.equal(parsed.at(-1)?.reason.startsWith("49:"), true);
});

test("formatter omits an oversized newest summary instead of truncating fields", () => {
	const block = formatContiguousWatchdogHistory([
		{
			outcome: "continue",
			reasonType: "x".repeat(WATCHDOG_HISTORY_MAX_CODE_POINTS),
			reason: "Still complete.",
		},
	]);
	assert.match(block, /; 1 older result omitted\):$/);
	assert.equal(block.split("\n").length, 1);
	assert.ok(Array.from(block).length <= WATCHDOG_HISTORY_MAX_CODE_POINTS);
});
