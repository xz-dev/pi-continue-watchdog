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
	readonly kind:
		| "stop"
		| "continue"
		| "unlock"
		| "invalid"
		| "delayed"
		| "connection-error";
	readonly reasonType?: string;
	readonly reason?: string;
	readonly started?: () => void;
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
	assert.equal(
		installedManifest.dependencies?.["pi-extension-utils"],
		"git+https://github.com/xz-dev/pi-extension-utils.git#a9043f0efef765789c221c1193373a8405792f1f",
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

test("packed stock Pi shares aggregate idle and root control across independent ResourceLoaders", {
	timeout: 35_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		includeWatchdog: false,
		withProbeOutput: true,
		watchdogConfig: { idleDelaySeconds: 0.25 },
	});
	assert.ok(fixture.probeOut);
	const packedWatchdogPath = join(fixture.packageDir, "src", "extension.ts");
	const packedProbePath = join(fixture.packageDir, "e2e-domain-probe.ts");
	await writeFile(
		packedProbePath,
		NEUTRAL_SEMANTIC_PROBE_SOURCE.replace(
			'import { appendFileSync } from "node:fs";',
			'import { appendFileSync } from "node:fs";\nimport registerWatchdog from "./src/extension.ts";',
		).replace(
			"export default function registerNeutralSemanticProbe(pi) {",
			"export default function registerNeutralSemanticProbe(pi) {\n\tregisterWatchdog(pi);",
		),
	);
	const rootCwd = join(fixture.root, "root-project");
	const childACwd = join(fixture.root, "child-a-project");
	const childBCwd = join(fixture.root, "child-b-project");
	await Promise.all(
		[rootCwd, childACwd, childBCwd].map((cwd) =>
			mkdir(cwd, { recursive: true }),
		),
	);

	let markChildBStarted: (() => void) | undefined;
	const childBStarted = new Promise<void>((resolveStarted) => {
		markChildBStarted = resolveStarted;
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "delayed", started: () => markChildBStarted?.() },
		{ kind: "stop", text: "root settled" },
		{ kind: "stop", text: "child-a settled" },
		{ kind: "unlock", reason: "aggregate idle proven" },
	]);

	const root = await createSession(fixture, baseUrl, {
		cwd: rootCwd,
		uiContext: createRpcUiContext(),
		additionalExtensionPaths: [packedProbePath],
	});
	const childA = await createSession(fixture, baseUrl, {
		cwd: childACwd,
		additionalExtensionPaths: [packedProbePath],
	});
	const childB = await createSession(fixture, baseUrl, {
		cwd: childBCwd,
		additionalExtensionPaths: [packedProbePath],
	});
	t.after(async () => {
		await Promise.all([
			shutdownSession(root.session),
			shutdownSession(childA.session),
			shutdownSession(childB.session),
		]);
	});

	for (const loaded of [root, childA, childB]) {
		assert.equal(loaded.extensionPath, packedProbePath);
		assert.equal(loaded.extensionPath.startsWith(fixture.packageDir), true);
	}
	assert.equal(packedWatchdogPath.startsWith(fixture.packageDir), true);
	assert.notEqual(root.loader, childA.loader);
	assert.notEqual(root.loader, childB.loader);
	assert.notEqual(childA.loader, childB.loader);

	const initialProbeRecords = await readProbeRecords(fixture.probeOut);
	const starts = initialProbeRecords.filter(
		(record) => record.kind === "session-start",
	);
	assert.deepEqual(
		starts.map((record) => record.cwd).sort(),
		[rootCwd, childACwd, childBCwd].sort(),
	);
	assert.equal(
		new Set(starts.map((record) => record.evaluationId)).size,
		3,
		"distinct-cwd loaders must independently evaluate their packed extension graph",
	);

	const registeredDecisionTools = (session: AgentSession): string[] =>
		session.extensionRunner
			.getAllRegisteredTools()
			.map((tool) => tool.definition.name)
			.filter((name) => decisionTools.includes(name))
			.sort();
	assert.deepEqual(registeredDecisionTools(root.session), []);
	assert.deepEqual(registeredDecisionTools(childA.session), []);
	assert.deepEqual(registeredDecisionTools(childB.session), []);

	const childBPrompt = childB.session.prompt(
		"Remain busy while the other observable agents settle.",
	);
	await childBStarted;
	await root.session.prompt("Root settles while child-b remains busy.");
	await childA.session.prompt(
		"Child-a also settles while child-b remains busy.",
	);
	await Promise.all([
		waitForSessionIdle(root.session, 3_000, "root initial work"),
		waitForSessionIdle(childA.session, 3_000, "child-a initial work"),
	]);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

	assert.equal(requests.length, 3);
	assert.equal(
		requests.some((request) =>
			request.messages.some((message) =>
				textOf(message).includes(decisionPromptStart),
			),
		),
		false,
		"root and child-a settling cannot decide while child-b remains busy",
	);
	assert.deepEqual(registeredDecisionTools(root.session), []);
	assert.deepEqual(registeredDecisionTools(childA.session), []);
	assert.deepEqual(registeredDecisionTools(childB.session), []);

	await childB.session.abort();
	await childBPrompt;
	await waitForSessionIdle(childB.session, 3_000, "child-b abort");
	await waitFor(() => requests.length === 4, 5_000, "aggregate-idle decision");
	await waitForSessionIdle(root.session, 3_000, "root unlock decision");

	const decisionRequests = requests.filter((request) =>
		request.messages.some((message) =>
			textOf(message).includes(decisionPromptStart),
		),
	);
	assert.equal(decisionRequests.length, 1);
	assert.deepEqual(toolNames(decisionRequests[0] as RequestRecord), [
		"bash",
		"edit",
		"read",
		"write",
	]);
	assert.deepEqual(registeredDecisionTools(root.session), []);
	assert.deepEqual(registeredDecisionTools(childA.session), []);
	assert.deepEqual(registeredDecisionTools(childB.session), []);
	assert.equal(
		requests
			.slice(0, 3)
			.every((request) =>
				decisionTools.every((name) => !toolNames(request).includes(name)),
			),
		true,
		"children and the root's ordinary turn must never activate decision tools",
	);

	await waitFor(
		() => requests.length === 4 && root.session.isIdle,
		2_000,
		"root unlock completion",
	);
	let finalProbeRecords = await readProbeRecords(fixture.probeOut);
	const hookDeadline = Date.now() + 2_000;
	while (
		finalProbeRecords.every((record) => record.kind !== "semantic-hook") &&
		Date.now() < hookDeadline
	) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		finalProbeRecords = await readProbeRecords(fixture.probeOut);
	}
	const hooks = finalProbeRecords.filter(
		(record) => record.kind === "semantic-hook",
	);
	assert.deepEqual(hooks, [
		{
			kind: "semantic-hook",
			cwd: rootCwd,
			evaluationId: starts.find((record) => record.cwd === rootCwd)
				?.evaluationId,
			data: {
				version: 1,
				name: "user-ready",
				values: {
					STOP_KIND: "AI_UNLOCK",
					REASON_TYPE: "JOB_DONE",
					REASON: "aggregate idle proven",
				},
			},
		},
	]);
});

