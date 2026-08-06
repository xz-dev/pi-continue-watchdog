import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	BUILT_IN_CONFIG,
	DEFAULT_CONTINUE_PROMPT,
	DEFAULT_DECISION_PROMPT,
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

/** Rejected direct-continuation reminder (must never be shipped as default). */
const REJECTED_DIRECT_REMINDER =
	"Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.";

/** Rejected untyped decision default that omits allowed reasonType. */
const REJECTED_UNTYPED_DECISION_PROMPT =
	"This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. Decide whether work should continue. Call unlock_continue_watchdog with a concise reason if you are intentionally waiting for the user or all tasks are complete. Otherwise call continue_watchdog. Call exactly one tool and do not answer with prose.";

const ACCEPTED_DECISION_PROMPT =
	"This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. It does not represent any decision by the user. Decide whether work should continue. Before deciding, check whether every task the user requested in this session is complete, including earlier requests and not only the latest one.";

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

test("built-in defaults match acceptance and reject the stale direct reminder", () => {
	assert.equal(BUILT_IN_CONFIG.idleDelaySeconds, 10);
	assert.equal(BUILT_IN_CONFIG.maxRetries, 10);
	assert.equal(BUILT_IN_CONFIG.decisionPrompt, ACCEPTED_DECISION_PROMPT);
	assert.equal(
		BUILT_IN_CONFIG.continuePrompt,
		"Continue until user assistance is required.",
	);
	assert.deepEqual(BUILT_IN_CONFIG.reasonTypes, [
		"JOB_DONE",
		"WAIT_USER",
		"JOB_BLOCKED",
	]);
	assert.deepEqual(DEFAULT_REASON_TYPES, BUILT_IN_CONFIG.reasonTypes);
	assert.equal(DEFAULT_DECISION_PROMPT, BUILT_IN_CONFIG.decisionPrompt);
	assert.equal(DEFAULT_CONTINUE_PROMPT, BUILT_IN_CONFIG.continuePrompt);
	assert.notEqual(BUILT_IN_CONFIG.decisionPrompt, REJECTED_DIRECT_REMINDER);
	assert.notEqual(
		BUILT_IN_CONFIG.decisionPrompt,
		REJECTED_UNTYPED_DECISION_PROMPT,
	);
	assert.notEqual(BUILT_IN_CONFIG.continuePrompt, REJECTED_DIRECT_REMINDER);
	assert.ok(!BUILT_IN_CONFIG.decisionPrompt.includes(REJECTED_DIRECT_REMINDER));
	assert.ok(!BUILT_IN_CONFIG.continuePrompt.includes(REJECTED_DIRECT_REMINDER));
	assert.ok(!BUILT_IN_CONFIG.decisionPrompt.includes("call tools"));
});

