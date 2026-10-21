import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type PrivateForkInput,
	type PrivateInquiryObservation,
	type PrivateInquiryResult,
	type PrivateRuntime,
	runPrivateInquiry,
} from "pi-extension-utils/private-inquiry";

import {
	DECISION_INVALID_ATTEMPT_LIMIT,
	type ValidDecision,
	validateDecisionArguments,
} from "./decision-protocol.js";

/**
 * Continue's policy adapter over the shared private inquiry core
 * (`pi-extension-utils/private-inquiry`, design Decisions 4-7 of
 * isolate-watchdog-decisions-in-private-fork).
 *
 * The shared core owns the mechanism: one private /var/tmp directory with a
 * result file initialized to `{}`, one child created through the private
 * runtime's full fork, up to two inquiries in that same child (initial plus
 * at most one review-challenged reconsideration), each bounded to
 * DECISION_INVALID_ATTEMPT_LIMIT settled responses, with setup, file,
 * provider, cancelled and stale outcomes as typed failures.
 *
 * This adapter supplies only Continue policy: the continue/unlock decision
 * validator, the unlock-only semantic review gate, Continue's published
 * <watchdog_result_file> / decision.json naming, and its disabled child
 * auto-retry. No cw/structured_output instructions are involved; the file is
 * the only result transport.
 */

/** Marker element appended to every prompt carrying the actual result path. */
export const WATCHDOG_RESULT_FILE_TAG = "watchdog_result_file";

/** /var/tmp on POSIX (disk-backed); Windows has none, so its temp dir. */
export const RESULT_DIR_PREFIX = join(
	process.platform === "win32" ? tmpdir() : "/var/tmp",
	"watchdog-decision-",
);

/** Safe per-response observation handed to the optional audit callback. */
export type PrivateDecisionObservation =
	PrivateInquiryObservation<ValidDecision>;

/** Content-free display observation; result attempts are not transport retries. */
export interface PrivateDecisionProgress {
	readonly stage: "waiting for model" | "validating" | "correcting";
	readonly inquiry: "initial" | "reconsideration";
	readonly attempt: number;
	readonly limit: number;
}

/** Terminal result of one logical private decision. */
export type PrivateDecisionResult = PrivateInquiryResult<ValidDecision>;

export interface PrivateDecisionOptions {
	readonly runtime: PrivateRuntime;
	/** Fork input minus host-owned agentDir/resultFile/retry policy. */
	readonly fork: Omit<
		PrivateForkInput,
		"agentDir" | "resultFile" | "retryPolicy"
	>;
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
	/** Optional human-only observation. Failure cannot affect execution. */
	readonly onProgress?: (progress: PrivateDecisionProgress) => void;
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

/**
 * Run one bounded logical private decision. See the module header and the
 * watchdog-private-fork-decisions spec for the full contract.
 */
export function runPrivateDecision(
	options: PrivateDecisionOptions,
): Promise<PrivateDecisionResult> {
	const {
		reasonTypes,
		continueReasonTypes,
		review,
		fork,
		runtime,
		onProgress,
		onStarted,
		correction,
		...rest
	} = options;
	let inquiry: PrivateDecisionProgress["inquiry"] = "initial";
	let attempt = 1;
	const observe = (stage: PrivateDecisionProgress["stage"]): void => {
		try {
			onProgress?.({
				stage,
				inquiry,
				attempt,
				limit: DECISION_INVALID_ATTEMPT_LIMIT,
			});
		} catch {
			// Display failure never changes validation, requests or accounting.
		}
	};
	const observedRuntime: PrivateRuntime =
		onProgress === undefined
			? runtime
			: {
					async fork(input) {
						const child = await runtime.fork(input);
						return {
							get sessionId() {
								return child.sessionId;
							},
							get sessionFile() {
								return child.sessionFile;
							},
							get modelId() {
								return child.modelId;
							},
							get messages() {
								return child.messages;
							},
							get inheritedProvider() {
								return child.inheritedProvider;
							},
							get attemptError() {
								return child.attemptError;
							},
							get helperCalls() {
								return child.helperCalls;
							},
							async prompt(text) {
								observe("waiting for model");
								const startIndex = child.messages.length;
								await child.prompt(text);
								try {
									const response = child.messages
										.slice(startIndex)
										.findLast((message) => message.role === "assistant");
									if (
										response?.role === "assistant" &&
										response.stopReason !== "error" &&
										response.stopReason !== "aborted"
									) {
										observe("validating");
									}
								} catch {
									// The shared core remains the only authority on terminal outcomes.
								}
							},
							abort: () => child.abort(),
							dispose: () => child.dispose(),
							subscribe: (listener) => child.subscribe(listener),
						};
					},
					dispose: () => runtime.dispose(),
				};
	return runPrivateInquiry<ValidDecision>({
		...rest,
		runtime: observedRuntime,
		onStarted: (event) => {
			inquiry = event.inquiry;
			attempt = 1;
			// Unlike progress, a throwing onStarted must still prevent the prompt.
			onStarted?.(event);
		},
		correction: (error, file) => {
			const text = correction(error, file);
			attempt += 1;
			observe("correcting");
			return text;
		},
		// Continue disables the child's native auto-retry: a provider error is
		// one typed execution failure, never a silent retry.
		fork: { ...fork, retryPolicy: "disabled" },
		invalidAttemptLimit: DECISION_INVALID_ATTEMPT_LIMIT,
		naming: {
			tag: WATCHDOG_RESULT_FILE_TAG,
			fileName: "decision.json",
			dirPrefix: RESULT_DIR_PREFIX,
		},
		validate: (payload) => {
			const validation = validateDecisionArguments(
				payload,
				reasonTypes,
				continueReasonTypes,
			);
			return validation.valid
				? { valid: true, value: validation.decision }
				: { valid: false, error: validation.error };
		},
		// Review is unlock-only Continue policy; continue is never reviewed.
		...(review === undefined
			? {}
			: {
					review: (decision: ValidDecision) =>
						decision.kind === "unlock"
							? review(decision)
							: Promise.resolve(undefined),
				}),
	});
}
