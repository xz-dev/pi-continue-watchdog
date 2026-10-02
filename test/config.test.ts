import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	BUILT_IN_CONFIG,
	DEFAULT_CONTINUE_PROMPT,
	DEFAULT_REASON_TYPES,
	loadConfigText,
	MAX_PROMPT_CHARACTERS,
	MAX_RETRIES,
	MIN_IDLE_DELAY_SECONDS,
	MIN_RETRIES,
	mergeConfig,
	validateConfig,
} from "../src/config.js";
import { loadRuntimeConfig } from "../src/config-loader.js";

async function fixture(
	t: TestContext,
): Promise<{ agentDir: string; cwd: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-continue-watchdog-config-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	return { agentDir, cwd };
}

test("built-in defaults match the effective configuration keys", () => {
	assert.equal(BUILT_IN_CONFIG.idleDelaySeconds, 10);
	assert.equal(BUILT_IN_CONFIG.maxRetries, 10);
	assert.equal(BUILT_IN_CONFIG.continuePrompt, DEFAULT_CONTINUE_PROMPT);
	assert.deepEqual(BUILT_IN_CONFIG.reasonTypes, [
		"JOB_DONE",
		"WAIT_USER",
		"JOB_BLOCKED",
		"WAIT_CALLBACK",
	]);
	assert.deepEqual(DEFAULT_REASON_TYPES, BUILT_IN_CONFIG.reasonTypes);
	assert.equal(BUILT_IN_CONFIG.unlockShortcut, "alt+u");
});

test("removed keys produce named error diagnostics and have no effect", () => {
	const globalLayer = validateConfig("global", {
		decisionPrompt: "Old decision prompt.",
		maxRetries: 5,
	});
	assert.equal(globalLayer.config.maxRetries, 5);
	// The removed key never lands in the parsed partial config.
	assert.equal(Object.hasOwn(globalLayer.config, "decisionPrompt"), false);
	const removed = globalLayer.diagnostics.find(
		(diagnosticItem) => diagnosticItem.severity === "error",
	);
	assert.ok(removed, "expected an error diagnostic");
	assert.match(removed.message, /decisionPrompt was removed/);
	assert.match(removed.message, /has no effect/);

	const projectLayer = validateConfig("project", {
		continueReasonTypes: ["WORK_REMAINS"],
		continuePrompt: "Project continue.",
	});
	assert.equal(projectLayer.config.continuePrompt, "Project continue.");
	const projectRemoved = projectLayer.diagnostics.find(
		(diagnosticItem) => diagnosticItem.severity === "error",
	);
	assert.ok(projectRemoved, "expected an error diagnostic");
	assert.match(projectRemoved.message, /continueReasonTypes was removed/);
	// No generic unsupported-keys diagnostic for the removed keys themselves.
	assert.equal(
		projectLayer.diagnostics.some(
			(diagnosticItem) =>
				diagnosticItem.message === "ignoring unsupported keys",
		),
		false,
	);
});

test("removed keys surface through mergeConfig diagnostics", () => {
	const merged = mergeConfig({ decisionPrompt: "x" }, {});
	assert.equal(merged.config.maxRetries, 10);
	assert.ok(
		merged.diagnostics.some(
			(diagnosticItem) =>
				diagnosticItem.severity === "error" &&
				diagnosticItem.message.includes("decisionPrompt"),
		),
	);
});

test("global and trusted project overrides apply field-by-field", () => {
	const globalOnly = mergeConfig({
		idleDelaySeconds: 7,
		continuePrompt: "Custom continue prompt.",
	});
	assert.equal(globalOnly.config.idleDelaySeconds, 7);
	assert.equal(globalOnly.config.maxRetries, 10);
	assert.equal(globalOnly.config.continuePrompt, "Custom continue prompt.");
	assert.deepEqual(globalOnly.config.reasonTypes, DEFAULT_REASON_TYPES);
	assert.deepEqual(globalOnly.diagnostics, []);

	const withProject = mergeConfig(
		{
			idleDelaySeconds: 7,
			maxRetries: 4,
			continuePrompt: "Global continue",
			reasonTypes: ["GlobalType"],
		},
		{
			idleDelaySeconds: 9,
			continuePrompt: "Project continue",
			reasonTypes: [" ProjectType ", "shipped"],
		},
	);
	assert.equal(withProject.config.idleDelaySeconds, 9);
	assert.equal(withProject.config.maxRetries, 4);
	assert.equal(withProject.config.continuePrompt, "Project continue");
	assert.deepEqual(withProject.config.reasonTypes, ["ProjectType", "shipped"]);
	assert.deepEqual(withProject.diagnostics, []);
});

