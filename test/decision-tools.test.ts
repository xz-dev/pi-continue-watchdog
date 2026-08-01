import assert from "node:assert/strict";
import test from "node:test";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
	CONTINUE_WATCHDOG_DESCRIPTION,
	CONTINUE_WATCHDOG_PROMPT_SNIPPET,
	CONTINUE_WATCHDOG_TOOL_NAME,
	createDecisionToolActivation,
	createDecisionToolExecutors,
	DECISION_TOOL_NAMES,
	type DecisionToolActivation,
	type DecisionToolCall,
	STALE_DECISION_TOOL_MESSAGE,
	UNLOCK_CONTINUE_WATCHDOG_DESCRIPTION,
	UNLOCK_CONTINUE_WATCHDOG_PROMPT_SNIPPET,
	UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
} from "../src/decision-tools.js";

type RegisteredDecisionTool = ToolDefinition;
type DecisionDetails = { readonly result: string };

interface Harness {
	readonly pi: ExtensionAPI;
	readonly tools: Map<string, RegisteredDecisionTool>;
	readonly setActiveCalls: string[][];
	readonly delegated: DecisionToolCall[];
	readonly continueResult: AgentToolResult<DecisionDetails>;
	readonly unlockResult: AgentToolResult<DecisionDetails>;
	readonly activation: DecisionToolActivation;
	setCurrentMain(current: boolean): void;
	setActiveTools(activeTools: readonly string[]): void;
	throwNextGetActiveTools(): void;
	throwNextSetActiveTools(): void;
	activeTools(): readonly string[];
}

function createHarness(
	initialActiveTools = ["read", "bash", "edit"],
	activateRegisteredTools = true,
): Harness {
	const tools = new Map<string, RegisteredDecisionTool>();
	const setActiveCalls: string[][] = [];
	const delegated: DecisionToolCall[] = [];
	let activeTools = [...initialActiveTools];
	let currentMain = true;
	let throwGetActiveTools = false;
	let throwSetActiveTools = false;

	const continueResult: AgentToolResult<DecisionDetails> = {
		content: [{ type: "text", text: "continue result" }],
		details: { result: "continue" },
	};
	const unlockResult: AgentToolResult<DecisionDetails> = {
		content: [{ type: "text", text: "unlock result" }],
		details: { result: "unlock" },
		terminate: true,
	};
	const pi = {
		registerTool(tool: RegisteredDecisionTool): void {
			tools.set(tool.name, tool);
			// Stock Pi registers custom definitions into the initial active set. The
			// manager must later remove its two definitions through setActiveTools.
			if (activateRegisteredTools && !activeTools.includes(tool.name)) {
				activeTools.push(tool.name);
			}
		},
		getActiveTools(): string[] {
			if (throwGetActiveTools) {
				throwGetActiveTools = false;
				throw new Error("getActiveTools failed");
			}
			return [...activeTools];
		},
		setActiveTools(toolNames: string[]): void {
			setActiveCalls.push([...toolNames]);
			if (throwSetActiveTools) {
				throwSetActiveTools = false;
				throw new Error("setActiveTools failed");
			}
			activeTools = [...toolNames];
		},
	} as unknown as ExtensionAPI;

	const executors = createDecisionToolExecutors({
		onDecisionToolCall(call) {
			delegated.push(call);
			return call.kind === "continue" ? continueResult : unlockResult;
		},
	});
	const activation = createDecisionToolActivation(pi, {
		isCurrentMain: () => currentMain,
		getContinuePrompt: () => "Continue from configuration.",
		...executors,
	});

	return {
		pi,
		tools,
		setActiveCalls,
		delegated,
		continueResult,
		unlockResult,
		activation,
		setCurrentMain(current: boolean): void {
			currentMain = current;
		},
		setActiveTools(nextActiveTools: readonly string[]): void {
			activeTools = [...nextActiveTools];
		},
		throwNextGetActiveTools(): void {
			throwGetActiveTools = true;
		},
		throwNextSetActiveTools(): void {
			throwSetActiveTools = true;
		},
		activeTools(): readonly string[] {
			return [...activeTools];
		},
	};
}

