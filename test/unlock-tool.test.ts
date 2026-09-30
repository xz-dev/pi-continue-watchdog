import assert from "node:assert/strict";
import test from "node:test";

import {
	buildUnlockToolParameters,
	createUnlockToolDefinition,
	INVALID_REASON_TOOL_ERROR,
	INVALID_REASON_TYPE_TOOL_ERROR,
	invalidReasonTypeToolError,
	MAX_TOOL_REASON_CHARACTERS,
	normalizeUnlockReason,
	normalizeUnlockReasonType,
	prepareUnlockToolArguments,
	UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	UNLOCK_TOOL_DESCRIPTION,
	UNLOCK_TOOL_PROMPT_GUIDELINES,
	UNLOCK_TOOL_PROMPT_SNIPPET,
	type UnlockToolHost,
	unlockReasonTypeEnum,
	unlockToolUserReadyValues,
	validateUnlockToolArguments,
} from "../src/unlock-tool.js";

const DEFAULT_TYPES = ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"];

test("tool name and description state the contract", () => {
	assert.equal(UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME, "unlock_continue_watchdog");
	assert.match(UNLOCK_TOOL_DESCRIPTION, /all requested work is complete/);
	assert.match(UNLOCK_TOOL_DESCRIPTION, /automatically continue your work/);
	assert.match(UNLOCK_TOOL_DESCRIPTION, /pi-continue-watchdog extension/);
	assert.match(UNLOCK_TOOL_DESCRIPTION, /reason_type/);
});

test("tool is listed in the system prompt with stable guidelines", () => {
	const host: UnlockToolHost = {
		isCurrentMain: () => true,
		isLocked: () => true,
		applyAiUnlock: () => true,
	};
	const tool = createUnlockToolDefinition({ reasonTypes: DEFAULT_TYPES }, host);
	assert.equal(tool.promptSnippet, UNLOCK_TOOL_PROMPT_SNIPPET);
	assert.ok((tool.promptSnippet ?? "").length > 0);
	assert.deepEqual(tool.promptGuidelines, [...UNLOCK_TOOL_PROMPT_GUIDELINES]);
	const joined = (tool.promptGuidelines ?? []).join("\n");
	assert.match(joined, /call unlock_continue_watchdog/);
	assert.match(joined, /automatically continues your work/);
	assert.match(joined, /sleep for your estimated duration/);
	// Deterministic: two definitions produce identical prompt contributions.
	const again = createUnlockToolDefinition(
		{ reasonTypes: DEFAULT_TYPES },
		host,
	);
	assert.deepEqual(again.promptGuidelines, tool.promptGuidelines);
	assert.equal(again.promptSnippet, tool.promptSnippet);
});

test("parameter schema enumerates the allowed reason types", () => {
	const schema = JSON.parse(
		JSON.stringify(buildUnlockToolParameters(["job_done", "Wait_User"])),
	) as {
		properties: Record<string, { anyOf?: { const?: string }[] }>;
		additionalProperties?: boolean;
	};
	assert.deepEqual(
		schema.properties.reason_type.anyOf?.map((entry) => entry.const),
		["JOB_DONE", "WAIT_USER"],
	);
	assert.ok(schema.properties.reason !== undefined);
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(unlockReasonTypeEnum(["a", "A", "b"]), ["A", "B"]);
});

test("prepareArguments canonicalizes recognized reason types only", () => {
	assert.deepEqual(
		prepareUnlockToolArguments(
			{ reason_type: " job_done ", reason: "x" },
			DEFAULT_TYPES,
		),
		{ reason_type: "JOB_DONE", reason: "x" },
	);
	const unknown = { reason_type: "FREE_FORM", reason: "x" };
	assert.equal(prepareUnlockToolArguments(unknown, DEFAULT_TYPES), unknown);
	assert.equal(prepareUnlockToolArguments(null, DEFAULT_TYPES), null);
	const tool = createUnlockToolDefinition(
		{ reasonTypes: DEFAULT_TYPES },
		{
			isCurrentMain: () => true,
			isLocked: () => true,
			applyAiUnlock: () => true,
		},
	);
	assert.deepEqual(
		tool.prepareArguments?.({ reason_type: "wait_user", reason: "y" }),
		{ reason_type: "WAIT_USER", reason: "y" },
	);
});

