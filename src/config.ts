/**
 * Built-in defaults, validation, and field-level merge for continue-watchdog config.
 * Precedence: builtins < global < trusted project.
 * Invalid higher-precedence values do not erase valid lower-precedence values.
 *
 * Timer-safe product bounds (independent, conservative):
 * - Node setTimeout max is 2^31-1 ms (MAX_TIMER_DELAY_MS).
 * - Retry delay formula: idleDelaySeconds * 1000 * 2^(maxRetries-1).
 * - idleDelaySeconds safe integer in [1, 3600]; maxRetries safe integer in [1, 10].
 * - Worst allowed delay: 3600 * 1000 * 2^9 = 1_843_200_000 <= 2_147_483_647.
 * Invalid values are rejected (no silent clamp).
 */

export const DEFAULT_DECISION_PROMPT =
	"Decide whether work should continue. Call unlock_continue_watchdog with a concise reason if you are intentionally waiting for the user or all tasks are complete. Otherwise call continue_watchdog. Call exactly one tool and do not answer with prose.";

export const DEFAULT_CONTINUE_PROMPT = "Continue until all jobs are done.";

/** Node.js setTimeout maximum delay in milliseconds (2^31-1). */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Minimum accepted idleDelaySeconds (inclusive). */
export const MIN_IDLE_DELAY_SECONDS = 1;

/**
 * Maximum accepted idleDelaySeconds (inclusive).
 * Chosen so maxRetries=10 always stays within Node timer limits at this idle base.
 */
export const MAX_IDLE_DELAY_SECONDS = 3600;

/** Minimum accepted maxRetries (inclusive). */
export const MIN_RETRIES = 1;

/**
 * Maximum accepted maxRetries (inclusive).
 * Matches the accepted product default budget; higher values are not required.
 */
export const MAX_RETRIES = 10;

export interface ContinueWatchdogConfig {
	idleDelaySeconds: number;
	maxRetries: number;
	decisionPrompt: string;
	continuePrompt: string;
}

export type ConfigInput = Record<string, unknown>;

export interface ConfigDiagnostic {
	source: string;
	message: string;
}

export interface ConfigResult {
	config: Partial<ContinueWatchdogConfig>;
	diagnostics: ConfigDiagnostic[];
}

export interface MergeConfigResult {
	config: ContinueWatchdogConfig;
	diagnostics: ConfigDiagnostic[];
}

export const BUILT_IN_CONFIG: Readonly<ContinueWatchdogConfig> = Object.freeze({
	idleDelaySeconds: 3,
	maxRetries: 10,
	decisionPrompt: DEFAULT_DECISION_PROMPT,
	continuePrompt: DEFAULT_CONTINUE_PROMPT,
});

const MAX_DIAGNOSTIC_LENGTH = 240;

const KNOWN_KEYS = [
	"idleDelaySeconds",
	"maxRetries",
	"decisionPrompt",
	"continuePrompt",
] as const;

function diagnostic(source: string, message: string): ConfigDiagnostic {
	return { source, message: message.slice(0, MAX_DIAGNOSTIC_LENGTH) };
}

/**
 * Longest retry delay for a configured base and retry budget.
 * Formula matches zero-based attempt `idleDelaySeconds * 2^attempt` with
 * final attempt index `maxRetries - 1`.
 */
export function maxConfiguredDelayMs(
	idleDelaySeconds: number,
	maxRetries: number,
): number {
	return idleDelaySeconds * 1000 * 2 ** (maxRetries - 1);
}

/** Safe integer idle delay within the product timer-safe range. */
function validIdleDelaySeconds(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_IDLE_DELAY_SECONDS &&
		value <= MAX_IDLE_DELAY_SECONDS
	);
}

/** Safe integer retry budget within the product timer-safe range. */
function validMaxRetries(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_RETRIES &&
		value <= MAX_RETRIES
	);
}

/** Non-empty string after trim is required for prompts. */
function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function validateConfig(source: string, value: unknown): ConfigResult {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return {
			config: {},
			diagnostics: [diagnostic(source, "configuration must be an object")],
		};
	}

	const input = value as ConfigInput;
	const config: Partial<ContinueWatchdogConfig> = {};
	const diagnostics: ConfigDiagnostic[] = [];

	if (input.idleDelaySeconds !== undefined) {
		if (validIdleDelaySeconds(input.idleDelaySeconds)) {
			config.idleDelaySeconds = input.idleDelaySeconds;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"idleDelaySeconds must be a safe integer between 1 and 3600",
				),
			);
		}
	}

	if (input.maxRetries !== undefined) {
		if (validMaxRetries(input.maxRetries)) {
			config.maxRetries = input.maxRetries;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"maxRetries must be a safe integer between 1 and 10",
				),
			);
		}
	}

	if (input.decisionPrompt !== undefined) {
		if (nonEmptyString(input.decisionPrompt)) {
			config.decisionPrompt = input.decisionPrompt;
		} else {
			diagnostics.push(
				diagnostic(source, "decisionPrompt must be a non-empty string"),
			);
		}
	}

	if (input.continuePrompt !== undefined) {
		if (nonEmptyString(input.continuePrompt)) {
			config.continuePrompt = input.continuePrompt;
		} else {
			diagnostics.push(
				diagnostic(source, "continuePrompt must be a non-empty string"),
			);
		}
	}

	let hasUnknownKey = false;
	for (const key of Object.keys(input)) {
		if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
			hasUnknownKey = true;
			break;
		}
	}
	if (hasUnknownKey) {
		diagnostics.push(diagnostic(source, "ignoring unsupported keys"));
	}

	return { config, diagnostics };
}

export function loadConfigText(source: string, text: string): ConfigResult {
	try {
		return validateConfig(source, JSON.parse(text) as unknown);
	} catch {
		return {
			config: {},
			diagnostics: [
				diagnostic(source, "configuration contains malformed JSON"),
			],
		};
	}
}

export function mergeConfig(
	global?: unknown,
	project?: unknown,
): MergeConfigResult {
	const layers = [
		validateConfig("global", global ?? {}),
		validateConfig("project", project ?? {}),
	];

	const config: ContinueWatchdogConfig = {
		idleDelaySeconds: BUILT_IN_CONFIG.idleDelaySeconds,
		maxRetries: BUILT_IN_CONFIG.maxRetries,
		decisionPrompt: BUILT_IN_CONFIG.decisionPrompt,
		continuePrompt: BUILT_IN_CONFIG.continuePrompt,
	};

	for (const { config: partial } of layers) {
		if (partial.idleDelaySeconds !== undefined) {
			config.idleDelaySeconds = partial.idleDelaySeconds;
		}
		if (partial.maxRetries !== undefined) {
			config.maxRetries = partial.maxRetries;
		}
		if (partial.decisionPrompt !== undefined) {
			config.decisionPrompt = partial.decisionPrompt;
		}
		if (partial.continuePrompt !== undefined) {
			config.continuePrompt = partial.continuePrompt;
		}
	}

	return {
		config,
		diagnostics: layers.flatMap((layer) => layer.diagnostics),
	};
}
