import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	CONTINUATION_MESSAGE_TYPE,
	DECISION_FOLD_MESSAGE_TYPE,
	DECISION_INQUIRY_NAMESPACE,
	type DecisionFoldDetails,
	foldDecisionContext,
	parseDecisionFoldDetails,
} from "./context-fold.js";
import {
	parseWatchdogEvent,
	WATCHDOG_EVENT_MESSAGE_TYPE,
} from "./watchdog-event.js";

/**
 * Native summary projection.
 *
 * Keeps watchdog-owned internal traffic (inquiry prompts, correction prompts,
 * assistant submissions, tool results, and quiet AI-unlock statuses) out of
 * the model input the host serializes for native manual/automatic compaction
 * and branch summaries, while preserving accepted continuation and safe shared
 * diagnostics at their original positions and every unowned record.
 *
 * The projection reuses the exact-exchange folding already used for ordinary
 * requests (`foldDecisionContext`) and limits its output to entries the host
 * itself selected for the summarized region. Identity is derived from exact
 * host-selected entry intervals and correlation keys — never from object
 * references, timestamps, signatures, or content equality. Stored session
 * entries are never mutated: only the supplied preparation arrays are
 * rewritten in place.
 */

/**
 * Minimal structural shapes of the public host preparation objects. The
 * pinned 0.85.1 surface exposes these through the session_before_compact and
 * session_before_tree events; only the fields this projection reads are
 * declared.
 */
interface WireMessage {
	readonly role?: unknown;
	readonly customType?: unknown;
	readonly content?: unknown;
	readonly display?: unknown;
	readonly details?: unknown;
	readonly timestamp?: unknown;
	[key: string]: unknown;
}

export interface CompactionPreparationLike {
	readonly firstKeptEntryId: string;
	readonly messagesToSummarize: unknown[];
	readonly turnPrefixMessages: unknown[];
}

export interface TreePreparationLike {
	readonly entriesToSummarize: SessionEntry[];
}

/** Wire-shape conversion of one branch entry, mirroring host serialization. */
function entryToWire(entry: SessionEntry): WireMessage | undefined {
	if (entry.type === "message") return { ...entry.message };
	if (entry.type === "custom_message") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content ?? [],
			display: entry.display,
			details: entry.details,
			timestamp: Date.parse(entry.timestamp),
		} as unknown as WireMessage;
	}
	return undefined;
}

