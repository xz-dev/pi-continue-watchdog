import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

interface RequestRecord {
	readonly messages: Array<{
		readonly role?: string;
		readonly content?: unknown;
	}>;
}

const proofExtension = (events: string[]) =>
	function settledDispatch(pi: ExtensionAPI): void {
		pi.on("agent_end", () => {
			events.push("agent_end");
		});
		pi.on("agent_settled", (_event, ctx) => {
			events.push(`agent_settled:${ctx.isIdle()}`);
			if (
				events.filter((entry) => entry.startsWith("agent_settled")).length === 1
			) {
				pi.sendMessage(
					{
						customType: "stock-pi-settled-proof",
						content: "Continue after settled.",
						display: false,
						details: { proof: true },
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			}
		});
	};

test("stock Pi 0.83 dispatches a triggerTurn custom message from idle agent_settled", async () => {
	const isolatedDir = await mkdtemp(join(tmpdir(), "pi-settled-proof-"));
	const requests: RequestRecord[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const payload = JSON.parse(body) as RequestRecord;
			requests.push(payload);
			response.writeHead(200, {
				"content-type": "text/event-stream",
				connection: "keep-alive",
			});
			const content = requests.length === 1 ? "first" : "second";
			response.write(
				`data: ${JSON.stringify({ id: `response-${requests.length}`, model: "proof-model", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({ id: `response-${requests.length}`, model: "proof-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");

	const events: string[] = [];
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	modelRuntime.registerProvider("settled-proof", {
		name: "Settled proof",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		apiKey: "local-proof-key",
		api: "openai-completions",
		models: [
			{
				id: "proof-model",
				name: "Proof model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 128,
			},
		],
	});
	const model = modelRuntime.getModel("settled-proof", "proof-model");
	assert.ok(model);

	const loader = new DefaultResourceLoader({
		cwd: isolatedDir,
		agentDir: isolatedDir,
		extensionFactories: [proofExtension(events)],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: isolatedDir,
		agentDir: isolatedDir,
		modelRuntime,
		model,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
		noTools: "all",
	});

	try {
		await session.prompt("Start the proof.");
		await session.waitForIdle();
		assert.equal(requests.length, 2);
		assert.deepEqual(events, [
			"agent_end",
			"agent_settled:true",
			"agent_end",
			"agent_settled:true",
		]);
		const secondRequest = requests[1];
		assert.ok(secondRequest);
		assert.equal(
			secondRequest.messages.some(
				(message) =>
					message.role === "user" &&
					JSON.stringify(message.content).includes("Continue after settled."),
			),
			true,
		);
	} finally {
		session.dispose();
		server.close();
		await once(server, "close");
		await rm(isolatedDir, { recursive: true, force: true });
	}
});
