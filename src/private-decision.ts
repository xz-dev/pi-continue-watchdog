import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
	WatchdogChildSession,
	WatchdogForkInput,
	WatchdogRuntime,
} from "watchdog-subagents-runtime/watchdog-runtime";

import {
	DECISION_INVALID_ATTEMPT_LIMIT,
	type ValidDecision,
	validateDecisionArguments,
} from "./decision-protocol.js";

/**
 * Host-side private decision operation (design Decisions 4-7 of
 * isolate-watchdog-decisions-in-private-fork).
 *
 * One logical decision = one private /var/tmp directory with a result file
 * initialized to `{}`, one child created through `WatchdogRuntime.fork`, and
 * up to two inquiries in that same child (initial plus at most one
 * review-challenged reconsideration). Each inquiry consumes at most
 * DECISION_INVALID_ATTEMPT_LIMIT settled model responses; only normally
 * settled responses count as format attempts. Setup, file write/read,
 * provider, cancelled, and stale outcomes are typed failures, never format
 * corrections.
 *
 * The host owns policy and prompt wording via the `prompt`, `correction`, and
 * `review` callbacks. This adapter appends the actual JSON-encoded result
 * path inside <watchdog_result_file>...</watchdog_result_file> to the
 * callback text. No cw/structured_output instructions or decision result
 * function calls are involved; the file is the only result transport.
 */

/** Marker element appended to every prompt carrying the actual result path. */
export const WATCHDOG_RESULT_FILE_TAG = "watchdog_result_file";

/** Result filename inside the per-decision private directory. */
const RESULT_FILE_NAME = "decision.json";

/** Safe per-response observation handed to the optional audit callback. */
export interface PrivateDecisionObservation {
	/** Which inquiry produced this response. */
	readonly inquiry: "initial" | "reconsideration";
	/** 1-based consumed-response number inside this inquiry. */
	readonly attempt: number;
	readonly sessionId: string;
	readonly outcome:
		| { readonly kind: "valid"; readonly decision: ValidDecision }
		| { readonly kind: "invalid"; readonly error: string };
}

/** Terminal result of one logical private decision. */
export type PrivateDecisionResult =
	| {
			readonly kind: "decision";
			readonly decision: ValidDecision;
			readonly sessionId: string;
			/** True when the decision came from the reconsideration inquiry. */
			readonly reconsidered: boolean;
	  }
	| {
			readonly kind: "decision-failed";
			readonly error: string;
			readonly sessionId: string;
			readonly reconsidered: boolean;
	  }
	| { readonly kind: "cancelled"; readonly sessionId?: string }
	| {
			readonly kind: "execution-error";
			readonly error: string;
			readonly sessionId?: string;
	  };

export interface PrivateDecisionOptions {
	readonly runtime: WatchdogRuntime;
	/** Fork input minus host-owned agentDir/resultFile, allocated here. */
	readonly fork: Omit<WatchdogForkInput, "agentDir" | "resultFile">;
	readonly reasonTypes: readonly string[];
	readonly continueReasonTypes: readonly string[];
	/** Cancellation signal for the whole logical decision. */
	readonly signal?: AbortSignal;
	/**
	 * Freshness guard evaluated before/after every awaited boundary and before
	 * the terminal result. False means stale: the child is cancelled and its
	 * outcome can never commit.
	 */
	readonly isCurrent: () => boolean;
	/**
	 * Inquiry prompt text. `definiteChallengeFeedback` is present only for the
	 * one reconsideration inquiry. The JSON-encoded result path in a
	 * <watchdog_result_file> marker is appended to the returned text.
	 */
	readonly prompt: (
		resultFile: string,
		definiteChallengeFeedback?: string,
	) => string;
	/**
	 * Correction text appended to the same child after a consumed invalid
	 * response; receives the safe validator diagnostic and result path. The
	 * result-file marker is appended to the returned text as for `prompt`.
	 */
	readonly correction: (error: string, resultFile: string) => string;
	/**
	 * Optional semantic review, invoked at most once and only for a valid
	 * initial `unlock` candidate — never continue or a replacement. Receives
	 * a copy of the flat candidate so observer mutation cannot alter the
	 * accepted result. Returning a string is a definite challenge whose
	 * feedback opens the one reconsideration inquiry; `undefined` releases
	 * the original candidate.
	 */
	readonly review?: (decision: ValidDecision) => Promise<string | undefined>;
	/**
	 * Optional safe per-response audit; receives a copy of the candidate.
	 * A throwing callback is swallowed: it must never add model requests or
	 * change decision accounting.
	 */
	readonly onResponse?: (observation: PrivateDecisionObservation) => void;
	/**
	 * Optional lifecycle notification invoked once immediately before the
	 * first authorized prompt of each inquiry, after the child exists. A
	 * throwing callback is an execution error: no model request is launched
	 * silently afterwards.
	 */
	readonly onStarted?: (event: {
		readonly inquiry: "initial" | "reconsideration";
		readonly sessionId: string;
	}) => void;
}