test("valid reasonTypes replace defaults and invalid lists fall back", () => {
	const replaced = mergeConfig({ reasonTypes: ["Custom", "typed"] }, {});
	assert.deepEqual(replaced.config.reasonTypes, ["Custom", "typed"]);

	const invalid = mergeConfig({ reasonTypes: ["Custom"] }, { reasonTypes: [] });
	assert.deepEqual(invalid.config.reasonTypes, ["Custom"]);
	assert.ok(
		invalid.diagnostics.some(
			(diagnosticItem) =>
				diagnosticItem.message ===
				"reasonTypes must be a non-empty array of non-blank strings",
		),
	);
});

test("invalid higher-precedence fields preserve lower valid values", () => {
	const merged = mergeConfig(
		{
			maxRetries: 4,
			continuePrompt: "Global continue",
			reasonTypes: ["GlobalType"],
		},
		{
			maxRetries: 99,
			continuePrompt: "   ",
			reasonTypes: ["", "bad"],
		},
	);
	assert.equal(merged.config.maxRetries, 4);
	assert.equal(merged.config.continuePrompt, "Global continue");
	assert.deepEqual(merged.config.reasonTypes, ["GlobalType"]);
});

test("validateConfig rejects non-objects, arrays, and invalid field types", () => {
	assert.deepEqual(validateConfig("global", null).diagnostics, [
		{
			source: "global",
			message: "configuration must be an object",
			severity: "warning",
		},
	]);
	assert.deepEqual(validateConfig("global", []).config, {});
	const invalid = validateConfig("global", {
		idleDelaySeconds: "ten",
		maxRetries: 1.5,
		reasonTypes: "none",
	});
	assert.equal(invalid.config.idleDelaySeconds, undefined);
	assert.equal(invalid.config.maxRetries, undefined);
	assert.equal(invalid.config.reasonTypes, undefined);
	assert.equal(invalid.diagnostics.length, 3);
	for (const diagnosticItem of invalid.diagnostics) {
		assert.equal(diagnosticItem.severity, "warning");
	}
});

test("idle delay accepts every finite nonnegative number while retries keep integer bounds", () => {
	assert.equal(MIN_IDLE_DELAY_SECONDS, 0);
	assert.equal(
		validateConfig("global", { idleDelaySeconds: 0 }).config.idleDelaySeconds,
		0,
	);
	assert.equal(
		validateConfig("global", { idleDelaySeconds: 7.5 }).config.idleDelaySeconds,
		7.5,
	);
	assert.equal(
		validateConfig("global", { idleDelaySeconds: -1 }).config.idleDelaySeconds,
		undefined,
	);
	assert.equal(MIN_RETRIES, 1);
	assert.equal(MAX_RETRIES, 10);
	assert.equal(
		validateConfig("global", { maxRetries: 1 }).config.maxRetries,
		1,
	);
	assert.equal(
		validateConfig("global", { maxRetries: 10 }).config.maxRetries,
		10,
	);
	assert.equal(
		validateConfig("global", { maxRetries: 11 }).config.maxRetries,
		undefined,
	);
	assert.equal(
		validateConfig("global", { maxRetries: Number.NaN }).config.maxRetries,
		undefined,
	);
});

test("continuePrompt accepts the Unicode code-point boundary and rejects one over", () => {
	const atLimit = "a".repeat(MAX_PROMPT_CHARACTERS);
	assert.equal(
		validateConfig("global", { continuePrompt: atLimit }).config.continuePrompt,
		atLimit,
	);
	assert.equal(
		validateConfig("global", { continuePrompt: `${atLimit}a` }).config
			.continuePrompt,
		undefined,
	);
});

