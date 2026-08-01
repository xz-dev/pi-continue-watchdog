import assert from "node:assert/strict";
import test from "node:test";

import { createContinueToolRenderers } from "../src/render.js";

const CONTINUE_PROMPT = "Continue until every background job has been checked.";
const THEME = {
	fg(_color: string, value: string): string {
		return value;
	},
	bold(value: string): string {
		return value;
	},
};

test("Slice 7 RED Example 7: continue call/result render as one compact configured-prompt line", () => {
	const renderers = createContinueToolRenderers(() => CONTINUE_PROMPT);
	const call = renderers.renderCall({}, THEME as never, {} as never);
	const result = renderers.renderResult(
		{
			content: [{ type: "text", text: "Decision recorded." }],
			details: { kind: "decision-recorded" },
		},
		{ expanded: false, isPartial: false },
		THEME as never,
		{} as never,
	);

	assert.deepEqual(
		call.render(120).map((line) => line.trimEnd()),
		[CONTINUE_PROMPT],
	);
	assert.deepEqual(result.render(120), []);
});

test("Slice 7 RED: the continue renderer is compact while running and preserves a one-line prompt with Pi TUI wrapping", () => {
	const renderers = createContinueToolRenderers(() => CONTINUE_PROMPT);
	const call = renderers.renderCall({}, THEME as never, {} as never);
	const partial = renderers.renderResult(
		{ content: [], details: undefined },
		{ expanded: false, isPartial: true },
		THEME as never,
		{} as never,
	);

	assert.deepEqual(
		call.render(18).map((line) => line.trimEnd()),
		["Continue until", "every background", "job has been", "checked."],
	);
	assert.deepEqual(partial.render(120), []);
});
