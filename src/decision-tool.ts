import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import {
	DECISION_TOOL_NAME,
	MAX_REASON_CHARACTERS,
	prepareDecisionArguments,
} from "./decision-protocol.js";

/** Exact public description of the reserved decision-result function. */
export const DECISION_TOOL_DESCRIPTION = "don't use unless ask";

/** Error returned for every call outside an authorized current attempt. */
export const RESERVED_FUNCTION_ERROR =
	"This function is reserved for the plugin. Please try another function.";

/** Error returned for a second submission inside one authorized attempt. */
export const DECISION_ALREADY_SUBMITTED_ERROR =
	"Decision result already submitted.";

export interface DecisionToolDetails {
	readonly outcome: "received" | "invalid" | "reserved";
	readonly error?: string;
}

/** Runtime authorization seam shared by the tool_call gate and execute. */
export interface DecisionToolHost {
	/**
	 * Validate that a result submission is authorized for the exact current
	 * consumed decision attempt, and stage it. Returns:
	 * - "unauthorized" outside a current consumed attempt;
	 * - "duplicate" when this attempt already staged a result;
	 * - "staged" with the parsed validation verdict or its named error.
	 */
	readonly submitDecisionResult: (call: {
		readonly toolCallId: string;
		readonly argumentsValue: unknown;
	}) =>
		| { readonly outcome: "unauthorized" }
		| { readonly outcome: "duplicate" }
		| {
				readonly outcome: "staged";
				readonly validation:
					| { readonly valid: true }
					| { readonly valid: false; readonly error: string };
		  };
	/**
	 * Presentation-only ownership evidence for renderers: true exactly when the
	 * call id belongs to the current owned decision attempt's recorded batch.
	 * Trusted identity only; arguments are never consulted. Optional so
	 * focused tool tests without runtime wiring keep visible defaults.
	 */
	readonly isOwnedDecisionCall?: (toolCallId: string) => boolean;
}

function reservedFunctionResult(): AgentToolResult<DecisionToolDetails> {
	return {
		content: [{ type: "text", text: RESERVED_FUNCTION_ERROR }],
		details: { outcome: "reserved" },
	};
}

/**
 * Exact-deduplicated union of the effective unlock and continue reason
 * types, preserving configured spellings and list order (unlock first).
 * Structural vocabulary only: action-specific admission is still enforced by
 * runtime validation, and uppercase remains the outcome representation, not
 * an input alias.
 */
export function decisionReasonTypeEnum(
	reasonTypes: readonly string[],
	continueReasonTypes: readonly string[],
): string[] {
	const union: string[] = [];
	const seen = new Set<string>();
	for (const entry of [...reasonTypes, ...continueReasonTypes]) {
		if (seen.has(entry)) continue;
		seen.add(entry);
		union.push(entry);
	}
	return union;
}

/** Build the constrained public parameter schema from effective reason lists. */
export function createDecisionToolParameters(
	reasonTypes: readonly string[],
	continueReasonTypes: readonly string[],
): TSchema {
	return Type.Object(
		{
			reason_content: Type.String({
				minLength: 1,
				maxLength: MAX_REASON_CHARACTERS,
				pattern: "\\S",
			}),
			reason_type: Type.String({
				enum: decisionReasonTypeEnum(reasonTypes, continueReasonTypes),
			}),
			action: Type.String({ enum: ["continue", "unlock"] }),
		},
		{ additionalProperties: true },
	);
}

/**
 * Build the root-only reserved decision-result function. The declaration is
 * minimal: description exactly `don't use unless ask`, a structurally
 * constrained parameter schema derived from the effective reason
 * configuration, no prompt snippet, no guidelines, and no explanatory
 * parameter annotations. Authority lives in the runtime host, which checks
 * authorization before argument validation; the schema is a structural
 * contract, never an authorization source.
 */