function registeredTool(
	harness: Harness,
	name: string,
): RegisteredDecisionTool {
	const tool = harness.tools.get(name);
	assert.ok(tool, `expected ${name} to be registered`);
	return tool;
}

function schemaJson(tool: RegisteredDecisionTool): unknown {
	return JSON.parse(JSON.stringify(tool.parameters));
}

function initializeDecisionTools(harness: Harness): void {
	assert.equal(harness.activation.initializeDecisionToolsInactive(), true);
}

test("Slice 5 RED: registers definitions into Pi's default active set, then lifecycle initialization removes exactly the decision pair", () => {
	const harness = createHarness();

	assert.deepEqual(
		[...harness.tools.keys()],
		[CONTINUE_WATCHDOG_TOOL_NAME, UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME],
	);
	assert.deepEqual(harness.activeTools(), [
		"read",
		"bash",
		"edit",
		...DECISION_TOOL_NAMES,
	]);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.setActiveCalls, []);

	initializeDecisionTools(harness);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "edit"]);
	assert.deepEqual(harness.setActiveCalls, [["read", "bash", "edit"]]);
	assert.equal(harness.activation.initializeDecisionToolsInactive(), false);
	assert.deepEqual(harness.setActiveCalls, [["read", "bash", "edit"]]);

	assert.equal(Object.isFrozen(DECISION_TOOL_NAMES), true);
	assert.deepEqual(DECISION_TOOL_NAMES, [
		CONTINUE_WATCHDOG_TOOL_NAME,
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	]);
	assert.throws(() => {
		(DECISION_TOOL_NAMES as unknown as { push(name: string): void }).push(
			"hostile",
		);
	}, TypeError);
});

test("Slice 5 RED: decision schemas, descriptions, and prompt snippets define only the accepted automated non-user protocol", () => {
	const harness = createHarness();
	const continueTool = registeredTool(harness, CONTINUE_WATCHDOG_TOOL_NAME);
	const unlockTool = registeredTool(
		harness,
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	);

	assert.equal(continueTool.description, CONTINUE_WATCHDOG_DESCRIPTION);
	assert.equal(continueTool.promptSnippet, CONTINUE_WATCHDOG_PROMPT_SNIPPET);
	assert.match(continueTool.description, /automated/i);
	assert.match(continueTool.description, /pi-continue-watchdog/i);
	assert.match(continueTool.description, /not a user request/i);
	assert.deepEqual(schemaJson(continueTool), {
		type: "object",
		properties: {},
		additionalProperties: false,
	});

	assert.equal(unlockTool.description, UNLOCK_CONTINUE_WATCHDOG_DESCRIPTION);
	assert.equal(
		unlockTool.promptSnippet,
		UNLOCK_CONTINUE_WATCHDOG_PROMPT_SNIPPET,
	);
	assert.match(unlockTool.description, /automated/i);
	assert.match(unlockTool.description, /pi-continue-watchdog/i);
	assert.match(unlockTool.description, /not a user request/i);
	assert.match(unlockTool.description, /concise, clear one-sentence/i);
	assert.match(unlockTool.description, /non-empty/i);
	assert.match(unlockTool.description, /500 characters/i);
	assert.deepEqual(schemaJson(unlockTool), {
		type: "object",
		required: ["reason"],
		properties: {
			reason: { type: "string", minLength: 1, maxLength: 500 },
		},
		additionalProperties: false,
	});
});

test("Slice 7 RED: the registered continue decision tool uses the compact configured-prompt renderer and hides its result row", () => {
	const harness = createHarness();
	const continueTool = registeredTool(harness, CONTINUE_WATCHDOG_TOOL_NAME);
	assert.ok(continueTool.renderCall);
	assert.ok(continueTool.renderResult);

	const theme = {
		fg(_color: string, text: string): string {
			return text;
		},
	};
	const call = continueTool.renderCall({}, theme as never, {} as never);
	const result = continueTool.renderResult(
		harness.continueResult,
		{ expanded: false, isPartial: false },
		theme as never,
		{} as never,
	);
	assert.deepEqual(
		call.render(120).map((line) => line.trimEnd()),
		["Continue from configuration."],
	);
	assert.deepEqual(result.render(120), []);
});

