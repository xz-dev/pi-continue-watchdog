import assert from "node:assert/strict";
import test from "node:test";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { DEFAULT_REASON_TYPES } from "../src/config.js";
import {
	CONTINUE_WATCHDOG_DESCRIPTION,
	CONTINUE_WATCHDOG_PROMPT_SNIPPET,
	CONTINUE_WATCHDOG_TOOL_NAME,
	createDecisionToolActivation,
	createDecisionToolExecutors,
	DECISION_TOOL_NAMES,
	type DecisionToolActivation,
	type DecisionToolCall,
	formatUnlockDecisionToolDescription,
	STALE_DECISION_TOOL_MESSAGE,
	UNLOCK_CONTINUE_WATCHDOG_DESCRIPTION,
	UNLOCK_CONTINUE_WATCHDOG_PROMPT_SNIPPET,
	UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
} from "../src/decision-tools.js";

type RegisteredDecisionTool = ToolDefinition;
type DecisionDetails = { readonly result: string };

interface Harness {
	readonly tools: Map<string, RegisteredDecisionTool>;
	readonly setActiveCalls: string[][];
	readonly delegated: DecisionToolCall[];
	readonly continueResult: AgentToolResult<DecisionDetails>;
	readonly unlockResult: AgentToolResult<DecisionDetails>;
	readonly activation: DecisionToolActivation;
	setCurrentMain(current: boolean): void;
	setActiveTools(activeTools: readonly string[]): void;
	setReasonTypes(reasonTypes: readonly string[]): void;
	throwNextGetActiveTools(): void;
	throwRegisterTool(name: string): void;
	throwNextSetActiveTools(): void;
	/** Synchronous demotion hook fired inside the named Pi API call. */
	onRegisterTool(name: string, hook: () => void): void;
	onSetActiveTools(hook: (toolNames: readonly string[]) => void): void;
	/** Claim-fenced activation using the harness live-main flag. */
	activate(stillOwns?: () => boolean): boolean;
	activeTools(): readonly string[];
}

function createHarness(
	initialActiveTools = ["read", "bash", "edit"],
	activateRegisteredTools = true,
	initialReasonTypes: readonly string[] = DEFAULT_REASON_TYPES,
): Harness {
	const tools = new Map<string, RegisteredDecisionTool>();
	const setActiveCalls: string[][] = [];
	const delegated: DecisionToolCall[] = [];
	let activeTools = [...initialActiveTools];
	let currentMain = true;
	let reasonTypes = [...initialReasonTypes];
	let throwGetActiveTools = false;
	let throwRegisterToolName: string | null = null;
	let throwSetActiveTools = false;
	const registerHooks = new Map<string, () => void>();
	let setActiveToolsHook: ((toolNames: readonly string[]) => void) | null =
		null;

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
			if (throwRegisterToolName === tool.name) {
				throwRegisterToolName = null;
				throw new Error("registerTool failed");
			}
			const hook = registerHooks.get(tool.name);
			if (hook !== undefined) {
				registerHooks.delete(tool.name);
				hook();
			}
			tools.set(tool.name, tool);
			// Stock Pi registers custom definitions into the initial active set.
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
			if (setActiveToolsHook !== null) {
				const hook = setActiveToolsHook;
				setActiveToolsHook = null;
				hook(toolNames);
			}
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
		getReasonTypes: () => reasonTypes,
		...executors,
	});

	return {
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
		setReasonTypes(nextReasonTypes: readonly string[]): void {
			reasonTypes = [...nextReasonTypes];
		},
		throwNextGetActiveTools(): void {
			throwGetActiveTools = true;
		},
		throwRegisterTool(name: string): void {
			throwRegisterToolName = name;
		},
		throwNextSetActiveTools(): void {
			throwSetActiveTools = true;
		},
		onRegisterTool(name: string, hook: () => void): void {
			registerHooks.set(name, hook);
		},
		onSetActiveTools(hook: (toolNames: readonly string[]) => void): void {
			setActiveToolsHook = hook;
		},
		activate(stillOwns?: () => boolean): boolean {
			return activation.activateDecisionTools(stillOwns ?? (() => currentMain));
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

test("construction and session initialization register nothing and leave active tools unchanged", () => {
	const harness = createHarness();

	assert.deepEqual([...harness.tools.keys()], []);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "edit"]);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.setActiveCalls, []);

	initializeDecisionTools(harness);
	assert.deepEqual([...harness.tools.keys()], []);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "edit"]);
	assert.deepEqual(harness.setActiveCalls, []);
	assert.equal(harness.activation.initializeDecisionToolsInactive(), false);
	assert.deepEqual(harness.setActiveCalls, []);
	assert.deepEqual(DECISION_TOOL_NAMES, [
		CONTINUE_WATCHDOG_TOOL_NAME,
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	]);
});