test("unsupported keys emit one content-free diagnostic while known fields remain", () => {
	const result = validateConfig("global", {
		maxRetries: 3,
		somethingElse: true,
	});
	assert.equal(result.config.maxRetries, 3);
	assert.ok(
		result.diagnostics.some(
			(diagnosticItem) =>
				diagnosticItem.message === "ignoring unsupported keys",
		),
	);
});

test("loadConfigText reports malformed JSON without crashing", () => {
	const result = loadConfigText("global", "{ not json");
	assert.deepEqual(result.config, {});
	assert.ok(
		result.diagnostics.some(
			(diagnosticItem) =>
				diagnosticItem.message === "configuration contains malformed JSON",
		),
	);
});

test("loadRuntimeConfig merges agentDir global with trusted project file", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({ maxRetries: 5, continuePrompt: "Global continue" }),
	);
	await writeFile(
		join(cwd, ".pi", "pi-continue-watchdog.json"),
		JSON.stringify({ maxRetries: 7 }),
	);
	const loaded = await loadRuntimeConfig({ cwd, trusted: true, agentDir });
	assert.equal(loaded.config.maxRetries, 7);
	assert.equal(loaded.config.continuePrompt, "Global continue");
	assert.deepEqual(loaded.diagnostics, []);
});

test("untrusted project file is ignored while global still applies", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({ maxRetries: 5 }),
	);
	await writeFile(
		join(cwd, ".pi", "pi-continue-watchdog.json"),
		JSON.stringify({ maxRetries: 9 }),
	);
	const loaded = await loadRuntimeConfig({ cwd, trusted: false, agentDir });
	assert.equal(loaded.config.maxRetries, 5);
	assert.deepEqual(loaded.diagnostics, []);
});

test("missing config files are silent and keep built-in defaults", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	const loaded = await loadRuntimeConfig({ cwd, trusted: true, agentDir });
	assert.deepEqual(loaded.config, { ...BUILT_IN_CONFIG });
	assert.deepEqual(loaded.diagnostics, []);
});

test("read errors yield one content-free diagnostic and keep defaults", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	const loaded = await loadRuntimeConfig({
		cwd,
		trusted: false,
		agentDir,
		io: {
			readFile: async () => {
				throw new Error("EACCES: permission denied");
			},
		},
	});
	assert.equal(loaded.config.maxRetries, 10);
	assert.deepEqual(
		loaded.diagnostics.map((diagnosticItem) => diagnosticItem.message),
		["could not read configuration"],
	);
	assert.equal(loaded.diagnostics[0].severity, "error");
});

test("malformed project JSON keeps global valid values", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({ maxRetries: 5 }),
	);
	await writeFile(
		join(cwd, ".pi", "pi-continue-watchdog.json"),
		"not json at all",
	);
	const loaded = await loadRuntimeConfig({ cwd, trusted: true, agentDir });
	assert.equal(loaded.config.maxRetries, 5);
	assert.ok(
		loaded.diagnostics.some(
			(diagnosticItem) =>
				diagnosticItem.message === "configuration contains malformed JSON",
		),
	);
});

test("removed keys in a real config file surface as error diagnostics", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({ decisionPrompt: "Legacy prompt.", maxRetries: 5 }),
	);
	const loaded = await loadRuntimeConfig({ cwd, trusted: true, agentDir });
	assert.equal(loaded.config.maxRetries, 5);
	const error = loaded.diagnostics.find(
		(diagnosticItem) => diagnosticItem.severity === "error",
	);
	assert.ok(error, "expected an error diagnostic");
	assert.match(error.message, /decisionPrompt was removed/);
});

test("ENOENT is silent while non-ENOENT throw values stay content-free", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	const enoent = await loadRuntimeConfig({
		cwd,
		trusted: false,
		agentDir,
		io: {
			readFile: async () => {
				const error = new Error(
					"ENOENT: no such file",
				) as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			},
		},
	});
	assert.deepEqual(enoent.diagnostics, []);
});

test("unlockShortcut defaults to alt+u, accepts a key id string, and can be disabled", () => {
	assert.equal(BUILT_IN_CONFIG.unlockShortcut, "alt+u");
	assert.equal(
		validateConfig("global", { unlockShortcut: "ctrl+alt+u" }).config
			.unlockShortcut,
		"ctrl+alt+u",
	);
	assert.equal(
		validateConfig("global", { unlockShortcut: false }).config.unlockShortcut,
		false,
	);
});

