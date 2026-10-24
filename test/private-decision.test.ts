import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	WatchdogChildSession,
	WatchdogForkInput,
	WatchdogRuntime,
} from "private-inquiry-subagents-runtime/watchdog-runtime";

import {
	type PrivateDecisionObservation,
	RESULT_DIR_PREFIX,
	runPrivateDecision,
} from "../src/private-decision.js";

const REASON_TYPES = ["JOB_DONE", "NeedReview"];
const CONTINUE_REASON_TYPES = ["VERIFYING", "PROGRESS"];

/** What a fake child response does. */
interface FakeReply {
	/** Content written to the result file (raw string). Omitted = no write. */
	readonly write?: string;
	/** Throw from prompt() — provider/transport failure. */
	readonly throw?: Error;
	/** Terminal assistant outcome override for this response. */
	readonly stopReason?: "stop" | "error" | "aborted";
	readonly errorMessage?: string;
	/** Runner-side format diagnostic for this normally settled response. */
	readonly attemptError?: string;
	/** Settled prompt appends no own assistant message (inherited-only). */
	readonly noOwnReply?: boolean;
	/** Side effect run before the reply settles (e.g. corrupt the file). */
	readonly effect?: (resultFile: string) => void | Promise<void>;
}

interface FakeChild extends WatchdogChildSession {
	readonly prompts: readonly string[];
	readonly fileStates: readonly string[];
	readonly aborted: boolean;
	/** Deliver one raw child event to current subscribers (unsubscribed drops). */
	emit(event: { type: string; [key: string]: unknown }): void;
}

/**
 * Fake WatchdogRuntime/child: each prompt performs one scripted response that
 * may write the real private result file. Only one fork is ever created.
 */
function createFakeRuntime(
	t: TestContext,
	responder: (response: {
		promptText: string;
		resultFile: string;
		responseIndex: number;
	}) => FakeReply | Promise<FakeReply>,
	options: {
		readonly inheritedAssistant?: boolean;
		/** Runs inside child.dispose() before it completes (e.g. abort). */
		readonly onDispose?: () => void;
		/** Native session locator the fake child reports to the shared core. */
		readonly sessionFile?: string;
	} = {},
) {
	const dirs: string[] = [];
	const children: FakeChild[] = [];
	let forkInput: WatchdogForkInput | undefined;
	const disposeGate: { hold?: Promise<void> } = {};
	t.after(async () => {
		for (const child of children) await child.dispose();
	});
	const runtime: WatchdogRuntime = {
		async fork(input) {
			forkInput = input;
			dirs.push(input.agentDir);
			const prompts: string[] = [];
			const fileStates: string[] = [];
			const messages: AgentMessage[] = [];
			if (options.inheritedAssistant === true) {
				// A full fork inherits the parent's own past assistant replies.
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: "inherited" }],
					stopReason: "stop",
					timestamp: Date.now(),
				} as AgentMessage);
			}
			const state = {
				aborted: false,
				disposed: false,
				attemptError: undefined as string | undefined,
			};
			const subscribers = new Set<
				(event: { type: string; [key: string]: unknown }) => void
			>();
			const child: FakeChild = {
				sessionId: `private-child-${children.length + 1}`,
				modelId: "fake/local",
				sessionFile: options.sessionFile,
				messages,
				get attemptError() {
					return state.attemptError;
				},
				get aborted() {
					return state.aborted;
				},
				prompts,
				fileStates,
				async prompt(text: string) {
					if (state.aborted) {
						const error = new Error("aborted");
						error.name = "AbortError";
						throw error;
					}
					prompts.push(text);
					fileStates.push(await readFile(input.resultFile, "utf8"));
					const reply = await responder({
						promptText: text,
						resultFile: input.resultFile,
						responseIndex: prompts.length,
					});
					if (reply.effect !== undefined) {
						await reply.effect(input.resultFile);
					}
					if (reply.write !== undefined && !state.aborted) {
						await writeFile(input.resultFile, reply.write);
					}
					state.attemptError = reply.attemptError;
					if (reply.noOwnReply !== true) {
						const stopReason = reply.stopReason ?? "stop";
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: "fake" }],
							stopReason,
							...(reply.errorMessage === undefined
								? {}
								: { errorMessage: reply.errorMessage }),
							timestamp: Date.now(),
						} as AgentMessage);
					}
					if (reply.throw !== undefined) throw reply.throw;
				},
				async abort() {
					state.aborted = true;
				},
				async dispose() {
					options.onDispose?.();
					await disposeGate.hold;
					state.disposed = true;
				},
				subscribe(listener) {
					subscribers.add(listener);
					return () => {
						subscribers.delete(listener);
					};
				},
				emit: (event) => {
					for (const subscriber of [...subscribers]) subscriber(event);
				},
			};
			children.push(child);
			return child;
		},
		async dispose() {},
	};
	return {
		runtime,
		children,
		disposeGate,
		get forkInput() {
			return forkInput;
		},
	};
}

