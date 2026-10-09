/**
 * Built-in defaults, validation, and field-level merge for continue-watchdog config.
 * Precedence: builtins < global < trusted project.
 * Invalid higher-precedence values do not erase valid lower-precedence values.
 *
 * Validation:
 * - idleDelaySeconds remains accepted for configuration compatibility only;
 *   automatic inquiries always use the fixed ten-second runtime fence.
 * - maxContinue is a safe integer in [1, 10] (shared continue/callback budget).
 * - reasonTypes and continueReasonTypes are nonempty arrays of trim-nonblank
 *   strings; valid lists replace the defaults.
 * - decisionPrompt and continuePrompt are non-blank bounded Unicode strings.
 * - jevWaitCheck and maxRetries are removed keys: each occurrence reports a
 *   named error diagnostic naming the key only (never values) and has no
 *   effect. maxRetries is not an alias for maxContinue.
 * Invalid values are rejected (no silent clamp).
 */

export const DEFAULT_DECISION_PROMPT =
	"This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. It does not represent any decision by the user. Decide whether work should continue. Before deciding, check whether every task the user requested in this session is complete, including earlier requests and not only the latest one.";

export const DEFAULT_CONTINUE_PROMPT =
	"Continue until user assistance is required.";

/** Built-in allowed AI unlock reason types; a valid configured list replaces these. */
export const DEFAULT_REASON_TYPES: readonly string[] = Object.freeze([
	"JOB_DONE",
	"WAIT_USER",
	"JOB_BLOCKED",
	"WAIT_CALLBACK",
]);

/** Built-in allowed automatic-continue reason types; configured values replace. */
export const DEFAULT_CONTINUE_REASON_TYPES: readonly string[] = Object.freeze([
	"WORK_REMAINS",
	"VERIFYING",
]);

/** Maximum prompt size, measured in Unicode code points, accepted from config. */
export const MAX_PROMPT_CHARACTERS = 16_384;

/** Minimum accepted deprecated idleDelaySeconds compatibility value. */
export const MIN_IDLE_DELAY_SECONDS = 0;

/** Minimum accepted maxContinue (inclusive). */
export const MIN_CONTINUE = 1;

/**
 * Maximum accepted maxContinue (inclusive).
 * Matches the accepted product default budget; higher values are not required.
 */
export const MAX_CONTINUE = 10;

export interface ContinueWatchdogConfig {
	/** @deprecated Accepted and preserved, but the inquiry fence is fixed at 10s. */
	idleDelaySeconds: number;
	/** Shared per-cycle budget for accepted continuations and callback suspensions. */
	maxContinue: number;
	/** Configurable guidance embedded in the fixed watchdog decision prompt. */
	decisionPrompt: string;
	/** Configurable guidance embedded in the fixed automated continuation envelope. */
	continuePrompt: string;
	reasonTypes: readonly string[];
	continueReasonTypes: readonly string[];
	/** Key binding for the human unlock shortcut, or false to disable it. */
	unlockShortcut: string | false;
	/** Third-party review of AI unlock decisions; default on, skipped with a warning when unavailable. */
	unlockReviewEnabled: boolean;
}

export type ConfigLayer = Partial<ContinueWatchdogConfig>;

export interface ConfigDiagnostic {
	source: string;
	message: string;
	severity: "warning" | "error";
}

export interface ConfigResult {
	config: ConfigLayer;
	diagnostics: ConfigDiagnostic[];
}

export interface MergeConfigResult {
	config: ContinueWatchdogConfig;
	diagnostics: ConfigDiagnostic[];
}

export const BUILT_IN_CONFIG: Readonly<ContinueWatchdogConfig> = Object.freeze({
	idleDelaySeconds: 10,
	maxContinue: 10,
	decisionPrompt: DEFAULT_DECISION_PROMPT,
	continuePrompt: DEFAULT_CONTINUE_PROMPT,
	reasonTypes: DEFAULT_REASON_TYPES,
	continueReasonTypes: DEFAULT_CONTINUE_REASON_TYPES,
	unlockShortcut: "alt+u",
	unlockReviewEnabled: true,
});

const MAX_DIAGNOSTIC_LENGTH = 240;

const KNOWN_KEYS = new Set([
	"idleDelaySeconds",
	"maxContinue",
	"decisionPrompt",
	"continuePrompt",
	"reasonTypes",
	"continueReasonTypes",
	"unlockShortcut",
	"unlockReviewEnabled",
]);

/** Removed keys; values never load. Optional replacement hint per key. */
const REMOVED_KEYS: ReadonlyMap<string, string | null> = new Map([
	["jevWaitCheck", null],
	["maxRetries", "maxContinue"],
]);

function diagnostic(
	source: string,
	message: string,
	severity: "warning" | "error" = "warning",
): ConfigDiagnostic {
	return { source, message: message.slice(0, MAX_DIAGNOSTIC_LENGTH), severity };
}

