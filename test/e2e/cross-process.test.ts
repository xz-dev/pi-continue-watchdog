import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	chmod,
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

import { DECISION_FOLD_MESSAGE_TYPE } from "../../src/context-fold.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const decisionPromptStart =
	"This is an automated continuation check from the pi-continue-watchdog extension";
const continuePrompt = "Continue until user assistance is required.";

interface RequestRecord {
	readonly receivedAt: number;
	readonly model?: string;
	readonly messages: Array<{
		readonly role?: string;
		readonly content?: unknown;
	}>;
	readonly tools?: Array<{ readonly function?: { readonly name?: string } }>;
}

interface MockReply {
	readonly kind:
		| "stop"
		| "continue"
		| "unlock"
		| "invalid"
		| "delayed"
		| "held-continue"
		| "connection-error";
	readonly reasonType?: string;
	readonly reason?: string;
	readonly started?: () => void;
	readonly release?: Promise<void>;
	readonly text?: string;
	readonly usage?: {
		readonly promptTokens: number;
		readonly completionTokens: number;
	};
}

interface PackedFixture {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	readonly cwd: string;
	readonly packageDir: string;
	readonly runtimeDir: string;
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
	const runtimeDir = join(root, "runtime");
	const installRoot = join(agentDir, "npm");
	await Promise.all([
		mkdir(packDir, { recursive: true }),
		mkdir(cwd, { recursive: true }),
		mkdir(runtimeDir, { recursive: true }),
		mkdir(installRoot, { recursive: true }),
	]);
	await chmod(runtimeDir, 0o700);

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
			// making the reviewed Git dependency transitive to the temporary root.
			// The production Pi Git-clone path instead uses `.npmrc` with the
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
	assert.equal(
		installedManifest.dependencies?.["pi-extension-utils"],
		"git+https://github.com/xz-dev/pi-extension-utils.git#c0a453bcfdbda08b769ef2508c09686b071737ad",
	);
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
	await readFile(join(utilsPackage, "dist", "xml.js"), "utf8");
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
	return { root, home, agentDir, cwd, packageDir, runtimeDir, probeOut };
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

function textOf(message: RequestRecord["messages"][number]): string {
	return JSON.stringify(message.content);
}

function isDecisionRequest(request: RequestRecord): boolean {
	return request.messages.some((message) =>
		textOf(message).includes(decisionPromptStart),
	);
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
			if (reply.kind === "held-continue") {
				reply.started?.();
				void reply.release?.then(() => {
					sendSse(response, [
						{
							id,
							model: "watchdog-e2e",
							choices: [
								{
									index: 0,
									delta: {
										content:
											"<watchdog><function>continue_watchdog</function><reason_type>WORK_REMAINS</reason_type><reason_content>Implementation work remains.</reason_content></watchdog>",
									},
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
				return;
			}
			if (
				reply.kind === "continue" ||
				reply.kind === "unlock" ||
				reply.kind === "invalid"
			) {
				const content =
					reply.kind === "continue"
						? "<watchdog><function>continue_watchdog</function><reason_type>WORK_REMAINS</reason_type><reason_content>Implementation work remains.</reason_content></watchdog>"
						: reply.kind === "unlock"
							? `<watchdog><function>unlock_continue_watchdog</function><reason_type>${reply.reasonType ?? "JOB_DONE"}</reason_type><reason_content>${reply.reason ?? "finished"}</reason_content></watchdog>`
							: (reply.text ?? "invalid watchdog response");
				sendSse(response, [
					{
						id,
						model: "watchdog-e2e",
						choices: [
							{
								index: 0,
								delta: { content },
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
				return;
			}
			const usage =
				reply.usage === undefined
					? undefined
					: {
							prompt_tokens: reply.usage.promptTokens,
							completion_tokens: reply.usage.completionTokens,
							total_tokens:
								reply.usage.promptTokens + reply.usage.completionTokens,
						};
			sendSse(response, [
				{
					id,
					model: "watchdog-e2e",
					choices: [
						{
							index: 0,
							delta: {
								content: reply.text ?? `ordinary-${requests.length}`,
							},
							finish_reason: null,
						},
					],
				},
				{
					id,
					model: "watchdog-e2e",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					...(usage === undefined ? {} : { usage }),
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
		readonly modelId?: string;
		readonly cwd?: string;
		readonly uiContext?: ExtensionUIContext;
		readonly additionalExtensionPaths?: string[];
		readonly sessionManager?: SessionManager;
	},
): Promise<{
	session: AgentSession;
	extensionPath: string;
	loader: DefaultResourceLoader;
	domainEnv: NodeJS.ProcessEnv;
}> {
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousProbeOut = process.env.PI_SEMANTIC_PROBE_OUT;
	const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
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
	process.env.XDG_RUNTIME_DIR = fixture.runtimeDir;
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

		const modelId = options?.modelId ?? "watchdog-e2e";
		const modelRuntime = await ModelRuntime.create({ modelsPath: null });
		modelRuntime.registerProvider("watchdog-e2e", {
			name: "Watchdog E2E",
			baseUrl,
			apiKey: "local-only",
			api: "openai-completions",
			models: [
				{
					id: modelId,
					name: modelId,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: options?.contextWindow ?? 4096,
					maxTokens: options?.maxTokens ?? 128,
				},
			],
		});
		const model = modelRuntime.getModel("watchdog-e2e", modelId);
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
			options?.uiContext === undefined
				? { mode: "print" }
				: { mode: "rpc", uiContext: options.uiContext },
		);
		return {
			session,
			extensionPath: loaded.path,
			loader,
			domainEnv: Object.fromEntries(
				domainNames.map((name) => [name, process.env[name]]),
			),
		};
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousProbeOut === undefined)
			delete process.env.PI_SEMANTIC_PROBE_OUT;
		else process.env.PI_SEMANTIC_PROBE_OUT = previousProbeOut;
		if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
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

interface ChildHarnessSnapshot {
	readonly isIdle: boolean;
	readonly decisionTools: string[];
	readonly customEntries: Array<{
		readonly customType?: string;
		readonly data?: unknown;
	}>;
}

interface ChildHarness {
	readonly process: ChildProcess;
	command<T>(command: string, prompt?: string): Promise<T>;
	stop(): Promise<void>;
}

function spawnPackedChild(
	fixture: PackedFixture,
	baseUrl: string,
	modelId: string,
	envOverrides?: NodeJS.ProcessEnv,
): ChildHarness {
	const childCwd = fixture.cwd;
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			join(repoRoot, "test", "fixtures", "packed-pi-child.ts"),
		],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agentDir,
				XDG_RUNTIME_DIR: fixture.runtimeDir,
				WATCHDOG_CHILD_AGENT_DIR: fixture.agentDir,
				WATCHDOG_CHILD_CWD: childCwd,
				WATCHDOG_CHILD_BASE_URL: baseUrl,
				WATCHDOG_CHILD_MODEL_ID: modelId,
				...envOverrides,
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	let nextId = 0;
	const waiting = new Map<
		number,
		{
			resolve: (data: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	child.on("message", (message: unknown) => {
		if (
			typeof message !== "object" ||
			message === null ||
			!("id" in message) ||
			typeof message.id !== "number"
		)
			return;
		const pending = waiting.get(message.id);
		if (pending === undefined) return;
		waiting.delete(message.id);
		clearTimeout(pending.timer);
		pending.resolve("data" in message ? message.data : undefined);
	});
	child.on("exit", (code, signal) => {
		for (const pending of waiting.values()) {
			clearTimeout(pending.timer);
			pending.reject(
				new Error(
					`Packed child exited (${code ?? signal ?? "unknown"}); stdout=${stdout}; stderr=${stderr}`,
				),
			);
		}
		waiting.clear();
	});

	return {
		process: child,
		command<T>(command: string, prompt?: string): Promise<T> {
			const id = ++nextId;
			return new Promise<T>((resolveCommand, rejectCommand) => {
				const timer = setTimeout(() => {
					waiting.delete(id);
					rejectCommand(
						new Error(
							`Timed out waiting for packed child ${command}; stdout=${stdout}; stderr=${stderr}`,
						),
					);
				}, 5_000);
				waiting.set(id, {
					resolve: (data) => resolveCommand(data as T),
					reject: rejectCommand,
					timer,
				});
				child.send({
					id,
					command,
					...(prompt === undefined ? {} : { prompt }),
				});
			});
		},
		async stop(): Promise<void> {
			if (child.exitCode === null && child.signalCode === null) {
				try {
					await this.command("shutdown");
				} catch {
					child.kill("SIGKILL");
				}
				if (child.exitCode === null && child.signalCode === null) {
					await Promise.race([
						once(child, "exit"),
						new Promise<void>((resolveTimeout) =>
							setTimeout(() => {
								child.kill("SIGKILL");
								resolveTimeout();
							}, 2_000),
						),
					]);
				}
			}
			child.stdout?.destroy();
			child.stderr?.destroy();
		},
	};
}

async function assertWrongCapabilityChildFailsClosed(
	fixture: PackedFixture,
	baseUrl: string,
	domainEnv: NodeJS.ProcessEnv,
): Promise<void> {
	const declaration = domainEnv.PI_EXTENSION_UTILS_PROCESS_DOMAIN;
	assert.ok(declaration);
	const decoded = JSON.parse(
		Buffer.from(declaration, "base64url").toString("utf8"),
	) as { capability: string; endpoint: string };
	const actualCapability = decoded.capability;
	const wrongCapability = randomBytes(32).toString("base64url");
	assert.notEqual(wrongCapability, actualCapability);
	const wrongDeclaration = Buffer.from(
		JSON.stringify({ ...decoded, capability: wrongCapability }),
		"utf8",
	).toString("base64url");
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			join(repoRoot, "test", "fixtures", "packed-pi-child.ts"),
		],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				...domainEnv,
				PI_EXTENSION_UTILS_PROCESS_DOMAIN: wrongDeclaration,
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agentDir,
				XDG_RUNTIME_DIR: fixture.runtimeDir,
				WATCHDOG_CHILD_AGENT_DIR: fixture.agentDir,
				WATCHDOG_CHILD_CWD: fixture.cwd,
				WATCHDOG_CHILD_BASE_URL: baseUrl,
				WATCHDOG_CHILD_MODEL_ID: "wrong-key-child-model",
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const exit = once(child, "exit") as Promise<
		[number | null, NodeJS.Signals | null]
	>;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let code: number | null;
	let signal: NodeJS.Signals | null;
	try {
		child.send({ id: 1, command: "start" });
		[code, signal] = await Promise.race([
			exit,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error("Timed out waiting for wrong-key child exit")),
					12_000,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await Promise.race([
				exit,
				new Promise<void>((resolveTimeout) =>
					setTimeout(resolveTimeout, 2_000),
				),
			]);
		}
		child.stdout?.destroy();
		child.stderr?.destroy();
	}
	assert.equal(signal, null);
	assert.equal(code, 78);
	const output = `${stdout}\n${stderr}`;
	assert.equal(
		output.includes("AUTHENTICATION_FAILED"),
		true,
		`sanitized child output: ${output}`,
	);
	assert.equal(output.includes(actualCapability), false);
	assert.equal(output.includes(wrongCapability), false);
	assert.equal(output.includes(decoded.endpoint), false);
	assert.equal(output.includes(fixture.runtimeDir), false);
}

function createRpcUiContext(): ExtensionUIContext {
	// bindExtensions only treats a supplied public UI context as UI-capable; the
	// watchdog uses notify in this E2E and does not require a real terminal/TUI.
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
		notify() {},
		onTerminalInput() {
			return () => {};
		},
	} as unknown as ExtensionUIContext;
}

test("packed stock Pi coordinates busy and decision epochs across an OS child", {
	timeout: 130_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { idleDelaySeconds: 10 },
	});
	assert.ok(fixture.probeOut);
	const rootCwd = join(fixture.root, "root-process-project");
	const childCwd = join(fixture.root, "child-process-project");
	await Promise.all([
		mkdir(rootCwd, { recursive: true }),
		mkdir(childCwd, { recursive: true }),
	]);

	let releaseHeldDecision: (() => void) | undefined;
	const heldDecisionRelease = new Promise<void>((resolveRelease) => {
		releaseHeldDecision = resolveRelease;
	});
	let heldDecisionStarted = false;
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "delayed" },
		{ kind: "stop", text: "root first epoch settled" },
		{ kind: "unlock", reason: "first cross-process epoch complete" },
		{ kind: "unlock", reason: "heartbeat recovery complete" },
		{ kind: "stop", text: "root fencing epoch settled" },
		{
			kind: "held-continue",
			started: () => {
				heldDecisionStarted = true;
			},
			release: heldDecisionRelease,
		},
		{ kind: "delayed" },
		{ kind: "stop", text: "invalidated decision fold settled" },
		{ kind: "unlock", reason: "fresh epoch complete" },
	]);
	const root = await createSession(fixture, baseUrl, {
		cwd: rootCwd,
		modelId: "root-process-model",
		uiContext: createRpcUiContext(),
	});
	t.after(() => shutdownSession(root.session));
	assert.equal(
		root.domainEnv.PI_CONTINUE_WATCHDOG_ROOT_PID,
		String(process.pid),
	);
	assert.ok(
		root.domainEnv.PI_EXTENSION_UTILS_PROCESS_DOMAIN,
		"root created PI_EXTENSION_UTILS_PROCESS_DOMAIN",
	);

	const child = spawnPackedChild(fixture, baseUrl, "child-process-model", {
		...root.domainEnv,
		WATCHDOG_CHILD_CWD: childCwd,
	});
	t.after(async () => {
		await child.stop();
	});
	const started = await child.command<{
		pid: number;
		decisionTools: string[];
	}>("start");
	assert.notEqual(started.pid, process.pid);
	assert.deepEqual(started.decisionTools, []);

	await child.command(
		"prompt",
		"Stay busy across the root's first idle delay.",
	);
	await waitFor(
		() => requests.some((request) => request.model === "child-process-model"),
		5_000,
		"child held provider request",
	);
	await root.session.prompt("Settle while the independent child stays busy.");
	await waitForSessionIdle(root.session, 3_000, "root first ordinary work");
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_300));
	assert.equal(
		requests.filter(isDecisionRequest).length,
		0,
		"root must not decide through a complete fixed fence while the OS child is busy",
	);

	const disconnectedAt = Date.now();
	assert.equal(child.process.kill("SIGSTOP"), true);
	// The transport heartbeat first observes the stopped process; disconnect then
	// removes its busy ID and starts a fresh fixed inquiry fence.
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 6_500));
	await waitFor(
		() => requests.filter(isDecisionRequest).length === 1,
		15_000,
		"busy-child disconnect decision",
	);
	await waitForSessionIdle(root.session, 3_000, "disconnect root decision");
	const firstDecision = requests.find(isDecisionRequest);
	assert.ok(firstDecision);
	assert.equal(firstDecision.model, "root-process-model");
	assert.ok(
		firstDecision.receivedAt - disconnectedAt >= 9_800,
		"disconnect must still wait a complete fixed inquiry fence",
	);
	assert.equal(
		requests.filter(
			(request) =>
				request.model === "child-process-model" && isDecisionRequest(request),
		).length,
		0,
	);

	let probeRecords = await readProbeRecords(fixture.probeOut);
	const hookDeadline = Date.now() + 2_000;
	while (
		!probeRecords.some(
			(record) => record.kind === "semantic-hook" && record.cwd === rootCwd,
		)
	) {
		if (Date.now() >= hookDeadline) {
			throw new Error("Timed out waiting for root user-ready hook");
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		probeRecords = await readProbeRecords(fixture.probeOut);
	}
	assert.equal(
		probeRecords.filter(
			(record) => record.kind === "semantic-hook" && record.cwd === childCwd,
		).length,
		0,
		"observer child must never publish user-ready",
	);

	assert.equal(child.process.kill("SIGCONT"), true);
	const resumedBusy = await child.command<ChildHarnessSnapshot>("snapshot");
	assert.equal(resumedBusy.isIdle, false);
	assert.deepEqual(resumedBusy.decisionTools, []);
	assert.deepEqual(resumedBusy.customEntries, []);
	// Reconnect is connection-neutral. The fixed one-second retry publishes a
	// newly queried live busy state, which must block a newly locked root.
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));
	await root.session.prompt("/lock-continue-watchdog");
	const requestsBeforeReconnectBusyFence = requests.length;
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_300));
	assert.equal(
		requests.length,
		requestsBeforeReconnectBusyFence,
		"fresh live busy report after reconnect must block the root",
	);

	const childIdleAt = Date.now();
	await child.command("abort");
	await waitFor(
		() => requests.filter(isDecisionRequest).length === 2,
		15_000,
		"reconnected child live-idle decision",
	);
	await waitForSessionIdle(root.session, 5_000, "reconnect recovery unlock");
	const reconnectDecision = requests.filter(isDecisionRequest)[1];
	assert.ok(reconnectDecision);
	assert.equal(reconnectDecision.model, "root-process-model");
	assert.ok(
		reconnectDecision.receivedAt - childIdleAt >= 9_800,
		"fresh child idle report must wait a complete fixed inquiry fence",
	);
	const childAfterReconnect =
		await child.command<ChildHarnessSnapshot>("snapshot");
	assert.equal(childAfterReconnect.isIdle, true);
	assert.deepEqual(childAfterReconnect.decisionTools, []);
	assert.deepEqual(childAfterReconnect.customEntries, []);

	await root.session.prompt(
		"Open a decision that will be invalidated by child work.",
	);
	await waitFor(
		() => heldDecisionStarted,
		15_000,
		"held root decision after the fixed fence",
	);
	const entriesBeforeInvalidation =
		root.session.sessionManager.getEntries().length;
	const hooksBeforeInvalidation = (await readProbeEnvelopes(fixture.probeOut))
		.length;
	await child.command("prompt", "Become busy while the root decision is open.");
	await waitFor(
		() =>
			requests.filter((request) => request.model === "child-process-model")
				.length === 2,
		5_000,
		"second child held provider request",
	);
	releaseHeldDecision?.();
	await waitFor(
		() => requests.length === 8,
		5_000,
		"invalidated decision fold settlement",
	);
	await waitForSessionIdle(root.session, 3_000, "invalidated root decision");

	const invalidatedEntries = root.session.sessionManager
		.getEntries()
		.slice(entriesBeforeInvalidation)
		.map((entry) => JSON.stringify(entry));
	const foldEntryToken = `"customType":${JSON.stringify(DECISION_FOLD_MESSAGE_TYPE)}`;
	assert.equal(
		invalidatedEntries.some(
			(entry) =>
				entry.includes(foldEntryToken) &&
				entry.includes('"watchdogOutcome":"invalidated"'),
		),
		true,
	);
	assert.equal(
		invalidatedEntries.some((entry) =>
			entry.includes('"customType":"pi-continue-watchdog:continue"'),
		),
		false,
	);
	assert.equal(
		invalidatedEntries.some((entry) =>
			entry.includes('"customType":"pi-continue-watchdog:human-unlock"'),
		),
		false,
	);
	assert.equal(
		invalidatedEntries.some(
			(entry) =>
				entry.includes(foldEntryToken) &&
				entry.includes('"watchdogOutcome":"continue"'),
		),
		false,
	);
	assert.equal(
		invalidatedEntries.some(
			(entry) =>
				entry.includes(foldEntryToken) &&
				entry.includes('"watchdogOutcome":"unlock"'),
		),
		false,
	);
	assert.equal(
		invalidatedEntries.some((entry) =>
			entry.includes('"kind":"validation-error"'),
		),
		false,
		"stale response must not consume an invalid-response retry",
	);
	assert.equal(
		(await readProbeEnvelopes(fixture.probeOut)).length,
		hooksBeforeInvalidation,
	);
	assert.equal(
		requests.some((request) =>
			request.messages.some((message) =>
				textOf(message).includes(continuePrompt),
			),
		),
		false,
		"stale continue must not start a continuation turn",
	);
	assert.equal(isDecisionRequest(requests[7] as RequestRecord), false);
	assert.equal(
		requests
			.slice(7)
			.some((request) => request.model === "child-process-model"),
		false,
	);

	const finalChildIdleAt = Date.now();
	await child.command("abort");
	await waitFor(
		() => requests.filter(isDecisionRequest).length === 4,
		15_000,
		"fresh post-invalidation decision",
	);
	await waitForSessionIdle(
		root.session,
		5_000,
		"fresh post-invalidation unlock",
	);
	const decisions = requests.filter(isDecisionRequest);
	assert.equal(decisions.length, 4);
	assert.ok(
		(decisions[3]?.receivedAt ?? 0) - finalChildIdleAt >= 9_800,
		"post-invalidation idle must wait a complete fixed inquiry fence",
	);
	assert.equal(
		decisions.every((request) => request.model === "root-process-model"),
		true,
	);
	const finalChild = await child.command<ChildHarnessSnapshot>("snapshot");
	assert.deepEqual(finalChild.decisionTools, []);
	assert.deepEqual(finalChild.customEntries, []);
	await assertWrongCapabilityChildFailsClosed(fixture, baseUrl, root.domainEnv);
	await child.stop();
});
