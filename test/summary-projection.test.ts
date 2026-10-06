import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	createDecisionFoldMessage,
	createDecisionPromptMessage,
	foldDecisionContext,
	parseDecisionFoldDetails,
} from "../src/context-fold.js";
import {
	type CompactionPreparationLike,
	projectBranchPreparation,
	projectCompactionPreparation,
} from "../src/summary-projection.js";
import {
	createDecisionFailedWatchdogEvent,
	createExhaustedWatchdogEvent,
	formatDecisionFailedWatchdogEvent,
	formatExhaustedWatchdogEvent,
	WATCHDOG_EVENT_MESSAGE_TYPE,
} from "../src/watchdog-event.js";

/**
 * Production native-summary projection unit seams: idempotence and boundary
 * preservation on structural preparations. The authoritative transport
 * evidence lives in test/e2e/native-summary.test.ts against the actual host.
 */

function customMessageEntry(
	id: string,
	customType: string,
	content: string,
	details: unknown,
	display: boolean,
): SessionEntry {
	return {
		type: "custom_message",
		customType,
		content,
		display,
		details,
		id,
		parentId: null,
		timestamp: "2024-01-01T00:00:00.000Z",
	} as SessionEntry;
}

function messageEntry(
	id: string,
	role: "user" | "assistant",
	text: string,
): SessionEntry {
	return {
		type: "message",
		message: { role, content: [{ type: "text", text }] },
		id,
		parentId: null,
		timestamp: "2024-01-01T00:00:00.000Z",
	} as unknown as SessionEntry;
}

const CONTINUATION = "pi-continue-watchdog:continuation";
const FOLD = "pi-continue-watchdog:inquiry-fold";
const INQUIRY = "pi-continue-watchdog:inquiry";

function ownedExchange(entries: SessionEntry[], exchange: string): void {
	entries.push(
		customMessageEntry(
			`m-${exchange}`,
			INQUIRY,
			`prompt ${exchange}`,
			{
				version: 1,
				namespace: "pi-continue-watchdog",
				inquiryId: exchange,
				attempt: 1,
			},
			false,
		),
	);
	entries.push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: `cw-${exchange}`,
					name: "cw",
					arguments: { action: "continue" },
				},
			],
			stopReason: "toolUse",
		},
		id: `a-${exchange}`,
		parentId: null,
		timestamp: "2024-01-01T00:00:00.000Z",
	} as unknown as SessionEntry);
	entries.push(
		customMessageEntry(
			`f-${exchange}`,
			FOLD,
			"Continue watchdog · continue · WORK_REMAINS",
			{
				version: 1,
				namespace: "pi-continue-watchdog",
				inquiryId: exchange,
				attempt: 1,
				outcome: "replace",
				watchdogOutcome: "continue",
				replacement: {
					customType: CONTINUATION,
					content: "Continue watchdog · continue · WORK_REMAINS",
					details: { version: 1, exchangeId: exchange, outcome: "continue" },
				},
			},
			true,
		),
	);
}

