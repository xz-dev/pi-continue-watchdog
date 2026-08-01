import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	BUILT_IN_CONFIG,
	DEFAULT_CONTINUE_PROMPT,
	DEFAULT_DECISION_PROMPT,
	loadConfigText,
	mergeConfig,
	validateConfig,
} from "../src/config.js";
import { loadRuntimeConfig } from "../src/config-loader.js";

/** Rejected direct-continuation reminder (must never be shipped as default). */
const REJECTED_DIRECT_REMINDER =
	"Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.";

async function fixture(): Promise<{ agentDir: string; cwd: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-continue-watchdog-config-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	return { agentDir, cwd };
}

test("Example 12: built-in defaults match acceptance (idleDelaySeconds=3, maxRetries=10, exact prompts)", () => {
	assert.equal(BUILT_IN_CONFIG.idleDelaySeconds, 3);
	assert.equal(BUILT_IN_CONFIG.maxRetries, 10);
	assert.equal(
		BUILT_IN_CONFIG.decisionPrompt,
		"Decide whether work should continue. Call unlock_continue_watchdog with a concise reason if you are intentionally waiting for the user or all tasks are complete. Otherwise call continue_watchdog. Call exactly one tool and do not answer with prose.",
	);
	assert.equal(
		BUILT_IN_CONFIG.continuePrompt,
		"Continue until all jobs are done.",
	);
	assert.equal(DEFAULT_DECISION_PROMPT, BUILT_IN_CONFIG.decisionPrompt);
	assert.equal(DEFAULT_CONTINUE_PROMPT, BUILT_IN_CONFIG.continuePrompt);
});

test("stale-string guard: defaults must not ship the rejected direct-continuation reminder", () => {
	assert.notEqual(BUILT_IN_CONFIG.decisionPrompt, REJECTED_DIRECT_REMINDER);
	assert.notEqual(BUILT_IN_CONFIG.continuePrompt, REJECTED_DIRECT_REMINDER);
	assert.ok(!BUILT_IN_CONFIG.decisionPrompt.includes(REJECTED_DIRECT_REMINDER));
	assert.ok(!BUILT_IN_CONFIG.continuePrompt.includes(REJECTED_DIRECT_REMINDER));
	assert.ok(
		!Object.values(BUILT_IN_CONFIG).some(
			(v) => typeof v === "string" && v.includes(REJECTED_DIRECT_REMINDER),
		),
	);
});

test("Example 12: global overrides apply field-by-field over defaults", () => {
	const { config, diagnostics } = mergeConfig({
		idleDelaySeconds: 7,
		decisionPrompt: "Custom decision prompt for global.",
	});
	assert.equal(config.idleDelaySeconds, 7);
	assert.equal(config.maxRetries, 10);
	assert.equal(config.decisionPrompt, "Custom decision prompt for global.");
	assert.equal(config.continuePrompt, DEFAULT_CONTINUE_PROMPT);
	assert.deepEqual(diagnostics, []);
});

test("Example 12: trusted project overrides global field-by-field", () => {
	const { config, diagnostics } = mergeConfig(
		{
			idleDelaySeconds: 7,
			maxRetries: 4,
			decisionPrompt: "Global decision",
			continuePrompt: "Global continue",
		},
		{
			idleDelaySeconds: 9,
			continuePrompt: "Project continue",
		},
	);
	assert.equal(config.idleDelaySeconds, 9);
	assert.equal(config.maxRetries, 4);
	assert.equal(config.decisionPrompt, "Global decision");
	assert.equal(config.continuePrompt, "Project continue");
	assert.deepEqual(diagnostics, []);
});

test("Example 12: invalid higher-precedence value preserves lower valid value", () => {
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
		// Bounded: no raw config content dumps of long secrets
		assert.ok(!d.message.includes("Global decision prompt"));
	}
});

