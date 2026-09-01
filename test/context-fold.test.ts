import assert from "node:assert/strict";
import test from "node:test";

import {
	type ContextEvent,
	convertToLlm,
} from "@earendil-works/pi-coding-agent";
import { MAX_PROMPT_CHARACTERS } from "../src/config.js";
import {
	CONTINUATION_MESSAGE_TYPE,
	createDecisionFoldMessage,
	createDecisionPromptMessage,
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_MESSAGE_TYPE,
	DECISION_PROTOCOL_VERSION,
	foldDecisionContext,
	neutralizeDecisionAssistant,
	registerDecisionContextFolding,
} from "../src/context-fold.js";

type Message = Record<string, unknown>;

const EXCHANGE_ID = "exchange-1";
const CONTINUE_PROMPT = "Continue with the configured task.";

function user(text: string, timestamp: number): Message {
	return { role: "user", content: text, timestamp };
}

function decision(
	exchangeId: string,
	cycleId: number,
	timestamp: number,
): Message {
	return {
		role: "custom",
		...createDecisionPromptMessage({
			exchangeId,
			cycleId,
			decisionPrompt: "hidden decision prompt",
		}),
		timestamp,
	};
}

function assistant(
	content: readonly Record<string, unknown>[],
	timestamp: number,
): Message {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {},
		stopReason: "stop",
		timestamp,
	};
}

function text(textContent: string): Record<string, unknown> {
	return { type: "text", text: textContent };
}

function toolCall(
	id: string,
	name: string,
	arguments_: Record<string, unknown> = {},
): Record<string, unknown> {
	return { type: "toolCall", id, name, arguments: arguments_ };
}

/**
 * Pi's persisted CustomMessage shape after reloading a sendMessage string:
 * role=custom, content=[{ type: "text", text }], and numeric timestamp.
 */
function persistedCustomMessage(
	message: ReturnType<
		typeof createDecisionPromptMessage | typeof createDecisionFoldMessage
	>,
	timestamp: number,
): Message {
	return {
		role: "custom",
		customType: message.customType,
		content: [{ type: "text", text: message.content }],
		display: message.display,
		details: message.details,
		timestamp,
	};
}

function toolResult(
	toolCallId: string,
	toolName: string,
	timestamp: number,
): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [
			{
				type: "text",
				text: "Do not call tools during the pi-continue-watchdog decision check.",
			},
		],
		isError: true,
		timestamp,
	};
}

function foldMarker(options: {
	readonly exchangeId?: string;
	readonly cycleId?: number;
	readonly outcome:
		| "continue"
		| "wait"
		| "unlock"
		| "decision-failed"
		| "preempted";
	readonly continuePrompt?: string;
	readonly timestamp: number;
}): Message {
	const exchangeId = options.exchangeId ?? EXCHANGE_ID;
	const cycleId = options.cycleId ?? 1;
	const message =
		options.outcome === "continue"
			? createDecisionFoldMessage({
					exchangeId,
					cycleId,
					outcome: "continue",
					continuePrompt: options.continuePrompt ?? CONTINUE_PROMPT,
				})
			: createDecisionFoldMessage({
					exchangeId,
					cycleId,
					outcome: options.outcome,
				});
	return { role: "custom", ...message, timestamp: options.timestamp };
}

function continuationMessage(
	timestamp: number,
	exchangeId = EXCHANGE_ID,
	continuePrompt = CONTINUE_PROMPT,
	attempt = 1,
): Message {
	return {
		role: "custom",
		customType: CONTINUATION_MESSAGE_TYPE,
		content: [{ type: "text", text: continuePrompt }],
		display: false,
		details: {
			version: DECISION_PROTOCOL_VERSION,
			exchangeId,
			outcome: "continue",
			piInquiry: {
				version: DECISION_PROTOCOL_VERSION,
				namespace: "pi-continue-watchdog",
				inquiryId: exchangeId,
				attempt,
			},
		},
		timestamp,
	};
}

