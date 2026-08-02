import type {
	AgentToolResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * A compact custom renderer for a successful continue decision.
 * Pi renders call and result in one ToolExecutionComponent; an empty result
 * component keeps the configured prompt as its single visible line.
 */
export interface ContinueToolRenderers {
	readonly renderCall: NonNullable<ToolDefinition["renderCall"]>;
	readonly renderResult: NonNullable<ToolDefinition["renderResult"]>;
}

export interface UnlockToolRenderers {
	readonly renderCall: NonNullable<ToolDefinition["renderCall"]>;
	readonly renderResult: NonNullable<ToolDefinition["renderResult"]>;
}

export function createContinueToolRenderers(
	getContinuePrompt: () => string,
): ContinueToolRenderers {
	return {
		renderCall(_args, theme, _context) {
			return new Text(theme.fg("toolTitle", getContinuePrompt()), 0, 0);
		},
		renderResult(
			_result: AgentToolResult<unknown>,
			_options,
			_theme,
			_context,
		) {
			return new Text("", 0, 0);
		},
	};
}

export function createUnlockToolRenderers(): UnlockToolRenderers {
	return {
		renderCall(_args, _theme, _context) {
			return new Text("", 0, 0);
		},
		renderResult(result, _options, theme, _context) {
			const recorded =
				typeof result.details === "object" &&
				result.details !== null &&
				(result.details as { readonly kind?: unknown }).kind ===
					"decision-recorded";
			if (recorded) return new Text("", 0, 0);

			const text = result.content
				.flatMap((content) => (content.type === "text" ? [content.text] : []))
				.join("\n");
			return new Text(theme.fg("error", text), 0, 0);
		},
	};
}

/** Shared exact empty parameter schema for the reasonless continue tool. */
export const CONTINUE_WATCHDOG_RENDER_PARAMETERS = Type.Object(
	{},
	{ additionalProperties: false },
);
