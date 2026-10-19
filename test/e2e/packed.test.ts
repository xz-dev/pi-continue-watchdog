import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
	access,
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
	readonly model?: string;
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
		| "write"
		| "cw-invalid"
		| "cw-mixed"
		| "delayed"
		| "connection-error";
	readonly action?: "continue" | "unlock";
	readonly mixedToolName?: string;
	readonly mixedToolArguments?: Record<string, unknown>;
	readonly reasonType?: string;
	readonly reason?: string;
	/**
	 * Raw decision JSON. Legacy cw/cw-invalid shorthand becomes a stock write
	 * only for a private result-file request; ordinary cw stays an ordinary tool.
	 */
	readonly args?: Record<string, unknown>;
	readonly started?: () => void;
	readonly closed?: () => void;
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
			// Use the declared exact SDK baseline for the isolated fixture host.
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
				response.on("close", () => reply.closed?.());
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
			if (
				reply.kind === "cw" ||
				reply.kind === "cw-invalid" ||
				reply.kind === "cw-mixed" ||
				reply.kind === "write"
			) {
				// Keep visible text separate from tool arguments for legacy and file results.
				let argumentsJson =
					reply.args !== undefined
						? JSON.stringify(reply.args)
						: reply.kind === "cw-invalid"
							? (reply.text ?? "{}")
							: JSON.stringify({
									action: reply.action ?? "unlock",
									reason_type: reply.reasonType ?? "JOB_DONE",
									reason_content:
										reply.reason ?? "All requested work is complete.",
								});
				const privateFileResponse =
					reply.kind === "write" ||
					payload.messages.some((message) =>
						contentText(message).includes("<watchdog_result_file>"),
					);
				if (privateFileResponse) {
					const text = payload.messages
						.map((message) => {
							if (typeof message.content === "string") return message.content;
							if (!Array.isArray(message.content)) return "";
							return message.content
								.flatMap((block) =>
									typeof block?.text === "string" ? [block.text] : [],
								)
								.join("\n");
						})
						.join("\n");
					const marker = [
						...text.matchAll(
							/<watchdog_result_file>(.*?)<\/watchdog_result_file>/gs,
						),
					].at(-1)?.[1];
					if (marker === undefined) {
						response.writeHead(400).end(
							JSON.stringify({
								error: { message: "Missing private result file marker" },
							}),
						);
						return;
					}
					argumentsJson = JSON.stringify({
						path: JSON.parse(marker),
						content: argumentsJson,
					});
					reply.started?.();
				}
				sendSse(response, [
					{
						id,
						model: "watchdog-e2e",
						choices: [
							{
								index: 0,
								delta: {
									content: reply.kind === "cw-mixed" ? (reply.text ?? "") : "",
									tool_calls: [
										{
											index: 0,
											id: `call-${requests.length}`,
											type: "function",
											function: {
												name: privateFileResponse ? "write" : TOOL_NAME,
												arguments: argumentsJson,
											},
										},
										...(reply.kind === "cw-mixed"
											? [
													{
														index: 1,
														id: `other-${requests.length}`,
														type: "function",
														function: {
															name: reply.mixedToolName ?? "bash",
															arguments: JSON.stringify(
																reply.mixedToolArguments ?? {
																	command: "echo side-effect",
																},
															),
														},
													},
												]
											: []),
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
			.extensions.find((extension) =>
				extension.path.startsWith(fixture.packageDir),
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
			sessionManager:
				options?.sessionManager ??
				SessionManager.create(cwd, join(fixture.root, "sessions")),
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
		contentText(message).includes("<watchdog_result_file>"),
	);
}

async function waitForReady(
	fixture: PackedFixture & { readonly probeOut?: string },
	stopKind = "AI_UNLOCK",
): Promise<void> {
	assert.ok(fixture.probeOut, "terminal receipt requires a semantic probe");
	const probeOut = fixture.probeOut;
	await waitFor(
		() =>
			readFileSync(probeOut, "utf8")
				.split("\n")
				.filter(Boolean)
				.some((line) => {
					const record = JSON.parse(line);
					return (
						record.kind === "semantic-hook" &&
						record.data?.name === "user-ready" &&
						record.data?.values?.STOP_KIND === stopKind
					);
				}),
		45_000,
		`private ${stopKind} publication`,
	);
}

test("packed native abort hides only the owned assistant notice through real Pi rendering", {
	timeout: 180_000,
}, async (t) => {
	initTheme("dark", false);
	const fixture = await makePackedFixture(t);
	// Private decisions have no parent assistant to render or abort. Their
	// cancellation/non-disclosure is covered by the private-stream cases below.
	for (const kind of ["continuation", "ordinary"] as const) {
		await t.test(kind, { timeout: 35_000 }, async (sub) => {
			const replies: MockReply[] = [];
			if (kind !== "ordinary")
				replies.push({ kind: "text", text: "Initial work." });
			if (kind === "continuation")
				replies.push({
					kind: "cw",
					action: "continue",
					reasonType: "WORK_REMAINS",
					reason: "Finish the work.",
				});
			replies.push({
				kind: "delayed",
				text: "partial native output",
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
				await waitFor(
					() => rendered.some((view) => view.includes("partial native output")),
					5_000,
					"partial rendering",
				);
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
					kind === "continuation" ? 2 : 1,
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
					`Pi native abort frames: ${JSON.stringify(abortFrames)}`,
				);
				assert.match(finalView, /partial native output/);
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

test("packed ordinary and private requests expose no watchdog result function", {
	timeout: 180_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Working." },
		{ kind: "cw", action: "unlock" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Do the work.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 45_000, "decision request");
		for (const request of requests) {
			assert.equal(
				(request.tools ?? []).some((tool) => tool.function?.name === TOOL_NAME),
				false,
			);
			assert.equal(
				(request.tools ?? []).some(
					(tool) => tool.function?.name === "structured_output",
				),
				false,
			);
			assert.ok(
				(request.tools ?? []).some((tool) => tool.function?.name === "write"),
			);
		}
		assert.doesNotMatch(
			JSON.stringify(requests[0].messages),
			/<watchdog_result_file>/,
		);
		assert.match(
			JSON.stringify(requests[1].messages),
			/<watchdog_result_file>/,
		);
		// No startup usage guidance advertises the protocol in ordinary requests.
		for (const request of requests) {
			for (const message of request.messages) {
				assert.doesNotMatch(
					contentText(message),
					/call cw now|Submit exactly one cw function call/,
				);
			}
		}
		await waitForReady(fixture);
	} finally {
		await shutdownSession(session);
	}
});

test("packed idle settlement opens one inquiry before continuation", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
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
		await waitFor(() => requests.length >= 2, 45_000, "decision request");
		const decisionRequest = requests[1];
		assert.ok(isDecisionRequest(decisionRequest), "request 2 is the inquiry");
		assert.match(
			contentText(decisionRequest.messages.at(-1) ?? ({ role: "" } as never)),
			new RegExp(DECISION_PROMPT_MARKER),
		);
		// The accepted continue publishes one ordinary continuation turn.
		await waitFor(() => requests.length >= 3, 15_000, "continuation request");
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
		await waitFor(() => requests.length >= 4, 45_000, "next decision");
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
		await waitForReady(fixture);
	} finally {
		await shutdownSession(session);
	}
});

test("packed unowned ordinary cw stays a native unknown tool and ordinary work continues", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl, requests } = await startMockServer(t, [
		// Ordinary run tries to stop through cw before any decision exists.
		{ kind: "cw", action: "unlock", reason: "Stopping proactively." },
		// Native unknown-tool handling, not watchdog reservation, resumes work.
		{ kind: "text", text: "Continued ordinary work." },
		{ kind: "cw", action: "unlock" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Try to stop early.");
		await waitForSessionIdle(session, 60_000, "first turn");
		// Unknown tool does not terminate the run: Pi follows up normally.
		await waitFor(() => requests.length >= 2, 45_000, "follow-up request");
		await waitForSessionIdle(session, 30_000, "second turn");
		const nativeError = requests[1].messages.find(
			(message) => message.role === "tool" && message.tool_call_id,
		);
		assert.ok(nativeError);
		assert.match(contentText(nativeError), /Tool cw not found/);
		assert.doesNotMatch(contentText(nativeError), /reserved for the plugin/);
		assert.equal(requests.slice(0, 2).some(isDecisionRequest), false);
		assert.equal(
			session.sessionManager
				.getBranch()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "pi-continue-watchdog:private-response",
				),
			false,
		);
		// No unlock hook fired for the unowned call.
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

test("packed malformed ordinary cw receives a native error and ordinary work continues", {
	timeout: 180_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "cw", args: { action: "bogus" } },
		{ kind: "text", text: "Ordinary work continued after validation." },
	]);
	const notifications: string[] = [];
	const { session } = await createSession(fixture, baseUrl, {
		uiContext: createRpcUiContext(notifications),
	});
	try {
		await session.prompt(
			"Continue ordinary work after rejecting invalid arguments.",
		);
		await waitForSessionIdle(session, 30_000, "ordinary native rejection");
		assert.equal(
			requests.length,
			2,
			"native error must allow an ordinary follow-up",
		);
		assert.equal(requests.some(isDecisionRequest), false);
		const nativeError = requests[1].messages.find(
			(message) => message.role === "tool" && message.tool_call_id,
		);
		assert.ok(
			nativeError,
			"follow-up must receive the actual native tool result",
		);
		assert.match(contentText(nativeError), /Tool cw not found/);
		assert.doesNotMatch(contentText(nativeError), /reserved for the plugin/);
		const branch = session.sessionManager.getBranch();
		assert.ok(
			branch.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					contentText(entry.message).includes(
						"Ordinary work continued after validation.",
					),
			),
			"ordinary response must complete rather than terminate at the schema error",
		);
		assert.equal(
			branch.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "pi-continue-watchdog:decision-audit",
			),
			false,
			"ordinary malformed call must not be accounted as a decision response",
		);
		await session.prompt("/status-continue-watchdog");
		assert.match(notifications.at(-1) ?? "", /Lock: locked/);
		assert.match(notifications.at(-1) ?? "", /Attempt: 0\//);
		assert.equal(requests.length, 2, "status inspection must not start work");
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		assert.equal(
			envelopes.some(
				(envelope) =>
					envelope.name === "user-ready" ||
					envelope.name === "watchdog-continued",
			),
			false,
			"native rejection must neither unlock nor publish a continuation",
		);
	} finally {
		await shutdownSession(session);
	}
});

test("packed foreign cw ownership survives ordinary work and private decisions", {
	timeout: 150_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const foreignPath = join(fixture.root, "foreign-cw.mjs");
	const callsPath = join(fixture.root, "foreign-calls.jsonl");
	await writeFile(callsPath, "");
	await writeFile(
		foreignPath,
		`
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.registerTool({
    name: "cw", label: "Foreign cw", description: "Foreign owned work tool",
    parameters: { type: "object", properties: { action: { type: "string" } } },
    async execute(_id, args) {
      appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
      return { content: [{ type: "text", text: "FOREIGN_CW_RESULT" }], details: {} };
    },
  });
}
`,
	);
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "cw", action: "unlock", reason: "Foreign tool, not a decision." },
		{ kind: "text", text: "Ordinary work after foreign result." },
		{ kind: "cw", action: "unlock", reason: "Private decision accepted." },
	]);
	const { session } = await createSession(fixture, baseUrl, {
		additionalExtensionPaths: [foreignPath],
	});
	try {
		await session.prompt("Use the foreign work tool, then deliver the report.");
		assert.equal(requests.length, 2);
		assert.match(requestPromptText(requests[1]), /FOREIGN_CW_RESULT/);
		assert.doesNotMatch(
			requestPromptText(requests[1]),
			/reserved for the plugin/,
		);
		assert.equal(
			(await readFile(callsPath, "utf8")).trim().split("\n").length,
			1,
		);
		assert.equal((await readProbeEnvelopes(fixture.probeOut ?? "")).length, 0);
		await waitForReady(fixture);
		assert.equal(requests.length, 3);
		assert.ok(isDecisionRequest(requests[2]));
		for (const request of requests) {
			const declared = request.tools?.filter(
				(tool) => tool.function?.name === TOOL_NAME,
			);
			assert.equal(declared?.length, 1);
			assert.equal(
				declared?.[0].function?.description,
				"Foreign owned work tool",
			);
		}
		assert.equal(
			(await readFile(callsPath, "utf8")).trim().split("\n").length,
			1,
		);
		const ready = (await readProbeEnvelopes(fixture.probeOut ?? "")).filter(
			(entry) => entry.name === "user-ready",
		);
		assert.equal(ready.length, 1);
		assert.equal(
			(ready[0].values as { REASON?: string }).REASON,
			"Private decision accepted.",
		);
	} finally {
		await shutdownSession(session);
	}
});

test("packed independent public pi-subagents keeps its surface and cannot select the private agent", {
	timeout: 180_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { unlockReviewEnabled: false },
	});
	await execFileAsync(
		"npm",
		[
			"install",
			"--prefer-offline",
			"--no-audit",
			"--no-fund",
			"--allow-git=all",
			"--save-exact",
			"pi-subagents@0.79.0",
		],
		{ cwd: fixture.installRoot, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
	);
	const publicDir = join(fixture.installRoot, "node_modules", "pi-subagents");
	const publicManifest = JSON.parse(
		await readFile(join(publicDir, "package.json"), "utf8"),
	);
	assert.equal(publicManifest.version, "0.79.0");
	assert.ok(publicManifest.pi?.extensions?.length > 0);
	const agentDir = join(fixture.agentDir, "agents");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "watchdog-decision.md"),
		"---\nname: watchdog-decision\ndescription: Public same-name fixture\nmodel: unavailable-public-model\ntools: bash\n---\nPUBLIC_AGENT_PROFILE_MUST_NOT_SELECT_PRIVATE_MODEL\n",
	);
	const { baseUrl, requests } = await startMockServer(t, [
		{
			kind: "text",
			text: "Ordinary work delivered with public subagents installed.",
		},
		{
			kind: "write",
			action: "unlock",
			reason: "Private co-installed decision.",
		},
	]);
	const { session } = await createSession(fixture, baseUrl, {
		additionalExtensionPaths: [
			join(publicDir, publicManifest.pi.extensions[0]),
		],
	});
	try {
		const before = session
			.getAllTools()
			.map((tool) => tool.name)
			.sort();
		assert.ok(
			before.some((name) => name.startsWith("subagent")),
			"independent public extension really registered its surface",
		);
		assert.equal(new Set(before).size, before.length);
		assert.equal(
			before.includes("cw") || before.includes("structured_output"),
			false,
		);
		await session.prompt("Deliver the authorized report.");
		await waitForReady(fixture);
		assert.equal(
			requests.length,
			2,
			"public install adds no private dispatch or follow-up",
		);
		assert.equal(requests[0].model, "watchdog-e2e");
		assert.equal(requests[1].model, requests[0].model);
		assert.ok(isDecisionRequest(requests[1]));
		assert.doesNotMatch(
			JSON.stringify(requests[1]),
			/unavailable-public-model/,
		);
		assert.deepEqual(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
			before,
		);
		assert.doesNotMatch(
			JSON.stringify(session.sessionManager.getBranch()),
			/watchdog_result_file|subagent_instructions/,
		);
		const privateManifest = JSON.parse(
			await readFile(
				join(
					fixture.packageDir,
					"node_modules",
					"watchdog-subagents-runtime",
					"package.json",
				),
				"utf8",
			),
		);
		assert.deepEqual(Object.keys(privateManifest.exports), [
			"./watchdog-runtime",
		]);
		assert.equal(privateManifest.pi, undefined);
		assert.ok(
			publicManifest.pi.extensions.length > 0,
			"private preparation did not strip public package metadata",
		);
	} finally {
		await shutdownSession(session);
	}
});

test("packed private mixed tools and reply-only JSON require file correction without effects", {
	timeout: 180_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { unlockReviewEnabled: false },
	});
	for (const kind of ["bash", "unknown-work-tool", "reply-only"] as const) {
		await t.test(kind, { timeout: 50_000 }, async (sub) => {
			await writeFile(fixture.probeOut ?? "", "");
			let beforeCorrection: string | undefined;
			const sideEffect = join(fixture.root, `forbidden-${kind}`);
			const { baseUrl, requests } = await startMockServer(sub, [
				{ kind: "text", text: "Ordinary work delivered." },
				kind === "reply-only"
					? {
							kind: "text",
							text: '{"action":"unlock","reason_type":"JOB_DONE","reason_content":"Prose is not a result."}',
						}
					: {
							kind: "cw-mixed",
							mixedToolName: kind,
							mixedToolArguments: {
								command: `touch ${JSON.stringify(sideEffect)}`,
							},
						},
				{
					kind: "cw",
					action: "unlock",
					reason: "File corrected.",
					started: () => {
						const marker = [
							...requestPromptText(requests[1]).matchAll(
								/<watchdog_result_file>(.*?)<\/watchdog_result_file>/gs,
							),
						].at(-1)?.[1];
						assert.ok(marker);
						beforeCorrection = readFileSync(JSON.parse(marker), "utf8");
					},
				},
			]);
			const { session } = await createSession(fixture, baseUrl);
			try {
				await session.prompt("Deliver the authorized work only.");
				await waitForReady(fixture);
				assert.equal(
					requests.length,
					3,
					"one invalid response, one private correction, no tool follow-up",
				);
				assert.equal(
					beforeCorrection,
					"{}",
					"correction starts with reset result file",
				);
				await assert.rejects(access(sideEffect), { code: "ENOENT" });
				const correction = requestPromptText(requests[2]);
				assert.match(correction, /failed validation/);
				assert.match(
					correction,
					kind === "reply-only"
						? /action/
						: /Expected exactly one write call to the designated decision result file/,
				);
				const branch = session.sessionManager.getBranch();
				const responses = branch.filter(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "pi-continue-watchdog:private-response",
				);
				assert.equal(responses.length, 2);
				const audits = responses.map(
					(entry) =>
						(
							entry as {
								data: {
									sessionId: string;
									attempt: number;
									outcome: { kind: string };
								};
							}
						).data,
				);
				assert.equal(audits[0].sessionId, audits[1].sessionId);
				const sessionDir = join(fixture.root, "sessions");
				const transcripts = await Promise.all(
					(await readdir(sessionDir, { recursive: true }))
						.filter((path) => path.endsWith(".jsonl"))
						.map(async (path) =>
							(await readFile(join(sessionDir, path), "utf8"))
								.split("\n")
								.filter(Boolean)
								.map((line) => JSON.parse(line)),
						),
				);
				const child = transcripts.find(
					(rows) => rows[0]?.id === audits[0].sessionId,
				);
				assert.ok(child, "private transcript must identify the audited child");
				const toolResults = child.filter(
					(row) => row.type === "message" && row.message?.role === "toolResult",
				);
				assert.equal(
					toolResults.some((row) =>
						["call-2", "other-2"].includes(row.message.toolCallId),
					),
					false,
					"invalid batch executes neither result write nor other tool",
				);
				assert.ok(
					toolResults.some((row) => row.message.toolCallId === "call-3"),
					"valid correction write really executes",
				);
				assert.deepEqual(
					audits.map((audit) => [audit.attempt, audit.outcome.kind]),
					[
						[1, "invalid"],
						[2, "valid"],
					],
				);
				assert.doesNotMatch(
					JSON.stringify(branch),
					/watchdog_result_file|subagent_instructions|side-effect|Prose is not a result/,
				);
				assert.equal(
					branch.filter(
						(entry) =>
							entry.type === "message" && entry.message.role === "assistant",
					).length,
					1,
				);
			} finally {
				await shutdownSession(session);
			}
		});
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
		await waitFor(() => requests.length >= 2, 45_000, "decision request");
		await waitForReady(fixture, "AI_UNLOCK");
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
	const sm = SessionManager.create(fixture.cwd, join(fixture.root, "sessions"));
	options.seed(sm);
	const { session } = await createSession(fixture, baseUrl, {
		sessionManager: sm,
	});
	try {
		await session.prompt("Kick off the ordinary turn.");
		await waitForSessionIdle(session, 60_000, "first turn");
		await waitFor(() => requests.length >= 2, 45_000, "decision request");
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
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
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
		await waitFor(() => requests.length >= 2, 45_000, "decision request");
		await waitForReady(fixture);
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
		watchdogConfig: { maxContinue: 1 },
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
		await waitFor(() => requests.length >= 2, 45_000, "decision request");
		// The retired wait is one invalid response: a correction re-ask follows.
		await waitFor(() => requests.length >= 3, 15_000, "correction request");
		// The rejection came from the retired-action validator, not from batch
		// preflight: the stock write carried only the result file, so correction
		// must carry the
		// retired-action diagnostic itself.
		const correction = requests[2];
		assert.ok(isDecisionRequest(correction), "request 3 is the correction");
		assert.match(
			JSON.stringify(correction.messages),
			/wait is no longer an accepted action\./,
			"correction carries RETIRED_WAIT_ACTION_ERROR",
		);
		await waitForReady(fixture, "AI_UNLOCK");
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
		{ kind: "cw-invalid", text: "[]" },
		{ kind: "cw-invalid", text: "{}" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Do the work.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 45_000, "first decision");
		await waitFor(() => requests.length >= 4, 15_000, "corrections");

		const decisionRequests = requests.filter((r) => isDecisionRequest(r));
		assert.equal(decisionRequests.length, 3);
		await waitForReady(fixture, "DECISION_FAILED");
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
 * Three retired-action files consume exactly three private responses, with
 * concrete validator feedback and no fourth response or ordinary work.
 */
test("packed singleton retired wait files stop without native follow-up", {
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
		await waitFor(() => requests.length >= 2, 45_000, "first decision");
		await waitFor(() => requests.length >= 4, 15_000, "corrections");
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
		await waitForReady(fixture, "DECISION_FAILED");
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
			args: {
				action: " UNLOCK ",
				reason_type: " needreview ",
				reason_content: " PR awaits review. ",
			},
		},
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Ship it.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 45_000, "decision request");
		await waitForReady(fixture);
		// Effective reason spelling is guidance for file validation, never a
		// public result-function schema. Padded/mixed-case JSON still normalizes.
		const prompt = requestPromptText(requests[1]);
		for (const reason of ["NeedReview", "shipped", "WORK_REMAINS", "VERIFYING"])
			assert.ok(prompt.includes(reason), `private guidance includes ${reason}`);
		assert.equal(
			requests
				.flatMap((request) => request.tools ?? [])
				.some((tool) => tool.function?.name === TOOL_NAME),
			false,
		);
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		const ready = envelopes.filter(
			(envelope) => envelope.name === "user-ready",
		);
		assert.equal(ready.length, 1);
		assert.equal(
			(ready[0].values as { REASON_TYPE?: string }).REASON_TYPE,
			"NEEDREVIEW",
		);
		assert.equal(
			(ready[0].values as { REASON?: string }).REASON,
			"PR awaits review.",
		);
	} finally {
		await shutdownSession(session);
	}
});

/** Invalid JSON fields consume bounded private corrections, never native
 * schema-error follow-ups or ordinary continuation budget. */
test("packed invalid file payloads stop before native follow-up", {
	timeout: 360_000,
}, async (t) => {
	const outputRoot = await mkdtemp(join(tmpdir(), "cw-invalid-payloads-"));
	const capturePath = join(outputRoot, "requests.json");
	t.after(async () => rm(outputRoot, { recursive: true, force: true }));

	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Work settles." },
		// Attempt 1: result file missing every field.
		{ kind: "cw-invalid", text: "{}" },
		// Attempt 2: result file with an invalid action value.
		{
			kind: "cw-invalid",
			text: '{"action":"bogus","reason_type":"JOB_DONE","reason_content":"Bad action."}',
		},
		// Attempt 3: missing action but otherwise plausible fields.
		{
			kind: "cw-invalid",
			text: '{"reason_type":"JOB_DONE","reason_content":"Missing action."}',
		},
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Do the work.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 45_000, "first decision");
		await waitFor(() => requests.length >= 4, 15_000, "corrections");
		const decisionRequests = requests.filter((request) =>
			isDecisionRequest(request),
		);
		assert.equal(decisionRequests.length, 3);
		// Corrections carry the safe validator diagnostic, never the raw
		// invalid payload or a native JSON-schema error dump.
		for (const correction of decisionRequests.slice(1)) {
			assert.match(JSON.stringify(correction.messages), /failed validation/);
			assert.doesNotMatch(
				JSON.stringify(correction.messages),
				/Validation failed for tool/,
			);
		}
		await waitForReady(fixture, "DECISION_FAILED");
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
		// No fourth native request follows the third invalid payload: the
		// settlement alone counts once; no continuation retry is charged.
		await new Promise((resolve) => setTimeout(resolve, 12_000));
		assert.equal(requests.length, 4);
	} finally {
		try {
			await writeFile(capturePath, JSON.stringify(requests, null, 2), "utf8");
		} catch {
			// Fixture-owned capture is best-effort; assertions are the gate.
		}
		await shutdownSession(session);
	}
});

