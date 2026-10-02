import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { BUILT_IN_JEV_WAIT_CHECK } from "../src/config.js";

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
	UNLOCK_COMPLETENESS_CHECK,
	UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	UNLOCK_DELIVERY_BOUNDARY,
	UNLOCK_REASON_DESCRIPTION,
	UNLOCK_TOOL_DESCRIPTION,
	UNLOCK_TOOL_PROMPT_GUIDELINES,
	UNLOCK_TOOL_PROMPT_SNIPPET,
	type UnlockToolHost,
	unlockReasonTypeDescription,
	unlockReasonTypeEnum,
	unlockToolUserReadyValues,
	validateUnlockToolArguments,
} from "../src/unlock-tool.js";

const DEFAULT_TYPES = ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED", "WAIT_CALLBACK"];

test("tool name and description state the contract", () => {
	assert.equal(UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME, "unlock_continue_watchdog");
	assert.match(UNLOCK_TOOL_DESCRIPTION, /all requested work is complete/);
	assert.match(UNLOCK_TOOL_DESCRIPTION, /automatically continue your work/);
	assert.match(UNLOCK_TOOL_DESCRIPTION, /pi-continue-watchdog extension/);
	assert.match(UNLOCK_TOOL_DESCRIPTION, /reason_type/);
	assert.ok(UNLOCK_TOOL_DESCRIPTION.includes(UNLOCK_COMPLETENESS_CHECK));
	assert.match(
		UNLOCK_COMPLETENESS_CHECK,
		/including earlier requests and not only the latest one/,
	);
	assert.match(UNLOCK_COMPLETENESS_CHECK, /cancelled, or superseded/);
	assert.match(UNLOCK_COMPLETENESS_CHECK, /do it instead of calling this tool/);
});

test("reason_type and reason descriptions explain each value", () => {
	assert.equal(
		unlockReasonTypeDescription(DEFAULT_TYPES),
		"Why work stops: JOB_DONE = all requested work is complete; WAIT_USER = user input, approval, or other user action is required; JOB_BLOCKED = work is blocked by something other than a user action; WAIT_CALLBACK = waiting for another agent or program to call back and wake you. Matched case-insensitively after trimming.",
	);
	// Custom types are listed by name only; built-ins keep their meaning.
	assert.equal(
		unlockReasonTypeDescription(["job_done", "Needs_Review"]),
		"Why work stops: JOB_DONE = all requested work is complete; NEEDS_REVIEW. Matched case-insensitively after trimming.",
	);
	const schema = JSON.parse(
		JSON.stringify(buildUnlockToolParameters(DEFAULT_TYPES)),
	) as { properties: Record<string, { description?: string }> };
	assert.equal(
		schema.properties.reason_type.description,
		unlockReasonTypeDescription(DEFAULT_TYPES),
	);
	assert.equal(schema.properties.reason.description, UNLOCK_REASON_DESCRIPTION);
	assert.match(
		UNLOCK_REASON_DESCRIPTION,
		/what was delivered, what the user must do, or what blocks the work/,
	);
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
	assert.match(joined, /call back and wake you.*reason_type WAIT_CALLBACK/);
	assert.match(joined, /blocked without a user action/);
	assert.match(joined, /including earlier requests, is still missing/);
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
	assert.match(
		badType.error,
		/JOB_DONE, WAIT_USER, JOB_BLOCKED, WAIT_CALLBACK/,
	);

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

function reviewFixture(
	answer: unknown = {
		choice: "contradicted",
		confidence: 0.7,
		probabilities: { contradicted: 0.84 },
	},
) {
	let cycleId = 1;
	let rejections = 0;
	let locked = true;
	let fetches = 0;
	let applied = 0;
	let leaf = "stop";
	let respond = async () =>
		new Response(JSON.stringify({ answers: { stop_review: answer } }));
	const host: UnlockToolHost = {
		isCurrentMain: () => true,
		isLocked: () => locked,
		applyAiUnlock: () => {
			applied += 1;
			locked = false;
			return true;
		},
		reviewState: () => ({ cycleId, rejections }),
		recordReviewRejection: (token) =>
			token === cycleId && rejections < 3 ? ++rejections : null,
		jev: {
			config: BUILT_IN_JEV_WAIT_CHECK,
			env: { TYPESAFE_API_KEY: "test-key" },
			fetchFn: async () => {
				fetches += 1;
				return respond();
			},
		},
	};
	const tool = createUnlockToolDefinition({ reasonTypes: DEFAULT_TYPES }, host);
	const ctx = {
		sessionManager: {
			getLeafId: () => leaf,
			getBranch: () => [
				{
					type: "message",
					id: "user",
					message: { role: "user", content: "Continue without asking again" },
				},
				{
					type: "message",
					id: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "May I proceed?" }],
					},
				},
			],
		},
	};
	return {
		host,
		call: (reasonType = "WAIT_USER", signal?: AbortSignal) =>
			tool.execute(
				"review-call",
				{
					reason_type: reasonType,
					reason: "Waiting for permission to proceed",
				} as never,
				signal,
				undefined,
				ctx as never,
			),
		get fetches() {
			return fetches;
		},
		get applied() {
			return applied;
		},
		get rejections() {
			return rejections;
		},
		unlock: () => {
			locked = false;
		},
		restart: () => {
			cycleId += 1;
			rejections = 0;
		},
		navigate: () => {
			leaf = "other-branch";
		},
		respond: (fn: typeof respond) => {
			respond = fn;
		},
	};
}

