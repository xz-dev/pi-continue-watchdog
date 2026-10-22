import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createWriteTool,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	createWatchdogRuntime,
	type WatchdogForkInput,
} from "private-inquiry-subagents-runtime/watchdog-runtime";
import { Type } from "typebox";

import {
	DECISION_MESSAGE_TYPE,
	foldDecisionContext,
} from "../src/context-fold.js";

function usage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function createFixture(
	t: TestContext,
	reply?: (request: number, resultFile: string) => AssistantMessage["content"],
) {
	const root = await mkdtemp(
		join(
			process.platform === "win32" ? tmpdir() : "/var/tmp",
			"watchdog-private-runtime-",
		),
	);
	let parent: AgentSession | undefined;
	let runtime: ReturnType<typeof createWatchdogRuntime> | undefined;
	t.after(async () => {
		await runtime?.dispose();
		parent?.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const agentDir = join(root, "parent-agent");
	const childAgentDir = join(root, "private-agent");
	await Promise.all([mkdir(agentDir), mkdir(childAgentDir)]);
	const resultFile = join(childAgentDir, "decision.json");
	await writeFile(resultFile, "{}", { mode: 0o600 });
	const requests: unknown[][] = [];
	const contexts: Context[] = [];
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	modelRuntime.registerProvider("watchdog-test", {
		baseUrl: "http://127.0.0.1:1",
		apiKey: "unused-local-test-key",
		api: "openai-completions",
		streamSimple: reply
			? (model, context) => {
					requests.push(JSON.parse(JSON.stringify(context.messages)));
					contexts.push(JSON.parse(JSON.stringify(context)));
					const content = reply(requests.length, resultFile);
					const stopReason = content.some((block) => block.type === "toolCall")
						? "toolUse"
						: "stop";
					const message: AssistantMessage = {
						role: "assistant",
						content,
						stopReason,
						provider: model.provider,
						api: model.api,
						model: model.id,
						timestamp: Date.now(),
						usage: { ...usage(), input: 8000, totalTokens: 8001 },
					};
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({
							type: "start",
							partial: { ...message, content: [] },
						});
						stream.push({ type: "done", reason: stopReason, message });
					});
					return stream;
				}
			: undefined,
		models: [
			{
				id: "local",
				name: "Local fixture",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			},
		],
	});
	const model = modelRuntime.getModel("watchdog-test", "local");
	assert.ok(model);
	const settingsManager = SettingsManager.inMemory();
	let parentApi: ExtensionAPI | undefined;
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			(pi) => {
				parentApi = pi;
				pi.registerTool({
					name: "cw",
					label: "Foreign cw",
					description: "Owned by a different extension",
					parameters: Type.Object({}),
					async execute() {
						return {
							content: [{ type: "text", text: "foreign" }],
							details: {},
						};
					},
				});
			},
		],
	});
	await loader.reload();
	const manager = SessionManager.create(root, join(root, "sessions"));
	const created = await createAgentSession({
		cwd: root,
		agentDir,
		modelRuntime,
		model,
		settingsManager,
		resourceLoader: loader,
		sessionManager: manager,
		tools: ["write"],
	});
	parent = created.session;
	await parent.bindExtensions({ mode: "print" });
	assert.ok(parentApi);
	const parentTools = parentApi.getAllTools();
	const timestamp = Date.now() - 1000;
	manager.appendMessage({
		role: "system",
		content: "Parent instructions",
		toolsAdded: [createWriteTool(root)],
		timestamp,
	});
	manager.appendMessage({
		role: "user",
		content: "Already authorized work",
		timestamp,
	});
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Existing delivery" }],
		provider: model.provider,
		api: model.api,
		model: model.id,
		timestamp,
		stopReason: "stop",
		usage: usage(),
	});
	runtime = createWatchdogRuntime();
	const privateRuntime = runtime;
	return {
		root,
		parent,
		parentApi,
		parentTools,
		manager,
		modelRuntime,
		model,
		resultFile,
		requests,
		contexts,
		runtime: privateRuntime,
		fork: (overrides?: Partial<WatchdogForkInput>) =>
			privateRuntime.fork({
				parent: manager,
				parentProviderRegistry: modelRuntime,
				cwd: root,
				agentDir: childAgentDir,
				resultFile,
				model: `${model.provider}/${model.id}:${created.session.thinkingLevel}`,
				retryPolicy: "disabled",
				...overrides,
			}),
	};
}