function isObjectWire(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Exact correlation key of a watchdog inquiry exchange (namespace+id+attempt). */
function correlationOf(details: unknown): string | undefined {
	if (!isObjectWire(details)) return undefined;
	if (
		details.namespace === DECISION_INQUIRY_NAMESPACE &&
		typeof details.inquiryId === "string" &&
		typeof details.attempt === "number" &&
		typeof details.version === "number"
	) {
		return JSON.stringify([
			details.namespace,
			details.version,
			details.inquiryId,
			details.attempt,
		]);
	}
	return undefined;
}

function piInquiryOf(details: unknown): string | undefined {
	if (!isObjectWire(details)) return undefined;
	return correlationOf(details.piInquiry);
}

/** A watchdog-owned fold custom message with a replacement payload. */
function isReplaceFold(message: unknown): message is {
	readonly customType: string;
	readonly details?: unknown;
} {
	return (
		isObjectWire(message) &&
		message.customType === DECISION_FOLD_MESSAGE_TYPE &&
		isObjectWire(message.details) &&
		message.details.replacement !== undefined
	);
}

/**
 * Valid owned fold metadata: the record claims the decision fold type AND
 * carries exactly the validated watchdog fold details (namespace, version,
 * correlation, outcome). The type name alone is never ownership — a
 * malformed or uncorrelated record shaped like our fold must pass through
 * unchanged like any other unknown record.
 */
function ownedFoldDetails(message: unknown): DecisionFoldDetails | undefined {
	return isObjectWire(message) &&
		message.customType === DECISION_FOLD_MESSAGE_TYPE
		? parseDecisionFoldDetails(message.details)
		: undefined;
}

/** Only validated model-bound outcomes may replace an owned fold. */
function foldReplacementIsShared(details: DecisionFoldDetails): boolean {
	if (details.outcome !== "replace") return false;
	const replacement = details.replacement;
	if (replacement?.customType === CONTINUATION_MESSAGE_TYPE) return true;
	if (replacement?.customType !== WATCHDOG_EVENT_MESSAGE_TYPE) return false;
	const event = parseWatchdogEvent(replacement.details);
	return event?.kind === "decision-failed" || event?.kind === "exhausted";
}

/**
 * Fold the full supplied branch once for ownership, then build the synthetic
 * shared-outcome map keyed by exact fold correlation. Synthetic messages come
 * from `foldDecisionContext` itself, so equal replacement bodies can never
 * misassociate: the key is the fold's correlation, not body text.
 */
function continuationByCorrelation(
	rows: Array<{ entry: SessionEntry; msg: WireMessage | undefined }>,
): {
	readonly foldedSet: Set<WireMessage>;
	readonly syntheticByCorr: Map<string, WireMessage>;
} {
	const wires = rows
		.map((row) => row.msg)
		.filter((msg): msg is WireMessage => msg !== undefined);
	const folded = foldDecisionContext([...wires]);
	const foldedSet = new Set(folded);
	const known = new Set(wires);
	const syntheticByCorr = new Map<string, WireMessage>();
	for (const message of folded) {
		if (known.has(message) || !isObjectWire(message)) continue;
		const key = piInquiryOf(message.details);
		if (key === undefined) continue;
		for (const row of rows) {
			const msg = row.msg;
			if (
				isObjectWire(msg) &&
				isReplaceFold(msg) &&
				correlationOf((msg as { details?: unknown }).details) === key
			) {
				syntheticByCorr.set(key, message);
				break;
			}
		}
	}
	return { foldedSet, syntheticByCorr };
}

/**
 * Project the host-selected entry interval for one compaction region set.
 *
 * The public previous-compaction boundary and the current cut identify the
 * exact entry slice; the supplied region array lengths give the host's split
 * of that slice. Output stays strictly limited to the selected entries: an
 * entry the host did not select is never added, and a selected entry is
 * either preserved as the host supplied it, replaced by its synthetic
 * continuation at the fold position, or dropped when it is internal traffic
 * folded out of model context.
 */
function projectCompactionRegions(
	regionNames: Array<"messagesToSummarize" | "turnPrefixMessages">,
	preparation: CompactionPreparationLike,
	branchEntries: readonly SessionEntry[],
): void {
	const rows = branchEntries.map((entry) => ({
		entry,
		msg: entryToWire(entry),
	}));
	const { foldedSet, syntheticByCorr } = continuationByCorrelation(rows);

	// Exact selected interval: from the entry after the last previous
	// compaction's kept boundary up to (excluding) the current first kept id.
	const previous = branchEntries.findLastIndex(
		(entry) => entry.type === "compaction",
	);
	let start = 0;
	if (previous >= 0) {
		const kept = branchEntries.findIndex(
			(entry) =>
				entry.id ===
				(branchEntries[previous] as { firstKeptEntryId?: string })
					.firstKeptEntryId,
		);
		start = kept >= 0 ? kept : previous + 1;
	}
	const end = branchEntries.findIndex(
		(entry) => entry.id === preparation.firstKeptEntryId,
	);
	const selected = rows
		.slice(start, end)
		.filter(
			({ entry, msg }) =>
				msg !== undefined ||
				(entry.type === "branch_summary" && entry.summary !== undefined),
		);
	const count = regionNames.reduce(
		(total, name) => total + preparation[name].length,
		0,
	);
	if (end < start || selected.length !== count) {
		// The host's preparation does not describe its own selected slice; do
		// not guess. Leave the preparation untouched rather than project
		// against an unverified identity mapping.
		return;
	}
	let offset = 0;
	for (const name of regionNames) {
		const region = preparation[name] as WireMessage[];
		const out: WireMessage[] = [];
		for (const original of region) {
			const { msg } = selected[offset++];
			// Owned folds emit only their permitted shared replacement, at the
			// fold's selected position (including when its prompt is outside).
			const ownedFold = ownedFoldDetails(msg);
			if (ownedFold !== undefined) {
				const details = ownedFold;
				if (!foldReplacementIsShared(details)) continue;
				const key = correlationOf(details);
				const synthetic =
					key === undefined ? undefined : syntheticByCorr.get(key);
				if (synthetic !== undefined) {
					out.push(synthetic);
					continue;
				}
				// Orphan fold: use its validated, permitted persisted replacement.
				const replacement = details.replacement;
				if (isObjectWire(replacement)) {
					out.push({
						role: "custom",
						...replacement,
						display: false,
						timestamp: msg?.timestamp,
					});
				}
				continue;
			}
			// A fold rejected by our parser is unowned, even if the generic
			// inquiry folder consumed it without checking watchdog metadata.
			if (
				msg === undefined ||
				msg.customType === DECISION_FOLD_MESSAGE_TYPE ||
				foldedSet.has(msg)
			) {
				out.push(original);
			}
			// Internal prompt/call/result traffic folded out of context never
			// re-enters native summaries.
		}
		region.length = 0;
		region.push(...out);
	}
}

/**
 * Project native manual/automatic compaction preparation in place: both the
 * history region and a split-turn prefix region are rewritten from the same
 * exact selected interval, so an exchange crossing the boundary folds once.
 */
export function projectCompactionPreparation(
	preparation: CompactionPreparationLike,
	branchEntries: readonly SessionEntry[],
): void {
	projectCompactionRegions(
		["messagesToSummarize", "turnPrefixMessages"],
		preparation,
		branchEntries,
	);
}

/**
 * Project native branch-summary preparation in place. The full old active
 * branch supplies correlation context so an exchange whose prompt sits
 * outside the selected region still folds completely; output remains limited
 * to the entries the host selected. Stored entries are never mutated; the
 * supplied array is rewritten in place, preserving its identity for hosts
 * that hold the reference.
 */
export function projectBranchPreparation(
	preparation: TreePreparationLike,
	oldBranchEntries: readonly SessionEntry[],
): void {
	const original = preparation.entriesToSummarize;
	const allRows = oldBranchEntries.map((entry) => ({
		entry,
		msg: entryToWire(entry),
	}));
	const { foldedSet } = continuationByCorrelation(allRows);
	const byId = new Map(allRows.map((row) => [row.entry.id, row]));
	const out: SessionEntry[] = [];
	for (const entry of original) {
		const row = byId.get(entry.id);
		// Owned folds emit only permitted shared outcomes; remove-only and
		// retired control replacements emit nothing.
		const ownedFold = row !== undefined ? ownedFoldDetails(row.msg) : undefined;
		if (ownedFold !== undefined) {
			const details = ownedFold;
			if (!foldReplacementIsShared(details)) continue;
			const replacement = details.replacement;
			if (isObjectWire(replacement)) {
				out.push({
					type: "custom_message",
					customType: String(
						replacement.customType ?? CONTINUATION_MESSAGE_TYPE,
					),
					content:
						typeof replacement.content === "string"
							? replacement.content
							: Array.isArray(replacement.content)
								? replacement.content
								: [],
					display: true,
					details: replacement.details,
					id: `projected-${entry.id}`,
					parentId: null,
					timestamp: entry.timestamp,
				} as SessionEntry);
			}
			continue;
		}
		if (
			row === undefined ||
			row.msg === undefined ||
			row.msg.customType === DECISION_FOLD_MESSAGE_TYPE ||
			foldedSet.has(row.msg)
		) {
			out.push(entry);
		}
	}
	original.length = 0;
	original.push(...out);
}
