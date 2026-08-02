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
	MAX_PERSISTED_CONTENT_BLOCKS,
	MAX_TOOL_CALL_ID_CHARACTERS,
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
		customType: DECISION_MESSAGE_TYPE,
		content: "hidden decision prompt",
		display: false,
		details: {
			version: DECISION_PROTOCOL_VERSION,
			exchangeId,
			cycleId,
		},
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
		stopReason: "toolUse",
		timestamp,
	};
}

function toolCall(
	id: string,
	name: "continue_watchdog" | "unlock_continue_watchdog",
	arguments_: Record<string, unknown>,
): Record<string, unknown> {
	return { type: "toolCall", id, name, arguments: arguments_ };
}

function text(textContent: string): Record<string, unknown> {
	return { type: "text", text: textContent };
}

/**
 * Pi's persisted CustomMessage shape after reloading a sendMessage string:
 * role=custom, content=[{ type: "text", text }], and numeric timestamp.
 * `createCustomMessage` is internal; this source-backed fixture stays on public
 * imports while `convertToLlm` proves the resulting public AgentMessage shape.
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
	toolName: "continue_watchdog" | "unlock_continue_watchdog",
	timestamp: number,
): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "Decision recorded." }],
		details: { kind: "decision-recorded" },
		isError: false,
		timestamp,
	};
}

function foldMarker(options: {
	readonly exchangeId?: string;
	readonly cycleId?: number;
	readonly outcome: "continue" | "unlock";
	readonly toolCallId: string;
	readonly continuePrompt?: string;
	readonly timestamp: number;
}): Message {
	return {
		role: "custom",
		customType: DECISION_FOLD_MESSAGE_TYPE,
		content:
			options.outcome === "continue"
				? (options.continuePrompt ?? CONTINUE_PROMPT)
				: "",
		display: false,
		details:
			options.outcome === "continue"
				? {
						version: DECISION_PROTOCOL_VERSION,
						exchangeId: options.exchangeId ?? EXCHANGE_ID,
						cycleId: options.cycleId ?? 1,
						outcome: options.outcome,
						toolCallId: options.toolCallId,
						continuePrompt: options.continuePrompt ?? CONTINUE_PROMPT,
					}
				: {
						version: DECISION_PROTOCOL_VERSION,
						exchangeId: options.exchangeId ?? EXCHANGE_ID,
						cycleId: options.cycleId ?? 1,
						outcome: options.outcome,
						toolCallId: options.toolCallId,
					},
		timestamp: options.timestamp,
	};
}

function validContinueExchange(
	options: {
		readonly exchangeId?: string;
		readonly timestampOffset?: number;
	} = {},
): Message[] {
	const exchangeId = options.exchangeId ?? EXCHANGE_ID;
	const offset = options.timestampOffset ?? 0;
	return [
		decision(exchangeId, 1, offset + 10),
		assistant(
			[toolCall("continue-call", "continue_watchdog", {})],
			offset + 11,
		),
		toolResult("continue-call", "continue_watchdog", offset + 12),
		foldMarker({
			exchangeId,
			outcome: "continue",
			toolCallId: "continue-call",
			continuePrompt: CONTINUE_PROMPT,
			timestamp: offset + 13,
		}),
	];
}

function validUnlockExchange(): Message[] {
	return [
		decision(EXCHANGE_ID, 1, 10),
		assistant(
			[
				toolCall("unlock-call", "unlock_continue_watchdog", {
					reason: "All jobs are complete.",
				}),
			],
			11,
		),
		toolResult("unlock-call", "unlock_continue_watchdog", 12),
		foldMarker({
			outcome: "unlock",
			toolCallId: "unlock-call",
			timestamp: 13,
		}),
	];
}

test("C1: Pi persisted custom blocks round-trip through the installed constructor and fold valid exchanges", () => {
	const decisionPayload = createDecisionPromptMessage({
		exchangeId: EXCHANGE_ID,
		cycleId: 1,
		decisionPrompt: "hidden decision prompt",
	});
	const foldPayload = createDecisionFoldMessage({
		exchangeId: EXCHANGE_ID,
		cycleId: 1,
		outcome: "continue",
		toolCallId: "continue-call",
		continuePrompt: CONTINUE_PROMPT,
	});
	const decisionRecord = persistedCustomMessage(decisionPayload, 10);
	const foldRecord = persistedCustomMessage(foldPayload, 13);
	assert.deepEqual(decisionRecord.content, [
		{ type: "text", text: "hidden decision prompt" },
	]);
	assert.deepEqual(foldRecord.content, [
		{ type: "text", text: CONTINUE_PROMPT },
	]);

	const folded = foldDecisionContext([
		decisionRecord,
		assistant([toolCall("continue-call", "continue_watchdog", {})], 11),
		toolResult("continue-call", "continue_watchdog", 12),
		foldRecord,
	] as never);
	assert.equal(folded.length, 1);
	assert.deepEqual(
		convertToLlm(folded as unknown as Parameters<typeof convertToLlm>[0]),
		[
			{
				role: "user",
				content: [{ type: "text", text: CONTINUE_PROMPT }],
				timestamp: 13,
			},
		],
	);
});

test("C1: string custom content remains compatible while persisted block arrays are exact", () => {
	const messages = [
		decision(EXCHANGE_ID, 1, 10),
		assistant([toolCall("continue-call", "continue_watchdog", {})], 11),
		toolResult("continue-call", "continue_watchdog", 12),
		foldMarker({
			outcome: "continue",
			toolCallId: "continue-call",
			timestamp: 13,
		}),
	];
	assert.equal(foldDecisionContext(messages as never).length, 1);
});

test("C1/I1: malformed persisted block arrays fail closed without iteration", () => {
	const invalidContent: readonly unknown[] = [
		[],
		[
			{ type: "text", text: CONTINUE_PROMPT },
			{ type: "text", text: "" },
		],
		[{ type: "image", data: "not-a-decision", mimeType: "image/png" }],
		[{ type: "text", text: CONTINUE_PROMPT, ignored: true }],
		new Proxy([{ type: "text", text: CONTINUE_PROMPT }], {
			getOwnPropertyDescriptor(_target, key) {
				if (key === "0") throw new Error("must fail closed");
				return Reflect.getOwnPropertyDescriptor(_target, key);
			},
		}),
	];
	for (const content of invalidContent) {
		const messages = validContinueExchange();
		(messages[3] as Message).content = content;
		assert.doesNotThrow(() => foldDecisionContext(messages as never));
		assert.equal(foldDecisionContext(messages as never), messages);
	}

	const iteratorHostile = validContinueExchange();
	(iteratorHostile[3] as Message).content = Object.assign(
		[{ type: "text", text: CONTINUE_PROMPT }],
		{
			[Symbol.iterator](): Iterator<never> {
				throw new Error("must not iterate persisted content");
			},
		},
	);
	assert.equal(foldDecisionContext(iteratorHostile as never).length, 1);
});

test("I1: strict indexed arrays reject holes, accessors, and over-limit content", () => {
	const sparse = [{ type: "text", text: CONTINUE_PROMPT }];
	sparse.length = 2;
	const accessor = [] as unknown[];
	Object.defineProperty(accessor, "0", {
		get() {
			throw new Error("must not invoke content accessor");
		},
		configurable: true,
	});
	accessor.length = 1;
	const overLimit = Array.from(
		{ length: MAX_PERSISTED_CONTENT_BLOCKS + 1 },
		() => ({ type: "text", text: CONTINUE_PROMPT }),
	);

	for (const content of [sparse, accessor, overLimit]) {
		const messages = validContinueExchange();
		(messages[3] as Message).content = content;
		assert.equal(foldDecisionContext(messages as never), messages);
	}
});

test("I1: hostile assistant content arrays fail closed without invoking their iterator", () => {
	const content = Object.assign(
		[toolCall("continue-call", "continue_watchdog", {})],
		{
			[Symbol.iterator](): Iterator<never> {
				throw new Error("must not iterate assistant content");
			},
		},
	);
	const messages = [
		decision(EXCHANGE_ID, 1, 10),
		assistant(content, 11),
		toolResult("continue-call", "continue_watchdog", 12),
		foldMarker({
			outcome: "continue",
			toolCallId: "continue-call",
			timestamp: 13,
		}),
	];
	assert.doesNotThrow(() => foldDecisionContext(messages as never));
	assert.equal(foldDecisionContext(messages as never).length, 1);
});

test("I2: constructor and parser share exact Unicode prompt and tool-call-id bounds", () => {
	const promptAtLimit = "😀".repeat(MAX_PROMPT_CHARACTERS);
	const promptOverLimit = `${promptAtLimit}😀`;
	const idAtLimit = "x".repeat(MAX_TOOL_CALL_ID_CHARACTERS);
	const idOverLimit = `${idAtLimit}x`;

	assert.doesNotThrow(() =>
		createDecisionPromptMessage({
			exchangeId: EXCHANGE_ID,
			cycleId: 1,
			decisionPrompt: promptAtLimit,
		}),
	);
	assert.throws(
		() =>
			createDecisionPromptMessage({
				exchangeId: EXCHANGE_ID,
				cycleId: 1,
				decisionPrompt: promptOverLimit,
			}),
		/invalid decision prompt message input/,
	);
	assert.doesNotThrow(() =>
		createDecisionFoldMessage({
			exchangeId: EXCHANGE_ID,
			cycleId: 1,
			outcome: "continue",
			toolCallId: idAtLimit,
			continuePrompt: promptAtLimit,
		}),
	);
	assert.throws(
		() =>
			createDecisionFoldMessage({
				exchangeId: EXCHANGE_ID,
				cycleId: 1,
				outcome: "continue",
				toolCallId: idOverLimit,
				continuePrompt: CONTINUE_PROMPT,
			}),
		/invalid decision fold message input/,
	);
	assert.throws(
		() =>
			createDecisionFoldMessage({
				exchangeId: EXCHANGE_ID,
				cycleId: 1,
				outcome: "continue",
				toolCallId: idAtLimit,
				continuePrompt: promptOverLimit,
			}),
		/invalid decision fold message input/,
	);

	for (const applyInvalidValue of [
		(messages: Message[], value: string) => {
			(messages[0]?.details as { exchangeId: string }).exchangeId = value;
		},
		(messages: Message[], value: string) => {
			(messages[1]?.content as Message[])[0] = toolCall(
				value,
				"continue_watchdog",
				{},
			);
		},
		(messages: Message[], value: string) => {
			(messages[3]?.details as { toolCallId: string }).toolCallId = value;
		},
	]) {
		const messages = validContinueExchange();
		applyInvalidValue(messages, idOverLimit);
		assert.equal(foldDecisionContext(messages as never), messages);
	}
});

test("Slice 7 RED Example 6: a correlated valid unlock exchange is removed only from model-bound context", () => {
	const messages = [
		user("Keep this task.", 1),
		...validUnlockExchange(),
		user("After.", 20),
	];
	const rawBefore = structuredClone(messages);

	const folded = foldDecisionContext(messages as never);

	assert.deepEqual(folded, [messages[0], messages[messages.length - 1]]);
	assert.deepEqual(messages, rawBefore);
});

test("Slice 7 RED Example 7: a correlated valid continue exchange becomes exactly one compact configured custom message", () => {
	const messages = [
		user("Keep this task.", 1),
		...validContinueExchange(),
		user("After.", 20),
	];
	const rawBefore = structuredClone(messages);

	const folded = foldDecisionContext(messages as never);

	assert.equal(folded.length, 3);
	assert.equal(folded[0], messages[0]);
	assert.deepEqual(folded[1], {
		role: "custom",
		customType: CONTINUATION_MESSAGE_TYPE,
		content: [{ type: "text", text: CONTINUE_PROMPT }],
		display: false,
		details: {
			version: DECISION_PROTOCOL_VERSION,
			exchangeId: EXCHANGE_ID,
			outcome: "continue",
		},
		timestamp: 13,
	});
	assert.equal(folded[2], messages[messages.length - 1]);
	assert.deepEqual(messages, rawBefore);
	assert.deepEqual(foldDecisionContext(folded as never), folded);
});

test("Slice 7 RED: the complete exchange includes invalid re-ask cycles before the terminal valid decision", () => {
	const messages = [
		user("Task stays available.", 1),
		decision(EXCHANGE_ID, 1, 10),
		assistant([text("I should continue.")], 11),
		decision(EXCHANGE_ID, 2, 12),
		assistant([toolCall("continue-call", "continue_watchdog", {})], 13),
		toolResult("continue-call", "continue_watchdog", 14),
		foldMarker({
			cycleId: 2,
			outcome: "continue",
			toolCallId: "continue-call",
			continuePrompt: CONTINUE_PROMPT,
			timestamp: 15,
		}),
	];

	const folded = foldDecisionContext(messages as never);

	assert.deepEqual(folded, [
		messages[0],
		{
			role: "custom",
			customType: CONTINUATION_MESSAGE_TYPE,
			content: [{ type: "text", text: CONTINUE_PROMPT }],
			display: false,
			details: {
				version: DECISION_PROTOCOL_VERSION,
				exchangeId: EXCHANGE_ID,
				outcome: "continue",
			},
			timestamp: 15,
		},
	]);
});

test("Slice 7 RED: multiple independently correlated completed exchanges fold without touching their surrounding messages", () => {
	const first = validContinueExchange({
		exchangeId: "exchange-a",
		timestampOffset: 0,
	});
	const second = validUnlockExchange().map((message) => {
		const copy = structuredClone(message);
		if (copy.role === "custom") {
			const details = copy.details as { exchangeId: string };
			details.exchangeId = "exchange-b";
		}
		return copy;
	});
	const messages = [
		user("Before", 1),
		...first,
		user("Between", 20),
		...second,
		user("After", 30),
	];

	const folded = foldDecisionContext(messages as never);

	assert.deepEqual(
		folded.map((message) => {
			const typed = message as Message;
			return typed.role === "custom" ? typed.customType : typed.content;
		}),
		["Before", CONTINUATION_MESSAGE_TYPE, "Between", "After"],
	);
});

test("Slice 7 RED: unexpected user work, nested prompts, incomplete spans, or bad tool-result correlation fail closed and retain raw context", () => {
	const cases: readonly {
		readonly name: string;
		readonly messages: Message[];
	}[] = [
		{
			name: "a user message arrives inside the decision span",
			messages: [
				decision(EXCHANGE_ID, 1, 10),
				user("Do not delete this.", 11),
				...validContinueExchange().slice(1),
			],
		},
		{
			name: "a nested decision prompt is present",
			messages: [
				decision(EXCHANGE_ID, 1, 10),
				decision(EXCHANGE_ID, 2, 11),
				...validContinueExchange().slice(1),
			],
		},
		{
			name: "the terminal fold marker is absent",
			messages: validContinueExchange().slice(0, -1),
		},
		{
			name: "a tool result cannot be correlated to the assistant tool call",
			messages: [
				decision(EXCHANGE_ID, 1, 10),
				assistant([toolCall("continue-call", "continue_watchdog", {})], 11),
				toolResult("other-call", "continue_watchdog", 12),
				foldMarker({
					outcome: "continue",
					toolCallId: "continue-call",
					timestamp: 13,
				}),
			],
		},
	];

	for (const entry of cases) {
		const rawBefore = structuredClone(entry.messages);
		const folded = foldDecisionContext(entry.messages as never);
		assert.equal(folded, entry.messages, entry.name);
		assert.deepEqual(entry.messages, rawBefore, entry.name);
	}
});

test("Slice 7 RED: malformed or hostile plugin-looking records never throw and never remove normal context", () => {
	const hostile = Object.create(null) as Record<string, unknown>;
	Object.defineProperty(hostile, "role", {
		get() {
			throw new Error("must not invoke message getters");
		},
	});
	const malformed = {
		role: "custom",
		customType: DECISION_MESSAGE_TYPE,
		content: "not trusted",
		display: false,
		details: { version: DECISION_PROTOCOL_VERSION, exchangeId: EXCHANGE_ID },
		timestamp: 1,
	};
	const messages = [user("Preserve me.", 1), hostile, malformed];

	assert.doesNotThrow(() => foldDecisionContext(messages as never));
	assert.equal(foldDecisionContext(messages as never), messages);
});

test("Slice 7 RED: the Pi context hook delegates only a new model-bound message array and leaves the event source untouched", () => {
	let handler:
		| ((event: { messages: unknown[] }) => { messages?: unknown[] } | undefined)
		| undefined;
	const pi = {
		on(event: string, candidate: typeof handler): void {
			if (event === "context") handler = candidate;
		},
	};
	registerDecisionContextFolding(pi as never);
	assert.ok(handler);

	const messages = validContinueExchange();
	const result = handler({ messages } as unknown as ContextEvent);
	assert.deepEqual(
		result?.messages?.map((message) => (message as Message).customType),
		[CONTINUATION_MESSAGE_TYPE],
	);
	assert.equal(messages.length, 4);
});