test("global and trusted project overrides apply field-by-field", () => {
	const globalOnly = mergeConfig({
		idleDelaySeconds: 7,
		decisionPrompt: "Custom decision prompt for global.",
	});
	assert.equal(globalOnly.config.idleDelaySeconds, 7);
	assert.equal(globalOnly.config.maxRetries, 10);
	assert.equal(
		globalOnly.config.decisionPrompt,
		"Custom decision prompt for global.",
	);
	assert.equal(globalOnly.config.continuePrompt, DEFAULT_CONTINUE_PROMPT);
	assert.deepEqual(globalOnly.config.reasonTypes, DEFAULT_REASON_TYPES);
	assert.deepEqual(globalOnly.diagnostics, []);

	const withProject = mergeConfig(
		{
			idleDelaySeconds: 7,
			maxRetries: 4,
			decisionPrompt: "Global decision",
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
	assert.equal(withProject.config.decisionPrompt, "Global decision");
	assert.equal(withProject.config.continuePrompt, "Project continue");
	assert.deepEqual(withProject.config.reasonTypes, ["ProjectType", "shipped"]);
	assert.deepEqual(withProject.diagnostics, []);
});

test("valid reasonTypes replace defaults and invalid lists fall back", () => {
	const replaced = mergeConfig({
		reasonTypes: [" NeedReview ", "shipped"],
	});
	assert.deepEqual(replaced.config.reasonTypes, ["NeedReview", "shipped"]);
	assert.deepEqual(replaced.diagnostics, []);
	assert.ok(!replaced.config.reasonTypes.includes("JOB_DONE"));

	const invalidProject = mergeConfig(
		{ reasonTypes: ["GlobalOnly"] },
		{ reasonTypes: ["ok", "  "] },
	);
	assert.deepEqual(invalidProject.config.reasonTypes, ["GlobalOnly"]);
	assert.ok(
		invalidProject.diagnostics.some((d) => /reasonTypes/i.test(d.message)),
	);

	for (const reasonTypes of [[], "JOB_DONE", [""], ["ok", 1], [null], {}]) {
		const result = validateConfig("project", { reasonTypes });
		assert.equal(result.config.reasonTypes, undefined);
		assert.equal(result.diagnostics.length, 1);
		assert.match(result.diagnostics[0]?.message ?? "", /reasonTypes/i);
	}

	const preserved = mergeConfig(
		{ reasonTypes: ["KeepMe"] },
		{ reasonTypes: [] },
	);
	assert.deepEqual(preserved.config.reasonTypes, ["KeepMe"]);
});

test("invalid higher-precedence fields preserve lower valid values", () => {
	const { config, diagnostics } = mergeConfig(
		{
			idleDelaySeconds: 8,
			maxRetries: 5,
			decisionPrompt: "Global decision prompt",
		},
		{
			idleDelaySeconds: -1,
			maxRetries: 0,
			decisionPrompt: "",
			continuePrompt: 123,
		},
	);
	assert.equal(config.idleDelaySeconds, 8);
	assert.equal(config.maxRetries, 5);
	assert.equal(config.decisionPrompt, "Global decision prompt");
	assert.equal(config.continuePrompt, DEFAULT_CONTINUE_PROMPT);
	assert.ok(diagnostics.length >= 3);
	for (const d of diagnostics) {
		assert.equal(typeof d.source, "string");
		assert.equal(typeof d.message, "string");
		assert.ok(d.message.length > 0);
		assert.ok(d.message.length <= 240);
		assert.ok(!d.message.includes("Global decision prompt"));
	}
});

test("validateConfig rejects non-objects, arrays, and invalid field types", () => {
	const nonObject = validateConfig("global", null);
	assert.deepEqual(nonObject.config, {});
	assert.equal(nonObject.diagnostics.length, 1);
	assert.match(nonObject.diagnostics[0]?.message ?? "", /object/i);

	const array = validateConfig("global", ["nope"]);
	assert.deepEqual(array.config, {});
	assert.equal(array.diagnostics.length, 1);
	assert.match(array.diagnostics[0]?.message ?? "", /object/i);

	const invalid = validateConfig("project", {
		idleDelaySeconds: Number.NaN,
		maxRetries: 1.5,
		decisionPrompt: "   ",
		continuePrompt: null,
		unknownKey: true,
	});
	assert.deepEqual(invalid.config, {});
	assert.ok(invalid.diagnostics.length >= 3);
	for (const d of invalid.diagnostics) {
		assert.ok(d.message.length <= 240);
	}
});

test("idle delay accepts every finite nonnegative number while retries keep integer bounds", () => {
	assert.equal(MIN_IDLE_DELAY_SECONDS, 0);
	assert.equal(MIN_RETRIES, 1);
	assert.equal(MAX_RETRIES, 10);

	for (const idleDelaySeconds of [0, 0.5, 3601, Number.MAX_VALUE]) {
		const result = validateConfig("global", {
			idleDelaySeconds,
			maxRetries: MAX_RETRIES,
		});
		assert.equal(result.config.idleDelaySeconds, idleDelaySeconds);
		assert.equal(result.config.maxRetries, MAX_RETRIES);
		assert.deepEqual(result.diagnostics, []);
	}

	for (const idleDelaySeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const result = validateConfig("global", { idleDelaySeconds });
		assert.equal(result.config.idleDelaySeconds, undefined);
		assert.equal(result.diagnostics.length, 1);
		assert.match(result.diagnostics[0]?.message ?? "", /idleDelaySeconds/i);
	}
	for (const retries of [0, 1.5, MAX_RETRIES + 1]) {
		const result = validateConfig("project", { maxRetries: retries });
		assert.equal(result.config.maxRetries, undefined);
		assert.equal(result.diagnostics.length, 1);
		assert.match(result.diagnostics[0]?.message ?? "", /maxRetries/i);
	}

	const preserved = mergeConfig(
		{ idleDelaySeconds: 12, maxRetries: 4 },
		{ idleDelaySeconds: -1, maxRetries: 11 },
	);
	assert.equal(preserved.config.idleDelaySeconds, 12);
	assert.equal(preserved.config.maxRetries, 4);
	assert.ok(preserved.diagnostics.length >= 2);
});

test("prompts accept the Unicode code-point boundary and reject one over", () => {
	const atLimit = "😀".repeat(MAX_PROMPT_CHARACTERS);
	const overLimit = `${atLimit}😀`;

	const valid = validateConfig("global", {
		decisionPrompt: atLimit,
		continuePrompt: atLimit,
	});
	assert.equal(valid.config.decisionPrompt, atLimit);
	assert.equal(valid.config.continuePrompt, atLimit);
	assert.deepEqual(valid.diagnostics, []);

	const invalid = validateConfig("project", {
		decisionPrompt: overLimit,
		continuePrompt: overLimit,
	});
	assert.equal(invalid.config.decisionPrompt, undefined);
	assert.equal(invalid.config.continuePrompt, undefined);
	assert.deepEqual(invalid.diagnostics, [
		{
			source: "project",
			message: `decisionPrompt must be a non-empty string of at most ${MAX_PROMPT_CHARACTERS} Unicode characters`,
		},
		{
			source: "project",
			message: `continuePrompt must be a non-empty string of at most ${MAX_PROMPT_CHARACTERS} Unicode characters`,
		},
	]);
});

test("unsupported keys emit one content-free diagnostic while known fields remain", () => {
	const secretKey = "api_key_SECRET_do_not_leak";
	// JSON own-string keys only, including `__proto__` as a normal unknown field.
	const input = JSON.parse(
		`{"idleDelaySeconds":8,"maxRetries":3,"decisionPrompt":"Keep me","${secretKey}":"value-must-not-appear","__proto__":"json-own-key"}`,
	) as Record<string, unknown>;

	const result = validateConfig("project", input);
	assert.equal(result.config.idleDelaySeconds, 8);
	assert.equal(result.config.maxRetries, 3);
	assert.equal(result.config.decisionPrompt, "Keep me");

	const unknownDiags = result.diagnostics.filter((d) =>
		/unsupported|unknown/i.test(d.message),
	);
	assert.equal(unknownDiags.length, 1);
	assert.equal(unknownDiags[0]?.message, "ignoring unsupported keys");
	assert.ok(!unknownDiags[0]?.message.includes(secretKey));
	assert.ok(!unknownDiags[0]?.message.includes("api_key"));
	assert.ok(!JSON.stringify(result.diagnostics).includes(secretKey));
	assert.ok(!JSON.stringify(result.diagnostics).includes("value-must-not"));
});

test("loadConfigText reports malformed JSON without crashing", () => {
	const result = loadConfigText("global", "{ not json");
	assert.deepEqual(result.config, {});
	assert.equal(result.diagnostics.length, 1);
	assert.equal(result.diagnostics[0]?.source, "global");
	assert.match(result.diagnostics[0]?.message ?? "", /malformed|JSON/i);
	assert.ok((result.diagnostics[0]?.message.length ?? 0) <= 240);
});

test("loadRuntimeConfig merges agentDir global with trusted project file", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({
			idleDelaySeconds: 5,
			maxRetries: 2,
			decisionPrompt: "From global file",
		}),
	);
	await writeFile(
		join(cwd, ".pi", "pi-continue-watchdog.json"),
		JSON.stringify({
			maxRetries: 6,
			continuePrompt: "From project file",
		}),
	);

	const loaded = await loadRuntimeConfig({ cwd, trusted: true, agentDir });
	assert.equal(loaded.config.idleDelaySeconds, 5);
	assert.equal(loaded.config.maxRetries, 6);
	assert.equal(loaded.config.decisionPrompt, "From global file");
	assert.equal(loaded.config.continuePrompt, "From project file");
	assert.deepEqual(loaded.diagnostics, []);
});