export function createDecisionToolDefinition(
	host: DecisionToolHost,
	reasonTypes: readonly string[],
	continueReasonTypes: readonly string[],
): ToolDefinition<TSchema, DecisionToolDetails> {
	return {
		name: DECISION_TOOL_NAME,
		label: DECISION_TOOL_NAME,
		description: DECISION_TOOL_DESCRIPTION,
		parameters: createDecisionToolParameters(reasonTypes, continueReasonTypes),
		renderShell: "self",
		// Compatibility preparation runs before native schema validation. It
		// normalizes the existing trim/case-insensitive inputs into their
		// configured spellings without manufacturing, coercing, or truncating
		// values: what remains invalid stays invalid.
		prepareArguments: (args) =>
			prepareDecisionArguments(args, reasonTypes, continueReasonTypes),
		async execute(toolCallId, args) {
			const submission = host.submitDecisionResult({
				toolCallId,
				argumentsValue: args,
			});
			if (submission.outcome === "unauthorized") {
				// An ordinary out-of-phase call must not stop ordinary work: no
				// terminate and no payload validation.
				return reservedFunctionResult();
			}
			if (submission.outcome === "duplicate") {
				return {
					content: [{ type: "text", text: DECISION_ALREADY_SUBMITTED_ERROR }],
					details: { outcome: "invalid" },
					terminate: true,
				};
			}
			if (!submission.validation.valid) {
				// An authorized validation failure is a staged outcome, not an
				// uncontrolled ordinary tool-error follow-up loop.
				return {
					content: [{ type: "text", text: submission.validation.error }],
					details: {
						outcome: "invalid",
						error: submission.validation.error,
					},
					terminate: true,
				};
			}
			return {
				content: [{ type: "text", text: "Decision received." }],
				details: { outcome: "received" },
				terminate: true,
			};
		},
		renderCall(_args, _theme, context) {
			// Owned internal presentation is quiet: the accepted outcome states
			// itself through the quiet unlock status or the continuation event.
			// Hidden by trusted call-id ownership evidence, never by arguments,
			// so unauthorized ordinary calls keep their visible rejection.
			if (
				typeof context?.toolCallId === "string" &&
				host.isOwnedDecisionCall?.(context.toolCallId) === true
			) {
				return new Container();
			}
			if (context?.isPartial === false && !context.isError) {
				return new Container();
			}
			return new Text("", 0, 0);
		},
		renderResult(result, _options, _theme, _context) {
			// Presentation provenance is positive trusted result identity, not
			// live attempt state and not mere absence of a known marker:
			// `received` and `invalid` details are authored only by an
			// authorized staging of the exact current attempt (execute is the
			// sole writer of those shapes), so an owned successful/corrected
			// receipt stays quiet across completion, finalization,
			// invalidation, redraw, and session resume long after the live
			// ownership lookup turns false. Everything else is visible by
			// default: `reserved` keeps unauthorized ordinary rejections (with
			// copied arguments or reused call ids) visible, and host-authored
			// error results (pinned createErrorToolResult: argument validation,
			// pre-call blocking, aborts, thrown execute) carry empty details —
			// hiding those would hide ordinary and owned host errors alike, so
			// they render through the ordinary text path. Failing closed on
			// visibility never widens execution authority: arguments, body
			// text, and call ids are never consulted for ownership. A missing
			// details object also renders visibly (host fallback masks a
			// throw, but a visible default is strictly safer).
			const outcome = result.details?.outcome;
			if (outcome === "received" || outcome === "invalid") {
				return new Container();
			}
			// Unauthorized ordinary calls and host errors keep a visible row.
			const text = result.content
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
			return new Text(text, 0, 0);
		},
	} as ToolDefinition<TSchema, DecisionToolDetails>;
}

/**
 * Register the reserved decision function exactly once per process session,
 * or refresh the same named declaration when effective constraints changed.
 * A same-name replacement must not change active membership: pinned Pi
 * refreshes add every allowlisted registered tool to the active set, so a
 * user-disabled `cw` would silently reactivate. Snapshot the pre-refresh
 * active names through the public API and restore them after the swap.
 * Initial registration deliberately keeps native membership behavior.
 */
export function registerDecisionTool(
	pi: ExtensionAPI,
	tool: ToolDefinition<TSchema, DecisionToolDetails>,
	options?: { readonly preserveActiveMembership?: boolean },
): void {
	const canPreserve =
		typeof pi.getActiveTools === "function" &&
		typeof pi.setActiveTools === "function";
	const activeBefore =
		options?.preserveActiveMembership === true && canPreserve
			? pi.getActiveTools()
			: null;
	pi.registerTool(tool);
	if (activeBefore !== null) {
		pi.setActiveTools(activeBefore);
	}
}
