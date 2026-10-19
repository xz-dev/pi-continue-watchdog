import assert from "node:assert/strict";
import test from "node:test";

import {
	buildDecisionFilePrompt,
	buildDecisionFileReaskPrompt,
} from "../src/decision-protocol.js";

const reasons = ["JOB_DONE", "WAIT_USER", "WAIT_CALLBACK"];
const continueReasons = ["WORK_REMAINS", "VERIFYING"];
const file = '/var/tmp/private decision/quoted "result".json';

test("file decision guidance preserves scope and delivery rules without a result function", () => {
	const prompt = buildDecisionFilePrompt(
		"Assess the authorized work.",
		reasons,
		continueReasons,
		file,
	);
	assert.doesNotMatch(prompt, /\bcw\b|reserved function/);
	assert.match(prompt, /using the write tool and no other tool/);
	assert.match(
		prompt,
		/Exclude work already delivered, cancelled, or superseded/,
	);
	assert.match(
		prompt,
		/Your own earlier confirmation question is not evidence/,
	);
	assert.match(prompt, /a suggested future workflow step/);
	assert.match(
		prompt,
		/reason_content never substitutes for a missing deliverable/,
	);
	assert.ok(prompt.includes(JSON.stringify(reasons)));
	assert.ok(prompt.includes(JSON.stringify(continueReasons)));
	const marker = prompt.match(
		/<watchdog_result_file>(.*?)<\/watchdog_result_file>/s,
	);
	assert.ok(marker);
	assert.equal(JSON.parse(marker[1]), file);
});

test("file correction teaches the same contract and includes the concrete validator error", () => {
	const prompt = buildDecisionFileReaskPrompt(
		"Assess current work.",
		reasons,
		continueReasons,
		file,
		"action is required",
	);
	assert.match(prompt, /failed validation: action is required/);
	assert.doesNotMatch(prompt, /\bcw\b|reserved function/);
	assert.match(prompt, /Only the host may request a further correction/);
	assert.match(prompt, /There is no wait action/);
});
