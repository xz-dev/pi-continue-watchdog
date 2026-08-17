import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_CONTINUE_REASON_TYPES,
	DEFAULT_REASON_TYPES,
} from "../src/config.js";
import { createLockDecisionController } from "../src/controller.js";
import {
	buildDecisionPrompt,
	buildDecisionReaskPrompt,
	createDecisionProtocolSession,
	DECISION_INVALID_ATTEMPT_LIMIT,
	type DecisionResponse,
	formatDecisionFailedNotification,
	INVALID_CONTINUE_REASON_ERROR,
	INVALID_CONTINUE_REASON_TYPE_ERROR,
	INVALID_DECISION_XML_ERROR,
	INVALID_UNLOCK_REASON_ERROR,
	INVALID_UNLOCK_REASON_TYPE_ERROR,
	MALFORMED_DECISION_RESPONSE_ERROR,
	MISSING_CONTINUE_FIELDS_ERROR,
	MISSING_UNLOCK_FIELDS_ERROR,
	normalizeAssistantDecisionResponse,
	UNSUPPORTED_DECISION_CONTENT_ERROR,
	validateDecisionResponse,
} from "../src/decision-protocol.js";

const DECISION_PROMPT = "Decision prompt from configuration.";
const REASON_TYPES = DEFAULT_REASON_TYPES;
const CONTINUE_REASON_TYPES = DEFAULT_CONTINUE_REASON_TYPES;

function response(content: DecisionResponse["content"]): DecisionResponse {
	return { content };
}

function text(value: string): DecisionResponse["content"][number] {
	return { type: "text", text: value };
}

function continueXml(
	reasonType = "WORK_REMAINS",
	reasonContent = "Implementation work remains.",
	extra = "",
): string {
	return `<watchdog><function>continue_watchdog</function><reason_type>${reasonType}</reason_type><reason_content>${reasonContent}</reason_content>${extra}</watchdog>`;
}

function unlockXml(
	reasonType = "JOB_DONE",
	reasonContent = "All requested work is complete.",
): string {
	return `<watchdog><function>unlock_continue_watchdog</function><reason_type>${reasonType}</reason_type><reason_content>${reasonContent}</reason_content></watchdog>`;
}

