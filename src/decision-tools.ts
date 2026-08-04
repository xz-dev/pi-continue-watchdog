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
	"Select unlock during the automated pi-continue-watchdog decision check. This check is extension automation, not a user request. Provide an allowed reasonType and a concise, clear one-sentence reason that is non-empty and at most 500 characters.";

export const UNLOCK_CONTINUE_WATCHDOG_PROMPT_SNIPPET =
	"Select unlock with an allowed reasonType and a concise reason for an automated pi-continue-watchdog decision check, not a user request.";

/** A fixed response when a stale decision tool execution cannot control main state. */
export const STALE_DECISION_TOOL_MESSAGE =
	"This pi-continue-watchdog decision window is no longer active.";

const CONTINUE_WATCHDOG_PARAMETERS = Type.Object(
	{},
	{ additionalProperties: false },
);

/** Append the effective allowed reasonType list to the stable unlock base description. */
export function formatUnlockDecisionToolDescription(
	reasonTypes: readonly string[],
): string {
	return `${UNLOCK_CONTINUE_WATCHDOG_DESCRIPTION} Allowed reasonType values: ${reasonTypes.join(", ")}.`;
}

function createUnlockDecisionParameters(reasonTypes: readonly string[]) {
	return Type.Object(
		{
			reasonType: Type.String({
				description: `Allowed reasonType values: ${reasonTypes.join(", ")}.`,
			}),
			reason: Type.String({ minLength: 1, maxLength: 500 }),
		},
		{ additionalProperties: false },
	);
}

export type DecisionToolKind = "continue" | "unlock";

/** A tool call handed to the decision protocol executor (raw args for unlock). */
export interface DecisionToolCall {
	readonly kind: DecisionToolKind;
	/** Present for unlock; raw model-supplied value, not yet protocol-normalized. */
	readonly reasonType?: string;
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
		reasonType: string,
		reason: string,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
}

export interface DecisionToolActivationOptions extends DecisionToolExecutors {
	/** Main ownership is live and may change after a decision window opens. */
	readonly isCurrentMain: () => boolean;
	/** Reads the effective config when Pi renders a valid continue decision. */
	readonly getContinuePrompt: () => string;
	/**
	 * Effective allowed reasonTypes at first main decision registration.
	 * Definitions register once; the description/schema capture this snapshot then.
	 */
	readonly getReasonTypes: () => readonly string[];
}

export interface DecisionToolActivation {
	/**
	 * Marks active-tool management ready without registering decision definitions.
	 * Runtime wiring invokes this for every attachment from `session_start`.
	 */
	readonly initializeDecisionToolsInactive: () => boolean;
	/**
	 * Snapshot currently active normal tools and replace them with exactly the pair.
	 * `stillOwns` is the exact current-main claim fence from the caller (typically
	 * `{attachmentId,generation}`); it is revalidated around every re-entrant Pi
	 * call. Inert until initialization succeeds, when already active, or when the
	 * claim is already stale. On mid-activation demotion restores the baseline
	 * best-effort and returns false without leaving the decision pair active.
	 */
	readonly activateDecisionTools: (stillOwns: () => boolean) => boolean;
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
			reasonType: string,
			reason: string,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			return executor.onDecisionToolCall({
				kind: "unlock",
				reasonType,
				reason,
				toolCallId,
				ctx,
			});
		},
	};
}

/**
 * Lazily registers the decision definitions and owns their temporary active-set
 * visibility. Pi has no public unregister API, so after the first main-agent
 * decision the definitions remain registered but model-invisible outside the
 * narrow decision request window.
 */
export function createDecisionToolActivation(
	pi: ExtensionAPI,
	options: DecisionToolActivationOptions,
): DecisionToolActivation {
	let registeredContinue = false;
	let registeredUnlock = false;
	let initialized = false;
	let capturedActiveTools: readonly string[] | null = null;

	const registerContinueTool = (): void => {
		if (registeredContinue) return;
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
		registeredContinue = true;
	};

	const registerUnlockTool = (): void => {
		if (registeredUnlock) return;
		const reasonTypes = options.getReasonTypes();
		pi.registerTool({
			name: UNLOCK_CONTINUE_WATCHDOG_TOOL_NAME,
			label: "Unlock Continue Watchdog",
			description: formatUnlockDecisionToolDescription(reasonTypes),
			promptSnippet: UNLOCK_CONTINUE_WATCHDOG_PROMPT_SNIPPET,
			parameters: createUnlockDecisionParameters(reasonTypes),
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
				// Forward raw model args; protocol owns case-insensitive type matching.
				return options.executeUnlock(
					toolCallId,
					params.reasonType,
					params.reason,
					ctx,
				);
			},
		});
		registeredUnlock = true;
	};

	/**
	 * Best-effort return to the pre-activation normal-tool baseline. Clears the
	 * capture when restore succeeds so a later cleanup path is not left holding
	 * a phantom active window. Keeps the capture when setActiveTools throws so a
	 * later restoreDecisionTools call can retry.
	 */
	const abandonActivation = (baseline: readonly string[]): false => {
		try {
			pi.setActiveTools([...baseline]);
			capturedActiveTools = null;
		} catch {
			// Retain the capture so a later cleanup attempt can restore it.
		}
		return false;
	};

	return {
		initializeDecisionToolsInactive(): boolean {
			if (initialized) return false;

			initialized = true;
			return true;
		},
		activateDecisionTools(stillOwns: () => boolean): boolean {
			if (!initialized || capturedActiveTools !== null || !stillOwns()) {
				return false;
			}

			// Capture the normal baseline before registration because stock Pi activates
			// newly registered custom tools by default. Revalidate around the read in
			// case getActiveTools is itself re-entrant.
			if (!stillOwns()) return false;
			const baseline = [...pi.getActiveTools()].filter(
				(name) => !isDecisionToolName(name),
			);
			if (!stillOwns()) return false;

			// Publish the captured baseline before registration so any partial
			// registration or demotion can restore the exact pre-activation set.
			capturedActiveTools = baseline;
			try {
				if (!stillOwns()) return abandonActivation(baseline);
				registerContinueTool();
				// Stop before the second definition when the first registration demoted us.
				if (!stillOwns()) return abandonActivation(baseline);
				registerUnlockTool();
				if (!stillOwns()) return abandonActivation(baseline);

				if (!stillOwns()) return abandonActivation(baseline);
				pi.setActiveTools([...DECISION_TOOL_NAMES]);
				if (!stillOwns()) return abandonActivation(baseline);
			} catch (error) {
				try {
					pi.setActiveTools([...baseline]);
					capturedActiveTools = null;
				} catch {
					// Retain the capture so a later cleanup attempt can restore it.
				}
				throw error;
			}
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
