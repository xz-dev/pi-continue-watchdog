import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProcessDomainFatalError } from "pi-process-domain";

import {
	createFatalExitAdapter,
	sanitizedProcessDomainError,
} from "../src/fatal-exit.js";

function harness(mode: "tui" | "rpc" | "print" | "json") {
	let exitCode: number | undefined;
	let exitListener: ((code: number) => void) | undefined;
	let fallback: (() => void) | undefined;
	const calls: string[] = [];
	const adapter = createFatalExitAdapter({
		process: {
			get exitCode() {
				return exitCode;
			},
			set exitCode(value) {
				exitCode = value;
			},
			once(_event, listener) {
				exitListener = listener;
			},
			exit(code) {
				calls.push(`exit:${code}`);
			},
		},
		clock: {
			setTimeout(callback) {
				fallback = callback;
				return callback;
			},
			clearTimeout() {
				fallback = undefined;
			},
		},
	});
	const ctx = {
		mode,
		abort: () => calls.push("abort"),
		shutdown: () => calls.push("shutdown"),
		ui: { notify: (message: string) => calls.push(message) },
	} as unknown as ExtensionContext;
	return {
		adapter,
		ctx,
		calls,
		get exitCode() {
			return exitCode;
		},
		fireExit: (code = 0) => {
			exitCode = code;
			exitListener?.(code);
		},
		fireFallback: () => fallback?.(),
	};
}

for (const mode of ["tui", "rpc", "print", "json"] as const) {
	test(`fatal process-domain failure exits 78 in ${mode} mode`, () => {
		const testHarness = harness(mode);
		const error = new ProcessDomainFatalError(
			"AUTHENTICATION_FAILED",
			"secret-key private-endpoint",
		);
		testHarness.adapter.fail(error, testHarness.ctx);
		assert.equal(testHarness.exitCode, 78);
		assert.ok(testHarness.calls.includes("abort"));
		assert.equal(
			testHarness.calls.includes("shutdown"),
			mode === "tui" || mode === "rpc",
		);
		assert.equal(testHarness.calls.join(" ").includes("secret-key"), false);
		testHarness.fireExit();
		assert.equal(testHarness.exitCode, 78);
		testHarness.fireFallback();
		assert.ok(testHarness.calls.includes("exit:78"));
	});
}

test("graceful shutdown cancels fallback but preserves fatal exit guard", () => {
	const testHarness = harness("tui");
	const error = new ProcessDomainFatalError(
		"AUTHENTICATION_FAILED",
		"private details",
	);

	testHarness.adapter.fail(error, testHarness.ctx);
	testHarness.adapter.completeShutdown();
	testHarness.fireFallback();
	assert.equal(testHarness.calls.includes("exit:78"), false);

	// Production order: Pi completes session_shutdown, then explicitly exits 0.
	testHarness.fireExit();
	assert.equal(testHarness.exitCode, 78);
});

test("sanitized fatal output exposes only a stable code", () => {
	const message = sanitizedProcessDomainError(
		new ProcessDomainFatalError("DOMAIN_ABSENT", "key=hunter2 /tmp/private"),
	);
	assert.match(message, /DOMAIN_ABSENT/);
	assert.doesNotMatch(message, /hunter2|\/tmp\/private/);
});