test("packed artifact asks after threshold compaction settles", {
	timeout: 35_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		watchdogConfig: { idleDelaySeconds: 0.5 },
		piSettings: {
			compaction: { reserveTokens: 16, keepRecentTokens: 1 },
			retry: { enabled: false },
		},
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{
			kind: "stop",
			text: "ordinary response",
			usage: { promptTokens: 52, completionTokens: 4 },
		},
		{
			kind: "stop",
			text: "## Goal\nPreserve the threshold-compaction test context.",
			usage: { promptTokens: 8, completionTokens: 4 },
		},
		{ kind: "unlock", reason: "threshold compaction recovery proven" },
	]);
	const { session, extensionPath } = await createSession(fixture, baseUrl, {
		contextWindow: 64,
		maxTokens: 16,
	});
	t.after(() => shutdownSession(session));
	assert.match(
		extensionPath,
		/node_modules\/pi-continue-watchdog\/src\/extension\.ts$/,
	);
	const lifecycle: Array<{ readonly type: string; readonly at: number }> = [];
	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "compaction_start" ||
			event.type === "compaction_end" ||
			event.type === "agent_settled"
		) {
			lifecycle.push({ type: event.type, at: Date.now() });
		}
	});
	t.after(unsubscribe);

	const promptStartedAt = Date.now();
	await session.prompt("A normal turn must settle after threshold compaction.");
	const decisionDeadline = promptStartedAt + 20_000;
	const waitWithinDeadline = async (
		condition: () => boolean,
		phase: string,
	): Promise<void> => {
		const remaining = decisionDeadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`Timed out waiting for ${phase}; requests=${requests.length}; lifecycle=${lifecycle.map((event) => event.type).join(",")}`,
			);
		}
		try {
			await waitFor(condition, remaining, phase);
		} catch {
			throw new Error(
				`Timed out waiting for ${phase}; requests=${requests.length}; lifecycle=${lifecycle.map((event) => event.type).join(",")}`,
			);
		}
	};
	await waitWithinDeadline(
		() => lifecycle.some((event) => event.type === "compaction_end"),
		"threshold compaction_end",
	);
	const compactionEndAt = lifecycle.find(
		(event) => event.type === "compaction_end",
	)?.at;
	assert.ok(compactionEndAt);
	await waitWithinDeadline(
		() =>
			lifecycle.some(
				(event) =>
					event.type === "agent_settled" && event.at >= compactionEndAt,
			),
		"post-compaction agent_settled",
	);
	const postCompactionSettledAt = lifecycle.find(
		(event) => event.type === "agent_settled" && event.at >= compactionEndAt,
	)?.at;
	assert.ok(postCompactionSettledAt);
	await waitWithinDeadline(() => session.isIdle, "post-compaction idle");
	await waitWithinDeadline(
		() =>
			requests.some(
				(request) =>
					request.receivedAt >= postCompactionSettledAt &&
					isDecisionRequest(request),
			),
		"post-compaction decision request",
	);
	await waitForSessionIdle(session, 3_000, "post-compaction unlock decision");

	assert.equal(
		lifecycle.some((event) => event.type === "compaction_start"),
		true,
	);
	assert.equal(
		lifecycle.some((event) => event.type === "compaction_end"),
		true,
	);
	assert.equal(
		lifecycle.some((event) => event.type === "agent_settled"),
		true,
	);
	const decisionRequests = requests.filter(isDecisionRequest);
	assert.equal(decisionRequests.length, 1);
	const decisionRequest = decisionRequests[0];
	assert.ok(decisionRequest);
	assert.equal(decisionRequest.receivedAt >= compactionEndAt, true);
	assert.equal(decisionRequest.receivedAt >= postCompactionSettledAt, true);
	assert.equal(requests.at(-1), decisionRequest);
	assert.deepEqual(toolNames(decisionRequest), [
		"bash",
		"edit",
		"read",
		"write",
	]);
	const ordinaryRequest = requests[0];
	const summaryRequest = requests[1];
	assert.ok(ordinaryRequest);
	assert.ok(summaryRequest);
	assert.deepEqual(toolNames(ordinaryRequest), [
		"bash",
		"edit",
		"read",
		"write",
	]);
	assert.deepEqual(toolNames(summaryRequest), []);
	assert.equal(
		textOf(ordinaryRequest.messages.at(-1) ?? {}).includes(
			"A normal turn must settle after threshold compaction.",
		),
		true,
	);
	assert.equal(
		textOf(summaryRequest.messages.at(-1) ?? {}).includes("<conversation>"),
		true,
	);
	assert.equal(decisionRequest.messages.at(-1)?.role, "user");
	const decisionContent = textOf(decisionRequest.messages.at(-1) ?? {});
	assert.equal(decisionContent.includes(decisionPromptStart), true);
	assert.equal(decisionContent.includes("Do not call tools"), true);
	assert.equal(decisionContent.includes("Do not output multiple"), true);
	assert.equal(
		decisionContent.includes(
			'[\\"JOB_DONE\\",\\"WAIT_USER\\",\\"JOB_BLOCKED\\"]',
		),
		true,
	);
});

