import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_REASON_TYPES } from "../src/config.js";
import {
	buildDecisionPrompt,
	validateDecisionArguments,
} from "../src/decision-protocol.js";

const CONTINUE_TYPES = ["WORK_REMAINS", "VERIFYING"] as const;

test("retired wait action is invalid regardless of its fields", () => {
	const verdict = validateDecisionArguments(
		{ action: "wait", reason_content: "Wait for CI.", wait_seconds: 60 },
		[...DEFAULT_REASON_TYPES],
		[...CONTINUE_TYPES],
	);
	assert.equal(
		verdict.valid,
		false,
		"wait must be a normal invalid decision, not an accepted outcome",
	);
});

test("decision prompt teaches only continue and unlock", () => {
	const prompt = buildDecisionPrompt(
		"Decide now.",
		[...DEFAULT_REASON_TYPES],
		[...CONTINUE_TYPES],
	);
	assert.doesNotMatch(
		prompt,
		/"action"\s*:\s*"wait"|To wait:|submit wait/i,
		"prompt must not teach the retired wait action",
	);
	assert.match(prompt, /continue/i);
	assert.match(prompt, /unlock/i);
});

test("wait_seconds never creates timing behavior under any action", () => {
	// A wait duration supplied alongside a still-valid action must not be
	// interpreted as timing semantics; existing extra-field acceptance is
	// unchanged, so a continue with an inert extra wait_seconds stays valid.
	const verdict = validateDecisionArguments(
		{
			action: "continue",
			reason_type: "WORK_REMAINS",
			reason_content: "Run the requested tests.",
			wait_seconds: 300,
		},
		[...DEFAULT_REASON_TYPES],
		[...CONTINUE_TYPES],
	);
	assert.equal(verdict.valid, true);
});

test("decision prompt requests assessment-first guidance", () => {
	const prompt = buildDecisionPrompt(
		"Decide now.",
		[...DEFAULT_REASON_TYPES],
		[...CONTINUE_TYPES],
	);
	assert.match(
		prompt,
		/component-by-component delivery assessment/,
		"prompt must ask for a delivery assessment in reason_content",
	);
	assert.match(
		prompt,
		/reason_content \(the delivery assessment\), reason_type, action/,
		"prompt must state the assessment-first field order",
	);
	assert.match(
		prompt,
		/Field order is guidance only, never an acceptance rule/,
		"prompt must not turn property order into a rejection rule",
	);
	// Distinguish reporting a future command from authorization to run it.
	assert.match(
		prompt,
		/supplying that command does not create permission or an obligation to run it/,
	);
});

test("both argument orders stay valid", () => {
	const assessmentFirst = validateDecisionArguments(
		{
			reason_content: "Docs delivered; tests missing.",
			reason_type: "WORK_REMAINS",
			action: "continue",
		},
		[...DEFAULT_REASON_TYPES],
		[...CONTINUE_TYPES],
	);
	assert.deepEqual(assessmentFirst, {
		valid: true,
		decision: {
			kind: "continue",
			reasonType: "WORK_REMAINS",
			reason: "Docs delivered; tests missing.",
		},
	});
	const actionFirst = validateDecisionArguments(
		{
			action: "unlock",
			reason_type: "job_done",
			reason_content: "All requested work delivered.",
		},
		[...DEFAULT_REASON_TYPES],
		[...CONTINUE_TYPES],
	);
	assert.deepEqual(actionFirst, {
		valid: true,
		decision: {
			kind: "unlock",
			reasonType: "JOB_DONE",
			reason: "All requested work delivered.",
		},
	});
});