/** One invalid file plus one valid correction publishes exactly once. */
test("packed invalid file payload then valid correction settles once", {
	timeout: 360_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { withSemanticProbe: true });
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Work settles." },
		// File-invalid under the contract: action enum violation.
		{
			kind: "cw-invalid",
			text: '{"action":"bogus","reason_type":"JOB_DONE","reason_content":"Wrong action."}',
		},
		{ kind: "cw", action: "unlock", reason: "Corrected." },
	]);
	const { session } = await createSession(fixture, baseUrl);
	try {
		await session.prompt("Do the work.");
		await waitForSessionIdle(session, 30_000, "first turn");
		await waitFor(() => requests.length >= 2, 45_000, "first decision");
		await waitFor(() => requests.length >= 3, 15_000, "correction");
		const decisionRequests = requests.filter((request) =>
			isDecisionRequest(request),
		);
		assert.equal(decisionRequests.length, 2);
		// The correction prompt carries the watchdog's safe diagnostic, not a
		// native schema error or the raw invalid arguments.
		assert.match(
			JSON.stringify(decisionRequests[1].messages),
			/failed validation/,
		);
		await waitForReady(fixture, "AI_UNLOCK");
		const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
		const ready = envelopes.filter(
			(envelope) => envelope.name === "user-ready",
		);
		assert.equal(ready.length, 1);
		assert.equal((ready[0].values as { REASON?: string }).REASON, "Corrected.");
		// No extra native follow-up: ordinary + inquiry + correction = 3.
		await new Promise((resolve) => setTimeout(resolve, 12_000));
		assert.equal(requests.length, 3);
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
	const sm = SessionManager.create(fixture.cwd, join(fixture.root, "sessions"));
	options.seed(sm);
	const { session } = await createSession(fixture, baseUrl, {
		sessionManager: sm,
	});
	try {
		await session.prompt("Kick off the ordinary turn.");
		await waitForSessionIdle(session, 60_000, "first turn");
		await waitFor(() => requests.length >= 2, 45_000, "decision request");
		await waitFor(() => requests.length >= 3, 15_000, "continuation request");
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
	assert.doesNotMatch(
		body,
		/<watchdog_result_file>|<subagent_instructions>|\/decision\.json/,
	);
	assert.doesNotMatch(body, /Source evidence \(bounded excerpts/);
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
 * persists the bounded view, source references, private child/response and
 * accepted outcome in context-excluded native records. Fresh-process reopen,
 * real resume and native compaction must preserve ordinary facts without
 * copying private prompts or file traffic. Localhost fixture only.
 */
test("packed disk-backed session persists private review association through reopen and summary", {
	timeout: 180_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		piSettings: {
			compaction: { enabled: false, reserveTokens: 128, keepRecentTokens: 5 },
			retry: { enabled: false },
		},
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "Delivered the migration report." },
		{
			kind: "cw",
			action: "unlock",
			reasonType: "JOB_DONE",
			reason: "Migration report delivered.",
		},
		{ kind: "text", text: "Resumed ordinary work." },
		{ kind: "text", text: "Native summary of authorized migration work." },
		{ kind: "text", text: "Native summary of authorized migration work." },
	]);
	const sm = SessionManager.create(fixture.cwd, join(fixture.root, "sessions"));
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
	let { session } = await createSession(fixture, baseUrl, {
		sessionManager: sm,
	});
	try {
		await session.prompt("Report the migration status.");
		await waitForReady(fixture);
		const decisionRequest = requests.find(isDecisionRequest);
		assert.ok(decisionRequest, "expected a serialized private request");
		const inquiryBody = requestPromptText(decisionRequest);
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
		assert.ok(sm.getEntry(excludedId), "excluded source remains local");
		const sessionFile = sm.getSessionFile();
		assert.ok(sessionFile, "session must be disk-backed");
		const mainId = sm.getSessionId();
		await shutdownSession(session);

		// Fresh process reconstructs association from native parent records only:
		// no runtime helper, temporary file, child transcript, or process memory.
		const verifyScript = join(fixture.installRoot, "verify-reopen.mts");
		await writeFile(
			verifyScript,
			String.raw`
import assert from "node:assert/strict";
import { SessionManager, convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { readReviewHistory } from ${JSON.stringify(join(fixture.packageDir, "src", "review-context.ts"))};
const sm = SessionManager.open(process.argv[2]);
const branch = sm.getBranch();
const ofType = (type) => branch.filter(e => e.type === "custom" && e.customType === type);
const markers = ofType("pi-continue-watchdog:inquiry-marker");
const decisions = ofType("pi-continue-watchdog:private-decision");
const responses = ofType("pi-continue-watchdog:private-response");
const unlocks = ofType("pi-continue-watchdog:ai-unlock");
assert.equal(markers.length, 1);
assert.equal(decisions.length, 1);
assert.equal(responses.length, 1);
assert.equal(unlocks.length, 1);
const marker = markers[0].data;
const decision = decisions[0].data;
const response = responses[0].data;
const unlock = unlocks[0].data;
const history = readReviewHistory(sm);
assert.equal(history.records.length, 1);
assert.equal(history.records[0].reviewMetadata, "ok");
assert.equal(history.records[0].responseOutcome, "unlock");
assert.equal(history.records[0].publishedOutcome, "unlock");
assert.equal(history.records[0].status, "published");
const reviewEntries = ofType("pi-continue-watchdog:unlock-review");
assert.equal(reviewEntries.length, 1);
assert.equal(reviewEntries[0].data.incompleteReason, "unavailable");
for (const entry of [marker, decision, response]) assert.equal(entry.version, 1);
for (const entry of [marker, decision, response, unlock]) {
  assert.equal(entry.exchangeId, marker.exchangeId);
  assert.equal(entry.cycleId, marker.cycleId);
}
assert.equal(decision.inquiry, "initial");
assert.equal(decision.phase, "started");
assert.notEqual(decision.childSessionId, sm.getSessionId());
assert.equal(response.sessionId, decision.childSessionId);
assert.equal(response.inquiry, "initial");
assert.equal(response.attempt, 1);
assert.equal(response.outcome.kind, "valid");
assert.equal(response.outcome.decision.kind, "unlock");
assert.equal(response.outcome.decision.reason, "Migration report delivered.");
assert.equal(unlock.reason, "Migration report delivered.");
assert.equal(decision.review.version, 1);
assert.deepEqual(decision.review, marker.review);
assert.ok(decision.review.selectedSources.some(source => source.id === ${JSON.stringify(includedId)}));
assert.ok(decision.review.selectedSources.every(source => source.id !== ${JSON.stringify(excludedId)}));
assert.match(decision.sourceView, /Source evidence \(bounded excerpts/);
assert.match(decision.sourceView, /Delivered the migration report/);
const context = JSON.stringify(convertToLlm(branch.flatMap(sessionEntryToContextMessages)));
assert.doesNotMatch(context, /Source evidence|watchdog_result_file|subagent_instructions|Migration report delivered\./);
assert.doesNotMatch(JSON.stringify(branch), /watchdog_result_file|subagent_instructions|\/decision\.json/);
assert.equal(branch.some(e => e.type === "custom_message" && e.customType === "pi-continue-watchdog:inquiry"), false);
console.log("fresh-process private association assertions passed");
`,
		);
		const { stdout } = await execFileAsync(
			process.execPath,
			[
				"--import",
				join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
				verifyScript,
				sessionFile,
			],
			{ cwd: fixture.installRoot, timeout: 30_000 },
		);
		assert.match(stdout, /fresh-process private association assertions passed/);

		const resumed = SessionManager.open(sessionFile);
		assert.equal(resumed.getSessionId(), mainId);
		({ session } = await createSession(fixture, baseUrl, {
			sessionManager: resumed,
		}));
		await session.prompt("Resume authorized migration work.");
		assert.equal(requests.length, 3);
		assert.match(
			requestPromptText(requests[2]),
			/Report the migration status\./,
		);
		assert.match(
			requestPromptText(requests[2]),
			/Delivered the migration report\./,
		);
		assertNoDecisionInternals(requests[2]);
		assert.doesNotMatch(
			requestPromptText(requests[2]),
			/Source evidence|Migration report delivered\./,
		);
		const result = await session.compact();
		assert.match(result.summary, /Native summary of authorized migration work/);
		assert.equal(
			requests.length,
			5,
			"only explicit resume and the two native summary regions add requests",
		);
		const summaries = requests.slice(3);
		const summaryBody = summaries.map(requestPromptText).join("\n");
		assert.match(summaryBody, /Report the migration status\./);
		assert.match(summaryBody, /Delivered the migration report\./);
		for (const request of summaries) assertNoDecisionInternals(request);
		assert.doesNotMatch(
			summaryBody,
			/Source evidence|Migration report delivered\.|LOCAL_ONLY_(COMMAND|OUTPUT)_SENTINEL/,
		);
		assert.ok(resumed.getBranch().some((entry) => entry.type === "compaction"));
	} finally {
		await shutdownSession(session);
	}
});