function copyBuiltIn(): ContinueWatchdogConfig {
	return {
		idleDelaySeconds: BUILT_IN_CONFIG.idleDelaySeconds,
		maxContinue: BUILT_IN_CONFIG.maxContinue,
		decisionPrompt: BUILT_IN_CONFIG.decisionPrompt,
		continuePrompt: BUILT_IN_CONFIG.continuePrompt,
		reasonTypes: [...BUILT_IN_CONFIG.reasonTypes],
		continueReasonTypes: [...BUILT_IN_CONFIG.continueReasonTypes],
		unlockShortcut: BUILT_IN_CONFIG.unlockShortcut,
		unlockReviewEnabled: BUILT_IN_CONFIG.unlockReviewEnabled,
	};
}

function validIdleDelaySeconds(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_IDLE_DELAY_SECONDS
	);
}

function validMaxContinue(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_CONTINUE &&
		value <= MAX_CONTINUE
	);
}

/**
 * Valid = nonempty array of strings, each trim-nonblank.
 * Stored entries are trimmed. No identifier regex or artificial limits.
 */
export function normalizeReasonTypes(value: unknown): readonly string[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const normalized: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return null;
		const trimmed = entry.trim();
		if (trimmed.length === 0) return null;
		normalized.push(trimmed);
	}
	return normalized;
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
	const config: ConfigLayer = {};
	const diagnostics: ConfigDiagnostic[] = [];

	if (Object.hasOwn(input, "idleDelaySeconds")) {
		const idle = input.idleDelaySeconds;
		if (validIdleDelaySeconds(idle)) {
			config.idleDelaySeconds = idle;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"idleDelaySeconds must be a finite number greater than or equal to 0",
				),
			);
		}
	}

	if (Object.hasOwn(input, "maxContinue")) {
		const budget = input.maxContinue;
		if (validMaxContinue(budget)) {
			config.maxContinue = budget;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"maxContinue must be a safe integer between 1 and 10",
				),
			);
		}
	}

	for (const [key, replacement] of REMOVED_KEYS) {
		if (!Object.hasOwn(input, key)) continue;
		diagnostics.push(
			diagnostic(
				source,
				replacement === null
					? `${key} was removed and has no effect; remove it from the configuration`
					: `${key} was removed and has no effect; use ${replacement} instead`,
				"error",
			),
		);
	}

	for (const field of ["decisionPrompt", "continuePrompt"] as const) {
		if (!Object.hasOwn(input, field)) continue;
		const prompt = input[field];
		if (isValidPrompt(prompt)) {
			config[field] = prompt;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					`${field} must be a non-empty string of at most ${MAX_PROMPT_CHARACTERS} Unicode characters`,
				),
			);
		}
	}

	for (const field of ["reasonTypes", "continueReasonTypes"] as const) {
		if (!Object.hasOwn(input, field)) continue;
		const reasonTypes = normalizeReasonTypes(input[field]);
		if (reasonTypes !== null) {
			config[field] = reasonTypes;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					`${field} must be a non-empty array of non-blank strings`,
				),
			);
		}
	}

	if (Object.hasOwn(input, "unlockShortcut")) {
		const shortcut = input.unlockShortcut;
		if (
			shortcut === false ||
			(typeof shortcut === "string" && shortcut.trim().length > 0)
		) {
			config.unlockShortcut = shortcut;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"unlockShortcut must be a non-empty key id string or false",
				),
			);
		}
	}

	if (Object.hasOwn(input, "unlockReviewEnabled")) {
		const enabled = input.unlockReviewEnabled;
		if (typeof enabled === "boolean") {
			config.unlockReviewEnabled = enabled;
		} else {
			diagnostics.push(
				diagnostic(source, "unlockReviewEnabled must be a boolean"),
			);
		}
	}

	for (const key of Object.keys(input)) {
		if (!KNOWN_KEYS.has(key) && !REMOVED_KEYS.has(key)) {
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
		if (partial.maxContinue !== undefined) {
			config.maxContinue = partial.maxContinue;
		}
		if (partial.decisionPrompt !== undefined) {
			config.decisionPrompt = partial.decisionPrompt;
		}
		if (partial.continuePrompt !== undefined) {
			config.continuePrompt = partial.continuePrompt;
		}
		if (partial.reasonTypes !== undefined) {
			config.reasonTypes = [...partial.reasonTypes];
		}
		if (partial.continueReasonTypes !== undefined) {
			config.continueReasonTypes = [...partial.continueReasonTypes];
		}
		if (partial.unlockShortcut !== undefined) {
			config.unlockShortcut = partial.unlockShortcut;
		}
		if (partial.unlockReviewEnabled !== undefined) {
			config.unlockReviewEnabled = partial.unlockReviewEnabled;
		}
	}

	return {
		config,
		diagnostics: layers.flatMap((layer) => layer.diagnostics),
	};
}
