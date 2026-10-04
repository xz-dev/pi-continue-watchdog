import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { DECISION_TOOL_NAME } from "./decision-protocol.js";

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
}

function reservedFunctionResult(): AgentToolResult<DecisionToolDetails> {
	return {
		content: [{ type: "text", text: RESERVED_FUNCTION_ERROR }],
		details: { outcome: "reserved" },
	};
}

/**
 * Build the root-only reserved decision-result function. The declaration is
 * fixed: minimal description, open empty-object schema, no prompt snippet or
 * guidelines, no reason enums. Authority lives in the runtime host, which
 * checks authorization before argument validation.
 */
export function createDecisionToolDefinition(
	host: DecisionToolHost,
): ToolDefinition<TSchema, DecisionToolDetails> {
	return {
		name: DECISION_TOOL_NAME,
		label: DECISION_TOOL_NAME,
		description: DECISION_TOOL_DESCRIPTION,
		parameters: Type.Object({}, { additionalProperties: true }),
		renderShell: "self",
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
		renderCall(args, theme, context) {
			// Pi renders call and result in the same row. Once a final result
			// exists it states the outcome itself; reserved/invalid calls keep the
			// header to show which call failed.
			if (context?.isPartial === false && !context.isError) {
				return new Container();
			}
			const action =
				typeof (args as { action?: unknown } | null)?.action === "string"
					? ((args as { action: string }).action as string)
					: "";
			return new Text(
				theme.fg(
					"accent",
					`Continue watchdog decision · ${action.trim().toUpperCase()}`,
				),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	} as ToolDefinition<TSchema, DecisionToolDetails>;
}

/** Register the reserved decision function exactly once per process session. */
export function registerDecisionTool(
	pi: ExtensionAPI,
	tool: ToolDefinition<TSchema, DecisionToolDetails>,
): void {
	pi.registerTool(tool);
}
