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
	AssistantMessageComponent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	initTheme,
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
		readonly tool_call_id?: string;
		readonly tool_calls?: Array<{
			readonly id?: string;
			readonly function?: { readonly name?: string };
		}>;
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
	readonly action?: "continue" | "unlock";
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
	readonly installRoot: string;
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
	const manifest = JSON.parse(
		await readFile(join(repoRoot, "package.json"), "utf8"),
	) as { name: string; devDependencies: Record<string, string> };
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
			// Pin only the fixture host; production peer ranges remain unchanged.
			...["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"].map(
				(name) => `${name}@${manifest.devDependencies[name]}`,
			),
		],
		{ cwd: installRoot, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
	);

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
	return { root, home, agentDir, cwd, packageDir, installRoot, probeOut };
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
					`data: ${JSON.stringify({ id, model: "watchdog-e2e", choices: [{ index: 0, delta: { content: reply.text ?? "partial" }, finish_reason: null }] })}\n\n`,
					() => reply.started?.(),
				);
				return;
			}
			if (reply.kind === "cw" || reply.kind === "cw-invalid") {
				// Visible text and function arguments are deliberately separate:
				// a singleton cw call with empty visible content reaches payload
				// validation instead of being rejected at batch preflight as
				// visible prose.
				const argumentsJson =
					reply.kind === "cw-invalid"
						? (reply.text ?? "{}")
						: JSON.stringify({
								action: reply.action ?? "unlock",
								reason_type: reply.reasonType ?? "JOB_DONE",
								reason_content:
									reply.reason ?? "All requested work is complete.",
							});
				sendSse(response, [
					{
						id,
						model: "watchdog-e2e",
						choices: [
							{
								index: 0,
								delta: {
									content: "",
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

test("packed native abort hides only the owned assistant notice through real Pi rendering", {
	timeout: 180_000,
}, async (t) => {
	initTheme("dark", false);
	const fixture = await makePackedFixture(t);
	for (const kind of [
		"decision",
		"correction",
		"continuation",
		"empty-decision",
		"ordinary",
	] as const) {
		await t.test(kind, { timeout: 35_000 }, async (sub) => {
			const replies: MockReply[] = [];
			if (kind !== "ordinary")
				replies.push({ kind: "text", text: "Initial work." });
			if (kind === "correction")
				replies.push({ kind: "cw-invalid", text: "{}" });
			if (kind === "continuation")
				replies.push({
					kind: "cw",
					action: "continue",
					reasonType: "WORK_REMAINS",
					reason: "Finish the work.",
				});
			replies.push({
				kind: "delayed",
				text: kind === "empty-decision" ? "" : "partial native output",
			});
			const { baseUrl, requests } = await startMockServer(sub, replies);
			const notifications: string[] = [];
			const { session } = await createSession(fixture, baseUrl, {
				uiContext: createRpcUiContext(notifications),
			});
			const rendered: string[] = [];
			const abortFrames: Array<{
				event: string;
				streamEvent?: string;
				stopReason: string;
			}> = [];
			const terminal: string[] = [];
			const terminalOutcomes: string[] = [];
			const unsubscribe = session.subscribe((event) => {
				if (
					(event.type === "message_start" ||
						event.type === "message_update" ||
						event.type === "message_end") &&
					event.message.role === "assistant"
				) {
					const component = new AssistantMessageComponent();
					component.updateContent(event.message, event.type !== "message_end");
					const view = component.render(100).join("\n");
					rendered.push(view);
					if (view.includes("Operation aborted"))
						abortFrames.push({
							event: event.type,
							streamEvent:
								event.type === "message_update"
									? event.assistantMessageEvent.type
									: undefined,
							stopReason: event.message.stopReason,
						});
					if (event.type === "message_end") {
						terminal.push(view);
						terminalOutcomes.push(event.message.stopReason);
					}
				}
			});
			try {
				const prompt = session.prompt("Do the work.");
				if (kind !== "ordinary") await prompt;
				await waitFor(
					() => requests.length === replies.length,
					25_000,
					`${kind} target request`,
				);
				if (kind !== "empty-decision") {
					await waitFor(
						() =>
							rendered.some((view) => view.includes("partial native output")),
						5_000,
						"partial rendering",
					);
				}
				await session.abort();
				await prompt;
				await waitForSessionIdle(session, 5_000, `${kind} abort`);
				assert.equal(
					requests.length,
					replies.length,
					"abort must not start a replacement request",
				);
				assert.equal(
					notifications.filter(
						(value) => value === "Continue watchdog unlocked",
					).length,
					1,
				);
				assert.equal(
					terminal.length,
					replies.length,
					"each response must reach final rendering",
				);
				assert.equal(
					terminalOutcomes.at(-1),
					"aborted",
					"host outcome stays aborted",
				);
				const finalView = terminal.at(-1) ?? "";
				if (kind === "ordinary") assert.match(finalView, /Operation aborted/);
				else
					assert.doesNotMatch(
						finalView,
						/Operation aborted/,
						"the finalized owned assistant must not retain an abort footer",
					);
				// The user accepts transient streaming notices; preserve evidence
				// instead of treating a quiet final view as proof of zero flashes.
				sub.diagnostic(
					`Pi 0.85.1 abort frames: ${JSON.stringify(abortFrames)}`,
				);
				if (kind === "continuation" || kind === "ordinary")
					assert.match(finalView, /partial native output/);
				else assert.doesNotMatch(finalView, /partial native output/);
				await session.prompt("/status-continue-watchdog");
				assert.match(notifications.at(-1) ?? "", /Lock: unlocked/);
				assert.match(notifications.at(-1) ?? "", /Trigger: blocked · unlocked/);
				assert.equal(requests.length, replies.length);
			} finally {
				unsubscribe();
				await session.abort();
				await shutdownSession(session);
			}
		});
	}
});

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
				contentText(message).includes("Continue watchdog · continue ·"),
		);
		assert.ok(continuationMessage, "expected continuation body in request 3");
		const body = contentText(continuationMessage);
		assert.match(body, new RegExp(continuePrompt));
		// The accepted reason appears once as the attributed next-step hint in
		// the SAME request that carries the controlling facts (user task and
		// ordinary delivery), with no prior-result JSON duplication.
		assert.match(body, /Continue watchdog · continue · WORK_REMAINS/);
		assert.match(body, /Suggested next step: /);
		assert.doesNotMatch(body, /"reasonType"/);
		assert.doesNotMatch(body, /Previous automated watchdog result/);
		assert.match(
			body,
			/does not revoke or reset permission the user already granted/,
		);
		const joinedRequest = JSON.stringify(continuationRequest.messages);
		assert.match(joinedRequest, /Start the task\./);
		assert.match(joinedRequest, /First ordinary answer\./);
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

const ZERO_USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function seededUser(
	manager: SessionManager,
	text: string,
	timestamp: number,
): string {
	return manager.appendMessage({
		role: "user",
		content: text,
		timestamp,
	});
}

function seededAssistant(
	manager: SessionManager,
	timestamp: number,
	toolCalls: Array<{
		readonly id: string;
		readonly name: string;
		readonly arguments: Record<string, unknown>;
	}> = [],
	text = `ordinary reply ${timestamp}`,
): string {
	return manager.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCalls.map((call) => ({ type: "toolCall", ...call }) as never),
		],
		api: "openai-completions",
		provider: "watchdog-e2e",
		model: "watchdog-e2e",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp,
	});
}

function seededToolResult(
	manager: SessionManager,
	toolCallId: string,
	toolName: string,
	output: string,
	timestamp: number,
): string {
	return manager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: output }],
		isError: false,
		timestamp,
	});
}