test("invalid unlockShortcut values fall back to the default with one bounded diagnostic", () => {
	const merged = mergeConfig({ unlockShortcut: 42 }, {});
	assert.equal(merged.config.unlockShortcut, "alt+u");
	assert.ok(
		merged.diagnostics.some(
			(diagnosticItem) =>
				diagnosticItem.message ===
				"unlockShortcut must be a non-empty key id string or false",
		),
	);
});

test("jevWaitCheck defaults apply when unset", () => {
	const merged = mergeConfig({}, {});
	assert.equal(merged.config.jevWaitCheck?.unlockReviewThreshold, 0.8);
	assert.deepEqual(merged.config.jevWaitCheck, {
		enabled: true,
		model: "jev-latest",
		confidenceThreshold: 0.8,
		unlockReviewThreshold: 0.8,
		timeoutMs: 15_000,
	});
	assert.deepEqual(merged.diagnostics, []);
});

test("jevWaitCheck merges per field across layers", () => {
	const merged = mergeConfig(
		{ jevWaitCheck: { enabled: false, apiKey: "global-key", timeoutMs: 5000 } },
		{ jevWaitCheck: { model: "jev-custom" } },
	);
	assert.deepEqual(merged.config.jevWaitCheck, {
		enabled: false,
		model: "jev-custom",
		confidenceThreshold: 0.8,
		unlockReviewThreshold: 0.8,
		timeoutMs: 5000,
		apiKey: "global-key",
	});
});

test("invalid jevWaitCheck threshold keeps the lower-precedence value", () => {
	const merged = mergeConfig(
		{ jevWaitCheck: { confidenceThreshold: 0.9 } },
		{ jevWaitCheck: { confidenceThreshold: 1.5, timeoutMs: 10 } },
	);
	assert.equal(merged.config.jevWaitCheck?.confidenceThreshold, 0.9);
	assert.equal(merged.config.jevWaitCheck?.timeoutMs, 15_000);
	const messages = merged.diagnostics.map((item) => item.message);
	assert.ok(
		messages.some((message) => message.includes("confidenceThreshold")),
	);
	assert.ok(messages.some((message) => message.includes("timeoutMs")));
});

test("invalid unlock review threshold keeps the lower layer", () => {
	for (const invalid of [-0.1, 1.1, Number.NaN, "0.8", null]) {
		const merged = mergeConfig(
			{ jevWaitCheck: { unlockReviewThreshold: 0.9 } },
			{ jevWaitCheck: { unlockReviewThreshold: invalid } },
		);
		assert.equal(merged.config.jevWaitCheck?.unlockReviewThreshold, 0.9);
		assert.ok(
			merged.diagnostics.some((item) =>
				item.message.includes("jevWaitCheck.unlockReviewThreshold"),
			),
		);
	}
});

test("project jevWaitCheck.apiKey is ignored with a diagnostic naming it", () => {
	const merged = mergeConfig(
		{ jevWaitCheck: { apiKey: "global-key" } },
		{ jevWaitCheck: { apiKey: "project-key" } },
	);
	assert.equal(merged.config.jevWaitCheck?.apiKey, "global-key");
	assert.ok(
		merged.diagnostics.some(
			(item) =>
				item.source === "project" &&
				item.message.includes("jevWaitCheck.apiKey"),
		),
	);
});

test("malformed jevWaitCheck.apiUrl keeps the lower-precedence endpoint", () => {
	const merged = mergeConfig(
		{ jevWaitCheck: { apiUrl: "https://api.typesafe.ai/v1/systemone" } },
		{ jevWaitCheck: { apiUrl: "not-a-url" } },
	);
	assert.equal(
		merged.config.jevWaitCheck?.apiUrl,
		"https://api.typesafe.ai/v1/systemone",
	);
	assert.ok(
		merged.diagnostics.some(
			(item) =>
				item.source === "project" &&
				item.message.includes("jevWaitCheck.apiUrl"),
		),
	);
});