test("validateConfig rejects non-object and invalid field types with bounded diagnostics", () => {
	const nonObject = validateConfig("global", ["nope"]);
	assert.deepEqual(nonObject.config, {});
	assert.equal(nonObject.diagnostics.length, 1);
	assert.equal(nonObject.diagnostics[0]?.source, "global");
	assert.match(nonObject.diagnostics[0]?.message ?? "", /object/i);

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

test("loadConfigText reports malformed JSON without crashing", () => {
	const result = loadConfigText("global", "{ not json");
	assert.deepEqual(result.config, {});
	assert.equal(result.diagnostics.length, 1);
	assert.equal(result.diagnostics[0]?.source, "global");
	assert.match(result.diagnostics[0]?.message ?? "", /malformed|JSON/i);
	assert.ok((result.diagnostics[0]?.message.length ?? 0) <= 240);
});

test("Example 12: loadRuntimeConfig uses agentDir injection and trusted project file", async () => {
	const { agentDir, cwd } = await fixture();
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

	const loaded = await loadRuntimeConfig({
		cwd,
		trusted: true,
		agentDir,
	});

	assert.equal(loaded.config.idleDelaySeconds, 5);
	assert.equal(loaded.config.maxRetries, 6);
	assert.equal(loaded.config.decisionPrompt, "From global file");
	assert.equal(loaded.config.continuePrompt, "From project file");
	assert.deepEqual(loaded.diagnostics, []);
});

test("Example 12: untrusted project file is ignored", async () => {
	const { agentDir, cwd } = await fixture();
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

	const loaded = await loadRuntimeConfig({
		cwd,
		trusted: false,
		agentDir,
	});

	assert.equal(loaded.config.idleDelaySeconds, 4);
	assert.equal(loaded.config.maxRetries, 10);
	assert.equal(loaded.config.decisionPrompt, "Global only");
	assert.equal(loaded.config.continuePrompt, DEFAULT_CONTINUE_PROMPT);
	assert.deepEqual(loaded.diagnostics, []);
});

test("Example 12: missing config files are silent", async () => {
	const { agentDir, cwd } = await fixture();
	const loaded = await loadRuntimeConfig({
		cwd,
		trusted: true,
		agentDir,
	});
	assert.deepEqual(loaded.config, { ...BUILT_IN_CONFIG });
	assert.deepEqual(loaded.diagnostics, []);
});

test("Example 12: unreadable config yields bounded diagnostic and keeps defaults", async () => {
	const { agentDir, cwd } = await fixture();
	const io = {
		async readFile(path: string): Promise<string> {
			if (
				path.endsWith("pi-continue-watchdog.json") &&
				path.includes("agent")
			) {
				const err = new Error(
					"EACCES permission denied",
				) as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		},
	};

	const loaded = await loadRuntimeConfig({
		cwd,
		trusted: false,
		agentDir,
		io,
	});

	assert.deepEqual(loaded.config, { ...BUILT_IN_CONFIG });
	assert.equal(loaded.diagnostics.length, 1);
	assert.equal(loaded.diagnostics[0]?.source, "global");
	assert.match(
		loaded.diagnostics[0]?.message ?? "",
		/could not read|permission|EACCES/i,
	);
	assert.ok((loaded.diagnostics[0]?.message.length ?? 0) <= 240);
	// Do not dump full paths that may include secrets beyond a short bounded message
	assert.ok(!loaded.diagnostics[0]?.message.includes("\n"));
});

test("Example 12: malformed project JSON keeps global valid values", async () => {
	const { agentDir, cwd } = await fixture();
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({ idleDelaySeconds: 11, maxRetries: 3 }),
	);
	await writeFile(join(cwd, ".pi", "pi-continue-watchdog.json"), "{ broken");

	const loaded = await loadRuntimeConfig({
		cwd,
		trusted: true,
		agentDir,
	});

	assert.equal(loaded.config.idleDelaySeconds, 11);
	assert.equal(loaded.config.maxRetries, 3);
	assert.equal(loaded.config.decisionPrompt, DEFAULT_DECISION_PROMPT);
	assert.equal(loaded.config.continuePrompt, DEFAULT_CONTINUE_PROMPT);
	assert.equal(loaded.diagnostics.length, 1);
	assert.equal(loaded.diagnostics[0]?.source, "project");
});

test("loadRuntimeConfig accepts positive finite idleDelaySeconds floats", async () => {
	const { agentDir, cwd } = await fixture();
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({ idleDelaySeconds: 0.5 }),
	);
	const loaded = await loadRuntimeConfig({ cwd, trusted: false, agentDir });
	assert.equal(loaded.config.idleDelaySeconds, 0.5);
	assert.deepEqual(loaded.diagnostics, []);
});