test("builders emit exact decision and fold custom messages", () => {
	assert.deepEqual(
		createDecisionPromptMessage({
			exchangeId: EXCHANGE_ID,
			cycleId: 1,
			decisionPrompt: "hidden decision prompt",
		}),
		{
			customType: DECISION_MESSAGE_TYPE,
			content: "hidden decision prompt",
			display: false,
			details: {
				version: DECISION_PROTOCOL_VERSION,
				namespace: "pi-continue-watchdog",
				inquiryId: EXCHANGE_ID,
				attempt: 1,
			},
		},
	);

	assert.deepEqual(
		createDecisionFoldMessage({
			exchangeId: EXCHANGE_ID,
			cycleId: 2,
			outcome: "continue",
			continuePrompt: CONTINUE_PROMPT,
		}),
		{
			customType: DECISION_FOLD_MESSAGE_TYPE,
			content: CONTINUE_PROMPT,
			display: false,
			details: {
				version: DECISION_PROTOCOL_VERSION,
				namespace: "pi-continue-watchdog",
				inquiryId: EXCHANGE_ID,
				attempt: 2,
				outcome: "replace",
				watchdogOutcome: "continue",
				replacement: {
					customType: CONTINUATION_MESSAGE_TYPE,
					content: CONTINUE_PROMPT,
					details: {
						version: DECISION_PROTOCOL_VERSION,
						exchangeId: EXCHANGE_ID,
						outcome: "continue",
					},
				},
			},
		},
	);

	assert.deepEqual(
		createDecisionFoldMessage({
			exchangeId: EXCHANGE_ID,
			cycleId: 1,
			outcome: "unlock",
		}),
		{
			customType: DECISION_FOLD_MESSAGE_TYPE,
			content: "",
			display: false,
			details: {
				version: DECISION_PROTOCOL_VERSION,
				namespace: "pi-continue-watchdog",
				inquiryId: EXCHANGE_ID,
				attempt: 1,
				outcome: "remove",
				watchdogOutcome: "unlock",
			},
		},
	);

	assert.deepEqual(
		createDecisionFoldMessage({
			exchangeId: EXCHANGE_ID,
			cycleId: 1,
			outcome: "wait",
		}),
		{
			customType: DECISION_FOLD_MESSAGE_TYPE,
			content: "",
			display: false,
			details: {
				version: DECISION_PROTOCOL_VERSION,
				namespace: "pi-continue-watchdog",
				inquiryId: EXCHANGE_ID,
				attempt: 1,
				outcome: "remove",
				watchdogOutcome: "wait",
			},
		},
	);

	assert.deepEqual(
		createDecisionFoldMessage({
			exchangeId: EXCHANGE_ID,
			cycleId: 3,
			outcome: "decision-failed",
		}),
		{
			customType: DECISION_FOLD_MESSAGE_TYPE,
			content: "",
			display: false,
			details: {
				version: DECISION_PROTOCOL_VERSION,
				namespace: "pi-continue-watchdog",
				inquiryId: EXCHANGE_ID,
				attempt: 3,
				outcome: "remove",
				watchdogOutcome: "decision-failed",
			},
		},
	);

	assert.deepEqual(
		createDecisionFoldMessage({
			exchangeId: EXCHANGE_ID,
			cycleId: 1,
			outcome: "preempted",
		}),
		{
			customType: DECISION_FOLD_MESSAGE_TYPE,
			content: "",
			display: false,
			details: {
				version: DECISION_PROTOCOL_VERSION,
				namespace: "pi-continue-watchdog",
				inquiryId: EXCHANGE_ID,
				attempt: 1,
				outcome: "remove",
				watchdogOutcome: "preempted",
			},
		},
	);
});