test("compaction projection is idempotent and preserves unrelated entries", () => {
	const branch: SessionEntry[] = [
		messageEntry("u1", "user", "ordinary task"),
		messageEntry("a1", "assistant", "ordinary answer"),
	];
	ownedExchange(branch, "ex1");
	branch.push(
		customMessageEntry(
			"other-1",
			"other-extension:work",
			"UNRELATED",
			{},
			true,
		),
	);
	branch.push(messageEntry("u2", "user", "tail"));

	const preparation: CompactionPreparationLike = {
		firstKeptEntryId: "u2",
		messagesToSummarize: [
			{ role: "user", content: "ordinary task" },
			{ role: "assistant", content: "ordinary answer" },
			{
				role: "custom",
				customType: INQUIRY,
				content: "prompt ex1",
				details: {
					version: 1,
					namespace: "pi-continue-watchdog",
					inquiryId: "ex1",
					attempt: 1,
				},
			},
			{
				role: "assistant",
				content: [],
				toolCalls: [{ id: "cw-ex1", name: "cw" }],
			} as never,
			{
				role: "custom",
				customType: FOLD,
				content: "Continue watchdog · continue · WORK_REMAINS",
				details: {
					version: 1,
					namespace: "pi-continue-watchdog",
					inquiryId: "ex1",
					attempt: 1,
					outcome: "replace",
					watchdogOutcome: "continue",
					replacement: {
						customType: CONTINUATION,
						content: "Continue watchdog · continue · WORK_REMAINS",
					},
				},
			},
			{
				role: "custom",
				customType: "other-extension:work",
				content: "UNRELATED",
				details: {},
			},
		],
		turnPrefixMessages: [],
	};

	projectCompactionPreparation(preparation, branch);
	const firstPass = JSON.stringify(preparation.messagesToSummarize);
	projectCompactionPreparation(preparation, branch);
	const secondPass = JSON.stringify(preparation.messagesToSummarize);
	assert.equal(secondPass, firstPass, "projection is idempotent");

	const types = preparation.messagesToSummarize.map(
		(message) =>
			(message as { role?: string; customType?: string }).customType ??
			(message as { role?: string }).role,
	);
	assert.deepEqual(types, [
		"user",
		"assistant",
		CONTINUATION,
		"other-extension:work",
	]);
});

test("branch projection is idempotent and drops control folds without continuation", () => {
	const oldBranch: SessionEntry[] = [messageEntry("u1", "user", "root task")];
	ownedExchange(oldBranch, "exT");
	// A legacy wait replace-fold: recognizable control payload, no prompt.
	oldBranch.push(
		customMessageEntry(
			"f-wait",
			FOLD,
			"Continue watchdog waiting · 30s",
			{
				version: 1,
				namespace: "pi-continue-watchdog",
				inquiryId: "legacyWait",
				attempt: 1,
				outcome: "replace",
				watchdogOutcome: "wait",
				replacement: {
					customType: "pi-continue-watchdog:event",
					content: "Continue watchdog waiting · 30s",
				},
			},
			true,
		),
	);
	// A quiet AI-unlock status entry: the pinned host excludes plain custom
	// entries from branch-summary preparation by design, so projection never
	// sees it; no type-based filtering is performed here. Actual serialized
	// requests are asserted in the production e2e suites.

	const preparation = {
		entriesToSummarize: [...oldBranch],
	};
	projectBranchPreparation(preparation, oldBranch);
	const firstPass = JSON.stringify(preparation.entriesToSummarize);
	projectBranchPreparation(preparation, oldBranch);
	assert.equal(
		JSON.stringify(preparation.entriesToSummarize),
		firstPass,
		"branch projection is idempotent",
	);
	const body = JSON.stringify(preparation.entriesToSummarize);
	assert.match(body, /root task/);
	assert.match(body, /Continue watchdog · continue · WORK_REMAINS/);
	assert.doesNotMatch(body, /Continue watchdog waiting/);
	assert.doesNotMatch(body, /prompt exT/);
});

test("branch projection preserves the supplied array identity", () => {
	const oldBranch: SessionEntry[] = [messageEntry("u1", "user", "solo")];
	const entriesToSummarize: SessionEntry[] = [...oldBranch];
	const preparation = { entriesToSummarize };
	projectBranchPreparation(preparation, oldBranch);
	assert.equal(preparation.entriesToSummarize, entriesToSummarize);
});