/**
 * A13–A15 separate actual decision-request captures (offline, localhost mock
 * provider only). Each case seeds its own session with genuine provenance —
 * real user-role records, real assistant tool calls with fixture toolResult
 * output, real plugin-attributed continuation custom messages — then captures
 * the ONE actual serialized decision request and asserts the decisive facts
 * AND the controlling fixed-guidance text appear in that same request.
 *
 * Expected outcomes recorded per case are input/boundary requirements, NOT
 * model-judgment evidence: the scripted reply only ends the fixture. Model
 * efficacy remains unmeasured; no live/paid provider is contacted.
 */
const FIXED_DELIVERY_GUIDANCE =
	/Exclude work already delivered, cancelled, or superseded/;
const FIXED_PERMISSION_GUIDANCE =
	/Your own earlier confirmation question is not evidence/;

async function captureDecisionRequest(
	t: TestContext,
	options: {
		readonly label: string;
		readonly seed: (manager: SessionManager) => void;
	},
): Promise<RequestRecord> {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t, [
		// Ordinary settle turn; the decision prompt then opens after idle.
		{ kind: "text", text: "Ordinary settle turn." },
		// Fixture-ending reply only. Never treated as judgment evidence.
		{ kind: "cw", action: "unlock", reason: "Fixture capture complete." },
	]);
	const sm = SessionManager.inMemory(fixture.cwd);
	options.seed(sm);
	const { session } = await createSession(fixture, baseUrl, {
		sessionManager: sm,
	});
	try {
		await session.prompt("Kick off the ordinary turn.");
		await waitForSessionIdle(session, 60_000, "first turn");
		await waitFor(() => requests.length >= 2, 180_000, "decision request");
		const decisionRequest = requests.find((request) =>
			isDecisionRequest(request),
		);
		assert.ok(decisionRequest, "expected a serialized decision request");
		// Persist the raw capture before cleanup under a deterministic name.
		const evidenceDir = "/var/tmp/two-outcome-lifecycle/evidence";
		try {
			await mkdir(evidenceDir, { recursive: true });
			await writeFile(
				`${evidenceDir}/${options.label}.json`,
				JSON.stringify(
					{
						capturedAt: new Date().toISOString(),
						expectedBoundary: options.label,
						request: decisionRequest,
					},
					null,
					2,
				),
				"utf8",
			);
		} catch {
			// Evidence copy is best-effort; the in-test assertions are the gate.
		}
		return decisionRequest;
	} finally {
		await shutdownSession(session);
	}
}

function requestPromptText(request: RequestRecord): string {
	return request.messages.map((message) => contentText(message)).join("\n");
}

/** User-role records excluding plugin-attributed custom messages (decision
 * prompt, continuation envelope) that the host serializes with user role. */
function genuineUserInstructions(request: RequestRecord): string[] {
	return request.messages
		.filter((message) => message.role === "user")
		.map((message) => contentText(message))
		.filter(
			(text) =>
				!text.includes(DECISION_PROMPT_MARKER) &&
				!text.includes("Continue watchdog · continue ·"),
		);
}

// A13a — user-text grant, redundant assistant question, no later revocation.
// Expected: no new WAIT_USER solely from that question; continue of the
// already-authorized action in unchanged scope.
test("packed A13a user-text grant with redundant question stays continue-eligible", {
	timeout: 360_000,
}, async (t) => {
	const request = await captureDecisionRequest(t, {
		label: "a13a-user-grant-redundant-question",
		seed: (sm) => {
			seededUser(sm, "Please apply the schema migration.", 1);
			seededUser(sm, "Yes — apply the schema migration now.", 2);
			// The redundant same-permission question the assistant asked anyway.
			seededAssistant(sm, 3, [], "To be safe, may I apply the migration?");
		},
	});
	const body = JSON.stringify(request.messages);
	assert.match(body, /apply the schema migration now/);
	assert.match(body, /may I apply the migration/);
	const promptText = requestPromptText(request);
	assert.match(promptText, FIXED_PERMISSION_GUIDANCE);
	// No later revocation exists after the grant: none of the genuine user
	// records following it restricts or revokes the migration permission.
	const instructions = genuineUserInstructions(request);
	const grantIndex = instructions.findIndex((text) =>
		text.includes("apply the schema migration now"),
	);
	assert.ok(grantIndex >= 0, "grant record present");
	for (const later of instructions.slice(grantIndex + 1)) {
		assert.doesNotMatch(
			later,
			/only read-only|do not (apply|change)|do not apply anything|revok/i,
			`no later revocation, got: ${later}`,
		);
	}
});