function baseOptions(
	runtime: WatchdogRuntime,
	overrides: Partial<Parameters<typeof runPrivateDecision>[0]> = {},
): Parameters<typeof runPrivateDecision>[0] {
	return {
		runtime,
		fork: {
			parent: undefined as never,
			parentProviderRegistry: undefined as never,
			cwd: "/var/tmp",
			model: "fake/local",
		},
		reasonTypes: REASON_TYPES,
		continueReasonTypes: CONTINUE_REASON_TYPES,
		isCurrent: () => true,
		prompt: () => "Submit the decision now.",
		correction: (error) => `Invalid: ${error} Correct it.`,
		...overrides,
	};
}

const VALID_UNLOCK =
	'{"action":"unlock","reason_type":"JOB_DONE","reason_content":"Done."}';
const VALID_CONTINUE =
	'{"action":"continue","reason_type":" verifying ","reason_content":"Run tests."}';

test("private progress observes validation and authorized correction without raw content", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? { write: "private malformed text" }
			: { write: VALID_CONTINUE },
	);
	const stages: unknown[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onProgress: (event) => stages.push(event),
		}),
	);
	assert.equal(result.kind, "decision");
	assert.deepEqual(stages, [
		{ stage: "waiting for model", inquiry: "initial", attempt: 1, limit: 3 },
		{ stage: "validating", inquiry: "initial", attempt: 1, limit: 3 },
		{ stage: "correcting", inquiry: "initial", attempt: 2, limit: 3 },
		{ stage: "waiting for model", inquiry: "initial", attempt: 2, limit: 3 },
		{ stage: "validating", inquiry: "initial", attempt: 2, limit: 3 },
	]);
	assert.equal(children[0].prompts.length, 2);
	assert.equal(
		JSON.stringify(stages).includes("private malformed text"),
		false,
	);
});

test("private progress keeps reconsideration allowance independent and observers nonthrowing", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) => ({
		write:
			responseIndex === 1
				? VALID_UNLOCK
				: responseIndex === 2
					? "{}"
					: VALID_CONTINUE,
	}));
	const stages: Array<{ inquiry: string; attempt: number; stage: string }> = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			review: async () => "challenge",
			onProgress: (event) => {
				stages.push({ ...event });
				throw new Error("display unavailable");
			},
		}),
	);
	assert.equal(result.kind, "decision");
	assert.deepEqual(
		stages
			.filter((event) => event.stage === "waiting for model")
			.map((event) => [event.inquiry, event.attempt]),
		[
			["initial", 1],
			["reconsideration", 1],
			["reconsideration", 2],
		],
	);
	assert.equal(children[0].prompts.length, 3);
});

