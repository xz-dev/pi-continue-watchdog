import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const decisionTools = ["continue_watchdog", "unlock_continue_watchdog"];
const decisionPromptStart =
	"This is an automated continuation check from the pi-continue-watchdog extension";
const continuePrompt = "Continue until user assistance is required.";

interface RequestRecord {
	readonly receivedAt: number;
	readonly messages: Array<{
		readonly role?: string;
		readonly content?: unknown;
	}>;
	readonly tools?: Array<{ readonly function?: { readonly name?: string } }>;
}

interface MockReply {
	readonly kind: "stop" | "continue" | "unlock" | "delayed";
	readonly reason?: string;
	readonly started?: () => void;
}

interface PackedFixture {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	readonly cwd: string;
	readonly packageDir: string;
}

async function makePackedFixture(t: TestContext): Promise<PackedFixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-continue-watchdog-e2e-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const packDir = join(root, "pack");
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const cwd = join(root, "project");
	const installRoot = join(agentDir, "npm");
	await Promise.all([
		mkdir(packDir, { recursive: true }),
		mkdir(cwd, { recursive: true }),
		mkdir(installRoot, { recursive: true }),
	]);

	const { stdout } = await execFileAsync(
		"npm",
		["pack", "--pack-destination", packDir],
		{
			cwd: repoRoot,
			timeout: 120_000,
			maxBuffer: 1024 * 1024,
		},
	);
	const tarball = join(packDir, stdout.trim().split("\n").at(-1) ?? "");
	await execFileAsync("npm", ["init", "-y"], {
		cwd: installRoot,
		timeout: 30_000,
	});
	await execFileAsync(
		"npm",
		[
			"install",
			"--prefer-offline",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			tarball,
		],
		{ cwd: installRoot, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
	);

	const manifest = JSON.parse(
		await readFile(join(repoRoot, "package.json"), "utf8"),
	) as { name: string };
	const packageDir = join(installRoot, "node_modules", manifest.name);
	const installedManifest = JSON.parse(
		await readFile(join(packageDir, "package.json"), "utf8"),
	) as { pi?: { extensions?: string[] } };
	assert.deepEqual(installedManifest.pi?.extensions, ["./src/extension.ts"]);
	assert.equal((await readdir(packageDir)).includes("test"), false);
	assert.equal((await readdir(packageDir)).includes("e2e"), false);

	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ extensions: [packageDir] }),
	);
	return { root, home, agentDir, cwd, packageDir };
}

function toolNames(request: RequestRecord): string[] {
	return (request.tools ?? [])
		.map((tool) => tool.function?.name)
		.filter((name): name is string => typeof name === "string")
		.sort();
}

function textOf(message: RequestRecord["messages"][number]): string {
	return JSON.stringify(message.content);
}

function sendSse(
	response: import("node:http").ServerResponse,
	chunks: unknown[],
): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		connection: "keep-alive",
	});
	for (const chunk of chunks) {
		response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	}
	response.end("data: [DONE]\n\n");
}