test("packed source artifact waits a real 10 seconds, decides continue, and folds context", {
	timeout: 40_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "stop" },
		{ kind: "continue" },
		{ kind: "stop" },
	]);
	const { session, extensionPath } = await createSession(fixture, baseUrl);
	t.after(() => shutdownSession(session));
	assert.match(
		extensionPath,
		/node_modules\/pi-continue-watchdog\/src\/extension\.ts$/,
	);

	const commands = session.extensionRunner
		.getRegisteredCommands()
		.map((command) => command.invocationName);
	assert.equal(commands.includes("lock-continue-watchdog"), true);
	assert.equal(commands.includes("unlock-continue-watchdog"), true);
	const publicEvents: Array<{ readonly type: string; readonly text: string }> =
		[];
	const unsubscribe = session.subscribe((event) =>
		publicEvents.push({ type: event.type, text: JSON.stringify(event) }),
	);
	t.after(unsubscribe);

	await session.prompt("Start a task that must not mysteriously stop.");
	await waitFor(() => requests.length === 3, 20_000, "continued provider turn");
	await waitForSessionIdle(session, 5_000, "continued ordinary work");

	const firstRequest = requests[0];
	const decisionRequest = requests[1];
	const continuedRequest = requests[2];
	assert.ok(firstRequest);
	assert.ok(decisionRequest);
	assert.ok(continuedRequest);
	assert.deepEqual(toolNames(firstRequest), ["bash", "edit", "read", "write"]);
	assert.deepEqual(toolNames(decisionRequest), [
		"bash",
		"edit",
		"read",
		"write",
	]);
	assert.deepEqual(toolNames(continuedRequest), [
		"bash",
		"edit",
		"read",
		"write",
	]);
	const elapsed = decisionRequest.receivedAt - firstRequest.receivedAt;
	assert.ok(elapsed >= 9_800, `decision arrived too early after ${elapsed}ms`);
	assert.ok(elapsed <= 13_000, `decision arrived too late after ${elapsed}ms`);
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
	const persisted = session.sessionManager
		.getEntries()
		.map((entry) => JSON.stringify(entry));
	assert.equal(
		persisted.filter((entry) =>
			entry.includes('"customType":"pi-continue-watchdog:continue"'),
		).length,
		1,
	);
	assert.equal(
		persisted.some(
			(entry) =>
				entry.includes('"customType":"pi-continue-watchdog:status"') &&
				entry.includes('"kind":"checking"'),
		),
		false,
	);
	assert.equal(thirdBody.includes("Continue watchdog continued"), false);
	assert.equal(thirdBody.includes("Continue watchdog checking"), false);
	// Decision content may stream while the provider runs, then message_end clears
	// the finalized assistant before public completion and session persistence.
	assert.equal(
		publicEvents.some((event) => event.type === "message_update"),
		true,
	);
	const firstDecisionUpdate = publicEvents.findIndex(
		(event) =>
			event.type === "message_update" &&
			event.text.includes("continue_watchdog"),
	);
	const publicDecisionEnd = publicEvents.findIndex(
		(event, index) =>
			index > firstDecisionUpdate &&
			event.type === "message_end" &&
			event.text.includes('"role":"assistant"') &&
			event.text.includes('"content":[]'),
	);
	assert.ok(firstDecisionUpdate >= 0);
	assert.ok(publicDecisionEnd > firstDecisionUpdate);
	const persistedAssistants = session.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? [entry.message]
				: [],
		);
	assert.equal(
		persistedAssistants.some((message) =>
			JSON.stringify(message).includes("continue_watchdog"),
		),
		false,
	);
});

