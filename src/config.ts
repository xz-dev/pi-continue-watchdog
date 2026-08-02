/**
 * Built-in defaults, validation, and field-level merge for continue-watchdog config.
 * Precedence: builtins < global < trusted project.
 * Invalid higher-precedence values do not erase valid lower-precedence values.
 *
 * Timer-safe product bounds:
 * - Node setTimeout max is 2^31-1 ms (MAX_TIMER_DELAY_MS).
 * - Retry delay formula: idleDelaySeconds * 1000 * 2^(maxRetries-1).
 * - idleDelaySeconds safe integer in [1, 3600]; maxRetries safe integer in [1, 10].
 * - Worst allowed delay: 3600 * 1000 * 2^9 = 1_843_200_000 <= 2_147_483_647.
 * Invalid values are rejected (no silent clamp).
 */

export const DEFAULT_DECISION_PROMPT =
	"This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. Decide whether work should continue. Call unlock_continue_watchdog with a concise reason if you are intentionally waiting for the user or all tasks are complete. Otherwise call continue_watchdog. Call exactly one tool and do not answer with prose.";

export const DEFAULT_CONTINUE_PROMPT = "Continue until all jobs are done.";

/** Maximum prompt size, measured in Unicode code points, accepted from config. */
export const MAX_PROMPT_CHARACTERS = 16_384;

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

const KNOWN_KEYS = new Set([
	"idleDelaySeconds",
	"maxRetries",
	"decisionPrompt",
	"continuePrompt",
]);

function diagnostic(source: string, message: string): ConfigDiagnostic {
	return { source, message: message.slice(0, MAX_DIAGNOSTIC_LENGTH) };
}

function copyBuiltIn(): ContinueWatchdogConfig {
	return {
		idleDelaySeconds: BUILT_IN_CONFIG.idleDelaySeconds,
		maxRetries: BUILT_IN_CONFIG.maxRetries,
		decisionPrompt: BUILT_IN_CONFIG.decisionPrompt,
		continuePrompt: BUILT_IN_CONFIG.continuePrompt,
	};
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

function validIdleDelaySeconds(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_IDLE_DELAY_SECONDS &&
		value <= MAX_IDLE_DELAY_SECONDS
	);
}

function validMaxRetries(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_RETRIES &&
		value <= MAX_RETRIES
	);
}

/**
 * Count Unicode code points only until the supplied bound is exceeded.
 * Lone surrogate code units count as one code point, matching the string
 * iterator / Array.from behavior.
 */
export function hasAtMostUnicodeCodePoints(
	value: string,
	maximum: number,
): boolean {
	let codePoints = 0;
	for (let index = 0; index < value.length; codePoints += 1) {
		if (codePoints >= maximum) return false;
		const first = value.charCodeAt(index);
		const second = value.charCodeAt(index + 1);
		index +=
			first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
				? 2
				: 1;
	}
	return true;
}

/** Non-blank bounded Unicode string required for configured prompts. */
export function isValidPrompt(value: unknown): value is string {
	return (
		typeof value === "string" &&
		hasAtMostUnicodeCodePoints(value, MAX_PROMPT_CHARACTERS) &&
		value.trim().length > 0
	);
}

/**
 * Validate ordinary config objects (JSON.parse results or plain objects).
 * Own string keys only; invalid fields are omitted with a bounded diagnostic.
 */
export function validateConfig(source: string, value: unknown): ConfigResult {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return {
			config: {},
			diagnostics: [diagnostic(source, "configuration must be an object")],
		};
	}

	const input = value as Record<string, unknown>;
	const config: Partial<ContinueWatchdogConfig> = {};
	const diagnostics: ConfigDiagnostic[] = [];

	if (Object.hasOwn(input, "idleDelaySeconds")) {
		const idle = input.idleDelaySeconds;
		if (validIdleDelaySeconds(idle)) {
			config.idleDelaySeconds = idle;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"idleDelaySeconds must be a safe integer between 1 and 3600",
				),
			);
		}
	}

	if (Object.hasOwn(input, "maxRetries")) {
		const retries = input.maxRetries;
		if (validMaxRetries(retries)) {
			config.maxRetries = retries;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"maxRetries must be a safe integer between 1 and 10",
				),
			);
		}
	}

	if (Object.hasOwn(input, "decisionPrompt")) {
		const decision = input.decisionPrompt;
		if (isValidPrompt(decision)) {
			config.decisionPrompt = decision;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					`decisionPrompt must be a non-empty string of at most ${MAX_PROMPT_CHARACTERS} Unicode characters`,
				),
			);
		}
	}

	if (Object.hasOwn(input, "continuePrompt")) {
		const cont = input.continuePrompt;
		if (isValidPrompt(cont)) {
			config.continuePrompt = cont;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					`continuePrompt must be a non-empty string of at most ${MAX_PROMPT_CHARACTERS} Unicode characters`,
				),
			);
		}
	}

	for (const key of Object.keys(input)) {
		if (!KNOWN_KEYS.has(key)) {
			diagnostics.push(diagnostic(source, "ignoring unsupported keys"));
			break;
		}
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

	const config = copyBuiltIn();
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