test("packed private runtime creates a full fork without a developer checkout or public subagents", {
	timeout: 180_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, { includeWatchdog: false });
	await execFileAsync(
		process.execPath,
		["scripts/prepare-private-runtime.mjs"],
		{
			cwd: fixture.packageDir,
			timeout: 30_000,
		},
	);
	const privateDir = join(
		fixture.packageDir,
		"node_modules",
		"watchdog-subagents-runtime",
	);
	const metadata = JSON.parse(
		await readFile(join(privateDir, "package.json"), "utf8"),
	);
	assert.deepEqual(Object.keys(metadata.exports), ["./watchdog-runtime"]);
	assert.equal(metadata.pi, undefined);
	await assert.rejects(
		access(join(fixture.installRoot, "node_modules", "pi-subagents")),
	);
	for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"]) {
		await assert.rejects(
			access(join(fixture.packageDir, "node_modules", "@earendil-works", name)),
		);
		await assert.rejects(
			access(join(privateDir, "node_modules", "@earendil-works", name)),
		);
	}
	const probePath = join(fixture.packageDir, "private-runtime-probe.ts");
	const output = join(fixture.root, "private-runtime-result.json");
	const privateAgentDir = join(fixture.root, "private-agent");
	await writeFile(
		probePath,
		`
import { mkdir, writeFile } from "node:fs/promises";
import { createWatchdogRuntime } from "watchdog-subagents-runtime/watchdog-runtime";
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    const runtime = createWatchdogRuntime();
    const before = pi.getAllTools().map(tool => tool.name);
    let result;
    try {
      await mkdir(${JSON.stringify(privateAgentDir)}, { recursive: true });
      const file = ${JSON.stringify(join(privateAgentDir, "decision.json"))};
      await writeFile(file, "{}", { mode: 0o600 });
      const child = await runtime.fork({
        parent: ctx.sessionManager, parentProviderRegistry: ctx.modelRegistry,
        cwd: ctx.cwd, agentDir: ${JSON.stringify(privateAgentDir)}, resultFile: file,
        model: ctx.model.provider + "/" + ctx.model.id,
      });
      result = { main: ctx.sessionManager.getSessionId(), child: child.sessionId,
        model: child.modelId, before, after: pi.getAllTools().map(tool => tool.name) };
      await child.dispose();
    } finally { await runtime.dispose(); }
    await writeFile(${JSON.stringify(output)}, JSON.stringify(result));
  });
}
`,
	);
	const manager = SessionManager.create(
		fixture.cwd,
		join(fixture.root, "sessions"),
	);
	const timestamp = Date.now() - 1000;
	manager.appendMessage({
		role: "system",
		content: "Packed parent instructions",
		toolsAdded: [],
		timestamp,
	});
	manager.appendMessage({
		role: "user",
		content: "Authorized work",
		timestamp,
	});
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Delivered" }],
		provider: "watchdog-e2e",
		api: "openai-completions",
		model: "watchdog-e2e",
		timestamp,
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const { session } = await createSession(fixture, "http://127.0.0.1:1/v1", {
		additionalExtensionPaths: [probePath],
		sessionManager: manager,
	});
	try {
		const result = JSON.parse(await readFile(output, "utf8"));
		assert.notEqual(result.child, result.main);
		assert.equal(result.model, "watchdog-e2e/watchdog-e2e");
		assert.deepEqual(result.after, result.before);
		assert.equal(result.after.includes("subagent"), false);
		assert.equal(result.after.includes("cw"), false);
	} finally {
		await shutdownSession(session);
	}
});