test("packed stock Pi retries a decision connection error and accepts the successful unlock", {
	timeout: 30_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		watchdogConfig: { idleDelaySeconds: 0 },
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "stop" },
		{ kind: "connection-error" },
		{
			kind: "unlock",
			reasonType: "JOB_DONE",
			reason: "retry recovered",
		},
	]);
	const { session } = await createSession(fixture, baseUrl);
	t.after(() => shutdownSession(session));

	await session.prompt("Complete the task, then let the watchdog decide.");
	await waitFor(
		() => requests.length === 3,
		10_000,
		"retried watchdog decision provider request",
	);
	await waitForSessionIdle(session, 10_000, "retried watchdog unlock");

	assert.equal(requests.filter(isDecisionRequest).length, 2);
	const serialized = session.sessionManager
		.getEntries()
		.map((entry) => JSON.stringify(entry));
	assert.equal(
		serialized.some(
			(entry) =>
				entry.includes('"outcome":"invalid"') &&
				!entry.includes('"outcome":"invalidated"'),
		),
		false,
	);
	assert.equal(
		serialized.some(
			(entry) =>
				entry.includes("previous decision response was invalid") &&
				!entry.includes('"outcome":"invalidated"'),
		),
		false,
	);
	assert.equal(
		serialized.some(
			(entry) =>
				entry.includes('"kind":"other-error"') &&
				entry.includes("Connection error."),
		),
		true,
	);
	assert.equal(
		serialized.some((entry) => entry.includes('"outcome":"unlock"')),
		true,
	);
	assert.equal(
		serialized.some((entry) => entry.includes("retry recovered")),
		true,
	);
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
	t.after(() => shutdownSession(session));
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
	await waitForSessionIdle(session, 3_000, "programmatic abort");
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

