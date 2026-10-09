import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	type CustomMessageEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	createDecisionPromptMessage,
	DECISION_MESSAGE_TYPE,
} from "../src/context-fold.js";
import type {
	JudgeRequest,
	ReviewResult,
	ReviewService,
} from "../src/judgment-client.js";
import {
	buildUnlockReviewProjection,
	buildUnlockReviewRequest,
	discoverUnlockReviewService,
	HUMAN_QUESTIONNAIRE_TOOL,
	runUnlockReview,
	UNLOCK_REVIEW_PROJECTION_VERSION,
	UNLOCK_REVIEW_QUESTION_ID,
} from "../src/unlock-review.js";

async function fixture(
	t: TestContext,
): Promise<{ manager: SessionManager; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-cw-unlock-review-"));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	return { manager: SessionManager.create(join(dir, "s.jsonl")), dir };
}

function user(manager: SessionManager, text: string): string {
	return manager.appendMessage({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	});
}

function assistant(
	manager: SessionManager,
	text: string,
	extras: { details?: unknown; content?: unknown[] } = {},
): string {
	return manager.appendMessage({
		role: "assistant",
		content: extras.content ?? [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {},
		stopReason: "stop",
		...(extras.details === undefined ? {} : { details: extras.details }),
		timestamp: Date.now(),
	} as never);
}

function toolCallBlock(
	id: string,
	name: string,
	args: unknown,
): Record<string, unknown> {
	return { type: "toolCall", id, name, arguments: args };
}

function toolResult(
	manager: SessionManager,
	options: {
		readonly toolCallId?: string;
		readonly toolName?: string;
		readonly text?: string;
		readonly isError?: boolean;
		readonly details?: unknown;
	},
): string {
	return manager.appendMessage({
		role: "toolResult",
		toolCallId: options.toolCallId ?? "call-1",
		toolName: options.toolName ?? "read",
		content: [{ type: "text", text: options.text ?? "result body" }],
		isError: options.isError ?? false,
		...(options.details === undefined ? {} : { details: options.details }),
		timestamp: Date.now(),
	} as never);
}

const QUESTIONNAIRE_CALL = "call_abc123|fc_deadbeef";
const QUESTIONNAIRE_ARGS = {
	questions: [
		{
			header: "scope",
			question: "Deploy now?",
			multiSelect: false,
			options: [{ label: "yes" }, { label: "no" }],
		},
	],
};
const QUESTIONNAIRE_DETAILS = {
	answers: [
		{
			questionIndex: 0,
			question: "Deploy now?",
			kind: "option",
			answer: "yes",
		},
	],
	cancelled: false,
};

function decisionEntries(manager: SessionManager): void {
	const prompt = createDecisionPromptMessage({
		exchangeId: "exchange-1",
		cycleId: 1,
		decisionPrompt: "hidden watchdog decision prompt",
	});
	manager.appendCustomMessageEntry(
		DECISION_MESSAGE_TYPE,
		prompt.content,
		false,
		prompt.details,
	);
}

// ---------- projection ----------

test("macro snapshot keeps full permitted sources in order and folds owned traffic", async (t) => {
	const { manager } = await fixture(t);
	user(manager, "first request");
	assistant(manager, "first delivery report with details");
	user(manager, "second narrower instruction");
	decisionEntries(manager);
	toolResult(manager, { toolName: "read", text: "SECRET FILE BODY" });
	user(manager, "final instruction");

	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	assert.deepEqual(
		projection.rows.map((row) => row.kind),
		["user", "assistant", "user", "tool", "user"],
	);
	assert.equal(projection.rows[0]?.text, "first request");
	assert.equal(projection.rows[1]?.text, "first delivery report with details");
	assert.equal(projection.rows[2]?.text, "second narrower instruction");
	// Tool activity is an envelope: no command, arguments, or result body.
	const tool = projection.rows[3];
	assert.equal(tool?.kind, "tool");
	assert.equal(tool?.toolName, "read");
	assert.equal(tool?.status, "returned");
	assert.equal(tool?.text, "");
	assert.equal(tool?.callId, "call-1");
	// Owned decision traffic never enters the snapshot.
	assert.ok(
		projection.rows.every(
			(row) => !row.text.includes("hidden watchdog decision prompt"),
		),
	);
	assert.equal(projection.gaps.length, 0);
});

test("assistant thinking and non-text blocks are excluded; user image is an explicit gap", async (t) => {
	const { manager } = await fixture(t);
	user(manager, "look at this");
	manager.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: "and this image" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		],
		timestamp: Date.now(),
	});
	manager.appendMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private chain of thought" },
			{ type: "text", text: "public report" },
		],
		api: "test",
		provider: "test",
		model: "test",
		usage: {},
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);

	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	const kinds = projection.rows.map((row) => row.kind);
	assert.deepEqual(kinds, ["user", "user", "assistant"]);
	assert.ok(
		projection.rows.every((row) => !row.text.includes("private chain")),
	);
	assert.equal(
		projection.gaps.filter((gap) => gap.reason === "unsupported-content")
			.length,
		1,
	);
});

