import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AI_UNLOCK_ENTRY_TYPE } from "../src/commands.js";
import {
	createDecisionFoldMessage,
	INQUIRY_MARKER_ENTRY_TYPE,
} from "../src/context-fold.js";
import {
	buildReviewSourceView,
	createReviewSourceMetadata,
	readReviewHistory,
} from "../src/review-context.js";

const exchangeId = "private-history-exchange";
const sessionId = "private-child";

function fixture() {
	const manager = SessionManager.inMemory("/var/tmp");
	manager.appendMessage({
		role: "user",
		content: "Deliver the summary.",
		timestamp: 1,
	});
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Summary delivered." }],
		provider: "fixture",
		api: "openai-completions",
		model: "fixture",
		timestamp: 2,
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const sourceLeaf = manager.getLeafId();
	assert.ok(sourceLeaf);
	const view = buildReviewSourceView(manager.buildContextEntries());
	const metadata = createReviewSourceMetadata(view, {
		sessionId: manager.getSessionId(),
	});
	manager.appendCustomEntry(INQUIRY_MARKER_ENTRY_TYPE, {
		version: 1,
		exchangeId,
		cycleId: 1,
		review: metadata,
	});
	const started = (inquiry: "initial" | "reconsideration" = "initial") =>
		manager.appendCustomEntry("pi-continue-watchdog:private-decision", {
			version: 1,
			exchangeId,
			cycleId: 1,
			childSessionId: sessionId,
			inquiry,
			phase: "started",
			sourceView: view.text,
			review: metadata,
		});
	const response = (
		attempt: number,
		inquiry: "initial" | "reconsideration" = "initial",
		invalid = false,
	) =>
		manager.appendCustomEntry("pi-continue-watchdog:private-response", {
			version: 1,
			exchangeId,
			cycleId: 1,
			sessionId,
			inquiry,
			attempt,
			outcome: invalid
				? { kind: "invalid", error: "action is required" }
				: {
						kind: "valid",
						decision: {
							kind: "unlock",
							reasonType: "JOB_DONE",
							matchedReasonType: "JOB_DONE",
							reason: "Delivered.",
						},
					},
		});
	const publish = () => {
		const fold = createDecisionFoldMessage({
			exchangeId,
			cycleId: 1,
			outcome: "unlock",
		});
		manager.appendCustomMessageEntry(
			fold.customType,
			fold.content,
			fold.display,
			fold.details,
		);
		manager.appendCustomEntry(AI_UNLOCK_ENTRY_TYPE, {
			exchangeId,
			cycleId: 1,
			reasonType: "JOB_DONE",
			reason: "Delivered.",
		});
	};
	return { manager, view, metadata, sourceLeaf, started, response, publish };
}

test("private history needs no parent prompt or result file to reconstruct published input/outcome", () => {
	const h = fixture();
	h.started();
	h.response(1);
	h.publish();
	const history = readReviewHistory(h.manager);
	assert.equal(history.diagnostic, undefined);
	assert.equal(history.records.length, 1);
	const record = history.records[0];
	assert.equal(record.status, "published");
	assert.equal(record.responseOutcome, "unlock");
	assert.equal(record.publishedOutcome, "unlock");
	assert.equal(record.reviewMetadata, "ok");
	assert.equal(record.source?.digest, h.metadata.digest);
	assert.equal(record.promptEntryId, undefined);
	assert.equal(record.childSessionId, sessionId);
	assert.equal(record.sourceView, h.view.text);
});

test("private history keeps local response association through correction and reconsideration", () => {
	const h = fixture();
	h.started();
	h.response(1, "initial", true);
	h.response(2);
	h.started("reconsideration");
	h.response(1, "reconsideration", true);
	const lastAudit = h.response(2, "reconsideration");
	h.publish();
	const history = readReviewHistory(h.manager);
	assert.equal(history.diagnostic, undefined);
	assert.equal(history.records.length, 1);
	assert.equal(history.records[0]?.auditEntryId, lastAudit);
	assert.equal(history.records[0]?.responseOutcome, "unlock");
	assert.equal(history.records[0]?.publishedOutcome, "unlock");
});

test("a private response cannot borrow another inquiry's start", () => {
	const h = fixture();
	h.started("initial");
	h.response(1, "reconsideration");
	const history = readReviewHistory(h.manager);
	assert.match(history.diagnostic ?? "", /private response.*association/);
	assert.equal(history.records[0]?.responseOutcome, undefined);
	assert.equal(history.records[0]?.publishedOutcome, undefined);
});

test("a private response with no recorded start remains unavailable history", () => {
	const h = fixture();
	h.response(1);
	const history = readReviewHistory(h.manager);
	assert.match(history.diagnostic ?? "", /private response.*association/);
	assert.equal(history.records[0]?.responseOutcome, undefined);
});

test("an unfinished private operation has no invented response or publication and is branch local", () => {
	const h = fixture();
	h.started();
	const history = readReviewHistory(h.manager);
	assert.equal(history.diagnostic, undefined);
	assert.equal(history.records[0]?.status, "pending");
	assert.equal(history.records[0]?.responseOutcome, undefined);
	assert.equal(history.records[0]?.publishedOutcome, undefined);
	h.manager.branch(h.sourceLeaf);
	assert.deepEqual(readReviewHistory(h.manager).records, []);
});