test("normalizeUnlockReasonType matches case-insensitively and uppercases", () => {
	assert.equal(
		normalizeUnlockReasonType("job_done", DEFAULT_TYPES),
		"JOB_DONE",
	);
	assert.equal(
		normalizeUnlockReasonType("  Wait_User ", DEFAULT_TYPES),
		"WAIT_USER",
	);
	// Uppercase of the matched configured value, preserving custom casing.
	assert.equal(
		normalizeUnlockReasonType("needreview", ["NeedReview"]),
		"NEEDREVIEW",
	);
	assert.equal(normalizeUnlockReasonType("NOPE", DEFAULT_TYPES), null);
	assert.equal(normalizeUnlockReasonType("", DEFAULT_TYPES), null);
	assert.equal(normalizeUnlockReasonType(42, DEFAULT_TYPES), null);
});

test("normalizeUnlockReason trims and enforces the code-point limit", () => {
	assert.equal(normalizeUnlockReason("  done  "), "done");
	assert.equal(normalizeUnlockReason("   "), null);
	assert.equal(
		normalizeUnlockReason("a".repeat(MAX_TOOL_REASON_CHARACTERS)),
		"a".repeat(MAX_TOOL_REASON_CHARACTERS),
	);
	// 1000 code points of an astral pair string counts code points, not units.
	const astral = "𝕬".repeat(MAX_TOOL_REASON_CHARACTERS);
	assert.equal(astral.length, MAX_TOOL_REASON_CHARACTERS * 2);
	assert.equal(normalizeUnlockReason(`${astral}x`), null);
});

test("validateUnlockToolArguments returns the normalized call or named error", () => {
	const ok = validateUnlockToolArguments(
		{ reason_type: "job_done", reason: "Complete." },
		DEFAULT_TYPES,
	);
	assert.ok(!("error" in ok));
	assert.deepEqual(ok, { reasonType: "JOB_DONE", reason: "Complete." });

	const badType = validateUnlockToolArguments(
		{ reason_type: "FREE_FORM", reason: "x" },
		DEFAULT_TYPES,
	);
	assert.ok("error" in badType);
	assert.equal(badType.error, invalidReasonTypeToolError(DEFAULT_TYPES));
	assert.ok(badType.error.startsWith(INVALID_REASON_TYPE_TOOL_ERROR));
	assert.match(badType.error, /JOB_DONE, WAIT_USER, JOB_BLOCKED/);

	const badReason = validateUnlockToolArguments(
		{ reason_type: "JOB_DONE", reason: "" },
		DEFAULT_TYPES,
	);
	assert.ok("error" in badReason);
	assert.equal(badReason.error, INVALID_REASON_TOOL_ERROR);

	assert.ok("error" in validateUnlockToolArguments(null, DEFAULT_TYPES));
});

test("execute: valid locked-main call unlocks, terminates, and records intent", async () => {
	const applied: unknown[] = [];
	let locked = true;
	const host: UnlockToolHost = {
		isCurrentMain: () => true,
		isLocked: () => locked,
		applyAiUnlock: (call) => {
			applied.push(call);
			locked = false;
			return true;
		},
	};
	const tool = createUnlockToolDefinition({ reasonTypes: DEFAULT_TYPES }, host);
	const result = await tool.execute(
		"call-1",
		{ reason_type: "job_done", reason: "All merged." } as never,
		undefined,
		undefined,
		{} as never,
	);
	assert.deepEqual(applied, [
		{ reasonType: "JOB_DONE", reason: "All merged." },
	]);
	assert.equal(result.terminate, true);
	assert.match(
		result.content.map((block) => ("text" in block ? block.text : "")).join(""),
		/Continue watchdog unlocked · JOB_DONE/,
	);
});

