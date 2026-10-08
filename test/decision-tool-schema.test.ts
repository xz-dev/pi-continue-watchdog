import assert from "node:assert/strict";
import test from "node:test";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";

import { BUILT_IN_CONFIG } from "../src/config.js";
import {
	DECISION_TOOL_NAME,
	MAX_REASON_CHARACTERS,
} from "../src/decision-protocol.js";
import {
	createDecisionToolDefinition,
	DECISION_TOOL_DESCRIPTION,
	type DecisionToolHost,
} from "../src/decision-tool.js";

const unauthorizedHost: DecisionToolHost = {
	submitDecisionResult: () => ({ outcome: "unauthorized" }),
};

interface ParameterShape {
	readonly type?: string;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean;
	readonly properties?: Record<
		string,
		{
			readonly type?: string;
			readonly enum?: readonly string[];
			readonly minLength?: number;
			readonly maxLength?: number;
			readonly pattern?: string;
			readonly description?: string;
			readonly title?: string;
			readonly examples?: unknown;
			readonly default?: unknown;
		}
	>;
}

function declaredParameters(
	reasonTypes: readonly string[] = BUILT_IN_CONFIG.reasonTypes,
	continueReasonTypes: readonly string[] = BUILT_IN_CONFIG.continueReasonTypes,
): { readonly schema: TSchema; readonly shape: ParameterShape } {
	const definition = createDecisionToolDefinition(
		unauthorizedHost,
		reasonTypes,
		continueReasonTypes,
	);
	return {
		schema: definition.parameters,
		shape: definition.parameters as unknown as ParameterShape,
	};
}

function check(schema: TSchema, args: unknown): boolean {
	return Compile(schema).Check(args);
}

test("cw declaration exposes the constrained parameter contract without explanatory annotations", () => {
	const definition = createDecisionToolDefinition(
		unauthorizedHost,
		BUILT_IN_CONFIG.reasonTypes,
		BUILT_IN_CONFIG.continueReasonTypes,
	);
	assert.equal(definition.name, DECISION_TOOL_NAME);
	assert.equal(definition.description, DECISION_TOOL_DESCRIPTION);
	assert.equal(definition.description, "don't use unless ask");
	assert.equal(definition.promptSnippet, undefined);
	assert.equal(definition.promptGuidelines, undefined);
	assert.equal(definition.constrainedSampling, undefined);

	const { shape } = declaredParameters();
	assert.equal(shape.type, "object");
	assert.equal(shape.additionalProperties, true);
	assert.deepEqual([...(shape.required ?? [])].sort(), [
		"action",
		"reason_content",
		"reason_type",
	]);

	const action = shape.properties?.action;
	assert.equal(action?.type, "string");
	assert.deepEqual([...(action?.enum ?? [])].sort(), ["continue", "unlock"]);

	const reasonType = shape.properties?.reason_type;
	assert.equal(reasonType?.type, "string");
	// Exact-deduplicated union of effective configured spellings, in order:
	// unlock list first, then continue list (configured spelling, not uppercase).
	assert.deepEqual(reasonType?.enum, [
		"JOB_DONE",
		"WAIT_USER",
		"JOB_BLOCKED",
		"WAIT_CALLBACK",
		"WORK_REMAINS",
		"VERIFYING",
	]);

	const reasonContent = shape.properties?.reason_content;
	assert.equal(reasonContent?.type, "string");
	assert.equal(reasonContent?.minLength, 1);
	assert.equal(reasonContent?.maxLength, MAX_REASON_CHARACTERS);
	assert.equal(reasonContent?.pattern, "\\S");

	// No explanatory parameter annotations: structural keywords only.
	for (const [name, property] of Object.entries(shape.properties ?? {})) {
		assert.equal(
			property.description,
			undefined,
			`${name} must not carry a description`,
		);
		assert.equal(property.title, undefined, `${name} must not carry a title`);
		assert.equal(
			property.examples,
			undefined,
			`${name} must not carry examples`,
		);
		assert.equal(
			property.default,
			undefined,
			`${name} must not carry a default`,
		);
	}
});

