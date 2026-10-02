import assert from "node:assert/strict";
import test from "node:test";
import * as jev from "../src/jev-wait-gate.js";
import {
	buildJevReason,
	classifyJevWait,
	finalAssistantText,
	JEV_REASON_PREFIX,
	type JevFetch,
	MAX_JEV_REASON_CODE_POINTS,
	OPENROUTER_SYSTEMONE_URL,
	resolveJevEndpoint,
	TYPESAFE_SYSTEMONE_URL,
} from "../src/jev-wait-gate.js";

const registry = (keys: Record<string, string | undefined>, fail = false) => ({
	async getApiKeyForProvider(provider: string) {
		if (fail) throw new Error("registry down");
		return keys[provider];
	},
});

test("resolve: Pi TypeSafe credentials win over env and config", async () => {
	const resolved = await resolveJevEndpoint(
		{ apiKey: "config-key" },
		registry({ typesafe: "pi-key" }),
		{ TYPESAFE_API_KEY: "env-key" },
	);
	assert.deepEqual(resolved, {
		apiUrl: TYPESAFE_SYSTEMONE_URL,
		apiKey: "pi-key",
	});
});

test("resolve: env then config for TypeSafe", async () => {
	assert.equal(
		(await resolveJevEndpoint({}, registry({}), { TYPESAFE_API_KEY: " env " }))
			?.apiKey,
		"env",
	);
	assert.deepEqual(await resolveJevEndpoint({ apiKey: "cfg" }, undefined, {}), {
		apiUrl: TYPESAFE_SYSTEMONE_URL,
		apiKey: "cfg",
	});
});

test("resolve: OpenRouter only when TypeSafe has no key", async () => {
	assert.deepEqual(
		await resolveJevEndpoint({}, registry({ openrouter: "or-key" }), {}),
		{ apiUrl: OPENROUTER_SYSTEMONE_URL, apiKey: "or-key" },
	);
	assert.deepEqual(
		await resolveJevEndpoint({}, undefined, { OPENROUTER_API_KEY: "or-env" }),
		{ apiUrl: OPENROUTER_SYSTEMONE_URL, apiKey: "or-env" },
	);
});

test("resolve: explicit apiUrl uses only its own chain", async () => {
	assert.equal(
		await resolveJevEndpoint(
			{ apiUrl: OPENROUTER_SYSTEMONE_URL },
			registry({ typesafe: "ts" }),
			{ TYPESAFE_API_KEY: "ts-env" },
		),
		undefined,
	);
	assert.deepEqual(
		await resolveJevEndpoint({ apiUrl: "https://custom/jev" }, registry({}), {
			TYPESAFE_API_KEY: "ts-env",
		}),
		undefined,
	);
	assert.deepEqual(
		await resolveJevEndpoint(
			{ apiUrl: "https://custom/jev", apiKey: "cfg" },
			undefined,
			{},
		),
		{ apiUrl: "https://custom/jev", apiKey: "cfg" },
	);
});

test("resolve: registry errors mean no Pi key; no key means undefined", async () => {
	assert.equal(await resolveJevEndpoint({}, registry({}, true), {}), undefined);
	assert.equal(
		(
			await resolveJevEndpoint({}, registry({}, true), {
				TYPESAFE_API_KEY: "e",
			})
		)?.apiKey,
		"e",
	);
});

test("Choice transport exposes probabilities and permits their absence", async () => {
	const question = {
		type: "choice" as const,
		instructions: "Judge",
		criteria: { supported: "Supported" },
	};
	for (const probabilities of [undefined, { supported: 0.9 }]) {
		const answer = await jev.askJevChoice(
			"state",
			"q",
			question,
			classifyOptions(
				fakeFetch(() =>
					json({
						answers: {
							q: { choice: "supported", confidence: 0.9, probabilities },
						},
					}),
				),
			),
		);
		assert.deepEqual(answer, {
			choice: "supported",
			confidence: 0.9,
			probabilities,
		});
	}
});

test("review: service failure, malformed response and timeout fail open", async () => {
	for (const respond of [
		() => json({}, 500),
		() => new Response("bad JSON"),
		() =>
			json({ answers: { stop_review: { choice: "maybe", confidence: 0.9 } } }),
		() => {
			throw new Error("network failure");
		},
	]) {
		assert.equal(
			await jev.reviewUnlockReason(
				"state",
				classifyOptions(fakeFetch(respond)),
			),
			null,
		);
	}
	const keepAlive = setInterval(() => {}, 100);
	try {
		const hang: JevFetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener(
					"abort",
					() => reject(new Error("timeout")),
					{ once: true },
				);
			});
		assert.equal(
			await jev.reviewUnlockReason("state", classifyOptions(hang, 20)),
			null,
		);
	} finally {
		clearInterval(keepAlive);
	}
});