test("packed interactive and RPC input preempt a streaming decision once", {
	timeout: 30_000,
}, async (t) => {
	for (const source of ["interactive", "rpc"] as const) {
		const fixture = await makePackedFixture(t, {
			watchdogConfig: { idleDelaySeconds: 0.1 },
		});
		let markDecisionStarted: (() => void) | undefined;
		const decisionStarted = new Promise<void>((resolveStarted) => {
			markDecisionStarted = resolveStarted;
		});
		const { baseUrl, requests } = await startMockServer(t, [
			{ kind: "stop", text: "ordinary work complete" },
			{ kind: "delayed", started: () => markDecisionStarted?.() },
			{ kind: "stop", text: "user takeover response" },
		]);
		let tuiAbortHandlerCalls = 0;
		const { session } = await createSession(fixture, baseUrl, {
			uiContext: createRpcUiContext(),
			abortHandler:
				source === "interactive"
					? (activeSession) => {
							tuiAbortHandlerCalls += 1;
							activeSession.clearQueue();
							activeSession.agent.abort();
						}
					: undefined,
		});
		let sessionClosed = false;
		t.after(async () => {
			if (!sessionClosed) await shutdownSession(session);
		});

		const publicEvents: Array<{
			readonly type: string;
			readonly text: string;
		}> = [];
		const unsubscribe = session.subscribe((event) =>
			publicEvents.push({ type: event.type, text: JSON.stringify(event) }),
		);
		t.after(unsubscribe);

		await session.prompt("Open a decision that user input will preempt.");
		await waitFor(
			() => requests.length === 2,
			8_000,
			`${source} decision stream`,
		);
		await decisionStarted;

		const takeover = session.prompt("user takeover", {
			source,
			streamingBehavior: "steer",
		});
		await waitFor(
			() => requests.length === 3,
			8_000,
			`${source} user takeover turn`,
		);
		await takeover;
		await waitForSessionIdle(session, 5_000, `${source} user takeover idle`);

		const userStarts = publicEvents.filter((event) => {
			if (event.type !== "message_start") return false;
			const parsed = JSON.parse(event.text) as {
				readonly message?: {
					readonly role?: string;
					readonly content?: unknown;
				};
			};
			return (
				parsed.message?.role === "user" &&
				JSON.stringify(parsed.message.content).includes("user takeover")
			);
		});
		assert.equal(userStarts.length, 1);
		assert.equal(tuiAbortHandlerCalls, source === "interactive" ? 1 : 0);
		assert.equal(
			publicEvents.some((event) => event.text.includes("Operation aborted")),
			false,
		);
		const decisionUpdate = publicEvents.findIndex(
			(event) =>
				event.type === "message_update" && event.text.includes("partial"),
		);
		const clearedDecisionEnd = publicEvents.findIndex(
			(event, index) =>
				index > decisionUpdate &&
				event.type === "message_end" &&
				event.text.includes('"role":"assistant"') &&
				event.text.includes('"content":[]'),
		);
		assert.ok(decisionUpdate >= 0);
		assert.ok(clearedDecisionEnd > decisionUpdate);
		assert.equal(
			publicEvents.some((event) =>
				event.text.includes("Continue watchdog unlocked"),
			),
			false,
		);

		const serialized = session.sessionManager
			.getEntries()
			.map((entry) => JSON.stringify(entry));
		assert.equal(
			serialized.some((entry) =>
				entry.includes('"watchdogOutcome":"preempted"'),
			),
			true,
			serialized.join("\n"),
		);
		assert.equal(
			serialized.some((entry) => entry.includes("partial")),
			false,
		);
		const laterPayload = JSON.stringify(requests[2]);
		assert.equal(laterPayload.includes(decisionPromptStart), false);
		assert.equal(laterPayload.includes("<watchdog>"), false);
		assert.equal(
			requests.filter((request) =>
				request.messages.some((message) =>
					textOf(message).includes("user takeover"),
				),
			).length,
			1,
		);
		await shutdownSession(session);
		sessionClosed = true;
	}
});

