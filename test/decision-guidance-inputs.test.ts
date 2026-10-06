import assert from "node:assert/strict";
import test from "node:test";

import { BUILT_IN_CONFIG, type ContinueWatchdogConfig } from "../src/config.js";
import { foldDecisionContext } from "../src/context-fold.js";
import { buildDecisionPrompt } from "../src/decision-protocol.js";

/**
 * A13–A15 unit-layer fixtures.
 *
 * Narrow unit checks of two separate layers: foldDecisionContext keeps
 * conversation inputs intact, and buildDecisionPrompt's fixed contract
 * encodes the evidence-first permission rules from design decision 8 (mature
 * 668b02b exact-permission semantics). They are NOT a full runtime-assembled
 * decision request: the conversation inputs here are plain in-memory objects
 * (the "questionnaire" record is assistant narration and the stale watchdog
 * hint is a fabricated user-role message), so they cannot prove
 * transport-layer input fidelity.
 *
 * The authoritative A13–A15 input-fidelity evidence is the set of separate
 * actual serialized decision-request captures in test/e2e/packed.test.ts
 * (`packed A13a…A15d`), each with genuine user-role/tool-result/plugin
 * attribution provenance and per-case expected boundaries. This file keeps
 * only the projection-preservation checks and a compact contract-shape check
 * that those captures do not duplicate.
 *
 * Neither layer proves that a live model reasons correctly: model efficacy
 * remains unmeasured, no provider call is made, and no fake verdict is
 * evidence.
 */

const config: ContinueWatchdogConfig = BUILT_IN_CONFIG;

function message(role: string, text: string, timestamp: number): object {
	return {
		role,
		content: [{ type: "text", text }],
		timestamp,
	};
}

test("A13–A15 input layer: decisive user records survive folding", () => {
	// Projection preservation only: the decisive records stay available to the
	// model after local context folding. Expected outcomes per case are the
	// packed captures' business; here only preservation is claimed.
	const messages = [
		message("user", "Yes — apply the schema migration now.", 1),
		message(
			"assistant",
			"Questionnaire complete: migration approved (answer recorded).",
			2,
		),
		message("assistant", "To be safe, may I apply the migration?", 3),
		message("user", "From now on, only read-only exploration.", 4),
	];
	const folded = foldDecisionContext(messages);
	const joined = folded
		.map((entry) =>
			(entry as { content?: Array<{ text?: string }> }).content
				?.map((block) => block.text ?? "")
				.join(""),
		)
		.join("\n");
	assert.match(joined, /apply the schema migration now/);
	assert.match(joined, /Questionnaire complete/);
	assert.match(joined, /only read-only exploration/);
	assert.equal(folded.length, 4);
});

test("A13–A15 fixed contract: evidence-first ordering and boundary rules are present", () => {
	const prompt = buildDecisionPrompt(
		config.decisionPrompt,
		config.reasonTypes,
		config.continueReasonTypes,
	);
	const fixed = prompt.slice(
		prompt.indexOf("Use only the existing conversation context"),
	);
	// One compact shape check over the controlling rules the packed captures
	// assert per-case; not a wording snapshot.
	assert.match(
		fixed,
		/An earlier authorization does not override a later restriction/,
	);
	assert.match(
		fixed,
		/Exclude work already delivered, cancelled, or superseded/,
	);
	assert.match(fixed, /Your own earlier confirmation question is not evidence/);
	assert.match(fixed, /Do not invent permission from generic encouragement/);
	assert.match(fixed, /a distinct unsatisfied confirmation requirement/);
	assert.match(
		fixed,
		/missing credentials, or unfinished device authentication/,
	);
	assert.match(fixed, /neither adds nor removes user permission/);
	assert.match(fixed, /There is no wait action and no watchdog timer/);
});