type AttemptOutcome =
	| { readonly kind: "valid"; readonly decision: ValidDecision }
	| { readonly kind: "invalid"; readonly error: string }
	| { readonly kind: "cancelled" }
	| { readonly kind: "execution-error"; readonly error: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Prompt rejections caused by cancellation surface as AbortError. */
function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { name?: unknown }).name === "AbortError"
	);
}

/**
 * Inspect the final assistant outcome this prompt appended to the child.
 * Only messages at or after `startIndex` — captured immediately before the
 * prompt — belong to this response; an inherited reply is never borrowed.
 * `none` means the settled prompt produced no own assistant message, so the
 * file (which may hold stale JSON) must not be evaluated as its result.
 * `failed` (`error`/`aborted`) is a typed provider outcome, never a format
 * correction.
 */
function assistantTerminalOutcome(
	child: WatchdogChildSession,
	startIndex: number,
):
	| { readonly kind: "none" }
	| { readonly kind: "ok" }
	| { readonly kind: "failed"; aborted: boolean; error: string } {
	for (let index = child.messages.length - 1; index >= startIndex; index--) {
		const message = child.messages[index];
		if (message?.role !== "assistant") continue;
		const stopReason = (message as { stopReason?: unknown }).stopReason;
		const detail = (message as { errorMessage?: unknown }).errorMessage;
		const errorText = typeof detail === "string" ? detail : undefined;
		if (stopReason === "aborted") {
			return {
				kind: "failed",
				aborted: true,
				error: errorText ?? "aborted",
			};
		}
		if (stopReason === "error") {
			return {
				kind: "failed",
				aborted: false,
				error: errorText ?? "provider error",
			};
		}
		return { kind: "ok" };
	}
	return { kind: "none" };
}

/**
 * Evaluate the designated result file after a normally settled response.
 * Malformed JSON, non-object JSON, and invalid decision fields are
 * model-format errors. Symlink/non-regular targets and filesystem read
 * failures are host execution errors, never repaired here. One complete
 * JSON object is required; extra fields and existing Unicode/type
 * normalization stay inside `validateDecisionArguments`.
 */
async function readDecisionFile(
	resultFile: string,
	reasonTypes: readonly string[],
	continueReasonTypes: readonly string[],
): Promise<
	| { readonly kind: "valid"; readonly decision: ValidDecision }
	| { readonly kind: "invalid"; readonly error: string }
	| { readonly kind: "execution-error"; readonly error: string }
