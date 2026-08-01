import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	MALFORMED_DECISION_RESPONSE_ERROR,
	MULTIPLE_DECISION_TOOLS_ERROR,
	NO_DECISION_TOOL_ERROR,
	normalizeAssistantDecisionResponse,
	PROSE_DECISION_RESPONSE_ERROR,
	UNKNOWN_DECISION_TOOL_ERROR,
	UNSUPPORTED_DECISION_CONTENT_ERROR,
	validateDecisionResponse,
} from "../src/decision-protocol.js";
import { createDecisionToolExecutors } from "../src/decision-tools.js";

const DECISION_PROMPT = "Decision prompt from configuration.";
const CONTEXT = {} as ExtensionContext;

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
): DecisionResponse["content"][number] {
	return {
		type: "toolCall",
		toolCallId: id,
		name: "unlock_continue_watchdog",
		arguments: { reason },
	};
}

function openDecision() {
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
		}),
	};
}

test("Slice 6 RED: validator accepts exactly one reasonless continue or one trimmed unlock reason, while ignoring private thinking", () => {
	assert.deepEqual(
		validateDecisionResponse(
			response([
				{ type: "thinking" },
				{ type: "text", text: " \n\t" },
				continueCall(),
			]),
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
				unlockCall("unlock-1", " \nWaiting for confirmation.\n "),
			]),
		),
		{
			valid: true,
			decision: {
				kind: "unlock",
				toolCallId: "unlock-1",
				reason: "Waiting for confirmation.",
			},
		},
	);
});

test("Slice 6 RED: validator counts Unicode code points for AI unlock reasons without truncating multiline content", () => {
	const exactly500 = "😀".repeat(500);
	const over500 = `${exactly500}😀`;

	const valid = validateDecisionResponse(
		response([unlockCall("unicode", `\n${exactly500}\n`)]),
	);
	assert.deepEqual(valid, {
		valid: true,
		decision: {
			kind: "unlock",
			toolCallId: "unicode",
			reason: exactly500,
		},
	});

	assert.deepEqual(
		validateDecisionResponse(response([unlockCall("over-limit", over500)])),
		{ valid: false, error: INVALID_UNLOCK_REASON_ERROR },
	);
	assert.deepEqual(
		validateDecisionResponse(response([unlockCall("blank", " \n\t ")])),
		{ valid: false, error: INVALID_UNLOCK_REASON_ERROR },
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([unlockCall("multiline", "First line.\nSecond line.")]),
		),
		{
			valid: true,
			decision: {
				kind: "unlock",
				toolCallId: "multiline",
				reason: "First line.\nSecond line.",
			},
		},
	);
});

test("Slice 6 RED: validator rejects every non-exactly-one/no-prose protocol class with fixed safe errors", () => {
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
			name: "unlock without exactly its reason property",
			value: response([
				{
					type: "toolCall",
					toolCallId: "unlock-extra",
					name: "unlock_continue_watchdog",
					arguments: { reason: "Done.", extra: true },
				},
			]),
			error: INVALID_UNLOCK_REASON_ERROR,
		},
		{
			name: "unsupported assistant content",
			value: response([{ type: "other" }]),
			error: UNSUPPORTED_DECISION_CONTENT_ERROR,
		},
	];

	for (const entry of cases) {
		assert.deepEqual(
			validateDecisionResponse(entry.value),
			{
				valid: false,
				error: entry.error,
			},
			entry.name,
		);
	}
});

test("Slice 6 RED: raw Pi AssistantMessage adapter preserves text/thinking/toolCall semantics and safely rejects malformed inputs", () => {
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
	assert.deepEqual(validateDecisionResponse(normalized), {
		valid: true,
		decision: { kind: "continue", toolCallId: "pi-call" },
	});

	const hostileMessage = Object.create(null) as Record<string, unknown>;
	Object.defineProperty(hostileMessage, "content", {
		get() {
			throw new Error("do not invoke getters");
		},
	});
	assert.doesNotThrow(() => normalizeAssistantDecisionResponse(hostileMessage));
	assert.deepEqual(
		validateDecisionResponse(
			normalizeAssistantDecisionResponse(hostileMessage),
		),
		{ valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR },
	);

	const hostileArguments = Object.create(null) as Record<string, unknown>;
	Object.defineProperty(hostileArguments, "reason", {
		get() {
			throw new Error("do not invoke argument getters");
		},
	});
	assert.doesNotThrow(() =>
		validateDecisionResponse(
			response([unlockCall("hostile", hostileArguments)]),
		),
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([unlockCall("hostile", hostileArguments)]),
		),
		{ valid: false, error: INVALID_UNLOCK_REASON_ERROR },
	);
});

test("Slice 6 RED: re-ask prompt embeds the exact fixed previous error and repeats the corrective protocol", () => {
	assert.equal(
		buildDecisionReaskPrompt(DECISION_PROMPT, NO_DECISION_TOOL_ERROR),
		"Decision prompt from configuration.\n\nYour previous decision response was invalid: Call exactly one decision tool.\nCorrect it now: call exactly one decision tool and do not answer with prose.",
	);
});

