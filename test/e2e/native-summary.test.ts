import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import { foldDecisionContext } from "../../src/context-fold.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST_PACKAGE = "@earendil-works/pi-coding-agent";

/** Host under test: devDependency pin; the packed fixture installs this host. */
const HOST_VERSION: string = (
	JSON.parse(
		await readFile(
			join(repoRoot, "node_modules", HOST_PACKAGE, "package.json"),
			"utf8",
		),
	) as { version: string }
).version;

const INQUIRY = "pi-continue-watchdog:inquiry";
const INQUIRY_FOLD = "pi-continue-watchdog:inquiry-fold";
const CONTINUATION = "pi-continue-watchdog:continuation";
const MARKER = "pi-continue-watchdog:inquiry-marker";

const CONTINUE_BODY =
	"Continue watchdog continued · WORK_REMAINS · 2024-01-01\n\nSuggested next step: keep building.";

interface RequestRecord {
	readonly receivedAt: number;
	readonly model?: string;
	readonly messages: Array<{
		readonly role?: string;
		readonly content?: unknown;
	}>;
}

type WireMessage = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Session-entry builders — append* calls produce real SessionEntry objects, so
// the preparation arrays contain exactly what the host serializes.
// ---------------------------------------------------------------------------

function userEntry(
	manager: SessionManager,
	text: string,
	timestamp: number,
): string {
	return manager.appendMessage({
		role: "user",
		content: text,
		timestamp,
	});
}

const ZERO_USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantEntry(
	manager: SessionManager,
	timestamp: number,
	toolCalls: Array<{
		readonly id: string;
		readonly name: string;
		readonly arguments: Record<string, unknown>;
	}> = [],
): string {
	return manager.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text: `ordinary reply ${timestamp}` },
			...toolCalls.map((call) => ({ type: "toolCall", ...call }) as never),
		],
		api: "openai-completions",
		provider: "watchdog-e2e",
		model: "watchdog-e2e",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp,
	});
}

function toolResultEntry(
	manager: SessionManager,
	toolCallId: string,
	toolName: string,
	output: string,
	timestamp: number,
): string {
	return manager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: output }],
		isError: false,
		timestamp,
	});
}

/** Inquiry marker: plain `custom` entry; excluded from context by host design. */
function markerEntry(
	manager: SessionManager,
	exchangeId: string,
	cycleId: number,
): string {
	return manager.appendCustomEntry(MARKER, {
		version: 1,
		exchangeId,
		cycleId,
	});
}

function inquiryPromptEntry(
	manager: SessionManager,
	exchangeId: string,
	cycleId: number,
): string {
	return manager.appendCustomMessageEntry(
		INQUIRY,
		`hidden decision prompt ${exchangeId}:${cycleId}`,
		false,
		{
			version: 1,
			namespace: "pi-continue-watchdog",
			inquiryId: exchangeId,
			attempt: cycleId,
		},
	);
}

function decisionAssistantEntry(
	manager: SessionManager,
	exchangeId: string,
	action: "continue" | "unlock",
): string {
	return manager.appendMessage({
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `cw-${exchangeId}`,
				name: "cw",
				arguments: {
					action,
					reason_type: action === "continue" ? "WORK_REMAINS" : "JOB_DONE",
					reason_content: "Recorded internal verdict.",
				},
			} as never,
		],
		api: "openai-completions",
		provider: "watchdog-e2e",
		model: "watchdog-e2e",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: 0,
	});
}

function decisionToolResultEntry(
	manager: SessionManager,
	exchangeId: string,
): string {
	return manager.appendMessage({
		role: "toolResult",
		toolCallId: `cw-${exchangeId}`,
		toolName: "cw",
		content: [{ type: "text", text: `verdict accepted for ${exchangeId}` }],
		isError: false,
		timestamp: 0,
	});
}

function foldEntry(
	manager: SessionManager,
	exchangeId: string,
	cycleId: number,
	outcome: "continue" | "unlock",
): string {
	const base = {
		version: 1,
		namespace: "pi-continue-watchdog",
		inquiryId: exchangeId,
		attempt: cycleId,
		watchdogOutcome: outcome,
	};
	if (outcome === "continue") {
		return manager.appendCustomMessageEntry(INQUIRY_FOLD, CONTINUE_BODY, true, {
			...base,
			outcome: "replace",
			replacement: {
				customType: CONTINUATION,
				content: CONTINUE_BODY,
				details: {
					version: 1,
					exchangeId,
					outcome: "continue",
				},
			},
		});
	}
	return manager.appendCustomMessageEntry(INQUIRY_FOLD, "", false, {
		...base,
		outcome: "remove",
	});
}

/**
 * Project a preparation message region through the production owned-exchange
 * fold. Preparation arrays already carry host `role:"custom"` messages, which
 * is exactly what foldInquiryContext recognizes — no role conversion needed.
 */
function projectMessages(messages: readonly WireMessage[]): WireMessage[] {
	return foldDecisionContext([...messages]);
}

// ---------------------------------------------------------------------------
// Packed fixture + mock provider
// ---------------------------------------------------------------------------

interface PackedFixture {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	readonly cwd: string;
	readonly packageDir: string;
	readonly probePath: string;
	readonly probeOut: string;
}

async function makePackedFixture(t: TestContext): Promise<PackedFixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-native-summary-e2e-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const packDir = join(root, "pack");
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const cwd = join(root, "project");
	const installRoot = join(agentDir, "npm");
	await Promise.all([
		mkdir(packDir, { recursive: true }),
		mkdir(cwd, { recursive: true }),
		mkdir(installRoot, { recursive: true }),
	]);

	const { stdout } = await execFileAsync(
		"npm",
		["pack", "--pack-destination", packDir],
		{ cwd: repoRoot, timeout: 120_000, maxBuffer: 1024 * 1024 },
	);
	const tarball = join(packDir, stdout.trim().split("\n").at(-1) ?? "");
	await execFileAsync("npm", ["init", "-y"], {
		cwd: installRoot,
		timeout: 30_000,
	});
	await execFileAsync(
		"npm",
		[
			"install",
			"--prefer-offline",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--allow-git=all",
			tarball,
		],
		{ cwd: installRoot, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
	);
	const manifest = JSON.parse(
		await readFile(join(repoRoot, "package.json"), "utf8"),
	) as { name: string };
	const packageDir = join(installRoot, "node_modules", manifest.name);

	// Probe extension: records the public preparation objects, applies the
	// production foldDecisionContext projection to the message/entry arrays in
	// place (the host retains the original reference), and can reintroduce
	// internal text when the negative-control env flag is set.
	const probeOut = join(root, "summary-probe-out.jsonl");
	const probePath = join(packageDir, "native-summary-probe.mjs");
	await writeFile(
		probePath,
		`import { appendFileSync } from "node:fs";

const OUT = process.env.NATIVE_SUMMARY_PROBE_OUT ?? "";
const NEGATIVE = process.env.NATIVE_SUMMARY_NEGATIVE === "1";
const INQUIRY = "pi-continue-watchdog:inquiry";

function dump(kind, data) {
  if (!OUT) return;
  appendFileSync(OUT, JSON.stringify({ kind, ...data }) + "\\n");
}

// Observational-only probe: the packed production watchdog registers its own
// session_before_compact / session_before_tree handlers first; this probe only
// records the preparation AFTER production projection has run, plus the
// explicit negative-control injection when enabled. No probe-side projection
// exists, so green runs exercise production cleanup alone.
export default function registerSummaryProbe(pi) {
  pi.on("session_before_compact", (event) => {
    const p = event.preparation;
    dump("before_compact", {
      reason: event.reason,
      willRetry: event.willRetry,
      firstKeptEntryId: p.firstKeptEntryId,
      isSplitTurn: p.isSplitTurn,
      messagesToSummarize: p.messagesToSummarize,
      turnPrefixMessages: p.turnPrefixMessages,
      fileOps: {
        read: [...p.fileOps.read],
        written: [...p.fileOps.written],
        edited: [...p.fileOps.edited],
      },
      branchEntries: event.branchEntries.length,
    });
    if (NEGATIVE) {
      p.messagesToSummarize.push({
        role: "custom",
        customType: INQUIRY,
        content: [
          { type: "text", text: "REINTRODUCED internal decision prompt" },
        ],
        display: false,
        details: {
          version: 1,
          namespace: "pi-continue-watchdog",
          inquiryId: "neg-seed",
          attempt: 1,
        },
        timestamp: Date.now(),
      });
      return;
    }
    dump("after_compact_projection", {
      isSplitTurn: p.isSplitTurn,
      historyAfter: p.messagesToSummarize.map((m) => ({
        role: m.role,
        customType: m.customType,
      })),
      prefixAfter: p.turnPrefixMessages.map((m) => ({
        role: m.role,
        customType: m.customType,
      })),
    });
  });
  pi.on("session_before_tree", (event) => {
    const p = event.preparation;
    dump("before_tree", {
      targetId: p.targetId,
      oldLeafId: p.oldLeafId,
      commonAncestorId: p.commonAncestorId,
      userWantsSummary: p.userWantsSummary,
      entriesToSummarize: p.entriesToSummarize.map((entry) => ({
        id: entry.id,
        type: entry.type,
        customType: entry.customType,
      })),
    });
    if (NEGATIVE) {
      p.entriesToSummarize.splice(0, 0, {
        type: "custom_message",
        customType: INQUIRY,
        content: [
          { type: "text", text: "REINTRODUCED internal decision prompt" },
        ],
        display: false,
        details: {},
        id: "neg-seed",
        parentId: null,
        timestamp: new Date(0).toISOString(),
      });
      return;
    }
  });
}
`,
	);
	await writeFile(probeOut, "");
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ extensions: [packageDir] }),
	);
	return { root, home, agentDir, cwd, packageDir, probePath, probeOut };
}