test("decision schemas, descriptions, and prompt snippets define the automated protocol", () => {
	const harness = createHarness();
	initializeDecisionTools(harness);
	assert.equal(harness.activate(), true);
	const continueTool = registeredTool(harness, CONTINUE_WATCHDOG_TOOL_NAME);
	const unlockTool = registeredTool(
		harness,
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	);

	assert.equal(continueTool.description, CONTINUE_WATCHDOG_DESCRIPTION);
	assert.equal(continueTool.promptSnippet, CONTINUE_WATCHDOG_PROMPT_SNIPPET);
	assert.match(continueTool.description, /automated/i);
	assert.match(continueTool.description, /not a user request/i);
	assert.deepEqual(schemaJson(continueTool), {
		type: "object",
		properties: {},
		additionalProperties: false,
	});

	const expectedDescription =
		formatUnlockDecisionToolDescription(DEFAULT_REASON_TYPES);
	assert.equal(unlockTool.description, expectedDescription);
	assert.equal(
		unlockTool.promptSnippet,
		UNLOCK_CONTINUE_WATCHDOG_PROMPT_SNIPPET,
	);
	assert.match(unlockTool.description, /allowed reasonType/i);
	assert.match(unlockTool.description, /concise, clear one-sentence/i);
	assert.match(unlockTool.description, /500 characters/i);
	assert.match(unlockTool.description, /JOB_DONE/);
	assert.match(unlockTool.description, /WAIT_USER/);
	assert.match(unlockTool.description, /JOB_BLOCKED/);
	assert.match(UNLOCK_CONTINUE_WATCHDOG_DESCRIPTION, /allowed reasonType/i);
	assert.match(UNLOCK_CONTINUE_WATCHDOG_PROMPT_SNIPPET, /allowed reasonType/i);

	const unlockSchema = schemaJson(unlockTool) as {
		required?: string[];
		properties?: Record<string, Record<string, unknown>>;
	};
	assert.deepEqual(unlockSchema.required?.slice().sort(), [
		"reason",
		"reasonType",
	]);
	assert.equal(unlockSchema.properties?.reasonType?.type, "string");
	assert.equal(unlockSchema.properties?.reasonType?.enum, undefined);
	assert.equal(unlockSchema.properties?.reasonType?.const, undefined);
	assert.match(
		String(unlockSchema.properties?.reasonType?.description ?? ""),
		/JOB_DONE/,
	);
	assert.deepEqual(unlockSchema.properties?.reason, {
		type: "string",
		minLength: 1,
		maxLength: 500,
	});
	assert.equal(
		(unlockSchema as { additionalProperties?: boolean }).additionalProperties,
		false,
	);
});

test("unlock description and schema list effective custom reasonTypes at registration", () => {
	const customTypes = ["NeedReview", "shipped"];
	const harness = createHarness(["read", "bash"], true, customTypes);
	initializeDecisionTools(harness);
	assert.equal(harness.activate(), true);
	const unlockTool = registeredTool(
		harness,
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	);

	assert.equal(
		unlockTool.description,
		formatUnlockDecisionToolDescription(customTypes),
	);
	assert.match(unlockTool.description, /NeedReview/);
	assert.match(unlockTool.description, /shipped/);
	assert.ok(!unlockTool.description.includes("JOB_DONE"));

	const unlockSchema = schemaJson(unlockTool) as {
		properties?: Record<string, Record<string, unknown>>;
	};
	const reasonTypeDescription = String(
		unlockSchema.properties?.reasonType?.description ?? "",
	);
	assert.match(reasonTypeDescription, /NeedReview/);
	assert.match(reasonTypeDescription, /shipped/);
	assert.ok(!reasonTypeDescription.includes("JOB_DONE"));
	assert.equal(unlockSchema.properties?.reasonType?.enum, undefined);
});