async function startMockServer(
	t: TestContext,
	replies: readonly MockReply[],
): Promise<{ server: Server; baseUrl: string; requests: RequestRecord[] }> {
	const requests: RequestRecord[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const payload = JSON.parse(body) as Omit<RequestRecord, "receivedAt">;
			requests.push({ ...payload, receivedAt: Date.now() });
			const reply = replies[requests.length - 1];
			if (reply === undefined) {
				response.writeHead(500).end("unexpected provider request");
				return;
			}
			const id = `mock-${requests.length}`;
			if (reply.kind === "delayed") {
				response.writeHead(200, {
					"content-type": "text/event-stream",
					connection: "keep-alive",
				});
				response.write(
					`data: ${JSON.stringify({ id, model: "watchdog-e2e", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
					() => reply.started?.(),
				);
				return;
			}
			if (reply.kind === "continue" || reply.kind === "unlock") {
				const name =
					reply.kind === "continue"
						? "continue_watchdog"
						: "unlock_continue_watchdog";
				const args =
					reply.kind === "continue"
						? "{}"
						: JSON.stringify({ reason: reply.reason });
				sendSse(response, [
					{
						id,
						model: "watchdog-e2e",
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: `${name}-${requests.length}`,
											type: "function",
											function: { name, arguments: args },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						id,
						model: "watchdog-e2e",
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					},
				]);
				return;
			}
			sendSse(response, [
				{
					id,
					model: "watchdog-e2e",
					choices: [
						{
							index: 0,
							delta: { content: `ordinary-${requests.length}` },
							finish_reason: null,
						},
					],
				},
				{
					id,
					model: "watchdog-e2e",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
			]);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		server.close();
		await once(server, "close");
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function createSession(
	fixture: PackedFixture,
	baseUrl: string,
): Promise<{ session: AgentSession; extensionPath: string }> {
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = fixture.home;
	process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
	try {
		const loader = new DefaultResourceLoader({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const [loaded] = loader.getExtensions().extensions;
		assert.ok(loaded);
		assert.equal(loaded.path.startsWith(fixture.packageDir), true);

		const modelRuntime = await ModelRuntime.create({ modelsPath: null });
		modelRuntime.registerProvider("watchdog-e2e", {
			name: "Watchdog E2E",
			baseUrl,
			apiKey: "local-only",
			api: "openai-completions",
			models: [
				{
					id: "watchdog-e2e",
					name: "Watchdog E2E",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 128,
				},
			],
		});
		const model = modelRuntime.getModel("watchdog-e2e", "watchdog-e2e");
		assert.ok(model);
		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRuntime,
			model,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(),
		});
		await session.bindExtensions({ mode: "print" });
		return { session, extensionPath: loaded.path };
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
}

async function waitFor(
	condition: () => boolean,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
}

test("packed source artifact waits a real 3 seconds, decides continue, and folds context", {
	timeout: 30_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "stop" },
		{ kind: "continue" },
		{ kind: "stop" },
	]);
	const { session, extensionPath } = await createSession(fixture, baseUrl);
	t.after(() => session.dispose());
	assert.match(
		extensionPath,
		/node_modules\/pi-continue-watchdog\/src\/extension\.ts$/,
	);

	const commands = session.extensionRunner
		.getRegisteredCommands()
		.map((command) => command.invocationName);
	assert.equal(commands.includes("lock-continue-watchdog"), true);
	assert.equal(commands.includes("unlock-continue-watchdog"), true);

	await session.prompt("Start a task that must not mysteriously stop.");
	await waitFor(() => requests.length === 3, 10_000, "continued provider turn");
	await session.waitForIdle();

	const firstRequest = requests[0];
	const decisionRequest = requests[1];
	const continuedRequest = requests[2];
	assert.ok(firstRequest);
	assert.ok(decisionRequest);
	assert.ok(continuedRequest);
	assert.deepEqual(toolNames(firstRequest), ["bash", "edit", "read", "write"]);
	assert.deepEqual(toolNames(decisionRequest), decisionTools);
	assert.deepEqual(toolNames(continuedRequest), [
		"bash",
		"edit",
		"read",
		"write",
	]);
	const elapsed = decisionRequest.receivedAt - firstRequest.receivedAt;
	assert.ok(elapsed >= 2_800, `decision arrived too early after ${elapsed}ms`);
	assert.ok(elapsed <= 6_000, `decision arrived too late after ${elapsed}ms`);
	assert.equal(
		decisionRequest.messages.some((message) =>
			textOf(message).includes(decisionPromptStart),
		),
		true,
	);
	const folded = continuedRequest.messages.filter(
		(message) =>
			message.role === "user" && textOf(message).includes(continuePrompt),
	);
	assert.equal(folded.length, 1);
	const thirdBody = JSON.stringify(requests[2]);
	assert.equal(thirdBody.includes(decisionPromptStart), false);
	assert.equal(thirdBody.includes("continue_watchdog"), false);
	assert.equal(thirdBody.includes("unlock_continue_watchdog"), false);
});

test("packed command unlock and canonical programmatic abort prevent a decision turn", {
	timeout: 20_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	let markStreamStarted: (() => void) | undefined;
	const streamStarted = new Promise<void>((resolveStarted) => {
		markStreamStarted = resolveStarted;
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "delayed", started: () => markStreamStarted?.() },
	]);
	const { session } = await createSession(fixture, baseUrl);
	t.after(() => session.dispose());
	let markAssistantStarted: (() => void) | undefined;
	const assistantStarted = new Promise<void>((resolveStarted) => {
		markAssistantStarted = resolveStarted;
	});
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update" && event.message.role === "assistant") {
			markAssistantStarted?.();
		}
	});
	t.after(unsubscribe);

	await session.prompt("/lock-continue-watchdog");
	await session.prompt("/unlock-continue-watchdog waiting for user");
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_300));
	assert.equal(requests.length, 0);
	const entries = session.sessionManager.getEntries();
	assert.equal(
		entries.some((entry) => JSON.stringify(entry).includes("waiting for user")),
		true,
	);

	const prompt = session.prompt("This run will be aborted through stock Pi.");
	await waitFor(() => requests.length === 1, 3_000, "delayed provider request");
	await Promise.all([streamStarted, assistantStarted]);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	await session.abort();
	await prompt;
	await session.waitForIdle();
	const branchAssistants = session.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? [entry.message]
				: [],
		);
	assert.equal(branchAssistants.length, 1);
	assert.equal(branchAssistants[0]?.stopReason, "aborted");
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_300));
	assert.equal(requests.length, 1);
});
