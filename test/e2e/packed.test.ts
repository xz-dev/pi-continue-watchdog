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
const TOOL_NAME = "cw";

interface RequestRecord {
	readonly receivedAt: number;
	readonly messages: Array<{
		readonly role?: string;
		readonly content?: unknown;
	}>;
	readonly tools?: Array<{
		readonly function?: {
			readonly name?: string;
			readonly description?: string;
			readonly parameters?: unknown;
		};
	}>;
}

interface MockReply {
	readonly kind:
		| "text"
		| "cw"
		| "cw-invalid"
		| "cw-mixed"
		| "delayed"
		| "connection-error";
	readonly action?: "continue" | "wait" | "unlock";
	readonly waitSeconds?: number;
	readonly mixedToolName?: string;
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
			if (reply.kind === "cw" || reply.kind === "cw-invalid") {
				const argumentsJson =
					reply.kind === "cw-invalid"
						? (reply.text ?? "{}")
						: JSON.stringify({
								action: reply.action ?? "unlock",
								...(reply.action === "wait"
									? {
											reason_content: reply.reason ?? "Waiting for automation.",
											wait_seconds: reply.waitSeconds ?? 60,
										}
									: {
											reason_type: reply.reasonType ?? "JOB_DONE",
											reason_content:
												reply.reason ?? "All requested work is complete.",
										}),
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
			if (reply.kind === "cw-mixed") {
				const argumentsJson = JSON.stringify({
					action: "unlock",
					reason_type: reply.reasonType ?? "JOB_DONE",
					reason_content: reply.reason ?? "Mixed batch result.",
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
										{
											index: 1,
											id: `bash-${requests.length}`,
											type: "function",
											function: {
												name: reply.mixedToolName ?? "bash",
												arguments: '{"command":"echo side-effect"}',
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

const DECISION_PROMPT_MARKER =
	"automated continuation check from the pi-continue-watchdog";

function isDecisionRequest(request: RequestRecord): boolean {
	return request.messages.some((message) =>
		contentText(message).includes(DECISION_PROMPT_MARKER),
	);
}

test("packed reserved function is advertised with minimal metadata to every request", {
	timeout: 180_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Working." },
		{ kind: "cw", action: "unlock" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Do the work.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "decision request");
		for (const request of requests) {
			const declared = (request.tools ?? []).find(
				(tool) => tool.function?.name === TOOL_NAME,
			);
			assert.ok(declared, `expected ${TOOL_NAME} in request tools`);
			assert.equal(declared.function?.description, "don't use unless ask");
			const parameters = JSON.stringify(declared.function?.parameters);
			assert.equal(parameters.includes("reason_type"), false);
			assert.equal(parameters.includes("action"), false);
		}
		// No startup usage guidance advertises the protocol in ordinary requests.
		for (const request of requests) {
			for (const message of request.messages) {
				assert.doesNotMatch(
					contentText(message),
					/call cw now|Submit exactly one cw function call/,
				);
			}
		}
	} finally {
		await shutdownSession(session);
	}
});

test("packed idle settlement opens one inquiry before continuation", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "First ordinary answer." },
		{ kind: "cw", action: "continue", reasonType: "WORK_REMAINS" },
		{ kind: "text", text: "Continued answer." },
		{ kind: "cw", action: "unlock" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Start the task.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "decision request");
		const decisionRequest = requests[1];
		assert.ok(isDecisionRequest(decisionRequest), "request 2 is the inquiry");
		assert.match(
			contentText(decisionRequest.messages.at(-1) ?? ({ role: "" } as never)),
			new RegExp(DECISION_PROMPT_MARKER),
		);
		await waitForSessionIdle(session, 30_000, "decision turn");
		// The accepted continue publishes one ordinary continuation turn.
		await waitFor(() => requests.length >= 3, 120_000, "continuation request");
		const continuationRequest = requests[2];
		const continuationMessage = continuationRequest.messages.find(
			(message) =>
				message.role === "user" &&
				contentText(message).includes("Continue watchdog continued ·"),
		);
		assert.ok(continuationMessage, "expected continuation body in request 3");
		const body = contentText(continuationMessage);
		assert.match(body, new RegExp(continuePrompt));
		assert.match(body, /WORK_REMAINS/);
		// Later ordinary requests contain one canonical continuation event and
		// no raw decision instructions or result calls.
		await waitForSessionIdle(session, 30_000, "second ordinary turn");
		await waitFor(() => requests.length >= 4, 120_000, "next decision");
		// The continuation request (3) contains no decision internals, and later
		// inquiry requests carry only their own newest prompt: completed
		// exchanges fold into the one shared outcome event.
		for (const request of requests.slice(2)) {
			const joined = JSON.stringify(request.messages);
			assert.equal(joined.includes("pi-continue-watchdog:inquiry-fold"), false);
			assert.equal(
				joined.includes("pi-continue-watchdog:decision-audit"),
				false,
			);
			const markerCount = joined.split(DECISION_PROMPT_MARKER).length - 1;
			const isOwnInquiry = isDecisionRequest(request);
			assert.equal(
				markerCount,
				isOwnInquiry ? 1 : 0,
				`request carried ${markerCount} inquiry bodies`,
			);
		}
	} finally {
		await shutdownSession(session);
	}
});

test("packed unauthorized proactive call returns the reserved error and continues", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl, requests } = await startMockServer(t, [
		// Ordinary run tries to stop through cw before any decision exists.
		{ kind: "cw", action: "unlock", reason: "Stopping proactively." },
		// The run continues after the reserved error; the next turn settles.
		{ kind: "text", text: "Continued ordinary work." },
		{ kind: "cw", action: "unlock" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Try to stop early.");
		await waitForSessionIdle(session, 60_000, "first turn");
		// The reserved error does not terminate the run: Pi follows up normally.
		await waitFor(() => requests.length >= 2, 120_000, "follow-up request");
		await waitForSessionIdle(session, 30_000, "second turn");
		// No unlock hook fired for the out-of-phase call.
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		assert.equal(
			envelopes.some((envelope) => envelope.name === "user-ready"),
			false,
			"no user-ready before any authorized decision",
		);
	} finally {
		await shutdownSession(session);
	}
});

test("packed decision unlock ends the cycle and publishes typed user-ready once", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Ordinary work done." },
		{
			kind: "cw",
			action: "unlock",
			reasonType: "WAIT_USER",
			reason: "Need deploy approval.",
		},
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Approve the deploy.");
		await waitForSessionIdle(session, 60_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "decision request");
		await waitForSessionIdle(session, 60_000, "decision turn");
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
		// The decision turn terminated on the tool result: no extra request.
		assert.equal(requests.length, 2);
		await new Promise((resolve) => setTimeout(resolve, 12_000));
		assert.equal(requests.length, 2);
	} finally {
		await shutdownSession(session);
	}
});

test("packed bounded wait defers exhaustion until its deadline", {
	timeout: 360_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { maxRetries: 1 },
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "External job pending." },
		{ kind: "cw", action: "wait", waitSeconds: 30 },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Wait for the job.");
		await waitForSessionIdle(session, 60_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "decision request");
		await waitForSessionIdle(session, 60_000, "decision turn");
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		const waiting = envelopes.filter(
			(envelope) => envelope.name === "watchdog-waiting",
		);
		assert.equal(waiting.length, 1);
		assert.deepEqual(waiting[0].values, {
			REASON: "Waiting for automation.",
			WAIT_SECONDS: "30",
		});
		// No new provider request before the 30s wait deadline elapses.
		await new Promise((resolve) => setTimeout(resolve, 12_000));
		assert.equal(requests.length, 2);
		// After the deadline and idle qualification, EXHAUSTED becomes eligible.
		await new Promise((resolve) => setTimeout(resolve, 25_000));
		const finalEnvelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		assert.ok(
			finalEnvelopes.some(
				(envelope) =>
					envelope.name === "user-ready" &&
					(envelope.values as { STOP_KIND?: string } | undefined)?.STOP_KIND ===
						"EXHAUSTED",
			),
			"expected EXHAUSTED user-ready after the wait deadline",
		);
		assert.equal(requests.length, 2);
	} finally {
		await shutdownSession(session);
	}
});

test("packed invalid decisions correct twice then decision-fail", {
	timeout: 360_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Work settles." },
		{ kind: "cw-invalid", text: "" },
		{ kind: "cw-invalid", text: "" },
		{ kind: "cw-invalid", text: "" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Do the work.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "first decision");
		await waitFor(() => requests.length >= 4, 240_000, "corrections");
		await waitForSessionIdle(session, 60_000, "final decision turn");
		const decisionRequests = requests.filter((r) => isDecisionRequest(r));
		assert.equal(decisionRequests.length, 3);
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		assert.ok(
			envelopes.some(
				(envelope) =>
					envelope.name === "user-ready" &&
					(envelope.values as { STOP_KIND?: string } | undefined)?.STOP_KIND ===
						"DECISION_FAILED",
			),
			"expected DECISION_FAILED user-ready",
		);
		// The fourth invalid response is never requested.
		await new Promise((resolve) => setTimeout(resolve, 12_000));
		assert.equal(requests.length, 4);
	} finally {
		await shutdownSession(session);
	}
});

test("packed custom reasonTypes are matched case-insensitively in the decision", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { reasonTypes: ["NeedReview", "shipped"] },
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "PR ready." },
		{
			kind: "cw",
			action: "unlock",
			reasonType: "needreview",
			reason: "PR awaits review.",
		},
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Ship it.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "decision request");
		await waitForSessionIdle(session, 60_000, "decision turn");
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		const ready = envelopes.filter(
			(envelope) => envelope.name === "user-ready",
		);
		assert.equal(ready.length, 1);
		assert.equal(
			(ready[0].values as { REASON_TYPE?: string }).REASON_TYPE,
			"NEEDREVIEW",
		);
	} finally {
		await shutdownSession(session);
	}
});