// A13b — successful-questionnaire-result-only grant plus redundant question.
// Expected: same as A13a; the correlated tool result, not assistant
// narration, is the authorization evidence preserved in the request.
test("packed A13b questionnaire-result grant with redundant question stays continue-eligible", {
	timeout: 360_000,
}, async (t) => {
	const request = await captureDecisionRequest(t, {
		label: "a13b-questionnaire-grant-redundant-question",
		seed: (sm) => {
			seededUser(sm, "Set up the release, confirming choices with me.", 1);
			seededAssistant(sm, 2, [
				{
					id: "ask-1",
					name: "ask_followup_question",
					arguments: { question: "Approve the release publish?" },
				},
			]);
			seededToolResult(
				sm,
				"ask-1",
				"ask_followup_question",
				"APPROVE — the user selected approval for the release publish.",
				3,
			);
			seededAssistant(sm, 4, [], "To be safe, may I proceed with the publish?");
		},
	});
	const body = JSON.stringify(request.messages);
	assert.match(body, /APPROVE — the user selected approval/);
	assert.match(body, /may I proceed with the publish/);
	assert.match(requestPromptText(request), FIXED_PERMISSION_GUIDANCE);
});

// A14 — latest delivered report plus stale plugin hint, analysis-only scope.
// Expected: completion (unlock), not redelivery and not automatic apply.
test("packed A14 delivered report with stale hint stays completion-eligible", {
	timeout: 360_000,
}, async (t) => {
	const request = await captureDecisionRequest(t, {
		label: "a14-delivered-report-stale-hint",
		seed: (sm) => {
			seededUser(
				sm,
				"Analyze the proposal and report its path, task status, validation, and next workflow. Analysis only — do not apply anything.",
				1,
			);
			seededAssistant(
				sm,
				2,
				[],
				"Proposal path: openspec/changes/simplify-watchdog-outcomes-and-presentation. Tasks: 4/6 complete. Validation: npm run check green. Next workflow: apply the remaining tasks (requires your explicit request).",
			);
			// Real plugin-attributed stale hint contradicting that delivery.
			sm.appendCustomMessageEntry(
				"pi-continue-watchdog:continuation",
				"Continue watchdog continued · VERIFYING · Report the proposal path, task status, validation result, and next workflow.",
				true,
				{
					version: 1,
					exchangeId: "seed-exchange-a14",
					outcome: "continue",
				},
			);
		},
	});
	const body = JSON.stringify(request.messages);
	assert.match(body, /4\/6 complete/);
	assert.match(body, /Continue watchdog continued · VERIFYING/);
	// Scope marker: analysis-only, no apply permission anywhere in the request.
	assert.match(body, /Analysis only — do not apply anything/);
	const promptText = requestPromptText(request);
	assert.match(promptText, FIXED_DELIVERY_GUIDANCE);
	assert.match(promptText, /Do not repeat an already-delivered answer/);
});

// A15a — an assistant-proposed destructive action outside user-authorized scope.
// Expected: no database mutation under parser permission. This does not prevent
// authorized parser work or require asking for an unnecessary extra operation.
test("packed A15a new-risk request keeps its user boundary in the request", {
	timeout: 360_000,
}, async (t) => {
	const request = await captureDecisionRequest(t, {
		label: "a15a-new-risk-request",
		seed: (sm) => {
			seededUser(
				sm,
				"Refactor the parser module only; do not change production data.",
				1,
			);
			seededAssistant(
				sm,
				2,
				[],
				"I propose an additional step: drop the production database and rebuild it from scratch.",
			);
		},
	});
	const instructions = genuineUserInstructions(request);
	const scopeIndex = instructions.findIndex((text) =>
		text.includes("parser module only; do not change production data"),
	);
	assert.ok(scopeIndex >= 0, "the user, not the assistant, limits the scope");
	assert.deepEqual(instructions.slice(scopeIndex + 1), [
		"Kick off the ordinary turn.",
	]);
	assert.ok(
		request.messages.some(
			(message) =>
				message.role === "assistant" &&
				contentText(message).includes(
					"I propose an additional step: drop the production database",
				),
		),
		"the destructive operation is an unapproved assistant proposal",
	);
	const promptText = requestPromptText(request);
	assert.match(
		promptText,
		/An earlier authorization does not override a later restriction/,
	);
	assert.match(promptText, /a distinct unsatisfied confirmation requirement/);
});