test("execute: review rejects three times, fourth passes, without touching unlock early", async () => {
	const fixture = reviewFixture();
	for (let n = 1; n <= 3; n++) {
		await assert.rejects(
			fixture.call(),
			new RegExp(`Unlock refused \\(${n}/3\\)`),
		);
		assert.equal(fixture.applied, 0);
	}
	assert.equal((await fixture.call()).terminate, true);
	assert.equal(fixture.fetches, 3);
	assert.equal(fixture.rejections, 3);
	assert.equal(fixture.applied, 1);
});

test("execute: nonreviewed reasons, no key and disabled review preserve unlock", async () => {
	for (const reasonType of ["JOB_DONE", "JOB_BLOCKED", "WAIT_CALLBACK"]) {
		const fixture = reviewFixture();
		assert.equal((await fixture.call(reasonType)).terminate, true);
		assert.equal(fixture.fetches, 0);
	}
	for (const disabled of [false, true]) {
		const fixture = reviewFixture();
		assert.ok(fixture.host.jev);
		fixture.host.jev.env = {};
		if (disabled)
			fixture.host.jev.config = { ...BUILT_IN_JEV_WAIT_CHECK, enabled: false };
		assert.equal((await fixture.call()).terminate, true);
		assert.equal(fixture.fetches, 0);
	}
});

test("execute: uncertainty, probability missing and service failure accept", async () => {
	for (const answer of [
		{
			choice: "supported",
			confidence: 0.99,
			probabilities: { contradicted: 0.01 },
		},
		{
			choice: "contradicted",
			confidence: 0.99,
			probabilities: { contradicted: 0.53 },
		},
		{ choice: "contradicted", confidence: 0.99 },
		null,
	]) {
		const fixture = reviewFixture(answer);
		assert.equal((await fixture.call()).terminate, true);
		assert.equal(fixture.applied, 1);
		assert.equal(fixture.rejections, 0);
	}
	const fixture = reviewFixture();
	fixture.respond(async () => new Response("failure", { status: 500 }));
	assert.equal((await fixture.call()).terminate, true);
});

test("execute: timeout accepts once and concurrent refusals stay bounded", async () => {
	const timeout = reviewFixture();
	assert.ok(timeout.host.jev);
	timeout.host.jev.config = { ...BUILT_IN_JEV_WAIT_CHECK, timeoutMs: 20 };
	timeout.host.jev.fetchFn = (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal?.addEventListener(
				"abort",
				() => reject(new Error("timeout")),
				{ once: true },
			);
		});
	const keepAlive = setInterval(() => {}, 100);
	try {
		assert.equal((await timeout.call()).terminate, true);
	} finally {
		clearInterval(keepAlive);
	}
	const parallel = reviewFixture();
	const results = await Promise.allSettled(
		Array.from({ length: 6 }, () => parallel.call()),
	);
	assert.equal(
		results.filter((result) => result.status === "rejected").length,
		3,
	);
	assert.equal(parallel.rejections, 3);
});

test("execute: no request while unlocked and no request after stale credential lookup", async () => {
	const unlocked = reviewFixture();
	unlocked.unlock();
	assert.equal((await unlocked.call()).terminate, undefined);
	assert.equal(unlocked.fetches, 0);
	const stale = reviewFixture();
	assert.ok(stale.host.jev);
	stale.host.jev.registry = {
		async getApiKeyForProvider() {
			stale.restart();
			return "resolved-key";
		},
	};
	assert.equal((await stale.call()).terminate, undefined);
	assert.equal(stale.fetches, 0);
	assert.equal(stale.applied, 0);
});