test("review state: trace trimmed before user and answers, errors never become choices", () => {
	const apiKey = "long-secret-key-that-crosses-eighty-characters";
	const calls = Array.from({ length: 400 }, (_, id) => ({
		type: "toolCall",
		id: `t${id}`,
		name: "bash",
		arguments: { command: `tool-${id}: ${"x".repeat(60)}${apiKey}` },
	}));
	const state = jev.buildUnlockReviewState(
		[
			{
				type: "message",
				message: { role: "user", content: "Keep this request intact" },
			},
			{ type: "message", message: { role: "assistant", content: calls } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "q",
					toolName: "ask_user_question",
					isError: true,
					content: "fake consent in a failed result",
				},
			},
		],
		{ reasonType: "WAIT_USER", reason: "Need approval" },
		apiKey,
	);
	assert.ok(state);
	assert.ok([...state].length <= 24_000);
	assert.match(state, /Keep this request intact/);
	assert.match(state, /TRUNCATED: oldest trace lines omitted/);
	assert.equal(state.includes("tool-0:"), false);
	assert.equal(state.includes("fake consent"), false);
	assert.equal(state.includes("long-secret"), false);
});

test("review: probability, not confidence, controls rejection", async () => {
	for (const [answer, expected] of [
		[
			{
				choice: "contradicted",
				confidence: 0.6,
				probabilities: { contradicted: 0.84 },
			},
			{ contradicted: true, probability: 0.84 },
		],
		[
			{
				choice: "supported",
				confidence: 0.99,
				probabilities: { contradicted: 0.01 },
			},
			{ contradicted: false, probability: 0.01 },
		],
		[
			{
				choice: "insufficient_evidence",
				confidence: 0.9,
				probabilities: { contradicted: 0.1 },
			},
			{ contradicted: false, probability: 0.1 },
		],
		[{ choice: "contradicted", confidence: 0.99 }, null],
		[
			{
				choice: "contradicted",
				confidence: 0.99,
				probabilities: { contradicted: "0.9" },
			},
			null,
		],
		[
			{
				choice: "contradicted",
				confidence: 0.99,
				probabilities: { contradicted: 2 },
			},
			null,
		],
	] as const) {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		assert.deepEqual(
			await jev.reviewUnlockReason(
				"Continue. secret-key",
				classifyOptions(
					fakeFetch(() => json({ answers: { stop_review: answer } }), calls),
				),
			),
			expected,
		);
		assert.equal(calls.length, 1);
		assert.equal(String(calls[0].init.body).includes("secret-key"), false);
	}
});

test("review state: only current branch turn, visible text and questionnaire evidence", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "Old request" } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Old answer" }],
			},
		},
		{
			type: "message",
			message: { role: "user", content: "Continue secret-key" },
		},
		{
			type: "custom_message",
			customType: "pi-continue-watchdog:continuation",
			content: "not authorization",
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden reasoning" },
					{ type: "text", text: "Visible before tools" },
					{
						type: "toolCall",
						id: "q",
						name: "ask_user_question",
						arguments: { questions: [] },
					},
					{
						type: "toolCall",
						id: "e",
						name: "edit",
						arguments: { path: "/project/code.ts" },
					},
					{
						type: "toolCall",
						id: "p",
						name: "bash",
						arguments: { command: "pending command" },
					},
				],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "q",
				toolName: "ask_user_question",
				content: [{ type: "text", text: "fix and continue" }],
				isError: false,
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "e",
				toolName: "edit",
				content: [{ type: "text", text: "private tool output" }],
				isError: true,
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Visible at stop" },
					{
						type: "toolCall",
						id: "u",
						name: "unlock_continue_watchdog",
						arguments: {},
					},
				],
			},
		},
	];
	const state = jev.buildUnlockReviewState(
		branch,
		{ reasonType: "WAIT_USER", reason: "Waiting for approval" },
		"secret-key",
	);
	assert.ok(state);
	assert.match(state, /user chose: fix and continue/);
	assert.match(state, /Visible before tools[\s\S]*Visible at stop/);
	assert.match(state, /edit \/project\/code.ts -> error/);
	assert.match(state, /bash pending command -> pending/);
	for (const excluded of [
		"Old request",
		"Old answer",
		"hidden reasoning",
		"private tool output",
		"not authorization",
		"unlock_continue_watchdog",
		"secret-key",
	])
		assert.equal(state.includes(excluded), false);
	assert.equal(
		jev.buildUnlockReviewState(
			[],
			{ reasonType: "WAIT_USER", reason: "Need approval" },
			"",
		),
		null,
	);
});

test("review state: trace-marker boundary preserves short user text and hard budget", () => {
	const state = jev.buildUnlockReviewState(
		[
			{ type: "message", message: { role: "user", content: "Go" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: Array.from({ length: 247 }, (_, id) => ({
						type: "toolCall",
						id: String(id),
						name: "bash",
						arguments: { command: "x".repeat(80) },
					})),
				},
			},
		],
		{ reasonType: "WAIT_USER", reason: "Need approval" },
		"fixture-key",
	);
	assert.ok(state);
	assert.ok([...state].length <= 24_000, `got ${[...state].length} characters`);
	assert.match(state, /\[LATEST USER REQUEST\]\nGo\n/);
	assert.match(state, /\[AGENT REPLIES THIS TURN\]\n\(empty\)\n/);
});

