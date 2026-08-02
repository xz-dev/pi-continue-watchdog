import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	createContinueToolRenderers,
	createUnlockToolRenderers,
} from "./render.js";

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

/** A validated tool call handed to the decision protocol executor. */
export interface DecisionToolCall {
	readonly kind: DecisionToolKind;
	readonly reason?: string;
	readonly toolCallId: string;
	readonly ctx: ExtensionContext;
}

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
	/** Reads the effective config when Pi renders a valid continue decision. */
	readonly getContinuePrompt: () => string;
}

export interface DecisionToolActivation {
	/** Registers the pair once for this Pi extension attachment. */
	readonly registerDecisionTools: () => void;
	/**
	 * Removes registered decision tools from the current active set.
	 *
	 * Pi makes registered tools active by default. Runtime wiring MUST invoke this
	 * for every attachment from `session_start` after Pi has bound its active-tool
	 * APIs and before that session's first model request. A thrown Pi API call
	 * leaves initialization incomplete so the later lifecycle callback can retry.
	 */
	readonly initializeDecisionToolsInactive: () => boolean;
	/**
	 * Snapshot currently active normal tools and replace them with exactly the pair.
	 * Inert until initialization succeeds; non-main attachments and a duplicate
	 * active entry are also inert.
	 */
	readonly activateDecisionTools: () => boolean;
	/**
	 * Restore the exact prior normal-tool set. Remains available after demotion so
	 * lifecycle cleanup cannot strand the decision pair. A thrown Pi API call
	 * leaves the capture intact for a later retry.
	 */
	readonly restoreDecisionTools: () => boolean;
	readonly isActive: () => boolean;
	/** A read-only testing/runtime seam; null after restore or before activation. */
	readonly getCapturedActiveTools: () => readonly string[] | null;
}

function isDecisionToolName(name: string): boolean {
	return (
		name === CONTINUE_WATCHDOG_TOOL_NAME ||
		name === UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME
	);
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

/** Builds pure tool execution delegates for the protocol collector. */
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
	let initialized = false;
	let capturedActiveTools: readonly string[] | null = null;

	const registerDecisionTools = (): void => {
		if (registered) return;
		registered = true;

		pi.registerTool({
			name: CONTINUE_WATCHDOG_TOOL_NAME,
			label: "Continue Watchdog",
			description: CONTINUE_WATCHDOG_DESCRIPTION,
			promptSnippet: CONTINUE_WATCHDOG_PROMPT_SNIPPET,
			parameters: CONTINUE_WATCHDOG_PARAMETERS,
			...createContinueToolRenderers(options.getContinuePrompt),
			async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
				if (
					!initialized ||
					!options.isCurrentMain() ||
					capturedActiveTools === null
				) {
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
			renderShell: "self",
			...createUnlockToolRenderers(),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				if (
					!initialized ||
					!options.isCurrentMain() ||
					capturedActiveTools === null
				) {
					return staleDecisionToolResult();
				}
				return options.executeUnlock(toolCallId, params.reason, ctx);
			},
		});
	};

	registerDecisionTools();

	return {
		registerDecisionTools,
		initializeDecisionToolsInactive(): boolean {
			if (initialized) return false;

			const activeTools = [...pi.getActiveTools()];
			const inactiveTools = activeTools.filter(
				(name) => !isDecisionToolName(name),
			);
			if (inactiveTools.length !== activeTools.length) {
				pi.setActiveTools(inactiveTools);
			}
			initialized = true;
			return true;
		},
		activateDecisionTools(): boolean {
			if (
				!initialized ||
				!options.isCurrentMain() ||
				capturedActiveTools !== null
			) {
				return false;
			}

			// Exclude decision names so a reactivated definition is never part of the
			// restored normal-tool baseline.
			const baseline = [...pi.getActiveTools()].filter(
				(name) => !isDecisionToolName(name),
			);
			pi.setActiveTools([...DECISION_TOOL_NAMES]);
			capturedActiveTools = baseline;
			return true;
		},
		restoreDecisionTools(): boolean {
			if (capturedActiveTools === null) return false;

			const activeTools = capturedActiveTools;
			pi.setActiveTools([...activeTools]);
			capturedActiveTools = null;
			return true;
		},
		isActive(): boolean {
			return initialized && capturedActiveTools !== null;
		},
		getCapturedActiveTools(): readonly string[] | null {
			return capturedActiveTools === null ? null : [...capturedActiveTools];
		},
	};
}