test("F6: ordinary user text questions and decisions remain complete in source order", async (t) => {
	const { manager } = await fixture(t);
	user(manager, "Can we deploy after verification?");
	assistant(manager, "Verification passed. Deploy now or wait?");
	user(
		manager,
		`Wait until Friday. Keep the full scope: ${"x".repeat(10_000)}`,
	);
	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	assert.deepEqual(
		projection.rows.map((row) => row.kind),
		["user", "assistant", "user"],
	);
	assert.deepEqual(
		projection.rows.map((row) => row.text),
		[
			"Can we deploy after verification?",
			"Verification passed. Deploy now or wait?",
			`Wait until Friday. Keep the full scope: ${"x".repeat(10_000)}`,
		],
	);
	assert.deepEqual(projection.gaps, []);
});

test("F6: public questionnaire replies preserve structured answers and text fallback", async (t) => {
	const { manager } = await fixture(t);
	const callEntryId = assistant(manager, "", {
		content: [
			toolCallBlock(
				QUESTIONNAIRE_CALL,
				HUMAN_QUESTIONNAIRE_TOOL,
				QUESTIONNAIRE_ARGS,
			),
		],
	});
	const resultEntryId = toolResult(manager, {
		toolCallId: QUESTIONNAIRE_CALL,
		toolName: HUMAN_QUESTIONNAIRE_TOOL,
		text: "UNRELATED_RESULT_BODY",
		details: {
			...QUESTIONNAIRE_DETAILS,
			answers: [
				...QUESTIONNAIRE_DETAILS.answers,
				{
					questionIndex: 1,
					question: "When?",
					kind: "custom",
					answer: "only on Friday",
				},
			],
			privateNotes: "UNRELATED_PRIVATE_DETAIL",
		},
	});
	// Missing structured data and a missing call do not suppress a public tool reply.
	const fallbackEntryId = toolResult(manager, {
		toolCallId: "no-retained-call",
		toolName: HUMAN_QUESTIONNAIRE_TOOL,
		text: "Public question: Continue?\nAnswer: yes.",
	});
	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	const reply = projection.rows.find((row) => row.entryId === resultEntryId);
	assert.ok(reply);
	assert.equal(reply.kind, "tool");
	assert.equal(reply.toolName, HUMAN_QUESTIONNAIRE_TOOL);
	assert.equal(reply.callId, QUESTIONNAIRE_CALL);
	assert.equal(reply.callEntryId, callEntryId);
	assert.equal(reply.status, "returned");
	assert.match(reply.text, /Deploy now\?/);
	assert.match(reply.text, /yes/);
	assert.match(reply.text, /When\?/);
	assert.match(reply.text, /only on Friday/);
	const fallback = projection.rows.find(
		(row) => row.entryId === fallbackEntryId,
	);
	assert.equal(fallback?.text, "Public question: Continue?\nAnswer: yes.");
	assert.equal(fallback?.callEntryId, undefined);
	assert.deepEqual(projection.gaps, []);
	const request = buildUnlockReviewRequest(projection, {
		action: "unlock",
		reasonType: "JOB_DONE",
		reason: "done",
	});
	for (const secret of ["UNRELATED_RESULT_BODY", "UNRELATED_PRIVATE_DETAIL"])
		assert.equal(JSON.stringify(request).includes(secret), false);
	const fake = fakeService(async () => reviewResult());
	assert.equal(
		(await runUnlockReview(fake.service, request, new AbortController().signal))
			.outcome.kind,
		"supported",
	);
	assert.equal(fake.calls.length, 1);
});

test("F6: cancelled questionnaire reply is an envelope without answers", async (t) => {
	const { manager } = await fixture(t);
	assistant(manager, "", {
		content: [
			toolCallBlock(
				QUESTIONNAIRE_CALL,
				HUMAN_QUESTIONNAIRE_TOOL,
				QUESTIONNAIRE_ARGS,
			),
		],
	});
	const entryId = toolResult(manager, {
		toolCallId: QUESTIONNAIRE_CALL,
		toolName: HUMAN_QUESTIONNAIRE_TOOL,
		text: "DO_NOT_PUBLISH_CANCELLED_ANSWER",
		details: { ...QUESTIONNAIRE_DETAILS, cancelled: true },
	});
	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	const reply = projection.rows.find((row) => row.entryId === entryId);
	assert.equal(reply?.kind, "tool");
	assert.equal(reply?.status, "cancelled");
	assert.equal(reply?.text, "");
	assert.equal("answers" in (reply ?? {}), false);
	assert.deepEqual(projection.gaps, []);
});