test("private progress streams content-free output activity per response", async (t) => {
	const secret = "watchdog-streaming-sentinel-do-not-render";
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) => {
		queueMicrotask(() => {
			const emit = children.at(-1)?.emit.bind(children.at(-1));
			emit?.({ type: "message_start", message: { role: "assistant" } });
			if (responseIndex === 1) {
				emit?.({
					type: "message_update",
					assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
				});
				emit?.({
					type: "message_update",
					assistantMessageEvent: {
						type: "toolcall_delta",
						delta: "tool-arg-secret",
					},
				});
				emit?.({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: secret },
				});
				emit?.({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "x" },
				});
			} else {
				emit?.({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "abcde" },
				});
			}
			emit?.({ type: "message_end" });
		});
		return { write: responseIndex === 1 ? "{}" : VALID_CONTINUE };
	});
	const stages: Array<Record<string, unknown>> = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onProgress: (event) => stages.push({ ...(event as object) }),
		}),
	);
	assert.equal(result.kind, "decision");
	assert.equal(children.length, 1);
	assert.equal(children[0].prompts.length, 2);

	// First prompt: waiting, then streaming activity for the same response.
	const stream = (stage: Record<string, unknown>) =>
		stage.stream as { kind?: string; count?: number } | undefined;
	const firstWaiting = stages.findIndex(
		(stage) => stage.stage === "waiting for model" && stage.attempt === 1,
	);
	const firstStream = stages.findIndex(
		(stage) => stream(stage)?.kind === "thinking" && stage.attempt === 1,
	);
	assert.ok(firstWaiting >= 0 && firstStream > firstWaiting);
	// thinking_delta(3) + toolcall_delta("tool-arg-secret"=15) + text_delta(secret) + text_delta("x")
	assert.ok(
		stages.some(
			(stage) =>
				stream(stage)?.kind === "writing" &&
				stream(stage)?.count === 3 + 15 + secret.length + 1 &&
				stage.attempt === 1,
		),
	);
	assert.ok(
		stages.some(
			(stage) => stream(stage)?.kind === "tool call" && stage.attempt === 1,
		),
	);
	// message_end of response 1 clears the stream before validating.
	const backToWaiting = stages.findIndex(
		(stage, index) =>
			index > firstStream &&
			stage.stage === "waiting for model" &&
			stream(stage) === undefined &&
			stage.attempt === 1,
	);
	assert.ok(backToWaiting > firstStream);
	assert.ok(
		stages.some(
			(stage, index) =>
				index > backToWaiting &&
				stage.stage === "validating" &&
				stage.attempt === 1,
		),
	);
	// Second response resets the count and returns to waiting first.
	const secondWaiting = stages.findIndex(
		(stage) => stage.stage === "waiting for model" && stage.attempt === 2,
	);
	assert.ok(secondWaiting > backToWaiting);
	assert.ok(
		stages.some(
			(stage, index) =>
				index > secondWaiting &&
				stream(stage)?.kind === "writing" &&
				stream(stage)?.count === 5 &&
				stage.attempt === 2,
		),
	);
	// Privacy: no streamed text, thinking or tool-call argument text leaks
	// into any observed progress state.
	const serialized = JSON.stringify(stages);
	assert.equal(serialized.includes(secret), false);
	assert.equal(serialized.includes("tool-arg-secret"), false);
});