function sendSse(
	response: import("node:http").ServerResponse,
	text: string,
): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		connection: "keep-alive",
	});
	const id = `mock-${Date.now()}`;
	response.write(
		`data: ${JSON.stringify({ id, model: "watchdog-e2e", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
	);
	response.write(
		`data: ${JSON.stringify({ id, model: "watchdog-e2e", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
	);
	response.end("data: [DONE]\n\n");
}

async function startMockServer(
	t: TestContext,
	replyText = "native summary",
): Promise<{ baseUrl: string; requests: RequestRecord[] }> {
	const requests: RequestRecord[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const payload = JSON.parse(body) as Omit<RequestRecord, "receivedAt">;
			requests.push({ ...payload, receivedAt: Date.now() });
			sendSse(response, replyText);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		server.close();
		await once(server, "close");
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function createSession(
	fixture: PackedFixture,
	baseUrl: string,
	sessionManager: SessionManager,
	piSettings?: Record<string, unknown>,
	options?: { readonly withoutProbe?: boolean },
): Promise<{ session: AgentSession }> {
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousProbe = process.env.NATIVE_SUMMARY_PROBE_OUT;
	const domainNames = [
		"PI_EXTENSION_UTILS_PROCESS_DOMAIN",
		"PI_CONTINUE_WATCHDOG_ROOT_PID",
	] as const;
	const previousDomain = Object.fromEntries(
		domainNames.map((name) => [name, process.env[name]]),
	) as Record<(typeof domainNames)[number], string | undefined>;
	for (const name of domainNames) delete process.env[name];
	process.env.HOME = fixture.home;
	process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
	process.env.NATIVE_SUMMARY_PROBE_OUT = fixture.probeOut;
	try {
		if (piSettings !== undefined) {
			await writeFile(
				join(fixture.agentDir, "settings.json"),
				JSON.stringify(piSettings),
			);
		}
		const loader = new DefaultResourceLoader({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			additionalExtensionPaths: options?.withoutProbe
				? []
				: [fixture.probePath],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const modelRuntime = await ModelRuntime.create({ modelsPath: null });
		modelRuntime.registerProvider("watchdog-e2e", {
			name: "Watchdog E2E",
			baseUrl,
			apiKey: "local-only",
			api: "openai-completions",
			models: [
				{
					id: "watchdog-e2e",
					name: "Watchdog E2E",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 128,
				},
			],
		});
		const model = modelRuntime.getModel("watchdog-e2e", "watchdog-e2e");
		assert.ok(model);
		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRuntime,
			model,
			resourceLoader: loader,
			sessionManager,
		});
		await session.bindExtensions({ mode: "print" });
		session.extensionRunner.onError((err) => {
			// Surface probe/adapter errors instead of silently swallowing them.
			console.error("[extension error]", err.error, err.stack ?? "");
		});
		return { session };
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousProbe === undefined)
			delete process.env.NATIVE_SUMMARY_PROBE_OUT;
		else process.env.NATIVE_SUMMARY_PROBE_OUT = previousProbe;
		for (const name of domainNames) {
			const value = previousDomain[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

async function shutdownSession(session: AgentSession): Promise<void> {
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	session.dispose();
}

function requestText(request: RequestRecord): string {
	return JSON.stringify(request);
}

/** Only the message list — tool declarations are allowed to include cw. */
function messageText(request: RequestRecord): string {
	return JSON.stringify(request.messages);
}

function readProbeRows(
	probeOut: string,
): Promise<Array<Record<string, unknown>>> {
	return readFile(probeOut, "utf8").then((raw) =>
		raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>),
	);
}

function assertNoWatchdogLeak(body: string, exchangeId: string): void {
	assert.doesNotMatch(body, new RegExp(`hidden decision prompt ${exchangeId}`));
	assert.doesNotMatch(body, new RegExp(`verdict accepted for ${exchangeId}`));
	assert.doesNotMatch(body, /"name":\s*"cw"/);
	assert.doesNotMatch(body, /cw\(action=/);
}

// ---------------------------------------------------------------------------
// 1.2 — recorder sees real serialized requests on every native summary path
// ---------------------------------------------------------------------------

test("native summary seam records serialized provider requests", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);
	assert.equal(HOST_VERSION, "0.85.1", "pinned host version recorded");

	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "Implement the widget task.", 1);
	assistantEntry(sm, 2, [
		{ id: "read-1", name: "read", arguments: { path: "/repo/src/widget.ts" } },
	]);
	toolResultEntry(sm, "read-1", "read", "export const widget = 1;", 3);
	markerEntry(sm, "exA", 1);
	inquiryPromptEntry(sm, "exA", 1);
	decisionAssistantEntry(sm, "exA", "unlock");
	decisionToolResultEntry(sm, "exA");
	foldEntry(sm, "exA", 1, "unlock");
	userEntry(sm, "Ordinary follow-up question.", 10);
	assistantEntry(sm, 11);
	userEntry(sm, "Final ordinary tail.", 12);
	const branchSnapshot = sm.getBranch().map((entry) => entry.id);

	const { session } = await createSession(fixture, baseUrl, sm);
	try {
		await session.prompt("Trigger an ordinary request now.");
		await session.waitForIdle();
	} finally {
		await shutdownSession(session);
	}
	assert.ok(requests.length >= 1, "ordinary request recorded");
	const ordinary = requests.at(-1);
	assert.ok(ordinary);
	const ordinaryBody = messageText(ordinary);
	assert.match(ordinaryBody, /Implement the widget task\./);
	assert.match(ordinaryBody, /Trigger an ordinary request now\./);
	assertNoWatchdogLeak(ordinaryBody, "exA");
	// Raw history preserved: internal entries remain in the session.
	assert.deepEqual(
		sm
			.getBranch()
			.map((entry) => entry.id)
			.slice(0, branchSnapshot.length),
		branchSnapshot,
	);
	assert.ok(
		sm
			.getBranch()
			.some(
				(entry) =>
					entry.type === "custom_message" && entry.customType === INQUIRY,
			),
		"raw inquiry prompt entry preserved",
	);
});

test("manual compaction consumes the public preparation seam", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "Root task for manual compaction.", 1);
	assistantEntry(sm, 2, [
		{ id: "r1", name: "read", arguments: { path: "/repo/a.ts" } },
	]);
	toolResultEntry(sm, "r1", "read", "file body", 3);
	sm.appendCustomMessageEntry(
		"other-extension:work",
		"UNRELATED_WORK_KEEP_872",
		true,
		{ source: "other" },
	);
	markerEntry(sm, "exM", 1);
	inquiryPromptEntry(sm, "exM", 1);
	decisionAssistantEntry(sm, "exM", "continue");
	decisionToolResultEntry(sm, "exM");
	foldEntry(sm, "exM", 1, "continue");
	// Second exchange with an IDENTICAL replacement body: correlation (not
	// content equality) must attach continuations to the right fold.
	markerEntry(sm, "exM2", 1);
	inquiryPromptEntry(sm, "exM2", 1);
	decisionAssistantEntry(sm, "exM2", "continue");
	decisionToolResultEntry(sm, "exM2");
	foldEntry(sm, "exM2", 1, "continue");
	userEntry(sm, "middle ordinary", 8);
	assistantEntry(sm, 9);
	userEntry(sm, "tail item one", 10);
	assistantEntry(sm, 11);
	const rawBefore = JSON.stringify(sm.getEntries());

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm, {
		extensions: [fixture.packageDir],
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 5 },
	});
	try {
		const result = await session.compact();
		assert.ok(result.summary.length > 0);
	} finally {
		await shutdownSession(session);
	}
	const summaryRequest = requests.at(before);
	assert.ok(summaryRequest, "manual compaction provider request recorded");
	const body = messageText(summaryRequest);
	assert.match(body, /Root task for manual compaction\./);
	assert.match(body, /\/repo\/a\.ts/, "file-operation evidence preserved");
	assert.match(body, /middle ordinary/);
	// Unrelated extension custom work survives projection.
	assert.match(
		body,
		/UNRELATED_WORK_KEEP_872/,
		"unrelated extension work must survive",
	);
	// Both accepted continuations survive at fold positions.
	const continuationHits =
		body.match(/Continue watchdog continued · WORK_REMAINS/g) ?? [];
	assert.equal(
		continuationHits.length,
		2,
		"exactly one continuation per selected fold, never another at its prompt",
	);
	assertNoWatchdogLeak(body, "exM");
	assertNoWatchdogLeak(body, "exM2");
	// Cut identity unchanged: persisted compaction.firstKeptEntryId equals the
	// exact id the probe captured in preparation.
	const rowsCut = await readProbeRows(fixture.probeOut);
	const recCut = rowsCut.find((row) => row.kind === "before_compact");
	assert.ok(recCut, "before_compact preparation recorded");
	const compactionEntry = sm
		.getBranch()
		.find((entry) => entry.type === "compaction");
	assert.ok(compactionEntry && compactionEntry.type === "compaction");
	assert.equal(
		compactionEntry.firstKeptEntryId,
		recCut.firstKeptEntryId,
		"persisted firstKeptEntryId equals recorded preparation cut",
	);
	const firstKept = sm
		.getBranch()
		.find((entry) => entry.id === compactionEntry.firstKeptEntryId);
	assert.ok(firstKept, "firstKeptEntryId resolves on the branch");
	// Preparation captured by the probe for inspection.
	const rec = recCut;
	assert.equal(rec.reason, "manual");
	assert.equal(typeof rec.firstKeptEntryId, "string");
	const fileOps = rec.fileOps as { read: string[]; edited: string[] };
	assert.ok(
		fileOps.read.includes("/repo/a.ts") ||
			fileOps.edited.includes("/repo/a.ts"),
		"fileOps tracked by host",
	);
	// Raw stored history unchanged — full content equality for every
	// pre-compaction entry, including the owned exchange the projection hid.
	const after = sm.getEntries();
	const afterById = new Map(after.map((entry) => [entry.id, entry]));
	for (const entry of JSON.parse(rawBefore) as Array<{ id: string }>) {
		const current = afterById.get(entry.id);
		assert.ok(current, `entry ${entry.id} preserved`);
		assert.deepEqual(current, entry, `entry ${entry.id} unchanged`);
	}
	assert.ok(
		after.some(
			(entry) =>
				entry.type === "custom_message" && entry.customType === INQUIRY,
		),
		"raw inquiry prompt entry preserved after compaction",
	);
});