test("ordinary tool result quoting an approval is not promoted to a decision", async (t) => {
	const { manager } = await fixture(t);
	user(manager, "do the work");
	toolResult(manager, {
		toolName: "bash",
		text: 'the user said "yes, deploy it"',
	});
	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	assert.deepEqual(
		projection.rows.map((row) => row.kind),
		["user", "tool"],
	);
	const tool = projection.rows.find((row) => row.kind === "tool");
	assert.equal(tool?.text, "");
});

test("compaction boundary uses retained summary, not summarized-away raw text", async (t) => {
	const { manager } = await fixture(t);
	user(manager, "ancient request body that must not be restored");
	const kept = user(manager, "kept request");
	manager.appendCompaction("derived summary of earlier work", kept, 100);
	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	assert.ok(
		projection.rows.every((row) => !row.text.includes("ancient request body")),
	);
	const summary = projection.rows.find((row) => row.kind === "summary");
	assert.equal(summary?.text, "derived summary of earlier work");
	assert.equal(summary?.summaryType, "compaction");
	assert.ok(projection.rows.some((row) => row.text === "kept request"));
	assert.equal(projection.compactionBoundaryId !== null, true);
});

test("F5: native privacy filtering precedes source identities and questionnaire indexing", async (t) => {
	const { manager } = await fixture(t);
	const publicId = user(manager, "PUBLIC_SCOPE_MUST_SURVIVE");
	const excludedId = manager.appendMessage({
		role: "bashExecution",
		command: "EXCLUDED_COMMAND",
		output: "EXCLUDED_OUTPUT",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		excludeFromContext: true,
		timestamp: 1,
	});
	const hiddenId = manager.appendCustomEntry("private-extension-state", {
		body: "PRIVATE_EXTENSION_BODY",
	});
	const thinkingId = assistant(manager, "", {
		content: [{ type: "thinking", thinking: "PRIVATE_THINKING_BODY" }],
	});
	const prompt = createDecisionPromptMessage({
		exchangeId: "owned-qa",
		cycleId: 1,
		decisionPrompt: "OWNED_CONTROL_BODY",
	});
	const ownedId = assistant(manager, "", {
		details: { piInquiry: prompt.details },
		content: [
			toolCallBlock(
				"OWNED_QUESTIONNAIRE_CALL",
				HUMAN_QUESTIONNAIRE_TOOL,
				QUESTIONNAIRE_ARGS,
			),
		],
	});
	const ownedResult = toolResult(manager, {
		toolCallId: "OWNED_QUESTIONNAIRE_CALL",
		toolName: HUMAN_QUESTIONNAIRE_TOOL,
		text: "OWNED_RESULT_BODY",
		details: QUESTIONNAIRE_DETAILS,
	});
	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	const request = buildUnlockReviewRequest(projection, {
		action: "unlock",
		reasonType: "JOB_DONE",
		reason: "done",
	});
	const json = JSON.stringify(request);
	for (const secret of [
		excludedId,
		hiddenId,
		thinkingId,
		ownedId,
		ownedResult,
		"EXCLUDED_COMMAND",
		"EXCLUDED_OUTPUT",
		"PRIVATE_EXTENSION_BODY",
		"PRIVATE_THINKING_BODY",
		"OWNED_QUESTIONNAIRE_CALL",
		"OWNED_RESULT_BODY",
	])
		assert.equal(json.includes(secret), false, secret);
	assert.deepEqual(
		projection.rows.map((row) => row.entryId),
		[publicId],
	);
	assert.equal(projection.sourceHeadId, publicId);
	assert.deepEqual(projection.gaps, []);
});

