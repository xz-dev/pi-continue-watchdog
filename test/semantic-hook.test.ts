import assert from "node:assert/strict";
import test from "node:test";

import {
	createUserReadyEnvelope,
	createWatchdogContinuedEnvelope,
	emitSemanticHook,
	SEMANTIC_HOOK_CHANNEL,
	USER_READY_HOOK_NAME,
	WATCHDOG_CONTINUED_HOOK_NAME,
} from "../src/semantic-hook.js";

test("published hook set: user-ready kinds and empty continuation values", () => {
	const continued = createWatchdogContinuedEnvelope();
	assert.equal(continued.name, WATCHDOG_CONTINUED_HOOK_NAME);
	assert.equal("values" in continued && continued.values !== undefined, false);

	const aiUnlock = createUserReadyEnvelope({
		STOP_KIND: "AI_UNLOCK",
		REASON_TYPE: "JOB_DONE",
		REASON: "All requested work is complete.",
	});
	assert.deepEqual(aiUnlock.values, {
		STOP_KIND: "AI_UNLOCK",
		REASON_TYPE: "JOB_DONE",
		REASON: "All requested work is complete.",
	});

	const errorUnlock = createUserReadyEnvelope({ STOP_KIND: "ERROR_UNLOCK" });
	assert.deepEqual(errorUnlock.values, { STOP_KIND: "ERROR_UNLOCK" });

	const exhausted = createUserReadyEnvelope({ STOP_KIND: "EXHAUSTED" });
	assert.deepEqual(exhausted.values, { STOP_KIND: "EXHAUSTED" });
});

test("non-AI stop kinds never invent type or reason fields", () => {
	assert.equal(
		createUserReadyEnvelope({ STOP_KIND: "EXHAUSTED" }).values?.REASON_TYPE,
		undefined,
	);
	assert.equal(
		createUserReadyEnvelope({ STOP_KIND: "ERROR_UNLOCK" }).values?.REASON,
		undefined,
	);
});

test("envelopes are frozen fresh plain data", () => {
	const first = createUserReadyEnvelope({
		STOP_KIND: "AI_UNLOCK",
		REASON_TYPE: "WAIT_USER",
		REASON: "Need approval.",
	});
	const second = createUserReadyEnvelope({
		STOP_KIND: "AI_UNLOCK",
		REASON_TYPE: "WAIT_USER",
		REASON: "Need approval.",
	});
	assert.notEqual(first, second);
	assert.ok(Object.isFrozen(first));
	assert.ok(Object.isFrozen(first.values));
	assert.equal(first.version, 1);
	assert.equal(first.name, USER_READY_HOOK_NAME);
});

test("emission is best-effort on the public channel", () => {
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const events = {
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
		},
	};
	emitSemanticHook(events, createWatchdogContinuedEnvelope());
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].channel, SEMANTIC_HOOK_CHANNEL);
	assert.equal(
		(emitted[0].data as { name: string }).name,
		WATCHDOG_CONTINUED_HOOK_NAME,
	);
});

test("a throwing listener exception propagates out of emission (bus-contained)", () => {
	const events = {
		emit() {
			throw new Error("listener exploded");
		},
	};
	assert.throws(() =>
		emitSemanticHook(events, createWatchdogContinuedEnvelope()),
	);
});

// Runtime-integration coverage of hook publication lives in test/runtime.test.ts:
// continuation publishes watchdog-continued with empty values, tool unlock
// publishes AI_UNLOCK with REASON_TYPE/REASON at aggregate idle, exhaustion
// publishes EXHAUSTED, and human/manual paths stay silent.