test("Slice 6 RED: executor records neutral terminating results and applies valid continue only after complete-response validation", async () => {
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

	const finalized = protocol.finalize(
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
	assert.deepEqual(finalized.transition.effects, [
		{ kind: "restoreDecisionTools", decisionId: 1 },
	]);
	assert.equal(controller.snapshot.attempt, 1);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(controller.snapshot.decisionOpen, false);

	const duplicate = protocol.finalize(response([continueCall("continue-1")]));
	assert.equal(duplicate, finalized);
	assert.equal(controller.snapshot.attempt, 1);
});

test("Slice 6 RED: invalid decisions immediately re-ask with controller's exact error, retain the window, and do not consume a valid continue retry", () => {
	const { controller, protocol } = openDecision();

	const invalid = protocol.finalize(
		response([{ type: "text", text: "I'll wait." }]),
	);
	assert.equal(invalid.outcome, "reask");
	assert.equal(invalid.error, PROSE_DECISION_RESPONSE_ERROR);
	assert.equal(
		invalid.prompt,
		buildDecisionReaskPrompt(DECISION_PROMPT, PROSE_DECISION_RESPONSE_ERROR),
	);
	assert.deepEqual(invalid.transition.effects, [
		{
			kind: "reaskDecision",
			decisionId: 1,
			invalidDecisionAttempt: 1,
			error: PROSE_DECISION_RESPONSE_ERROR,
		},
	]);
	assert.equal(controller.snapshot.attempt, 0);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(controller.snapshot.decisionOpen, true);

	protocol.onDecisionToolCall({
		kind: "continue",
		toolCallId: "continue-after-invalid",
		ctx: CONTEXT,
	});
	const valid = protocol.finalize(
		response([continueCall("continue-after-invalid")]),
	);
	assert.equal(valid.outcome, "continue");
	assert.equal(controller.snapshot.attempt, 1);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 0);
});

test("Slice 6 RED: third invalid response takes the controller decision-failed path without advancing retries", () => {
	const { controller, protocol } = openDecision();

	const first = protocol.finalize(response([{ type: "text", text: "one" }]));
	assert.equal(first.outcome, "reask");
	const second = protocol.finalize(response([{ type: "text", text: "two" }]));
	assert.equal(second.outcome, "reask");
	const third = protocol.finalize(response([{ type: "text", text: "three" }]));

	assert.equal(third.outcome, "decision-failed");
	assert.equal(third.error, PROSE_DECISION_RESPONSE_ERROR);
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
});

test("Slice 6 RED: validation requires the collected execution to match the complete assistant tool call before changing controller state", () => {
	const missing = openDecision();
	const missingExecution = missing.protocol.finalize(
		response([continueCall("not-executed")]),
	);
	assert.equal(missingExecution.outcome, "reask");
	assert.equal(missingExecution.error, DECISION_TOOL_NOT_EXECUTED_ERROR);
	assert.equal(missing.controller.snapshot.attempt, 0);

	const mismatch = openDecision();
	mismatch.protocol.onDecisionToolCall({
		kind: "unlock",
		toolCallId: "wrong-call",
		reason: "Done.",
		ctx: CONTEXT,
	});
	const mismatchedExecution = mismatch.protocol.finalize(
		response([continueCall("right-call")]),
	);
	assert.equal(mismatchedExecution.outcome, "reask");
	assert.equal(mismatchedExecution.error, DECISION_TOOLS_MISMATCH_ERROR);
	assert.equal(mismatch.controller.snapshot.attempt, 0);
});

test("Slice 6 RED: valid unlock reports its normalized reason only after matching collected execution", () => {
	const { controller, protocol } = openDecision();
	protocol.onDecisionToolCall({
		kind: "unlock",
		toolCallId: "unlock-1",
		reason: " \nWaiting for user confirmation.\n ",
		ctx: CONTEXT,
	});

	const finalized = protocol.finalize(
		response([unlockCall("unlock-1", " \nWaiting for user confirmation.\n ")]),
	);
	assert.equal(finalized.outcome, "unlock");
	assert.equal(finalized.reason, "Waiting for user confirmation.");
	assert.deepEqual(finalized.transition.effects, [
		{ kind: "restoreDecisionTools", decisionId: 1 },
		{ kind: "notify", notification: "unlocked" },
	]);
	assert.equal(controller.snapshot.locked, false);
});

test("Slice 6 RED: collector rejects an executed unlock whose raw reason differs from the completed decision message", () => {
	const { controller, protocol } = openDecision();
	protocol.onDecisionToolCall({
		kind: "unlock",
		toolCallId: "unlock-1",
		reason: "Actual reason.",
		ctx: CONTEXT,
	});

	const finalized = protocol.finalize(
		response([unlockCall("unlock-1", "Different reason.")]),
	);
	assert.equal(finalized.outcome, "reask");
	assert.equal(finalized.error, DECISION_TOOLS_MISMATCH_ERROR);
	assert.equal(controller.snapshot.locked, true);
	assert.equal(controller.snapshot.attempt, 0);
});

test("Slice 6 RED: a third collector mismatch is a decision failure rather than retry-budget consumption", () => {
	const { controller, protocol } = openDecision();
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const result = protocol.finalize(
			response([continueCall(`missing-${attempt}`)]),
		);
		if (attempt < 3) {
			assert.equal(result.outcome, "reask");
			assert.equal(result.error, DECISION_TOOL_NOT_EXECUTED_ERROR);
		} else {
			assert.equal(result.outcome, "decision-failed");
			assert.equal(result.error, DECISION_TOOL_NOT_EXECUTED_ERROR);
		}
	}
	assert.equal(controller.snapshot.attempt, 0);
	assert.equal(controller.snapshot.decisionFailed, true);
});