test("packed production watchdog accepts a private file decision without a main-model round trip", {
	timeout: 180_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { unlockReviewEnabled: false },
		piSettings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "text", text: "The requested summary is delivered." },
		{
			kind: "write",
			action: "unlock",
			reasonType: "JOB_DONE",
			reason: "Summary delivered.",
		},
	]);
	const manager = SessionManager.create(
		fixture.cwd,
		join(fixture.root, "sessions"),
	);
	const { session } = await createSession(fixture, baseUrl, {
		sessionManager: manager,
	});
	const mainId = session.sessionId;
	try {
		await session.prompt("Give the requested summary.");
		assert.equal(requests.length, 1);
		assert.equal(
			requests[0].tools?.some((tool) => tool.function?.name === "cw"),
			false,
			"ordinary requests must not expose a watchdog result function",
		);
		await waitFor(
			() =>
				readFileSync(fixture.probeOut ?? "", "utf8")
					.split("\n")
					.filter(Boolean)
					.some((line) => {
						const record = JSON.parse(line);
						return (
							record.kind === "semantic-hook" &&
							record.data?.name === "user-ready" &&
							record.data?.values?.STOP_KIND === "AI_UNLOCK"
						);
					}),
			45_000,
			"private file decision publication",
		);
		const ready = (await readProbeEnvelopes(fixture.probeOut ?? "")).filter(
			(envelope) => envelope.name === "user-ready",
		);
		assert.equal(ready.length, 1);
		assert.deepEqual(ready[0].values, {
			STOP_KIND: "AI_UNLOCK",
			REASON_TYPE: "JOB_DONE",
			REASON: "Summary delivered.",
		});
		assert.equal(
			requests.length,
			2,
			"only ordinary work and one private write response are needed",
		);
		assert.equal(
			requests[1].messages.some((message) =>
				JSON.stringify(message.content).includes("<watchdog_result_file>"),
			),
			true,
		);
		assert.equal(session.sessionId, mainId);
		const parentFile = manager.getSessionFile();
		assert.ok(parentFile);
		const childHeaders = await Promise.all(
			(await readdir(join(fixture.root, "sessions"), { recursive: true }))
				.filter((path) => path.endsWith(".jsonl"))
				.map(async (path) =>
					JSON.parse(
						(
							await readFile(join(fixture.root, "sessions", path), "utf8")
						).split("\n")[0],
					),
				),
		);
		const forks = childHeaders.filter(
			(header) => header.parentSession === parentFile,
		);
		assert.equal(forks.length, 1);
		assert.notEqual(forks[0].id, mainId);
		assert.doesNotMatch(
			JSON.stringify(manager.getBranch()),
			/<watchdog_result_file>|<subagent_instructions>|\/decision\.json/,
		);
	} finally {
		await shutdownSession(session);
	}
});