test("untrusted project file is ignored while global still applies", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({ idleDelaySeconds: 4, decisionPrompt: "Global only" }),
	);
	await writeFile(
		join(cwd, ".pi", "pi-continue-watchdog.json"),
		JSON.stringify({
			idleDelaySeconds: 99,
			decisionPrompt: "Untrusted must not apply",
			continuePrompt: "Untrusted continue",
			maxRetries: 1,
		}),
	);

	const loaded = await loadRuntimeConfig({ cwd, trusted: false, agentDir });
	assert.equal(loaded.config.idleDelaySeconds, 4);
	assert.equal(loaded.config.maxRetries, 10);
	assert.equal(loaded.config.decisionPrompt, "Global only");
	assert.equal(loaded.config.continuePrompt, DEFAULT_CONTINUE_PROMPT);
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
			async readFile(path: string): Promise<string> {
				if (path.includes("agent")) {
					const err = new Error(
						"EACCES permission denied /secret/path/token-abc",
					) as NodeJS.ErrnoException;
					err.code = "EACCES";
					throw err;
				}
				const err = new Error("ENOENT") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			},
		},
	});

	assert.deepEqual(loaded.config, { ...BUILT_IN_CONFIG });
	assert.equal(loaded.diagnostics.length, 1);
	assert.equal(loaded.diagnostics[0]?.source, "global");
	assert.equal(loaded.diagnostics[0]?.message, "could not read configuration");
	assert.ok(!loaded.diagnostics[0]?.message.includes("token-abc"));
	assert.ok(!loaded.diagnostics[0]?.message.includes("EACCES"));
	assert.ok(!loaded.diagnostics[0]?.message.includes("/secret/"));
});

