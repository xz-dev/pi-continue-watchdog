import assert from "node:assert/strict";
import test from "node:test";

import {
	AI_UNLOCK_ENTRY_TYPE,
	type AiUnlockEntry,
	createAiUnlockEntryRenderer,
	createHumanUnlockEntryRenderer,
	formatContinueTimeline,
} from "../src/commands.js";

const theme = { fg: (_color: string, text: string) => text };

function aiUnlockEntry(data: Partial<AiUnlockEntry>): {
	id: string;
	type: string;
	customType: string;
	timestamp: string;
	data: Partial<AiUnlockEntry>;
} {
	return {
		id: "ai-unlock-entry",
		type: "custom",
		customType: AI_UNLOCK_ENTRY_TYPE,
		timestamp: "1970-01-01T00:00:00.000+00:00",
		data,
	};
}

test("A2: one quiet AI-unlock status shows source/status/type/reason only", () => {
	const component = createAiUnlockEntryRenderer()(
		aiUnlockEntry({
			reasonType: "JOB_DONE",
			reason: "Requested analysis delivered.",
			exchangeId: "exA",
			cycleId: 1,
		}) as never,
		{ expanded: false },
		theme as never,
	);
	assert.ok(component);
	assert.deepEqual(component.render(80), [
		"Continue watchdog unlocked · JOB_DONE · Requested analysis delivered.",
	]);
});

test("A2: no timestamp, box, or disclaimer in the quiet status", () => {
	const component = createAiUnlockEntryRenderer()(
		aiUnlockEntry({
			reasonType: "JOB_DONE",
			reason: "Requested analysis delivered.",
			exchangeId: "exA",
			cycleId: 1,
		}) as never,
		{ expanded: false },
		theme as never,
	);
	const text = (component?.render(200) ?? []).join("\n");
	assert.doesNotMatch(text, /1970-01-01/);
	assert.doesNotMatch(
		text,
		/not user approval|not a user message|authorization/i,
	);
	assert.doesNotMatch(text, /exA/);
	assert.doesNotMatch(text, /cycle/i);
});

test("A2: malformed metadata renders nothing", () => {
	assert.equal(
		createAiUnlockEntryRenderer()(
			aiUnlockEntry({ reasonType: "", reason: "" }) as never,
			{ expanded: false },
			theme as never,
		),
		undefined,
	);
});

test("A2: control characters sanitized and narrow width wraps safely", () => {
	const component = createAiUnlockEntryRenderer()(
		aiUnlockEntry({
			reasonType: "JOB_DONE",
			reason: "done\u0007 and \u001b[31mred\u001b[0m plus wide 世界字",
			exchangeId: "exA",
			cycleId: 1,
		}) as never,
		{ expanded: false },
		theme as never,
	);
	const lines = component?.render(20) ?? [];
	assert.ok(lines.length > 1, "long reason wraps");
	for (const line of lines) {
		assert.equal(line.includes("\u001b["), false);
		assert.equal(line.includes("\u0007"), false);
	}
});

test("A2: human unlock presentation stays unchanged", () => {
	const human = createHumanUnlockEntryRenderer()(
		{
			id: "h",
			type: "custom",
			customType: "pi-continue-watchdog:unlock",
			data: { reason: "Taking over manually." },
		} as never,
		{ expanded: false },
		theme as never,
	);
	assert.deepEqual(human?.render(80), [
		"Continue watchdog unlocked · Taking over manually.",
	]);
});

test("A2: timeline renders the AI unlock once with its typed reason", () => {
	const timeline = formatContinueTimeline([
		aiUnlockEntry({
			reasonType: "JOB_DONE",
			reason: "Requested analysis delivered.",
			exchangeId: "exA",
			cycleId: 1,
		}),
	]);
	assert.match(
		timeline,
		/AI unlock · JOB_DONE · Requested analysis delivered\./,
	);
});

test("callback suspension renders one retained-lock status, never 'unlocked'", () => {
	const component = createAiUnlockEntryRenderer()(
		aiUnlockEntry({
			reasonType: "WAIT_CALLBACK",
			reason: "Waiting for the child.",
			exchangeId: "exA",
			cycleId: 1,
			effect: "callback-suspended",
		}) as never,
		{ expanded: false },
		theme as never,
	);
	const text = (component?.render(200) ?? []).join("\n");
	assert.match(text, /waiting for callback \(lock retained\)/);
	assert.match(text, /WAIT_CALLBACK · Waiting for the child\./);
	assert.doesNotMatch(text, /unlocked/);
	const timeline = formatContinueTimeline([
		aiUnlockEntry({
			reasonType: "WAIT_CALLBACK",
			reason: "Waiting for the child.",
			exchangeId: "exA",
			cycleId: 1,
			effect: "callback-suspended",
		}),
	]);
	assert.match(
		timeline,
		/callback wait · WAIT_CALLBACK · Waiting for the child\./,
	);
});

test("legacy WAIT_CALLBACK unlock records keep their unlock meaning", () => {
	const component = createAiUnlockEntryRenderer()(
		aiUnlockEntry({
			reasonType: "WAIT_CALLBACK",
			reason: "Old callback unlock.",
			exchangeId: "exA",
			cycleId: 1,
		}) as never,
		{ expanded: false },
		theme as never,
	);
	assert.deepEqual(component?.render(80), [
		"Continue watchdog unlocked · WAIT_CALLBACK · Old callback unlock.",
	]);
	assert.match(
		formatContinueTimeline([
			aiUnlockEntry({
				reasonType: "WAIT_CALLBACK",
				reason: "Old callback unlock.",
				exchangeId: "exA",
				cycleId: 1,
			}),
		]),
		/AI unlock · WAIT_CALLBACK · Old callback unlock\./,
	);
});
