import assert from "node:assert/strict";
import test from "node:test";

import {
	type ContextEvent,
	convertToLlm,
} from "@earendil-works/pi-coding-agent";
import { MAX_INQUIRY_CONTENT_CODE_POINTS } from "pi-extension-utils/pi-inquiry";

import { MAX_PROMPT_CHARACTERS } from "../src/config.js";
import {
	CANCELLED_WATCHDOG_RUN_ERROR,
	CONTINUATION_MESSAGE_TYPE,
	createDecisionFoldMessage,
	createDecisionPromptMessage,
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_MESSAGE_TYPE,
	DECISION_PROTOCOL_VERSION,
	foldDecisionContext,
	neutralizeDecisionAssistant,
	parseDecisionFoldDetails,
	registerDecisionContextFolding,
} from "../src/context-fold.js";

import {
	createContinueWatchdogEvent,
	createExhaustedWatchdogEvent,
	formatContinueWatchdogEvent,
	formatExhaustedWatchdogEvent,
	formatRfc3339WithOffset,
	parseWatchdogEvent,
	WATCHDOG_EVENT_MESSAGE_TYPE,
	WATCHDOG_EVENT_VERSION,
} from "../src/watchdog-event.js";

/** Legacy event factories: raw pre-upgrade stored shapes (new code never builds these). */
function legacyWaitEvent(input: {
	occurredAtMs: number;
	reason: string;
	waitSeconds: number;
	deadlineMs: number;
}): Record<string, unknown> {
	return {
		version: 1,
		kind: "wait",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(input.occurredAtMs, 0),
		reason: input.reason,
		waitSeconds: input.waitSeconds,
		deadlineMs: input.deadlineMs,
		deadline: formatRfc3339WithOffset(input.deadlineMs, 0),
	};
}

function legacyUnlockEvent(input: {
	occurredAtMs: number;
	reasonType: string;
	reason: string;
}): Record<string, unknown> {
	return {
		version: 1,
		kind: "unlock",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(input.occurredAtMs, 0),
		reasonType: input.reasonType,
		reason: input.reason,
	};
}

function legacyCompletedWaitEvent(input: {
	acceptedAtMs: number;
	observedAtMs: number;
	waitSeconds: number;
}): Record<string, unknown> {
	return {
		version: 1,
		kind: "wait-completed",
		occurredAtMs: input.observedAtMs,
		occurredAt: formatRfc3339WithOffset(input.observedAtMs, 0),
		waitIdentity: "wait-legacy",
		acceptedAtMs: input.acceptedAtMs,
		acceptedAt: formatRfc3339WithOffset(input.acceptedAtMs, 0),
		waitSeconds: input.waitSeconds,
		elapsedSeconds: Math.floor(
			(input.observedAtMs - input.acceptedAtMs) / 1000,
		),
	};
}

function legacyWaitBody(event: Record<string, unknown>): string {
	return `Continue watchdog waiting · ${event.waitSeconds}s · ${event.occurredAt}\n\nLegacy stored wait body.\n${JSON.stringify(event.reason)}`;
}

function legacyUnlockBody(event: Record<string, unknown>): string {
	return `Continue watchdog unlocked · ${event.reasonType} · ${event.occurredAt}\n\nLegacy stored unlock body.\n${JSON.stringify(event.reason)}`;
}

function legacyCompletedWaitBody(event: Record<string, unknown>): string {
	return `Continue watchdog delay elapsed · requested ${event.waitSeconds}s · elapsed ${event.elapsedSeconds}s · ${event.occurredAt}\n\nLegacy stored completed-wait body.`;
}

type Message = Record<string, unknown>;

