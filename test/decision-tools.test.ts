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
	activeTools(): readonly string[];
}

function createHarness(initialActiveTools = ["read", "bash", "edit"]): Harness {
	const tools = new Map<string, RegisteredDecisionTool>();
	const setActiveCalls: string[][] = [];
	const delegated: DecisionToolCall[] = [];
	let activeTools = [...initialActiveTools];
	let currentMain = true;

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
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(toolNames: string[]): void {
			setActiveCalls.push([...toolNames]);
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

test("Slice 5 RED: registers exactly the inactive decision-pair definitions once per attachment", () => {
	const harness = createHarness();

	assert.deepEqual(
		[...harness.tools.keys()],
		[CONTINUE_WATCHDOG_TOOL_NAME, UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME],
	);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "edit"]);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.setActiveCalls, []);

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

test("Slice 5 RED: activation snapshots once, replaces active tools with only the immutable decision pair, and restores the exact ordered snapshot", () => {
	const initial = [
		"read",
		CONTINUE_WATCHDOG_TOOL_NAME,
		"bash",
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
		"read",
	];
	const harness = createHarness(initial);

	assert.equal(harness.activation.activateDecisionTools(), true);
	assert.equal(harness.activation.isActive(), true);
	assert.deepEqual(harness.activeTools(), [...DECISION_TOOL_NAMES]);
	assert.deepEqual(harness.activation.getCapturedActiveTools(), initial);
	assert.deepEqual(harness.setActiveCalls, [[...DECISION_TOOL_NAMES]]);

	// A repeated decision entry must not overwrite the normal-tool snapshot.
	harness.setActiveTools(["hostile-normal-tool"]);
	assert.equal(harness.activation.activateDecisionTools(), false);
	assert.deepEqual(harness.setActiveCalls, [[...DECISION_TOOL_NAMES]]);
	assert.deepEqual(harness.activation.getCapturedActiveTools(), initial);

	assert.equal(harness.activation.restoreDecisionTools(), true);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.activeTools(), initial);
	assert.deepEqual(harness.setActiveCalls, [[...DECISION_TOOL_NAMES], initial]);
	assert.equal(harness.activation.getCapturedActiveTools(), null);
	assert.equal(harness.activation.restoreDecisionTools(), false);
});

test("Slice 5 RED: a non-main attachment never captures or activates decision controls", () => {
	const harness = createHarness(["read", "bash"]);
	harness.setCurrentMain(false);

	assert.equal(harness.activation.activateDecisionTools(), false);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.activeTools(), ["read", "bash"]);
	assert.deepEqual(harness.setActiveCalls, []);
	assert.equal(harness.activation.getCapturedActiveTools(), null);
});

test("Slice 5 RED: a demoted active attachment restores its original normal set without requiring current-main ownership", () => {
	const harness = createHarness(["read", "bash"]);
	assert.equal(harness.activation.activateDecisionTools(), true);
	harness.setCurrentMain(false);

	assert.equal(harness.activation.restoreDecisionTools(), true);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.activeTools(), ["read", "bash"]);
	assert.deepEqual(harness.setActiveCalls, [
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

test("Slice 5 RED: inactive or demoted tool execution cannot delegate decision control and returns the fixed terminating stale result", async () => {
	const harness = createHarness();
	const context = {} as ExtensionContext;
	const continueTool = registeredTool(harness, CONTINUE_WATCHDOG_TOOL_NAME);

	const inactive = await continueTool.execute(
		"inactive-call",
		{},
		undefined,
		undefined,
		context,
	);
	assert.deepEqual(inactive, {
		content: [{ type: "text", text: STALE_DECISION_TOOL_MESSAGE }],
		details: { kind: "stale-decision-tool" },
		terminate: true,
	});
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