test("Slice 5 RED: activation only follows lifecycle initialization and restores an ordered normal-only baseline", () => {
	const initial = ["read", "bash", "read"];
	const harness = createHarness(initial);

	assert.equal(harness.activation.activateDecisionTools(), false);
	assert.equal(harness.activation.isActive(), false);
	initializeDecisionTools(harness);
	assert.deepEqual(harness.activeTools(), initial);
	assert.deepEqual(harness.setActiveCalls, [initial]);

	assert.equal(harness.activation.activateDecisionTools(), true);
	assert.equal(harness.activation.isActive(), true);
	assert.deepEqual(harness.activeTools(), [...DECISION_TOOL_NAMES]);
	assert.deepEqual(harness.activation.getCapturedActiveTools(), initial);
	assert.deepEqual(harness.setActiveCalls, [initial, [...DECISION_TOOL_NAMES]]);

	// A repeated decision entry must not overwrite the normal-tool snapshot.
	harness.setActiveTools(["hostile-normal-tool"]);
	assert.equal(harness.activation.activateDecisionTools(), false);
	assert.deepEqual(harness.setActiveCalls, [initial, [...DECISION_TOOL_NAMES]]);
	assert.deepEqual(harness.activation.getCapturedActiveTools(), initial);

	assert.equal(harness.activation.restoreDecisionTools(), true);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.activeTools(), initial);
	assert.deepEqual(harness.setActiveCalls, [
		initial,
		[...DECISION_TOOL_NAMES],
		initial,
	]);
	assert.equal(harness.activation.getCapturedActiveTools(), null);
	assert.equal(harness.activation.restoreDecisionTools(), false);
});

test("Slice 5 RED: lifecycle initialization removes the pair for a non-main attachment, which still cannot activate controls", () => {
	const harness = createHarness(["read", "bash"]);
	harness.setCurrentMain(false);

	initializeDecisionTools(harness);
	assert.equal(harness.activation.activateDecisionTools(), false);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.activeTools(), ["read", "bash"]);
	assert.deepEqual(harness.setActiveCalls, [["read", "bash"]]);
	assert.equal(harness.activation.getCapturedActiveTools(), null);
});

test("Slice 5 RED: a demoted active attachment restores its original normal set without requiring current-main ownership", () => {
	const harness = createHarness(["read", "bash"]);
	initializeDecisionTools(harness);
	assert.equal(harness.activation.activateDecisionTools(), true);
	harness.setCurrentMain(false);

	assert.equal(harness.activation.restoreDecisionTools(), true);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.activeTools(), ["read", "bash"]);
	assert.deepEqual(harness.setActiveCalls, [
		["read", "bash"],
		[...DECISION_TOOL_NAMES],
		["read", "bash"],
	]);
});

test("Slice 5 RED: each active main decision tool delegates the exact validated call to the future protocol seam", async () => {
	const harness = createHarness();
	const context = { marker: "decision-context" } as unknown as ExtensionContext;
	const continueTool = registeredTool(harness, CONTINUE_WATCHDOG_TOOL_NAME);
	const unlockTool = registeredTool(
		harness,
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	);

	initializeDecisionTools(harness);
	assert.equal(harness.activation.activateDecisionTools(), true);
	const continueResult = await continueTool.execute(
		"continue-call",
		{},
		undefined,
		undefined,
		context,
	);
	const unlockResult = await unlockTool.execute(
		"unlock-call",
		{ reason: "All tasks are complete." },
		undefined,
		undefined,
		context,
	);

	assert.equal(continueResult, harness.continueResult);
	assert.equal(unlockResult, harness.unlockResult);
	assert.deepEqual(harness.delegated, [
		{
			kind: "continue",
			toolCallId: "continue-call",
			ctx: context,
		},
		{
			kind: "unlock",
			reason: "All tasks are complete.",
			toolCallId: "unlock-call",
			ctx: context,
		},
	]);
});