test("packed neutral probe receives typed continue and AI unlock hooks", {
	timeout: 45_000,
}, async (t) => {
	// Continue path: probe receives the accepted typed continue exactly once.
	const continueFixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { idleDelaySeconds: 1 },
	});
	assert.ok(continueFixture.probeOut);
	const continueServer = await startMockServer(t, [
		{ kind: "stop" },
		{ kind: "continue" },
		{ kind: "stop" },
	]);
	const continueSession = await createSession(
		continueFixture,
		continueServer.baseUrl,
	);
	t.after(() => continueSession.session.dispose());

	await continueSession.session.prompt(
		"Continue path must not emit user-ready.",
	);
	await waitFor(
		() => continueServer.requests.length === 3,
		8_000,
		"continued provider turn with probe",
	);
	await waitForSessionIdle(
		continueSession.session,
		5_000,
		"probe continue path",
	);
	assert.deepEqual(await readProbeEnvelopes(continueFixture.probeOut), [
		{
			version: 1,
			name: "watchdog-continued",
			values: {
				REASON_TYPE: "WORK_REMAINS",
				REASON: "Implementation work remains.",
			},
		},
	]);
	await continueSession.session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});

	// AI unlock path: probe receives exactly one AI_UNLOCK envelope with reason.
	const unlockFixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: { idleDelaySeconds: 1 },
	});
	assert.ok(unlockFixture.probeOut);
	const unlockServer = await startMockServer(t, [
		{ kind: "stop" },
		{ kind: "unlock", reason: "waiting for human review" },
	]);
	const unlockSession = await createSession(
		unlockFixture,
		unlockServer.baseUrl,
	);
	t.after(() => shutdownSession(unlockSession.session));

	await unlockSession.session.prompt("Unlock after the decision check.");
	await waitFor(
		() => unlockServer.requests.length === 2,
		8_000,
		"unlock decision request",
	);
	await waitForSessionIdle(unlockSession.session, 3_000, "probe unlock path");
	const unlockDeadline = Date.now() + 3_000;
	while ((await readProbeEnvelopes(unlockFixture.probeOut)).length < 1) {
		if (Date.now() >= unlockDeadline) {
			throw new Error("Timed out waiting for AI unlock user-ready envelope");
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
	assert.deepEqual(await readProbeEnvelopes(unlockFixture.probeOut), [
		{
			version: 1,
			name: "user-ready",
			values: {
				STOP_KIND: "AI_UNLOCK",
				REASON_TYPE: "JOB_DONE",
				REASON: "waiting for human review",
			},
		},
	]);
});

