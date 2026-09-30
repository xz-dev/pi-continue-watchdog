import assert from "node:assert/strict";
import test from "node:test";

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