// A15b — distinct mandatory-confirmation policy still unmet.
// Expected: the unmet confirmation remains a genuine WAIT_USER boundary.
test("packed A15b unmet mandatory confirmation stays a real boundary", {
	timeout: 360_000,
}, async (t) => {
	const request = await captureDecisionRequest(t, {
		label: "a15b-mandatory-confirmation-unmet",
		seed: (sm) => {
			seededUser(
				sm,
				"Run the deployment pipeline. Before the destructive cutover, show its preview and require a separate reply of APPROVE CUTOVER. Starting the pipeline is not that confirmation.",
				1,
			);
			seededAssistant(
				sm,
				2,
				[],
				"Cutover preview: replace the production deployment with the new release. The required separate confirmation has not been given yet.",
			);
		},
	});
	const instructions = genuineUserInstructions(request);
	const policyIndex = instructions.findIndex((text) =>
		text.includes("require a separate reply of APPROVE CUTOVER"),
	);
	assert.ok(policyIndex >= 0, "the confirmation rule must come from the user");
	assert.match(instructions[policyIndex] ?? "", /Run the deployment pipeline/);
	assert.deepEqual(instructions.slice(policyIndex + 1), [
		"Kick off the ordinary turn.",
	]);
	assert.ok(
		!request.messages.some((message) => message.role === "tool"),
		"no questionnaire-result confirmation exists in this fixture",
	);
	assert.match(
		requestPromptText(request),
		/a distinct unsatisfied confirmation requirement/,
	);
});

// A15c — missing credentials/authentication evidence.
// Expected: the missing authentication remains required; earlier permission
// for other work does not substitute for it.
test("packed A15c missing authentication stays required in the request", {
	timeout: 360_000,
}, async (t) => {
	const request = await captureDecisionRequest(t, {
		label: "a15c-missing-authentication",
		seed: (sm) => {
			seededUser(sm, "Publish the signed release artifact.", 1);
			seededAssistant(sm, 2, [
				{
					id: "release-auth-1",
					name: "check_release_authentication",
					arguments: { artifact: "release.tar.gz" },
				},
			]);
			seededToolResult(
				sm,
				"release-auth-1",
				"check_release_authentication",
				JSON.stringify({
					signingDevice: "awaiting_user_confirmation",
					registryCredentials: "missing",
				}),
				3,
			);
			seededAssistant(
				sm,
				4,
				[],
				"The signing key's device authentication is unfinished and the registry credentials are unavailable, so the signing step cannot proceed yet.",
			);
		},
	});
	const callIndex = request.messages.findIndex(
		(message) =>
			message.role === "assistant" &&
			message.tool_calls?.some(
				(call) =>
					call.id === "release-auth-1" &&
					call.function?.name === "check_release_authentication",
			),
	);
	const resultIndex = request.messages.findIndex(
		(message) =>
			message.role === "tool" && message.tool_call_id === "release-auth-1",
	);
	assert.ok(callIndex >= 0, "the authentication query must be preserved");
	assert.ok(
		resultIndex > callIndex,
		"the result must follow its correlated call",
	);
	const result = request.messages[resultIndex];
	assert.ok(result);
	assert.deepEqual(JSON.parse(contentText(result)), {
		signingDevice: "awaiting_user_confirmation",
		registryCredentials: "missing",
	});
	assert.ok(
		genuineUserInstructions(request).includes(
			"Publish the signed release artifact.",
		),
		"release permission is distinct from authentication readiness",
	);
	const promptText = requestPromptText(request);
	assert.match(
		promptText,
		/missing credentials, or unfinished device authentication/,
	);
});

// A15d — later explicit read-only restriction overriding earlier grant.
// Expected: earlier implementation permission is not used to resume mutation;
// once the exploration is delivered, completion rather than invented work.
test("packed A15d later read-only restriction overrides earlier grant", {
	timeout: 360_000,
}, async (t) => {
	const request = await captureDecisionRequest(t, {
		label: "a15d-later-readonly-restriction",
		seed: (sm) => {
			seededUser(sm, "Yes — apply the schema migration now.", 1);
			seededUser(
				sm,
				"From now on, only read-only exploration; do not change anything.",
				2,
			);
		},
	});
	const body = JSON.stringify(request.messages);
	assert.match(body, /apply the schema migration now/);
	assert.match(body, /only read-only exploration/);
	// The restriction is the newest genuine user instruction about scope: no
	// genuine user record after it re-authorizes mutation.
	const instructions = genuineUserInstructions(request);
	const restrictionIndex = instructions.findIndex((text) =>
		text.includes("only read-only exploration"),
	);
	assert.ok(restrictionIndex >= 0, "restriction record present");
	const grantIndex = instructions.findIndex((text) =>
		text.includes("apply the schema migration now"),
	);
	assert.ok(
		restrictionIndex > grantIndex && grantIndex >= 0,
		"restriction supersedes the earlier grant in order",
	);
	for (const later of instructions.slice(restrictionIndex + 1)) {
		assert.doesNotMatch(
			later,
			/apply the schema migration|you may (now )?apply|re-?authoriz/i,
			`no later re-authorization, got: ${later}`,
		);
	}
	assert.match(
		requestPromptText(request),
		/An earlier authorization does not override a later restriction/,
	);
});

/**
 * A2 actual transport: after an accepted AI unlock, the next ordinary user
 * request contains the user work and prior conversation but none of the
 * finalized inquiry protocol or the unlock reason; the quiet status exists
 * exactly once as a UI-only custom entry (excluded from LLM context by the
 * host's custom-entry design).
 */
test("packed next ordinary request after AI unlock has no unlock text or control exchange", {
	timeout: 360_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Deploy work done." },
		{
			kind: "cw",
			action: "unlock",
			reasonType: "JOB_DONE",
			reason: "Requested analysis delivered.",
		},
		{ kind: "text", text: "New ordinary work after unlock." },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Do the analysis.");
		await waitForSessionIdle(session, 60_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "decision request");
		await waitForSessionIdle(session, 60_000, "decision turn");
		// Exactly one quiet UI-only unlock status in stored session entries.
		const branch = session.sessionManager.getBranch();
		const statuses = branch.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "pi-continue-watchdog:ai-unlock",
		);
		assert.equal(statuses.length, 1);
		// New user work after the unlock: its actual provider request excludes
		// the unlock reason and all decision protocol traffic.
		await session.prompt("Start unrelated work.");
		await waitForSessionIdle(session, 60_000, "post-unlock turn");
		const postUnlock = requests.at(-1);
		assert.ok(postUnlock);
		const body = JSON.stringify(postUnlock.messages);
		assert.match(body, /Start unrelated work\./);
		assert.doesNotMatch(body, /Requested analysis delivered\./);
		assert.doesNotMatch(body, /pi-continue-watchdog:inquiry-fold/);
		assert.doesNotMatch(body, /pi-continue-watchdog:inquiry/);
		assert.doesNotMatch(body, /pi-continue-watchdog:ai-unlock/);
		assert.doesNotMatch(body, /Continue watchdog unlocked/);
		assert.doesNotMatch(body, /Decision received\./);
	} finally {
		await shutdownSession(session);
	}
});