function openDecision(
	reasonTypes: readonly string[] = REASON_TYPES,
	continueReasonTypes: readonly string[] = CONTINUE_REASON_TYPES,
) {
	const controller = createLockDecisionController({ maxRetries: 2 });
	controller.lock();
	const opened = controller
		.beginDecision()
		.effects.find((effect) => effect.kind === "openDecisionWindow");
	assert.ok(opened);
	return {
		controller,
		protocol: createDecisionProtocolSession({
			controller,
			decisionId: opened.decisionId,
			decisionPrompt: DECISION_PROMPT,
			reasonTypes,
			continueReasonTypes,
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

test("validator accepts one trailing continue XML block after narration and ignores thinking plus surrounding whitespace", () => {
	assert.deepEqual(
		validateDecisionResponse(
			response([
				{ type: "thinking" },
				text(`I checked the existing conversation.\n\n${continueXml()}\n `),
			]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "continue",
				reasonType: "WORK_REMAINS",
				reason: "Implementation work remains.",
			},
		},
	);
});

test("watchdog XML root, fields, and function are case-insensitive", () => {
	assert.deepEqual(
		validateDecisionResponse(
			response([
				text(
					"<WaTcHdOg><FuNcTiOn>CoNtInUe_WaTcHdOg</FuNcTiOn><ReAsOn_TyPe>work_remains</ReAsOn_TyPe><ReAsOn_CoNtEnT>still working</ReAsOn_CoNtEnT></wAtChDoG>",
				),
			]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "continue",
				reasonType: "WORK_REMAINS",
				reason: "still working",
			},
		},
	);
});

test("validator rejects multiple watchdog blocks anywhere in one response", () => {
	for (const value of [
		`${continueXml()}\n${continueXml()}`,
		`Earlier candidate: ${continueXml()}\nFinal candidate: ${continueXml()}`,
		`<watchdog><function>continue_watchdog</function></watchdog></watchdog>`,
	]) {
		assert.deepEqual(
			validateDecisionResponse(
				response([text(value)]),
				REASON_TYPES,
				CONTINUE_REASON_TYPES,
			),
			{ valid: false, error: INVALID_DECISION_XML_ERROR },
		);
	}
});

test("continue XML requires independently configured type and nonblank reason", () => {
	assert.deepEqual(
		validateDecisionResponse(
			response([text(continueXml("verifying", " Tests still need to run. "))]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "continue",
				reasonType: "VERIFYING",
				reason: "Tests still need to run.",
			},
		},
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([
				text("<watchdog><function>continue_watchdog</function></watchdog>"),
			]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{ valid: false, error: MISSING_CONTINUE_FIELDS_ERROR },
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([text(continueXml("JOB_DONE", "Wrong namespace."))]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{ valid: false, error: INVALID_CONTINUE_REASON_TYPE_ERROR },
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([text(continueXml("WORK_REMAINS", " "))]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{ valid: false, error: INVALID_CONTINUE_REASON_ERROR },
	);
});

test("validator accepts unlock XML with entity decoding and case-insensitive reason_type", () => {
	assert.deepEqual(
		validateDecisionResponse(
			response([
				{ type: "thinking" },
				text(
					unlockXml(
						" wait_user ",
						" Waiting for &lt;user&gt; confirmation.&amp; ",
					),
				),
			]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "unlock",
				reasonType: "WAIT_USER",
				reason: "Waiting for <user> confirmation.&",
			},
		},
	);
});

test("unlock reason_type matches configured values case-insensitively and emits uppercased match", () => {
	const custom = ["NeedReview", "shipped"] as const;
	assert.deepEqual(
		validateDecisionResponse(
			response([text(unlockXml("needreview", "PR is open for human review."))]),
			custom,
			CONTINUE_REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "unlock",
				reasonType: "NEEDREVIEW",
				reason: "PR is open for human review.",
			},
		},
	);

	assert.deepEqual(
		validateDecisionResponse(
			response([text(unlockXml("JOB_DONE", "Still using defaults."))]),
			custom,
			CONTINUE_REASON_TYPES,
		),
		{ valid: false, error: INVALID_UNLOCK_REASON_TYPE_ERROR },
	);
});

test("unlock reason_content is trimmed, counts Unicode code points, and never truncates", () => {
	const exactly500 = "世".repeat(500);
	const over500 = `${exactly500}界`;

	assert.deepEqual(
		validateDecisionResponse(
			response([text(unlockXml("JOB_DONE", `\n${exactly500}\n`))]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "unlock",
				reasonType: "JOB_DONE",
				reason: exactly500,
			},
		},
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([text(unlockXml("JOB_DONE", over500))]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{ valid: false, error: INVALID_UNLOCK_REASON_ERROR },
	);
	assert.deepEqual(
		validateDecisionResponse(
			response([text(unlockXml("JOB_DONE", " \n\t "))]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{ valid: false, error: INVALID_UNLOCK_REASON_ERROR },
	);
});

test("blocked ordinary toolCall blocks do not invalidate a final valid XML answer", () => {
	assert.deepEqual(
		validateDecisionResponse(
			response([
				{
					type: "toolCall",
					toolCallId: "bash-1",
					name: "bash",
					arguments: { command: "true" },
				},
				text(continueXml()),
			]),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
		),
		{
			valid: true,
			decision: {
				kind: "continue",
				reasonType: "WORK_REMAINS",
				reason: "Implementation work remains.",
			},
		},
	);
});

test("validator rejects non-XML, fences, prose, and malformed documents with fixed errors", () => {
	const cases: readonly {
		readonly name: string;
		readonly value: DecisionResponse;
		readonly error: string;
	}[] = [
		{
			name: "thinking only",
			value: response([{ type: "thinking" }]),
			error: INVALID_DECISION_XML_ERROR,
		},
		{
			name: "prose only",
			value: response([text("I will wait.")]),
			error: INVALID_DECISION_XML_ERROR,
		},
		{
			name: "markdown fence",
			value: response([text(`\`\`\`xml\n${continueXml()}\n\`\`\``)]),
			error: INVALID_DECISION_XML_ERROR,
		},
		{
			name: "duplicate function",
			value: response([
				text(
					"<watchdog><function>continue_watchdog</function><function>unlock_continue_watchdog</function></watchdog>",
				),
			]),
			error: INVALID_DECISION_XML_ERROR,
		},
		{
			name: "root attributes",
			value: response([
				text(
					'<watchdog id="x"><function>continue_watchdog</function></watchdog>',
				),
			]),
			error: INVALID_DECISION_XML_ERROR,
		},
		{
			name: "unlock missing fields",
			value: response([
				text(
					"<watchdog><function>unlock_continue_watchdog</function><reason_type>JOB_DONE</reason_type></watchdog>",
				),
			]),
			error: MISSING_UNLOCK_FIELDS_ERROR,
		},
		{
			name: "unsupported assistant content",
			value: response([{ type: "other" }]),
			error: UNSUPPORTED_DECISION_CONTENT_ERROR,
		},
	];

	for (const entry of cases) {
		assert.deepEqual(
			validateDecisionResponse(
				entry.value,
				REASON_TYPES,
				CONTINUE_REASON_TYPES,
			),
			{ valid: false, error: entry.error },
			entry.name,
		);
	}
});

test("Pi AssistantMessage normalization maps ordinary text/thinking/toolCall shapes", () => {
	const normalized = normalizeAssistantDecisionResponse({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text: ` \n${continueXml()}\n ` },
			{
				type: "toolCall",
				id: "bash-1",
				name: "bash",
				arguments: { command: "echo hi" },
			},
		],
	});
	assert.deepEqual(
		validateDecisionResponse(normalized, REASON_TYPES, CONTINUE_REASON_TYPES),
		{
			valid: true,
			decision: {
				kind: "continue",
				reasonType: "WORK_REMAINS",
				reason: "Implementation work remains.",
			},
		},
	);

	assert.deepEqual(
		validateDecisionResponse(
			normalizeAssistantDecisionResponse({ role: "user", content: [] }),
			REASON_TYPES,
			CONTINUE_REASON_TYPES,
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
			CONTINUE_REASON_TYPES,
		),
		{ valid: false, error: UNSUPPORTED_DECISION_CONTENT_ERROR },
	);
});

test("fixed prompt suffix requires typed reasons for both decisions", () => {
	const prompt = buildDecisionPrompt(
		DECISION_PROMPT,
		["JOB_DONE", "WAIT_USER"],
		["WORK_REMAINS", "VERIFYING"],
	);
	assert.match(prompt, /Do not make decisions on the user's behalf/);
	assert.match(prompt, /Do not call tools/);
	assert.match(prompt, /existing conversation context/);
	assert.match(prompt, /exactly one <watchdog>\.\.\.<\/watchdog>/);
	assert.match(prompt, /very end of your response/);
	assert.match(prompt, /Do not output multiple/);
	assert.match(prompt, /\["JOB_DONE","WAIT_USER"\]/);
	assert.match(prompt, /\["WORK_REMAINS","VERIFYING"\]/);
	assert.match(prompt, /<function>continue_watchdog<\/function>/);
	assert.match(prompt, /<reason_type>WORK_REMAINS<\/reason_type>/);
	assert.match(prompt, /<reason_content>concise reason<\/reason_content>/);
	assert.match(prompt, /<function>unlock_continue_watchdog<\/function>/);
	assert.equal(/extra|ignored|unknown child/i.test(prompt), false);
});

test("fixed prompt suffix XML-escapes an arbitrary reason type and lists types unambiguously", () => {
	const prompt = buildDecisionPrompt(
		DECISION_PROMPT,
		["Need <Review & Approval", "comma, type"],
		["Work <Remains & Verify"],
	);
	assert.match(prompt, /\["Need <Review & Approval","comma, type"\]/);
	assert.match(
		prompt,
		/<reason_type>Need &lt;Review &amp; Approval<\/reason_type>/,
	);
	assert.match(
		prompt,
		/<reason_type>Work &lt;Remains &amp; Verify<\/reason_type>/,
	);
	assert.equal(prompt.includes("<reason_type>Need <Review & Approval"), false);
});

test("re-ask prompt embeds the fixed previous error and keeps the XML block last rule", () => {
	assert.equal(
		buildDecisionReaskPrompt(DECISION_PROMPT, INVALID_DECISION_XML_ERROR),
		"Decision prompt from configuration.\n\nYour previous decision response was invalid: End the response with one valid watchdog XML decision block.\nCorrect it now without calling tools. You may explain first, but the watchdog XML block must be at the very end of your response.",
	);
});

test("session finalizes valid continue without temporary decision tools", () => {
	const { controller, protocol } = openDecision();
	assert.equal(controller.snapshot.decisionOpen, true);

	const finalized = finalizeCurrent(
		protocol,
		normalizeAssistantDecisionResponse({
			role: "assistant",
			content: [{ type: "text", text: continueXml() }],
		}),
	);
	assert.equal(finalized.outcome, "continue");
	assert.equal(finalized.cycleId, 1);
	assert.equal(finalized.reasonType, "WORK_REMAINS");
	assert.equal(finalized.reason, "Implementation work remains.");
	assert.deepEqual(finalized.transition.effects, [
		{ kind: "restoreDecisionTools", decisionId: 1 },
	]);
	assert.equal(controller.snapshot.attempt, 1);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 0);
	assert.equal(controller.snapshot.decisionOpen, false);

	const duplicate = finalizeCurrent(protocol, response([text(continueXml())]));
	assert.equal(duplicate, finalized);
	assert.equal(controller.snapshot.attempt, 1);
	assert.equal(protocol.advanceAfterReask(protocol.currentCycleId), false);
});

test("invalid decisions re-ask without consuming a valid continue retry", () => {
	const { controller, protocol } = openDecision();

	const invalid = finalizeCurrent(protocol, response([text("I'll wait.")]));
	assert.equal(invalid.outcome, "reask");
	assert.equal(invalid.error, INVALID_DECISION_XML_ERROR);
	assert.equal(invalid.cycleId, 1);
	assert.equal(
		invalid.reaskPrompt,
		buildDecisionReaskPrompt(DECISION_PROMPT, INVALID_DECISION_XML_ERROR),
	);
	assert.equal(controller.snapshot.attempt, 0);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 1);
	assert.equal(controller.snapshot.decisionOpen, true);

	advanceReask(protocol);
	const valid = finalizeCurrent(protocol, response([text(continueXml())]));
	assert.equal(valid.outcome, "continue");
	assert.equal(controller.snapshot.attempt, 1);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 0);
});

test("finalization caches each cycle and advances only after reask ack", () => {
	const { controller, protocol } = openDecision();
	const firstCycleId = protocol.currentCycleId;
	const invalidResponse = response([text("I will wait.")]);

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

	const second = finalizeCurrent(protocol, response([text("Still waiting.")]));
	assert.equal(second.outcome, "reask");
	assert.equal(controller.snapshot.invalidDecisionAttempts, 2);
	advanceReask(protocol);

	const third = finalizeCurrent(protocol, response([text("Again.")]));
	assert.equal(third.outcome, "decision-failed");
	assert.equal(controller.snapshot.invalidDecisionAttempts, 3);
});

test("third invalid response decision-fails without advancing retries", () => {
	const { controller, protocol } = openDecision();

	const first = finalizeCurrent(protocol, response([text("one")]));
	assert.equal(first.outcome, "reask");
	advanceReask(protocol);
	const second = finalizeCurrent(protocol, response([text("two")]));
	assert.equal(second.outcome, "reask");
	advanceReask(protocol);
	const third = finalizeCurrent(protocol, response([text("three")]));

	assert.equal(third.outcome, "decision-failed");
	assert.equal(third.error, INVALID_DECISION_XML_ERROR);
	assert.equal(third.cycleId, protocol.currentCycleId);
	assert.equal(
		third.notification,
		"Continue watchdog decision failed after 3 attempts: End the response with one valid watchdog XML decision block.",
	);
	assert.equal(DECISION_INVALID_ATTEMPT_LIMIT, 3);
	assert.equal(
		formatDecisionFailedNotification(INVALID_DECISION_XML_ERROR),
		third.notification,
	);
	assert.deepEqual(third.transition.effects, [
		{ kind: "restoreDecisionTools", decisionId: 1 },
		{ kind: "decisionFailed", error: INVALID_DECISION_XML_ERROR },
	]);
	assert.equal(controller.snapshot.attempt, 0);
	assert.equal(controller.snapshot.invalidDecisionAttempts, 3);
	assert.equal(controller.snapshot.decisionFailed, true);
	assert.equal(controller.snapshot.decisionOpen, false);
	assert.equal(protocol.advanceAfterReask(protocol.currentCycleId), false);
});

test("valid unlock reports normalized reason_type and reason_content from XML only", () => {
	const { controller, protocol } = openDecision();

	const finalized = finalizeCurrent(
		protocol,
		response([
			text(unlockXml(" job_done ", " \nWaiting for user confirmation.\n ")),
		]),
	);
	assert.equal(finalized.outcome, "unlock");
	assert.equal(finalized.reasonType, "JOB_DONE");
	assert.equal(finalized.reason, "Waiting for user confirmation.");
	assert.equal(finalized.cycleId, 1);
	assert.deepEqual(finalized.transition.effects, [
		{ kind: "restoreDecisionTools", decisionId: 1 },
		{ kind: "notify", notification: "unlocked" },
	]);
	assert.equal(controller.snapshot.locked, false);
});