test("one valid file response returns a terminal decision and cleans up", async (t) => {
	const fixture = createFakeRuntime(t, () => ({
		write: VALID_CONTINUE,
	}));
	const result = await runPrivateDecision(baseOptions(fixture.runtime));
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.deepEqual(result.decision, {
		kind: "continue",
		reasonType: "VERIFYING",
		matchedReasonType: "VERIFYING",
		reason: "Run tests.",
	});
	const { children, forkInput } = fixture;
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.deepEqual(result.decision, {
		kind: "continue",
		reasonType: "VERIFYING",
		matchedReasonType: "VERIFYING",
		reason: "Run tests.",
	});
	assert.equal(result.reconsidered, false);
	assert.equal(result.sessionId, children[0].sessionId);
	assert.equal(children.length, 1, "exactly one child");
	assert.equal(children[0].prompts.length, 1);
	assert.ok(forkInput !== undefined);
	const ownedDir = dirname(forkInput.resultFile);
	// The prompt carries the actual JSON-encoded path inside the marker.
	assert.ok(
		children[0].prompts[0].endsWith(
			`<watchdog_result_file>${JSON.stringify(forkInput.resultFile)}</watchdog_result_file>`,
		),
	);
	assert.ok(forkInput.resultFile.startsWith(RESULT_DIR_PREFIX));
	if (process.platform !== "win32")
		assert.ok(forkInput.resultFile.startsWith("/var/tmp/watchdog-decision-"));
	assert.equal(forkInput.resultFile.endsWith("decision.json"), true);
	// Owned temp resources are deleted; nothing durable remains.
	assert.equal(existsSync(ownedDir), false);
});

test("invalid then valid corrects in the same child with the file reset", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? { write: '{"reason_type":"JOB_DONE","reason_content":"No action."}' }
			: { write: VALID_UNLOCK },
	);
	const corrections: string[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			correction: (error) => {
				corrections.push(error);
				return `Fix: ${error}`;
			},
		}),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "unlock");
	assert.equal(children.length, 1);
	assert.equal(children[0].prompts.length, 2);
	// The same child saw {} before every authorized attempt.
	assert.deepEqual(children[0].fileStates, ["{}", "{}"]);
	// The concrete validator diagnostic reached the correction prompt.
	assert.equal(corrections.length, 1);
	assert.match(corrections[0], /action must be one of continue or unlock/);
	assert.match(
		children[0].prompts[1],
		/action must be one of continue or unlock/,
	);
});

test("three invalid responses fail once with no fourth request", async (t) => {
	const { runtime, children } = createFakeRuntime(t, () => ({
		write: '{"action":"wait","reason_content":"Wait.","wait_seconds":60}',
	}));
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "decision-failed");
	if (result.kind !== "decision-failed") return;
	assert.match(result.error, /wait is no longer an accepted action/);
	assert.equal(result.reconsidered, false);
	assert.equal(children[0].prompts.length, 3);
});

test("exhausted corrections forward the verified retained session path", async (t) => {
	const sessionFile = `${RESULT_DIR_PREFIX}evidence-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`;
	await writeFile(sessionFile, "{}\n", { mode: 0o600 });
	t.after(async () => {
		await import("node:fs/promises").then((fs) =>
			fs.rm(sessionFile, { force: true }),
		);
	});
	const { runtime, children } = createFakeRuntime(
		t,
		() => ({ write: "not json" }),
		{ sessionFile },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "decision-failed");
	assert.deepEqual(result.session, {
		kind: "available",
		path: sessionFile,
		sessionId: children[0].sessionId,
	});
});

test("execution error forwards the verified retained session path", async (t) => {
	const sessionFile = `${RESULT_DIR_PREFIX}evidence-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`;
	await writeFile(sessionFile, "{}\n", { mode: 0o600 });
	t.after(async () => {
		await import("node:fs/promises").then((fs) =>
			fs.rm(sessionFile, { force: true }),
		);
	});
	const { runtime, children } = createFakeRuntime(
		t,
		() => ({ throw: new Error("provider exploded") }),
		{ sessionFile },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.deepEqual(result.session, {
		kind: "available",
		path: sessionFile,
		sessionId: children[0].sessionId,
	});
});

test("a child without a session file reports unavailable evidence", async (t) => {
	const { runtime } = createFakeRuntime(t, () => ({
		throw: new Error("provider exploded"),
	}));
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.equal(result.session?.kind, "unavailable");
	if (result.session?.kind === "unavailable")
		assert.equal(result.session.reason, "no-session");
});

test("a missing session file never becomes a claimed saved path", async (t) => {
	const missing = `${RESULT_DIR_PREFIX}evidence-missing-${process.pid}.jsonl`;
	const { runtime } = createFakeRuntime(
		t,
		() => ({ throw: new Error("provider exploded") }),
		{ sessionFile: missing },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.deepEqual(result.session, {
		kind: "unavailable",
		reason: "missing",
		sessionId: result.sessionId,
	});
});

test("malformed and non-object JSON are invalid format responses", async (t) => {
	const writes = [
		'{"action":"unlock"', // malformed
		"[1,2]", // non-object
		VALID_CONTINUE,
	];
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) => ({
		write: writes[responseIndex - 1],
	}));
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "decision");
	assert.equal(children[0].prompts.length, 3);
	assert.deepEqual(children[0].fileStates, ["{}", "{}", "{}"]);
});