test("automatic split-turn compaction projects both regions", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	// Layout verified against the real `prepareCompaction` cut finder with
	// keepRecentTokens=8: the walk back from the tail user entry accumulates
	// past the budget at the trailing assistant, so the cut lands mid-turn and
	// the SAME exchange splits across regions — prompt/call/result inside
	// messagesToSummarize and its remove fold inside turnPrefixMessages. The
	// exchange stays contiguous in the branch; only the host cut crosses it.
	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "Old task history.", 1);
	assistantEntry(sm, 2);
	markerEntry(sm, "splitEx", 1);
	inquiryPromptEntry(sm, "splitEx", 1);
	decisionAssistantEntry(sm, "splitEx", "unlock");
	decisionToolResultEntry(sm, "splitEx");
	foldEntry(sm, "splitEx", 1, "unlock");
	assistantEntry(sm, 8);
	userEntry(sm, "Recent tail of the turn.", 9);
	const rawBefore = JSON.stringify(sm.getEntries());

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm, {
		extensions: [fixture.packageDir],
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 8 },
	});
	try {
		await session.prompt("kick off the turn");
		await session.waitForIdle();
	} finally {
		await shutdownSession(session);
	}
	const autoRequests = requests.slice(before);
	assert.ok(
		autoRequests.length >= 1,
		"automatic compaction produced a provider request",
	);
	// The split-turn history summary is the real native request covering the
	// region that carried the owned prompt/call/result.
	const historySummary = autoRequests
		.map(messageText)
		.find((text) => text.includes("Old task history."));
	assert.ok(
		historySummary,
		"split-turn history summarization request recorded",
	);
	assert.match(historySummary, /ordinary reply 2/);
	assertNoWatchdogLeak(historySummary, "splitEx");
	// No serialized request anywhere reintroduces owned traffic from either
	// region — including the emptied turn-prefix segment.
	const combined = autoRequests.map(messageText).join("\n");
	assertNoWatchdogLeak(combined, "splitEx");
	// Every summary-shaped request stays free of owned traffic; the turn-prefix
	// prompt can only appear if the host serialized a non-empty prefix region.
	for (const text of autoRequests.map(messageText)) {
		if (!text.includes("summarization assistant")) continue;
		assertNoWatchdogLeak(text, "splitEx");
	}
	const rows = await readProbeRows(fixture.probeOut);
	const splits = rows.filter(
		(row) => row.kind === "before_compact" && row.isSplitTurn === true,
	);
	assert.ok(splits.length > 0, "split-turn before_compact recorded");
	const splitRecord = splits.at(-1);
	assert.ok(splitRecord);
	const prefix = splitRecord.turnPrefixMessages as WireMessage[];
	assert.ok(prefix.length > 0, "turn prefix region present");
	// Exact region layout proof: captured raw regions show the exchange split
	// across the history/prefix boundary — prompt, call, and result in the
	// history region, the owned remove fold inside turnPrefixMessages.
	const historyRaw = JSON.stringify(splitRecord.messagesToSummarize);
	const prefixRaw = JSON.stringify(prefix);
	assert.ok(
		historyRaw.includes("hidden decision prompt splitEx"),
		"raw history region carried the owned inquiry prompt",
	);
	assert.ok(
		historyRaw.includes('"cw-splitEx"'),
		"raw history region carried the finalized cw call",
	);
	assert.ok(
		historyRaw.includes("verdict accepted for splitEx"),
		"raw history region carried the finalized cw result",
	);
	assert.ok(
		prefixRaw.includes("pi-continue-watchdog:inquiry-fold"),
		"raw turnPrefixMessages carried the owned fold",
	);
	// Both serialized requests exclude every owned piece even though each
	// region alone is incomplete: correlation came from the full branch. The
	// projection emptied the turn-prefix region, so the host (guarding on a
	// non-empty prefix) serialized no prefix request — proof the owned fold
	// never reached the provider rather than a missing case.
	assert.ok(
		!autoRequests.some((request) =>
			messageText(request).includes("PREFIX of a turn"),
		),
		"emptied owned turn-prefix produced no prefix request",
	);
	// Cut identity: recorded firstKeptEntryId matches the persisted compaction
	// entries' cut, and resolves to the tail user entry.
	const keptId = splitRecord.firstKeptEntryId;
	const keptEntry = sm.getEntries().find((entry) => entry.id === keptId);
	assert.ok(keptEntry, "recorded firstKeptEntryId resolves in raw entries");
	assert.equal(
		keptEntry.type === "message" ? keptEntry.message.role : keptEntry.type,
		"assistant",
		"split-turn cut keeps from the mid-turn assistant, not the turn start",
	);
	const persistedCuts = sm
		.getEntries()
		.filter((entry) => entry.type === "compaction")
		.map((entry) =>
			entry.type === "compaction" ? entry.firstKeptEntryId : "",
		);
	assert.ok(
		persistedCuts.includes(keptId as string),
		"persisted compaction entry records the same cut",
	);
	// Raw stored history unchanged — full content equality for every
	// pre-session entry.
	const after = sm.getEntries();
	const afterById = new Map(after.map((entry) => [entry.id, entry]));
	for (const entry of JSON.parse(rawBefore) as Array<{ id: string }>) {
		const current = afterById.get(entry.id);
		assert.ok(current, `entry ${entry.id} preserved`);
		assert.deepEqual(current, entry, `entry ${entry.id} unchanged`);
	}
});