test("F5: full public reports and producer labels retain ordered truthful activity envelopes", async (t) => {
	const { manager } = await fixture(t);
	user(manager, "EARLY_PUBLIC_REQUEST");
	const report = `FULL_REPORT_START${"x".repeat(10_000)}FULL_REPORT_END`;
	const callEntryId = assistant(manager, report, {
		content: [
			{ type: "text", text: report },
			toolCallBlock("ordinary-read", "read", { path: "PRIVATE_ARGUMENT_PATH" }),
		],
	});
	toolResult(manager, {
		toolCallId: "ordinary-read",
		toolName: "read",
		text: "PRIVATE_FILE_BODY",
	});
	manager.appendCustomMessageEntry(
		"public-producer-a",
		"PUBLIC_OPINION_A",
		true,
	);
	manager.appendCustomMessageEntry(
		"public-producer-b",
		"PUBLIC_OPINION_B",
		true,
	);
	for (const [exitCode, cancelled] of [
		[0, false],
		[7, false],
		[undefined, true],
		[undefined, false],
	] as const)
		manager.appendMessage({
			role: "bashExecution",
			command: "PRIVATE_SHELL_COMMAND",
			output: "PRIVATE_SHELL_OUTPUT",
			exitCode,
			cancelled,
			truncated: false,
			timestamp: 2,
		});
	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	assert.equal(
		projection.rows.find((row) => row.kind === "assistant")?.text,
		report,
	);
	const tools = projection.rows.filter((row) => row.kind === "tool");
	assert.deepEqual(
		tools.map((row) => row.status),
		["pending", "returned", "returned", "error", "cancelled", "unknown"],
	);
	assert.equal(tools[0]?.callId, "ordinary-read");
	assert.equal(tools[1]?.callId, "ordinary-read");
	assert.equal(tools[1]?.callEntryId, callEntryId);
	assert.deepEqual(
		projection.rows
			.filter((row) => row.kind === "custom")
			.map((row) => row.customType),
		["public-producer-a", "public-producer-b"],
	);
	const request = buildUnlockReviewRequest(projection, {
		action: "unlock",
		reasonType: "JOB_DONE",
		reason: "done",
	});
	const json = JSON.stringify(request);
	for (const privateBody of [
		"PRIVATE_ARGUMENT_PATH",
		"PRIVATE_FILE_BODY",
		"PRIVATE_SHELL_COMMAND",
		"PRIVATE_SHELL_OUTPUT",
	])
		assert.equal(json.includes(privateBody), false);
	assert.equal(json.split(report).length - 1, 1);
	assert.equal(request.evidence, undefined);
});

test("F5 admission: necessary gaps suppress even a valid service challenge without fake observations", async () => {
	const request = buildUnlockReviewRequest(
		{
			projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
			rows: [],
			gaps: [
				{ entryId: "public-unavailable-source", reason: "unsupported-content" },
			],
			sourceHeadId: null,
			compactionBoundaryId: null,
		},
		{ action: "unlock", reasonType: "JOB_DONE", reason: "done" },
	);
	const challenge = fakeService(async () =>
		reviewResult({
			answers: {
				[UNLOCK_REVIEW_QUESTION_ID]: {
					type: "choice",
					choice: "challenged",
					probabilities: {},
					confidence: 1,
				},
			},
		}),
	);
	const report = await runUnlockReview(
		challenge.service,
		request,
		new AbortController().signal,
	);
	assert.deepEqual(report, {
		outcome: { kind: "incomplete", reason: "insufficient-evidence" },
	});
	assert.equal(challenge.calls.length, 0);
	const empty = buildUnlockReviewRequest(
		{
			projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
			rows: [],
			gaps: [],
			sourceHeadId: null,
			compactionBoundaryId: null,
		},
		{ action: "unlock", reasonType: "JOB_DONE", reason: "done" },
	);
	const fake = fakeService(async () => reviewResult());
	assert.equal(
		(await runUnlockReview(fake.service, empty, new AbortController().signal))
			.outcome.kind,
		"supported",
	);
	assert.equal(fake.calls.length, 1);
});

// ---------- request serialization ----------