const SUBAGENT_CALLBACK_WAKE =
	"Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";

for (const callback of [false, true]) {
	test(`packed private ${callback ? "callback suspension preserves" : "continuation spends"} the final shared budget unit`, {
		timeout: 180_000,
	}, async (t) => {
		const fixture = await makePackedFixture(t, {
			withSemanticProbe: true,
			watchdogConfig: { unlockReviewEnabled: false, maxContinue: 1 },
			piSettings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		const { baseUrl, requests } = await startMockServer(t, [
			{ kind: "text", text: "Work status assessed." },
			{
				kind: "write",
				action: callback ? "unlock" : "continue",
				reasonType: callback ? "WAIT_CALLBACK" : "VERIFYING",
				reason: callback
					? "Waiting for the known callback."
					: "Complete the requested check.",
			},
			{ kind: "text", text: "Final ordinary work completed." },
		]);
		const manager = SessionManager.create(
			fixture.cwd,
			join(fixture.root, "sessions"),
		);
		const { session } = await createSession(fixture, baseUrl, {
			sessionManager: manager,
		});
		const hasStop = (stop: string) =>
			readFileSync(fixture.probeOut ?? "", "utf8")
				.split("\n")
				.filter(Boolean)
				.some((line) => {
					const record = JSON.parse(line);
					return (
						record.kind === "semantic-hook" &&
						record.data?.name === "user-ready" &&
						record.data?.values?.STOP_KIND === stop
					);
				});
		try {
			await session.prompt(
				"Complete the requested work, including its callback when needed.",
			);
			if (callback) {
				await waitFor(
					() => hasStop("WAIT_CALLBACK"),
					45_000,
					"callback suspension",
				);
				assert.equal(requests.length, 2);
				await new Promise((resolve) => setTimeout(resolve, 12_000));
				assert.equal(
					requests.length,
					2,
					"suspension must not poll or spend a new response",
				);
				assert.equal(hasStop("EXHAUSTED"), false);
				await session.prompt(SUBAGENT_CALLBACK_WAKE);
			}
			await waitFor(
				() => hasStop("EXHAUSTED"),
				45_000,
				"final unit exhaustion after actual ordinary work",
			);
			assert.equal(
				requests.length,
				3,
				"the final ordinary work runs with no additional private inquiry",
			);
			const envelopes = await readProbeEnvelopes(fixture.probeOut ?? "");
			assert.equal(
				envelopes.filter((entry) => entry.name === "watchdog-continued").length,
				callback ? 0 : 1,
			);
			assert.equal(
				envelopes.filter((entry) => entry.name === "user-ready").length,
				callback ? 2 : 1,
			);
			assert.doesNotMatch(
				JSON.stringify(requests[2].messages),
				/<watchdog_result_file>|<subagent_instructions>/,
			);
			assert.equal(
				manager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "message" && entry.message.role === "assistant",
					).length,
				2,
			);
		} finally {
			await shutdownSession(session);
		}
	});
}

test("packed manual unlock cancels private initial, correction, and empty streams without aborting main", {
	timeout: 180_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { unlockReviewEnabled: false },
	});
	for (const kind of ["initial", "correction", "empty"] as const) {
		await t.test(kind, { timeout: 50_000 }, async (sub) => {
			await writeFile(fixture.probeOut ?? "", "");
			let privateStarted = false;
			let privateClosed = false;
			const { baseUrl, requests } = await startMockServer(sub, [
				{ kind: "text", text: "Ordinary work delivered." },
				...(kind === "correction"
					? [{ kind: "cw-invalid", text: "{}" } as const]
					: []),
				{
					kind: "delayed",
					text: kind === "empty" ? "" : "private partial output",
					started: () => {
						privateStarted = true;
					},
					closed: () => {
						privateClosed = true;
					},
				},
			]);
			const { session } = await createSession(fixture, baseUrl);
			let mainAborts = 0;
			const unsubscribe = session.subscribe((event) => {
				if (
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.stopReason === "aborted"
				)
					mainAborts++;
			});
			try {
				await session.prompt("Give the requested report.");
				await waitFor(() => privateStarted, 35_000, "private stream started");
				assert.equal(
					session.isStreaming,
					false,
					"private generation must not occupy main run",
				);
				await session.prompt("/unlock-continue-watchdog");
				await waitFor(
					() => privateClosed,
					10_000,
					"exact private stream cancellation",
				);
				await waitForSessionIdle(
					session,
					10_000,
					"manual unlock main readiness",
				);
				assert.equal(requests.length, kind === "correction" ? 3 : 2);
				assert.equal(
					mainAborts,
					0,
					"private cancellation is not parent assistant abort",
				);
				assert.equal(
					(await readProbeEnvelopes(fixture.probeOut ?? "")).filter(
						(entry) => entry.name === "user-ready",
					).length,
					0,
				);
				assert.doesNotMatch(
					JSON.stringify(session.sessionManager.getBranch()),
					/private partial output|Operation aborted|<watchdog_result_file>/,
				);
			} finally {
				unsubscribe();
				await shutdownSession(session);
			}
		});
	}
});