// ---------------------------------------------------------------------------
// 1.3 — identity collisions at a previous compaction cut (reviewer cases)
// ---------------------------------------------------------------------------

test("shared custom metadata cannot substitute excluded history", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);
	const sm = SessionManager.inMemory(fixture.cwd);
	const details = { source: "other-extension", version: 1 };
	userEntry(sm, "Shared metadata root.", 1);
	const excluded = sm.appendCustomMessageEntry(
		"other-extension:work",
		"EXCLUDED_ALIAS_672",
		true,
		details,
	);
	assistantEntry(sm, 2);
	const selected = sm.appendCustomMessageEntry(
		"other-extension:work",
		"SELECTED_ALIAS_672",
		true,
		details,
	);
	assistantEntry(sm, 3);
	const oldEntry = sm.getEntry(excluded);
	const selectedEntry = sm.getEntry(selected);
	assert.ok(oldEntry?.type === "custom_message");
	assert.ok(selectedEntry?.type === "custom_message");
	assert.equal(oldEntry.details, selectedEntry.details);
	sm.appendCompaction("PRIOR_SUMMARY_SENTINEL", selected, 100);
	userEntry(sm, "Shared metadata retained tail.", 4);
	assistantEntry(sm, 5);
	const { session } = await createSession(fixture, baseUrl, sm, {
		extensions: [fixture.packageDir],
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 5 },
	});
	try {
		await session.compact();
	} finally {
		await shutdownSession(session);
	}
	const rows = await readProbeRows(fixture.probeOut);
	const preparation = rows.find((row) => row.kind === "before_compact");
	assert.ok(preparation);
	assert.match(
		JSON.stringify(preparation.messagesToSummarize),
		/SELECTED_ALIAS_672/,
	);
	assert.doesNotMatch(
		JSON.stringify(preparation.messagesToSummarize),
		/EXCLUDED_ALIAS_672/,
	);
	const body = requests.map(messageText).join("\n");
	assert.match(
		body,
		/SELECTED_ALIAS_672/,
		"selected unowned content stays verbatim",
	);
	assert.doesNotMatch(
		body,
		/EXCLUDED_ALIAS_672/,
		"excluded history is never substituted",
	);
});

test("equal-timestamp selected user is not substituted by older excluded history", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "EXCLUDED_OLD_USER_COLLISION", 1);
	assistantEntry(sm, 2);
	const selected = userEntry(sm, "CURRENT_SELECTED_USER_COLLISION", 1);
	assistantEntry(sm, 3);
	// Public persisted boundary: the older equal-timestamp user lies outside
	// the active window; the kept suffix starts at the selected user.
	sm.appendCompaction("PRIOR_SUMMARY_SENTINEL", selected, 100);
	userEntry(sm, "collision tail ordinary", 4);
	assistantEntry(sm, 5);

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm, {
		extensions: [fixture.packageDir],
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 5 },
	});
	try {
		await session.compact();
	} finally {
		await shutdownSession(session);
	}
	const rows = await readProbeRows(fixture.probeOut);
	const rec = rows.find((row) => row.kind === "before_compact");
	assert.ok(rec, "before_compact preparation recorded");
	const raw = JSON.stringify(rec.messagesToSummarize);
	assert.match(raw, /CURRENT_SELECTED_USER_COLLISION/);
	assert.doesNotMatch(raw, /EXCLUDED_OLD_USER_COLLISION/);
	const body = requests.slice(before).map(messageText).join("\n");
	assert.match(
		body,
		/CURRENT_SELECTED_USER_COLLISION/,
		"native selected ordinary work must survive exact identity correlation",
	);
	assert.doesNotMatch(
		body,
		/EXCLUDED_OLD_USER_COLLISION/,
		"older outside-region work must not be substituted into the request",
	);
});

test("same-timestamp ordinary cw call cannot resolve to an earlier folded call", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "CW collision root.", 1);
	markerEntry(sm, "oldFoldedCall", 1);
	inquiryPromptEntry(sm, "oldFoldedCall", 1);
	decisionAssistantEntry(sm, "oldFoldedCall", "unlock");
	decisionToolResultEntry(sm, "oldFoldedCall");
	foldEntry(sm, "oldFoldedCall", 1, "unlock");
	userEntry(sm, "Outside phase ordinary cw remains evidence.", 10);
	// decisionAssistantEntry pins timestamp 0; the ordinary non-owned cw call
	// below shares that assistant timestamp by construction.
	const selected = decisionAssistantEntry(sm, "unownedOrdinaryCall", "unlock");
	decisionToolResultEntry(sm, "unownedOrdinaryCall");
	sm.appendCompaction("PRIOR_SUMMARY_SENTINEL", selected, 100);
	userEntry(sm, "CW collision retained tail.", 11);
	assistantEntry(sm, 12);

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm, {
		extensions: [fixture.packageDir],
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 5 },
	});
	try {
		await session.compact();
	} finally {
		await shutdownSession(session);
	}
	const rows = await readProbeRows(fixture.probeOut);
	const rec = rows.find((row) => row.kind === "before_compact");
	assert.ok(rec, "before_compact preparation recorded");
	assert.match(
		JSON.stringify(rec.messagesToSummarize),
		/cw-unownedOrdinaryCall/,
		"raw selected region carried the ordinary cw call",
	);
	assert.doesNotMatch(
		JSON.stringify(rec.messagesToSummarize),
		/cw-oldFoldedCall/,
		"earlier folded call lies outside the selected region",
	);
	const body = requests.slice(before).map(messageText).join("\n");
	// The summarizer serializes assistant calls without tool-call ids, so the
	// wire assertion is on the serialized call form; id-level identity is
	// asserted above on the raw/probe region. Exactly one serialized cw call
	// must remain: the ordinary non-owned one.
	const cwWireHits = body.match(/cw\(action=/g) ?? [];
	assert.equal(
		cwWireHits.length,
		1,
		`exactly the ordinary non-owned cw call reaches the wire, got ${cwWireHits.length}`,
	);
	assert.match(
		body,
		/verdict accepted for unownedOrdinaryCall/,
		"ordinary non-owned cw result reaches the wire",
	);
	// Old owned exchange isolation, specifically: its prompt, its verdict, and
	// its call id never reach the wire. The ordinary non-owned cw call above is
	// deliberately NOT covered by a blanket cw matcher — it must survive.
	assert.doesNotMatch(body, /hidden decision prompt oldFoldedCall/);
	assert.doesNotMatch(body, /verdict accepted for oldFoldedCall/);
	assert.doesNotMatch(body, /cw-oldFoldedCall/);
});