test("registered continue tool uses the compact configured-prompt renderer", () => {
	const harness = createHarness();
	initializeDecisionTools(harness);
	assert.equal(harness.activate(), true);
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

test("registered unlock tool hides its automated decision trace", () => {
	const harness = createHarness();
	initializeDecisionTools(harness);
	assert.equal(harness.activate(), true);
	const unlockTool = registeredTool(
		harness,
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	);
	assert.equal(unlockTool.renderShell, "self");
	assert.ok(unlockTool.renderCall);
	assert.ok(unlockTool.renderResult);

	const theme = {
		fg(_color: string, text: string): string {
			return text;
		},
	};
	const call = unlockTool.renderCall(
		{
			reasonType: "WAIT_USER",
			reason: "Waiting for user confirmation.",
		},
		theme as never,
		{} as never,
	);
	const result = unlockTool.renderResult(
		{
			content: [{ type: "text", text: "Decision recorded." }],
			details: { kind: "decision-recorded" },
			terminate: true,
		},
		{ expanded: false, isPartial: false },
		theme as never,
		{} as never,
	);

	assert.deepEqual(call.render(120), []);
	assert.deepEqual(result.render(120), []);

	const staleResult = unlockTool.renderResult(
		{
			content: [{ type: "text", text: STALE_DECISION_TOOL_MESSAGE }],
			details: { kind: "stale-decision-tool" },
			terminate: true,
		},
		{ expanded: false, isPartial: false },
		theme as never,
		{} as never,
	);
	assert.deepEqual(
		staleResult.render(120).map((line) => line.trimEnd()),
		[STALE_DECISION_TOOL_MESSAGE],
	);
});

test("activation lazily registers once and restores an ordered normal-only baseline", () => {
	const initial = ["read", "bash", "read"];
	const harness = createHarness(initial);

	assert.equal(harness.activate(), false);
	assert.deepEqual([...harness.tools.keys()], []);
	initializeDecisionTools(harness);
	assert.deepEqual([...harness.tools.keys()], []);
	assert.deepEqual(harness.activeTools(), initial);

	assert.equal(harness.activate(), true);
	assert.deepEqual(
		[...harness.tools.keys()],
		[CONTINUE_WATCHDOG_TOOL_NAME, UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME],
	);
	assert.equal(harness.activation.isActive(), true);
	assert.deepEqual(harness.activeTools(), [...DECISION_TOOL_NAMES]);
	assert.deepEqual(harness.activation.getCapturedActiveTools(), initial);

	// A second activation while already active is inert.
	harness.setActiveTools(["hostile-normal-tool"]);
	assert.equal(harness.activate(), false);
	assert.deepEqual(harness.activation.getCapturedActiveTools(), initial);

	assert.equal(harness.activation.restoreDecisionTools(), true);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.activeTools(), initial);
	assert.equal(harness.activation.getCapturedActiveTools(), null);
	assert.equal(harness.activation.restoreDecisionTools(), false);

	assert.equal(harness.activate(), true);
	assert.deepEqual(
		[...harness.tools.keys()],
		[CONTINUE_WATCHDOG_TOOL_NAME, UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME],
	);
	assert.equal(harness.activation.restoreDecisionTools(), true);
});

test("non-main attachments initialize inactive and never register decision tools", () => {
	const harness = createHarness(["read", "bash"]);
	harness.setCurrentMain(false);

	initializeDecisionTools(harness);
	assert.equal(harness.activate(), false);
	assert.deepEqual([...harness.tools.keys()], []);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.activeTools(), ["read", "bash"]);
	assert.equal(harness.activation.getCapturedActiveTools(), null);
});

test("demoted active attachment still restores its original normal set", () => {
	const harness = createHarness(["read", "bash"]);
	initializeDecisionTools(harness);
	assert.equal(harness.activate(), true);
	harness.setCurrentMain(false);

	assert.equal(harness.activation.restoreDecisionTools(), true);
	assert.equal(harness.activation.isActive(), false);
	assert.deepEqual(harness.activeTools(), ["read", "bash"]);
});

test("active main decision tools delegate the exact validated call", async () => {
	const harness = createHarness();
	const context = { marker: "decision-context" } as unknown as ExtensionContext;

	initializeDecisionTools(harness);
	assert.equal(harness.activate(), true);
	const continueTool = registeredTool(harness, CONTINUE_WATCHDOG_TOOL_NAME);
	const unlockTool = registeredTool(
		harness,
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	);
	const continueResult = await continueTool.execute(
		"continue-call",
		{},
		undefined,
		undefined,
		context,
	);
	const unlockResult = await unlockTool.execute(
		"unlock-call",
		{ reasonType: " job_done ", reason: "All tasks are complete." },
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
			reasonType: " job_done ",
			reason: "All tasks are complete.",
			toolCallId: "unlock-call",
			ctx: context,
		},
	]);
});

