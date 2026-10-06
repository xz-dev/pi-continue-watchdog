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
