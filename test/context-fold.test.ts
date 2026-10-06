import assert from "node:assert/strict";
import test from "node:test";

import {
	type ContextEvent,
	convertToLlm,
} from "@earendil-works/pi-coding-agent";
import {
	createInquiryRuntime,
	MAX_INQUIRY_CONTENT_CODE_POINTS,
} from "pi-extension-utils/pi-inquiry";

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
	createDecisionFailedWatchdogEvent,
	createExhaustedWatchdogEvent,
	createUnlockWatchdogEvent,
	formatContinueWatchdogEvent,
	formatDecisionFailedWatchdogEvent,
	formatExhaustedWatchdogEvent,
	formatRfc3339WithOffset,
	formatUnlockWatchdogEvent,
	WATCHDOG_EVENT_MESSAGE_TYPE,
	WATCHDOG_EVENT_VERSION,
} from "../src/watchdog-event.js";

type Message = Record<string, unknown>;

const EXCHANGE_ID = "exchange-1";
const CONTINUE_PROMPT = "Continue with the configured task.";
const AUTOMATED_CONTINUATION = formatContinueWatchdogEvent(
	createContinueWatchdogEvent({
		occurredAtMs: 0,
		offsetMinutes: 0,
		reasonType: "WORK_REMAINS",
		reason: "Implementation remains incomplete.",
	}),
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
		| "unlock"
		| "decision-failed"
		| "invalidated"
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

test("shared continue body is frozen with full accepted reason and guidance", () => {
	const longReason = `first line\n${"世".repeat(589)}`;
	const event = createContinueWatchdogEvent({
		occurredAtMs: 0,
		offsetMinutes: -480,
		reasonType: "VERIFYING",
		reason: longReason,
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
	// The accepted reason appears once verbatim as the next-step hint; no
	// prior-result JSON duplication of the reason.
	assert.equal(body.split(longReason).length, 2);
	assert.equal(body.includes("Custom guidance."), true);
	assert.match(body, /latest actually delivered results/);
	assert.match(body, /already delivered, cancelled, or superseded/);
	assert.match(
		body,
		/does not revoke or reset permission the user already granted/,
	);
	assert.doesNotMatch(body, /Previous automated watchdog result/);
	assert.equal(body.includes("cw"), false);
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
		reasonType: "VERIFYING",
		reason: "Run the accepted verification.",
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
	const unlockEvent = createUnlockWatchdogEvent({
		occurredAtMs: 0,
		offsetMinutes: 0,
		reasonType: maximumReasonType,
		reason: "The accepted work is complete.",
	});
	const unlockBody = formatUnlockWatchdogEvent(unlockEvent);
	assert.ok(Array.from(unlockBody).length > MAX_PROMPT_CHARACTERS);
	const unlockFold = createDecisionFoldMessage({
		exchangeId: "exchange-2",
		cycleId: 1,
		outcome: "unlock",
		eventContent: unlockBody,
		watchdogEvent: unlockEvent,
	});
	// The full unlock body still round-trips through the formatter and fold
	// construction at any size; folding a legacy-shaped unlock replace-fold
	// then keeps it OUT of ordinary model context (R1 contract: the unlock
	// reason is control traffic, published today as the quiet UI-only status).
	const unlockMessages = [
		decision("exchange-2", 1, 1),
		assistant([text("unlock")], 2),
		{ role: "custom", ...unlockFold, timestamp: 3 },
	];
	assert.equal(
		foldDecisionContext(unlockMessages).filter(
			(message) => (message as Message).role === "custom",
		).length,
		0,
		"legacy-shaped unlock replacement does not reenter ordinary context",
	);
});

test("automated continuation formatter preserves guidance and safely serializes the reason", () => {
	const body = formatContinueWatchdogEvent(
		createContinueWatchdogEvent({
			occurredAtMs: 0,
			offsetMinutes: 0,
			reasonType: "VERIFYING",
			reason: 'Run tests.\nDo not confuse "quoted" text.',
		}),
		CONTINUE_PROMPT,
	);
	assert.equal(
		body,
		`Continue watchdog · continue · VERIFYING · 1970-01-01T00:00:00.000+00:00\n\nAutomated guidance from the pi-continue-watchdog extension, not a user message or request.\nThis is not user approval, confirmation, consent, or authorization.\nAbsence of new authorization from this notice does not revoke or reset permission the user already granted; permission is reevaluated only against actual scope changes, revocations, and applicable unsatisfied requirements.\n\nSuggested next step: Run tests.\nDo not confuse "quoted" text.\n\nContinuation guidance:\n${CONTINUE_PROMPT}\n\nReconcile this suggested step against the user's current authorized scope and the latest actually delivered results before acting: exclude work already delivered, cancelled, or superseded; do not repeat an already-delivered answer and do not reopen a permission question the user already answered. Resume only requested, authorized work that remains actionable. If additional user input, approval, or assistance is required, stop that action and ask the user normally.`,
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

	// The retired wait outcome can no longer be written: untyped callers get
	// the same TypeError as every other invalid fold input.
	assert.throws(
		() =>
			createDecisionFoldMessage({
				exchangeId: EXCHANGE_ID,
				cycleId: 1,
				outcome: "wait",
			} as never),
		/wait is a retired outcome/,
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
	// Raw persisted legacy wait-fold record: written by an older version,
	// constructed inline because no production writer admits wait anymore.
	const details = {
		version: DECISION_PROTOCOL_VERSION,
		namespace: "pi-continue-watchdog",
		inquiryId: EXCHANGE_ID,
		attempt: 8,
		outcome: "remove",
		watchdogOutcome: "wait",
		watchdogResult: {
			outcome: "wait",
			reason: "Legacy waiting reason.",
			waitSeconds: 300,
		},
	};
	const parsed = parseDecisionFoldDetails(details);
	assert.ok(parsed);
	assert.equal(Object.hasOwn(parsed, "watchdogResult"), false);
	assert.equal(parsed?.watchdogOutcome, "wait");
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

test("legacy wait records stay readable and fold without restoring wait behavior", () => {
	// Legacy records written by versions that still accepted waits. They are
	// constructed inline as raw persisted data: no production wait constructor
	// exists anymore, and reading these must not rearm any timer.
	const waitBody =
		"Continue watchdog waiting · 30s · 1970-01-01T00:00:30.000+00:00";
	const completedBody =
		"Continue watchdog delay elapsed · requested 30s · elapsed 31s · 1970-01-01T00:00:31.000+00:00";
	const waitEvent = {
		version: 1 as const,
		kind: "wait" as const,
		occurredAtMs: 0,
		occurredAt: "1970-01-01T00:00:00.000+00:00",
		reason: "Waiting for CI.",
		waitSeconds: 30,
		deadlineMs: 30_000,
		deadline: "1970-01-01T00:00:30.000+00:00",
	};
	// Raw persisted legacy replace-fold record with its wait replacement event,
	// exactly in the stored format an older version wrote: the generic inquiry
	// fold payload plus the legacy watchdog outcome/event details. Built through
	// the shared inquiry runtime because the production decision-fold writer
	// now rejects retired outcomes.
	const legacyWaitFold = createInquiryRuntime("pi-continue-watchdog", {
		inquiryId: EXCHANGE_ID,
	}).fold(1, {
		customType: WATCHDOG_EVENT_MESSAGE_TYPE,
		content: waitBody,
		details: waitEvent,
	});
	const waitFold = {
		...legacyWaitFold,
		display: true,
		details: {
			...legacyWaitFold.details,
			watchdogOutcome: "wait",
			watchdogEvent: waitEvent,
		},
	};
	const completedEvent = {
		version: 1 as const,
		kind: "wait-completed" as const,
		occurredAtMs: 31_000,
		occurredAt: "1970-01-01T00:00:31.000+00:00",
		waitIdentity: "wait-1",
		acceptedAtMs: 0,
		acceptedAt: "1970-01-01T00:00:00.000+00:00",
		waitSeconds: 30,
		elapsedSeconds: 31,
	};
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

	// Legacy wait bodies are retired control traffic: the wait replace-fold
	// and its replacement no longer reenter ordinary model context (R1
	// contract), while the standalone shared completion/exhaustion events —
	// which were published directly, not as fold replacements — survive.
	const foldedCustoms = foldDecisionContext(messages)
		.filter((message) => message.role === "custom")
		.map(messageText);
	assert.deepEqual(foldedCustoms, [completedBody, exhaustedBody]);
	// A legacy wait fold still parses as a recognized legacy outcome for
	// read/timeline compatibility; it simply never reenters model context.
	const parsed = parseDecisionFoldDetails(waitFold.details);
	assert.equal(parsed?.watchdogOutcome, "wait");
	assert.equal(parsed?.watchdogEvent?.kind, "wait");
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
	assert.match(AUTOMATED_CONTINUATION, /not a user message or request/);
	assert.match(
		AUTOMATED_CONTINUATION,
		/not user approval, confirmation, consent, or authorization/,
	);
	// The reason appears once as the attributed next step, not JSON history.
	assert.match(
		AUTOMATED_CONTINUATION,
		/Suggested next step: Implementation remains incomplete\./,
	);
	assert.doesNotMatch(AUTOMATED_CONTINUATION, /"reasonType"/);
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

test("continuation envelope keeps A13–A15 counterparts in fixed wording", () => {
	const event = createContinueWatchdogEvent({
		occurredAtMs: 0,
		offsetMinutes: 0,
		reasonType: "VERIFYING",
		reason: "Run the requested tests.",
	});
	const body = formatContinueWatchdogEvent(event, "Keep going.");
	// A13 counterpart: the disclaimer does not erase existing permission.
	assert.match(
		body,
		/does not revoke or reset permission the user already granted/,
	);
	assert.match(
		body,
		/only against actual scope changes, revocations, and applicable unsatisfied requirements/,
	);
	// A14 counterpart: a stale hint is not proof of missing delivery.
	assert.match(body, /latest actually delivered results/);
	assert.match(body, /do not repeat an already-delivered answer/);
	assert.match(
		body,
		/do not reopen a permission question the user already answered/,
	);
	// Genuine boundaries remain intact: user authorization is still required.
	assert.match(body, /stop that action and ask the user normally/);
	// The envelope teaches no ordinary-turn control call.
	assert.equal(body.includes("cw"), false);
});

test("recognized legacy unlock and wait replacements do not reenter ordinary context", () => {
	// R1 regression: persisted legacy replace-folds whose replacement carries a
	// validated unlock/wait control event must fold out of ordinary model
	// context together with their exchange, while the shared failure and
	// exhaustion events published directly (not as fold replacements) and all
	// human records survive.
	const unlockEvent = createUnlockWatchdogEvent({
		occurredAtMs: 0,
		offsetMinutes: 0,
		reasonType: "JOB_DONE",
		reason: "LEGACY_PRIVATE_UNLOCK_REASON",
	});
	const unlockFold = createDecisionFoldMessage({
		exchangeId: "legacy-unlock-ex",
		cycleId: 1,
		outcome: "unlock",
		eventContent: formatUnlockWatchdogEvent(unlockEvent),
		watchdogEvent: unlockEvent,
	});
	const failedEvent = createDecisionFailedWatchdogEvent({
		occurredAtMs: 1,
		error: "The decision response was malformed.",
	});
	const failedFold = createDecisionFoldMessage({
		exchangeId: "legacy-failed-ex",
		cycleId: 3,
		outcome: "decision-failed",
		eventContent: formatDecisionFailedWatchdogEvent(failedEvent),
		watchdogEvent: failedEvent,
	});
	const messages = [
		user("original request", 1),
		decision("legacy-unlock-ex", 1, 2),
		{ role: "custom", ...unlockFold, timestamp: 5 },
		user("human interjection", 6),
		decision("legacy-failed-ex", 3, 7),
		{ role: "custom", ...failedFold, timestamp: 8 },
		user("new request", 9),
	];
	const folded = foldDecisionContext(messages);
	const text = JSON.stringify(folded);
	assert.doesNotMatch(text, /LEGACY_PRIVATE_UNLOCK_REASON/);
	assert.match(text, /original request/);
	assert.match(text, /human interjection/);
	assert.match(text, /new request/);
	// The permitted shared failure event (the decision-failed replacement)
	// survives: that is how the current runtime publishes it.
	assert.match(text, /decision response was malformed/i);
});

test("legacy wait replacement folds out while shared completion events survive", () => {
	const waitEvent = {
		version: 1 as const,
		kind: "wait" as const,
		occurredAtMs: 0,
		occurredAt: "1970-01-01T00:00:00.000+00:00",
		reason: "Waiting for CI.",
		waitSeconds: 30,
		deadlineMs: 30_000,
		deadline: "1970-01-01T00:00:30.000+00:00",
	};
	const waitFold = createInquiryRuntime("pi-continue-watchdog", {
		inquiryId: "legacy-wait-ex",
	}).fold(1, {
		customType: WATCHDOG_EVENT_MESSAGE_TYPE,
		content: "Continue watchdog waiting · 30s · legacy",
		details: waitEvent,
	});
	const messages = [
		user("task", 1),
		decision("legacy-wait-ex", 1, 2),
		{
			role: "custom",
			...waitFold,
			details: { ...waitFold.details, watchdogOutcome: "wait" },
			timestamp: 3,
		},
		user("after", 4),
	];
	const text = JSON.stringify(foldDecisionContext(messages));
	assert.doesNotMatch(text, /Continue watchdog waiting/);
	assert.match(text, /task/);
	assert.match(text, /after/);
});

test("user quotation of retired control text is never folded", () => {
	// Control: a user message quoting legacy control text verbatim survives —
	// cleanup is keyed on validated fold metadata, never body text.
	const unlockEvent = createUnlockWatchdogEvent({
		occurredAtMs: 0,
		offsetMinutes: 0,
		reasonType: "JOB_DONE",
		reason: "QUOTED_REASON",
	});
	const unlockFold = createDecisionFoldMessage({
		exchangeId: "other-ex",
		cycleId: 1,
		outcome: "unlock",
		eventContent: formatUnlockWatchdogEvent(unlockEvent),
		watchdogEvent: unlockEvent,
	});
	const messages = [
		user("task", 1),
		decision("other-ex", 1, 2),
		{ role: "custom", ...unlockFold, timestamp: 3 },
		{
			role: "user",
			content: `The watchdog said: ${formatUnlockWatchdogEvent(unlockEvent)}`,
			timestamp: 4,
		},
	];
	const folded = foldDecisionContext(messages);
	const userText = folded
		.filter((message) => (message as Message).role === "user")
		.map((message) => messageText(message as Message))
		.join("\n");
	assert.match(userText, /QUOTED_REASON/);
	// Only the fold's own replacement body is gone.
	const customs = folded.filter(
		(message) => (message as Message).role === "custom",
	);
	assert.equal(customs.length, 0);
});
