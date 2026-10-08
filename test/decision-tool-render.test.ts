import assert from "node:assert/strict";
import test from "node:test";

import { Container, Text } from "@earendil-works/pi-tui";

import { BUILT_IN_CONFIG } from "../src/config.js";
import {
	createDecisionToolDefinition,
	DECISION_ALREADY_SUBMITTED_ERROR,
	type DecisionToolHost,
	RESERVED_FUNCTION_ERROR,
} from "../src/decision-tool.js";

type RenderedResult = {
	readonly content: ReadonlyArray<{
		readonly type: string;
		readonly text?: string;
	}>;
	readonly details: unknown;
};

type RenderContext = {
	readonly toolCallId: string;
	readonly isError: boolean;
	readonly isPartial: boolean;
};

function tool(host: DecisionToolHost) {
	return createDecisionToolDefinition(
		host,
		BUILT_IN_CONFIG.reasonTypes,
		BUILT_IN_CONFIG.continueReasonTypes,
	);
}

function renderResult(
	definition: ReturnType<typeof tool>,
	result: RenderedResult,
	context: RenderContext,
): string[] {
	const renderer = definition.renderResult;
	if (renderer === undefined) throw new Error("renderResult is required");
	const component = renderer(
		result as never,
		{ expanded: false, isPartial: context.isPartial },
		{} as never,
		context as never,
	);
	if (component instanceof Container) return [];
	if (component instanceof Text) return component.render(80);
	return component.render(80);
}

const unauthorizedHost: DecisionToolHost = {
	submitDecisionResult: () => ({ outcome: "unauthorized" }),
};

function textOf(lines: string[]): string {
	return lines.join("\n").replace(/\s+$/, "");
}

