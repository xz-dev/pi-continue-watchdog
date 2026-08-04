import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_REASON_TYPES } from "../src/config.js";
import { createLockDecisionController } from "../src/controller.js";
import {
	buildDecisionReaskPrompt,
	CONTINUE_ARGUMENTS_ERROR,
	createDecisionProtocolSession,
	DECISION_INVALID_ATTEMPT_LIMIT,
	DECISION_TOOL_NOT_EXECUTED_ERROR,
	DECISION_TOOL_RESULT_MESSAGE,
	DECISION_TOOLS_MISMATCH_ERROR,
	type DecisionResponse,
	formatDecisionFailedNotification,
	INVALID_UNLOCK_REASON_ERROR,
	INVALID_UNLOCK_REASON_TYPE_ERROR,
	MALFORMED_DECISION_RESPONSE_ERROR,
	MULTIPLE_DECISION_TOOLS_ERROR,
	NO_DECISION_TOOL_ERROR,
	normalizeAssistantDecisionResponse,
	PROSE_DECISION_RESPONSE_ERROR,
	STALE_DECISION_TOOL_RESULT_MESSAGE,
	UNKNOWN_DECISION_TOOL_ERROR,
	UNSUPPORTED_DECISION_CONTENT_ERROR,
	validateDecisionResponse,
} from "../src/decision-protocol.js";
import {
	createDecisionToolExecutors,
	type DecisionToolCall,
} from "../src/decision-tools.js";

const DECISION_PROMPT = "Decision prompt from configuration.";
const CONTEXT = {} as ExtensionContext;
const REASON_TYPES = DEFAULT_REASON_TYPES;

function response(content: DecisionResponse["content"]): DecisionResponse {
	return { content };
}

function continueCall(
	id = "continue-1",
	arguments_: unknown = {},
): DecisionResponse["content"][number] {
	return {
		type: "toolCall",
		toolCallId: id,
		name: "continue_watchdog",
		arguments: arguments_,
	};
}

function unlockCall(
	id = "unlock-1",
	reason: unknown = "All tasks are complete.",
	reasonType: unknown = "JOB_DONE",
): DecisionResponse["content"][number] {
	return {
		type: "toolCall",
		toolCallId: id,
		name: "unlock_continue_watchdog",
		arguments: { reasonType, reason },
	};
}

function unlockToolCall(
	toolCallId: string,
	reasonType: string,
	reason: string,
): DecisionToolCall {
	return {
		kind: "unlock",
		toolCallId,
		reasonType,
		reason,
		ctx: CONTEXT,
	};
}

function openDecision(reasonTypes: readonly string[] = REASON_TYPES) {
	const controller = createLockDecisionController({
		idleDelaySeconds: 3,
		maxRetries: 2,
	});
	controller.lock();
	const timer = controller
		.onAllObservableIdle()
		.effects.find((effect) => effect.kind === "armIdleTimer");
	assert.ok(timer);
	const opened = controller
		.beginDecision(timer.timerId)
		.effects.find((effect) => effect.kind === "openDecisionWindow");
	assert.ok(opened);
	return {
		controller,
		protocol: createDecisionProtocolSession({
			controller,
			decisionId: opened.decisionId,
			decisionPrompt: DECISION_PROMPT,
			reasonTypes,
		}),
	};
}

function finalizeCurrent(
	protocol: ReturnType<typeof createDecisionProtocolSession>,
	decisionResponse: DecisionResponse,
) {
	return protocol.finalizeResponse(protocol.currentCycleId, decisionResponse);
}

function advanceReask(
	protocol: ReturnType<typeof createDecisionProtocolSession>,
): void {
	assert.equal(protocol.advanceAfterReask(protocol.currentCycleId), true);
}

test("validator accepts exactly one continue or unlock and ignores thinking", () => {
	assert.deepEqual(
		validateDecisionResponse(
			response([
				{ type: "thinking" },
				{ type: "text", text: " \n\t" },
				continueCall(),
			]),
			REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "continue",
				toolCallId: "continue-1",
			},
		},
	);

	assert.deepEqual(
		validateDecisionResponse(
			response([
				{ type: "thinking" },
				unlockCall(
					"unlock-1",
					" \nWaiting for confirmation.\n ",
					" wait_user ",
				),
			]),
			REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "unlock",
				toolCallId: "unlock-1",
				reasonType: "WAIT_USER",
				reason: "Waiting for confirmation.",
			},
		},
	);
});