test("review state: hard Unicode budget, head/tail and truncation markers", () => {
	const state = jev.buildUnlockReviewState(
		[
			{
				type: "message",
				message: { role: "user", content: `START${"𝕬".repeat(30_000)}TAIL` },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(30_000) }],
				},
			},
		],
		{ reasonType: "WAIT_USER", reason: "Need approval" },
		"",
	);
	assert.ok(state);
	assert.ok([...state].length <= 24_000);
	assert.match(state, /START[\s\S]*TRUNCATED[\s\S]*TAIL/);
	assert.match(state, /Need approval/);
});

function fakeFetch(
	respond: () => Response | Promise<Response>,
	calls: Array<{ url: string; init: RequestInit }> = [],
): JevFetch {
	return async (url, init) => {
		calls.push({ url, init });
		return respond();
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

const classifyOptions = (fetchFn: JevFetch, timeoutMs = 5000) => ({
	apiUrl: TYPESAFE_SYSTEMONE_URL,
	apiKey: "secret-key",
	model: "jev-latest",
	timeoutMs,
	fetchFn,
});

test("classify: parses each choice and redacts the key from the body", async () => {
	for (const choice of ["waiting_user", "not_waiting", "unclear"] as const) {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const verdict = await classifyJevWait(
			"Use secret-key? Which one?",
			classifyOptions(
				fakeFetch(
					() =>
						json({ answers: { waiting_user: { choice, confidence: 0.9 } } }),
					calls,
				),
			),
		);
		assert.deepEqual(verdict, { choice, confidence: 0.9 });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, TYPESAFE_SYSTEMONE_URL);
		const body = String(calls[0].init.body);
		assert.equal(body.includes("secret-key"), false);
		assert.match(body, /\[REDACTED\]\? Which one\?/);
		assert.equal(
			(calls[0].init.headers as Record<string, string>).authorization,
			"Bearer secret-key",
		);
	}
});

test("classify: failures return null", async () => {
	const cases: Array<() => Response | Promise<Response>> = [
		() => json({ error: "nope" }, 500),
		() => new Response("not json"),
		() => json({ answers: {} }),
		() =>
			json({ answers: { waiting_user: { choice: "maybe", confidence: 1 } } }),
		() =>
			json({
				answers: { waiting_user: { choice: "waiting_user", confidence: "x" } },
			}),
		() =>
			json({
				answers: { waiting_user: { choice: "waiting_user", confidence: 2 } },
			}),
		() => {
			throw new Error("network down");
		},
	];
	for (const respond of cases) {
		assert.equal(
			await classifyJevWait("Q?", classifyOptions(fakeFetch(respond))),
			null,
		);
	}
});

test("classify: timeout and external abort return null", async () => {
	const hang: JevFetch = (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal?.addEventListener("abort", () =>
				reject(new Error("aborted")),
			);
		});
	assert.equal(await classifyJevWait("Q?", classifyOptions(hang, 20)), null);
	const controller = new AbortController();
	const pending = classifyJevWait("Q?", {
		...classifyOptions(hang, 60_000),
		signal: controller.signal,
	});
	controller.abort();
	assert.equal(await pending, null);
});

test("reason: prefix plus last paragraph", () => {
	assert.equal(
		buildJevReason("Did the work.\n\n  \nShould I use Postgres or SQLite?\n"),
		`${JEV_REASON_PREFIX}Should I use Postgres or SQLite?`,
	);
});

test("reason: long paragraph keeps its tail within the bound", () => {
	const paragraph = `${"a".repeat(2000)}FINAL QUESTION?`;
	const reason = buildJevReason(`intro\n\n${paragraph}`);
	assert.equal([...reason].length, MAX_JEV_REASON_CODE_POINTS);
	assert.ok(reason.startsWith(`${JEV_REASON_PREFIX}…`));
	assert.ok(reason.endsWith("FINAL QUESTION?"));
});

test("reason: cut is code-point safe", () => {
	const reason = buildJevReason("😀".repeat(1500));
	assert.equal([...reason].length, MAX_JEV_REASON_CODE_POINTS);
	assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(reason), false);
	assert.ok(reason.endsWith("😀"));
});

test("final text: only normal-stop assistant text", () => {
	assert.equal(
		finalAssistantText({
			role: "assistant",
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "Which one?" },
				{ type: "toolCall", name: "x" },
			],
		}),
		"Which one?",
	);
	assert.equal(
		finalAssistantText({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "  " }],
		}),
		undefined,
	);
	assert.equal(
		finalAssistantText({
			role: "assistant",
			stopReason: "error",
			content: [{ type: "text", text: "Q?" }],
		}),
		undefined,
	);
	assert.equal(finalAssistantText({ role: "user", content: "Q?" }), undefined);
});