test("packed retired wait action is rejected as invalid without waiting effects", {
	timeout: 360_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { maxRetries: 1 },
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "External job pending." },
		// The retired wait payload: copied from the old protocol.
		{
			kind: "cw-invalid",
			text: '{"action":"wait","reason_content":"Waiting for automation.","wait_seconds":30}',
		},
		// The correction is answered with a plain unlock, closing the cycle.
		{ kind: "cw", action: "unlock", reason: "Job settled externally." },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Wait for the job.");
		await waitForSessionIdle(session, 60_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "decision request");
		await waitForSessionIdle(session, 60_000, "decision turn");
		// The retired wait is one invalid response: a correction re-ask follows.
		await waitFor(() => requests.length >= 3, 120_000, "correction request");
		await waitForSessionIdle(session, 60_000, "correction turn");
		// The rejection came from the retired-action validator, not from batch
		// preflight treating duplicated visible JSON as prose: the singleton cw
		// call carried empty visible content, so the correction must carry the
		// retired-action diagnostic itself.
		const correction = requests[2];
		assert.ok(isDecisionRequest(correction), "request 3 is the correction");
		assert.match(
			JSON.stringify(correction.messages),
			/wait is no longer an accepted action\./,
			"correction carries RETIRED_WAIT_ACTION_ERROR",
		);
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		assert.equal(
			envelopes.some((envelope) => envelope.name === "watchdog-waiting"),
			false,
			"no waiting hook for a retired wait payload",
		);
		assert.equal(
			envelopes.some(
				(envelope) =>
					envelope.values &&
					typeof envelope.values === "object" &&
					"WAIT_SECONDS" in envelope.values,
			),
			false,
			"no wait duration value on any hook",
		);
		const ready = envelopes.filter(
			(envelope) => envelope.name === "user-ready",
		);
		// The only terminal signal comes from the explicit correction unlock.
		assert.equal(ready.length, 1);
		assert.deepEqual(ready[0].values, {
			STOP_KIND: "AI_UNLOCK",
			REASON_TYPE: "JOB_DONE",
			REASON: "Job settled externally.",
		});
		// No watchdog deadline timer dispatched additional work after the cycle
		// ended: the request count stays at exactly three.
		await new Promise((resolve) => setTimeout(resolve, 12_000));
		assert.equal(requests.length, 3);
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

/**
 * Native three-response regression for the retired action: three structurally
 * valid singleton cw calls whose payload selects the retired wait action must
 * stop after exactly three invalid decisions with no fourth native follow-up.
 * The mock keeps visible content empty so each response reaches payload
 * validation instead of dying at batch preflight.
 */
test("packed singleton retired waits stop without native follow-up", {
	timeout: 360_000,
}, async (t) => {
	const outputRoot = await mkdtemp(join(tmpdir(), "cw-retired-waits-"));
	const capturePath = join(outputRoot, "requests.json");
	t.after(async () => rm(outputRoot, { recursive: true, force: true }));

	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Work settles." },
		{
			kind: "cw-invalid",
			text: '{"action":"wait","reason_content":"Wait for CI.","wait_seconds":60}',
		},
		{
			kind: "cw-invalid",
			text: '{"action":"wait","reason_content":"Wait for CI.","wait_seconds":60}',
		},
		{
			kind: "cw-invalid",
			text: '{"action":"wait","reason_content":"Wait for CI.","wait_seconds":60}',
		},
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Do the work.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "first decision");
		await waitFor(() => requests.length >= 4, 240_000, "corrections");
		await waitForSessionIdle(session, 60_000, "final decision turn");
		const decisionRequests = requests.filter((request) =>
			isDecisionRequest(request),
		);
		assert.equal(decisionRequests.length, 3);
		// Every correction re-ask carries the retired-action validator
		// diagnostic, proving the wait payload reached payload validation.
		for (const correction of decisionRequests.slice(1)) {
			assert.match(
				JSON.stringify(correction.messages),
				/wait is no longer an accepted action\./,
			);
		}
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		assert.equal(
			envelopes.some((envelope) => envelope.name === "watchdog-waiting"),
			false,
			"no waiting hook for retired wait payloads",
		);
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
		try {
			await writeFile(capturePath, JSON.stringify(requests, null, 2), "utf8");
			await mkdir("/var/tmp/two-outcome-lifecycle/evidence", {
				recursive: true,
			});
			await writeFile(
				"/var/tmp/two-outcome-lifecycle/evidence/packed-singleton-retired-waits.requests.json",
				JSON.stringify(requests, null, 2),
				"utf8",
			);
		} catch {
			// Evidence copy is best-effort; the in-test assertions are the gate.
		}
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

/**
 * A13–A15 continuation input evidence: the actual NEXT ORDINARY request after
 * an accepted continue must still carry the decisive seeded facts (grant /
 * questionnaire result, delivered report + stale hint, unapproved scope,
 * mandatory confirmation, authentication evidence, later read-only
 * restriction) together with the fixed continuation envelope — and nothing
 * else that could add or remove authority.
 *
 * The scripted continue reply only drives request assembly; it is never
 * model-judgment evidence. Facts are asserted from the real serialized
 * provider request captured on the localhost mock.
 */
async function captureContinuationRequest(
	t: TestContext,
	options: {
		readonly label: string;
		readonly seed: (manager: SessionManager) => void;
		readonly reason: string;
	},
): Promise<RequestRecord> {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Ordinary settle turn." },
		{
			kind: "cw",
			action: "continue",
			reasonType: "WORK_REMAINS",
			reason: options.reason,
		},
		{ kind: "text", text: "Continuation ordinary turn." },
		{ kind: "cw", action: "unlock" },
	]);
	const sm = SessionManager.inMemory(fixture.cwd);
	options.seed(sm);
	const { session } = await createSession(fixture, baseUrl, {
		sessionManager: sm,
	});
	try {
		await session.prompt("Kick off the ordinary turn.");
		await waitForSessionIdle(session, 60_000, "first turn");
		await waitFor(() => requests.length >= 2, 180_000, "decision request");
		await waitForSessionIdle(session, 60_000, "decision turn");
		await waitFor(() => requests.length >= 3, 180_000, "continuation request");
		const continuationRequest = requests[2];
		assert.ok(continuationRequest, "expected a continuation request");
		assert.ok(
			!isDecisionRequest(continuationRequest),
			"the captured request is the next ordinary request, not the inquiry",
		);
		const evidenceDir = "/var/tmp/two-outcome-lifecycle/evidence";
		try {
			await mkdir(evidenceDir, { recursive: true });
			await writeFile(
				`${evidenceDir}/${options.label}-continuation.json`,
				JSON.stringify(
					{
						capturedAt: new Date().toISOString(),
						expectedBoundary: options.label,
						request: continuationRequest,
					},
					null,
					2,
				),
				"utf8",
			);
		} catch {
			// Best-effort evidence copy; in-test assertions are the gate.
		}
		return continuationRequest;
	} finally {
		await shutdownSession(session);
	}
}