test("packed invalid decisions reask three times and leave Pi idle", {
	timeout: 20_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		watchdogConfig: { idleDelaySeconds: 0.1 },
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "stop", text: "ordinary work complete" },
		{ kind: "invalid", text: "private invalid one" },
		{ kind: "invalid", text: "private invalid two" },
		{ kind: "invalid", text: "private invalid three" },
	]);
	const { session } = await createSession(fixture, baseUrl);
	t.after(() => shutdownSession(session));

	await session.prompt("Exercise the bounded invalid decision path.");
	await waitFor(() => requests.length === 4, 8_000, "three invalid decisions");
	await waitForSessionIdle(session, 3_000, "decision-failed path");

	const branch = session.sessionManager.getBranch();
	const audits = branch.flatMap((entry) =>
		entry.type === "custom" &&
		entry.customType === "pi-continue-watchdog:decision-audit"
			? [entry.data]
			: [],
	);
	assert.equal(audits.length, 3);
	assert.deepEqual(
		audits.map((audit) =>
			typeof audit === "object" && audit !== null && "outcome" in audit
				? audit.outcome
				: undefined,
		),
		["invalid", "invalid", "invalid"],
	);
});

test("packed persisted session resumes without watchdog decision context or working hang", {
	timeout: 30_000,
}, async (t) => {
	const fixture = await makePackedFixture(t, {
		watchdogConfig: { idleDelaySeconds: 0.1 },
	});
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "stop", text: "ordinary work complete" },
		{ kind: "unlock", reason: "resume context is clean" },
		{ kind: "stop", text: "resumed ordinary response" },
	]);
	const sessionDir = join(fixture.root, "sessions");
	await mkdir(sessionDir, { recursive: true });
	const firstManager = SessionManager.create(fixture.cwd, sessionDir);
	const first = await createSession(fixture, baseUrl, {
		sessionManager: firstManager,
	});

	await first.session.prompt(
		"Persist one ordinary task before watchdog unlock.",
	);
	await waitFor(
		() => requests.length === 2,
		6_000,
		"persisted unlock decision",
	);
	await waitForSessionIdle(first.session, 3_000, "persisted unlock decision");
	const sessionFile = first.session.sessionManager.getSessionFile();
	assert.ok(sessionFile);
	await shutdownSession(first.session);

	const rawSession = await readFile(sessionFile, "utf8");
	assert.equal(rawSession.includes("resume context is clean"), true);
	assert.equal(
		rawSession.includes("pi-continue-watchdog:decision-audit"),
		true,
	);

	const resumedManager = SessionManager.open(sessionFile);
	const resumed = await createSession(fixture, baseUrl, {
		sessionManager: resumedManager,
	});
	t.after(() => shutdownSession(resumed.session));
	await resumed.session.prompt("Continue after restoring this session.");
	await waitForSessionIdle(resumed.session, 3_000, "resumed ordinary request");
	assert.equal(requests.length, 3);

	const resumedPayload = JSON.stringify(requests[2]);
	assert.equal(resumedPayload.includes(decisionPromptStart), false);
	assert.equal(resumedPayload.includes("<watchdog>"), false);
	assert.equal(resumedPayload.includes("resume context is clean"), false);
	assert.equal(
		resumedPayload.includes("pi-continue-watchdog:decision-audit"),
		false,
	);
});