test("valid continue folds the complete exchange into the compact continue prompt", () => {
	const messages = [
		user("task", 1),
		decision(EXCHANGE_ID, 1, 2),
		assistant(
			[text("<watchdog><function>continue_watchdog</function></watchdog>")],
			3,
		),
		foldMarker({ outcome: "continue", timestamp: 4 }),
		user("later", 5),
	];

	assert.deepEqual(foldDecisionContext(messages), [
		user("task", 1),
		continuationMessage(4),
		user("later", 5),
	]);
});

test("user-preempted decisions fold without a terminal assistant or replacement", () => {
	const withoutAssistant = [
		user("task", 1),
		decision(EXCHANGE_ID, 1, 2),
		foldMarker({ outcome: "preempted", timestamp: 3 }),
		user("takeover", 4),
	];
	assert.deepEqual(foldDecisionContext(withoutAssistant), [
		user("task", 1),
		user("takeover", 4),
	]);

	const neutralizedAssistant = neutralizeDecisionAssistant(
		{
			...assistant([], 3),
			stopReason: "stop",
			errorMessage: "pi-continue-watchdog:preempted",
		},
		EXCHANGE_ID,
		1,
	);
	const withNeutralizedAssistant = [
		user("task", 1),
		decision(EXCHANGE_ID, 1, 2),
		neutralizedAssistant,
		foldMarker({ outcome: "preempted", timestamp: 4 }),
		user("takeover", 5),
	];
	assert.deepEqual(foldDecisionContext(withNeutralizedAssistant), [
		user("task", 1),
		user("takeover", 5),
	]);

	const pluginBefore = {
		role: "custom",
		customType: "other:before",
		content: "before",
		display: false,
		timestamp: 3,
	};
	const pluginAfter = {
		role: "custom",
		customType: "other:after",
		content: "after",
		display: false,
		timestamp: 6,
	};
	const interleaved = [
		user("task", 1),
		decision(EXCHANGE_ID, 1, 2),
		pluginBefore,
		foldMarker({ outcome: "preempted", timestamp: 4 }),
		pluginAfter,
		{ ...neutralizedAssistant, timestamp: 5 },
		user("takeover", 7),
	];
	assert.deepEqual(foldDecisionContext(interleaved), [
		user("task", 1),
		pluginBefore,
		pluginAfter,
		user("takeover", 7),
	]);

	const invalidFirstCycle = {
		...assistant([text("invalid")], 3),
		content: [],
	};
	const betweenCycles = {
		role: "custom",
		customType: "other:between-cycles",
		content: "keep me",
		display: false,
		timestamp: 4,
	};
	const multiCycle = [
		decision(EXCHANGE_ID, 1, 2),
		invalidFirstCycle,
		betweenCycles,
		decision(EXCHANGE_ID, 2, 5),
		foldMarker({ outcome: "preempted", cycleId: 2, timestamp: 6 }),
		neutralizeDecisionAssistant(
			{ ...neutralizedAssistant, timestamp: 7 },
			EXCHANGE_ID,
			2,
		),
	];
	assert.deepEqual(foldDecisionContext(multiCycle), [betweenCycles]);
});