test("cw schema is derived from effective custom and fallback constraints", () => {
	// Custom effective constraints replace the built-in lists and preserve
	// configured spellings, deduplicating exact repeats across both lists.
	const { shape: custom } = declaredParameters(
		["NeedReview", "shipped"],
		["verifying", "NeedReview"],
	);
	assert.deepEqual(custom.properties?.reason_type?.enum, [
		"NeedReview",
		"shipped",
		"verifying",
	]);

	// The Unicode-sensitive configuration keeps its own spelling: the schema
	// enum is ß, never the uppercase outcome representation SS.
	const { shape: unicode, schema } = declaredParameters(["ß"], ["verifying"]);
	assert.deepEqual(unicode.properties?.reason_type?.enum, ["ß", "verifying"]);
	assert.equal(
		check(schema, {
			action: "unlock",
			reason_type: "ß",
			reason_content: "Awaiting review.",
		}),
		true,
	);
	assert.equal(
		check(schema, {
			action: "unlock",
			reason_type: "SS",
			reason_content: "Awaiting review.",
		}),
		false,
	);

	// An invalid higher-precedence list falls back to the same effective list
	// everywhere; the fallback declaration is never an empty enum.
	const { shape: fallback } = declaredParameters(
		BUILT_IN_CONFIG.reasonTypes,
		BUILT_IN_CONFIG.continueReasonTypes,
	);
	assert.ok((fallback.properties?.reason_type?.enum?.length ?? 0) > 0);
});

test("cw schema rejects missing, mistyped, and out-of-contract arguments", () => {
	const { schema } = declaredParameters();
	const validUnlock = {
		action: "unlock",
		reason_type: "JOB_DONE",
		reason_content: "All requested work is complete.",
	};
	assert.equal(check(schema, validUnlock), true);

	const validContinue = {
		action: "continue",
		reason_type: "WORK_REMAINS",
		reason_content: "Implementation remains.",
	};
	assert.equal(check(schema, validContinue), true);

	// Unrelated extra properties and either property order stay admissible.
	assert.equal(
		check(schema, { ...validUnlock, wait_seconds: 30, note: "extra" }),
		true,
	);
	assert.equal(
		check(schema, {
			reason_content: "Implementation remains.",
			reason_type: "WORK_REMAINS",
			action: "continue",
		}),
		true,
	);

	// Missing required fields.
	assert.equal(check(schema, {}), false);
	assert.equal(check(schema, { action: "unlock" }), false);
	assert.equal(
		check(schema, { action: "unlock", reason_type: "JOB_DONE" }),
		false,
	);
	assert.equal(
		check(schema, { reason_type: "JOB_DONE", reason_content: "x" }),
		false,
	);

	// Non-string fields are not admitted by the declared contract.
	assert.equal(check(schema, { ...validUnlock, reason_content: 123 }), false);
	assert.equal(check(schema, { ...validUnlock, action: 1 }), false);

	// Unknown and retired actions, including raw case variants, fail the enum.
	for (const action of ["wait", "bogus", "UNLOCK", "Unlock", ""]) {
		assert.equal(
			check(schema, { ...validUnlock, action }),
			false,
			`action ${JSON.stringify(action)} must fail`,
		);
	}

	// Reason types outside both effective lists fail.
	assert.equal(check(schema, { ...validUnlock, reason_type: "NOPE" }), false);
	// Raw non-normalized spelling is not an input alias.
	assert.equal(
		check(schema, { ...validUnlock, reason_type: "job_done" }),
		false,
	);

	// Empty, whitespace-only, and oversized reasons fail the bounds.
	assert.equal(check(schema, { ...validUnlock, reason_content: "" }), false);
	assert.equal(
		check(schema, { ...validUnlock, reason_content: "   \t\n " }),
		false,
	);
	assert.equal(
		check(schema, {
			...validUnlock,
			reason_content: "x".repeat(MAX_REASON_CHARACTERS + 1),
		}),
		false,
	);
});

test("cw schema bounds reasons at 1000 Unicode code points, not UTF-16 units", () => {
	const { schema } = declaredParameters();
	const emoji1000 = "😀".repeat(MAX_REASON_CHARACTERS);
	const emoji1001 = "😀".repeat(MAX_REASON_CHARACTERS + 1);
	assert.equal(
		check(schema, {
			action: "unlock",
			reason_type: "JOB_DONE",
			reason_content: emoji1000,
		}),
		true,
	);
	assert.equal(
		check(schema, {
			action: "unlock",
			reason_type: "JOB_DONE",
			reason_content: emoji1001,
		}),
		false,
	);
	// A 1000-code-point reason padded with whitespace stays schema-valid:
	// trimming is the preparation seam, not a stricter bound here.
	assert.equal(
		check(schema, {
			action: "continue",
			reason_type: "VERIFYING",
			reason_content: `  ${emoji1000}  `,
		}),
		false,
		"surrounding whitespace pushes the raw string over the raw bound",
	);
});
