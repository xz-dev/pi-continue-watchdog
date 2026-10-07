import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

import { AI_UNLOCK_ENTRY_TYPE } from "./commands.js";
import { hasAtMostUnicodeCodePoints } from "./config.js";
import {
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_MESSAGE_TYPE,
	decisionCorrelationKey,
	decisionDetails,
	foldDecisionContext,
	INQUIRY_MARKER_ENTRY_TYPE,
	markerDetails,
	parseDecisionFoldDetails,
} from "./context-fold.js";

/**
 * Bounded source-aware review context (pure half).
 *
 * Two independent pieces live here; runtime orchestration stays in
 * `src/runtime.ts`:
 *
 * - `buildReviewSourceView` projects the session's compaction-aware effective
 *   entries into a small labelled evidence view. It never replaces or
 *   reorders the underlying native conversation and performs no semantic
 *   completion judgement.
 * - `readReviewHistory` reconstructs observed-vs-published review history by
 *   correlating the existing inquiry marker / inquiry prompt / neutralized
 *   decision assistant / decision audit / fold / quiet-unlock records on the
 *   host-selected active ancestry. It restores no execution authority.
 *
 * Provenance is trusted by record type plus exact exchange correlation — the
 * same ownership rules as `context-fold.ts` / `summary-projection.ts` —
 * never by body text or stopReason heuristics.
 */

/** Bump when the projected row model or bounds change. */
export const REVIEW_PROJECTION_VERSION = 1;
/** Ceiling for the whole rendered supplemental view, in Unicode code points. */
export const REVIEW_VIEW_MAX_CODE_POINTS = 8000;
/** Per-row excerpt bound, in Unicode code points, with head/tail omission. */
export const REVIEW_EXCERPT_MAX_CODE_POINTS = 1600;

export type ReviewSourceProvenance =
	| "user"
	| "assistant"
	| "tool-result"
	| "bash-execution"
	| "compaction-summary"
	| "branch-summary"
	| "automation";