test("execute: skipped-review async gaps cannot unlock a stale cycle, branch or cancelled call", async () => {
	for (const mode of ["cap", "disabled", "nonreviewed"] as const) {
		for (const interrupt of ["restart", "navigate", "abort"] as const) {
			const fixture = reviewFixture();
			if (mode === "cap")
				for (let n = 0; n < 3; n++)
					await assert.rejects(fixture.call(), /Unlock refused/);
			if (mode === "disabled") {
				assert.ok(fixture.host.jev);
				fixture.host.jev.config = {
					...BUILT_IN_JEV_WAIT_CHECK,
					enabled: false,
				};
			}
			const abort = new AbortController();
			const pending = fixture.call(
				mode === "nonreviewed" ? "JOB_DONE" : "WAIT_USER",
				abort.signal,
			);
			if (interrupt === "abort") abort.abort();
			else fixture[interrupt]();
			assert.equal(
				(await pending).terminate,
				undefined,
				`${mode}/${interrupt}`,
			);
			assert.equal(fixture.applied, 0, `${mode}/${interrupt}`);
			assert.equal(fixture.fetches, mode === "cap" ? 3 : 0);
		}
	}
});

test("execute: manual unlock, restart, navigation and cancellation discard verdict", async () => {
	for (const interrupt of ["unlock", "restart", "navigate", "abort"] as const) {
		const fixture = reviewFixture();
		const abort = new AbortController();
		fixture.respond(async () => {
			if (interrupt === "abort") abort.abort();
			else fixture[interrupt]();
			return new Response(
				JSON.stringify({
					answers: {
						stop_review: {
							choice: "contradicted",
							confidence: 0.9,
							probabilities: { contradicted: 0.99 },
						},
					},
				}),
			);
		});
		assert.equal(
			(await fixture.call("WAIT_USER", abort.signal)).terminate,
			undefined,
		);
		assert.equal(fixture.applied, 0);
		assert.equal(fixture.rejections, 0);
	}
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

test("unlock tool row renders through Pi's ToolExecutionComponent without duplication", () => {
	initTheme(undefined, false);
	const tool = createUnlockToolDefinition(
		{ reasonTypes: DEFAULT_TYPES },
		{
			isCurrentMain: () => true,
			isLocked: () => true,
			applyAiUnlock: () => true,
		},
	);
	const rows = (result?: {
		content: { type: "text"; text: string }[];
		details?: unknown;
		isError: boolean;
	}): string[] => {
		const row = new ToolExecutionComponent(
			UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
			"call-1",
			{ reason_type: "WAIT_USER", reason: "Need approval." },
			{},
			tool as never,
			{ requestRender() {} } as never,
			"/tmp",
		);
		row.setArgsComplete();
		row.markExecutionStarted();
		if (result !== undefined) row.updateResult(result as never, false);
		return row
			.render(160)
			.map((line) => stripVTControlCharacters(line).trim())
			.filter((line) => line.length > 0);
	};

	assert.deepEqual(rows(), ["Continue watchdog unlock · WAIT_USER"]);
	assert.deepEqual(
		rows({
			content: [
				{ type: "text", text: "Continue watchdog unlocked · WAIT_USER" },
			],
			details: {
				outcome: "unlocked",
				reasonType: "WAIT_USER",
				reason: "Need approval.",
			},
			isError: false,
		}),
		["Continue watchdog unlocked · WAIT_USER · Need approval."],
	);
	assert.deepEqual(
		rows({
			content: [{ type: "text", text: "reason_type must match" }],
			isError: true,
		}),
		["Continue watchdog unlock · WAIT_USER", "reason_type must match"],
	);
});

test("tool text states it is not a delivery channel without claiming invisibility", () => {
	assert.ok(UNLOCK_TOOL_DESCRIPTION.includes(UNLOCK_DELIVERY_BOUNDARY));
	assert.ok(
		UNLOCK_TOOL_PROMPT_GUIDELINES[0].includes(UNLOCK_DELIVERY_BOUNDARY),
	);
	assert.match(
		UNLOCK_DELIVERY_BOUNDARY,
		/only stops the automatic continuation/,
	);
	assert.match(UNLOCK_DELIVERY_BOUNDARY, /not a delivery channel/);
	assert.match(UNLOCK_DELIVERY_BOUNDARY, /normal reply text before calling it/);
	assert.match(UNLOCK_REASON_DESCRIPTION, /Not the user-facing answer/);
	assert.match(UNLOCK_REASON_DESCRIPTION, /the user may not see it/);
	for (const text of [
		UNLOCK_TOOL_DESCRIPTION,
		UNLOCK_TOOL_PROMPT_GUIDELINES[0],
		UNLOCK_REASON_DESCRIPTION,
	]) {
		assert.doesNotMatch(text, /cannot see|can't see|never see|invisible/i);
	}
});
