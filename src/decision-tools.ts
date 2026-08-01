import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Public model-visible tool name used only during an automated decision window. */
export const CONTINUE_WATCHDOG_TOOL_NAME = "continue_watchdog";

/** Public model-visible tool name used only during an automated decision window. */
export const UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME = "unlock_continue_watchdog";

/** The complete decision-only active tool set, in its stable protocol order. */
export const DECISION_TOOL_NAMES: readonly [
	typeof CONTINUE_WATCHDOG_TOOL_NAME,
	typeof UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
] = Object.freeze([
	CONTINUE_WATCHDOG_TOOL_NAME,
	UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
]);

export const CONTINUE_WATCHDOG_DESCRIPTION =
	"Select continuation during the automated pi-continue-watchdog decision check. This check is extension automation, not a user request.";

export const CONTINUE_WATCHDOG_PROMPT_SNIPPET =
	"Select continuation for an automated pi-continue-watchdog decision check, not a user request.";

export const UNLOCK_CONTINUE_WATCHDOG_DESCRIPTION =
	"Select unlock during the automated pi-continue-watchdog decision check. This check is extension automation, not a user request. Provide a concise, clear one-sentence reason that is non-empty and at most 500 characters.";

export const UNLOCK_CONTINUE_WATCHDOG_PROMPT_SNIPPET =
	"Select unlock with a concise reason for an automated pi-continue-watchdog decision check, not a user request.";

/** A fixed response when a stale decision tool execution cannot control main state. */
export const STALE_DECISION_TOOL_MESSAGE =
	"This pi-continue-watchdog decision window is no longer active.";

const CONTINUE_WATCHDOG_PARAMETERS = Type.Object(
	{},
	{ additionalProperties: false },
);
const UNLOCK_CONTINUE_WATCHDOG_PARAMETERS = Type.Object(
	{
		reason: Type.String({ minLength: 1, maxLength: 500 }),
	},
	{ additionalProperties: false },
);

export type DecisionToolKind = "continue" | "unlock";

/** A validated tool call handed to the Slice 6 decision protocol executor. */
export interface DecisionToolCall {
	readonly kind: DecisionToolKind;
	readonly reason?: string;
	readonly toolCallId: string;
	readonly ctx: ExtensionContext;
}

/**
 * Deliberately opaque result details: Slice 5 makes no protocol or rendering
 * decision. The future executor owns validation, state transitions, folding,
 * TUI rendering, and whether a particular outcome should terminate.
 */
export interface DecisionToolExecutor {
	onDecisionToolCall(
		call: DecisionToolCall,
	): AgentToolResult<unknown> | Promise<AgentToolResult<unknown>>;
}

export interface DecisionToolExecutors {
	readonly executeContinue: (
		toolCallId: string,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	readonly executeUnlock: (
		toolCallId: string,
		reason: string,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
}

export interface DecisionToolActivationOptions extends DecisionToolExecutors {
	/** Main ownership is live and may change after a decision window opens. */
	readonly isCurrentMain: () => boolean;
}

export interface DecisionToolActivation {
	/** Registers the pair once for this Pi extension attachment. */
	readonly registerDecisionTools: () => void;
	/**
	 * Snapshot currently active normal tools and replace them with exactly the pair.
	 * Non-main attachments and a duplicate active entry are intentionally inert.
	 */
	readonly activateDecisionTools: () => boolean;
	/**
	 * Restore the exact prior active set. This remains available after demotion so
	 * lifecycle cleanup cannot strand the decision pair as the active set.
	 */
	readonly restoreDecisionTools: () => boolean;
	readonly isActive: () => boolean;
	/** A read-only testing/runtime seam; null after restore or before activation. */
	readonly getCapturedActiveTools: () => readonly string[] | null;
}

function staleDecisionToolResult(): AgentToolResult<{
	readonly kind: "stale-decision-tool";
}> {
	return {
		content: [{ type: "text", text: STALE_DECISION_TOOL_MESSAGE }],
		details: { kind: "stale-decision-tool" },
		terminate: true,
	};
}

/**
 * Builds pure tool execution delegates. No validation, batching semantics,
 * context folding, decision retries, or timer behavior belongs in this slice.
 */
export function createDecisionToolExecutors(
	executor: DecisionToolExecutor,
): DecisionToolExecutors {
	return {
		async executeContinue(
			toolCallId: string,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			return executor.onDecisionToolCall({
				kind: "continue",
				toolCallId,
				ctx,
			});
		},
		async executeUnlock(
			toolCallId: string,
			reason: string,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			return executor.onDecisionToolCall({
				kind: "unlock",
				reason,
				toolCallId,
				ctx,
			});
		},
	};
}

/**
 * Registers permanent definitions and owns their temporary active-set visibility.
 * Pi has no public unregister API, so the definitions remain in getAllTools();
 * callers must use this manager to ensure they are model-invisible outside the
 * narrow decision request window.
 */
export function createDecisionToolActivation(
	pi: ExtensionAPI,
	options: DecisionToolActivationOptions,
): DecisionToolActivation {
	let registered = false;
	let capturedActiveTools: string[] | null = null;

	const registerDecisionTools = (): void => {
		if (registered) return;
		registered = true;

		pi.registerTool({
			name: CONTINUE_WATCHDOG_TOOL_NAME,
			label: "Continue Watchdog",
			description: CONTINUE_WATCHDOG_DESCRIPTION,
			promptSnippet: CONTINUE_WATCHDOG_PROMPT_SNIPPET,
			parameters: CONTINUE_WATCHDOG_PARAMETERS,
			async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
				if (!options.isCurrentMain() || capturedActiveTools === null) {
					return staleDecisionToolResult();
				}
				return options.executeContinue(toolCallId, ctx);
			},
		});
		pi.registerTool({
			name: UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
			label: "Unlock Continue Watchdog",
			description: UNLOCK_CONTINUE_WATCHDOG_DESCRIPTION,
			promptSnippet: UNLOCK_CONTINUE_WATCHDOG_PROMPT_SNIPPET,
			parameters: UNLOCK_CONTINUE_WATCHDOG_PARAMETERS,
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				if (!options.isCurrentMain() || capturedActiveTools === null) {
					return staleDecisionToolResult();
				}
				return options.executeUnlock(toolCallId, params.reason, ctx);
			},
		});
	};

	registerDecisionTools();

	return Object.freeze({
		registerDecisionTools,
		activateDecisionTools(): boolean {
			if (!options.isCurrentMain() || capturedActiveTools !== null)
				return false;

			// Copy now: a host implementation may retain/mutate its returned array.
			capturedActiveTools = [...pi.getActiveTools()];
			pi.setActiveTools([...DECISION_TOOL_NAMES]);
			return true;
		},
		restoreDecisionTools(): boolean {
			if (capturedActiveTools === null) return false;

			const activeTools = capturedActiveTools;
			capturedActiveTools = null;
			pi.setActiveTools([...activeTools]);
			return true;
		},
		isActive(): boolean {
			return capturedActiveTools !== null;
		},
		getCapturedActiveTools(): readonly string[] | null {
			return capturedActiveTools === null ? null : [...capturedActiveTools];
		},
	});
}
