import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PrivateDecisionOptions } from "../src/private-decision.js";
import {
	awaitPrivatePrompt,
	createPrivateDriver,
	VALID_UNLOCK_JSON,
} from "./fixtures/private-decision-driver.js";

function options(
	signal?: AbortSignal,
): Omit<PrivateDecisionOptions, "runtime"> {
	return {
		fork: {
			parent: SessionManager.inMemory("/var/tmp"),
			parentProviderRegistry: {
				getRegisteredProviderIds: () => [],
				getRegisteredProviderConfig: () => undefined,
				getRegisteredNativeProvider: () => undefined,
			},
			cwd: "/var/tmp",
			model: "fake/local",
		},
		reasonTypes: ["JOB_DONE"],
		continueReasonTypes: ["WORK_REMAINS"],
		signal,
		isCurrent: () => signal?.aborted !== true,
		prompt: () => "Assess the existing delivery and write the result file.",
		correction: (error) => `Validation error: ${error}`,
	};
}

test("scripted private driver uses the real file operation and a separate child", {
	timeout: 10_000,
}, async () => {
	const driver = createPrivateDriver();
	driver.respond({ write: VALID_UNLOCK_JSON });
	const result = await driver.execute({
		...options(),
		runtime: driver.runtime,
	});
	assert.equal(result.kind, "decision");
	assert.equal(driver.children.length, 1);
	assert.equal(driver.children[0]?.prompts.length, 1);
	assert.deepEqual(driver.children[0]?.fileStates, ["{}"]);
	assert.equal(driver.current?.settled, true);
	assert.equal(driver.children[0]?.disposed, true);
});

test("scripted private cancellation releases a parked prompt and cleans up", {
	timeout: 10_000,
}, async () => {
	const driver = createPrivateDriver();
	const cancellation = new AbortController();
	const pending = driver.execute({
		...options(cancellation.signal),
		runtime: driver.runtime,
	});
	await awaitPrivatePrompt(driver);
	assert.equal(driver.awaitingResponse, true);
	cancellation.abort();
	const result = await pending;
	assert.equal(result.kind, "cancelled");
	assert.equal(driver.awaitingResponse, false);
	assert.equal(driver.children[0]?.disposed, true);
	assert.equal(driver.current?.settled, true);
});
