import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_REASON_TYPES } from "../src/config.js";
import {
	buildDecisionPrompt,
	isWaitCallbackReasonType,
	prepareDecisionArguments,
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
			matchedReasonType: "WORK_REMAINS",
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
			matchedReasonType: "JOB_DONE",
			reason: "All requested work delivered.",
		},
	});
});

test("preparation normalizes compatible inputs to configured spellings", () => {
	// The existing trim/case-insensitive admission is preserved before native
	// schema validation: padded action casing, mixed-case reason types, and
	// padded reasons all normalize to their configured spellings.
	const prepared = prepareDecisionArguments(
		{
			action: " UNLOCK ",
			reason_type: " job_done ",
			reason_content: " All requested work delivered. ",
			wait_seconds: 30,
		},
		["NeedReview", "JOB_DONE"],
		[...CONTINUE_TYPES],
	);
	assert.deepEqual(prepared, {
		action: "unlock",
		reason_type: "JOB_DONE",
		reason_content: "All requested work delivered.",
		wait_seconds: 30,
	});
	const verdict = validateDecisionArguments(
		prepared,
		["NeedReview", "JOB_DONE"],
		[...CONTINUE_TYPES],
	);
	assert.deepEqual(verdict, {
		valid: true,
		decision: {
			kind: "unlock",
			reasonType: "JOB_DONE",
			matchedReasonType: "JOB_DONE",
			reason: "All requested work delivered.",
		},
	});

	// The matched spelling is the configured entry, preserving custom casing.
	const customPrepared = prepareDecisionArguments(
		{
			action: "unlock",
			reason_type: "needreview",
			reason_content: "PR awaits review.",
		},
		["NeedReview", "shipped"],
		[...CONTINUE_TYPES],
	);
	assert.deepEqual(customPrepared, {
		action: "unlock",
		reason_type: "NeedReview",
		reason_content: "PR awaits review.",
	});

	// A 1000-code-point reason padded with whitespace stays valid after
	// trimming; nothing is truncated.
	const longReason = `  ${"x".repeat(1000)}  `;
	const padded = prepareDecisionArguments(
		{
			action: "continue",
			reason_type: " verifying ",
			reason_content: longReason,
		},
		[...DEFAULT_REASON_TYPES],
		[...CONTINUE_TYPES],
	);
	assert.deepEqual(padded, {
		action: "continue",
		reason_type: "VERIFYING",
		reason_content: "x".repeat(1000),
	});
	const paddedVerdict = validateDecisionArguments(
		padded,
		[...DEFAULT_REASON_TYPES],
		[...CONTINUE_TYPES],
	);
	assert.equal(paddedVerdict.valid, true);

	// Preparation never mutates the caller's argument object.
	const original = {
		action: " UNLOCK ",
		reason_type: " job_done ",
		reason_content: " Done. ",
	};
	prepareDecisionArguments(original, ["JOB_DONE"], [...CONTINUE_TYPES]);
	assert.deepEqual(original, {
		action: " UNLOCK ",
		reason_type: " job_done ",
		reason_content: " Done. ",
	});
});

test("preparation keeps invalid inputs invalid without manufacturing values", () => {
	const unlockTypes = ["NeedReview", "shipped"];
	// Missing fields are never supplied.
	assert.deepEqual(
		prepareDecisionArguments({}, unlockTypes, [...CONTINUE_TYPES]),
		{},
	);
	// Non-string values are never stringified.
	assert.deepEqual(
		prepareDecisionArguments(
			{ action: "unlock", reason_type: "NeedReview", reason_content: 5 },
			unlockTypes,
			[...CONTINUE_TYPES],
		),
		{ action: "unlock", reason_type: "NeedReview", reason_content: 5 },
	);
	// An invalid action is never rewritten to a valid one, and the unmatched
	// reason type is left alone so enum admission cannot leak across actions.
	assert.deepEqual(
		prepareDecisionArguments(
			{ action: "wait", reason_type: "needreview", reason_content: "w" },
			unlockTypes,
			[...CONTINUE_TYPES],
		),
		{ action: "wait", reason_type: "needreview", reason_content: "w" },
	);
	// An unmatched reason type keeps its raw spelling: schema and runtime
	// validation still reject it.
	assert.deepEqual(
		prepareDecisionArguments(
			{ action: "unlock", reason_type: "NOPE", reason_content: "x" },
			unlockTypes,
			[...CONTINUE_TYPES],
		),
		{ action: "unlock", reason_type: "NOPE", reason_content: "x" },
	);
	// An oversized reason is never truncated.
	const oversized = "y".repeat(1001);
	const unprepared = prepareDecisionArguments(
		{ action: "continue", reason_type: "verifying", reason_content: oversized },
		unlockTypes,
		[...CONTINUE_TYPES],
	);
	assert.equal(
		(unprepared as { reason_content: string }).reason_content.length,
		1001,
	);
	assert.equal(
		validateDecisionArguments(unprepared, unlockTypes, [...CONTINUE_TYPES])
			.valid,
		false,
	);
	// Non-object payloads pass through untouched.
	assert.equal(
		prepareDecisionArguments("cw()", unlockTypes, [...CONTINUE_TYPES]),
		"cw()",
	);
});