test("execute: unlocked watchdog returns informational result without terminating", async () => {
	const host: UnlockToolHost = {
		isCurrentMain: () => true,
		isLocked: () => false,
		applyAiUnlock: () => false,
	};
	const tool = createUnlockToolDefinition({ reasonTypes: DEFAULT_TYPES }, host);
	const result = await tool.execute(
		"call-1",
		{ reason_type: "JOB_DONE", reason: "x" } as never,
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(result.terminate, undefined);
	assert.match(
		result.content.map((block) => ("text" in block ? block.text : "")).join(""),
		/not locked/,
	);
});

test("execute: invalid arguments throw and never touch the host", async () => {
	const applied: unknown[] = [];
	const host: UnlockToolHost = {
		isCurrentMain: () => true,
		isLocked: () => true,
		applyAiUnlock: (call) => {
			applied.push(call);
			return true;
		},
	};
	const tool = createUnlockToolDefinition({ reasonTypes: DEFAULT_TYPES }, host);
	await assert.rejects(
		tool.execute(
			"call-1",
			{ reason_type: "UNKNOWN", reason: "x" } as never,
			undefined,
			undefined,
			{} as never,
		),
		/reason_type/,
	);
	assert.deepEqual(applied, []);
});

test("unlockToolUserReadyValues carries type and reason", () => {
	assert.deepEqual(
		unlockToolUserReadyValues({
			reasonType: "WAIT_USER",
			reason: "Need approval.",
		}),
		{
			STOP_KIND: "AI_UNLOCK",
			REASON_TYPE: "WAIT_USER",
			REASON: "Need approval.",
		},
	);
});

test("successful unlock renders one line: header hides once the result is in", () => {
	const tool = createUnlockToolDefinition(
		{ reasonTypes: DEFAULT_TYPES },
		{
			isCurrentMain: () => true,
			isLocked: () => true,
			applyAiUnlock: () => true,
		},
	);
	const theme = { fg: (_color: string, text: string) => text } as never;
	const lines = (component: { render(width: number): string[] }) =>
		component.render(200).join("\n").trim();
	const renderRow = (result: {
		content: { type: "text"; text: string }[];
		details?: unknown;
		isError?: boolean;
	}) => {
		const state = {};
		let invalidations = 0;
		const context = (isPartial: boolean) =>
			({
				state,
				isPartial,
				isError: result.isError ?? false,
				invalidate: () => {
					invalidations += 1;
				},
			}) as never;
		const args = { reason_type: "job_done", reason: "All done." };
		// Pi order: call slot, then result slot; invalidate() redraws both.
		const running = lines(
			tool.renderCall?.(args as never, theme, context(true)) as never,
		);
		lines(tool.renderCall?.(args as never, theme, context(false)) as never);
		const body = lines(
			tool.renderResult?.(
				result as never,
				{ expanded: false, isPartial: false },
				theme,
				context(false),
			) as never,
		);
		const header = lines(
			tool.renderCall?.(args as never, theme, context(false)) as never,
		);
		// A second result render with the same outcome does not redraw again.
		tool.renderResult?.(
			result as never,
			{ expanded: false, isPartial: false },
			theme,
			context(false),
		);
		return { running, header, body, invalidations };
	};

	const unlocked = renderRow({
		content: [{ type: "text", text: "Continue watchdog unlocked · JOB_DONE" }],
		details: {
			outcome: "unlocked",
			reasonType: "JOB_DONE",
			reason: "All done.",
		},
	});
	assert.equal(unlocked.running, "Continue watchdog unlock · JOB_DONE");
	assert.equal(unlocked.header, "");
	assert.equal(
		unlocked.body,
		"Continue watchdog unlocked · JOB_DONE · All done.",
	);
	assert.equal(unlocked.invalidations, 1);

	const informational = renderRow({
		content: [{ type: "text", text: "Continue watchdog is not locked." }],
		details: { outcome: "not-locked" },
	});
	assert.equal(informational.header, "Continue watchdog unlock · JOB_DONE");

	const failed = renderRow({
		content: [{ type: "text", text: "reason_type must match" }],
		isError: true,
	});
	assert.equal(failed.header, "Continue watchdog unlock · JOB_DONE");
});