for (const [label, patch] of [
	["foreign namespace", { namespace: "other-extension", version: 999 }],
	["unsupported version", { version: 999 }],
	["empty inquiry id", { inquiryId: "" }],
	["invalid inquiry id", { inquiryId: "bad id" }],
	["zero attempt", { attempt: 0 }],
	["fractional attempt", { attempt: 1.5 }],
	[
		"invalid watchdog event",
		{ watchdogEvent: { kind: "unlock", version: 999 } },
	],
] as const) {
	test(`native projections preserve invalid fold metadata: ${label}`, () => {
		const correlation = {
			version: 1,
			namespace: "pi-continue-watchdog",
			inquiryId: "invalid-fold",
			attempt: 1,
		};
		const details = {
			...correlation,
			outcome: "remove",
			watchdogOutcome: "invalidated",
			...patch,
		};
		assert.equal(parseDecisionFoldDetails(details), undefined);
		const malformed = customMessageEntry(
			"bad",
			FOLD,
			"PRESERVE",
			details,
			true,
		);
		const wire = {
			role: "custom",
			customType: FOLD,
			content: "PRESERVE",
			details,
		};
		const tail = messageEntry("tail", "user", "later");
		// Also retain malformed folds when the generic inquiry folder sees a
		// matching prompt: that folder does not validate watchdog event metadata.
		for (const withPrompt of [false, true]) {
			const prompt = customMessageEntry(
				"prompt",
				INQUIRY,
				"prompt",
				correlation,
				false,
			);
			const branch = [...(withPrompt ? [prompt] : []), malformed, tail];
			const raw = JSON.stringify(branch);
			const selected = { ...malformed };
			const entriesToSummarize = [selected];
			const branchPrep = { entriesToSummarize };
			projectBranchPreparation(branchPrep, branch);
			assert.equal(branchPrep.entriesToSummarize, entriesToSummarize);
			assert.deepEqual(branchPrep.entriesToSummarize, [selected]);
			assert.equal(branchPrep.entriesToSummarize[0], selected);

			const messagesToSummarize = withPrompt
				? [
						{
							role: "custom",
							customType: INQUIRY,
							content: "prompt",
							details: correlation,
						},
						wire,
					]
				: [wire];
			const turnPrefixMessages: unknown[] = [];
			const compactionPrep = {
				firstKeptEntryId: "tail",
				messagesToSummarize,
				turnPrefixMessages,
			};
			projectCompactionPreparation(compactionPrep, branch);
			assert.equal(compactionPrep.messagesToSummarize, messagesToSummarize);
			assert.equal(compactionPrep.turnPrefixMessages, turnPrefixMessages);
			assert.equal(compactionPrep.messagesToSummarize.at(-1), wire);
			assert.equal(JSON.stringify(branch), raw, "raw history is unchanged");
		}
	});
}

test("valid owned fold metadata still receives special handling in both paths", () => {
	// Control for R2: narrowing ownership must not weaken real fold handling.
	// A terminal remove fold with valid correlation is still dropped.
	const prompt = customMessageEntry(
		"p1",
		"pi-continue-watchdog:inquiry",
		"PRIVATE_PROMPT",
		{
			version: 1,
			namespace: "pi-continue-watchdog",
			inquiryId: "ex-r2",
			attempt: 1,
		},
		false,
	);
	const fold = customMessageEntry(
		"f1",
		"pi-continue-watchdog:inquiry-fold",
		"",
		{
			version: 1,
			namespace: "pi-continue-watchdog",
			inquiryId: "ex-r2",
			attempt: 1,
			outcome: "remove",
			watchdogOutcome: "invalidated",
		},
		false,
	);
	const branch = [prompt, fold];
	const branchPrep = { entriesToSummarize: [{ ...prompt }, { ...fold }] };
	projectBranchPreparation(branchPrep as never, branch as never);
	assert.deepEqual(branchPrep.entriesToSummarize, []);
});