> {
	// Open without following links and fstat the descriptor: a replaced
	// directory, symlink, or other non-regular path is a host execution
	// failure, not a model-format retry.
	let raw: string;
	try {
		const handle = await open(
			resultFile,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			if (!(await handle.stat()).isFile()) {
				return {
					kind: "execution-error",
					error: "decision result path is not the designated regular file.",
				};
			}
			raw = await handle.readFile("utf8");
		} finally {
			await handle.close().catch(() => {});
		}
	} catch (error) {
		return {
			kind: "execution-error",
			error: `result file unreadable: ${errorMessage(error)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			kind: "invalid",
			error: "decision result file does not contain one complete JSON object.",
		};
	}
	const validation = validateDecisionArguments(
		parsed,
		reasonTypes,
		continueReasonTypes,
	);
	return validation.valid
		? { kind: "valid", decision: validation.decision }
		: { kind: "invalid", error: validation.error };
}

/** Append the actual result-file marker to host callback text. */
function withResultMarker(text: string, resultFile: string): string {
	return `${text}\n\n<${WATCHDOG_RESULT_FILE_TAG}>${JSON.stringify(resultFile)}</${WATCHDOG_RESULT_FILE_TAG}>`;
}

/**
 * Run one bounded logical private decision. See the module header and the
 * watchdog-private-fork-decisions spec for the full contract.
 */
export async function runPrivateDecision(
	options: PrivateDecisionOptions,
): Promise<PrivateDecisionResult> {
	const { signal } = options;
	const cancelled = (): boolean =>
		signal?.aborted === true || !options.isCurrent();

	// Owned private resources: exactly one temp dir, created and removed here.
	let dir: string;
	try {
		dir = await mkdtemp("/var/tmp/watchdog-decision-");
	} catch (error) {
		return {
			kind: "execution-error",
			error: `private decision directory: ${errorMessage(error)}`,
		};
	}
	const agentDir = join(dir, "agent");
	const resultFile = join(dir, RESULT_FILE_NAME);
	let child: WatchdogChildSession | undefined;
	let abortRequested = false;

	const abortChild = async (): Promise<void> => {
		if (child === undefined || abortRequested) return;
		abortRequested = true;
		try {
			await child.abort();
		} catch {
			// Abort is best-effort; result authority is already revoked.
		}
	};

	const onSignalAbort = (): void => {
		void abortChild();
	};
	signal?.addEventListener("abort", onSignalAbort, { once: true });

	const cleanup = async (): Promise<void> => {
		// Drain/cancel the exact child, then remove only the owned temp dir.
		await abortChild();
		if (child !== undefined) {
			try {
				await child.dispose();
			} catch {
				// Disposal failure must not mask the terminal result.
			}
		}
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	};

	const resetResultFile = async (): Promise<string | undefined> => {
		// Initialize {} through a no-follow descriptor pinned by fstat. An
		// unexpected replacement (directory, link, non-regular node) is a
		// filesystem failure, not a format retry: it is reported, never
		// repaired or deleted here.
		try {
			const handle = await open(
				resultFile,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_NOFOLLOW |
					constants.O_NONBLOCK,
				0o600,
			);
			try {
				if (!(await handle.stat()).isFile()) {
					return "result file initialization: not a regular file";
				}
				await handle.truncate(0);
				await handle.writeFile("{}", "utf8");
			} finally {
				await handle.close().catch(() => {});
			}
			return undefined;
		} catch (error) {
			return `result file initialization: ${errorMessage(error)}`;
		}
	};

	const runDecision = async (): Promise<PrivateDecisionResult> => {
		// Initialize the result file to {} before the first attempt.
		const initError = await resetResultFile();
		if (initError !== undefined) {
			return { kind: "execution-error", error: initError };
		}

		try {
			await mkdir(agentDir, { recursive: true, mode: 0o700 });
		} catch (error) {
			return {
				kind: "execution-error",
				error: `private agent directory: ${errorMessage(error)}`,
			};
		}
		try {
			child = await options.runtime.fork({
				...options.fork,
				agentDir,
				resultFile,
			});
		} catch (error) {
			return {
				kind: "execution-error",
				error: `private fork: ${errorMessage(error)}`,
			};
		}
		const sessionId = child.sessionId;
		const ownedChild = child;

		/**
		 * One attempt = prompt the child once, then evaluate its own final
		 * assistant outcome before trusting the file. Aborted/errored provider
		 * outcomes and cancelled/stale attempts are typed failures, never
		 * format corrections.
		 */
		const attempt = async (text: string): Promise<AttemptOutcome> => {
			if (cancelled()) return { kind: "cancelled" };
			const startIndex = ownedChild.messages.length;
			let promptError: unknown;
			try {
				await ownedChild.prompt(withResultMarker(text, resultFile));
			} catch (error) {
				promptError = error;
			}
			const outcome = assistantTerminalOutcome(ownedChild, startIndex);
			if (
				cancelled() ||
				abortRequested ||
				(outcome.kind === "failed" && outcome.aborted) ||
				isAbortError(promptError)
			) {
				return { kind: "cancelled" };
			}
			if (promptError !== undefined) {
				return {
					kind: "execution-error",
					error: errorMessage(promptError),
				};
			}
			if (outcome.kind === "failed") {
				return { kind: "execution-error", error: outcome.error };
			}
			if (outcome.kind === "none") {
				// No own completed assistant message: the file (possibly stale
				// JSON or an inherited reply) must not supply a result.
				return {
					kind: "execution-error",
					error: "the prompt settled without an own completed response.",
				};
			}
			// Normally settled own response; admitted writes already completed.
			// The runner's concrete format diagnostic beats generic {}
			// field validation; provider/host throws stay execution errors.
			if (typeof ownedChild.attemptError === "string") {
				return { kind: "invalid", error: ownedChild.attemptError };
			}
			return readDecisionFile(
				resultFile,
				options.reasonTypes,
				options.continueReasonTypes,
			);
		};

		/**
		 * One inquiry = at most DECISION_INVALID_ATTEMPT_LIMIT consumed
		 * responses in the same child. Corrections append host text to that
		 * child; the file is reset to `{}` before the next authorized attempt.
		 */
		const runInquiry = async (
			inquiry: "initial" | "reconsideration",
			challengeFeedback?: string,
		): Promise<
			| { readonly kind: "decision"; decision: ValidDecision }
			| { readonly kind: "decision-failed"; error: string }
			| { readonly kind: "cancelled" }
			| { readonly kind: "execution-error"; error: string }
		> => {
			let text = options.prompt(resultFile, challengeFeedback);
			// Notify once before the first authorized prompt of this inquiry,
			// after the child exists; a throwing callback is an execution
			// error, not a silently launched model request.
			try {
				options.onStarted?.({ inquiry, sessionId });
			} catch (error) {
				return { kind: "execution-error", error: errorMessage(error) };
			}
			if (cancelled()) return { kind: "cancelled" };
			for (
				let response = 0;
				response < DECISION_INVALID_ATTEMPT_LIMIT;
				response++
			) {
				// The file is reset to {} before EVERY response attempt: the prior
				// attempt's admitted writes already settled inside `attempt`, so an
				// unchanged old object can never decide a later attempt.
				const attemptInitError = await resetResultFile();
				if (attemptInitError !== undefined) {
					return { kind: "execution-error", error: attemptInitError };
				}
				const outcome = await attempt(text);
				if (outcome.kind === "cancelled") return { kind: "cancelled" };
				if (outcome.kind === "execution-error") return outcome;
				const observation = outcome;
				try {
					options.onResponse?.({
						inquiry,
						attempt: response + 1,
						sessionId,
						outcome:
							observation.kind === "valid"
								? {
										kind: "valid",
										decision: { ...observation.decision },
									}
								: { kind: "invalid", error: observation.error },
					});
				} catch {
					// Audit failure never changes accounting or adds requests.
				}
				if (observation.kind === "valid") {
					return {
						kind: "decision",
						decision: { ...observation.decision },
					};
				}
				if (response + 1 >= DECISION_INVALID_ATTEMPT_LIMIT) {
					return { kind: "decision-failed", error: observation.error };
				}
				if (cancelled()) return { kind: "cancelled" };
				text = options.correction(observation.error, resultFile);
			}
			// Unreachable: the loop bound is DECISION_INVALID_ATTEMPT_LIMIT.
			return { kind: "decision-failed", error: "invalid decision" };
		};

		const initial = await runInquiry("initial");
		if (initial.kind === "cancelled") {
			return { kind: "cancelled", sessionId };
		}
		if (initial.kind === "execution-error") {
			return {
				kind: "execution-error",
				error: initial.error,
				sessionId,
			};
		}
		if (initial.kind === "decision-failed") {
			return {
				kind: "decision-failed",
				error: initial.error,
				sessionId,
				reconsidered: false,
			};
		}

		let candidate = initial.decision;
		let reconsidered = false;

		// One optional semantic review: valid initial unlock only.
		if (candidate.kind === "unlock" && options.review !== undefined) {
			if (cancelled()) return { kind: "cancelled", sessionId };
			let feedback: string | undefined;
			try {
				// Observer copy: a mutating review cannot alter the candidate.
				feedback = await options.review({ ...candidate });
			} catch {
				// A review-service failure is incomplete review: release original.
				feedback = undefined;
			}
			if (cancelled()) return { kind: "cancelled", sessionId };
			if (feedback !== undefined) {
				// The second inquiry has its own three-response allowance in the
				// same child; the superseded candidate never commits.
				const second = await runInquiry("reconsideration", feedback);
				if (second.kind === "cancelled") {
					return { kind: "cancelled", sessionId };
				}
				if (second.kind === "execution-error") {
					return {
						kind: "execution-error",
						error: second.error,
						sessionId,
					};
				}
				if (second.kind === "decision-failed") {
					return {
						kind: "decision-failed",
						error: second.error,
						sessionId,
						reconsidered: true,
					};
				}
				candidate = second.decision;
				reconsidered = true;
			}
		}

		if (cancelled()) return { kind: "cancelled", sessionId };
		return {
			kind: "decision",
			decision: candidate,
			sessionId,
			reconsidered,
		};
	};

	let result: PrivateDecisionResult;
	try {
		if (cancelled()) {
			result = { kind: "cancelled" };
		} else {
			result = await runDecision();
		}
	} finally {
		signal?.removeEventListener("abort", onSignalAbort);
		// Cancellation stays live through cleanup; currentness is rechecked
		// after this awaited boundary before any decision/failure can commit.
		await cleanup();
	}
	if (
		(result.kind === "decision" || result.kind === "decision-failed") &&
		cancelled()
	) {
		return { kind: "cancelled", sessionId: result.sessionId };
	}
	return result;
}