test("F4: request keeps complete ordered macro facts once in fixed state", async () => {
	const projection = {
		projectionVersion:
			UNLOCK_REVIEW_PROJECTION_VERSION as typeof UNLOCK_REVIEW_PROJECTION_VERSION,
		rows: [
			{
				index: 0,
				kind: "user" as const,
				entryId: "early",
				text: "EARLY_SCOPE_SENTINEL",
			},
			{
				index: 1,
				kind: "assistant" as const,
				entryId: "middle",
				text: `MIDDLE_DELIVERY_SENTINEL${"x".repeat(10_000)}`,
			},
			{
				index: 2,
				kind: "user" as const,
				entryId: "late",
				text: "LATE_RESTRICTION_SENTINEL",
			},
		],
		gaps: [],
		sourceHeadId: "late",
		compactionBoundaryId: null,
	};
	const candidate = {
		action: "unlock" as const,
		reasonType: "JOB_DONE",
		reason: "all delivered",
	};
	const request = buildUnlockReviewRequest(projection, candidate);
	const fixed = request.state.macroSnapshot as {
		rows: typeof projection.rows;
		sourceHeadId: string;
	};
	assert.ok(fixed, "necessary factual state must not be splittable evidence");
	assert.deepEqual(fixed.rows, projection.rows);
	assert.equal(fixed.sourceHeadId, "late");
	assert.equal(request.evidence, undefined);
	assert.ok(JSON.stringify(request.state).length > 8_000);
	for (const row of projection.rows)
		assert.equal(JSON.stringify(request).split(row.text).length - 1, 1);
	assert.deepEqual(
		buildUnlockReviewRequest(structuredClone(projection), candidate),
		request,
	);
	for (const changed of [
		{
			...projection,
			rows: projection.rows.map((row) =>
				row.index === 1 ? { ...row, text: "Different delivery" } : row,
			),
		},
		{
			...projection,
			rows: projection.rows.map((row) =>
				row.index === 1 ? { ...row, entryId: "different-origin" } : row,
			),
		},
		{ ...projection, rows: projection.rows.toReversed() },
		{ ...projection, compactionBoundaryId: "summary-boundary" },
	])
		assert.notDeepEqual(buildUnlockReviewRequest(changed, candidate), request);
});

test("request carries labelled candidate, rubric, fixed rows and gaps", async (t) => {
	const { manager } = await fixture(t);
	user(manager, "build the feature");
	assistant(manager, "feature delivered and verified");
	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	const request = buildUnlockReviewRequest(projection, {
		action: "unlock",
		reasonType: "JOB_DONE",
		reason: "all delivered",
	});
	assert.equal(
		request.state.projectionVersion,
		UNLOCK_REVIEW_PROJECTION_VERSION,
	);
	const candidate = request.state.candidate as Record<string, unknown>;
	assert.equal(candidate.action, "unlock");
	assert.equal(candidate.reasonType, "JOB_DONE");
	assert.equal(candidate.reason, "all delivered");
	const question = request.questions[UNLOCK_REVIEW_QUESTION_ID];
	assert.equal(question?.type, "choice");
	assert.deepEqual(
		question.type === "choice" ? Object.keys(question.criteria) : [],
		["supported", "challenged", "insufficient_evidence"],
	);
	const fixed = request.state.macroSnapshot as {
		rows: { index: number; kind: string; entryId: string; text: string }[];
	};
	assert.equal(request.evidence, undefined);
	assert.equal(fixed.rows.length, 2);
	assert.equal(fixed.rows[0]?.entryId, projection.rows[0]?.entryId);
	assert.equal(fixed.rows[0]?.text, "build the feature");
	// Changing the candidate changes the factual input identity.
	const other = buildUnlockReviewRequest(projection, {
		action: "unlock",
		reasonType: "WAIT_USER",
		reason: "needs user",
	});
	assert.notDeepEqual(other.state, request.state);
});

// ---------- discovery ----------

test("discovery is absent/incompatible/available without probes", async (t) => {
	const key = Symbol.for("pi-llm-as-jev:service");
	const globals = globalThis as Record<symbol, unknown>;
	const previous = globals[key];
	t.after(() => {
		if (previous === undefined) delete globals[key];
		else globals[key] = previous;
	});
	delete globals[key];
	assert.equal(discoverUnlockReviewService().status, "unavailable");
	globals[key] = { version: 1, judge: async () => ({}) };
	assert.equal(discoverUnlockReviewService().status, "incompatible");
	const service: ReviewService = {
		version: 1,
		reviewVersion: 1,
		judge: async () => {
			throw new Error("unexpected");
		},
		availability: async () => ({}),
		review: async () => ({}) as never,
	};
	globals[key] = service;
	const found = discoverUnlockReviewService();
	assert.equal(found.status, "available");
	if (found.status === "available") assert.equal(found.service, service);
});

// ---------- review outcomes ----------

function reviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
	return {
		answers: {
			[UNLOCK_REVIEW_QUESTION_ID]: {
				type: "choice",
				choice: "supported",
				probabilities: {},
				confidence: 1,
			},
		},
		dropped: [],
		backend: "classifier",
		model: "typesafe/jev-1.13",
		stopReason: "stop",
		reuse: { hits: 0, joined: 0, sent: 1 },
		progress: { stages: [] },
		diagnostics: {
			attempts: [
				{
					id: "fixture#1",
					ordinal: 1,
					phase: "end",
					outcome: "response",
					inputTokens: 10,
					outputTokens: 5,
					costUsd: 0.001,
				},
			],
			attemptCount: 1,
			usage: {
				inputTokens: { knownSum: 10, missing: 0 },
				outputTokens: { knownSum: 5, missing: 0 },
				costUsd: { knownSum: 0.001, missing: 0 },
			},
			observationCoverage: "complete",
		},
		unresolved: [],
		...overrides,
	};
}