test("an untouched {} file is one consumed invalid response", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1 ? {} : { write: VALID_CONTINUE },
	);
	const observations: PrivateDecisionObservation[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onResponse: (observation) => observations.push(observation),
		}),
	);
	assert.equal(result.kind, "decision");
	assert.equal(children[0].prompts.length, 2);
	assert.deepEqual(
		observations.map((o) => [o.inquiry, o.attempt, o.outcome.kind]),
		[
			["initial", 1, "invalid"],
			["initial", 2, "valid"],
		],
	);
});

test("provider failure is an execution error, not a format attempt", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? {
					throw: new Error("provider exploded"),
					stopReason: "error",
					errorMessage: "provider exploded",
				}
			: { write: VALID_CONTINUE },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	if (result.kind !== "execution-error") return;
	assert.match(result.error, /provider exploded/);
	assert.equal(children[0].prompts.length, 1, "no correction invented");
});

test("host file failure is an execution error, never a format failure", async (t) => {
	const { runtime, children } = createFakeRuntime(t, () => ({
		// Delete the result file instead of writing it: unreadable host file.
		effect: async (file) => {
			await import("node:fs/promises").then((fs) => fs.rm(file));
		},
	}));
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match(
		(result as { error?: string }).error ?? "",
		/result file unreadable/,
	);
	assert.equal(children[0].prompts.length, 1);
});

test("a directory replacement is a terminal filesystem error, no retry", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? {
					effect: async (file) => {
						// Replace the designated file with a directory.
						const fs = await import("node:fs/promises");
						await fs.rm(file);
						await fs.mkdir(file);
					},
				}
			: { write: VALID_CONTINUE },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match(
		(result as { error?: string }).error ?? "",
		/result file unreadable|not the designated regular file/,
	);
	assert.equal(children[0].prompts.length, 1, "no extra model call");
});

test("a symlink result path is a terminal filesystem error, never followed", async (t) => {
	const { runtime, children } = createFakeRuntime(t, () => ({
		effect: async (file) => {
			const fs = await import("node:fs/promises");
			await fs.rm(file);
			const target = `${file}.target`;
			await fs.writeFile(target, VALID_CONTINUE);
			await fs.symlink(target, file);
		},
	}));
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match(
		(result as { error?: string }).error ?? "",
		/result file unreadable|not the designated regular file/,
	);
	assert.equal(children[0].prompts.length, 1, "no extra model call");
});

test("abort cancels the exact child and a late file never commits", async (t) => {
	const controller = new AbortController();
	const { runtime, children } = createFakeRuntime(
		t,
		() =>
			new Promise<FakeReply>((resolve) => {
				// Write a valid file only after cancellation, then abort the run.
				queueMicrotask(() => {
					controller.abort();
					resolve({ write: VALID_CONTINUE });
				});
			}),
	);
	const result = await runPrivateDecision(
		baseOptions(runtime, { signal: controller.signal }),
	);
	assert.equal(result.kind, "cancelled");
	assert.equal(children[0].aborted, true, "exact child aborted");
});