test("equal-time continuation folds keep exact fold identity across a cut", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "collision continuation root", 1);
	markerEntry(sm, "oldSameTime", 1);
	inquiryPromptEntry(sm, "oldSameTime", 1);
	decisionAssistantEntry(sm, "oldSameTime", "continue");
	decisionToolResultEntry(sm, "oldSameTime");
	const oldFold = foldEntry(sm, "oldSameTime", 1, "continue");
	markerEntry(sm, "selectedSameTime", 1);
	inquiryPromptEntry(sm, "selectedSameTime", 1);
	decisionAssistantEntry(sm, "selectedSameTime", "continue");
	decisionToolResultEntry(sm, "selectedSameTime");
	const selectedFold = foldEntry(sm, "selectedSameTime", 1, "continue");
	// Force equal fold timestamps in the seeded history only: both folds then
	// share (role, customType, timestamp) — only exact correlation can
	// distinguish them. Both replacement bodies stay distinct so the wire
	// shows which exchange supplied the emitted guidance.
	const oldEntry = sm.getEntry(oldFold);
	const selectedEntry = sm.getEntry(selectedFold);
	assert.ok(
		oldEntry &&
			selectedEntry &&
			oldEntry.type === "custom_message" &&
			selectedEntry.type === "custom_message",
	);
	oldEntry.timestamp = "2026-01-01T00:00:00.000Z";
	// Distinct bodies: selected keeps the canonical CONTINUE_BODY; the old
	// exchange's replacement carries a marker body that must NOT appear.
	if (selectedEntry.content !== CONTINUE_BODY) {
		throw new Error("selected fold must carry the canonical body");
	}
	oldEntry.content = "EARLIER_GUIDANCE_OUTSIDE_SELECTED_REGION";
	const oldDetails = oldEntry.details as {
		replacement?: { content: string };
	};
	if (oldDetails.replacement !== undefined) {
		oldDetails.replacement.content = "EARLIER_GUIDANCE_OUTSIDE_SELECTED_REGION";
	}
	selectedEntry.timestamp = oldEntry.timestamp;
	// Public persisted boundary: older exchange already summarized; the kept
	// suffix starts at the selected fold.
	sm.appendCompaction("PRIOR_SUMMARY_SENTINEL", selectedFold, 100);
	userEntry(sm, "selected fold followed by ordinary work", 20);
	assistantEntry(sm, 21);
	userEntry(sm, "selected fold recent tail", 22);
	assistantEntry(sm, 23);

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm, {
		extensions: [fixture.packageDir],
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 5 },
	});
	try {
		await session.compact();
	} finally {
		await shutdownSession(session);
	}
	const rows = await readProbeRows(fixture.probeOut);
	const rec = rows.find((row) => row.kind === "before_compact");
	assert.ok(rec, "before_compact preparation recorded");
	const raw = JSON.stringify(rec.messagesToSummarize);
	assert.match(raw, /selectedSameTime/, "raw region carried the selected fold");
	assert.doesNotMatch(
		raw,
		/oldSameTime/,
		"older same-time fold lies outside the selected region",
	);
	const body = requests.slice(before).map(messageText).join("\n");
	assert.match(
		body,
		/Suggested next step: keep building\./,
		"selected continuation reaches the native summary request",
	);
	assert.doesNotMatch(
		body,
		/EARLIER_GUIDANCE_OUTSIDE_SELECTED_REGION/,
		"outside-region guidance must not be inserted",
	);
	assertNoWatchdogLeak(body, "oldSameTime");
	assertNoWatchdogLeak(body, "selectedSameTime");
});

test("owned continue fold inside a split prefix preserves ordinary prefix work", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	// The native cut places only the completed exchange's fold inside the
	// prefix; unrelated custom work and prompt/call/result remain in history.
	// The replacement is non-empty, so the prefix request must carry it once.
	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "Split prefix root ordinary.", 1);
	assistantEntry(sm, 2);
	markerEntry(sm, "ownedPrefix", 1);
	inquiryPromptEntry(sm, "ownedPrefix", 1);
	sm.appendCustomMessageEntry(
		"other-extension:prefix-work",
		"PREFIX_UNRELATED_KEEP_481",
		true,
		{ source: "other" },
	);
	decisionAssistantEntry(sm, "ownedPrefix", "continue");
	decisionToolResultEntry(sm, "ownedPrefix");
	foldEntry(sm, "ownedPrefix", 1, "continue");
	assistantEntry(sm, 8);
	userEntry(sm, "Split prefix recent tail.", 9);

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm, {
		extensions: [fixture.packageDir],
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 8 },
	});
	try {
		await session.prompt("Trigger prefix native requests.");
		await session.waitForIdle();
	} finally {
		await shutdownSession(session);
	}
	const rows = await readProbeRows(fixture.probeOut);
	const split = rows.find(
		(row) => row.kind === "before_compact" && row.isSplitTurn === true,
	);
	assert.ok(split, "actual native split preparation recorded");
	// Actual host cut layout (verified on the wire): the turn starts at the
	// fold — the only custom entry the host treats as turn-start-capable — so
	// the prefix region holds exactly the owned fold (with its non-empty
	// replacement) while the unrelated custom work stays in the history
	// region together with the exchange prompt/call/result.
	assert.match(
		JSON.stringify(split.messagesToSummarize),
		/PREFIX_UNRELATED_KEEP_481/,
		"raw history region carried unrelated custom work",
	);
	assert.match(
		JSON.stringify(split.turnPrefixMessages),
		/pi-continue-watchdog:inquiry-fold/,
		"raw split prefix carried the owned fold",
	);
	const body = requests.slice(before).map(messageText).join("\n");
	assert.match(
		body,
		/PREFIX_UNRELATED_KEEP_481/,
		"unrelated custom work survives projection on the wire",
	);
	// The replacement is non-empty, so the projected prefix region stays
	// non-empty and the host's real turn-prefix summarizer request must carry
	// exactly the continuation — proving placement, not just survival.
	const prefixRequest = requests
		.slice(before)
		.map(messageText)
		.find((text) => text.includes("PREFIX of a turn"));
	assert.ok(
		prefixRequest,
		"non-empty replacement produced a real turn-prefix request",
	);
	assert.equal(
		(prefixRequest.match(/Suggested next step: keep building\./g) ?? []).length,
		1,
		"turn-prefix request carries the selected continuation exactly once",
	);
	const historyRequest = requests
		.slice(before)
		.map(messageText)
		.find(
			(text) =>
				text.includes("context summarization assistant") &&
				text.includes("Split prefix root ordinary."),
		);
	assert.ok(historyRequest, "native history summary request recorded");
	assert.doesNotMatch(
		historyRequest,
		/Suggested next step: keep building\./,
		"a prompt in history must not duplicate its prefix-only replacement",
	);
	assert.doesNotMatch(
		prefixRequest,
		/PREFIX_UNRELATED_KEEP_481|hidden decision prompt|inquiry-fold/,
		"prefix region limited to its own turn content",
	);
	assertNoWatchdogLeak(body, "ownedPrefix");
});