function fakeService(
	handler: (
		req: JudgeRequest,
		opts: { signal?: AbortSignal },
	) => Promise<ReviewResult>,
): {
	service: ReviewService;
	calls: JudgeRequest[];
	signals: (AbortSignal | undefined)[];
} {
	const calls: JudgeRequest[] = [];
	const signals: (AbortSignal | undefined)[] = [];
	return {
		calls,
		signals,
		service: {
			version: 1,
			reviewVersion: 1,
			judge: async () => {
				throw new Error("judge must not be called");
			},
			availability: async () => {
				throw new Error("availability probe must not be called");
			},
			review: async (req, opts) => {
				calls.push(req);
				signals.push(opts?.signal);
				return handler(req, opts ?? {});
			},
		},
	};
}

test("supported and challenged map to outcomes; signal is forwarded, no timeoutMs", async () => {
	const { service, calls, signals } = fakeService(async () => reviewResult());
	const controller = new AbortController();
	const request = buildUnlockReviewRequest(
		{
			projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
			rows: [],
			gaps: [],
			sourceHeadId: null,
			compactionBoundaryId: null,
		},
		{ action: "unlock", reasonType: "JOB_DONE", reason: "done" },
	);
	const report = await runUnlockReview(service, request, controller.signal);
	assert.equal(report.outcome.kind, "supported");
	assert.equal(report.backend, "classifier");
	assert.equal(report.model, "typesafe/jev-1.13");
	assert.equal(report.attemptCount, 1);
	assert.equal(calls.length, 1);
	assert.equal(signals[0], controller.signal);
	assert.ok(!("timeoutMs" in (calls[0] as unknown as Record<string, unknown>)));

	const challenged = fakeService(async () =>
		reviewResult({
			answers: {
				[UNLOCK_REVIEW_QUESTION_ID]: {
					type: "choice",
					choice: "challenged",
					probabilities: {},
					confidence: 1,
				},
			},
		}),
	);
	const report2 = await runUnlockReview(
		challenged.service,
		request,
		new AbortController().signal,
	);
	assert.equal(report2.outcome.kind, "challenged");
});

test("error, aborted, insufficient, malformed, unresolved and unobserved are incomplete", async () => {
	const request = buildUnlockReviewRequest(
		{
			projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
			rows: [],
			gaps: [],
			sourceHeadId: null,
			compactionBoundaryId: null,
		},
		{ action: "unlock", reasonType: "JOB_DONE", reason: "done" },
	);
	const run = async (result: Partial<ReviewResult>) => {
		const { service } = fakeService(async () => reviewResult(result));
		return runUnlockReview(service, request, new AbortController().signal);
	};
	assert.equal(
		(await run({ stopReason: "error", errorMessage: "timeout", answers: {} }))
			.outcome.kind,
		"incomplete",
	);
	const aborted = await run({ stopReason: "aborted", answers: {} });
	assert.equal(aborted.outcome.kind, "incomplete");
	if (aborted.outcome.kind === "incomplete")
		assert.equal(aborted.outcome.reason, "aborted");
	const insufficient = await run({
		answers: {
			[UNLOCK_REVIEW_QUESTION_ID]: {
				type: "choice",
				choice: "insufficient_evidence",
				probabilities: {},
				confidence: 1,
			},
		},
	});
	assert.equal(insufficient.outcome.kind, "incomplete");
	if (insufficient.outcome.kind === "incomplete")
		assert.equal(insufficient.outcome.reason, "insufficient-evidence");
	assert.equal((await run({ answers: {} })).outcome.kind, "incomplete");
	const unresolved = await run({
		unresolved: [UNLOCK_REVIEW_QUESTION_ID],
		answers: {},
	});
	if (unresolved.outcome.kind === "incomplete")
		assert.equal(unresolved.outcome.reason, "unresolved");
	const unobserved = await run({
		diagnostics: {
			attempts: [],
			attemptCount: 0,
			usage: {
				inputTokens: { knownSum: 0, missing: 1 },
				outputTokens: { knownSum: 0, missing: 1 },
				costUsd: { knownSum: 0, missing: 1 },
			},
			observationCoverage: "unavailable",
		},
	});
	if (unobserved.outcome.kind === "incomplete")
		assert.equal(unobserved.outcome.reason, "unobserved");
	const thrown = fakeService(async () => {
		throw new Error("boom");
	});
	const report = await runUnlockReview(
		thrown.service,
		request,
		new AbortController().signal,
	);
	assert.equal(report.outcome.kind, "incomplete");
});