test("a stale operation is cancelled without consuming its result", async (t) => {
	let current = true;
	const { runtime, children } = createFakeRuntime(t, () => {
		current = false; // ownership lost while the response settled
		return { write: VALID_CONTINUE };
	});
	const result = await runPrivateDecision(
		baseOptions(runtime, { isCurrent: () => current }),
	);
	assert.equal(result.kind, "cancelled");
	assert.equal(children[0].aborted, true);
});

test("cancelled before start creates no child", async (t) => {
	const controller = new AbortController();
	controller.abort();
	const { runtime, children } = createFakeRuntime(t, () => ({
		write: VALID_CONTINUE,
	}));
	const result = await runPrivateDecision(
		baseOptions(runtime, { signal: controller.signal }),
	);
	assert.equal(result.kind, "cancelled");
	assert.equal(children.length, 0, "no fork on an already-dead signal");
});

test("a definite challenge opens one reconsideration in the same child", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1 ? { write: VALID_UNLOCK } : { write: VALID_CONTINUE },
	);
	const prompts: Array<[string, string | undefined]> = [];
	const reviews: string[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			prompt: (file, feedback) => {
				prompts.push([file, feedback]);
				return "Decide.";
			},
			review: async (decision) => {
				reviews.push(decision.kind);
				return "challenge feedback: stop basis unproven";
			},
		}),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "continue");
	assert.equal(result.reconsidered, true);
	assert.equal(children.length, 1, "same child across inquiries");
	assert.deepEqual(reviews, ["unlock"]);
	// Second prompt carried the definite challenge feedback.
	assert.equal(prompts.length, 2);
	assert.equal(prompts[1][1], "challenge feedback: stop basis unproven");
	// File reset to {} before the reconsideration's first response.
	assert.deepEqual(children[0].fileStates, ["{}", "{}"]);
});

test("unsupported review releases the original unlock candidate", async (t) => {
	const { runtime } = createFakeRuntime(t, () => ({ write: VALID_UNLOCK }));
	const result = await runPrivateDecision(
		baseOptions(runtime, { review: async () => undefined }),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "unlock");
	assert.equal(result.reconsidered, false);
});

test("review throwing releases the original candidate", async (t) => {
	const { runtime } = createFakeRuntime(t, () => ({ write: VALID_UNLOCK }));
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			review: async () => {
				throw new Error("service down");
			},
		}),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "unlock");
});

test("review is never invoked for continue or the replacement", async (t) => {
	const replies = [VALID_UNLOCK, VALID_UNLOCK];
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) => ({
		write: replies[responseIndex - 1],
	}));
	const seen: string[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			review: async (decision) => {
				seen.push(decision.kind);
				return seen.length === 1 ? "challenged once" : "must not happen";
			},
		}),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "unlock");
	assert.equal(result.reconsidered, true);
	assert.deepEqual(seen, ["unlock"], "no second review of the replacement");
	assert.equal(children[0].prompts.length, 2);
});

test("review is skipped entirely for a continue candidate", async (t) => {
	const { runtime } = createFakeRuntime(t, () => ({ write: VALID_CONTINUE }));
	let called = 0;
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			review: async () => {
				called++;
				return "challenge";
			},
		}),
	);
	assert.equal(result.kind, "decision");
	assert.equal(called, 0);
});

test("six-response bound: two inquiries share one child, each capped at three", async (t) => {
	// initial: invalid, invalid, valid unlock (3) → challenge →
	// reconsideration: invalid, invalid, invalid (3) → decision-failed.
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) => {
		if (responseIndex <= 2) {
			return { write: '{"action":"bogus"}' };
		}
		if (responseIndex === 3) return { write: VALID_UNLOCK };
		return { write: '{"action":"also-bogus"}' };
	});
	const result = await runPrivateDecision(
		baseOptions(runtime, { review: async () => "definite challenge" }),
	);
	assert.equal(result.kind, "decision-failed");
	if (result.kind === "decision-failed") {
		assert.equal(result.reconsidered, true);
	}
	assert.equal(children[0].prompts.length, 6, "at most six consumed responses");
	assert.equal(children.length, 1);
});