test("branch summarization consumes the in-place preparation array", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	const sm = SessionManager.inMemory(fixture.cwd);
	const rootId = userEntry(sm, "Root navigation target.", 1);
	userEntry(sm, "Abandoned exploration question.", 2);
	assistantEntry(sm, 3);
	markerEntry(sm, "treeEx", 1);
	inquiryPromptEntry(sm, "treeEx", 1);
	decisionAssistantEntry(sm, "treeEx", "continue");
	decisionToolResultEntry(sm, "treeEx");
	foldEntry(sm, "treeEx", 1, "continue");
	userEntry(sm, "Abandoned tail question.", 8);
	const rawBefore = JSON.stringify(sm.getEntries());

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm);
	// Session startup may append bookkeeping entries (session_info, thinking
	// level), so the leaf at navigation time is authoritative.
	const oldLeafId = sm.getLeafId();
	let navResult: Awaited<ReturnType<typeof session.navigateTree>>;
	try {
		navResult = await session.navigateTree(rootId, { summarize: true });
		assert.equal(navResult.cancelled, false);
		assert.ok(navResult.summaryEntry, "summary entry produced");
	} finally {
		await shutdownSession(session);
	}
	const summaryRequest = requests.at(before);
	assert.ok(summaryRequest, "branch summary provider request recorded");
	const body = messageText(summaryRequest);
	assert.match(body, /Abandoned exploration question\./);
	assert.match(body, /Abandoned tail question\./);
	assertNoWatchdogLeak(body, "treeEx");
	assert.equal(
		(body.match(/Suggested next step: keep building\./g) ?? []).length,
		1,
		"tree summary emits a continuation only at its selected fold",
	);
	const rows = await readProbeRows(fixture.probeOut);
	const treeRecord = rows.find((row) => row.kind === "before_tree");
	assert.ok(treeRecord, "before_tree preparation recorded");
	assert.equal(treeRecord.targetId, rootId);
	// Exact identity, not just presence: recorded oldLeafId is the pre-nav leaf
	// and the recorded common ancestor is an entry on both paths (it must be an
	// ancestor of the target).
	assert.equal(treeRecord.oldLeafId, oldLeafId);
	const targetPath = sm.getBranch(rootId).map((entry) => entry.id);
	assert.ok(
		treeRecord.commonAncestorId === null
			? sm.getEntry(rootId)?.parentId === null
			: targetPath.includes(treeRecord.commonAncestorId as string),
		"commonAncestorId lies on the target path",
	);
	assert.equal(treeRecord.userWantsSummary, true);
	// Summary entry provenance: attached under the target's parent, recording
	// the exact old leaf it summarizes.
	assert.ok(navResult.summaryEntry);
	assert.equal(navResult.summaryEntry.fromId, oldLeafId);
	assert.equal(
		navResult.summaryEntry.parentId,
		sm.getEntry(rootId)?.parentId ?? null,
		"summary attaches at the target's parent (new leaf)",
	);
	const recorded = treeRecord.entriesToSummarize as Array<{
		type: string;
		customType?: string;
	}>;
	assert.ok(
		recorded.some(
			(entry) => entry.customType === "pi-continue-watchdog:inquiry-marker",
		),
		"entriesToSummarize included the plain custom marker",
	);
	assert.ok(
		recorded.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "pi-continue-watchdog:inquiry",
		),
		"entriesToSummarize included the hidden inquiry prompt",
	);
	// Raw stored history unchanged — full entry content equality, not just
	// ids: every pre-navigation entry survives byte-for-byte.
	const after = sm.getEntries();
	const afterById = new Map(after.map((entry) => [entry.id, entry]));
	for (const entry of JSON.parse(rawBefore) as Array<{ id: string }>) {
		const current = afterById.get(entry.id);
		assert.ok(current, `entry ${entry.id} preserved`);
		assert.deepEqual(current, entry, `entry ${entry.id} unchanged`);
	}
	assert.ok(
		after.some(
			(entry) =>
				entry.type === "custom_message" && entry.customType === INQUIRY,
		),
		"raw inquiry prompt entry preserved after navigation",
	);
});

test("branch summary excludes an exchange whose prompt sits outside the selected region", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	// Boundary shape: the abandoned branch contains the whole exchange, but
	// the navigation target is the inquiry prompt entry itself. The common
	// ancestor is then the prompt, so entriesToSummarize begins with the
	// finalized cw call — the prompt lies OUTSIDE the host-selected region.
	// Folding only the selected entries cannot recognize the call; ownership
	// must come from the full old active branch.
	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "Boundary root task.", 1);
	userEntry(sm, "Abandoned exploration question.", 2);
	assistantEntry(sm, 3);
	markerEntry(sm, "treeB", 1);
	const promptId = inquiryPromptEntry(sm, "treeB", 1);
	decisionAssistantEntry(sm, "treeB", "unlock");
	decisionToolResultEntry(sm, "treeB");
	foldEntry(sm, "treeB", 1, "unlock");
	// Ordinary selected work after the exchange must survive projection.
	userEntry(sm, "Abandoned ordinary tail work.", 8);
	const rawBefore = JSON.stringify(sm.getEntries());

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm);
	const oldLeafId = sm.getLeafId();
	try {
		const navResult = await session.navigateTree(promptId, {
			summarize: true,
		});
		assert.equal(navResult.cancelled, false);
	} finally {
		await shutdownSession(session);
	}
	const summaryRequest = requests.at(before);
	assert.ok(summaryRequest, "boundary branch summary request recorded");
	const body = messageText(summaryRequest);
	// Unrelated selected work survives. ("Abandoned exploration question"
	// sits before the prompt — outside the host-selected region by design.)
	assert.match(body, /Abandoned ordinary tail work\./);
	// The finalized call/result/fold — inside the selected region, whose
	// prompt is outside it — do not leak.
	assertNoWatchdogLeak(body, "treeB");
	assert.doesNotMatch(body, /pi-continue-watchdog:inquiry-fold/);
	// Exact selection boundary from the recorded preparation.
	const rows = await readProbeRows(fixture.probeOut);
	const treeRecord = rows.find((row) => row.kind === "before_tree");
	assert.ok(treeRecord, "before_tree preparation recorded");
	assert.equal(treeRecord.targetId, promptId);
	assert.equal(treeRecord.oldLeafId, oldLeafId);
	assert.equal(treeRecord.commonAncestorId, promptId);
	const recorded = treeRecord.entriesToSummarize as Array<{
		type: string;
		customType?: string;
	}>;
	assert.ok(
		recorded.length > 0 &&
			recorded[0]?.type === "message" &&
			!recorded.some(
				(entry) =>
					entry.type === "custom_message" && entry.customType === INQUIRY,
			),
		"selection began after the prompt and excluded the prompt entry",
	);
	// Raw stored history unchanged — full entry content equality.
	const after = sm.getEntries();
	const afterById = new Map(after.map((entry) => [entry.id, entry]));
	for (const entry of JSON.parse(rawBefore) as Array<{ id: string }>) {
		const current = afterById.get(entry.id);
		assert.ok(current, `entry ${entry.id} preserved`);
		assert.deepEqual(current, entry, `entry ${entry.id} unchanged`);
	}
});

// ---------------------------------------------------------------------------
// 1.3 — exact owned-exchange projection at the seam
// ---------------------------------------------------------------------------

test("public preparation seam projects exact owned exchanges", () => {
	// Completed prompt/call/result/fold exchange disappears entirely.
	const exchangeMessages: WireMessage[] = [
		{ role: "user", content: "task", timestamp: 1 },
		{
			role: "custom",
			customType: INQUIRY,
			content: [{ type: "text", text: "hidden decision prompt" }],
			display: false,
			details: {
				version: 1,
				namespace: "pi-continue-watchdog",
				inquiryId: "exX",
				attempt: 1,
			},
			timestamp: 2,
		},
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "cw-exX",
					name: "cw",
					arguments: { action: "unlock" },
				},
			],
			api: "openai-completions",
			provider: "watchdog-e2e",
			model: "watchdog-e2e",
			usage: {},
			stopReason: "toolUse",
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "cw-exX",
			toolName: "cw",
			content: [{ type: "text", text: "verdict accepted" }],
			isError: false,
			timestamp: 4,
		},
		{
			role: "custom",
			customType: INQUIRY_FOLD,
			content: [{ type: "text", text: "" }],
			display: false,
			details: {
				version: 1,
				namespace: "pi-continue-watchdog",
				inquiryId: "exX",
				attempt: 1,
				outcome: "remove",
				watchdogOutcome: "unlock",
			},
			timestamp: 5,
		},
		{ role: "user", content: "later", timestamp: 6 },
	];
	const projected = projectMessages(exchangeMessages);
	assert.deepEqual(
		projected.map((m) => (m as WireMessage).role),
		["user", "user"],
	);
	assert.doesNotMatch(JSON.stringify(projected), /hidden decision prompt/);
	assert.doesNotMatch(JSON.stringify(projected), /verdict accepted/);
	assert.match(JSON.stringify(projected), /later/);

	// Active exchange without a fold stays live (dispatch preserved).
	// Active admissible dispatch through this same production projection is
	// proven by the real native packed test "packed idle settlement opens one
	// inquiry before continuation" (test/e2e/packed.test.ts). That test
	// installs the packed watchdog extension — so src/extension.ts registers
	// registerDecisionContextFolding, applying this exact foldDecisionContext
	// to every outgoing request — and serves an admissible cw continue
	// response over real HTTP. Its four serialized requests show ordinary →
	// active inquiry → exactly one continuation turn (canonical continuation
	// body, no raw fold/audit internals) → next inquiry carrying only its own
	// prompt. Reviewer wire capture:
	// /var/tmp/native-summary-rereview-IIstLo/evidence/packed-dispatch-wire.jsonl.
	const active = projectMessages(exchangeMessages.slice(0, 4));
	assert.ok(
		active.some((m) => (m as WireMessage).role === "assistant"),
		"active admissible call preserved until dispatch",
	);

	// A replace fold emits the continuation message instead of the exchange.
	const continueFold: WireMessage = {
		role: "custom",
		customType: INQUIRY_FOLD,
		content: [{ type: "text", text: CONTINUE_BODY }],
		display: true,
		details: {
			version: 1,
			namespace: "pi-continue-watchdog",
			inquiryId: "exY",
			attempt: 1,
			outcome: "replace",
			watchdogOutcome: "continue",
			replacement: {
				customType: CONTINUATION,
				content: CONTINUE_BODY,
				details: { version: 1, exchangeId: "exY", outcome: "continue" },
			},
		},
		timestamp: 6,
	};
	const replaceMessages: WireMessage[] = [
		{ role: "user", content: "task", timestamp: 1 },
		{
			role: "custom",
			customType: INQUIRY,
			content: [{ type: "text", text: "hidden prompt exY" }],
			display: false,
			details: {
				version: 1,
				namespace: "pi-continue-watchdog",
				inquiryId: "exY",
				attempt: 1,
			},
			timestamp: 2,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "thinking" }],
			api: "openai-completions",
			provider: "watchdog-e2e",
			model: "watchdog-e2e",
			usage: {},
			stopReason: "stop",
			timestamp: 3,
		},
		continueFold,
		{ role: "user", content: "after", timestamp: 7 },
	];
	const replaceProjected = projectMessages(replaceMessages);
	const text = JSON.stringify(replaceProjected);
	assert.doesNotMatch(text, /hidden prompt exY/);
	assert.match(text, /Continue watchdog continued · WORK_REMAINS/);

	// Region crossing: the selection begins AFTER the prompt (prompt outside
	// the region, fold inside). Region-only folding cannot recognize the
	// exchange — this documents that boundary; full-branch correlation is what
	// the native probes above prove for real preparations.
	const tailRegion = replaceMessages.slice(2);
	assert.ok(
		tailRegion.every((m) => m !== replaceMessages[1]),
		"prompt genuinely outside the region",
	);
	const tailProjected = projectMessages(tailRegion);
	assert.doesNotMatch(JSON.stringify(tailProjected), /hidden prompt exY/);
});