test("unlock reasonType is case-insensitive and emits uppercased matched configured value", () => {
	assert.deepEqual(
		validateDecisionResponse(
			response([
				unlockCall(
					"typed",
					"All requested package bumps are merged.",
					"job_done",
				),
			]),
			REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "unlock",
				toolCallId: "typed",
				reasonType: "JOB_DONE",
				reason: "All requested package bumps are merged.",
			},
		},
	);

	const custom = ["NeedReview", "shipped"] as const;
	assert.deepEqual(
		validateDecisionResponse(
			response([
				unlockCall("custom", "PR is open for human review.", "needreview"),
			]),
			custom,
		),
		{
			valid: true,
			decision: {
				kind: "unlock",
				toolCallId: "custom",
				reasonType: "NEEDREVIEW",
				reason: "PR is open for human review.",
			},
		},
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([
				unlockCall("default-gone", "Still using defaults.", "JOB_DONE"),
			]),
			custom,
		),
		{ valid: false, error: INVALID_UNLOCK_REASON_TYPE_ERROR },
	);

	for (const reasonType of ["", "   ", "UNKNOWN", null, 1]) {
		assert.deepEqual(
			validateDecisionResponse(
				response([unlockCall("bad-type", "Done.", reasonType)]),
				REASON_TYPES,
			),
			{ valid: false, error: INVALID_UNLOCK_REASON_TYPE_ERROR },
			String(reasonType),
		);
	}

	assert.deepEqual(
		validateDecisionResponse(
			response([
				{
					type: "toolCall",
					toolCallId: "missing-type",
					name: "unlock_continue_watchdog",
					arguments: { reason: "Done." },
				},
			]),
			REASON_TYPES,
		),
		{ valid: false, error: INVALID_UNLOCK_REASON_TYPE_ERROR },
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([
				{
					type: "toolCall",
					toolCallId: "undefined-type",
					name: "unlock_continue_watchdog",
					arguments: { reasonType: undefined, reason: "Done." },
				},
			]),
			REASON_TYPES,
		),
		{ valid: false, error: INVALID_UNLOCK_REASON_TYPE_ERROR },
	);
});

test("unlock reason is trimmed, counts Unicode code points, and never truncates", () => {
	const exactly500 = "😀".repeat(500);
	const over500 = `${exactly500}😀`;

	assert.deepEqual(
		validateDecisionResponse(
			response([unlockCall("unicode", `\n${exactly500}\n`)]),
			REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "unlock",
				toolCallId: "unicode",
				reasonType: "JOB_DONE",
				reason: exactly500,
			},
		},
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([unlockCall("over-limit", over500)]),
			REASON_TYPES,
		),
		{ valid: false, error: INVALID_UNLOCK_REASON_ERROR },
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([unlockCall("blank", " \n\t ")]),
			REASON_TYPES,
		),
		{ valid: false, error: INVALID_UNLOCK_REASON_ERROR },
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([unlockCall("multiline", "First line.\nSecond line.")]),
			REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "unlock",
				toolCallId: "multiline",
				reasonType: "JOB_DONE",
				reason: "First line.\nSecond line.",
			},
		},
	);
});