test("private full fork owns a separate session without registering parent tools", {
	timeout: 15_000,
}, async (t) => {
	const fixture = await createFixture(t);
	const child = await fixture.fork();
	assert.notEqual(child.sessionId, fixture.parent.sessionId);
	assert.equal(child.modelId, "watchdog-test/local");
	assert.equal(child.inheritedProvider, "watchdog-test");
	assert.ok(
		child.messages.some(
			(message) =>
				message.role === "user" &&
				message.content === "Already authorized work",
		),
	);
	assert.deepEqual(fixture.parentApi.getAllTools(), fixture.parentTools);
	const metadata = JSON.parse(
		await readFile(
			new URL(
				"../node_modules/private-inquiry-subagents-runtime/package.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	assert.deepEqual(Object.keys(metadata.exports), ["./watchdog-runtime"]);
	assert.equal(metadata.pi, undefined);
	await child.dispose();
	await child.dispose();
	await fixture.runtime.dispose();
});

test("full effective fork keeps native compaction, exclusions, legacy folds and selected thinking", {
	timeout: 15_000,
}, async (t) => {
	const fixture = await createFixture(t, () => [
		{ type: "text", text: "Private response." },
	]);
	const { manager, parent } = fixture;
	parent.settingsManager.setDefaultModel("different-default");
	parent.setThinkingLevel("high");
	assert.equal(parent.thinkingLevel, "high");
	const kept = manager.appendMessage({
		role: "user",
		content: "Retained active anchor",
		timestamp: 1,
	});
	manager.appendMessage({
		role: "user",
		content: "SIBLING_MUST_NOT_RETURN",
		timestamp: 2,
	});
	manager.branch(kept);
	manager.appendCompaction(
		"Retained native summary of earlier work",
		kept,
		4000,
	);
	manager.appendMessage({
		role: "bashExecution",
		command: "EXCLUDED_COMMAND",
		output: "EXCLUDED_OUTPUT",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		excludeFromContext: true,
		timestamp: 3,
	});
	const legacy = {
		version: 1,
		namespace: "pi-continue-watchdog",
		inquiryId: "legacy-private",
		attempt: 1,
	};
	manager.appendCustomMessageEntry(
		DECISION_MESSAGE_TYPE,
		"OLD_PRIVATE_INQUIRY",
		false,
		legacy,
	);
	manager.appendCustomMessageEntry(
		"pi-continue-watchdog:inquiry-fold",
		"",
		false,
		{ ...legacy, outcome: "remove", watchdogOutcome: "unlock" },
	);
	const leaf = manager.getLeafId();
	const child = await fixture.fork({ projectContext: foldDecisionContext });
	assert.equal(
		child.modelId,
		"watchdog-test/local",
		"active model, not configured default",
	);
	await child.prompt("DECISION_SUPPLEMENT_AFTER_INHERITED_CONTEXT");
	assert.equal(fixture.contexts.length, 1);
	const request = JSON.stringify(fixture.contexts[0]);
	assert.match(request, /Retained native summary/);
	assert.match(request, /Retained active anchor/);
	assert.match(request, /Parent instructions/);
	assert.doesNotMatch(
		request,
		/Already authorized work|Existing delivery|SIBLING_MUST_NOT_RETURN|EXCLUDED_COMMAND|EXCLUDED_OUTPUT|OLD_PRIVATE_INQUIRY/,
	);
	assert.ok(
		request.indexOf("Retained active anchor") <
			request.indexOf("DECISION_SUPPLEMENT_AFTER_INHERITED_CONTEXT"),
	);
	assert.equal(manager.getLeafId(), leaf);
	assert.equal(parent.thinkingLevel, "high");
	assert.notEqual(child.sessionId, parent.sessionId);
	const childFile = child.sessionFile;
	assert.ok(childFile);
	assert.equal(
		SessionManager.open(childFile).buildSessionProjection().thinkingLevel,
		"high",
	);
	assert.deepEqual(fixture.parentApi.getAllTools(), fixture.parentTools);
});

test("unavailable full fork rejects without a fresh-context model request", {
	timeout: 15_000,
}, async (t) => {
	const fixture = await createFixture(t, () => [
		{ type: "text", text: "Must not run." },
	]);
	await assert.rejects(
		fixture.fork({ parent: SessionManager.inMemory(fixture.root) }),
	);
	assert.equal(fixture.requests.length, 0);
});

test("one private response completes its file write without a follow-up response", {
	timeout: 15_000,
}, async (t) => {
	const fixture = await createFixture(t, (request, resultFile) =>
		request === 1
			? [
					{
						type: "toolCall",
						id: "result-write",
						name: "write",
						arguments: {
							path: resultFile,
							content:
								'{"action":"unlock","reason_type":"JOB_DONE","reason_content":"Delivered."}',
						},
					},
				]
			: [{ type: "text", text: "This acknowledgement must not be requested." }],
	);
	const child = await fixture.fork();
	const parentLeaf = fixture.manager.getLeafId();
	assert.equal(await readFile(fixture.resultFile, "utf8"), "{}");
	await child.prompt("Write the decision to the designated result file.");
	assert.equal(
		JSON.parse(await readFile(fixture.resultFile, "utf8")).action,
		"unlock",
	);
	assert.equal(
		fixture.requests.length,
		1,
		"the write must not trigger a second model response",
	);
	assert.equal(fixture.manager.getLeafId(), parentLeaf);
});

test("validation feedback starts the next single response in the same private child", {
	timeout: 15_000,
}, async (t) => {
	const initialFiles: string[] = [];
	const fixture = await createFixture(t, (request, resultFile) => {
		initialFiles.push(readFileSync(resultFile, "utf8"));
		return request <= 2
			? [
					{
						type: "toolCall",
						id: `result-${request}`,
						name: "write",
						arguments: {
							path: resultFile,
							content:
								request === 1
									? '{"reason_type":"JOB_DONE","reason_content":"Missing action."}'
									: '{"action":"unlock","reason_type":"JOB_DONE","reason_content":"Corrected."}',
						},
					},
				]
			: [{ type: "text", text: "Unexpected automatic response." }];
	});
	const child = await fixture.fork();
	const sessionId = child.sessionId;
	const parentLeaf = fixture.manager.getLeafId();
	await child.prompt("Write the first decision.");
	assert.equal(fixture.requests.length, 1);
	assert.equal(
		JSON.parse(await readFile(fixture.resultFile, "utf8")).action,
		undefined,
	);
	const diagnostic =
		"Validation error: action is required. Write the corrected JSON result.";
	await child.prompt(diagnostic);
	assert.equal(fixture.requests.length, 2);
	assert.equal(child.sessionId, sessionId);
	assert.deepEqual(initialFiles, ["{}", "{}"]);
	assert.equal(
		JSON.parse(await readFile(fixture.resultFile, "utf8")).action,
		"unlock",
	);
	assert.match(
		JSON.stringify(fixture.requests[1]),
		/Validation error: action is required/,
	);
	assert.equal(fixture.manager.getLeafId(), parentLeaf);
});

test("a missing result ends after one response without automatic compaction", {
	timeout: 15_000,
}, async (t) => {
	const fixture = await createFixture(t, () => [
		{ type: "text", text: "No file was written." },
	]);
	const child = await fixture.fork();
	await child.prompt("Write the decision result.");
	assert.equal(fixture.requests.length, 1);
	assert.equal(await readFile(fixture.resultFile, "utf8"), "{}");
	assert.match(child.attemptError ?? "", /one write/);
});

const invalidResponses: Array<{
	name: string;
	reply: (resultFile: string) => AssistantMessage["content"];
}> = [
	{
		name: "native schema-invalid write",
		reply: (path) => [
			{
				type: "toolCall",
				id: "invalid-write",
				name: "write",
				arguments: { path, content: 42 },
			},
		],
	},
	{
		name: "mixed write and ordinary tool",
		reply: (path): AssistantMessage["content"] => [
			{
				type: "toolCall",
				id: "mixed-write",
				name: "write",
				arguments: { path, content: '{"action":"unlock"}' },
			},
			{
				type: "toolCall",
				id: "ordinary-tool",
				name: "bash",
				arguments: { command: "false" },
			},
		],
	},
	{
		name: "different result path",
		reply: (path) => [
			{
				type: "toolCall",
				id: "wrong-path",
				name: "write",
				arguments: { path: join(dirname(path), "other.json"), content: "{}" },
			},
		],
	},
];

for (const scenario of invalidResponses) {
	test(`${scenario.name} stops before native tool-error follow-up`, {
		timeout: 15_000,
	}, async (t) => {
		const fixture = await createFixture(t, (request, resultFile) =>
			request === 1
				? scenario.reply(resultFile)
				: [{ type: "text", text: "Unexpected automatic repair." }],
		);
		const child = await fixture.fork();
		await child.prompt("Write the decision result.");
		assert.equal(fixture.requests.length, 1);
		assert.equal(await readFile(fixture.resultFile, "utf8"), "{}");
		assert.match(child.attemptError ?? "", /designated decision result file/);
	});
}

test("a result write failure stops without an automatic response", {
	timeout: 15_000,
}, async (t) => {
	const fixture = await createFixture(t, (request, path) =>
		request === 1
			? [
					{
						type: "toolCall",
						id: "failing-write",
						name: "write",
						arguments: { path, content: "{}" },
					},
				]
			: [{ type: "text", text: "Unexpected automatic repair." }],
	);
	const child = await fixture.fork();
	let disturbed = false;
	child.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "write") {
			rmSync(fixture.resultFile);
			mkdirSync(fixture.resultFile);
			disturbed = true;
		}
	});
	await assert.rejects(
		child.prompt("Write the result."),
		/EISDIR|regular file/,
	);
	assert.equal(disturbed, true);
	assert.equal(fixture.requests.length, 1);
});