const EXCHANGE_ID = "exchange-1";
const CONTINUE_PROMPT = "Continue with the configured task.";
const AUTOMATED_CONTINUATION = formatContinueWatchdogEvent(
	createContinueWatchdogEvent({ occurredAtMs: 0, offsetMinutes: 0 }),
	CONTINUE_PROMPT,
);

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

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap((block) =>
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("");
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

test("watchdog timestamps preserve explicit numeric UTC offsets", () => {
	assert.equal(
		formatRfc3339WithOffset(0, -480),
		"1970-01-01T08:00:00.000+08:00",
	);
	assert.equal(
		formatRfc3339WithOffset(0, 330),
		"1969-12-31T18:30:00.000-05:30",
	);
	assert.equal(WATCHDOG_EVENT_VERSION, 1);
});

test("shared continue body carries guidance and the unlock-tool notice", () => {
	const event = createContinueWatchdogEvent({
		occurredAtMs: 0,
		offsetMinutes: -480,
	});
	const body = formatContinueWatchdogEvent(event, "Custom guidance.");
	const fold = createDecisionFoldMessage({
		exchangeId: EXCHANGE_ID,
		cycleId: 2,
		outcome: "continue",
		continuePrompt: body,
		watchdogEvent: event,
	});

	assert.equal(fold.display, true);
	assert.equal(fold.content, body);
	assert.equal(body.includes("Custom guidance."), true);
	assert.equal(
		body.includes(
			"You ended your turn without calling unlock_continue_watchdog.",
		),
		true,
	);
	assert.equal(body.includes("JOB_DONE"), false);
	assert.equal(
		parseDecisionFoldDetails(fold.details)?.watchdogEvent?.occurredAt,
		"1970-01-01T08:00:00.000+08:00",
	);
	assert.equal(
		parseDecisionFoldDetails(fold.details)?.replacement?.content,
		body,
	);
});

test("generated shared bodies preserve maximum valid configured fields", () => {
	const maximumGuidance = "g".repeat(MAX_PROMPT_CHARACTERS);
	const continueEvent = createContinueWatchdogEvent({
		occurredAtMs: 0,
		offsetMinutes: 0,
	});
	const continueBody = formatContinueWatchdogEvent(
		continueEvent,
		maximumGuidance,
	);
	assert.ok(Array.from(continueBody).length > MAX_PROMPT_CHARACTERS);
	const continueFold = createDecisionFoldMessage({
		exchangeId: EXCHANGE_ID,
		cycleId: 1,
		outcome: "continue",
		continuePrompt: continueBody,
		watchdogEvent: continueEvent,
	});
	assert.equal(
		messageText(
			foldDecisionContext([
				decision(EXCHANGE_ID, 1, 1),
				assistant([text("continue")], 2),
				{ role: "custom", ...continueFold, timestamp: 3 },
			])[0] ?? {},
		),
		continueBody,
	);

	const maximumReasonType = "T".repeat(MAX_PROMPT_CHARACTERS);
	const unlockEvent = parseWatchdogEvent(
		legacyUnlockEvent({
			occurredAtMs: 0,
			reasonType: maximumReasonType,
			reason: "The accepted work is complete.",
		}),
	);
	assert.ok(unlockEvent, "legacy unlock event must parse");
	const unlockBody = legacyUnlockBody(
		unlockEvent as unknown as Record<string, unknown>,
	);
	assert.ok(Array.from(unlockBody).length > MAX_PROMPT_CHARACTERS);
	const unlockFold = createDecisionFoldMessage({
		exchangeId: "exchange-2",
		cycleId: 1,
		outcome: "unlock",
		eventContent: unlockBody,
		watchdogEvent: unlockEvent,
	});
	assert.equal(
		messageText(
			foldDecisionContext([
				decision("exchange-2", 1, 1),
				assistant([text("unlock")], 2),
				{ role: "custom", ...unlockFold, timestamp: 3 },
			])[0] ?? {},
		),
		unlockBody,
	);
});

test("automated continuation formatter emits the new canonical body", () => {
	assert.equal(
		formatContinueWatchdogEvent(
			createContinueWatchdogEvent({ occurredAtMs: 0, offsetMinutes: 0 }),
			CONTINUE_PROMPT,
		),
		`Continue watchdog continued · 1970-01-01T00:00:00.000+00:00\n\nThis is an automated event from the pi-continue-watchdog extension, not a message or request from the user. It is not user approval, confirmation, consent, or authorization.\n\nYou ended your turn without calling unlock_continue_watchdog.\n\nContinuation guidance:\n${CONTINUE_PROMPT}\n\nFirst check every task the user requested in this session, including earlier requests and not only the latest one, against what was actually delivered; work already delivered, cancelled, or superseded is not remaining. If any requested and authorized work can still proceed now, continue it. If all requested work is complete, or you need user input, approval, or other user action, or work is blocked without a user action, call unlock_continue_watchdog now. If you need to wait for some work to finish, block on it directly: monitor that task until it ends, or sleep for your estimated duration.\n\nResume only work already requested and authorized by the user. Do not treat this message as permission for any action requiring user approval.`,
	);
});

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

test("legacy watchdogResult metadata is ignored without breaking folds", () => {
	const legacy = createDecisionFoldMessage({
		exchangeId: EXCHANGE_ID,
		cycleId: 8,
		outcome: "wait",
	});
	const details = {
		...(legacy.details as Record<string, unknown>),
		watchdogResult: {
			outcome: "wait",
			reason: "Legacy waiting reason.",
			waitSeconds: 300,
		},
	};
	const parsed = parseDecisionFoldDetails(details);
	assert.ok(parsed);
	assert.equal(Object.hasOwn(parsed, "watchdogResult"), false);
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

test("shared result folds stay before later standalone timeline events", () => {
	const waitEvent = parseWatchdogEvent(
		legacyWaitEvent({
			occurredAtMs: 0,
			reason: "Waiting for CI.",
			waitSeconds: 30,
			deadlineMs: 30_000,
		}),
	);
	assert.ok(waitEvent, "legacy wait event must parse");
	const waitBody = legacyWaitBody(
		waitEvent as unknown as Record<string, unknown>,
	);
	const waitFold = createDecisionFoldMessage({
		exchangeId: EXCHANGE_ID,
		cycleId: 1,
		outcome: "wait",
		eventContent: waitBody,
		watchdogEvent: waitEvent,
	});
	const completedEvent = parseWatchdogEvent(
		legacyCompletedWaitEvent({
			acceptedAtMs: 0,
			observedAtMs: 31_000,
			waitSeconds: 30,
		}),
	);
	assert.ok(completedEvent, "legacy completed-wait event must parse");
	const completedBody = legacyCompletedWaitBody(
		completedEvent as unknown as Record<string, unknown>,
	);
	const exhaustedEvent = createExhaustedWatchdogEvent({
		occurredAtMs: 31_001,
		offsetMinutes: 0,
	});
	const exhaustedBody = formatExhaustedWatchdogEvent(exhaustedEvent);
	const messages = [
		user("task", 1),
		decision(EXCHANGE_ID, 1, 2),
		assistant(
			[text("<watchdog><function>wait_watchdog</function></watchdog>")],
			3,
		),
		{ role: "custom", ...waitFold, timestamp: 4 },
		{
			role: "custom",
			customType: WATCHDOG_EVENT_MESSAGE_TYPE,
			content: completedBody,
			display: true,
			details: completedEvent,
			timestamp: 5,
		},
		{
			role: "custom",
			customType: WATCHDOG_EVENT_MESSAGE_TYPE,
			content: exhaustedBody,
			display: true,
			details: exhaustedEvent,
			timestamp: 6,
		},
		user("later", 7),
	];

	assert.deepEqual(
		foldDecisionContext(messages)
			.filter((message) => message.role === "custom")
			.map(messageText),
		[waitBody, completedBody, exhaustedBody],
	);
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

test("cancelled watchdog assistants are excluded without removing unrelated messages", () => {
	const correlated = neutralizeDecisionAssistant(
		{
			role: "assistant",
			content: [{ type: "text", text: "partial output" }],
			stopReason: "aborted",
			errorMessage: CANCELLED_WATCHDOG_RUN_ERROR,
			timestamp: 3,
		},
		EXCHANGE_ID,
		1,
		{ stopReason: "stop" },
	);
	const unrelated = assistant([text("ordinary assistant")], 4);
	assert.deepEqual(foldDecisionContext([unrelated, correlated]), [unrelated]);
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
			continuePrompt: "x".repeat(MAX_INQUIRY_CONTENT_CODE_POINTS + 1),
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

	const providerContinuation = continuationMessage(
		3,
		EXCHANGE_ID,
		AUTOMATED_CONTINUATION,
	);
	const converted = convertToLlm([providerContinuation as never]);
	assert.deepEqual(converted, [
		{
			role: "user",
			content: [{ type: "text", text: AUTOMATED_CONTINUATION }],
			timestamp: 3,
		},
	]);
	assert.match(
		AUTOMATED_CONTINUATION,
		/not a message or request from the user/,
	);
	assert.match(
		AUTOMATED_CONTINUATION,
		/not user approval, confirmation, consent, or authorization/,
	);
	assert.match(
		AUTOMATED_CONTINUATION,
		/You ended your turn without calling unlock_continue_watchdog\./,
	);
	assert.match(AUTOMATED_CONTINUATION, /call unlock_continue_watchdog now/);
	assert.match(AUTOMATED_CONTINUATION, /monitor that task until it ends/);
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