test("validator rejects non-exactly-one and prose responses with fixed errors", () => {
	const cases: readonly {
		readonly name: string;
		readonly value: DecisionResponse;
		readonly error: string;
	}[] = [
		{
			name: "no decision tool",
			value: response([{ type: "thinking" }]),
			error: NO_DECISION_TOOL_ERROR,
		},
		{
			name: "prose-only response",
			value: response([{ type: "text", text: "I will wait." }]),
			error: PROSE_DECISION_RESPONSE_ERROR,
		},
		{
			name: "prose beside a tool call",
			value: response([
				{ type: "text", text: "Continuing now." },
				continueCall(),
			]),
			error: PROSE_DECISION_RESPONSE_ERROR,
		},
		{
			name: "both decision tools",
			value: response([continueCall(), unlockCall()]),
			error: MULTIPLE_DECISION_TOOLS_ERROR,
		},
		{
			name: "unknown tool beside a decision tool",
			value: response([
				continueCall(),
				{
					type: "toolCall",
					toolCallId: "unknown-extra",
					name: "bash",
					arguments: {},
				},
			]),
			error: UNKNOWN_DECISION_TOOL_ERROR,
		},
		{
			name: "same decision tool twice",
			value: response([continueCall("one"), continueCall("two")]),
			error: MULTIPLE_DECISION_TOOLS_ERROR,
		},
		{
			name: "unknown extra tool",
			value: response([
				{
					type: "toolCall",
					toolCallId: "unknown",
					name: "bash",
					arguments: {},
				},
			]),
			error: UNKNOWN_DECISION_TOOL_ERROR,
		},
		{
			name: "continue arguments",
			value: response([continueCall("continue-extra", { extra: true })]),
			error: CONTINUE_ARGUMENTS_ERROR,
		},
		{
			name: "continue array arguments",
			value: response([continueCall("continue-array", [])]),
			error: CONTINUE_ARGUMENTS_ERROR,
		},
		{
			name: "unlock without exactly reasonType and reason",
			value: response([
				{
					type: "toolCall",
					toolCallId: "unlock-extra",
					name: "unlock_continue_watchdog",
					arguments: {
						reasonType: "JOB_DONE",
						reason: "Done.",
						extra: true,
					},
				},
			]),
			error: INVALID_UNLOCK_REASON_TYPE_ERROR,
		},
		{
			name: "unsupported assistant content",
			value: response([{ type: "other" }]),
			error: UNSUPPORTED_DECISION_CONTENT_ERROR,
		},
	];

	for (const entry of cases) {
		assert.deepEqual(
			validateDecisionResponse(entry.value, REASON_TYPES),
			{
				valid: false,
				error: entry.error,
			},
			entry.name,
		);
	}
});

test("Pi AssistantMessage normalization maps ordinary text/thinking/toolCall shapes", () => {
	const normalized = normalizeAssistantDecisionResponse({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text: " " },
			{
				type: "toolCall",
				id: "pi-call",
				name: "continue_watchdog",
				arguments: {},
			},
		],
	});
	assert.deepEqual(validateDecisionResponse(normalized, REASON_TYPES), {
		valid: true,
		decision: { kind: "continue", toolCallId: "pi-call" },
	});

	assert.deepEqual(
		validateDecisionResponse(
			normalizeAssistantDecisionResponse({ role: "user", content: [] }),
			REASON_TYPES,
		),
		{ valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR },
	);
	assert.deepEqual(
		validateDecisionResponse(
			normalizeAssistantDecisionResponse({
				role: "assistant",
				content: [{ type: "toolCall", id: 1, name: "continue_watchdog" }],
			}),
			REASON_TYPES,
		),
		{ valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR },
	);
	assert.deepEqual(
		validateDecisionResponse(
			normalizeAssistantDecisionResponse({
				role: "assistant",
				content: [{ type: "image", url: "x" }],
			}),
			REASON_TYPES,
		),
		{ valid: false, error: UNSUPPORTED_DECISION_CONTENT_ERROR },
	);
});

test("re-ask prompt embeds the fixed previous error", () => {
	assert.equal(
		buildDecisionReaskPrompt(DECISION_PROMPT, NO_DECISION_TOOL_ERROR),
		"Decision prompt from configuration.\n\nYour previous decision response was invalid: Call exactly one decision tool.\nCorrect it now: call exactly one decision tool and do not answer with prose.",
	);
});

test("collector records neutral terminating results and finalizes valid continue with fold ids", async () => {
	const { controller, protocol } = openDecision();
	const executors = createDecisionToolExecutors(protocol);

	const result = await executors.executeContinue("continue-1", CONTEXT);
	assert.deepEqual(result, {
		content: [{ type: "text", text: DECISION_TOOL_RESULT_MESSAGE }],
		details: { kind: "decision-recorded" },
		terminate: true,
	});
	assert.equal(controller.snapshot.attempt, 0);
	assert.equal(controller.snapshot.decisionOpen, true);

	const finalized = finalizeCurrent(
		protocol,
		normalizeAssistantDecisionResponse({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "continue-1",
					name: "continue_watchdog",
					arguments: {},
				},
			],
		}),
	);
	assert.equal(finalized.outcome, "continue");
	assert.equal(finalized.toolCallId, "continue-1");
	assert.equal(finalized.cycleId, 1);
	assert.deepEqual(finalized.transition.effects, [
		{ kind: "restoreDecisionTools", decisionId: 1 },
	]);
	assert.equal(controller.snapshot.attempt, 1);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(controller.snapshot.decisionOpen, false);

	const duplicate = finalizeCurrent(
		protocol,
		response([continueCall("continue-1")]),
	);
	assert.equal(duplicate, finalized);
	assert.equal(controller.snapshot.attempt, 1);
	assert.equal(protocol.advanceAfterReask(protocol.currentCycleId), false);
});

