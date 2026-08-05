import assert from "node:assert/strict";

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

interface ParentCommand {
	readonly id: number;
	readonly command: "start" | "prompt" | "abort" | "snapshot" | "shutdown";
	readonly prompt?: string;
}

interface ChildEvent {
	readonly id?: number;
	readonly event: string;
	readonly data?: unknown;
}

const agentDir = requiredEnv("WATCHDOG_CHILD_AGENT_DIR");
const cwd = requiredEnv("WATCHDOG_CHILD_CWD");
const baseUrl = requiredEnv("WATCHDOG_CHILD_BASE_URL");
const modelId = requiredEnv("WATCHDOG_CHILD_MODEL_ID");

let session: AgentSession | null = null;
let pendingPrompt: Promise<void> | null = null;

function requiredEnv(name: string): string {
	const value = process.env[name];
	assert.ok(value, `${name} is required`);
	return value;
}

function send(message: ChildEvent): void {
	process.send?.(message);
}

function disconnect(): void {
	process.disconnect?.();
}

function decisionTools(): string[] {
	return (
		session?.extensionRunner
			.getAllRegisteredTools()
			.map((tool) => tool.definition.name)
			.filter(
				(name) =>
					name === "continue_watchdog" || name === "unlock_continue_watchdog",
			)
			.sort() ?? []
	);
}

function childUiContext(): ExtensionUIContext {
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
			console.error(message);
		},
		onTerminalInput() {
			return () => {};
		},
	} as unknown as ExtensionUIContext;
}

function customEntries(): unknown[] {
	return (
		session?.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom")
			.map((entry) => ({
				customType: entry.customType,
				data: entry.data,
			})) ?? []
	);
}

async function start(): Promise<void> {
	assert.equal(session, null, "child session already started");
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	modelRuntime.registerProvider("watchdog-child-e2e", {
		name: "Watchdog child E2E",
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
				contextWindow: 4096,
				maxTokens: 128,
			},
		],
	});
	const model = modelRuntime.getModel("watchdog-child-e2e", modelId);
	assert.ok(model);
	({ session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
	}));
	await session.bindExtensions({ mode: "rpc", uiContext: childUiContext() });
}

async function abortPrompt(): Promise<void> {
	if (pendingPrompt === null || session === null) return;
	await session.abort();
	await pendingPrompt;
	pendingPrompt = null;
	await session.waitForIdle();
}

async function shutdown(): Promise<void> {
	await abortPrompt();
	if (session !== null) {
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		session.dispose();
		session = null;
	}
}

process.on("message", (raw: ParentCommand) => {
	void (async () => {
		switch (raw.command) {
			case "start":
				await start();
				send({
					id: raw.id,
					event: "session-started",
					data: { pid: process.pid, decisionTools: decisionTools() },
				});
				break;
			case "prompt":
				assert.ok(session);
				assert.equal(pendingPrompt, null, "child prompt already active");
				pendingPrompt = session.prompt(raw.prompt ?? "Child work");
				send({ id: raw.id, event: "prompt-started" });
				break;
			case "abort":
				await abortPrompt();
				send({ id: raw.id, event: "idle" });
				break;
			case "snapshot":
				send({
					id: raw.id,
					event: "snapshot",
					data: {
						isIdle: session?.isIdle ?? true,
						decisionTools: decisionTools(),
						customEntries: customEntries(),
					},
				});
				break;
			case "shutdown":
				await shutdown();
				send({ id: raw.id, event: "shutdown" });
				disconnect();
				process.exit(0);
				break;
		}
	})().catch((error: unknown) => {
		if (process.exitCode !== 78) process.exitCode = 1;
		if (process.exitCode !== 78) {
			console.error("Packed Pi child harness failed.");
		} else if (
			error instanceof Error &&
			"code" in error &&
			typeof error.code === "string"
		) {
			console.error(`Packed Pi child domain failed (${error.code}).`);
		}
		disconnect();
	});
});

send({ event: "ready", data: { pid: process.pid } });