test("a takeover-invalidated exchange is not presented as a completed exchange", () => {
	// Fixture legality, pinned separately from the completed-exchange cases:
	// a user message can only land between the prompt and the call when the
	// decision window was preempted/invalidated BEFORE dispatch — the runtime
	// then writes a remove fold with watchdogOutcome invalidated/preempted and
	// NO cw call or reason exists. The approved production contract strips the
	// provably owned terminal exchange (prompt, neutralized residue, remove
	// fold) identified by exact exchange correlation — never by body text —
	// while the human takeover record and all ordinary records survive.
	const invalidated: WireMessage[] = [
		{ role: "user", content: "task", timestamp: 1 },
		{
			role: "custom",
			customType: INQUIRY,
			content: [{ type: "text", text: "hidden decision prompt exT:1" }],
			display: false,
			details: {
				version: 1,
				namespace: "pi-continue-watchdog",
				inquiryId: "exT",
				attempt: 1,
			},
			timestamp: 2,
		},
		{ role: "user", content: "takeover", timestamp: 3 },
		{
			role: "custom",
			customType: INQUIRY_FOLD,
			content: [{ type: "text", text: "" }],
			display: false,
			details: {
				version: 1,
				namespace: "pi-continue-watchdog",
				inquiryId: "exT",
				attempt: 1,
				outcome: "remove",
				watchdogOutcome: "invalidated",
			},
			timestamp: 4,
		},
		{ role: "user", content: "later", timestamp: 5 },
	];
	const projected = projectMessages(invalidated);
	const text = JSON.stringify(projected);
	// The provably owned terminal exchange is stripped; the human takeover
	// and ordinary records survive.
	assert.doesNotMatch(
		text,
		/hidden decision prompt exT/,
		"owned invalidated prompt must not survive projection",
	);
	assert.match(text, /takeover/, "human takeover record survives");
	assert.match(text, /task|later/, "ordinary records survive");
	assert.ok(
		!text.includes('"name":"cw"') && !text.includes("verdict"),
		"no finalized call or reason is forged across the takeover",
	);
});

test("negative control notices reintroduced internal text", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);
	process.env.NATIVE_SUMMARY_NEGATIVE = "1";
	t.after(() => {
		delete process.env.NATIVE_SUMMARY_NEGATIVE;
	});

	const sm = SessionManager.inMemory(fixture.cwd);
	const rootId = userEntry(sm, "Neg root.", 1);
	userEntry(sm, "Neg abandoned.", 2);
	markerEntry(sm, "negEx", 1);
	inquiryPromptEntry(sm, "negEx", 1);
	decisionAssistantEntry(sm, "negEx", "unlock");
	decisionToolResultEntry(sm, "negEx");
	foldEntry(sm, "negEx", 1, "unlock");

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm);
	try {
		await session.navigateTree(rootId, { summarize: true });
	} finally {
		await shutdownSession(session);
	}
	const summaryRequest = requests.at(before);
	assert.ok(summaryRequest, "negative-control summary request recorded");
	const body = requestText(summaryRequest);
	// Probe reinsertion proves the capture would flag a genuine leak.
	assert.match(body, /REINTRODUCED internal decision prompt/);
	assert.throws(
		() => assert.doesNotMatch(body, /internal decision prompt/),
		/REINTRODUCED/,
	);
});

// ---------------------------------------------------------------------------
// Production-projection observation (no probe extension): the packed watchdog
// is the ONLY extension, so every assertion below observes the production
// summary-projection wiring through actual serialized provider requests.
// ---------------------------------------------------------------------------

function aiUnlockStatusEntry(
	manager: SessionManager,
	exchangeId: string,
	reason: string,
): string {
	return manager.appendCustomEntry("pi-continue-watchdog:ai-unlock", {
		reasonType: "JOB_DONE",
		reason,
		exchangeId,
		cycleId: 1,
	});
}

test("production compaction projection keeps ordinary work and continuations without control traffic", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "Prod manual root task.", 1);
	assistantEntry(sm, 2, [
		{ id: "p1", name: "read", arguments: { path: "/repo/prod.ts" } },
	]);
	toolResultEntry(sm, "p1", "read", "prod file body", 3);
	markerEntry(sm, "prodEx", 1);
	inquiryPromptEntry(sm, "prodEx", 1);
	decisionAssistantEntry(sm, "prodEx", "continue");
	decisionToolResultEntry(sm, "prodEx");
	foldEntry(sm, "prodEx", 1, "continue");
	// A finalized remove-only unlock exchange plus its quiet status entry.
	markerEntry(sm, "prodUnlock", 1);
	inquiryPromptEntry(sm, "prodUnlock", 1);
	decisionAssistantEntry(sm, "prodUnlock", "unlock");
	decisionToolResultEntry(sm, "prodUnlock");
	foldEntry(sm, "prodUnlock", 1, "unlock");
	aiUnlockStatusEntry(sm, "prodUnlock", "Requested analysis delivered.");
	userEntry(sm, "Prod tail question.", 8);
	const rawBefore = JSON.stringify(sm.getBranch());

	const before = requests.length;
	const { session } = await createSession(
		fixture,
		baseUrl,
		sm,
		{
			extensions: [fixture.packageDir],
			compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 5 },
		},
		{ withoutProbe: true },
	);
	try {
		const result = await session.compact();
		assert.ok(result.summary.length > 0);
	} finally {
		await shutdownSession(session);
	}
	const summaryRequest = requests.at(before);
	assert.ok(summaryRequest, "production manual compaction request recorded");
	const body = messageText(summaryRequest);
	assert.match(body, /Prod manual root task\./);
	assert.match(body, /\/repo\/prod\.ts/, "file evidence preserved");
	// Accepted continuation survives at its fold position; the kept tail region
	// stays out of the summarized conversation by host design.
	assert.match(body, /Suggested next step: keep building\./);
	assert.doesNotMatch(body, /Prod tail question\./);
	// Internal traffic and the quiet unlock status stay out of model input.
	assertNoWatchdogLeak(body, "prodEx");
	assertNoWatchdogLeak(body, "prodUnlock");
	assert.doesNotMatch(body, /Requested analysis delivered\./);
	assert.doesNotMatch(body, /pi-continue-watchdog:ai-unlock/);
	assert.equal(body.includes("pi-continue-watchdog:inquiry"), false);
	// Raw stored entries are untouched by projection itself: the pre-existing
	// prefix is byte-identical (the host may append its own compaction entry).
	const entriesAfter = sm.getEntries();
	const prefix = JSON.parse(rawBefore) as unknown[];
	assert.deepEqual(entriesAfter.slice(0, prefix.length), prefix);
});