test("invalid decisions re-ask without consuming a valid continue retry", () => {
	const { controller, protocol } = openDecision();

	const invalid = finalizeCurrent(
		protocol,
		response([{ type: "text", text: "I'll wait." }]),
	);
	assert.equal(invalid.outcome, "reask");
	assert.equal(invalid.error, PROSE_DECISION_RESPONSE_ERROR);
	assert.equal(invalid.cycleId, 1);
	assert.equal(
		invalid.reaskPrompt,
		buildDecisionReaskPrompt(DECISION_PROMPT, PROSE_DECISION_RESPONSE_ERROR),
	);
	assert.equal(controller.snapshot.attempt, 0);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(controller.snapshot.decisionOpen, true);

	advanceReask(protocol);
	protocol.onDecisionToolCall({
		kind: "continue",
		toolCallId: "continue-after-invalid",
		ctx: CONTEXT,
	});
	const valid = finalizeCurrent(
		protocol,
		response([continueCall("continue-after-invalid")]),
	);
	assert.equal(valid.outcome, "continue");
	assert.equal(controller.snapshot.attempt, 1);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 0);
});

test("finalization caches each cycle, rejects stale work, and advances only after reask ack", () => {
	const { controller, protocol } = openDecision();
	const firstCycleId = protocol.currentCycleId;
	const invalidResponse = response([{ type: "text", text: "I will wait." }]);

	const first = protocol.finalizeResponse(firstCycleId, invalidResponse);
	assert.equal(first.outcome, "reask");
	assert.equal(controller.snapshot.invalidDecisionAttempts, 1);
	for (let repeat = 0; repeat < 3; repeat += 1) {
		assert.equal(
			protocol.finalizeResponse(firstCycleId, invalidResponse),
			first,
		);
	}
	assert.equal(controller.snapshot.invalidDecisionAttempts, 1);

	assert.deepEqual(
		protocol.onDecisionToolCall({
			kind: "continue",
			toolCallId: "late-before-advance",
			ctx: CONTEXT,
		}),
		{
			content: [{ type: "text", text: STALE_DECISION_TOOL_RESULT_MESSAGE }],
			details: { kind: "stale-decision-tool" },
			terminate: true,
		},
	);
	assert.equal(protocol.advanceAfterReask(firstCycleId + 1), false);
	assert.equal(protocol.advanceAfterReask(firstCycleId), true);
	assert.equal(protocol.currentCycleId, firstCycleId + 1);
	assert.equal(protocol.advanceAfterReask(firstCycleId), false);

	const staleFinalize = protocol.finalizeResponse(
		firstCycleId,
		invalidResponse,
	);
	assert.equal(staleFinalize.outcome, "ignored");
	assert.equal(staleFinalize.transition.applied, false);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 1);

	const second = finalizeCurrent(
		protocol,
		response([continueCall("late-before-advance")]),
	);
	assert.equal(second.outcome, "reask");
	assert.equal(second.error, DECISION_TOOL_NOT_EXECUTED_ERROR);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 2);
	advanceReask(protocol);

	const third = finalizeCurrent(
		protocol,
		response([{ type: "text", text: "Still waiting." }]),
	);
	assert.equal(third.outcome, "decision-failed");
	assert.equal(controller.snapshot.invalidDecisionAttempts, 3);
});

