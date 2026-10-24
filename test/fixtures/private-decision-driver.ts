import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	WatchdogChildSession,
	WatchdogForkInput,
	WatchdogRuntime,
} from "private-inquiry-subagents-runtime/watchdog-runtime";

import {
	type PrivateDecisionOptions,
	type PrivateDecisionResult,
	runPrivateDecision,
} from "../../src/private-decision.js";

/**
 * Reusable private-transport driver for main-session runtime tests.
 *
 * Installed through the `executePrivateDecision` lifecycle-test seam. It
 * forwards to the real `runPrivateDecision` with a fake `WatchdogRuntime`:
 * every child prompt consumes one scripted reply that writes the real private
 * result file. Only the file supplies the result; no public tool or parent
 * message is involved. All accounting, correction, review and cancellation
 * behavior is the production adapter's own.
 *
 * Prompts pace like the retired main-session flow: when the scripted queue is
 * empty and no responder is configured, a child prompt waits for the next
 * `respond` call instead of inventing a result.
 */

/** What one scripted child response does. */
export interface DriverReply {
	/** Raw string written to the result file. Omitted = leave `{}` untouched. */
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
	/** Side effect run inside the prompt before the reply settles. */
	readonly effect?: (resultFile: string) => void | Promise<void>;
	/** Optional gate: the prompt does not settle until this resolves. */
	readonly hold?: Promise<void>;
}

export interface DriverPromptContext {
	readonly promptText: string;
	readonly resultFile: string;
	/** 1-based response number inside this child. */
	readonly responseIndex: number;
	readonly child: FakeChildSession;
	readonly forkInput: WatchdogForkInput;
}

export type DriverResponder = (
	context: DriverPromptContext,
) => DriverReply | Promise<DriverReply>;

export interface FakeChildSession extends WatchdogChildSession {
	readonly prompts: readonly string[];
	/** Result-file contents observed before each scripted response. */
	readonly fileStates: readonly string[];
	readonly aborted: boolean;
	readonly disposed: boolean;
	/** Deliver one raw child event to current subscribers (unsubscribed drops). */
	emit(event: { type: string; [key: string]: unknown }): void;
}

export interface TrackedOperation {
	readonly options: PrivateDecisionOptions;
	readonly result: Promise<PrivateDecisionResult>;
	readonly settled: boolean;
}

export const VALID_UNLOCK_JSON = unlockJson();
export const VALID_CONTINUE_JSON = continueJson();

export function continueJson(
	reasonType = "WORK_REMAINS",
	reason = "Implementation work remains.",
): string {
	return JSON.stringify({
		action: "continue",
		reason_type: reasonType,
		reason_content: reason,
	});
}

export function unlockJson(
	reasonType = "JOB_DONE",
	reason = "All requested work is complete.",
): string {
	return JSON.stringify({
		action: "unlock",
		reason_type: reasonType,
		reason_content: reason,
	});
}

/**
 * One private-decision driver per harness. `execute` is installed as the
 * `executePrivateDecision` option; replies are queued in order or supplied
 * through `responder` (which sees the real prompt text and result path).
 */