test("native summaries keep shared failure and exhaustion at selected positions", () => {
	const event = createDecisionFailedWatchdogEvent({
		occurredAtMs: 1,
		offsetMinutes: 0,
		error: "SAFE_FAILURE_DIAGNOSTIC",
	});
	const failure = createDecisionFoldMessage({
		exchangeId: "failed-ex",
		cycleId: 3,
		outcome: "decision-failed",
		eventContent: formatDecisionFailedWatchdogEvent(event),
		watchdogEvent: event,
	});
	const exhausted = createExhaustedWatchdogEvent({
		occurredAtMs: 2,
		offsetMinutes: 0,
	});
	const messages: object[] = [{ role: "user", content: "before" }];
	for (let cycleId = 1; cycleId <= 3; cycleId++) {
		messages.push(
			{
				role: "custom",
				...createDecisionPromptMessage({
					exchangeId: "failed-ex",
					cycleId,
					decisionPrompt: `PRIVATE_PROMPT_${cycleId}`,
				}),
			},
			{ role: "assistant", content: [], stopReason: "stop" },
		);
	}
	messages.push(
		{ role: "custom", ...failure },
		{ role: "user", content: "after" },
		{
			role: "custom",
			customType: WATCHDOG_EVENT_MESSAGE_TYPE,
			content: formatExhaustedWatchdogEvent(exhausted),
			details: exhausted,
			display: true,
		},
	);
	const entries = messages.map((message, index) => {
		const msg = message as {
			role: string;
			customType?: string;
			content: string;
			details?: unknown;
			display?: boolean;
		};
		return msg.role === "custom"
			? customMessageEntry(
					String(index),
					String(msg.customType),
					msg.content,
					msg.details,
					msg.display === true,
				)
			: ({
					type: "message",
					id: String(index),
					parentId: null,
					timestamp: "2024-01-01T00:00:00.000Z",
					message,
				} as SessionEntry);
	});
	const branch = [...entries, messageEntry("tail", "user", "later")];
	const raw = JSON.stringify(branch);
	const ordinary = foldDecisionContext(messages);
	assert.match(JSON.stringify(ordinary), /SAFE_FAILURE_DIAGNOSTIC/);

	// The fold starts the host's split-turn prefix; its safe replacement
	// belongs there, not at the prompt position in the history region.
	const messagesToSummarize = messages.slice(0, 7);
	const turnPrefixMessages = messages.slice(7);
	const compact = {
		firstKeptEntryId: "tail",
		messagesToSummarize,
		turnPrefixMessages,
	};
	projectCompactionPreparation(compact, branch);
	assert.equal(compact.messagesToSummarize, messagesToSummarize);
	assert.equal(compact.turnPrefixMessages, turnPrefixMessages);
	assert.deepEqual(compact.messagesToSummarize, [messages[0]]);
	assert.match(
		JSON.stringify(compact.turnPrefixMessages[0]),
		/SAFE_FAILURE_DIAGNOSTIC/,
	);
	assert.deepEqual(compact.turnPrefixMessages.slice(1), messages.slice(8));
	const orphan = {
		firstKeptEntryId: "tail",
		messagesToSummarize: messages.slice(7),
		turnPrefixMessages: [],
	};
	projectCompactionPreparation(orphan, branch.slice(7));
	assert.equal(
		(orphan.messagesToSummarize[0] as { role: string }).role,
		"custom",
	);
	assert.match(
		JSON.stringify(orphan.messagesToSummarize[0]),
		/SAFE_FAILURE_DIAGNOSTIC/,
	);
	assert.deepEqual(orphan.messagesToSummarize.slice(1), messages.slice(8));

	// Full selection and an orphaned fold must both preserve the same safe
	// body; a region that excludes the fold must not acquire its replacement.
	for (const selected of [entries, entries.slice(7), entries.slice(0, 7)]) {
		const entriesToSummarize = [...selected];
		const tree = { entriesToSummarize };
		projectBranchPreparation(tree, branch);
		assert.equal(tree.entriesToSummarize, entriesToSummarize);
		const expected = selected.includes(entries[7]);
		assert.equal(
			JSON.stringify(tree).includes("SAFE_FAILURE_DIAGNOSTIC"),
			expected,
		);
		assert.doesNotMatch(JSON.stringify(tree), /PRIVATE_PROMPT_|inquiry-fold/);
		if (expected) {
			const index = selected === entries ? 1 : 0;
			assert.match(
				JSON.stringify(tree.entriesToSummarize[index]),
				/SAFE_FAILURE_DIAGNOSTIC/,
			);
			assert.deepEqual(
				tree.entriesToSummarize.slice(index + 1),
				entries.slice(8),
			);
		}
	}
	assert.doesNotMatch(JSON.stringify(compact), /PRIVATE_PROMPT_|inquiry-fold/);
	assert.equal(JSON.stringify(branch), raw);
});