test("a throwing audit callback changes neither decision nor accounting", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? { write: '{"action":"bogus"}' }
			: { write: VALID_CONTINUE },
	);
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onResponse: () => {
				throw new Error("audit blew up");
			},
		}),
	);
	assert.equal(result.kind, "decision");
	assert.equal(children[0].prompts.length, 2, "no extra model requests");
});

test("fork setup failure is an execution error without a decision", async () => {
	const runtime: WatchdogRuntime = {
		async fork() {
			throw new Error("no full-fork projection");
		},
		async dispose() {},
	};
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match(
		(result as { error?: string }).error ?? "",
		/no full-fork projection/,
	);
});

test("a settled prompt with no own reply cannot borrow an inherited response or a stale file", async (t) => {
	const { runtime, children } = createFakeRuntime(
		t,
		() => ({
			// The child settles without appending its own assistant message;
			// the file still holds a valid-looking stale object.
			noOwnReply: true,
			write: VALID_CONTINUE,
		}),
		{ inheritedAssistant: true },
	);
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.match(
		(result as { error?: string }).error ?? "",
		/without an own completed response/,
	);
	assert.equal(children[0].prompts.length, 1);
});

test("stream observations stop when the operation ends", async (t) => {
	const { runtime, children } = createFakeRuntime(t, () => ({
		write: VALID_CONTINUE,
	}));
	const stages: Array<Record<string, unknown>> = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onProgress: (event) => stages.push({ ...(event as object) }),
		}),
	);
	assert.equal(result.kind, "decision");
	const recorded = stages.length;
	children[0]?.emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "late" },
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 1));
	assert.equal(stages.length, recorded, "late deltas after completion drop");
});

for (const fault of ["subscribe", "unsubscribe"] as const) {
	test(`a throwing display ${fault} cannot change the decision or skip child cleanup`, async () => {
		const state = { prompts: 0, disposals: 0, listeners: 0 };
		let saved: ((event: { type: string }) => void) | undefined;
		const runtime = {
			async fork(input: { resultFile: string }) {
				const messages: unknown[] = [];
				return {
					sessionId: "fault-child",
					modelId: "fake/local",
					messages,
					async prompt() {
						state.prompts++;
						await writeFile(input.resultFile, VALID_CONTINUE);
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							stopReason: "stop",
							timestamp: Date.now(),
						});
					},
					async abort() {},
					async dispose() {
						state.disposals++;
					},
					subscribe(listener: (event: { type: string }) => void) {
						if (fault === "subscribe") throw new Error("display subscribe");
						saved = listener;
						state.listeners++;
						return () => {
							throw new Error("display unsubscribe");
						};
					},
				};
			},
			async dispose() {},
		} as unknown as WatchdogRuntime;
		const stages: unknown[] = [];
		const result = await runPrivateDecision(
			baseOptions(runtime, { onProgress: (event) => stages.push(event) }),
		);
		assert.equal(result.kind, "decision");
		assert.equal(state.prompts, 1);
		assert.equal(state.disposals, 1, "underlying child is always disposed");
		const recorded = stages.length;
		saved?.({ type: "message_start" });
		assert.equal(
			stages.length,
			recorded,
			"a saved listener is inert after cleanup",
		);
	});
}

test("a stale result read before a later recheck cannot commit", async (t) => {
	let current = true;
	const { runtime } = createFakeRuntime(t, () => ({ write: VALID_CONTINUE }));
	let checkedAfterRead = 0;
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			isCurrent: () => current,
			onResponse: () => {
				// Ownership is lost after the file read but before commit.
				checkedAfterRead++;
				current = false;
			},
		}),
	);
	assert.equal(result.kind, "cancelled");
	assert.ok(checkedAfterRead >= 1);
});