const privateFileCases: Array<{
	name: string;
	outputs: Record<string, unknown>[];
	values: Record<string, string>;
	foreignAudit?: boolean;
}> = [
	{
		name: "context-excluded foreign metadata does not invalidate the source",
		outputs: [
			{
				action: "unlock",
				reason_type: "JOB_DONE",
				reason_content: "Metadata ignored.",
			},
		],
		values: {
			STOP_KIND: "AI_UNLOCK",
			REASON_TYPE: "JOB_DONE",
			REASON: "Metadata ignored.",
		},
		foreignAudit: true,
	},
	{
		name: "invalid file is corrected in the same child",
		outputs: [
			{ reason_type: "JOB_DONE", reason_content: "Missing action." },
			{
				action: "unlock",
				reason_type: "JOB_DONE",
				reason_content: "Corrected.",
			},
		],
		values: {
			STOP_KIND: "AI_UNLOCK",
			REASON_TYPE: "JOB_DONE",
			REASON: "Corrected.",
		},
	},
	{
		name: "third invalid file fails without a fourth response",
		outputs: [{ action: "wait" }, { action: "wait" }, { action: "wait" }],
		values: { STOP_KIND: "DECISION_FAILED" },
	},
];

for (const scenario of privateFileCases) {
	test(`packed production file ${scenario.name}`, {
		timeout: 180_000,
	}, async (t) => {
		const fixture = await makePackedFixture(t, {
			withSemanticProbe: true,
			watchdogConfig: { unlockReviewEnabled: false, maxContinue: 1 },
			piSettings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		const { baseUrl, requests } = await startMockServer(t, [
			{ kind: "text", text: "The requested summary is delivered." },
			...scenario.outputs.map(
				(args): MockReply => ({
					kind: "write",
					args,
					started: scenario.foreignAudit
						? () => {
								manager.appendCustomEntry("foreign:diagnostic", { test: true });
							}
						: undefined,
				}),
			),
		]);
		const manager = SessionManager.create(
			fixture.cwd,
			join(fixture.root, "sessions"),
		);
		const { session } = await createSession(fixture, baseUrl, {
			sessionManager: manager,
		});
		const mainId = session.sessionId;
		let phase = "ordinary reply";
		try {
			await session.prompt("Give the requested summary.");
			assert.equal(
				requests[0].tools?.some((tool) => tool.function?.name === "cw"),
				false,
			);
			phase = "private terminal publication";
			await waitFor(
				() =>
					readFileSync(fixture.probeOut ?? "", "utf8")
						.split("\n")
						.filter(Boolean)
						.some((line) => {
							const record = JSON.parse(line);
							return (
								record.kind === "semantic-hook" &&
								record.data?.name === "user-ready" &&
								record.data?.values?.STOP_KIND === scenario.values.STOP_KIND
							);
						}),
				45_000,
				scenario.name,
			);
			phase = "terminal assertions";
			assert.equal(requests.length, scenario.outputs.length + 1);
			const ready = (await readProbeEnvelopes(fixture.probeOut ?? "")).filter(
				(envelope) => envelope.name === "user-ready",
			);
			assert.equal(ready.length, 1);
			assert.deepEqual(ready[0].values, scenario.values);
			assert.equal(session.sessionId, mainId);
			if (scenario.outputs.length > 1)
				assert.match(JSON.stringify(requests[2].messages), /failed validation/);
			const responseEntries = manager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "pi-continue-watchdog:private-response",
				);
			assert.equal(responseEntries.length, scenario.outputs.length);
			const childIds = new Set<string>();
			for (const entry of responseEntries) {
				assert.ok(
					entry.type === "custom" &&
						entry.data &&
						typeof entry.data === "object" &&
						"sessionId" in entry.data,
				);
				assert.ok(typeof entry.data.sessionId === "string");
				childIds.add(entry.data.sessionId);
			}
			assert.equal(childIds.size, 1);
			assert.equal(childIds.has(mainId), false);
			assert.equal(
				manager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "message" && entry.message.role === "assistant",
					).length,
				1,
			);
			assert.doesNotMatch(
				JSON.stringify(manager.getBranch()),
				/<watchdog_result_file>|<subagent_instructions>|\/decision\.json/,
			);
		} catch (error) {
			console.error(
				"Private file fixture failure:",
				phase,
				"requests:",
				requests.length,
				manager
					.getBranch()
					.slice(-5)
					.map((entry) => ({
						type: entry.type,
						customType: "customType" in entry ? entry.customType : undefined,
					})),
			);
			throw error;
		} finally {
			await shutdownSession(session);
		}
	});
}