test("missing usage is not reported as zero cost", async () => {
	const { service } = fakeService(async () =>
		reviewResult({
			diagnostics: {
				attempts: [
					{ id: "fixture#1", ordinal: 1, phase: "end", outcome: "response" },
					{ id: "fixture#2", ordinal: 2, phase: "end", outcome: "response" },
				],
				attemptCount: 2,
				usage: {
					inputTokens: { knownSum: 0, missing: 2 },
					outputTokens: { knownSum: 0, missing: 2 },
					costUsd: { knownSum: 0, missing: 2 },
				},
				observationCoverage: "complete",
			},
		}),
	);
	const report = await runUnlockReview(
		service,
		buildUnlockReviewRequest(
			{
				projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
				rows: [],
				gaps: [],
				sourceHeadId: null,
				compactionBoundaryId: null,
			},
			{ action: "unlock", reasonType: "JOB_DONE", reason: "done" },
		),
		new AbortController().signal,
	);
	assert.equal(report.usage?.missing, 6);
	assert.equal(report.attemptCount, 2);
});

test("F7: malformed result and missing observation capability never reject or authorize", async () => {
	const accepted = reviewResult({
		answers: {
			[UNLOCK_REVIEW_QUESTION_ID]: {
				type: "choice",
				choice: "challenged",
				probabilities: {},
				confidence: 1,
			},
		},
	});
	const cases: unknown[] = [
		null,
		7,
		"result",
		[],
		{},
		{ ...accepted, stopReason: undefined },
		{ ...accepted, stopReason: "unknown" },
		{ ...accepted, unresolved: undefined },
		{ ...accepted, unresolved: null },
		{ ...accepted, unresolved: "none" },
		{ ...accepted, unresolved: [7] },
		{ ...accepted, unresolved: new Array(1) },
		{ ...accepted, answers: null },
		{ ...accepted, answers: {} },
		{
			...accepted,
			answers: {
				[UNLOCK_REVIEW_QUESTION_ID]: { type: "choice", choice: "unknown" },
			},
		},
		{ ...accepted, unresolved: [UNLOCK_REVIEW_QUESTION_ID] },
		{ ...accepted, contextOverflow: true },
		{ ...accepted, answers: [] },
		{ ...accepted, answers: { [UNLOCK_REVIEW_QUESTION_ID]: null } },
		{ ...accepted, diagnostics: undefined },
		{ ...accepted, diagnostics: null },
		{ ...accepted, diagnostics: 3 },
		{ ...accepted, diagnostics: { ...accepted.diagnostics, attemptCount: -1 } },
		{
			...accepted,
			diagnostics: { ...accepted.diagnostics, observationCoverage: undefined },
		},
		{
			...accepted,
			diagnostics: { ...accepted.diagnostics, observationCoverage: "partial" },
		},
		{ ...accepted, diagnostics: { ...accepted.diagnostics, usage: null } },
		{ ...accepted, diagnostics: { ...accepted.diagnostics, usage: {} } },
		{
			...accepted,
			diagnostics: {
				...accepted.diagnostics,
				usage: {
					...accepted.diagnostics.usage,
					inputTokens: { knownSum: "10", missing: 0 },
				},
			},
		},
		{
			...accepted,
			diagnostics: {
				...accepted.diagnostics,
				usage: {
					...accepted.diagnostics.usage,
					costUsd: { knownSum: Number.NaN, missing: 0 },
				},
			},
		},
	];
	const request = buildUnlockReviewRequest(
		{
			projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
			rows: [],
			gaps: [],
			sourceHeadId: null,
			compactionBoundaryId: null,
		},
		{ action: "unlock", reasonType: "JOB_DONE", reason: "done" },
	);
	for (const value of cases) {
		const fake = fakeService(async () => value as ReviewResult);
		const report = await runUnlockReview(
			fake.service,
			request,
			new AbortController().signal,
		);
		assert.equal(
			report.outcome.kind,
			"incomplete",
			`payload ${JSON.stringify(value)}`,
		);
		assert.equal(fake.calls.length, 1);
	}
	const throwing = {
		...accepted,
		get unresolved(): string[] {
			throw new Error("decode getter failed");
		},
	};
	assert.equal(
		(
			await runUnlockReview(
				fakeService(async () => throwing).service,
				request,
				new AbortController().signal,
			)
		).outcome.kind,
		"incomplete",
	);
});