test("cancellation during cleanup still revokes a decided candidate", async (t) => {
	const controller = new AbortController();
	const { runtime, children, disposeGate } = createFakeRuntime(
		t,
		() => ({ write: VALID_CONTINUE }),
		{
			onDispose: () => {
				// The decision was made; abort lands mid-disposal.
				controller.abort();
				releaseDispose();
			},
		},
	);
	let releaseDispose: () => void = () => {};
	disposeGate.hold = new Promise<void>((resolve) => {
		releaseDispose = resolve;
	});
	const result = await runPrivateDecision(
		baseOptions(runtime, { signal: controller.signal }),
	);
	assert.equal(result.kind, "cancelled");
	assert.equal(children[0].aborted, true);
});

test("onStarted fires once per inquiry before its first authorized prompt", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1 ? { write: VALID_UNLOCK } : { write: VALID_CONTINUE },
	);
	const events: Array<{ inquiry: string; sessionId: string; at: number }> = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onStarted: ({ inquiry, sessionId }) => {
				events.push({
					inquiry,
					sessionId,
					at: children[0]?.prompts.length ?? -1,
				});
			},
			review: async () => "challenge",
		}),
	);
	assert.equal(result.kind, "decision");
	assert.deepEqual(
		events.map((event) => [event.inquiry, event.at]),
		[
			["initial", 0],
			["reconsideration", 1],
		],
	);
	assert.equal(events[0].sessionId, children[0].sessionId);
});

test("a throwing onStarted is an execution error without a model request", async (t) => {
	const { runtime, children } = createFakeRuntime(t, () => ({
		write: VALID_CONTINUE,
	}));
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onStarted: () => {
				throw new Error("lifecycle blew up");
			},
		}),
	);
	assert.equal(result.kind, "execution-error");
	assert.match((result as { error?: string }).error ?? "", /lifecycle blew up/);
	assert.equal(children[0].prompts.length, 0, "no silent model request");
});

test("a runner attemptError supplies the concrete format diagnostic", async (t) => {
	const { runtime, children } = createFakeRuntime(t, ({ responseIndex }) =>
		responseIndex === 1
			? {
					// Runner-rejected batch: file stays at the initialized {}.
					attemptError:
						"Expected exactly one write call to the designated decision result file.",
				}
			: { write: VALID_CONTINUE },
	);
	const corrections: string[] = [];
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			correction: (error) => {
				corrections.push(error);
				return `Fix: ${error}`;
			},
		}),
	);
	assert.equal(result.kind, "decision");
	assert.equal(children[0].prompts.length, 2);
	assert.equal(corrections.length, 1);
	assert.match(corrections[0], /exactly one write call/);
});

test("review and audit callbacks receive copies that cannot mutate the candidate", async (t) => {
	const { runtime } = createFakeRuntime(t, () => ({ write: VALID_UNLOCK }));
	const result = await runPrivateDecision(
		baseOptions(runtime, {
			onResponse: (observation) => {
				if (observation.outcome.kind === "valid") {
					// Mutating the audit copy must not alter the accepted result.
					(observation.outcome.decision as { reason: string }).reason =
						"poisoned";
				}
			},
			review: async (decision) => {
				(decision as { reason: string }).reason = "poisoned";
				return undefined;
			},
		}),
	);
	assert.equal(result.kind, "decision");
	if (result.kind !== "decision") return;
	assert.equal(result.decision.kind, "unlock");
	assert.equal(result.decision.reason, "Done.");
});

test("agentDir exists before runtime.fork is invoked", async () => {
	let existedAtFork = false;
	const runtime: WatchdogRuntime = {
		async fork(input) {
			existedAtFork = existsSync(input.agentDir);
			throw new Error("stop after check");
		},
		async dispose() {},
	};
	const result = await runPrivateDecision(baseOptions(runtime));
	assert.equal(result.kind, "execution-error");
	assert.equal(existedAtFork, true, "host created agentDir before fork");
});