test("unlock execution forwards raw mixed-case reasonType without normalizing", async () => {
	const harness = createHarness();
	const context = {} as ExtensionContext;
	initializeDecisionTools(harness);
	assert.equal(harness.activate(), true);
	const unlockTool = registeredTool(
		harness,
		UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
	);

	await unlockTool.execute(
		"raw-type-call",
		{ reasonType: "WaIt_UsEr", reason: " Need input. " },
		undefined,
		undefined,
		context,
	);

	assert.deepEqual(harness.delegated, [
		{
			kind: "unlock",
			reasonType: "WaIt_UsEr",
			reason: " Need input. ",
			toolCallId: "raw-type-call",
			ctx: context,
		},
	]);
});

test("inactive or demoted execution returns the fixed terminating stale result", async () => {
	const harness = createHarness();
	const context = {} as ExtensionContext;

	initializeDecisionTools(harness);
	assert.equal(harness.activate(), true);
	const continueTool = registeredTool(harness, CONTINUE_WATCHDOG_TOOL_NAME);
	assert.equal(harness.activation.restoreDecisionTools(), true);

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

	assert.equal(harness.activate(), true);
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

test("Pi registration and active-tool failures restore normal tools and remain retryable", () => {
	const harness = createHarness();

	initializeDecisionTools(harness);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "edit"]);

	harness.throwRegisterTool(UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME);
	assert.throws(() => harness.activate(), /registerTool failed/);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "edit"]);
	assert.equal(harness.activation.isActive(), false);
	assert.equal(harness.activation.getCapturedActiveTools(), null);

	harness.throwNextSetActiveTools();
	assert.throws(() => harness.activate(), /setActiveTools failed/);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "edit"]);
	assert.equal(harness.activation.isActive(), false);
	assert.equal(harness.activation.getCapturedActiveTools(), null);

	assert.equal(harness.activate(), true);
	assert.deepEqual(harness.activation.getCapturedActiveTools(), [
		"read",
		"bash",
		"edit",
	]);

	harness.throwNextSetActiveTools();
	assert.throws(
		() => harness.activation.restoreDecisionTools(),
		/setActiveTools failed/,
	);
	assert.equal(harness.activation.isActive(), true);
	assert.equal(harness.activation.restoreDecisionTools(), true);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "edit"]);
});

test("claim fence demotion during first registerTool skips second tool and restores baseline", () => {
	const harness = createHarness(["read", "bash"]);
	initializeDecisionTools(harness);

	harness.onRegisterTool(CONTINUE_WATCHDOG_TOOL_NAME, () => {
		harness.setCurrentMain(false);
	});

	assert.equal(harness.activate(), false);
	assert.equal(harness.tools.has(CONTINUE_WATCHDOG_TOOL_NAME), true);
	assert.equal(harness.tools.has(UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME), false);
	assert.equal(harness.activation.isActive(), false);
	assert.equal(harness.activation.getCapturedActiveTools(), null);
	assert.deepEqual(harness.activeTools(), ["read", "bash"]);
	// Decision definitions must not remain active after abandon.
	assert.ok(
		!harness.activeTools().includes(CONTINUE_WATCHDOG_TOOL_NAME),
		"demoted first registration must not leave continue active",
	);
});

test("claim fence demotion during setActiveTools restores baseline and stays inactive", () => {
	const harness = createHarness(["read", "bash"]);
	initializeDecisionTools(harness);

	harness.onSetActiveTools((toolNames) => {
		if (
			toolNames.length === DECISION_TOOL_NAMES.length &&
			toolNames[0] === CONTINUE_WATCHDOG_TOOL_NAME
		) {
			harness.setCurrentMain(false);
		}
	});

	assert.equal(harness.activate(), false);
	assert.deepEqual(
		[...harness.tools.keys()],
		[CONTINUE_WATCHDOG_TOOL_NAME, UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME],
	);
	assert.equal(harness.activation.isActive(), false);
	assert.equal(harness.activation.getCapturedActiveTools(), null);
	assert.deepEqual(harness.activeTools(), ["read", "bash"]);
});

test("claim-fenced activation still succeeds exactly once for a live owner", () => {
	const harness = createHarness(["read", "bash"]);
	initializeDecisionTools(harness);

	assert.equal(harness.activate(), true);
	assert.deepEqual(harness.activeTools(), [...DECISION_TOOL_NAMES]);
	assert.equal(harness.activate(), false);
	assert.equal(harness.activation.restoreDecisionTools(), true);
	assert.deepEqual(harness.activeTools(), ["read", "bash"]);
});
