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
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const continuePrompt = "Continue until user assistance is required.";
const TOOL_NAME = "unlock_continue_watchdog";

interface RequestRecord {
	readonly receivedAt: number;
	readonly messages: Array<{
		readonly role?: string;
		readonly content?: unknown;
	}>;
	readonly tools?: Array<{ readonly function?: { readonly name?: string } }>;
}

interface MockReply {
	readonly kind: "text" | "unlock-tool" | "delayed" | "connection-error";
	readonly reasonType?: string;
	readonly reason?: string;
	readonly started?: () => void;
	readonly text?: string;
}

interface PackedFixture {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	readonly cwd: string;
	readonly packageDir: string;
}

/**
 * Independent neutral consumer probe for packed E2E.
 * Knows only channel `pi:semantic-hook:v1` and the plain envelope schema.
 * It does not import or name pi-continue-watchdog.
 */
const NEUTRAL_SEMANTIC_PROBE_SOURCE = `import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

const CHANNEL = "pi:semantic-hook:v1";
const evaluationId = randomUUID();
const outputPath = process.env.PI_SEMANTIC_PROBE_OUT;

function record(kind, ctx, data) {
	if (typeof outputPath !== "string" || outputPath.length === 0) return;
	appendFileSync(outputPath, JSON.stringify({ kind, cwd: ctx.cwd, evaluationId, data }) + "\\n");
}

export default function registerNeutralSemanticProbe(pi) {
	pi.on("session_start", (_event, ctx) => {
		record("session-start", ctx);
		pi.events.on(CHANNEL, (data) => record("semantic-hook", ctx, data));
	});
}
`;

async function makePackedFixture(
	t: TestContext,
	options?: {
		readonly withSemanticProbe?: boolean;
		readonly withProbeOutput?: boolean;
		readonly includeWatchdog?: boolean;
		readonly watchdogConfig?: Record<string, unknown>;
		readonly piSettings?: Record<string, unknown>;
	},
): Promise<PackedFixture & { readonly probeOut?: string }> {
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
			// This fixture intentionally installs the watchdog as a tarball dependency,
			// so its reviewed Git dependency is transitive to the temporary root.
			// Production distribution uses a Pi Git clone, where `.npmrc` applies the
			// narrower `allow-git=root` policy verified separately in CI.
			"--allow-git=all",
			tarball,
		],
		{ cwd: installRoot, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
	);

	const manifest = JSON.parse(
		await readFile(join(repoRoot, "package.json"), "utf8"),
	) as { name: string };
	const packageDir = join(installRoot, "node_modules", manifest.name);
	const installedManifest = JSON.parse(
		await readFile(join(packageDir, "package.json"), "utf8"),
	) as {
		pi?: { extensions?: string[] };
		dependencies?: Record<string, string>;
	};
	assert.deepEqual(installedManifest.pi?.extensions, ["./src/extension.ts"]);
	const utilsPackage = join(installRoot, "node_modules", "pi-extension-utils");
	const utilsManifest = JSON.parse(
		await readFile(join(utilsPackage, "package.json"), "utf8"),
	) as { name?: string; bin?: Record<string, string> };
	assert.equal(utilsManifest.name, "pi-extension-utils");
	assert.equal(utilsManifest.bin, undefined);
	await readFile(join(utilsPackage, "dist", "index.js"), "utf8");
	await readFile(
		join(utilsPackage, "dist", "process-domain", "index.js"),
		"utf8",
	);
	await readFile(join(utilsPackage, "dist", "pi-inquiry.js"), "utf8");
	assert.equal((await readdir(packageDir)).includes("test"), false);

	const extensions: string[] =
		options?.includeWatchdog === false ? [] : [packageDir];
	let probeOut: string | undefined;
	if (options?.withSemanticProbe || options?.withProbeOutput) {
		probeOut = join(root, "semantic-probe-out.jsonl");
		await writeFile(probeOut, "");
	}
	if (options?.withSemanticProbe) {
		const probePath = join(root, "neutral-semantic-probe.mjs");
		await writeFile(probePath, NEUTRAL_SEMANTIC_PROBE_SOURCE);
		extensions.push(probePath);
	}
	if (options?.watchdogConfig !== undefined) {
		await writeFile(
			join(agentDir, "pi-continue-watchdog.json"),
			JSON.stringify(options.watchdogConfig),
		);
	}

	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ ...options?.piSettings, extensions }),
	);
	return { root, home, agentDir, cwd, packageDir, probeOut };
}

interface ProbeRecord {
	readonly kind: "session-start" | "semantic-hook";
	readonly cwd: string;
	readonly evaluationId: string;
	readonly data?: Record<string, unknown>;
}

async function readProbeRecords(probeOut: string): Promise<ProbeRecord[]> {
	const raw = await readFile(probeOut, "utf8");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as ProbeRecord);
}

async function readProbeEnvelopes(
	probeOut: string,
): Promise<Array<Record<string, unknown>>> {
	return (await readProbeRecords(probeOut))
		.filter((record) => record.kind === "semantic-hook")
		.map((record) => record.data ?? {});
}

