/**
 * Optional AI-unlock review projection and shared-service adapter (pure half).
 *
 * Two independent pieces live here; runtime orchestration stays in
 * `src/runtime.ts`:
 *
 * - `buildUnlockReviewProjection` projects the session's compaction-aware
 *   effective entries into the complete permitted macro snapshot of D2/D3:
 *   public user/assistant/summary/custom text in full, tool activity as
 *   name/call/status envelopes and ask_user_question public reply text. No
 *   excerpt bound, last-N suffix, cropping, or prior-opinion substitution.
 * - `buildUnlockReviewRequest` / `runUnlockReview` wrap the vendored
 *   version-two client: one stable Choice question through `judge()`, no
 *   consumer outer timer, no auto-install or fallback.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

import {
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_MESSAGE_TYPE,
	decisionDetails,
	foldDecisionContext,
	parseDecisionFoldDetails,
} from "./context-fold.js";
import {
	getJudgmentService,
	type JsonObject,
	type JudgeRequest,
	type JudgmentService,
} from "./judgment-client.js";

/** Bump when the macro projection layout or rubric identity changes. */
export const UNLOCK_REVIEW_PROJECTION_VERSION = 3;
/** Stable id of the single accepted review question. */
export const UNLOCK_REVIEW_QUESTION_ID = "unlock_supported";

/** Extension tool whose public reply text belongs in the macro snapshot. */
export const HUMAN_QUESTIONNAIRE_TOOL = "ask_user_question";

export type UnlockReviewRowKind =
	| "user"
	| "assistant"
	| "custom"
	| "summary"
	| "tool";

export interface UnlockReviewCandidate {
	readonly action: "unlock";
	readonly reasonType: string;
	readonly reason: string;
}

export interface UnlockReviewRow {
	readonly index: number;
	readonly kind: UnlockReviewRowKind;
	/** Native entry id of the row's source (provenance only). */
	readonly entryId: string;
	readonly text: string;
	/** Tool rows: associated tool name. */
	readonly toolName?: string;
	/** Tool rows: associated call identity when the host retained it. */
	readonly callId?: string;
	/** Unique prior permitted native call source; absent when association is unavailable. */
	readonly callEntryId?: string;
	/** Public custom producer label, not a user-role or authority claim. */
	readonly customType?: string;
	/** Native summary origin; both kinds remain derived material. */
	readonly summaryType?: "compaction" | "branch";
	/** Tool rows: observed status; `unknown` when the host kept no verdict. */
	readonly status?: "returned" | "error" | "cancelled" | "pending" | "unknown";
}

export interface UnlockReviewGap {
	readonly entryId: string;
	readonly reason: "unsupported-content";
}

export interface UnlockReviewProjection {
	readonly projectionVersion: typeof UNLOCK_REVIEW_PROJECTION_VERSION;
	readonly rows: readonly UnlockReviewRow[];
	readonly gaps: readonly UnlockReviewGap[];
	/** Effective-context head row id; null when no rows were projected. */
	readonly sourceHeadId: string | null;
	readonly compactionBoundaryId: string | null;
}

