/**
 * Actual-candidate-service seam tests.
 *
 * These exercise the REAL pi-llm-as-jev v2 `createJudgmentService` code from
 * the sibling source checkout pointed at by `PI_JUDGMENT_SOURCE` — never a
 * copied engine, a handwritten protocol fake or an installed/activated copy.
 * Provider registries and transport are fixtures; no live credentials or
 * inference occur.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { JudgeRequest, JudgeResult } from "../src/judgment-client.js";
import {
	buildUnlockReviewRequest,
	runUnlockReview,
	UNLOCK_REVIEW_PROJECTION_VERSION,
	UNLOCK_REVIEW_QUESTION_ID,
} from "../src/unlock-review.js";

const SOURCE = process.env.PI_JUDGMENT_SOURCE;
const RUN = SOURCE !== undefined && SOURCE.length > 0;

interface LoadedCandidate {
	createJudgmentService: (runtime: unknown) => {
		judge(
			req: JudgeRequest,
			opts?: { signal?: AbortSignal },
		): Promise<JudgeResult>;
	};
	createAssistantMessageEventStream: () => {
		push(event: unknown): void;
		end(message: unknown): void;
	};
}

async function loadCandidate(): Promise<LoadedCandidate> {
	assert.ok(SOURCE, "PI_JUDGMENT_SOURCE points at the candidate checkout");
	const service = await import(
		pathToFileURL(join(SOURCE, "src/service.ts")).href
	);
	const piAi = await import(
		new URL("./index.js", import.meta.resolve("@earendil-works/pi-ai")).href
	);
	return {
		createJudgmentService: service.createJudgmentService,
		createAssistantMessageEventStream: piAi.createAssistantMessageEventStream,
	};
}

function request(): JudgeRequest {
	return buildUnlockReviewRequest(
		{
			projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
			rows: [
				{
					index: 0,
					kind: "user",
					entryId: "scope",
					text: "Deliver the staged report before stopping.",
				},
				{
					index: 1,
					kind: "assistant",
					entryId: "report",
					text: "Staged report delivered and verified.",
				},
			],
			gaps: [],
			sourceHeadId: "report",
			compactionBoundaryId: null,
		},
		{ action: "unlock", reasonType: "JOB_DONE", reason: "report delivered" },
	);
}

function chatModel() {
	return {
		type: undefined,
		id: "fake-model",
		provider: "fake",
		api: "openai-completions",
		baseUrl: "https://fake.invalid",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function jevModel() {
	return {
		type: "classifier",
		id: "jev-1.13",
		provider: "typesafe",
		name: "jev",
		api: "typesafe-system-one",
		baseUrl: "https://unused.invalid",
		input: ["text"],
		contextWindow: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function config(overrides: Record<string, unknown> = {}) {
	return {
		mode: "auto",
		thinkingLevel: "off",
		model: "fake/fake-model",
		provider: "fake",
		modelId: "fake-model",
		...overrides,
	};
}

const USAGE = {
	input: 7,
	output: 3,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 10,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function llmAnswer(choice: string) {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "answer",
				arguments: { choice },
			},
		],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function jevAnswer(choice: string) {
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: "jev-1.13",
		answers: {
			[UNLOCK_REVIEW_QUESTION_ID]: {
				type: "choice",
				choice,
				probabilities: {
					supported: choice === "supported" ? 1 : 0,
					challenged: choice === "challenged" ? 1 : 0,
					insufficient_evidence: choice === "insufficient_evidence" ? 1 : 0,
				},
				confidence: 1,
			},
		},
		stopReason: "stop",
		usage: USAGE,
		timestamp: Date.now(),
	};
}

interface FixtureOptions {
	mode?: "auto" | "auto-llm" | "classifier" | "llm";
	native?: {
		answer?: string;
		error?: Error;
		hang?: boolean;
	};
	llm?: {
		answer?: string;
		error?: Error;
		hang?: boolean;
	};
}

/** Real candidate service over fully scripted registries; no transport. */
async function candidateService(options: FixtureOptions) {
	const { createJudgmentService, createAssistantMessageEventStream } =
		await loadCandidate();
	const llmCalls: { signal?: AbortSignal }[] = [];
	const nativeCalls: { signal?: AbortSignal }[] = [];
	const registry = {
		getProviders: () => [{ id: "fake" }],
		getAuth: async () => ({ auth: { apiKey: "fixture-only" } }),
		getModel: (provider: string, id: string) =>
			provider === "fake" && id === "fake-model" ? chatModel() : undefined,
		getAvailableOfType: async () =>
			options.native === undefined ? [] : [jevModel()],
		classify: (_m: unknown, _c: unknown, o?: { signal?: AbortSignal }) => {
			nativeCalls.push({ signal: o?.signal });
			const native = options.native;
			if (native?.error) return Promise.reject(native.error);
			if (native?.hang) {
				return new Promise<never>(() => {});
			}
			return Promise.resolve(jevAnswer(native?.answer ?? "supported"));
		},
		streamSimple: (_m: unknown, _c: unknown, o?: { signal?: AbortSignal }) => {
			llmCalls.push({ signal: o?.signal });
			if (options.llm?.error) throw options.llm.error;
			const stream = createAssistantMessageEventStream();
			if (options.llm?.hang) {
				o?.signal?.addEventListener(
					"abort",
					() =>
						stream.end({
							role: "assistant",
							content: [],
							api: "openai-completions",
							provider: "fake",
							model: "fake-model",
							usage: USAGE,
							stopReason: "aborted",
							timestamp: Date.now(),
						}),
					{ once: true },
				);
				return stream;
			}
			stream.end(llmAnswer(options.llm?.answer ?? "supported"));
			return stream;
		},
	};
	const service = createJudgmentService({
		registry,
		config: () => config({ mode: options.mode ?? "auto" }),
		nativeFetch: () => {
			throw new Error("live transport forbidden in fixture");
		},
	});
	return { service, llmCalls, nativeCalls };
}

