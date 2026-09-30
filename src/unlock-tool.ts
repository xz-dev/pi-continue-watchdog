import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import type { ContinueWatchdogConfig } from "./config.js";
import { hasAtMostUnicodeCodePoints } from "./config.js";
import type { UserReadyValues } from "./semantic-hook.js";

/** Public model-visible tool name. Always registered in root processes. */
export const UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME = "unlock_continue_watchdog";

/** Hard limit for the model-provided reason, in Unicode code points. */
export const MAX_TOOL_REASON_CHARACTERS = 1000;

/**
 * Shared completeness check, used verbatim by the tool description, the
 * prompt guideline, and the continuation event body.
 */
export const UNLOCK_COMPLETENESS_CHECK =
	"Before calling it, check every task the user requested in this session, including earlier requests and not only the latest one, against what was actually delivered; work already delivered, cancelled, or superseded is not remaining. If any requested and authorized work can still proceed now, do it instead of calling this tool.";

export const UNLOCK_TOOL_DESCRIPTION = `Signal that your work should stop and control returns to the user. Call this tool when all requested work is complete, or when user input, approval, or other user action is required, or work is blocked without a user action. ${UNLOCK_COMPLETENESS_CHECK} If you end your turn without calling this tool, the pi-continue-watchdog extension will automatically continue your work. This tool belongs to the pi-continue-watchdog extension; calling it is your decision, not a user request. Provide reason_type (one of the allowed values for this project) and a concise reason.`;

/** One-line entry for the system prompt's available-tools section. */
export const UNLOCK_TOOL_PROMPT_SNIPPET =
	"Signal that your work is done or needs the user (pi-continue-watchdog); otherwise you are continued automatically";

/** Session-stable system prompt guidelines; never change during a lock cycle. */
export const UNLOCK_TOOL_PROMPT_GUIDELINES: readonly string[] = Object.freeze([
	"Before ending a turn because all requested work is complete, because you need user input, approval, or other user action, or because work is blocked without a user action, call unlock_continue_watchdog with a reason_type and a concise reason. First confirm that no task the user requested in this session, including earlier requests, is still missing and can proceed now. If you end a turn without calling it, the pi-continue-watchdog extension automatically continues your work.",
	"If you need to wait for some work to finish, do not end the turn to wait: block on or monitor that task directly, or sleep for your estimated duration.",
]);

export const INVALID_REASON_TYPE_TOOL_ERROR =
	"reason_type must match one of the allowed reason types for this project (case-insensitive after trimming).";

/** Named reason-type error that lists the effective allowed values. */
export function invalidReasonTypeToolError(
	reasonTypes: readonly string[],
): string {
	return `${INVALID_REASON_TYPE_TOOL_ERROR} Allowed: ${reasonTypes.map((entry) => entry.toUpperCase()).join(", ")}.`;
}
export const INVALID_REASON_TOOL_ERROR = `reason must be non-empty after trimming and at most ${MAX_TOOL_REASON_CHARACTERS} Unicode characters.`;

export interface UnlockToolDetails {
	readonly outcome: "unlocked" | "already-unlocked";
	readonly reasonType?: string;
	readonly reason?: string;
}

export interface UnlockToolCall {
	readonly reasonType: string;
	readonly reason: string;
}

/**
 * Trim AI reasonType input, match case-insensitively against configured types,
 * and return the uppercase form of the matched configured entry.
 */
export function normalizeUnlockReasonType(
	reasonType: unknown,
	reasonTypes: readonly string[],
): string | null {
	if (typeof reasonType !== "string") return null;
	const trimmed = reasonType.trim();
	if (trimmed.length === 0) return null;
	const needle = trimmed.toLowerCase();
	for (const entry of reasonTypes) {
		if (entry.toLowerCase() === needle) {
			return entry.toUpperCase();
		}
	}
	return null;
}