function assertContinuationEnvelope(request: RequestRecord): void {
	const envelope = request.messages.find((message) =>
		contentText(message).includes("Continue watchdog · continue ·"),
	);
	assert.ok(envelope, "continuation envelope present in the ordinary request");
	const body = contentText(envelope);
	assert.match(body, /Suggested next step: /);
	assert.match(body, /does not revoke or reset permission/);
	assert.doesNotMatch(body, /"reasonType"/);
	assert.doesNotMatch(body, /Previous automated watchdog result/);
}

function assertNoDecisionInternals(request: RequestRecord): void {
	const body = JSON.stringify(request.messages);
	assert.doesNotMatch(
		body,
		/automated continuation check from the pi-continue-watchdog/,
	);
	assert.doesNotMatch(
		body,
		/Your entire response must be exactly one cw function call/,
	);
	assert.doesNotMatch(body, /"name":"cw"/);
}

// A13 continuation — a real user grant plus the assistant's redundant
// re-question survive into the ordinary request that continues the work.
test("packed A13 continuation request keeps the user grant and questionnaire evidence", {
	timeout: 360_000,
}, async (t) => {
	const request = await captureContinuationRequest(t, {
		label: "a13-continuation",
		reason: "Apply the approved schema migration.",
		seed: (sm) => {
			seededUser(sm, "Please apply the schema migration.", 1);
			seededUser(sm, "Yes — apply the schema migration now.", 2);
			seededAssistant(sm, 3, [], "To be safe, may I apply the migration?");
			// Successful correlated questionnaire answer (A13b evidence class).
			seededAssistant(sm, 4, [
				{
					id: "ask-a13",
					name: "ask_followup_question",
					arguments: { question: "Approve the migration apply?" },
				},
			]);
			seededToolResult(
				sm,
				"ask-a13",
				"ask_followup_question",
				"APPROVE — the user selected approval for the schema migration.",
				5,
			);
		},
	});
	const body = JSON.stringify(request.messages);
	assert.match(body, /apply the schema migration now/);
	assert.match(body, /may I apply the migration\?/);
	assert.match(body, /APPROVE — the user selected approval/);
	assertContinuationEnvelope(request);
	assertNoDecisionInternals(request);
	// No new authority: the continuation envelope does not re-grant or widen
	// anything — the only permission records are the genuine user ones.
	const instructions = genuineUserInstructions(request);
	assert.ok(
		instructions.some((text) =>
			text.includes("apply the schema migration now"),
		),
		"grant record survives in the ordinary request",
	);
	for (const text of instructions) {
		assert.doesNotMatch(
			text,
			/you may (now )?apply|permission granted|approved by the watchdog/i,
			`no watchdog-authored authority, got: ${text}`,
		);
	}
});

// A14 continuation — the delivered analysis-only report and the stale plugin
// hint both survive; the continuation envelope subordinates the hint.
test("packed A14 continuation request keeps delivered report and stale hint subordinate", {
	timeout: 360_000,
}, async (t) => {
	const request = await captureContinuationRequest(t, {
		label: "a14-continuation",
		reason: "Verify the remaining analysis follow-up.",
		seed: (sm) => {
			seededUser(
				sm,
				"Analyze the proposal and report its path, task status, validation, and next workflow. Analysis only — do not apply anything.",
				1,
			);
			seededAssistant(
				sm,
				2,
				[],
				"Proposal path: openspec/changes/simplify-watchdog-outcomes-and-presentation. Tasks: 4/6 complete. Validation: npm run check green.",
			);
			sm.appendCustomMessageEntry(
				"pi-continue-watchdog:continuation",
				"Continue watchdog continued · VERIFYING · Report the proposal path, task status, validation result, and next workflow.",
				true,
				{
					version: 1,
					exchangeId: "seed-exchange-a14-c",
					outcome: "continue",
				},
			);
		},
	});
	const body = JSON.stringify(request.messages);
	assert.match(body, /4\/6 complete/);
	assert.match(body, /Analysis only — do not apply anything/);
	assert.match(body, /Continue watchdog continued · VERIFYING/);
	assertContinuationEnvelope(request);
	assertNoDecisionInternals(request);
});