test("valid unlock and decision-failed erase the exchange with no replacement", () => {
	const unlockMessages = [
		user("task", 1),
		decision(EXCHANGE_ID, 1, 2),
		assistant(
			[
				text(
					"<watchdog><function>unlock_continue_watchdog</function><reason_type>JOB_DONE</reason_type><reason_content>Done.</reason_content></watchdog>",
				),
			],
			3,
		),
		foldMarker({ outcome: "unlock", timestamp: 4 }),
	];
	assert.deepEqual(foldDecisionContext(unlockMessages), [user("task", 1)]);

	const hiddenUnlockMessages = [
		user("task", 1),
		decision(EXCHANGE_ID, 1, 2),
		assistant([], 3),
		foldMarker({ outcome: "unlock", timestamp: 4 }),
	];
	assert.deepEqual(foldDecisionContext(hiddenUnlockMessages), [
		user("task", 1),
	]);

	const failedMessages = [
		user("task", 1),
		decision(EXCHANGE_ID, 1, 2),
		assistant([text("nope")], 3),
		decision(EXCHANGE_ID, 2, 4),
		assistant([text("still nope")], 5),
		decision(EXCHANGE_ID, 3, 6),
		assistant([text("fail")], 7),
		foldMarker({ outcome: "decision-failed", cycleId: 3, timestamp: 8 }),
	];
	assert.deepEqual(foldDecisionContext(failedMessages), [user("task", 1)]);

	const noResultFailedMessages = [
		user("task", 1),
		decision(EXCHANGE_ID, 1, 2),
		decision(EXCHANGE_ID, 2, 3),
		decision(EXCHANGE_ID, 3, 4),
		foldMarker({ outcome: "decision-failed", cycleId: 3, timestamp: 5 }),
	];
	assert.deepEqual(foldDecisionContext(noResultFailedMessages), [
		user("task", 1),
	]);
});

test("blocked ordinary tool calls and multi-round invalid re-asks fold as one exchange", () => {
	const messages = [
		user("task", 1),
		decision(EXCHANGE_ID, 1, 2),
		assistant(
			[toolCall("bash-1", "bash", { command: "true" }), text("thinking aloud")],
			3,
		),
		toolResult("bash-1", "bash", 4),
		decision(EXCHANGE_ID, 2, 5),
		assistant(
			[text("<watchdog><function>continue_watchdog</function></watchdog>")],
			6,
		),
		foldMarker({ outcome: "continue", cycleId: 2, timestamp: 7 }),
	];

	assert.deepEqual(foldDecisionContext(messages), [
		user("task", 1),
		continuationMessage(7, EXCHANGE_ID, CONTINUE_PROMPT, 2),
	]);
});

test("incomplete, interleaved, or malformed exchanges fail closed", () => {
	const incomplete = [
		decision(EXCHANGE_ID, 1, 1),
		assistant(
			[text("<watchdog><function>continue_watchdog</function></watchdog>")],
			2,
		),
	];
	assert.equal(foldDecisionContext(incomplete), incomplete);

	const interleaved = [
		decision(EXCHANGE_ID, 1, 1),
		assistant(
			[text("<watchdog><function>continue_watchdog</function></watchdog>")],
			2,
		),
		user("interleaved", 3),
		foldMarker({ outcome: "continue", timestamp: 4 }),
	];
	assert.equal(foldDecisionContext(interleaved), interleaved);

	const badCycle = [
		decision(EXCHANGE_ID, 1, 1),
		assistant([text("bad")], 2),
		decision(EXCHANGE_ID, 3, 3),
		assistant(
			[text("<watchdog><function>continue_watchdog</function></watchdog>")],
			4,
		),
		foldMarker({ outcome: "continue", cycleId: 3, timestamp: 5 }),
	];
	assert.equal(foldDecisionContext(badCycle), badCycle);
});

test("a malformed plugin record keeps later cycles with the same exchange id raw", () => {
	const malformedDecision = {
		...decision(EXCHANGE_ID, 1, 1),
		content: "",
	};
	const laterCycle = decision(EXCHANGE_ID, 2, 2);
	const laterAssistant = assistant(
		[text("<watchdog><function>continue_watchdog</function></watchdog>")],
		3,
	);
	const laterFold = foldMarker({
		outcome: "continue",
		cycleId: 2,
		timestamp: 4,
	});
	const messages = [malformedDecision, laterCycle, laterAssistant, laterFold];

	assert.deepEqual(foldDecisionContext(messages), messages);
});