test("production branch-summary projection excludes finalized unlock and quiet status", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	const sm = SessionManager.inMemory(fixture.cwd);
	const rootId = userEntry(sm, "Prod nav target.", 1);
	userEntry(sm, "Prod abandoned question.", 2);
	assistantEntry(sm, 3);
	markerEntry(sm, "prodTree", 1);
	inquiryPromptEntry(sm, "prodTree", 1);
	decisionAssistantEntry(sm, "prodTree", "unlock");
	decisionToolResultEntry(sm, "prodTree");
	foldEntry(sm, "prodTree", 1, "unlock");
	aiUnlockStatusEntry(sm, "prodTree", "Requested analysis delivered.");
	userEntry(sm, "Prod abandoned tail.", 8);
	const rawBefore = JSON.stringify(sm.getEntries());

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm, undefined, {
		withoutProbe: true,
	});
	try {
		const navResult = await session.navigateTree(rootId, {
			summarize: true,
		});
		assert.equal(navResult.cancelled, false);
		assert.ok(navResult.summaryEntry, "summary entry produced");
	} finally {
		await shutdownSession(session);
	}
	const summaryRequest = requests.at(before);
	assert.ok(summaryRequest, "production branch summary request recorded");
	const body = messageText(summaryRequest);
	assert.match(body, /Prod abandoned question\./);
	assert.match(body, /Prod abandoned tail\./);
	assertNoWatchdogLeak(body, "prodTree");
	assert.doesNotMatch(body, /Requested analysis delivered\./);
	assert.doesNotMatch(body, /pi-continue-watchdog:ai-unlock/);
	// Stored entries are never mutated by projection; the host appends its own
	// navigation bookkeeping after the unchanged prefix.
	const entriesAfter = sm.getEntries();
	const prefix = JSON.parse(rawBefore) as unknown[];
	assert.deepEqual(entriesAfter.slice(0, prefix.length), prefix);
});

test("production no-summary navigation performs no projection and mutates nothing", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	const sm = SessionManager.inMemory(fixture.cwd);
	const rootId = userEntry(sm, "Prod no-summary target.", 1);
	userEntry(sm, "Prod no-summary tail.", 2);
	const rawBefore = JSON.stringify(sm.getEntries());

	const before = requests.length;
	const { session } = await createSession(fixture, baseUrl, sm, undefined, {
		withoutProbe: true,
	});
	try {
		const navResult = await session.navigateTree(rootId, {
			summarize: false,
		});
		assert.equal(navResult.cancelled, false);
	} finally {
		await shutdownSession(session);
	}
	assert.equal(
		requests.length,
		before,
		"no-summary navigation issues no provider request",
	);
	// No projection or mutation: every original entry is present unchanged in
	// order (the host may append its own session bookkeeping entries).
	const entriesAfter = sm.getEntries();
	const prefix = JSON.parse(rawBefore) as unknown[];
	assert.deepEqual(entriesAfter.slice(0, prefix.length), prefix);
});

test("production projection survives session resume with legacy unlock history", {
	timeout: 300_000,
}, async (t) => {
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t);

	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "Prod resume task.", 1);
	assistantEntry(sm, 2);
	// Legacy raw records persisted by an older version: an unlock exchange and
	// a legacy wait fold with its wait event.
	markerEntry(sm, "resumeUnlock", 1);
	inquiryPromptEntry(sm, "resumeUnlock", 1);
	decisionAssistantEntry(sm, "resumeUnlock", "unlock");
	decisionToolResultEntry(sm, "resumeUnlock");
	foldEntry(sm, "resumeUnlock", 1, "unlock");
	aiUnlockStatusEntry(sm, "resumeUnlock", "Legacy analysis delivered.");
	sm.appendCustomMessageEntry(
		INQUIRY_FOLD,
		"Continue watchdog waiting · 30s · 2024-01-01",
		true,
		{
			version: 1,
			namespace: "pi-continue-watchdog",
			inquiryId: "resumeWait",
			attempt: 1,
			outcome: "replace",
			watchdogOutcome: "wait",
			replacement: {
				customType: "pi-continue-watchdog:event",
				content: "Continue watchdog waiting · 30s · 2024-01-01",
				details: {
					version: 1,
					kind: "wait",
					occurredAtMs: 0,
					occurredAt: "2024-01-01T00:00:00.000Z",
					reason: "Legacy wait reason.",
					waitSeconds: 30,
					deadlineMs: 30_000,
					deadline: "2024-01-01T00:00:30.000Z",
				},
			},
		},
	);
	userEntry(sm, "Prod resume tail.", 8);
	const rawBefore = JSON.stringify(sm.getEntries());

	const before = requests.length;
	// First session: resume over the legacy history, then compact.
	const first = await createSession(
		fixture,
		baseUrl,
		sm,
		{
			extensions: [fixture.packageDir],
			compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 5 },
		},
		{ withoutProbe: true },
	);
	try {
		const result = await first.session.compact();
		assert.ok(result.summary.length > 0);
	} finally {
		await shutdownSession(first.session);
	}
	const summaryRequest = requests.at(before);
	assert.ok(summaryRequest, "resume compaction request recorded");
	const body = messageText(summaryRequest);
	assert.match(body, /Prod resume task\./);
	assertNoWatchdogLeak(body, "resumeUnlock");
	assert.doesNotMatch(body, /Legacy analysis delivered\./);
	// The legacy wait replacement is recognized control traffic from a retired
	// exchange: its raw control body must not be reintroduced into the summary.
	assert.doesNotMatch(body, /Continue watchdog waiting · 30s/);
	const entriesAfter = sm.getEntries();
	const prefix = JSON.parse(rawBefore) as unknown[];
	assert.deepEqual(entriesAfter.slice(0, prefix.length), prefix);
});

test("actual ordinary request after resumed legacy unlock excludes the old reason", {
	timeout: 300_000,
}, async (t) => {
	// R1 regression at the real transport seam: a persisted legacy unlock
	// replace-fold (valid v1 metadata, real legacy replacement event) must
	// not reenter the NEXT ORDINARY provider request, while the preserved
	// human work and the new user request do.
	const fixture = await makePackedFixture(t);
	const { baseUrl, requests } = await startMockServer(t, "ordinary reply");
	const sm = SessionManager.inMemory(fixture.cwd);
	userEntry(sm, "Legacy task.", 1);
	markerEntry(sm, "legacyActual", 1);
	inquiryPromptEntry(sm, "legacyActual", 1);
	decisionAssistantEntry(sm, "legacyActual", "unlock");
	decisionToolResultEntry(sm, "legacyActual");
	const oldBody =
		"Continue watchdog unlocked · JOB_DONE · LEGACY_NATIVE_PRIVATE_REASON";
	sm.appendCustomMessageEntry(INQUIRY_FOLD, oldBody, true, {
		version: 1,
		namespace: "pi-continue-watchdog",
		inquiryId: "legacyActual",
		attempt: 1,
		outcome: "replace",
		watchdogOutcome: "unlock",
		replacement: {
			customType: "pi-continue-watchdog:event",
			content: oldBody,
			details: {
				version: 1,
				kind: "unlock",
				occurredAtMs: 0,
				occurredAt: "1970-01-01T00:00:00.000+00:00",
				reasonType: "JOB_DONE",
				reason: "LEGACY_NATIVE_PRIVATE_REASON",
			},
		},
	});
	const { session } = await createSession(fixture, baseUrl, sm);
	try {
		await session.prompt("New ordinary user work.");
	} finally {
		await shutdownSession(session);
	}
	const request = requests[0];
	assert.ok(request, "ordinary request captured");
	const text = messageText(request);
	assert.match(text, /Legacy task\./);
	assert.match(text, /New ordinary user work\./);
	assert.doesNotMatch(
		text,
		/LEGACY_NATIVE_PRIVATE_REASON/,
		"legacy unlock reason must not reenter the ordinary provider request",
	);
});