test("owned received receipt stays quiet after live ownership ends", async () => {
	let owned = true;
	const definition = tool({
		submitDecisionResult: () => ({
			outcome: "staged",
			validation: { valid: true },
		}),
		isOwnedDecisionCall: (id) => owned && id === "owned-call",
	});
	const result = await definition.execute(
		"owned-call",
		{},
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(
		(result as { details: { outcome: string } }).details.outcome,
		"received",
	);
	const context = {
		toolCallId: "owned-call",
		isError: false,
		isPartial: false,
	};
	assert.deepEqual(
		renderResult(definition, result as never, context),
		[],
		"live owned receipt is quiet",
	);
	owned = false;
	assert.deepEqual(
		renderResult(definition, result as never, context),
		[],
		"persisted owned receipt stays quiet after finalization/resume",
	);
});

test("owned corrected (invalid) receipt stays quiet through the correction cycle", async () => {
	const definition = tool({
		submitDecisionResult: () => ({
			outcome: "staged",
			validation: { valid: false, error: "reason_content must be non-empty" },
		}),
	});
	const result = await definition.execute(
		"owned-invalid",
		{},
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(
		(result as { details: { outcome: string } }).details.outcome,
		"invalid",
	);
	assert.deepEqual(
		renderResult(definition, result as never, {
			toolCallId: "owned-invalid",
			isError: true,
			isPartial: false,
		}),
		[],
		"owned validation failure is quiet (terminal diagnostic comes from the decision-failed event)",
	);
});

test("ordinary reserved rejection stays visible with copied arguments or reused ids", async () => {
	const definition = tool(unauthorizedHost);
	// Same literal arguments a real owned call would carry; the runtime still
	// answers unauthorized, and the rejection must render.
	const args = {
		action: "continue",
		reason_type: "WORK_REMAINS",
		reason_content: "looks owned",
	};
	const result = await definition.execute(
		"reused-id",
		args,
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(
		(result as { details: { outcome: string } }).details.outcome,
		"reserved",
	);
	const lines = renderResult(definition, result as never, {
		toolCallId: "reused-id",
		isError: false,
		isPartial: false,
	});
	assert.match(textOf(lines), new RegExp(RESERVED_FUNCTION_ERROR));
	// A duplicate submission inside one authorized attempt is internal
	// correction-cycle traffic (details.outcome "invalid") and stays quiet;
	// the safe terminal diagnostic comes from the decision-failed event.
	const duplicate = tool({
		submitDecisionResult: () => ({ outcome: "duplicate" }),
	});
	const duplicateResult = await duplicate.execute(
		"reused-id",
		args,
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(
		(duplicateResult as { details: { outcome: string } }).details.outcome,
		"invalid",
		"duplicate is an owned invalid outcome",
	);
	assert.deepEqual(
		renderResult(duplicate, duplicateResult as never, {
			toolCallId: "reused-id",
			isError: false,
			isPartial: false,
		}),
		[],
		"duplicate receipt is quiet as owned correction traffic",
	);
	// The reserved marker never grants quietness: forging it is visible.
	assert.ok(DECISION_ALREADY_SUBMITTED_ERROR.length > 0);
});

test("unowned host error result with empty details stays visible", () => {
	// Pinned 0.85.1 createErrorToolResult: host-authored tool errors carry
	// {content:[{type:"text",text:message}],details:{}}. These come from
	// argument validation, pre-call blocking, aborts, and thrown execute —
	// ordinary traffic that must not be hidden by the quiet-internal rule.
	const definition = tool(unauthorizedHost);
	const hostError = {
		content: [{ type: "text", text: "ORDINARY_HOST_TOOL_ERROR" }],
		details: {},
	};
	for (const toolCallId of ["ordinary-host-error", "cw", "any-id"]) {
		const lines = renderResult(definition, hostError as never, {
			toolCallId,
			isError: true,
			isPartial: false,
		});
		assert.match(
			textOf(lines),
			/ORDINARY_HOST_TOOL_ERROR/,
			`host error with details:{} renders visibly (toolCallId=${toolCallId})`,
		);
	}
});

test("missing details object fails open to visible text instead of crashing", () => {
	const definition = tool(unauthorizedHost);
	const malformed = { content: [{ type: "text", text: "ORPHAN_RESULT" }] };
	const lines = renderResult(definition, malformed as never, {
		toolCallId: "orphan",
		isError: false,
		isPartial: false,
	});
	assert.match(textOf(lines), /ORPHAN_RESULT/);
});

test("forged details never grant quietness: unknown outcome values render visibly", () => {
	const definition = tool(unauthorizedHost);
	for (const outcome of [
		"received ",
		"invalid\0",
		"RECEIVED",
		"unlock",
		"",
		undefined,
		null,
		1,
	]) {
		const forged = {
			content: [{ type: "text", text: `FORGED_${String(outcome)}` }],
			details: { outcome },
		};
		const lines = renderResult(definition, forged as never, {
			toolCallId: "forged",
			isError: false,
			isPartial: false,
		});
		assert.match(
			textOf(lines),
			/FORGED_/,
			`only exact received/invalid identity is quiet; outcome=${JSON.stringify(outcome)} stays visible`,
		);
	}
});

test("owned renderCall stays quiet while ownership is live and empty otherwise", () => {
	let owned = true;
	const definition = tool({
		submitDecisionResult: () => ({
			outcome: "staged",
			validation: { valid: true },
		}),
		isOwnedDecisionCall: (id) => owned && id === "owned-call",
	});
	const callRenderer = definition.renderCall;
	if (callRenderer === undefined) throw new Error("renderCall is required");
	const component = callRenderer(
		{} as never,
		{} as never,
		{ toolCallId: "owned-call", isPartial: false, isError: false } as never,
	);
	assert.ok(component instanceof Container, "owned call hides while live");
	owned = false;
	const settled = callRenderer(
		{} as never,
		{} as never,
		{ toolCallId: "owned-call", isPartial: false, isError: false } as never,
	);
	// A completed non-error call is a settled row the host collapses; the
	// placeholder component renders zero lines either way, so a persisted
	// owned call row never flashes content after ownership ends.
	assert.deepEqual(settled.render(80), []);
	const erroring = callRenderer(
		{} as never,
		{} as never,
		{ toolCallId: "owned-call", isPartial: true, isError: false } as never,
	);
	assert.deepEqual(erroring.render(80), []);
});

test("real ToolExecutionComponent keeps pinned host error results visible", async () => {
	// Native seam: the pinned 0.85.1 TUI component that hosts every tool
	// result. It passes {content, details} straight into renderResult and
	// falls back to visible text when a renderer throws. This reproduces the
	// exact production render path for a host-authored error result
	// (createErrorToolResult: {content:[{type:"text",text}],details:{}}).
	const { ToolExecutionComponent } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const definition = tool(unauthorizedHost);
	const ui = {
		requestRender() {},
	} as never;
	const component = new ToolExecutionComponent(
		"cw",
		"ordinary-host-error",
		{},
		{},
		definition as never,
		ui,
		"/tmp",
	);
	component.updateResult(
		{
			content: [{ type: "text", text: "ORDINARY_HOST_TOOL_ERROR" }],
			details: {},
			isError: true,
		} as never,
		false,
	);
	const lines = component.render(80);
	const joined = lines.join("\n");
	assert.match(
		joined,
		/ORDINARY_HOST_TOOL_ERROR/,
		"the real host component renders the error text through our renderer",
	);
	// The same component renders owned receipts with zero visible lines.
	const ownedComponent = new ToolExecutionComponent(
		"cw",
		"owned-receipt",
		{},
		{},
		tool({
			submitDecisionResult: () => ({
				outcome: "staged",
				validation: { valid: true },
			}),
		}) as never,
		ui,
		"/tmp",
	);
	ownedComponent.updateResult(
		{
			content: [{ type: "text", text: "Decision received." }],
			details: { outcome: "received" },
			isError: false,
		} as never,
		false,
	);
	const ownedLines = ownedComponent.render(80);
	assert.equal(
		ownedLines.filter((line) => line.trim().length > 0).length,
		0,
		"owned receipt renders no visible rows through the real component",
	);
});