test("an earlier aborted decision does not prevent a later complete exchange from folding", () => {
	const abortedExchangeId = "aborted-exchange";
	const completeExchangeId = "complete-exchange";
	const abortedAssistant = neutralizeDecisionAssistant(
		{
			...assistant([], 3),
			stopReason: "aborted",
			errorMessage: "Operation aborted",
		},
		abortedExchangeId,
		1,
		{ stopReason: "aborted" },
	);
	const messages = [
		user("before", 1),
		decision(abortedExchangeId, 1, 2),
		abortedAssistant,
		user("after aborted run", 4),
		decision(completeExchangeId, 1, 5),
		assistant(
			[text("<watchdog><function>continue_watchdog</function></watchdog>")],
			6,
		),
		foldMarker({
			exchangeId: completeExchangeId,
			outcome: "continue",
			timestamp: 7,
		}),
	];

	assert.deepEqual(foldDecisionContext(messages), [
		user("before", 1),
		user("after aborted run", 4),
		continuationMessage(7, completeExchangeId),
	]);
});

test("an incomplete exchange stays raw without poisoning a later complete exchange", () => {
	const incompleteExchangeId = "incomplete-exchange";
	const completeExchangeId = "complete-exchange";
	const incompleteDecision = decision(incompleteExchangeId, 1, 2);
	const incompleteAssistant = assistant([text("no terminal marker")], 3);
	const messages = [
		user("before", 1),
		incompleteDecision,
		incompleteAssistant,
		user("interleaving user message", 4),
		decision(completeExchangeId, 1, 5),
		assistant(
			[text("<watchdog><function>continue_watchdog</function></watchdog>")],
			6,
		),
		foldMarker({
			exchangeId: completeExchangeId,
			outcome: "continue",
			timestamp: 7,
		}),
	];

	assert.deepEqual(foldDecisionContext(messages), [
		user("before", 1),
		incompleteDecision,
		incompleteAssistant,
		user("interleaving user message", 4),
		continuationMessage(7, completeExchangeId),
	]);
});

test("builders reject invalid inputs and the context hook uses foldDecisionContext", () => {
	assert.throws(() =>
		createDecisionPromptMessage({
			exchangeId: "",
			cycleId: 1,
			decisionPrompt: "x",
		}),
	);
	assert.throws(() =>
		createDecisionFoldMessage({
			exchangeId: EXCHANGE_ID,
			cycleId: 1,
			outcome: "continue",
			continuePrompt: "x".repeat(MAX_PROMPT_CHARACTERS + 1),
		}),
	);

	const messages = [
		decision(EXCHANGE_ID, 1, 1),
		assistant(
			[text("<watchdog><function>continue_watchdog</function></watchdog>")],
			2,
		),
		foldMarker({ outcome: "continue", timestamp: 3 }),
	];
	let seen: unknown;
	const pi = {
		on(event: string, handler: (event: ContextEvent) => unknown): void {
			assert.equal(event, "context");
			seen = handler({
				type: "context",
				messages: messages as never,
			} as ContextEvent);
		},
	};
	registerDecisionContextFolding(pi as never);
	assert.deepEqual(seen, {
		messages: [continuationMessage(3)],
	});

	// convertToLlm must still accept the continuation custom message shape.
	const converted = convertToLlm([continuationMessage(3) as never]);
	assert.ok(Array.isArray(converted));
});

test("persisted string-or-text-block custom messages still fold", () => {
	const prompt = createDecisionPromptMessage({
		exchangeId: EXCHANGE_ID,
		cycleId: 1,
		decisionPrompt: "hidden decision prompt",
	});
	const fold = createDecisionFoldMessage({
		exchangeId: EXCHANGE_ID,
		cycleId: 1,
		outcome: "continue",
		continuePrompt: CONTINUE_PROMPT,
	});
	const messages = [
		persistedCustomMessage(prompt, 1),
		assistant(
			[text("<watchdog><function>continue_watchdog</function></watchdog>")],
			2,
		),
		persistedCustomMessage(fold, 3),
	];
	assert.deepEqual(foldDecisionContext(messages), [continuationMessage(3)]);
});
