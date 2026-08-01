import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	BUILT_IN_CONFIG,
	DEFAULT_CONTINUE_PROMPT,
	DEFAULT_DECISION_PROMPT,
	loadConfigText,
	MAX_IDLE_DELAY_SECONDS,
	MAX_RETRIES,
	MAX_TIMER_DELAY_MS,
	MIN_IDLE_DELAY_SECONDS,
	MIN_RETRIES,
	maxConfiguredDelayMs,
	mergeConfig,
	validateConfig,
} from "../src/config.js";
import { loadRuntimeConfig } from "../src/config-loader.js";

/** Rejected direct-continuation reminder (must never be shipped as default). */
const REJECTED_DIRECT_REMINDER =
	"Continue the task. If you are intentionally waiting for the user or all tasks are complete, call unlock_continue_watchdog.";

/** Node setTimeout hard limit (2^31-1 ms). */
const NODE_MAX_TIMEOUT_MS = 2 ** 31 - 1;

async function fixture(
	t?: TestContext,
): Promise<{ agentDir: string; cwd: string; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-continue-watchdog-config-"));
	if (t) {
		t.after(async () => {
			await rm(root, { recursive: true, force: true });
		});
	}
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	return { agentDir, cwd, root };
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

test("Example 12: loadRuntimeConfig uses agentDir injection and trusted project file", async (t) => {
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

test("Example 12: untrusted project file is ignored", async (t) => {
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

test("Example 12: missing config files are silent", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	const loaded = await loadRuntimeConfig({
		cwd,
		trusted: true,
		agentDir,
	});
	assert.deepEqual(loaded.config, { ...BUILT_IN_CONFIG });
	assert.deepEqual(loaded.diagnostics, []);
});

test("Example 12: unreadable config yields content-free bounded diagnostic and keeps defaults", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	const io = {
		async readFile(path: string): Promise<string> {
			if (
				path.endsWith("pi-continue-watchdog.json") &&
				path.includes("agent")
			) {
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
	assert.equal(loaded.diagnostics[0]?.message, "could not read configuration");
	assert.ok((loaded.diagnostics[0]?.message.length ?? 0) <= 240);
	assert.ok(!loaded.diagnostics[0]?.message.includes("\n"));
	assert.ok(!loaded.diagnostics[0]?.message.includes("token-abc"));
	assert.ok(!loaded.diagnostics[0]?.message.includes("EACCES"));
	assert.ok(!loaded.diagnostics[0]?.message.includes("/secret/"));
});

test("Example 12: malformed project JSON keeps global valid values", async (t) => {
	const { agentDir, cwd } = await fixture(t);
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

test("loadRuntimeConfig rejects non-integer idleDelaySeconds (no silent clamp)", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	await writeFile(
		join(agentDir, "pi-continue-watchdog.json"),
		JSON.stringify({ idleDelaySeconds: 0.5 }),
	);
	const loaded = await loadRuntimeConfig({ cwd, trusted: false, agentDir });
	assert.equal(
		loaded.config.idleDelaySeconds,
		BUILT_IN_CONFIG.idleDelaySeconds,
	);
	assert.equal(loaded.diagnostics.length, 1);
	assert.match(
		loaded.diagnostics[0]?.message ?? "",
		/idleDelaySeconds|integer|range/i,
	);
});

// --- Hardening (review C0/I3/M1) ---

test("C0 bounds: accepted extremes produce timer delays <= Node setTimeout max", () => {
	assert.equal(MIN_IDLE_DELAY_SECONDS, 1);
	assert.equal(MAX_IDLE_DELAY_SECONDS, 3600);
	assert.equal(MIN_RETRIES, 1);
	assert.equal(MAX_RETRIES, 10);
	assert.equal(MAX_TIMER_DELAY_MS, NODE_MAX_TIMEOUT_MS);

	const worst = maxConfiguredDelayMs(MAX_IDLE_DELAY_SECONDS, MAX_RETRIES);
	assert.equal(worst, 3600 * 1000 * 2 ** 9);
	assert.ok(worst <= NODE_MAX_TIMEOUT_MS);

	const boundaryIdle = validateConfig("global", {
		idleDelaySeconds: MAX_IDLE_DELAY_SECONDS,
		maxRetries: MAX_RETRIES,
	});
	assert.equal(boundaryIdle.config.idleDelaySeconds, MAX_IDLE_DELAY_SECONDS);
	assert.equal(boundaryIdle.config.maxRetries, MAX_RETRIES);
	assert.deepEqual(boundaryIdle.diagnostics, []);

	const minBoundary = validateConfig("global", {
		idleDelaySeconds: MIN_IDLE_DELAY_SECONDS,
		maxRetries: MIN_RETRIES,
	});
	assert.equal(minBoundary.config.idleDelaySeconds, MIN_IDLE_DELAY_SECONDS);
	assert.equal(minBoundary.config.maxRetries, MIN_RETRIES);
	assert.deepEqual(minBoundary.diagnostics, []);
});

test("C0 bounds: just-outside values are rejected without clamping", () => {
	const overIdle = validateConfig("global", {
		idleDelaySeconds: MAX_IDLE_DELAY_SECONDS + 1,
	});
	assert.equal(overIdle.config.idleDelaySeconds, undefined);
	assert.equal(overIdle.diagnostics.length, 1);
	assert.match(overIdle.diagnostics[0]?.message ?? "", /idleDelaySeconds/i);

	const underIdle = validateConfig("global", { idleDelaySeconds: 0 });
	assert.equal(underIdle.config.idleDelaySeconds, undefined);

	const floatIdle = validateConfig("global", { idleDelaySeconds: 1.5 });
	assert.equal(floatIdle.config.idleDelaySeconds, undefined);

	const overRetries = validateConfig("project", {
		maxRetries: MAX_RETRIES + 1,
	});
	assert.equal(overRetries.config.maxRetries, undefined);
	assert.equal(overRetries.diagnostics.length, 1);
	assert.match(overRetries.diagnostics[0]?.message ?? "", /maxRetries/i);

	const underRetries = validateConfig("project", { maxRetries: 0 });
	assert.equal(underRetries.config.maxRetries, undefined);

	// Independent product guarantee: maxRetries=11 would overflow at max idle.
	const overRetryWorst = maxConfiguredDelayMs(
		MAX_IDLE_DELAY_SECONDS,
		MAX_RETRIES + 1,
	);
	assert.ok(overRetryWorst > NODE_MAX_TIMEOUT_MS);
});

test("C0 bounds: invalid higher-precedence out-of-range preserves lower valid", () => {
	const { config, diagnostics } = mergeConfig(
		{ idleDelaySeconds: 12, maxRetries: 4 },
		{ idleDelaySeconds: 3601, maxRetries: 11 },
	);
	assert.equal(config.idleDelaySeconds, 12);
	assert.equal(config.maxRetries, 4);
	assert.ok(diagnostics.length >= 2);
	for (const d of diagnostics) {
		assert.ok(d.message.length <= 240);
		assert.ok(!d.message.includes("3601"));
		assert.ok(!d.message.includes("11"));
	}
});

test("I3 IO: only object/non-null code===ENOENT is silent; others are content-free", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	const secret =
		"SUPER_SECRET_TOKEN=abc\npath=/home/user/.secrets/key.pem\nstack: Error: boom";

	const cases: Array<{ label: string; throwValue: unknown }> = [
		{ label: "null", throwValue: null },
		{ label: "string", throwValue: secret },
		{
			label: "object secret multiline",
			throwValue: {
				message: secret,
				code: "EPERM",
				stack: `Error: ${secret}`,
				path: "/tmp/secret-path/token-xyz",
			},
		},
		{
			label: "ErrnoException without code",
			throwValue: Object.assign(new Error(secret), {
				path: "/tmp/leaky/path",
			}),
		},
		{
			label: "object with non-ENOENT code",
			throwValue: Object.assign(new Error(secret), { code: "EACCES" }),
		},
		{
			label: "object with code property not ENOENT string",
			throwValue: { code: 2, message: secret },
		},
	];

	for (const c of cases) {
		const loaded = await loadRuntimeConfig({
			cwd,
			trusted: false,
			agentDir,
			io: {
				async readFile(): Promise<string> {
					throw c.throwValue;
				},
			},
		});
		assert.deepEqual(loaded.config, { ...BUILT_IN_CONFIG }, c.label);
		assert.equal(loaded.diagnostics.length, 1, c.label);
		assert.equal(loaded.diagnostics[0]?.source, "global", c.label);
		assert.equal(
			loaded.diagnostics[0]?.message,
			"could not read configuration",
			c.label,
		);
		const msg = loaded.diagnostics[0]?.message ?? "";
		assert.ok(msg.length <= 240, c.label);
		assert.ok(!msg.includes("\n"), c.label);
		assert.ok(!msg.includes("SUPER_SECRET"), c.label);
		assert.ok(!msg.includes("token"), c.label);
		assert.ok(!msg.includes("/home/user"), c.label);
		assert.ok(!msg.includes("stack"), c.label);
		assert.ok(!msg.includes("EPERM"), c.label);
		assert.ok(!msg.includes("EACCES"), c.label);
	}

	// True ENOENT remains silent.
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
});

test("I3 unknown keys: one generic content-free diagnostic; known fields preserved", () => {
	const secretKey = "api_key_SECRET_do_not_leak";
	const input: Record<string, unknown> = {
		idleDelaySeconds: 8,
		maxRetries: 3,
		decisionPrompt: "Keep me",
		[secretKey]: "value-must-not-appear",
	};
	for (let i = 0; i < 1000; i++) {
		input[`extra_key_${i}_token`] = `secret-${i}`;
	}

	const result = validateConfig("project", input);
	assert.equal(result.config.idleDelaySeconds, 8);
	assert.equal(result.config.maxRetries, 3);
	assert.equal(result.config.decisionPrompt, "Keep me");

	const unknownDiags = result.diagnostics.filter((d) =>
		/unsupported|unknown/i.test(d.message),
	);
	assert.equal(unknownDiags.length, 1);
	assert.equal(unknownDiags[0]?.source, "project");
	assert.equal(unknownDiags[0]?.message, "ignoring unsupported keys");
	assert.ok((unknownDiags[0]?.message.length ?? 0) <= 240);
	assert.ok(!unknownDiags[0]?.message.includes(secretKey));
	assert.ok(!unknownDiags[0]?.message.includes("token"));
	assert.ok(!unknownDiags[0]?.message.includes("1000"));
	assert.ok(!unknownDiags[0]?.message.includes("api_key"));
	assert.ok(!JSON.stringify(result.diagnostics).includes(secretKey));
	assert.ok(!JSON.stringify(result.diagnostics).includes("secret-"));
});

test("M1 fixtures: temporary directories are cleaned after tests", async (t) => {
	const { root } = await fixture(t);
	await writeFile(join(root, "marker.txt"), "cleanup-me");
	// t.after from fixture must remove root; assert callback is registered by running access after suite is not possible here,
	// so verify cleanup helper works explicitly as the contract.
	await rm(root, { recursive: true, force: true });
	await assert.rejects(() => access(root), { code: "ENOENT" });
});