test("F7: affirmative observation permits cache-hit zero and leaves absent accounting unknown", async () => {
	const request = buildUnlockReviewRequest(
		{
			projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
			rows: [],
			gaps: [],
			sourceHeadId: null,
			compactionBoundaryId: null,
		},
		{ action: "unlock", reasonType: "JOB_DONE", reason: "done" },
	);
	const zero = reviewResult({
		reuse: { hits: 1, joined: 0, sent: 0 },
		diagnostics: {
			attempts: [],
			attemptCount: 0,
			observationCoverage: "complete",
			usage: {
				inputTokens: { knownSum: 0, missing: 0 },
				outputTokens: { knownSum: 0, missing: 0 },
				costUsd: { knownSum: 0, missing: 0 },
			},
		},
	});
	const cache = await runUnlockReview(
		fakeService(async () => zero).service,
		request,
		new AbortController().signal,
	);
	assert.equal(cache.outcome.kind, "supported");
	assert.equal(cache.attemptCount, 0);
	const absent = {
		...zero,
		diagnostics: { observationCoverage: "complete" },
	} as ReviewResult;
	const unknown = await runUnlockReview(
		fakeService(async () => absent).service,
		request,
		new AbortController().signal,
	);
	assert.equal(unknown.outcome.kind, "supported");
	assert.equal(unknown.attemptCount, undefined);
	assert.equal(unknown.usage, undefined);
	const nativeAccepted = {
		...zero,
		answers: {
			[UNLOCK_REVIEW_QUESTION_ID]: {
				type: "choice" as const,
				choice: "supported",
				confidence: 0,
				probabilities: {},
			},
		},
	};
	assert.equal(
		(
			await runUnlockReview(
				fakeService(async () => nativeAccepted).service,
				request,
				new AbortController().signal,
			)
		).outcome.kind,
		"supported",
	);
});

test("F4: bounded offline capacity fixture receives whole fixed state or returns incomplete", async () => {
	const request = buildUnlockReviewRequest(
		{
			projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
			rows: [
				{
					index: 0,
					kind: "user",
					entryId: "scope",
					text: `ALL_FIXED_FACTS${"y".repeat(9_000)}`,
				},
			],
			gaps: [],
			sourceHeadId: "scope",
			compactionBoundaryId: null,
		},
		{ action: "unlock", reasonType: "JOB_DONE", reason: "done" },
	);
	const fixedBytes = Buffer.byteLength(JSON.stringify(request.state), "utf8");
	for (const capacity of [fixedBytes, fixedBytes - 1]) {
		const transports: JudgeRequest["state"][] = [];
		const fake = fakeService(async (actual, opts) => {
			assert.deepEqual(actual, request);
			assert.equal(actual.evidence, undefined);
			assert.ok(JSON.stringify(actual.state).includes("ALL_FIXED_FACTS"));
			assert.deepEqual(Object.keys(opts), ["signal"]);
			// Contract stub, not sealed shared-engine or transport integration.
			if (Buffer.byteLength(JSON.stringify(actual.state), "utf8") > capacity) {
				return reviewResult({
					stopReason: "error",
					answers: {},
					contextOverflow: true,
					errorMessage: "Fixed state cannot fit fixture capacity",
					diagnostics: {
						attempts: [],
						attemptCount: 0,
						observationCoverage: "complete",
						usage: {
							inputTokens: { knownSum: 0, missing: 0 },
							outputTokens: { knownSum: 0, missing: 0 },
							costUsd: { knownSum: 0, missing: 0 },
						},
					},
				});
			}
			transports.push(actual.state);
			return reviewResult();
		});
		const report = await runUnlockReview(
			fake.service,
			request,
			new AbortController().signal,
		);
		const fits = capacity >= fixedBytes;
		assert.equal(report.outcome.kind, fits ? "supported" : "incomplete");
		assert.equal(fake.calls.length, 1);
		assert.equal(transports.length, fits ? 1 : 0);
		if (fits) assert.deepEqual(transports[0], request.state);
		else assert.equal(report.contextOverflow, true);
	}
});

// ---------- CustomMessageEntry typing guard ----------

test("custom_message entries project as custom rows", async (t) => {
	const { manager } = await fixture(t);
	manager.appendCustomMessageEntry(
		"other-extension:note",
		"public extension note",
		true,
		{ some: "details" },
	);
	const projection = buildUnlockReviewProjection(manager.buildContextEntries());
	const row = projection.rows.find((entry) => entry.kind === "custom");
	assert.equal(row?.text, "public extension note");
	void (0 as unknown as CustomMessageEntry);
});