/** Trim and validate the model-provided unlock reason (no truncation). */
export function normalizeUnlockReason(reason: unknown): string | null {
	if (typeof reason !== "string") return null;
	const trimmed = reason.trim();
	if (
		trimmed.length === 0 ||
		!hasAtMostUnicodeCodePoints(trimmed, MAX_TOOL_REASON_CHARACTERS)
	)
		return null;
	return trimmed;
}

/** Validate raw arguments into an {@link UnlockToolCall} or a named error. */
export function validateUnlockToolArguments(
	args: unknown,
	reasonTypes: readonly string[],
): UnlockToolCall | { readonly error: string } {
	if (typeof args !== "object" || args === null) {
		return { error: invalidReasonTypeToolError(reasonTypes) };
	}
	const input = args as Record<string, unknown>;
	const reasonType = normalizeUnlockReasonType(input.reason_type, reasonTypes);
	if (reasonType === null) {
		return { error: invalidReasonTypeToolError(reasonTypes) };
	}
	const reason = normalizeUnlockReason(input.reason);
	if (reason === null) return { error: INVALID_REASON_TOOL_ERROR };
	return { reasonType, reason };
}

/** Meanings of the built-in reason types; custom types are listed by name only. */
const KNOWN_REASON_TYPE_MEANINGS: Readonly<Record<string, string>> = {
	JOB_DONE: "all requested work is complete",
	WAIT_USER: "user input, approval, or other user action is required",
	JOB_BLOCKED: "work is blocked by something other than a user action",
};

/** Model-facing reason_type description for the effective reason types. */
export function unlockReasonTypeDescription(
	reasonTypes: readonly string[],
): string {
	const values = unlockReasonTypeEnum(reasonTypes).map((entry) => {
		const meaning = KNOWN_REASON_TYPE_MEANINGS[entry];
		return meaning === undefined ? entry : `${entry} = ${meaning}`;
	});
	return `Why work stops: ${values.join("; ")}. Matched case-insensitively after trimming.`;
}

/** Model-facing reason description. */
export const UNLOCK_REASON_DESCRIPTION = `One concise sentence: what was delivered, what the user must do, or what blocks the work. Non-empty after trimming and at most ${MAX_TOOL_REASON_CHARACTERS} Unicode characters.`;

/** Canonical (uppercased, de-duplicated) schema values for the reason types. */
export function unlockReasonTypeEnum(reasonTypes: readonly string[]): string[] {
	return [...new Set(reasonTypes.map((entry) => entry.toUpperCase()))];
}

/**
 * Build the TypeBox parameter schema for the effective reason types.
 * `reason_type` is an enum of the canonical uppercase configured values.
 * Case-insensitive, trimmed input is canonicalized by
 * {@link prepareUnlockToolArguments} before schema validation, so it is still
 * accepted; anything else fails validation or execute with a named error.
 */
export function buildUnlockToolParameters(
	reasonTypes: readonly string[],
): TSchema {
	return Type.Object(
		{
			reason_type: Type.Union(
				unlockReasonTypeEnum(reasonTypes).map((entry) => Type.Literal(entry)),
				{ description: unlockReasonTypeDescription(reasonTypes) },
			),
			reason: Type.String({
				minLength: 1,
				description: UNLOCK_REASON_DESCRIPTION,
			}),
		},
		{ additionalProperties: false },
	);
}

/**
 * Canonicalize a recognized reason_type (trim + case-insensitive match) before
 * schema validation. Unrecognized values are passed through unchanged so the
 * schema/execute path reports them as errors.
 */
export function prepareUnlockToolArguments(
	args: unknown,
	reasonTypes: readonly string[],
): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return args;
	}
	const input = args as Record<string, unknown>;
	const canonical = normalizeUnlockReasonType(input.reason_type, reasonTypes);
	if (canonical === null || canonical === input.reason_type) return args;
	return { ...input, reason_type: canonical };
}