interface WireLike {
	readonly role?: unknown;
	readonly customType?: unknown;
	readonly content?: unknown;
	readonly summary?: unknown;
	readonly command?: unknown;
	readonly output?: unknown;
	readonly details?: unknown;
	readonly [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectLoose(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function codePointCount(value: string): number {
	let count = 0;
	for (let index = 0; index < value.length; count += 1) {
		const first = value.charCodeAt(index);
		const second = value.charCodeAt(index + 1);
		index +=
			first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
				? 2
				: 1;
	}
	return count;
}

/**
 * Head+tail excerpt: split on code-point boundaries so the rendered excerpt,
 * including the elision marker, stays within REVIEW_EXCERPT_MAX_CODE_POINTS.
 * The marker length counts against the bound; whatever budget remains is
 * split between head and tail so the stated omission count stays exact.
 */
function excerptText(text: string): {
	readonly text: string;
	readonly omitted: boolean;
} {
	const units = Array.from(text);
	if (units.length <= REVIEW_EXCERPT_MAX_CODE_POINTS) {
		return { text, omitted: false };
	}
	const markerFor = (omitted: number): string =>
		`[…${omitted} code points omitted…]`;
	// Largest kept total so kept + marker(units.length - kept) <= bound.
	let keep = 0;
	for (
		let candidate = REVIEW_EXCERPT_MAX_CODE_POINTS;
		candidate >= 0;
		candidate -= 1
	) {
		if (
			candidate + Array.from(markerFor(units.length - candidate)).length <=
			REVIEW_EXCERPT_MAX_CODE_POINTS
		) {
			keep = candidate;
			break;
		}
	}
	const headKeep = Math.ceil(keep / 2);
	const tailKeep = keep - headKeep;
	const omitted = units.length - keep;
	return {
		text: `${units.slice(0, headKeep).join("")}${markerFor(omitted)}${units.slice(units.length - tailKeep).join("")}`,
		omitted: true,
	};
}

/** Flatten visible text of a user/tool/custom content value. */
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

function assistantText(message: WireLike): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap((block) =>
			isObjectLoose(block) &&
			block.type === "text" &&
			typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n");
}

/** The wire roles this view classifies; other roles produce no row. */
function classifyWire(wire: WireLike): {
	readonly provenance: ReviewSourceProvenance;
	readonly text: string;
} | null {
	switch (wire.role) {
		case "user":
			return { provenance: "user", text: textOfContent(wire.content) };
		case "assistant":
			return { provenance: "assistant", text: assistantText(wire) };
		case "toolResult": {
			const tool = typeof wire.toolName === "string" ? wire.toolName : "tool";
			const error =
				isObjectLoose(wire) && wire.isError === true ? " (error)" : "";
			return {
				provenance: "tool-result",
				text: `[${tool}${error}]\n${textOfContent(wire.content)}`,
			};
		}
		case "bashExecution": {
			// Reuse Pi's exclusion boundary and cancellation/exit/truncation text.
			const [message] = convertToLlm([
				wire as unknown as ReturnType<
					typeof sessionEntryToContextMessages
				>[number],
			]);
			return message === undefined
				? null
				: {
						provenance: "bash-execution",
						text: textOfContent(message.content),
					};
		}
		case "compactionSummary":
			return {
				provenance: "compaction-summary",
				text: typeof wire.summary === "string" ? wire.summary : "",
			};
		case "branchSummary":
			return {
				provenance: "branch-summary",
				text: typeof wire.summary === "string" ? wire.summary : "",
			};
		case "custom":
			return {
				provenance: "automation",
				text: textOfContent(wire.content),
			};
		default:
			return null;
	}
}

export interface ReviewSourceRow {
	/** Native entry id of the row's source (non-label; survives fork). */
	readonly entryId: string;
	readonly provenance: ReviewSourceProvenance;
	readonly excerpt: string;
	/** True when the excerpt elided an infix of the source text. */
	readonly excerptOmitted: boolean;
	/** Full source text length in code points, before excerpting. */
	readonly excerptCodePoints: number;
	/** Position within the projected evidence rows (source order). */
	readonly index: number;
	/** Present in the rendered view; omitted rows carry source details only. */
	readonly selected: boolean;
}

export interface ReviewSourceView {
	readonly projectionVersion: typeof REVIEW_PROJECTION_VERSION;
	/** Model-facing view text, within REVIEW_VIEW_MAX_CODE_POINTS. */
	readonly text: string;
	/** All eligible rows in source order, selected or not. */
	readonly rows: readonly ReviewSourceRow[];
	/** Rows rendered in `text`, in source order. */
	readonly selected: readonly ReviewSourceRow[];
	/** Counts of rows omitted under the deterministic budget. */
	readonly omitted: {
		readonly byProvenance: Readonly<Record<string, number>>;
		readonly total: number;
	};
	/**
	 * Deterministic digest over the view's row id/provenance/excerpt tuples;
	 * a projection identity for diagnostics, never an execution authority.
	 */
	readonly digest: string;
	/**
	 * id of the newest effective context entry used as source input — the
	 * non-label head reference recorded for later correlation.
	 */
	readonly sourceHeadId: string | null;
	/** Latest compaction id on the effective context path, if any. */
	readonly compactionBoundaryId: string | null;
}

function renderRow(row: ReviewSourceRow): string {
	const trimmed = row.excerpt.trimEnd();
	return `[${row.index}] ${row.provenance} ${row.entryId}${row.excerptOmitted ? " (excerpt shortened)" : ""}\n${trimmed}`;
}

const DIGEST_BASIS = 0x811c9dc5;

/** Deterministic non-cryptographic projection identity over selected rows. */
function reviewDigest(rows: readonly ReviewSourceRow[]): string {
	let hash = DIGEST_BASIS;
	for (const row of rows) {
		const key = `${row.entryId}${row.provenance}${row.excerpt}`;
		for (let index = 0; index < key.length; index += 1) {
			hash ^= key.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Build the bounded evidence view from the session's effective
 * (compaction-aware) context entries.
 *
 * The caller supplies `manager.buildContextEntries()` output — the exact
 * entries the host itself retained for the current leaf — so pre-compaction
 * raw material never enters the new model-facing view. Owned decision traffic
 * (inquiry prompts, folds, neutralized assistants, cancelled-decision
 * messages) is removed by folding a wire copy through `foldDecisionContext`
 * and correlating each surviving wire object back to its source entry.
 */
export function buildReviewSourceView(
	contextEntries: readonly SessionEntry[],
): ReviewSourceView {
	const compactionBoundaryId = (() => {
		for (let index = contextEntries.length - 1; index >= 0; index -= 1) {
			const entry = contextEntries[index];
			if (entry !== undefined && entry.type === "compaction") return entry.id;
		}
		return null;
	})();

	const pairs: Array<{ entry: SessionEntry; wire: WireLike }> = [];
	for (const entry of contextEntries) {
		for (const wire of sessionEntryToContextMessages(entry)) {
			pairs.push({ entry, wire: wire as unknown as WireLike });
		}
	}
	const wires = pairs.map((pair) => pair.wire as object);
	const foldedSet = new Set(foldDecisionContext([...wires]));

	// Owned inquiry traffic: fold removes completed exchanges; an in-flight or
	// malformed prompt that the folder left behind is still owned control by
	// correlation metadata, never automation evidence for a new inquiry. The
	// same applies to a neutralized owned assistant carrying piInquiry details.
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

	// Eligible projected rows, in source order. Empty or unclassifiable wires
	// contribute no row rather than a labelled blank.
	const rows: ReviewSourceRow[] = [];
	for (const pair of pairs) {
		if (!foldedSet.has(pair.wire) || ownedCustomWire(pair.wire)) continue;
		const classified = classifyWire(pair.wire);
		if (classified === null) continue;
		const { text, omitted } = excerptText(classified.text);
		rows.push({
			entryId: pair.entry.id,
			provenance: classified.provenance,
			excerpt: text,
			excerptOmitted: omitted,
			excerptCodePoints: codePointCount(classified.text),
			index: rows.length,
			selected: false,
		});
	}

	// Rows into selection pools: latest user, latest assistant, two newest
	// tool results/bash executions lead per the design; everything else fills
	// remaining budget in recency order, rendered back in source order.
	const isToolEvidence = (row: ReviewSourceRow): boolean =>
		row.provenance === "tool-result" || row.provenance === "bash-execution";
	const newestOf = (
		predicate: (row: ReviewSourceRow) => boolean,
		count: number,
	): ReviewSourceRow[] => {
		const out: ReviewSourceRow[] = [];
		for (
			let index = rows.length - 1;
			index >= 0 && out.length < count;
			index -= 1
		) {
			const row = rows[index];
			if (row !== undefined && predicate(row)) out.push(row);
		}
		return out;
	};
	const lead: ReviewSourceRow[] = [
		...newestOf((row) => row.provenance === "user", 1),
		...newestOf((row) => row.provenance === "assistant", 1),
		...newestOf(isToolEvidence, 2),
	];
	const leadSet = new Set(lead);
	// The lead evidence is followed by earlier requests/deliveries, then
	// derived summaries and finally automation opinions. Extra tool rows do
	// not displace the earlier human context reserved by this policy.
	const isOrdinary = (row: ReviewSourceRow): boolean =>
		row.provenance === "user" || row.provenance === "assistant";
	const remaining = rows.filter((row) => !leadSet.has(row)).reverse();
	const candidates = [
		...lead,
		...remaining.filter(isOrdinary),
		...remaining.filter((row) => row.provenance.endsWith("-summary")),
		...remaining.filter((row) => row.provenance === "automation"),
	];

	let head =
		"Source evidence (bounded excerpts; omissions are not proof of absence; earlier requests and deliveries remain in native context):\n";
	if (!hasAtMostUnicodeCodePoints(head, REVIEW_VIEW_MAX_CODE_POINTS)) {
		head = "";
	}
	const omissionNote =
		"\n[additional source rows omitted under the view budget]";
	const render = (sel: readonly ReviewSourceRow[], omitted: number): string =>
		head +
		sel.map(renderRow).join("\n\n") +
		(omitted > 0
			? `${omissionNote} (${omitted} row${omitted === 1 ? "" : "s"})`
			: "");

	// Greedy accept in priority order: a row that does not fit is skipped,
	// later candidates may still fit, and the rendered text — including the
	// full omission footer — stays within the ceiling.
	const selected: ReviewSourceRow[] = [];
	const renderSelected = (): string => {
		const sorted = [...selected].sort(
			(left, right) => left.index - right.index,
		);
		return render(sorted, rows.length - sorted.length);
	};
	for (const row of candidates) {
		selected.push({ ...row, selected: true });
		if (codePointCount(renderSelected()) > REVIEW_VIEW_MAX_CODE_POINTS) {
			selected.pop();
		}
	}
	selected.sort((left, right) => left.index - right.index);

	const selectedIds = new Set(selected.map((row) => row.index));
	const omittedRows = rows.filter((row) => !selectedIds.has(row.index));
	const byProvenance: Record<string, number> = {};
	for (const row of omittedRows) {
		byProvenance[row.provenance] = (byProvenance[row.provenance] ?? 0) + 1;
	}
	const text = renderSelected();
	const finalRows = rows.map((row) =>
		selectedIds.has(row.index) ? { ...row, selected: true } : row,
	);
	// Source head = newest entry that actually contributed a row, so a label
	// or other non-source tail entry never becomes the recorded identity.
	const sourceHeadId =
		rows.length === 0 ? null : (rows[rows.length - 1]?.entryId ?? null);
	return {
		projectionVersion: REVIEW_PROJECTION_VERSION,
		text,
		rows: finalRows,
		selected,
		omitted: { byProvenance, total: omittedRows.length },
		digest: reviewDigest(selected),
		sourceHeadId,
		compactionBoundaryId,
	};
}

/**
 * Versioned nested review metadata appended to the existing hidden inquiry
 * marker entry (`data.review`). Persisted through the ordinary marker append;
 * readers treat its absence (legacy markers) as unavailable history.
 */
export interface ReviewSourceMetadata {
	readonly version: 1;
	readonly projectionVersion: number;
	/** Effective-context head entry id at assembly (non-label). */
	readonly sourceHeadId: string | null;
	/** Latest compaction id within the effective context, if any. */
	readonly compactionBoundaryId: string | null;
	/** Provenance of each selected row, in source order. */
	readonly selectedSources: readonly {
		readonly id: string;
		readonly provenance: ReviewSourceProvenance;
	}[];
	/** Row digest of the rendered view. */
	readonly digest: string;
	/** Omitted row counts. */
	readonly omittedRows: number;
	readonly omittedByProvenance: Readonly<Record<string, number>>;
	/** Origin session id recorded as provenance only — never authority. */
	readonly originSessionId?: string;
	/** Session file name recorded as provenance only. */
	readonly originSessionFile?: string;
}

/** Build the nested marker review metadata for one assembled view. */
export function createReviewSourceMetadata(
	view: ReviewSourceView,
	origin: {
		readonly sessionId?: string;
		readonly sessionFile?: string;
	} = {},
): ReviewSourceMetadata {
	return {
		version: 1,
		projectionVersion: view.projectionVersion,
		sourceHeadId: view.sourceHeadId,
		compactionBoundaryId: view.compactionBoundaryId,
		selectedSources: view.selected.map((row) => ({
			id: row.entryId,
			provenance: row.provenance,
		})),
		digest: view.digest,
		omittedRows: view.omitted.total,
		omittedByProvenance: view.omitted.byProvenance,
		...(origin.sessionId === undefined
			? {}
			: { originSessionId: origin.sessionId }),
		...(origin.sessionFile === undefined
			? {}
			: { originSessionFile: origin.sessionFile }),
	};
}

/**
 * Nested review association appended to the existing hidden decision audit
 * entry (`data.review`). Identifies the observed exchange's persisted prompt
 * and marker records without duplicating their content.
 */
export interface ReviewAuditMetadata {
	readonly version: 1;
	/** Session entry id of the hidden inquiry marker for this attempt. */
	readonly markerEntryId?: string;
	/** Session entry id of the owned inquiry prompt for this attempt. */
	readonly promptEntryId?: string;
	/** id of the exchange's marker review metadata source-head, if recorded. */
	readonly sourceHeadId?: string;
	/** Digest recorded on the marker metadata, if recorded. */
	readonly sourceDigest?: string;
}

function markerData(entry: SessionEntry): Record<string, unknown> | undefined {
	if (entry.type !== "custom" || entry.customType !== INQUIRY_MARKER_ENTRY_TYPE)
		return undefined;
	return isObjectLoose(entry.data) ? entry.data : undefined;
}

/** Marker identity fields, independent of optional nested review metadata. */
function markerCorrelation(
	data: Record<string, unknown>,
): { exchangeId: string; cycleId: number } | undefined {
	return data.version === 1 ? markerDetails(data) : undefined;
}

/**
 * Nested `review` field on a marker or audit record. A present-but-invalid
 * shape is distinguished from an absent field so recovery can report it as
 * unknown rather than missing.
 */
function reviewField(
	data: Record<string, unknown>,
):
	| { readonly state: "absent" }
	| { readonly state: "unknown"; readonly value: unknown }
	| { readonly state: "ok"; readonly value: Record<string, unknown> } {
	if (!Object.hasOwn(data, "review")) return { state: "absent" };
	const value = data.review;
	if (!isObject(value)) return { state: "unknown", value };
	if (value.version !== 1) return { state: "unknown", value };
	return { state: "ok", value };
}

export type ReviewOutcomeKind =
	| "continue"
	| "unlock"
	| "decision-failed"
	| "invalidated"
	| "preempted";

export type ReviewRecordStatus =
	| "pending"
	| "responded"
	| "published"
	| "invalid-response";

export interface ReviewHistoryRecord {
	/** Correlation shared by all records of this attempt. */
	readonly exchangeId: string;
	readonly cycleId: number;
	/** Session entry id of the hidden inquiry marker. */
	readonly markerEntryId: string;
	/** Session entry id of the owned inquiry prompt, if found on ancestry. */
	readonly promptEntryId?: string;
	/** Session entry id of the owned (neutralized) assistant, if present. */
	readonly assistantEntryId?: string;
	/** Session entry id of the persisted decision audit, if appended. */
	readonly auditEntryId?: string;
	/** Session entry id of the correlated quiet AI-unlock status, if retained. */
	readonly unlockEntryId?: string;
	/** Session entry id of the cleanup/replacement fold, if appended. */
	readonly foldEntryId?: string;
	/** Observed fold outcome, even when quiet publication remains incomplete. */
	readonly foldOutcome?: ReviewOutcomeKind;
	/** Audit outcome — the observed response, never proof that work started. */
	readonly responseOutcome?: "continue" | "unlock" | "invalid";
	/** Published canonical outcome, after its required artifacts are retained. */
	readonly publishedOutcome?: ReviewOutcomeKind;
	/**
	 * Derived stage: marker without prompt/response is `pending`; a recorded
	 * audit is `responded` (or `invalid-response`); a correlated canonical
	 * publication makes it `published`. Quiet unlock requires both its remove
	 * fold and native status entry; the fold alone is only cleanup evidence.
	 */
	readonly status: ReviewRecordStatus;
	/**
	 * `none`: neither record carried review metadata (legacy exchange).
	 * `partial`: marker or audit carried it, but the other did not or could
	 * not be read. `unknown-version`: a nested review field was present but
	 * not understood. `ok`: understood review metadata present.
	 */
	readonly reviewMetadata: "none" | "partial" | "unknown-version" | "ok";
	/** Marker review metadata when present and understood. */
	readonly source?: ReviewSourceMetadata;
}

export interface ReviewHistory {
	/** Host-selected leaf used for this read (non-label). */
	readonly leafId: string | null;
	/** Origin session id provenance, when a session exists. */
	readonly sessionId?: string;
	/** Session file path provenance, when the session is persisted. */
	readonly sessionFile?: string;
	/** Reconstructed exchange records in ancestry order (oldest first). */
	readonly records: readonly ReviewHistoryRecord[];
	/** Set when the branch could not be read (e.g. no session / read failure). */
	readonly diagnostic?: string;
}

function auditOutcome(
	data: Record<string, unknown>,
): "continue" | "unlock" | "invalid" | undefined {
	if (data.version !== 1) return undefined;
	if (
		data.outcome === "continue" ||
		data.outcome === "unlock" ||
		data.outcome === "invalid"
	) {
		return data.outcome;
	}
	return undefined;
}

const DECISION_AUDIT_ENTRY_TYPE = "pi-continue-watchdog:decision-audit";

/**
 * Minimal session-manager surface the reader needs. `ExtensionContext`'s
 * `sessionManager` (the public ReadonlySessionManager pick) satisfies it.
 */
export interface ReviewHistorySource {
	getBranch(): SessionEntry[];
	getSessionId?(): string;
	getSessionFile?(): string | undefined;
	getLeafId?(): string | null;
}

/**
 * Reconstruct review history from the active ancestry of `manager`.
 *
 * Reads `getBranch()` once; a record on a sibling path is never eligible.
 * Correlation is the exact exchange/attempt identity on marker, prompt,
 * assistant (via its neutralizing `details.piInquiry`), audit, and fold
 * records — no timestamp or file-order inference.
 */
export function readReviewHistory(manager: ReviewHistorySource): ReviewHistory {
	let branch: SessionEntry[];
	try {
		branch = manager.getBranch();
	} catch (error) {
		return {
			leafId: null,
			records: [],
			diagnostic: `session branch read failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const leafId =
		typeof manager.getLeafId === "function" ? manager.getLeafId() : null;
	const sessionId =
		typeof manager.getSessionId === "function"
			? manager.getSessionId()
			: undefined;
	const sessionFile =
		typeof manager.getSessionFile === "function"
			? manager.getSessionFile()
			: undefined;
	const diagnostics: string[] = [];

	interface Accum {
		exchangeId: string;
		cycleId: number;
		markerEntryId: string;
		markerData: Record<string, unknown>;
		promptEntryId?: string;
		assistantEntryId?: string;
		auditEntryId?: string;
		auditData?: Record<string, unknown>;
		unlockEntryId?: string;
		foldEntryId?: string;
		foldOutcome?: ReviewOutcomeKind;
		quietUnlock?: boolean;
	}
	const byKey = new Map<string, Accum>();
	const order: Accum[] = [];
	const key = (exchangeId: string, cycleId: number) =>
		decisionCorrelationKey({ inquiryId: exchangeId, attempt: cycleId });

	for (const entry of branch) {
		if (entry.type === "custom") {
			if (entry.customType === AI_UNLOCK_ENTRY_TYPE && isObject(entry.data)) {
				// Quiet records have no version field; reuse exact native identity
				// parsing and require the normalized reason carried by this artifact.
				const correlation = markerDetails(entry.data);
				if (
					correlation !== undefined &&
					typeof entry.data.reasonType === "string" &&
					entry.data.reasonType.length > 0 &&
					typeof entry.data.reason === "string" &&
					entry.data.reason.length > 0
				) {
					const accum = byKey.get(
						key(correlation.exchangeId, correlation.cycleId),
					);
					if (accum !== undefined && accum.unlockEntryId === undefined)
						accum.unlockEntryId = entry.id;
				}
				continue;
			}
			if (entry.customType === INQUIRY_MARKER_ENTRY_TYPE) {
				const data = markerData(entry);
				if (data === undefined) continue;
				const correlation = markerCorrelation(data);
				if (correlation === undefined) continue;
				const k = key(correlation.exchangeId, correlation.cycleId);
				let accum = byKey.get(k);
				if (accum === undefined) {
					accum = {
						exchangeId: correlation.exchangeId,
						cycleId: correlation.cycleId,
						markerEntryId: entry.id,
						markerData: data,
					};
					byKey.set(k, accum);
					order.push(accum);
				}
				continue;
			}
			if (
				entry.customType === DECISION_AUDIT_ENTRY_TYPE &&
				isObjectLoose(entry.data)
			) {
				const correlation = markerCorrelation(entry.data);
				if (correlation === undefined) continue;
				const accum = byKey.get(
					key(correlation.exchangeId, correlation.cycleId),
				);
				if (accum === undefined) continue; // audit without marker on ancestry
				if (accum.auditEntryId === undefined) {
					accum.auditEntryId = entry.id;
					accum.auditData = entry.data;
				}
			}
			continue;
		}
		if (entry.type === "custom_message") {
			if (entry.customType === DECISION_MESSAGE_TYPE) {
				const details = decisionDetails(entry.details);
				if (details === undefined) continue;
				const accum = byKey.get(key(details.inquiryId, details.attempt));
				if (accum !== undefined && accum.promptEntryId === undefined) {
					accum.promptEntryId = entry.id;
				}
				continue;
			}
			if (entry.customType === DECISION_FOLD_MESSAGE_TYPE) {
				const fold = parseDecisionFoldDetails(entry.details);
				if (fold === undefined) continue;
				const accum = byKey.get(key(fold.inquiryId, fold.attempt));
				if (accum === undefined || accum.foldEntryId !== undefined) continue;
				if (
					fold.watchdogOutcome === "continue" ||
					fold.watchdogOutcome === "unlock" ||
					fold.watchdogOutcome === "decision-failed" ||
					fold.watchdogOutcome === "invalidated" ||
					fold.watchdogOutcome === "preempted"
				) {
					accum.foldEntryId = entry.id;
					accum.foldOutcome = fold.watchdogOutcome;
					accum.quietUnlock =
						fold.watchdogOutcome === "unlock" && fold.outcome === "remove";
				}
			}
			continue;
		}
		if (entry.type === "message" && isObjectLoose(entry.message)) {
			const message = entry.message as WireLike;
			const details = isObjectLoose(message.details)
				? (message.details as Record<string, unknown>)
				: undefined;
			const piInquiry = isObjectLoose(details?.piInquiry)
				? (details?.piInquiry as Record<string, unknown>)
				: undefined;
			const correlation = decisionDetails(piInquiry);
			if (correlation === undefined) continue;
			const accum = byKey.get(key(correlation.inquiryId, correlation.attempt));
			if (accum !== undefined && accum.assistantEntryId === undefined) {
				accum.assistantEntryId = entry.id;
			}
		}
	}

	const sourcePositions = new Map(
		branch.map((entry, index) => [entry.id, index]),
	);
	const records: ReviewHistoryRecord[] = order.map((accum) => {
		const markerReview = reviewField(accum.markerData);
		const auditReview =
			accum.auditData === undefined
				? ({ state: "absent" } as const)
				: reviewField(accum.auditData);
		const responseOutcome =
			accum.auditData === undefined ? undefined : auditOutcome(accum.auditData);
		const missingUnlockStatus =
			accum.quietUnlock === true && accum.unlockEntryId === undefined;
		const publishedOutcome =
			missingUnlockStatus ||
			accum.foldOutcome === "invalidated" ||
			accum.foldOutcome === "preempted"
				? undefined
				: accum.foldOutcome === "decision-failed"
					? "decision-failed"
					: accum.foldOutcome;
		const status: ReviewRecordStatus =
			accum.foldEntryId !== undefined && !missingUnlockStatus
				? "published"
				: responseOutcome === "invalid"
					? "invalid-response"
					: accum.auditEntryId !== undefined ||
							accum.assistantEntryId !== undefined
						? "responded"
						: "pending";
		const problems: string[] = [];
		if (missingUnlockStatus)
			problems.push("quiet unlock publication unavailable");
		if (accum.unlockEntryId !== undefined && accum.foldOutcome !== "unlock")
			problems.push("quiet unlock cleanup unavailable");
		let reviewMetadata: ReviewHistoryRecord["reviewMetadata"] = "none";
		let source: ReviewSourceMetadata | undefined;
		if (
			markerReview.state === "unknown" ||
			auditReview.state === "unknown" ||
			(markerReview.state === "ok" &&
				markerReview.value.projectionVersion !== REVIEW_PROJECTION_VERSION)
		) {
			reviewMetadata = "unknown-version";
			problems.push("unsupported review metadata or projection version");
		} else if (markerReview.state === "ok" || auditReview.state === "ok") {
			if (accum.promptEntryId === undefined)
				problems.push("inquiry unavailable");
			const markerPosition = sourcePositions.get(accum.markerEntryId) ?? -1;
			const sourceEntry = (id: unknown): SessionEntry | undefined => {
				if (typeof id !== "string") return undefined;
				const position = sourcePositions.get(id);
				if (position === undefined || position >= markerPosition)
					return undefined;
				const entry = branch[position];
				return entry !== undefined &&
					sessionEntryToContextMessages(entry).length > 0
					? entry
					: undefined;
			};
			const count = (value: unknown): boolean =>
				typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
			const value =
				markerReview.state === "ok" ? markerReview.value : undefined;
			if (
				value !== undefined &&
				(value.sourceHeadId === null ||
					sourceEntry(value.sourceHeadId) !== undefined) &&
				(value.compactionBoundaryId === null ||
					sourceEntry(value.compactionBoundaryId)?.type === "compaction") &&
				Array.isArray(value.selectedSources) &&
				value.selectedSources.every((ref: unknown) => {
					if (!isObject(ref)) return false;
					const entry = sourceEntry(ref.id);
					return (
						entry !== undefined &&
						sessionEntryToContextMessages(entry).some(
							(wire) =>
								classifyWire(wire as unknown as WireLike)?.provenance ===
								ref.provenance,
						)
					);
				}) &&
				typeof value.digest === "string" &&
				value.digest.length > 0 &&
				count(value.omittedRows) &&
				isObject(value.omittedByProvenance) &&
				Object.values(value.omittedByProvenance).every(count)
			) {
				source = value as unknown as ReviewSourceMetadata;
			} else {
				problems.push(
					"source metadata malformed or references unavailable on the review's ancestry",
				);
			}
			if (accum.auditData === undefined)
				problems.push("response audit unavailable");
			else if (auditReview.state !== "ok")
				problems.push("audit review association unavailable");
			if (auditReview.state === "ok") {
				const association = auditReview.value;
				for (const [field, expected] of [
					["markerEntryId", accum.markerEntryId],
					["promptEntryId", accum.promptEntryId],
					["sourceHeadId", source?.sourceHeadId],
					["sourceDigest", source?.digest],
				] as const) {
					if (
						Object.hasOwn(association, field) &&
						association[field] !== expected
					)
						problems.push(`audit ${field} does not match its review`);
				}
			}
			reviewMetadata = problems.length === 0 ? "ok" : "partial";
		}
		for (const problem of problems)
			diagnostics.push(
				`exchange ${accum.exchangeId} attempt ${accum.cycleId}: ${problem}`,
			);
		return {
			exchangeId: accum.exchangeId,
			cycleId: accum.cycleId,
			markerEntryId: accum.markerEntryId,
			...(accum.promptEntryId === undefined
				? {}
				: { promptEntryId: accum.promptEntryId }),
			...(accum.assistantEntryId === undefined
				? {}
				: { assistantEntryId: accum.assistantEntryId }),
			...(accum.auditEntryId === undefined
				? {}
				: { auditEntryId: accum.auditEntryId }),
			...(accum.unlockEntryId === undefined
				? {}
				: { unlockEntryId: accum.unlockEntryId }),
			...(accum.foldEntryId === undefined
				? {}
				: { foldEntryId: accum.foldEntryId }),
			...(accum.foldOutcome === undefined
				? {}
				: { foldOutcome: accum.foldOutcome }),
			...(responseOutcome === undefined ? {} : { responseOutcome }),
			...(publishedOutcome === undefined ? {} : { publishedOutcome }),
			status,
			reviewMetadata,
			...(source === undefined ? {} : { source }),
		};
	});
	return {
		leafId,
		...(sessionId === undefined ? {} : { sessionId }),
		...(sessionFile === undefined ? {} : { sessionFile }),
		records,
		...(diagnostics.length === 0 ? {} : { diagnostic: diagnostics.join("; ") }),
	};
}