test("uppercase outcome is not an accepted input alias", () => {
	// For effective config ["ß"], ß is admitted and keeps its configured
	// identity; the uppercase outcome form SS is never an accepted alias.
	const unlockTypes = ["ß"];
	const prepared = prepareDecisionArguments(
		{ action: "unlock", reason_type: " ß ", reason_content: "done" },
		unlockTypes,
		[...CONTINUE_TYPES],
	);
	assert.deepEqual(prepared, {
		action: "unlock",
		reason_type: "ß",
		reason_content: "done",
	});
	assert.deepEqual(
		validateDecisionArguments(prepared, unlockTypes, [...CONTINUE_TYPES]),
		{
			valid: true,
			decision: {
				kind: "unlock",
				reasonType: "SS",
				matchedReasonType: "ß",
				reason: "done",
			},
		},
	);
	// Revalidating the preserved input identity still admits ß.
	assert.equal(
		validateDecisionArguments(
			{ action: "unlock", reason_type: "ß", reason_content: "done" },
			unlockTypes,
			[...CONTINUE_TYPES],
		).valid,
		true,
	);
	// The uppercase output SS is not an input alias.
	assert.equal(
		validateDecisionArguments(
			{ action: "unlock", reason_type: "SS", reason_content: "done" },
			unlockTypes,
			[...CONTINUE_TYPES],
		).valid,
		false,
	);
});

test("union membership does not authorize the wrong action", () => {
	// VERIFYING is a continue type; choosing unlock with it stays invalid even
	// though the public reason_type enum union contains it.
	assert.equal(
		validateDecisionArguments(
			{ action: "unlock", reason_type: "VERIFYING", reason_content: "x" },
			[...DEFAULT_REASON_TYPES],
			[...CONTINUE_TYPES],
		).valid,
		false,
	);
	// JOB_DONE is an unlock type; choosing continue with it stays invalid.
	assert.equal(
		validateDecisionArguments(
			{ action: "continue", reason_type: "JOB_DONE", reason_content: "x" },
			[...DEFAULT_REASON_TYPES],
			[...CONTINUE_TYPES],
		).valid,
		false,
	);
	// An overlapping configured label remains valid for both actions.
	assert.equal(
		validateDecisionArguments(
			{ action: "unlock", reason_type: "NeedReview", reason_content: "x" },
			["NeedReview"],
			["NeedReview"],
		).valid,
		true,
	);
	assert.equal(
		validateDecisionArguments(
			{ action: "continue", reason_type: "NeedReview", reason_content: "x" },
			["NeedReview"],
			["NeedReview"],
		).valid,
		true,
	);
});

test("only the built-in WAIT_CALLBACK unlock is classified as callback suspension", () => {
	const reasonTypes = [...DEFAULT_REASON_TYPES, "WAIT_CALLBACK", "CUSTOM_WAIT"];
	const classify = (reasonType: string, extra?: Record<string, unknown>) => {
		const verdict = validateDecisionArguments(
			{
				action: "unlock",
				reason_type: reasonType,
				reason_content: "x",
				...extra,
			},
			reasonTypes,
			[...CONTINUE_TYPES],
		);
		assert.equal(verdict.valid, true, reasonType);
		return verdict.valid && verdict.decision.kind === "unlock"
			? isWaitCallbackReasonType(verdict.decision.matchedReasonType)
			: null;
	};
	assert.equal(classify("WAIT_CALLBACK"), true);
	assert.equal(classify("  wait_callback "), true);
	assert.equal(classify("WAIT_CALLBACK", { wait_seconds: 60 }), true);
	assert.equal(classify("JOB_DONE"), false);
	assert.equal(classify("CUSTOM_WAIT"), false);
	// Excluded from the configured list: an ordinary invalid unlock reason type.
	const excluded = validateDecisionArguments(
		{ action: "unlock", reason_type: "WAIT_CALLBACK", reason_content: "x" },
		["JOB_DONE"],
		[...CONTINUE_TYPES],
	);
	assert.equal(excluded.valid, false);
	// WAIT_CALLBACK is not a continue reason type.
	const asContinue = validateDecisionArguments(
		{ action: "continue", reason_type: "WAIT_CALLBACK", reason_content: "x" },
		reasonTypes,
		[...CONTINUE_TYPES],
	);
	assert.equal(asContinue.valid, false);
});

test("callback guidance explains the retained lock and shared allowance", () => {
	const prompt = buildDecisionPrompt(
		"Decide now.",
		[...DEFAULT_REASON_TYPES, "WAIT_CALLBACK"],
		[...CONTINUE_TYPES],
	);
	assert.match(prompt, /WAIT_CALLBACK, when you are waiting/);
	assert.match(prompt, /keeps the watchdog locked/);
	assert.doesNotMatch(prompt, /"action"\s*:\s*"wait"/);
});