test("packed custom reasonTypes replace defaults and match mixed-case input", {
	timeout: 30_000,
}, async (t) => {
	// Post-GREEN integration coverage: the production feature already exists;
	// this proves config, dynamic XML instructions, protocol, runtime, and hook
	// are wired to the same representation through the packed artifact.
	const fixture = await makePackedFixture(t, {
		withSemanticProbe: true,
		watchdogConfig: {
			idleDelaySeconds: 1,
			reasonTypes: ["Need Review", "shipped"],
		},
	});
	assert.ok(fixture.probeOut);
	const { baseUrl, requests } = await startMockServer(t, [
		{ kind: "stop" },
		{
			kind: "unlock",
			reasonType: " need review ",
			reason: " awaiting review ",
		},
	]);
	const { session } = await createSession(fixture, baseUrl);
	t.after(() => shutdownSession(session));

	await session.prompt("Unlock with a custom mixed-case reason type.");
	await waitFor(() => requests.length === 2, 8_000, "unlock decision request");
	await waitForSessionIdle(session, 3_000, "custom reason unlock path");

	// The decision prompt advertises only the effective custom list while ordinary
	// tools remain unchanged for prompt-prefix stability.
	const decisionRequest = requests[1];
	assert.ok(decisionRequest);
	assert.deepEqual(toolNames(decisionRequest), [
		"bash",
		"edit",
		"read",
		"write",
	]);
	const serializedDecisionMessages = JSON.stringify(decisionRequest.messages);
	assert.equal(
		serializedDecisionMessages.includes('[\\"Need Review\\",\\"shipped\\"]'),
		true,
	);
	assert.equal(serializedDecisionMessages.includes("JOB_DONE"), false);
	assert.equal(
		serializedDecisionMessages.includes("Do not output multiple"),
		true,
	);

	// Live decision content may remain in the append-only session. CustomEntry
	// audits stay excluded from Pi's model-bound session context by construction.
	const branch = session.sessionManager.getBranch();
	const auditEntries = branch.flatMap((entry) =>
		entry.type === "custom" &&
		entry.customType === "pi-continue-watchdog:decision-audit"
			? [entry]
			: [],
	);
	assert.equal(auditEntries.length, 1);
	const auditData = auditEntries[0]?.data as
		| {
				exchangeId?: unknown;
		  }
		| undefined;
	assert.ok(auditData);
	assert.deepEqual(auditData, {
		version: 1,
		exchangeId: auditData.exchangeId,
		cycleId: 1,
		outcome: "unlock",
		reasonType: "NEED REVIEW",
		reason: "awaiting review",
	});
	assert.equal(typeof auditData.exchangeId, "string");
	assert.equal(
		JSON.stringify(session.sessionManager.buildSessionContext()).includes(
			"pi-continue-watchdog:decision-audit",
		),
		false,
	);

	// The trimmed, case-insensitively matched, uppercased pair publishes once.
	const hookDeadline = Date.now() + 3_000;
	while ((await readProbeEnvelopes(fixture.probeOut)).length < 1) {
		if (Date.now() >= hookDeadline) {
			throw new Error("Timed out waiting for custom-type user-ready envelope");
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
	assert.deepEqual(await readProbeEnvelopes(fixture.probeOut), [
		{
			version: 1,
			name: "user-ready",
			values: {
				STOP_KIND: "AI_UNLOCK",
				REASON_TYPE: "NEED REVIEW",
				REASON: "awaiting review",
			},
		},
	]);
});