interface WireLike {
	readonly role?: unknown;
	readonly customType?: unknown;
	readonly toolCallId?: unknown;
	readonly toolName?: unknown;
	readonly isError?: unknown;
	readonly content?: unknown;
	readonly summary?: unknown;
	readonly details?: unknown;
	readonly [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectLoose(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			isObjectLoose(block) &&
			block.type === "text" &&
			typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n");
}

/** True when the content carries non-text blocks (e.g. images) we cannot export. */
function hasUnsupportedContent(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some(
		(block) =>
			isObjectLoose(block) &&
			typeof block.type === "string" &&
			block.type !== "text",
	);
}

function toolCalls(wire: WireLike): { id: string; name: string }[] {
	if (wire.role !== "assistant" || !Array.isArray(wire.content)) return [];
	return wire.content.flatMap((block) =>
		isObject(block) &&
		block.type === "toolCall" &&
		typeof block.id === "string" &&
		block.id.length > 0 &&
		typeof block.name === "string" &&
		block.name.length > 0
			? [{ id: block.id, name: block.name }]
			: [],
	);
}

/**
 * Build the complete permitted macro snapshot from the session's effective
 * (compaction-aware) context entries.
 *
 * The caller supplies `manager.buildContextEntries()` output — the exact
 * entries the host retained for the current leaf — so pre-compaction raw
 * material and sibling branches never enter the snapshot. Owned decision
 * traffic is removed by folding a wire copy through `foldDecisionContext`
 * plus the same correlation-metadata rule as the bounded source view.
 *
 * Assistant content keeps only visible text: thinking blocks and other
 * non-text payloads are never exported. Ordinary tools stay envelopes;
 * ask_user_question retains public question/answer text as a tool reply.
 * Unsupported public content is a `gaps` entry, never silently shortened.
 */
export function buildUnlockReviewProjection(
	contextEntries: readonly SessionEntry[],
): UnlockReviewProjection {
	const pairs: Array<{ entry: SessionEntry; wire: WireLike }> = [];
	for (const entry of contextEntries) {
		for (const wire of sessionEntryToContextMessages(entry)) {
			// Reuse the host exclusion boundary before deriving rows, IDs or call indexes.
			if (convertToLlm([wire]).length === 0) continue;
			pairs.push({ entry, wire: wire as unknown as WireLike });
		}
	}
	const wires = pairs.map((pair) => pair.wire as object);
	const foldedSet = new Set(foldDecisionContext([...wires]));

	const ownedCustomWire = (wire: WireLike): boolean => {
		if (wire.role === "custom") {
			if (wire.customType === DECISION_MESSAGE_TYPE)
				return decisionDetails(wire.details) !== undefined;
			if (wire.customType === DECISION_FOLD_MESSAGE_TYPE)
				return parseDecisionFoldDetails(wire.details) !== undefined;
		}
		return (
			wire.role === "assistant" &&
			isObject(wire.details) &&
			decisionDetails(wire.details.piInquiry) !== undefined
		);
	};

	const ownedCallIds = new Set(
		pairs
			.filter(({ wire }) => !foldedSet.has(wire) || ownedCustomWire(wire))
			.flatMap(({ wire }) => toolCalls(wire).map((call) => call.id)),
	);
	const permitted = pairs.filter(
		({ wire }) =>
			foldedSet.has(wire) &&
			!ownedCustomWire(wire) &&
			!(
				wire.role === "toolResult" &&
				typeof wire.toolCallId === "string" &&
				ownedCallIds.has(wire.toolCallId)
			),
	);
	const compactionBoundaryId =
		permitted.findLast(({ entry }) => entry.type === "compaction")?.entry.id ??
		null;
	const callCounts = new Map<string, number>();
	for (const { wire } of permitted)
		for (const call of toolCalls(wire))
			callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
	const priorCalls = new Map<string, { entryId: string; name: string }>();
	const resultIds = new Set<string>();

	const rows: UnlockReviewRow[] = [];
	const gaps: UnlockReviewGap[] = [];
	const push = (row: Omit<UnlockReviewRow, "index">): void => {
		rows.push({ ...row, index: rows.length });
	};

	for (const pair of permitted) {
		const wire = pair.wire;
		const entryId = pair.entry.id;
		switch (wire.role) {
			case "user": {
				const text = textOfContent(wire.content);
				if (text.length > 0) push({ kind: "user", entryId, text });
				if (hasUnsupportedContent(wire.content))
					gaps.push({ entryId, reason: "unsupported-content" });
				break;
			}
			case "assistant": {
				const text = textOfContent(wire.content);
				if (text.length > 0) push({ kind: "assistant", entryId, text });
				for (const call of toolCalls(wire)) {
					priorCalls.set(call.id, { entryId, name: call.name });
					push({
						kind: "tool",
						entryId,
						text: "",
						toolName: call.name,
						callId: call.id,
						status: "pending",
					});
				}
				break;
			}
			case "custom": {
				const text = textOfContent(wire.content);
				if (text.length > 0)
					push({
						kind: "custom",
						entryId,
						text,
						...(typeof wire.customType === "string"
							? { customType: wire.customType }
							: {}),
					});
				if (hasUnsupportedContent(wire.content))
					gaps.push({ entryId, reason: "unsupported-content" });
				break;
			}
			case "compactionSummary":
			case "branchSummary": {
				const text = typeof wire.summary === "string" ? wire.summary : "";
				if (text.length > 0)
					push({
						kind: "summary",
						entryId,
						text,
						summaryType:
							wire.role === "compactionSummary" ? "compaction" : "branch",
					});
				break;
			}
			case "bashExecution":
				// Host flags report activity, never completion or permission.
				push({
					kind: "tool",
					entryId,
					toolName: "bash",
					status:
						wire.cancelled === true
							? "cancelled"
							: typeof wire.exitCode === "number" &&
									Number.isFinite(wire.exitCode)
								? wire.exitCode === 0
									? "returned"
									: "error"
								: "unknown",
					text: "",
				});
				break;
			case "toolResult": {
				const toolName =
					typeof wire.toolName === "string" ? wire.toolName : "tool";
				const callId =
					typeof wire.toolCallId === "string" ? wire.toolCallId : undefined;
				const prior = callId === undefined ? undefined : priorCalls.get(callId);
				const associated =
					callId !== undefined &&
					callCounts.get(callId) === 1 &&
					prior?.name === toolName &&
					!resultIds.has(callId)
						? prior
						: undefined;
				if (callId !== undefined) resultIds.add(callId);
				const questionnaire = toolName === HUMAN_QUESTIONNAIRE_TOOL;
				const cancelled =
					questionnaire &&
					isObject(wire.details) &&
					wire.details.cancelled === true;
				const answers =
					questionnaire &&
					isObject(wire.details) &&
					Array.isArray(wire.details.answers)
						? wire.details.answers.flatMap((answer) =>
								isObject(answer) &&
								typeof answer.question === "string" &&
								typeof answer.answer === "string"
									? [`Question: ${answer.question}\nAnswer: ${answer.answer}`]
									: [],
							)
						: [];
				push({
					kind: "tool",
					entryId,
					toolName,
					text:
						questionnaire && wire.isError !== true && !cancelled
							? answers.join("\n\n") || textOfContent(wire.content)
							: "",
					...(callId === undefined ? {} : { callId }),
					...(associated === undefined
						? {}
						: { callEntryId: associated.entryId }),
					status:
						wire.isError === true
							? "error"
							: cancelled
								? "cancelled"
								: wire.isError === false
									? "returned"
									: "unknown",
				});
				break;
			}
			default:
				break;
		}
	}

	const sourceHeadId =
		rows.length === 0 ? null : (rows.at(-1)?.entryId ?? null);
	return {
		projectionVersion: UNLOCK_REVIEW_PROJECTION_VERSION,
		rows,
		gaps,
		sourceHeadId,
		compactionBoundaryId,
	};
}

/** Keep every projected fact in indivisible fixed state, never splittable evidence. */
export function buildUnlockReviewRequest(
	projection: UnlockReviewProjection,
	candidate: UnlockReviewCandidate,
): JudgeRequest {
	const state: JsonObject = {
		projectionVersion: projection.projectionVersion,
		rubric:
			"Decide whether the labelled candidate decision to stop automatic " +
			"work on the stated basis is supported by the supplied macro " +
			"snapshot. The candidate is a claim, not delivery evidence or user " +
			"permission. Assistant reports are reported facts, not verified " +
			"execution; summaries are derived material; tool envelopes report " +
			"status only, not completion or approval; ask_user_question replies " +
			"are public question/answer text from that extension tool. supported: the stated " +
			"stopping basis is affirmatively supported. challenged: an " +
			"affirmative basis for questioning it exists, not merely missing " +
			"detail. insufficient_evidence: the supplied evidence cannot settle " +
			"the question.",
		candidate: {
			action: candidate.action,
			reasonType: candidate.reasonType,
			reason: candidate.reason,
		},
		gaps: projection.gaps.map((gap) => ({
			entryId: gap.entryId,
			reason: gap.reason,
		})),
		macroSnapshot: {
			sourceHeadId: projection.sourceHeadId,
			compactionBoundaryId: projection.compactionBoundaryId,
			rows: projection.rows.map((row) => ({
				index: row.index,
				kind: row.kind,
				entryId: row.entryId,
				text: row.text,
				...(row.toolName === undefined ? {} : { toolName: row.toolName }),
				...(row.callId === undefined ? {} : { callId: row.callId }),
				...(row.callEntryId === undefined
					? {}
					: { callEntryId: row.callEntryId }),
				...(row.customType === undefined ? {} : { customType: row.customType }),
				...(row.summaryType === undefined
					? {}
					: { summaryType: row.summaryType }),
				...(row.status === undefined ? {} : { status: row.status }),
			})),
		},
	};
	return {
		state,
		questions: {
			[UNLOCK_REVIEW_QUESTION_ID]: {
				type: "choice",
				instructions:
					"Assess the candidate unlock decision against the complete fixed " +
					"macroSnapshot and gaps. Answer supported only when the stated " +
					"stopping basis is affirmatively supported; challenged only " +
					"with an affirmative basis for questioning it; otherwise " +
					"insufficient_evidence. Do not treat absence from a partial " +
					"input as absence in the session.",
				criteria: {
					supported:
						"The candidate's stated stopping basis is affirmatively supported by the evidence.",
					challenged:
						"There is an affirmative basis for questioning the candidate's stated stopping basis.",
					insufficient_evidence:
						"The supplied evidence cannot settle whether the stopping basis holds.",
				},
			},
		},
	};
}

export type UnlockReviewIncompleteReason =
	| "unavailable"
	| "incompatible"
	| "error"
	| "aborted"
	| "insufficient-evidence"
	| "malformed";

export type UnlockReviewOutcome =
	| { readonly kind: "supported" }
	| { readonly kind: "challenged" }
	| {
			readonly kind: "incomplete";
			readonly reason: UnlockReviewIncompleteReason;
	  };

export interface UnlockReviewReport {
	readonly outcome: UnlockReviewOutcome;
	/** Selected backend/model when the service reported them. */
	readonly backend?: string;
	readonly model?: string;
	/**
	 * Backend-reported usage for the terminal attempt only, forwarded
	 * verbatim. Absent stays absent: it is never a complete-operation charge
	 * and never reported as zero.
	 */
	readonly usage?: JudgeUsage;
	readonly errorMessage?: string;
	readonly contextOverflow?: boolean;
}

/** The version-two members the watchdog consumes, structural not nominal. */
export type ReviewServiceLike = Pick<JudgmentService, "judge">;

/**
 * Call-time discovery of the already-loaded version-two judgment service. No
 * availability probe, no install, no HTTP or model fallback: absence and
 * version mismatch are returned, never thrown.
 */
export function discoverUnlockReviewService():
	| { readonly status: "available"; readonly service: JudgmentService }
	| { readonly status: "unavailable" | "incompatible" } {
	let candidate: ReturnType<typeof getJudgmentService>;
	try {
		candidate = getJudgmentService();
	} catch {
		return { status: "unavailable" };
	}
	if (candidate === undefined) return { status: "unavailable" };
	if (
		candidate.version === 2 &&
		typeof (candidate as Partial<JudgmentService>).judge === "function"
	) {
		return { status: "available", service: candidate };
	}
	return { status: "incompatible" };
}

/** Terminal-attempt backend usage totals reported by the service. */
export interface JudgeUsage {
	readonly input: number;
	readonly output: number;
	readonly totalTokens: number;
	readonly costTotal: number;
}

/**
 * Forwarded backend usage, kept under its own scope. Anything that is not a
 * well-formed usage object stays absent rather than becoming zero or
 * malformed.
 */
function scopedUsage(value: unknown): JudgeUsage | undefined {
	if (!isObject(value)) return undefined;
	const { input, output, totalTokens, cost } = value;
	if (
		typeof input !== "number" ||
		!Number.isFinite(input) ||
		typeof output !== "number" ||
		!Number.isFinite(output) ||
		typeof totalTokens !== "number" ||
		!Number.isFinite(totalTokens) ||
		!isObject(cost) ||
		typeof cost.total !== "number" ||
		!Number.isFinite(cost.total)
	)
		return undefined;
	return { input, output, totalTokens, costTotal: cost.total };
}

function diagnosticsOf(
	result: Record<string, unknown>,
): Partial<UnlockReviewReport> {
	const usage = scopedUsage(result.usage);
	return {
		...(typeof result.backend === "string" ? { backend: result.backend } : {}),
		...(typeof result.model === "string" ? { model: result.model } : {}),
		...(usage === undefined ? {} : { usage }),
		...(typeof result.errorMessage === "string"
			? { errorMessage: result.errorMessage }
			: {}),
		...(result.contextOverflow === true ? { contextOverflow: true } : {}),
	};
}

function incomplete(
	reason: UnlockReviewIncompleteReason,
	result?: unknown,
): UnlockReviewReport {
	return {
		outcome: { kind: "incomplete", reason },
		...(isObject(result) ? diagnosticsOf(result) : {}),
	};
}

/** One business call; strict final-answer acceptance, guarded decode. */
export async function runUnlockReview(
	service: ReviewServiceLike,
	request: JudgeRequest,
	signal: AbortSignal,
): Promise<UnlockReviewReport> {
	try {
		if (Array.isArray(request.state.gaps) && request.state.gaps.length > 0)
			return incomplete(signal.aborted ? "aborted" : "insufficient-evidence");
		const result: unknown = await service.judge(request, { signal });
		if (signal.aborted) return incomplete("aborted", result);
		if (!isObject(result)) return incomplete("malformed");
		if (result.stopReason === "aborted") return incomplete("aborted", result);
		if (result.stopReason === "error" || result.contextOverflow === true)
			return incomplete("error", result);
		if (result.stopReason !== "stop") return incomplete("malformed", result);
		// A dropped required id is an explicit decline, never a challenge.
		if (!Array.isArray(result.dropped)) return incomplete("malformed", result);
		for (const id of result.dropped) {
			if (typeof id !== "string") return incomplete("malformed", result);
		}
		if (result.dropped.includes(UNLOCK_REVIEW_QUESTION_ID))
			return incomplete("insufficient-evidence", result);
		if (
			!isObject(result.answers) ||
			!Object.hasOwn(result.answers, UNLOCK_REVIEW_QUESTION_ID)
		)
			return incomplete("malformed", result);
		const answer = result.answers[UNLOCK_REVIEW_QUESTION_ID];
		if (!isObject(answer) || answer.type !== "choice")
			return incomplete("malformed", result);
		if (answer.choice === "supported" || answer.choice === "challenged") {
			return { outcome: { kind: answer.choice }, ...diagnosticsOf(result) };
		}
		if (answer.choice === "insufficient_evidence")
			return incomplete("insufficient-evidence", result);
		return incomplete("malformed", result);
	} catch (error) {
		let errorMessage = "Unlock review failed.";
		try {
			if (error instanceof Error && typeof error.message === "string")
				errorMessage = error.message;
		} catch {
			/* Malformed thrown values cannot escape this boundary. */
		}
		return { outcome: { kind: "incomplete", reason: "error" }, errorMessage };
	}
}