test("actual candidate: native supported judgment releases through the review seam", {
	skip: !RUN,
}, async () => {
	const { service } = await candidateService({
		native: { answer: "supported" },
	});
	const report = await runUnlockReview(
		service,
		request(),
		new AbortController().signal,
	);
	assert.equal(report.outcome.kind, "supported");
	assert.equal(report.backend, "classifier");
	assert.equal(report.model, "typesafe/jev-1.13");
});

test("actual candidate: challenged judgment opens the same single-reconsideration outcome", {
	skip: !RUN,
}, async () => {
	const { service } = await candidateService({
		native: { answer: "challenged" },
	});
	const report = await runUnlockReview(
		service,
		request(),
		new AbortController().signal,
	);
	assert.equal(report.outcome.kind, "challenged");
});

test("actual candidate: native failure falls back to real LLM attempt", {
	skip: !RUN,
}, async () => {
	const { service, llmCalls, nativeCalls } = await candidateService({
		native: { error: new Error("native classifier transport failed") },
		llm: { answer: "challenged" },
	});
	const report = await runUnlockReview(
		service,
		request(),
		new AbortController().signal,
	);
	assert.equal(report.outcome.kind, "challenged");
	assert.equal(report.backend, "llm");
	assert.equal(report.model, "fake/fake-model");
	assert.equal(nativeCalls.length, 1);
	assert.equal(llmCalls.length, 1);
});

for (const scenario of [
	{
		name: "forced LLM success",
		options: { mode: "llm", native: {}, llm: {} },
		outcome: "supported",
		backend: "llm",
		nativeCalls: 0,
		llmCalls: 1,
	},
	{
		name: "forced native failure",
		options: {
			mode: "classifier",
			native: { error: new Error("native down") },
			llm: {},
		},
		outcome: "incomplete",
		backend: "classifier",
		nativeCalls: 1,
		llmCalls: 0,
	},
	{
		name: "auto-llm failure to native",
		options: {
			mode: "auto-llm",
			native: {},
			llm: { error: new Error("llm down") },
		},
		outcome: "supported",
		backend: "classifier",
		nativeCalls: 1,
		llmCalls: 1,
	},
	{
		name: "terminal overflow",
		options: {
			mode: "classifier",
			native: { error: new Error("413: context_length_exceeded") },
		},
		outcome: "incomplete",
		backend: "classifier",
		nativeCalls: 1,
		llmCalls: 0,
	},
] satisfies Array<{
	name: string;
	options: FixtureOptions;
	outcome: string;
	backend: string;
	nativeCalls: number;
	llmCalls: number;
}>) {
	test(`actual candidate: ${scenario.name} preserves consumer disposition`, {
		skip: !RUN,
	}, async () => {
		const fixture = await candidateService(scenario.options);
		const report = await runUnlockReview(
			fixture.service,
			request(),
			new AbortController().signal,
		);
		assert.equal(report.outcome.kind, scenario.outcome);
		assert.equal(report.backend, scenario.backend);
		assert.equal(fixture.nativeCalls.length, scenario.nativeCalls);
		assert.equal(fixture.llmCalls.length, scenario.llmCalls);
		if (scenario.name === "terminal overflow")
			assert.equal(report.contextOverflow, true);
	});
}

test("actual candidate: caller cancellation aborts the owned call with no fallback", {
	skip: !RUN,
}, async () => {
	const { service, llmCalls } = await candidateService({
		native: { hang: true },
		llm: { answer: "supported" },
	});
	const controller = new AbortController();
	const pending = runUnlockReview(service, request(), controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	const report = await pending;
	assert.equal(report.outcome.kind, "incomplete");
	if (report.outcome.kind === "incomplete")
		assert.equal(report.outcome.reason, "aborted");
	assert.equal(llmCalls.length, 0);
});

test("actual candidate: both-failed error stays incomplete without a challenge", {
	skip: !RUN,
}, async () => {
	const { createJudgmentService } = await loadCandidate();
	const registry = {
		getProviders: () => [{ id: "fake" }],
		getAuth: async () => ({ auth: { apiKey: "fixture-only" } }),
		getModel: () => chatModel(),
		getAvailableOfType: async () => [jevModel()],
		classify: () => Promise.reject(new Error("native down")),
		streamSimple: () => {
			throw new Error("llm transport failed");
		},
	};
	const dead = createJudgmentService({
		registry,
		config: () => config(),
	});
	const report = await runUnlockReview(
		dead,
		request(),
		new AbortController().signal,
	);
	assert.equal(report.outcome.kind, "incomplete");
	if (report.outcome.kind === "incomplete")
		assert.equal(report.outcome.reason, "error");
	assert.ok(
		report.errorMessage === undefined || report.errorMessage.length <= 4096,
	);
});