// A15 continuation — unapproved scope, unmet mandatory confirmation,
// authentication evidence, and a later read-only restriction all survive the
// continuation envelope without being overridden by it.
test("packed A15 continuation request keeps every genuine user boundary", {
	timeout: 360_000,
}, async (t) => {
	const request = await captureContinuationRequest(t, {
		label: "a15-continuation",
		reason: "Continue the read-only verification work.",
		seed: (sm) => {
			seededUser(
				sm,
				"Refactor the parser module only; do not change production data.",
				1,
			);
			seededAssistant(
				sm,
				2,
				[],
				"I propose an additional step: drop the production database and rebuild it from scratch.",
			);
			seededUser(
				sm,
				"Run the deployment pipeline. Before the destructive cutover, require a separate reply of APPROVE CUTOVER. Starting the pipeline is not that confirmation.",
				3,
			);
			seededAssistant(
				sm,
				4,
				[],
				"The required separate confirmation has not been given yet.",
			);
			seededUser(sm, "Publish the signed release artifact.", 5);
			seededAssistant(sm, 6, [
				{
					id: "auth-a15",
					name: "check_release_authentication",
					arguments: { artifact: "release.tar.gz" },
				},
			]);
			seededToolResult(
				sm,
				"auth-a15",
				"check_release_authentication",
				JSON.stringify({
					signingDevice: "awaiting_user_confirmation",
					registryCredentials: "missing",
				}),
				7,
			);
			seededUser(
				sm,
				"From now on, only read-only exploration; do not change anything.",
				8,
			);
		},
	});
	const body = JSON.stringify(request.messages);
	assert.match(body, /parser module only; do not change production data/);
	assert.match(body, /drop the production database/);
	assert.match(body, /separate reply of APPROVE CUTOVER/);
	assert.match(body, /awaiting_user_confirmation/);
	assert.match(body, /Publish the signed release artifact/);
	assert.match(body, /only read-only exploration/);
	assertContinuationEnvelope(request);
	assertNoDecisionInternals(request);
	// Ordering: the read-only restriction is the latest genuine user scope
	// record; the continuation envelope adds none after it.
	const instructions = genuineUserInstructions(request);
	const restrictionIndex = instructions.findIndex((text) =>
		text.includes("only read-only exploration"),
	);
	assert.ok(restrictionIndex >= 0, "restriction record survives");
	const afterRestriction = instructions.slice(restrictionIndex + 1);
	assert.deepEqual(
		afterRestriction.filter(
			(text) => !text.includes("Kick off the ordinary turn."),
		),
		[],
		"no user record after the restriction except the live turn",
	);
});

/**
 * 2.1/2.2/3.1 — real disk-backed same-JSONL association. A completed exchange
 * persists the bounded view in the owned inquiry body, nested review metadata
 * on the hidden marker, the normalized response on the hidden audit, and the
 * canonical fold — all under the same attempt, readable after a fresh-process
 * reopen of the exact same session file. Deterministic localhost fixture
 * provider only; input fidelity is asserted, not model accuracy.
 */