test("Slice 5 RED: uninitialized, inactive, or demoted tool execution cannot delegate decision control and returns the fixed terminating stale result", async () => {
	const harness = createHarness();
	const context = {} as ExtensionContext;
	const continueTool = registeredTool(harness, CONTINUE_WATCHDOG_TOOL_NAME);

	const uninitialized = await continueTool.execute(
		"uninitialized-call",
		{},
		undefined,
		undefined,
		context,
	);
	assert.deepEqual(uninitialized, {
		content: [{ type: "text", text: STALE_DECISION_TOOL_MESSAGE }],
		details: { kind: "stale-decision-tool" },
		terminate: true,
	});
	assert.deepEqual(harness.delegated, []);

	initializeDecisionTools(harness);
	const inactive = await continueTool.execute(
		"inactive-call",
		{},
		undefined,
		undefined,
		context,
	);
	assert.deepEqual(inactive, uninitialized);
	assert.deepEqual(harness.delegated, []);

	assert.equal(harness.activation.activateDecisionTools(), true);
	harness.setCurrentMain(false);
	const demoted = await continueTool.execute(
		"demoted-call",
		{},
		undefined,
		undefined,
		context,
	);
	assert.deepEqual(demoted, inactive);
	assert.deepEqual(harness.delegated, []);
});

test("Slice 5 RED: initialization is idempotent and skips setActiveTools when both definitions are already inactive", () => {
	const harness = createHarness(["read", "bash"], false);

	initializeDecisionTools(harness);
	assert.deepEqual(harness.activeTools(), ["read", "bash"]);
	assert.deepEqual(harness.setActiveCalls, []);
	assert.equal(harness.activation.initializeDecisionToolsInactive(), false);
	assert.deepEqual(harness.setActiveCalls, []);
});

test("Slice 5 RED: initialization retries after Pi active-tool API failures without exposing a partially initialized state", () => {
	const harness = createHarness();

	harness.throwNextGetActiveTools();
	assert.throws(
		() => harness.activation.initializeDecisionToolsInactive(),
		/getActiveTools failed/,
	);
	assert.equal(harness.activation.activateDecisionTools(), false);
	assert.deepEqual(harness.activeTools(), [
		"read",
		"bash",
		"edit",
		...DECISION_TOOL_NAMES,
	]);

	harness.throwNextSetActiveTools();
	assert.throws(
		() => harness.activation.initializeDecisionToolsInactive(),
		/setActiveTools failed/,
	);
	assert.equal(harness.activation.activateDecisionTools(), false);
	assert.deepEqual(harness.activeTools(), [
		"read",
		"bash",
		"edit",
		...DECISION_TOOL_NAMES,
	]);

	initializeDecisionTools(harness);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "edit"]);
});

test("Slice 5 RED: activation does not capture a baseline until Pi replaces the active set, then retries cleanly", () => {
	const harness = createHarness();
	initializeDecisionTools(harness);

	harness.setActiveTools([
		"read",
		CONTINUE_WATCHDOG_TOOL_NAME,
		"bash",
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
		"read",
	]);
	harness.throwNextSetActiveTools();
	assert.throws(
		() => harness.activation.activateDecisionTools(),
		/setActiveTools failed/,
	);
	assert.equal(harness.activation.isActive(), false);
	assert.equal(harness.activation.getCapturedActiveTools(), null);

	assert.equal(harness.activation.activateDecisionTools(), true);
	assert.deepEqual(harness.activeTools(), [...DECISION_TOOL_NAMES]);
	assert.deepEqual(harness.activation.getCapturedActiveTools(), [
		"read",
		"bash",
		"read",
	]);
});

test("Slice 5 RED: restoration clears its captured baseline only after Pi accepts it, so a failed restore is retryable", () => {
	const harness = createHarness();
	initializeDecisionTools(harness);
	assert.equal(harness.activation.activateDecisionTools(), true);

	harness.throwNextSetActiveTools();
	assert.throws(
		() => harness.activation.restoreDecisionTools(),
		/setActiveTools failed/,
	);
	assert.equal(harness.activation.isActive(), true);
	assert.deepEqual(harness.activation.getCapturedActiveTools(), [
		"read",
		"bash",
		"edit",
	]);
	assert.deepEqual(harness.activeTools(), [...DECISION_TOOL_NAMES]);

	assert.equal(harness.activation.restoreDecisionTools(), true);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "edit"]);
});