export interface UnlockToolHost {
	/** Live ownership check: is this attachment the current main agent? */
	readonly isCurrentMain: () => boolean;
	/** Effective lock state of the controller, when one exists. */
	readonly isLocked: () => boolean;
	/**
	 * Apply the AI unlock: controller transition plus cleared pending
	 * continuation. Returns false when it could not be applied.
	 */
	readonly applyAiUnlock: (call: UnlockToolCall) => boolean;
}

function informationalResult(
	message: string,
): AgentToolResult<UnlockToolDetails> {
	return {
		content: [{ type: "text", text: message }],
		details: { outcome: "already-unlocked" },
	};
}

/**
 * Build the always-registered unlock tool. `execute` validates arguments
 * (invalid arguments throw and become ordinary failed tool results), applies
 * the AI unlock through the host when locked and main, and requests run
 * termination so no follow-up model request is needed.
 */
export function createUnlockToolDefinition(
	config: Pick<ContinueWatchdogConfig, "reasonTypes">,
	host: UnlockToolHost,
): ToolDefinition<TSchema, UnlockToolDetails> {
	return {
		name: UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
		label: "Unlock continue watchdog",
		description: UNLOCK_TOOL_DESCRIPTION,
		promptSnippet: UNLOCK_TOOL_PROMPT_SNIPPET,
		promptGuidelines: [...UNLOCK_TOOL_PROMPT_GUIDELINES],
		parameters: buildUnlockToolParameters(config.reasonTypes),
		prepareArguments: (args: unknown) =>
			prepareUnlockToolArguments(args, config.reasonTypes),
		renderShell: "self",
		async execute(_toolCallId, args) {
			const validated = validateUnlockToolArguments(args, config.reasonTypes);
			if ("error" in validated) {
				throw new Error(validated.error);
			}
			if (!host.isCurrentMain() || !host.isLocked()) {
				return informationalResult(
					"The continue watchdog is not locked for the current main session; no unlock was needed.",
				);
			}
			const applied = host.applyAiUnlock(validated);
			if (!applied) {
				return informationalResult(
					"The continue watchdog lock changed before this call; no unlock was applied.",
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `Continue watchdog unlocked · ${validated.reasonType}`,
					},
				],
				details: {
					outcome: "unlocked",
					reasonType: validated.reasonType,
					reason: validated.reason,
				},
				terminate: true,
			};
		},
		renderCall(args: unknown, theme, context) {
			// Pi renders call and result in the same row. Once a final non-error
			// result exists it states the outcome itself, so the call header would
			// only repeat it; errors keep the header to show which call failed.
			// Decided from the render context alone: calling invalidate() from a
			// renderer re-enters Pi's updateDisplay and duplicates the result row.
			if (context?.isPartial === false && !context.isError) {
				return new Container();
			}
			const reasonType =
				typeof (args as { reason_type?: unknown } | null)?.reason_type ===
				"string"
					? ((args as { reason_type: string }).reason_type as string)
					: "";
			return new Text(
				theme.fg(
					"accent",
					`Continue watchdog unlock · ${reasonType.toUpperCase()}`,
				),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
			const reason =
				result.details?.outcome === "unlocked" && result.details.reason
					? ` · ${result.details.reason}`
					: "";
			return new Text(theme.fg("toolOutput", `${text}${reason}`), 0, 0);
		},
	} as ToolDefinition<TSchema, UnlockToolDetails>;
}

/** Pending user-ready intent recorded by a valid tool unlock. */
export function unlockToolUserReadyValues(
	call: UnlockToolCall,
): UserReadyValues {
	return {
		STOP_KIND: "AI_UNLOCK",
		REASON_TYPE: call.reasonType,
		REASON: call.reason,
	};
}

/** Register the unlock tool exactly once per process session. */
export function registerUnlockTool(
	pi: ExtensionAPI,
	tool: ToolDefinition<TSchema, UnlockToolDetails>,
): void {
	pi.registerTool(tool);
}