test("packed disk-backed session persists and reopens the review association", {
	timeout: 360_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const sessionDir = join(fixture.root, "sessions");
	await mkdir(sessionDir, { recursive: true });
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Delivered the migration report." },
		{
			kind: "cw",
			action: "unlock",
			reasonType: "JOB_DONE",
			reason: "Migration report delivered.",
		},
	]);
	const sm = SessionManager.create(fixture.cwd, sessionDir);
	const excludedId = sm.appendMessage({
		role: "bashExecution",
		command: "echo LOCAL_ONLY_COMMAND_SENTINEL",
		output: "LOCAL_ONLY_OUTPUT_SENTINEL",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		excludeFromContext: true,
		timestamp: 1,
	});
	const includedId = sm.appendMessage({
		role: "bashExecution",
		command: "echo INCLUDED_COMMAND_SENTINEL",
		output: "INCLUDED_OUTPUT_SENTINEL",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 2,
	});
	let session: AgentSession | undefined;
	try {
		({ session } = await createSession(fixture, baseUrl, {
			sessionManager: sm,
		}));
		await session.prompt("Report the migration status.");
		await waitForSessionIdle(session, 60_000, "first turn");
		await waitFor(() => requests.length >= 2, 120_000, "decision request");
		await waitForSessionIdle(session, 60_000, "decision turn");

		const decisionRequest = requests.find((request) =>
			isDecisionRequest(request),
		);
		assert.ok(decisionRequest, "expected a serialized inquiry request");
		const inquiryBody = requestPromptText(decisionRequest);
		// The same inquiry carries the bounded provenance-labelled view.
		assert.match(
			inquiryBody,
			/Source evidence \(bounded excerpts; omissions are not proof of absence/,
		);
		assert.match(inquiryBody, /Report the migration status\./);
		assert.match(inquiryBody, /Delivered the migration report\./);
		assert.match(inquiryBody, /INCLUDED_COMMAND_SENTINEL/);
		assert.match(inquiryBody, /INCLUDED_OUTPUT_SENTINEL/);
		assert.doesNotMatch(
			JSON.stringify(requests),
			/LOCAL_ONLY_(COMMAND|OUTPUT)_SENTINEL/,
		);
		assert.ok(
			sm.getEntry(excludedId),
			"native excluded record is retained locally",
		);

		const sessionFile = sm.getSessionFile();
		assert.ok(sessionFile !== undefined, "session must be disk-backed");
		// Fresh-process reopen: a separate Node/tsx process, running from the
		// fixture install root where @earendil-works/pi-coding-agent resolves,
		// reads the same JSONL with zero shared memory. Any assertion failure
		// inside surfaces as a non-zero exit code on execFileAsync.
		const verifyScript = join(fixture.installRoot, "verify-reopen.mts");
		await writeFile(
			verifyScript,
			`import assert from "node:assert/strict";\n` +
				`import { SessionManager } from "@earendil-works/pi-coding-agent";\n` +
				`import { readReviewHistory } from ${JSON.stringify(join(fixture.packageDir, "src", "review-context.ts"))};\n` +
				`const sm = SessionManager.open(process.argv[2]);\n` +
				`const branch = sm.getBranch();\n` +
				`const markers = branch.filter((e) => e.type === "custom" && e.customType === "pi-continue-watchdog:inquiry-marker");\n` +
				`assert.equal(markers.length, 1, "marker survives fresh-process reopen");\n` +
				`const review = markers[0].data?.review;\n` +
				`assert.ok(review, "review metadata survives reopen");\n` +
				`assert.equal(review.version, 1);\n` +
				`const audits = branch.filter((e) => e.type === "custom" && e.customType === "pi-continue-watchdog:decision-audit");\n` +
				`assert.equal(audits.length, 1, "audit survives reopen");\n` +
				`assert.equal(audits[0].data?.review?.markerEntryId, markers[0].id);\n` +
				`const folds = branch.filter((e) => e.type === "custom_message" && e.customType === "pi-continue-watchdog:inquiry-fold");\n` +
				`assert.equal(folds.length, 1, "canonical fold survives reopen");\n` +
				`assert.notEqual(sm.getSessionId(), "", "reopened session has identity");\n` +
				`const history = readReviewHistory(sm);\n` +
				`assert.equal(history.records.length, 1);\n` +
				`assert.equal(history.records[0].reviewMetadata, "ok");\n` +
				`assert.equal(history.records[0].responseOutcome, "unlock");\n` +
				`assert.equal(history.records[0].publishedOutcome, "unlock");\n` +
				`assert.equal(history.records[0].status, "published");\n` +
				`const quietUnlock = sm.getEntry(history.records[0].unlockEntryId);\n` +
				`assert.equal(quietUnlock?.customType, "pi-continue-watchdog:ai-unlock");\n` +
				`assert.equal(quietUnlock.data.exchangeId, history.records[0].exchangeId);\n` +
				`assert.equal(quietUnlock.data.cycleId, history.records[0].cycleId);\n` +
				`const prompt = sm.getEntry(history.records[0].promptEntryId);\n` +
				`assert.ok(prompt?.content.includes("Source evidence (bounded excerpts"));\n` +
				`console.log("fresh-process reopen assertions passed");\n`,
		);
		const { stdout: reopenOut } = await execFileAsync(
			process.execPath,
			[
				"--import",
				join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
				verifyScript,
				sessionFile,
			],
			{ cwd: fixture.installRoot, timeout: 60_000 },
		);
		assert.match(reopenOut, /fresh-process reopen assertions passed/);
		const branch = sm.getBranch();
		const storedInquiry = branch.find(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "pi-continue-watchdog:inquiry",
		);
		assert.ok(
			storedInquiry?.type === "custom_message" &&
				typeof storedInquiry.content === "string",
		);
		assert.ok(
			inquiryBody.includes(storedInquiry.content),
			"persisted inquiry equals the assembled model-facing input",
		);
		const markers = branch.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "pi-continue-watchdog:inquiry-marker",
		);
		assert.equal(markers.length, 1);
		const markerData = (markers[0] as { data?: unknown }).data as Record<
			string,
			unknown
		>;
		const markerReview = markerData.review as
			| Record<string, unknown>
			| undefined;
		assert.ok(markerReview, "marker carries nested review metadata");
		assert.equal(markerReview.version, 1);
		assert.ok(
			Array.isArray(markerReview.selectedSources) &&
				(markerReview.selectedSources as unknown[]).length > 0,
			"review records selected source ids",
		);
		const selectedSources = markerReview.selectedSources as { id: string }[];
		assert.ok(selectedSources.some((source) => source.id === includedId));
		assert.ok(selectedSources.every((source) => source.id !== excludedId));
		assert.notEqual(markerReview.sourceHeadId, excludedId);
		const audits = branch.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "pi-continue-watchdog:decision-audit",
		);
		assert.equal(audits.length, 1);
		const auditData = (audits[0] as { data?: unknown }).data as Record<
			string,
			unknown
		>;
		assert.equal(auditData.exchangeId, markerData.exchangeId);
		assert.equal(auditData.outcome, "unlock");
		const auditReview = auditData.review as Record<string, unknown> | undefined;
		assert.ok(auditReview, "audit carries the review association");
		assert.equal(auditReview.version, 1);
		assert.equal(auditReview.markerEntryId, markers[0].id);
		// Canonical fold correlates the published outcome on the same attempt.
		const folds = branch.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "pi-continue-watchdog:inquiry-fold",
		);
		assert.equal(folds.length, 1);
		const foldDetails = (folds[0] as { details?: unknown }).details as Record<
			string,
			unknown
		>;
		assert.equal(foldDetails.watchdogOutcome, "unlock");
		// No extra review entry type, sidecar, or second model request exists.
		assert.equal(
			branch.filter(
				(entry) =>
					entry.type === "custom" &&
					String((entry as { customType?: unknown }).customType).includes(
						"review",
					),
			).length,
			0,
		);
		assert.equal(requests.filter(isDecisionRequest).length, 1);
	} finally {
		// Real cleanup on the live session, then reopen assertions run against
		// the persisted file — never mask a mid-test failure behind them.
		if (session !== undefined) {
			await shutdownSession(session);
		}
	}
});