test("third invalid response decision-fails without advancing retries", () => {
	const { controller, protocol } = openDecision();

	const first = finalizeCurrent(
		protocol,
		response([{ type: "text", text: "one" }]),
	);
	assert.equal(first.outcome, "reask");
	advanceReask(protocol);
	const second = finalizeCurrent(
		protocol,
		response([{ type: "text", text: "two" }]),
	);
	assert.equal(second.outcome, "reask");
	advanceReask(protocol);
	const third = finalizeCurrent(
		protocol,
		response([{ type: "text", text: "three" }]),
	);

	assert.equal(third.outcome, "decision-failed");
	assert.equal(third.error, PROSE_DECISION_RESPONSE_ERROR);
	assert.equal(third.cycleId, protocol.currentCycleId);
	assert.equal(
		third.notification,
		"Continue watchdog decision failed after 3 attempts: Do not answer with prose; call exactly one decision tool.",
	);
	assert.equal(DECISION_INVALID_ATTEMPT_LIMIT, 3);
	assert.equal(
		formatDecisionFailedNotification(PROSE_DECISION_RESPONSE_ERROR),
		third.notification,
	);
	assert.deepEqual(third.transition.effects, [
		{ kind: "restoreDecisionTools", decisionId: 1 },
		{ kind: "decisionFailed", error: PROSE_DECISION_RESPONSE_ERROR },
	]);
	assert.equal(controller.snapshot.attempt, 0);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 3);
	assert.equal(controller.snapshot.decisionFailed, true);
	assert.equal(controller.snapshot.decisionOpen, false);
	assert.equal(protocol.advanceAfterReask(protocol.currentCycleId), false);
});

test("validation requires collected execution to match the complete assistant tool call", () => {
	const missing = openDecision();
	const missingExecution = finalizeCurrent(
		missing.protocol,
		response([continueCall("not-executed")]),
	);
	assert.equal(missingExecution.outcome, "reask");
	assert.equal(missingExecution.error, DECISION_TOOL_NOT_EXECUTED_ERROR);
	assert.equal(missing.controller.snapshot.attempt, 0);

	const mismatch = openDecision();
	mismatch.protocol.onDecisionToolCall(
		unlockToolCall("wrong-call", "JOB_DONE", "Done."),
	);
	const mismatchedExecution = finalizeCurrent(
		mismatch.protocol,
		response([continueCall("right-call")]),
	);
	assert.equal(mismatchedExecution.outcome, "reask");
	assert.equal(mismatchedExecution.error, DECISION_TOOLS_MISMATCH_ERROR);
	assert.equal(mismatch.controller.snapshot.attempt, 0);
});

test("valid unlock reports normalized reasonType and reason after matching execution", () => {
	const { controller, protocol } = openDecision();
	protocol.onDecisionToolCall(
		unlockToolCall(
			"unlock-1",
			" job_done ",
			" \nWaiting for user confirmation.\n ",
		),
	);

	const finalized = finalizeCurrent(
		protocol,
		response([
			unlockCall(
				"unlock-1",
				" \nWaiting for user confirmation.\n ",
				" job_done ",
			),
		]),
	);
	assert.equal(finalized.outcome, "unlock");
	assert.equal(finalized.reasonType, "JOB_DONE");
	assert.equal(finalized.reason, "Waiting for user confirmation.");
	assert.equal(finalized.toolCallId, "unlock-1");
	assert.equal(finalized.cycleId, 1);
	assert.deepEqual(finalized.transition.effects, [
		{ kind: "restoreDecisionTools", decisionId: 1 },
		{ kind: "notify", notification: "unlocked" },
	]);
	assert.equal(controller.snapshot.locked, false);
});

test("collector rejects unlock when recorded type or reason differs from the message", () => {
	const reasonMismatch = openDecision();
	reasonMismatch.protocol.onDecisionToolCall(
		unlockToolCall("unlock-1", "JOB_DONE", "Actual reason."),
	);
	const reasonFinalized = finalizeCurrent(
		reasonMismatch.protocol,
		response([unlockCall("unlock-1", "Different reason.", "JOB_DONE")]),
	);
	assert.equal(reasonFinalized.outcome, "reask");
	assert.equal(reasonFinalized.error, DECISION_TOOLS_MISMATCH_ERROR);
	assert.equal(reasonMismatch.controller.snapshot.locked, true);
	assert.equal(reasonMismatch.controller.snapshot.attempt, 0);

	const typeMismatch = openDecision();
	typeMismatch.protocol.onDecisionToolCall(
		unlockToolCall("unlock-2", "JOB_DONE", "Same reason."),
	);
	const typeFinalized = finalizeCurrent(
		typeMismatch.protocol,
		response([unlockCall("unlock-2", "Same reason.", "WAIT_USER")]),
	);
	assert.equal(typeFinalized.outcome, "reask");
	assert.equal(typeFinalized.error, DECISION_TOOLS_MISMATCH_ERROR);
	assert.equal(typeMismatch.controller.snapshot.locked, true);
});