test("malformed project JSON keeps global valid values", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({ idleDelaySeconds: 11, maxRetries: 3 }),
	);
	await writeFile(join(cwd, ".pi", "pi-continue-watchdog.json"), "{ broken");

	const loaded = await loadRuntimeConfig({ cwd, trusted: true, agentDir });
	assert.equal(loaded.config.idleDelaySeconds, 11);
	assert.equal(loaded.config.maxRetries, 3);
	assert.equal(loaded.config.decisionPrompt, DEFAULT_DECISION_PROMPT);
	assert.equal(loaded.config.continuePrompt, DEFAULT_CONTINUE_PROMPT);
	assert.equal(loaded.diagnostics.length, 1);
	assert.equal(loaded.diagnostics[0]?.source, "project");
	assert.match(loaded.diagnostics[0]?.message ?? "", /malformed|JSON/i);
});

test("fractional idleDelaySeconds loads without clamping", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({ idleDelaySeconds: 0.5 }),
	);
	const loaded = await loadRuntimeConfig({ cwd, trusted: false, agentDir });
	assert.equal(loaded.config.idleDelaySeconds, 0.5);
	assert.deepEqual(loaded.diagnostics, []);
});

test("ENOENT is silent while non-ENOENT throw values stay content-free", async (t) => {
	const { agentDir, cwd } = await fixture(t);

	const silent = await loadRuntimeConfig({
		cwd,
		trusted: false,
		agentDir,
		io: {
			async readFile(): Promise<string> {
				const err = new Error("missing") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			},
		},
	});
	assert.deepEqual(silent.config, { ...BUILT_IN_CONFIG });
	assert.deepEqual(silent.diagnostics, []);

	const secret = "SUPER_SECRET_TOKEN=abc\npath=/home/user/.secrets/key.pem";
	const failed = await loadRuntimeConfig({
		cwd,
		trusted: false,
		agentDir,
		io: {
			async readFile(): Promise<string> {
				throw Object.assign(new Error(secret), { code: "EPERM" });
			},
		},
	});
	assert.deepEqual(failed.config, { ...BUILT_IN_CONFIG });
	assert.equal(failed.diagnostics.length, 1);
	assert.equal(failed.diagnostics[0]?.message, "could not read configuration");
	assert.ok(!failed.diagnostics[0]?.message.includes("SUPER_SECRET"));
	assert.ok(!failed.diagnostics[0]?.message.includes("/home/user"));
	assert.ok(!failed.diagnostics[0]?.message.includes("EPERM"));
});