function toolNames(request: RequestRecord): string[] {
	return (request.tools ?? [])
		.map((tool) => tool.function?.name)
		.filter((name): name is string => typeof name === "string")
		.sort();
}

function contentText(message: RequestRecord["messages"][number]): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((block) =>
			typeof block === "object" &&
			block !== null &&
			typeof (block as { readonly text?: unknown }).text === "string"
				? (block as { readonly text: string }).text
				: "",
		)
		.join("");
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
			if (reply.kind === "connection-error") {
				request.socket.destroy();
				return;
			}
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
			if (reply.kind === "unlock-tool") {
				const argumentsJson = JSON.stringify({
					reason_type: reply.reasonType ?? "JOB_DONE",
					reason: reply.reason ?? "All requested work is complete.",
				});
				sendSse(response, [
					{
						id,
						model: "watchdog-e2e",
						choices: [
							{
								index: 0,
								delta: {
									content: reply.text ?? "",
									tool_calls: [
										{
											index: 0,
											id: `call-${requests.length}`,
											type: "function",
											function: {
												name: TOOL_NAME,
												arguments: argumentsJson,
											},
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
							delta: { content: reply.text ?? `ordinary-${requests.length}` },
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
	fixture: PackedFixture & { readonly probeOut?: string },
	baseUrl: string,
	options?: {
		readonly contextWindow?: number;
		readonly maxTokens?: number;
		readonly cwd?: string;
		readonly uiContext?: ExtensionUIContext;
		readonly abortHandler?: (session: AgentSession) => void;
		readonly additionalExtensionPaths?: string[];
		readonly sessionManager?: SessionManager;
	},
): Promise<{
	session: AgentSession;
	extensionPath: string;
	loader: DefaultResourceLoader;
}> {
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousProbeOut = process.env.PI_SEMANTIC_PROBE_OUT;
	const domainNames = [
		"PI_EXTENSION_UTILS_PROCESS_DOMAIN",
		"PI_CONTINUE_WATCHDOG_ROOT_PID",
	] as const;
	const previousDomain = Object.fromEntries(
		domainNames.map((name) => [name, process.env[name]]),
	) as Record<(typeof domainNames)[number], string | undefined>;
	for (const name of domainNames) delete process.env[name];
	process.env.HOME = fixture.home;
	process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
	if (fixture.probeOut !== undefined) {
		process.env.PI_SEMANTIC_PROBE_OUT = fixture.probeOut;
	} else {
		delete process.env.PI_SEMANTIC_PROBE_OUT;
	}
	try {
		const cwd = options?.cwd ?? fixture.cwd;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: fixture.agentDir,
			additionalExtensionPaths: options?.additionalExtensionPaths,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const loaded = loader
			.getExtensions()
			.extensions.find(
				(extension) =>
					extension.path.startsWith(fixture.packageDir) ||
					options?.additionalExtensionPaths?.includes(extension.path),
			);
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
					contextWindow: options?.contextWindow ?? 4096,
					maxTokens: options?.maxTokens ?? 128,
				},
			],
		});
		const model = modelRuntime.getModel("watchdog-e2e", "watchdog-e2e");
		assert.ok(model);
		const { session } = await createAgentSession({
			cwd,
			agentDir: fixture.agentDir,
			modelRuntime,
			model,
			resourceLoader: loader,
			sessionManager: options?.sessionManager ?? SessionManager.inMemory(),
		});
		await session.bindExtensions(
			options?.abortHandler !== undefined
				? {
						mode: "tui",
						uiContext: options.uiContext ?? createRpcUiContext(),
						abortHandler: () => options.abortHandler?.(session),
					}
				: options?.uiContext === undefined
					? { mode: "print" }
					: { mode: "rpc", uiContext: options.uiContext },
		);
		return { session, extensionPath: loaded.path, loader };
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousProbeOut === undefined)
			delete process.env.PI_SEMANTIC_PROBE_OUT;
		else process.env.PI_SEMANTIC_PROBE_OUT = previousProbeOut;
		for (const name of domainNames) {
			const value = previousDomain[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
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

async function waitForSessionIdle(
	session: AgentSession,
	timeoutMs: number,
	label: string,
): Promise<void> {
	await waitFor(() => session.isIdle, timeoutMs, `${label} to become idle`);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			session.waitForIdle(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`Timed out waiting for ${label} waitForIdle`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
	assert.equal(session.isIdle, true, `${label} remained working`);
}

async function shutdownSession(session: AgentSession): Promise<void> {
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	session.dispose();
}

function createRpcUiContext(notifications?: string[]): ExtensionUIContext {
	return {
		async select() {
			return undefined;
		},
		async confirm() {
			return false;
		},
		async input() {
			return undefined;
		},
		notify(message: string) {
			notifications?.push(message);
		},
		onTerminalInput() {
			return () => {};
		},
	} as unknown as ExtensionUIContext;
}

test("packed tool is advertised to every provider request", {
	timeout: 180_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Working." },
		{ kind: "unlock-tool" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Do the work.");
		await waitForSessionIdle(session, 30_000, "first turn");
		// The unlock tool settles the run; wait for the second request.
		await waitFor(() => requests.length >= 2, 60_000, "unlock request");
		for (const request of requests) {
			assert.ok(
				toolNames(request).includes(TOOL_NAME),
				`expected ${TOOL_NAME} in ${JSON.stringify(toolNames(request))}`,
			);
		}
	} finally {
		await shutdownSession(session);
	}
});

test("packed idle continuation directly continues without an inquiry", {
	timeout: 240_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "First ordinary answer." },
		{ kind: "text", text: "Continued answer after nudge." },
		{ kind: "unlock-tool" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Start the task.");
		await waitForSessionIdle(session, 30_000, "first turn");
		// After the fixed 10s fence the watchdog sends one direct continuation.
		await waitFor(() => requests.length >= 2, 120_000, "continuation request");
		const continuationRequest = requests[1];
		const continuationMessage = continuationRequest.messages.find(
			(message) =>
				message.role === "user" &&
				contentText(message).includes("Continue watchdog continued ·"),
		);
		assert.ok(continuationMessage, "expected continuation body in request 2");
		const body = contentText(continuationMessage);
		assert.match(
			body,
			/You ended your turn without calling unlock_continue_watchdog\./,
		);
		assert.match(body, new RegExp(continuePrompt));
		assert.match(body, /monitor that task until it ends/);
		// No hidden decision prompt ever reached the provider.
		for (const request of requests) {
			for (const message of request.messages) {
				assert.doesNotMatch(
					contentText(message),
					/automated continuation check from the pi-continue-watchdog/,
				);
			}
		}
		await waitForSessionIdle(session, 30_000, "second turn");
		await waitFor(() => requests.length >= 3, 120_000, "unlock request");
	} finally {
		await shutdownSession(session);
	}
});

test("packed tool unlock ends the cycle and publishes typed user-ready once", {
	timeout: 240_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl, requests } = await startMockServer(t, [
		{
			kind: "unlock-tool",
			reasonType: "WAIT_USER",
			reason: "Need deploy approval.",
		},
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Approve the deploy.");
		await waitForSessionIdle(session, 60_000, "unlock turn");
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		const ready = envelopes.filter(
			(envelope) => envelope.name === "user-ready",
		);
		assert.equal(ready.length, 1);
		assert.deepEqual(ready[0].values, {
			STOP_KIND: "AI_UNLOCK",
			REASON_TYPE: "WAIT_USER",
			REASON: "Need deploy approval.",
		});
		// The run terminated on the tool result: no second model request.
		assert.equal(requests.length, 1);
	} finally {
		await shutdownSession(session);
	}
});

test("packed simple watchdog-continued hook carries no values", {
	timeout: 240_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl } = await startMockServer(t, [
		{ kind: "text", text: "Part one." },
		{ kind: "unlock-tool" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Work then finish.");
		await waitForSessionIdle(session, 30_000, "first turn");
		// Give the fence time to fire exactly one continuation, then let the
		// unlock-tool reply settle the cycle.
		await new Promise((resolve) => setTimeout(resolve, 12_000));
		const afterFence = (
			await readProbeEnvelopes(fixture.probeOut ?? "")
		).filter((envelope) => envelope.name === "watchdog-continued");
		assert.equal(afterFence.length, 1);
		assert.equal(afterFence[0].values, undefined);
	} finally {
		await shutdownSession(session);
	}
});

test("packed exhausted budget stops continuing and publishes EXHAUSTED", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { maxRetries: 1 },
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Never unlocks." },
		{ kind: "text", text: "Still working." },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Loop the work.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "only continuation");
		// maxRetries=1: exactly one continuation, then exhaustion at the next idle.
		await waitForSessionIdle(session, 30_000, "continuation turn");
		await new Promise((resolve) => setTimeout(resolve, 12_000));
		assert.equal(requests.length, 2);
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		assert.ok(
			envelopes.some(
				(envelope) =>
					envelope.name === "user-ready" &&
					(envelope.values as { STOP_KIND?: string } | undefined)?.STOP_KIND ===
						"EXHAUSTED",
			),
			"expected EXHAUSTED user-ready",
		);
	} finally {
		await shutdownSession(session);
	}
});

test("packed custom reasonTypes are matched case-insensitively through the tool", {
	timeout: 240_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		watchdogConfig: { reasonTypes: ["NeedReview", "shipped"] },
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{
			kind: "unlock-tool",
			reasonType: "needreview",
			reason: "PR awaits review.",
		},
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Ship it.");
		await waitForSessionIdle(session, 60_000, "unlock turn");
		assert.equal(requests.length, 1);
		const toolRequest = requests[0];
		assert.ok(
			toolNames(toolRequest).includes(TOOL_NAME),
			"tool schema present",
		);
		// The tool result is model-visible in the same batch; the normalized
		// type is asserted through the semantic probe in the unlock test above.
	} finally {
		await shutdownSession(session);
	}
});
