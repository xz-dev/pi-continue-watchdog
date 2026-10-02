import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUILT_IN_CONFIG, BUILT_IN_JEV_WAIT_CHECK } from "../../src/config.js";
import { createLockDecisionController } from "../../src/controller.js";
import { createContinueWatchdogExtension } from "../../src/extension.js";
import { createObservableAgentHub } from "../../src/hub.js";

/** Actual Pi tool-error follow-up, isolated from personal extensions and files. */
test("Pi SDK: refused WAIT_USER follows up and executes the authorized work", {
	timeout: 60_000,
}, async () => {
	const root = await mkdtemp("/var/tmp/watchdog-unlock-review-");
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const requests: unknown[] = [];
	const toolResults: Array<{
		toolName: string;
		isError: boolean;
		text: string;
	}> = [];
	const hooks: unknown[] = [];
	let reviewCalls = 0;
	let workDone = false;
	const live = process.env.WATCHDOG_LIVE_JEV_SMOKE === "1";
	const config = {
		...BUILT_IN_CONFIG,
		unlockShortcut: false as const,
		jevWaitCheck: {
			...BUILT_IN_JEV_WAIT_CHECK,
			apiUrl: live
				? "https://api.typesafe.ai/v1/systemone"
				: "http://127.0.0.1/jev",
			apiKey: live ? undefined : "fixture-key",
		},
	};
	const controller = createLockDecisionController(config);
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			requests.push(JSON.parse(body));
			const n = requests.length;
			const name =
				n === 2 ? "perform_authorized_work" : "unlock_continue_watchdog";
			const args =
				n === 1
					? {
							reason_type: "WAIT_USER",
							reason:
								"I need the user to authorize implementing the approved change",
						}
					: n === 2
						? {}
						: n === 3
							? {
									reason_type: "JOB_DONE",
									reason: "Authorized work is delivered",
								}
							: {
									reason_type: "WAIT_USER",
									reason:
										"The user must choose between Postgres and SQLite before I can proceed",
								};
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunks = [
				{
					id: `reply-${n}`,
					model: "review-smoke",
					choices: [
						{
							index: 0,
							delta: {
								content:
									n === 1
										? "May I start implementing the already approved change?"
										: n === 4
											? "Should I use Postgres or SQLite?"
											: "",
								tool_calls: [
									{
										index: 0,
										id: `call-${n}`,
										type: "function",
										function: { name, arguments: JSON.stringify(args) },
									},
								],
							},
							finish_reason: null,
						},
					],
				},
				{
					id: `reply-${n}`,
					model: "review-smoke",
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				},
			];
			for (const chunk of chunks)
				response.write(`data: ${JSON.stringify(chunk)}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const modelRuntime = await ModelRuntime.create({
		authPath: live ? undefined : join(root, "auth.json"),
		modelsPath: null,
	});
	if (live) {
		// modelsPath:null intentionally disables personal provider definitions.
		// Register only the provider identity; authentication remains the existing
		// credential through Pi's production ModelRegistry lookup (no key copy).
		modelRuntime.registerProvider("typesafe", {
			baseUrl: "https://api.typesafe.ai/v1",
			api: "openai-completions",
			models: [
				{
					id: "jev-latest",
					name: "Jev",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32_000,
					maxTokens: 512,
				},
			],
		});
	}
	modelRuntime.registerProvider("review-smoke", {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		apiKey: "local-fixture-only",
		api: "openai-completions",
		models: [
			{
				id: "review-smoke",
				name: "review-smoke",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 512,
			},
		],
	});
	const model = modelRuntime.getModel("review-smoke", "review-smoke");
	assert.ok(model);
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				createContinueWatchdogExtension({
					hub: createObservableAgentHub(),
					controller,
					config,
				})(pi);
				pi.events.on("pi:semantic-hook:v1", (event) => hooks.push(event));
				pi.registerTool({
					name: "perform_authorized_work",
					label: "Authorized work",
					description: "Perform the approved work",
					parameters: { type: "object", properties: {} } as never,
					async execute() {
						workDone = true;
						return {
							content: [{ type: "text", text: "Authorized work delivered" }],
							details: undefined,
						};
					},
				});
				pi.on("tool_result", (event) => {
					toolResults.push({
						toolName: event.toolName,
						isError: event.isError,
						text: event.content
							.map((block) => (block.type === "text" ? block.text : ""))
							.join(""),
					});
				});
			},
		],
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		if (String(input).endsWith("/jev")) {
			reviewCalls++;
			const request = JSON.parse(String(init?.body));
			const supported = request.state.includes("Do not choose a database yet");
			return new Response(
				JSON.stringify({
					answers: {
						stop_review: {
							choice: supported ? "supported" : "contradicted",
							confidence: 0.7,
							probabilities: { contradicted: supported ? 0.01 : 0.95 },
						},
					},
				}),
			);
		}
		if (String(input).includes("typesafe.ai/v1/systemone")) reviewCalls++;
		return originalFetch(input, init);
	}) as typeof fetch;
	let session:
		| Awaited<ReturnType<typeof createAgentSession>>["session"]
		| undefined;
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: root,
			agentDir,
			modelRuntime,
			model,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			settingsManager: SettingsManager.inMemory(),
			noTools: "builtin",
		}));
		await session.bindExtensions({ mode: "print" });
		await session.prompt(
			"Implement the approved change now. You already have my permission to implement it. Do not ask me for permission to implement it again. 继续，不用再问。",
		);
		assert.equal(
			reviewCalls,
			1,
			"The production endpoint/registry chain must actually contact Jev; fail-open is not a live pass",
		);
		assert.equal(
			toolResults[0]?.isError,
			true,
			"The review must refuse the duplicate permission request",
		);
		assert.match(toolResults[0].text, /Unlock refused \(1\/3\)/);
		assert.equal(
			workDone,
			true,
			"Pi must follow up after the tool error and execute authorized work",
		);
		assert.equal(requests.length, 3);
		assert.equal(reviewCalls, 1);
		assert.equal(controller.snapshot.locked, false);
		assert.equal(
			hooks.filter(
				(event) => (event as { name?: string }).name === "user-ready",
			).length,
			1,
		);
		const previousRequests = requests.length;
		await session.prompt(
			"Do not choose a database yet. Ask me to choose between Postgres and SQLite; that decision is still pending.",
		);
		assert.equal(
			requests.length,
			previousRequests + 1,
			"A genuine WAIT_USER should terminate without a model follow-up",
		);
		assert.equal(toolResults.at(-1)?.isError, false);
		assert.equal(reviewCalls, 2);
		console.log(
			`SDK follow-up smoke: duplicate approval refused, authorized work executed, genuine pending choice accepted (${process.env.WATCHDOG_LIVE_JEV_SMOKE === "1" ? "live Jev" : "fixture Jev"}); artifacts ${root}`,
		);
	} finally {
		if (session) {
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			session.dispose();
		}
		globalThis.fetch = originalFetch;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