export function createPrivateDriver(options?: {
	readonly responder?: DriverResponder;
	/**
	 * Native session-file locator each fake child reports, as the real
	 * runtime does. The shared core verifies it after settlement; point it
	 * at a real file to produce `available` evidence.
	 */
	readonly sessionFile?: string;
}) {
	const queue: Array<DriverReply | DriverResponder> = [];
	const children: FakeChildSession[] = [];
	const operations: TrackedOperation[] = [];
	const forkInputs: WatchdogForkInput[] = [];
	/** Prompts currently blocked on an empty script queue. */
	const waiting: Array<{
		readonly context: DriverPromptContext;
		readonly child: FakeChildSession;
		resolve(reply: DriverReply | DriverResponder): void;
	}> = [];
	let promptListener: ((context: DriverPromptContext) => void) | undefined;

	const nextReply = async (
		context: DriverPromptContext,
	): Promise<DriverReply> => {
		const scripted =
			queue.shift() ??
			options?.responder ??
			(await new Promise<DriverReply | DriverResponder>((resolve) => {
				waiting.push({ context, child: context.child, resolve });
			}));
		return typeof scripted === "function" ? scripted(context) : scripted;
	};

	const runtime: WatchdogRuntime = {
		async fork(input) {
			forkInputs.push(input);
			const prompts: string[] = [];
			const fileStates: string[] = [];
			const messages: AgentMessage[] = [];
			const state = {
				aborted: false,
				disposed: false,
				attemptError: undefined as string | undefined,
			};
			const subscribers = new Set<
				(event: { type: string; [key: string]: unknown }) => void
			>();
			const child: FakeChildSession = {
				sessionId: `private-child-${children.length + 1}`,
				modelId: "fake/local",
				sessionFile: options?.sessionFile,
				messages,
				get attemptError() {
					return state.attemptError;
				},
				get aborted() {
					return state.aborted;
				},
				get disposed() {
					return state.disposed;
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
					const context: DriverPromptContext = {
						promptText: text,
						resultFile: input.resultFile,
						responseIndex: prompts.length,
						child,
						forkInput: input,
					};
					promptListener?.(context);
					const reply = await nextReply(context);
					if (state.aborted) {
						const error = new Error("aborted");
						error.name = "AbortError";
						throw error;
					}
					if (reply.hold !== undefined) {
						await reply.hold;
						if (state.aborted) {
							const error = new Error("aborted");
							error.name = "AbortError";
							throw error;
						}
					}
					if (reply.effect !== undefined) {
						await reply.effect(input.resultFile);
					}
					if (reply.write !== undefined && !state.aborted) {
						await writeFile(input.resultFile, reply.write);
					}
					state.attemptError = reply.attemptError;
					if (reply.noOwnReply !== true) {
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: "fake" }],
							stopReason: reply.stopReason ?? "stop",
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
					// A parked prompt must surface its AbortError, not hang: release
					// this child's waiters; the post-await aborted check throws.
					for (let index = waiting.length - 1; index >= 0; index -= 1) {
						const parked = waiting[index];
						if (parked?.child === child) {
							waiting.splice(index, 1);
							parked.resolve({});
						}
					}
				},
				async dispose() {
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

	const driver = {
		runtime,
		children,
		forkInputs,
		operations,
		waiting,
		/** Queue a scripted reply (or per-prompt responder) for the next prompt. */
		respond(reply: DriverReply | DriverResponder): void {
			const blocked = waiting.shift();
			if (blocked !== undefined) {
				blocked.resolve(reply);
				return;
			}
			queue.push(reply);
		},
		/** True while a child prompt is parked on an empty script queue. */
		get awaitingResponse(): boolean {
			return waiting.length > 0;
		},
		/** Observe every consumed prompt (text carries the result-file marker). */
		onPrompt(listener: (context: DriverPromptContext) => void): void {
			promptListener = listener;
		},
		/**
		 * `executePrivateDecision` seam: real production operation, fake
		 * transport. Result promise is tracked for test synchronization.
		 */
		execute: (
			operationOptions: PrivateDecisionOptions,
		): Promise<PrivateDecisionResult> => {
			const operation = {
				options: operationOptions,
				settled: false,
				result: runPrivateDecision({
					...operationOptions,
					runtime,
				}),
			};
			const tracked = operation as TrackedOperation & {
				settled: boolean;
			};
			void operation.result.then(
				() => {
					tracked.settled = true;
				},
				() => {
					tracked.settled = true;
				},
			);
			operations.push(tracked);
			return operation.result;
		},
		/** Latest tracked operation, if any. */
		get current(): TrackedOperation | undefined {
			return operations.at(-1);
		},
	};

	return driver;
}

export type PrivateDriver = ReturnType<typeof createPrivateDriver>;

const TURN_LIMIT = 2000;

/** One event-loop turn: private ops await real filesystem work. */
const turn = (): Promise<void> =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 1);
	});

/**
 * Wait until the latest private operation reaches its terminal result and the
 * host's post-decision async work (finalization, publication) has drained.
 * Fails fast when a response is still parked on an empty script queue — the
 * test forgot to script a reply — instead of spinning forever.
 */
export async function settlePrivateDecision(
	driver: PrivateDriver,
	options?: { readonly turns?: number },
): Promise<PrivateDecisionResult | undefined> {
	const operation = driver.current;
	assert.ok(operation, "expected a started private decision operation");
	const limit = options?.turns ?? TURN_LIMIT;
	for (let attempt = 0; attempt < limit && !operation.settled; attempt += 1) {
		if (driver.awaitingResponse) {
			assert.fail(
				"private child is waiting for a scripted response that was never queued",
			);
		}
		await turn();
	}
	assert.equal(
		operation.settled,
		true,
		"private decision operation did not settle",
	);
	const result = await operation.result;
	// deliverPending/publication continue after the result resolves.
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await turn();
	}
	return result;
}

/** Wait until the operation exists (dispatch is async through the timer). */
export async function awaitPrivateOperation(
	driver: PrivateDriver,
	options?: { readonly turns?: number; readonly index?: number },
): Promise<TrackedOperation> {
	const limit = options?.turns ?? TURN_LIMIT;
	for (let attempt = 0; attempt < limit; attempt += 1) {
		const operation =
			driver.operations[options?.index ?? driver.operations.length - 1];
		if (operation !== undefined) return operation;
		await turn();
	}
	assert.fail("private decision operation was never started");
}

/** Wait until a child prompt is parked on the script queue (or consumed all). */
export async function awaitPrivatePrompt(
	driver: PrivateDriver,
	options?: { readonly turns?: number; readonly count?: number },
): Promise<DriverPromptContext> {
	const limit = options?.turns ?? TURN_LIMIT;
	const count = options?.count ?? 1;
	for (let attempt = 0; attempt < limit; attempt += 1) {
		const parked = driver.waiting.at(-1);
		if (parked !== undefined) return parked.context;
		const total = driver.children.reduce(
			(sum, child) => sum + child.prompts.length,
			0,
		);
		if (
			total >= count &&
			parked === undefined &&
			driver.children.every(
				(child) => child.fileStates.length === child.prompts.length,
			)
		) {
			// All consumed so far; expose the latest prompt's context.
			const child = driver.children.at(-1);
			const input = driver.forkInputs.at(-1);
			if (
				child !== undefined &&
				input !== undefined &&
				child.prompts.length > 0
			) {
				return {
					promptText: child.prompts.at(-1) ?? "",
					resultFile: input.resultFile,
					responseIndex: child.prompts.length,
					child,
					forkInput: input,
				};
			}
		}
		await turn();
	}
	assert.fail("no private child prompt reached the script queue");
}
