/**
 * Built-in defaults, validation, and field-level merge for continue-watchdog config.
 * Precedence: builtins < global < trusted project.
 * Invalid higher-precedence values do not erase valid lower-precedence values.
 *
 * Validation:
 * - idleDelaySeconds remains accepted for configuration compatibility only;
 *   the idle fence is fixed at ten seconds.
 * - maxRetries remains a safe integer in [1, 10].
 * - reasonTypes is a nonempty array of trim-nonblank strings; a valid list
 *   replaces the default.
 * - decisionPrompt and continueReasonTypes are removed keys: each occurrence
 *   reports a named error diagnostic and has no effect.
 * - jevWaitCheck is validated per field; its apiKey is global-only and a
 *   project-layer apiKey is ignored with a diagnostic.
 * Invalid values are rejected (no silent clamp).
 */

export const DEFAULT_CONTINUE_PROMPT =
	"Continue until user assistance is required.";

/** Built-in allowed AI unlock reason types; a valid configured list replaces these. */
export const DEFAULT_REASON_TYPES: readonly string[] = Object.freeze([
	"JOB_DONE",
	"WAIT_USER",
	"JOB_BLOCKED",
]);

/** Maximum prompt size, measured in Unicode code points, accepted from config. */
export const MAX_PROMPT_CHARACTERS = 16_384;

/** Minimum accepted deprecated idleDelaySeconds compatibility value. */
export const MIN_IDLE_DELAY_SECONDS = 0;

/** Minimum accepted maxRetries (inclusive). */
export const MIN_RETRIES = 1;

/**
 * Maximum accepted maxRetries (inclusive).
 * Matches the accepted product default budget; higher values are not required.
 */
export const MAX_RETRIES = 10;

/** Minimum accepted jevWaitCheck.timeoutMs (inclusive). */
export const MIN_JEV_TIMEOUT_MS = 1_000;

/** jev classification of the final assistant output before a continuation. */
export interface JevWaitCheckConfig {
	enabled: boolean;
	/** TypeSafe or OpenRouter System One endpoint; unset = automatic selection. */
	apiUrl?: string;
	model: string;
	confidenceThreshold: number;
	timeoutMs: number;
	/** Global-only fallback key. */
	apiKey?: string;
}

export const BUILT_IN_JEV_WAIT_CHECK: Readonly<JevWaitCheckConfig> =
	Object.freeze({
		enabled: true,
		model: "jev-latest",
		confidenceThreshold: 0.8,
		timeoutMs: 15_000,
	});

export interface ContinueWatchdogConfig {
	/** @deprecated Accepted and preserved, but the idle fence is fixed at 10s. */
	idleDelaySeconds: number;
	maxRetries: number;
	/** Configurable guidance embedded in the fixed automated continuation envelope. */
	continuePrompt: string;
	reasonTypes: readonly string[];
	/** Key binding for the human unlock shortcut, or false to disable it. */
	unlockShortcut: string | false;
	/** Omitted = built-in defaults. */
	jevWaitCheck?: JevWaitCheckConfig;
}

/** One validated layer; nested jevWaitCheck fields merge individually. */
export type ConfigLayer = Partial<
	Omit<ContinueWatchdogConfig, "jevWaitCheck">
> & {
	jevWaitCheck?: Partial<JevWaitCheckConfig>;
};

export type ConfigDiagnosticSeverity = "warning" | "error";

export interface ConfigDiagnostic {
	source: string;
	message: string;
	/** Removed-key diagnostics are errors; everything else stays a warning. */
	severity: ConfigDiagnosticSeverity;
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
	maxRetries: 10,
	continuePrompt: DEFAULT_CONTINUE_PROMPT,
	reasonTypes: DEFAULT_REASON_TYPES,
	unlockShortcut: "alt+u",
	jevWaitCheck: BUILT_IN_JEV_WAIT_CHECK,
});

const MAX_DIAGNOSTIC_LENGTH = 240;

const KNOWN_KEYS = new Set([
	"idleDelaySeconds",
	"maxRetries",
	"continuePrompt",
	"reasonTypes",
	"unlockShortcut",
	"jevWaitCheck",
]);

const JEV_KEYS = new Set([
	"enabled",
	"apiUrl",
	"model",
	"confidenceThreshold",
	"timeoutMs",
	"apiKey",
]);

/** Keys removed by the unlock-tool change; configured values have no effect. */
const REMOVED_KEYS: ReadonlySet<string> = new Set([
	"decisionPrompt",
	"continueReasonTypes",
]);

function diagnostic(
	source: string,
	message: string,
	severity: ConfigDiagnosticSeverity = "warning",
): ConfigDiagnostic {
	return { source, message: message.slice(0, MAX_DIAGNOSTIC_LENGTH), severity };
}

function copyBuiltIn(): ContinueWatchdogConfig {
	return {
		idleDelaySeconds: BUILT_IN_CONFIG.idleDelaySeconds,
		maxRetries: BUILT_IN_CONFIG.maxRetries,
		continuePrompt: BUILT_IN_CONFIG.continuePrompt,
		reasonTypes: [...BUILT_IN_CONFIG.reasonTypes],
		unlockShortcut: BUILT_IN_CONFIG.unlockShortcut,
		jevWaitCheck: { ...BUILT_IN_JEV_WAIT_CHECK },
	};
}

const nonBlank = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

function isHttpUrl(value: unknown): value is string {
	if (!nonBlank(value)) return false;
	try {
		const { protocol } = new URL(value.trim());
		return protocol === "https:" || protocol === "http:";
	} catch {
		return false;
	}
}

/** Per-field jevWaitCheck validation; project layers cannot set apiKey. */
function validateJevWaitCheck(
	source: string,
	value: unknown,
	diagnostics: ConfigDiagnostic[],
): Partial<JevWaitCheckConfig> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(diagnostic(source, "jevWaitCheck must be an object"));
		return {};
	}
	const input = value as Record<string, unknown>;
	const out: Partial<JevWaitCheckConfig> = {};
	const reject = (message: string): void => {
		diagnostics.push(diagnostic(source, `jevWaitCheck.${message}`));
	};
	if (Object.hasOwn(input, "enabled")) {
		if (typeof input.enabled === "boolean") out.enabled = input.enabled;
		else reject("enabled must be a boolean");
	}
	if (Object.hasOwn(input, "apiUrl")) {
		if (isHttpUrl(input.apiUrl)) out.apiUrl = input.apiUrl.trim();
		else reject("apiUrl must be an http(s) URL");
	}
	if (Object.hasOwn(input, "model")) {
		if (nonBlank(input.model)) out.model = input.model.trim();
		else reject("model must be a non-empty string");
	}
	if (Object.hasOwn(input, "confidenceThreshold")) {
		const threshold = input.confidenceThreshold;
		if (
			typeof threshold === "number" &&
			Number.isFinite(threshold) &&
			threshold >= 0 &&
			threshold <= 1
		) {
			out.confidenceThreshold = threshold;
		} else {
			reject("confidenceThreshold must be a number between 0 and 1");
		}
	}
	if (Object.hasOwn(input, "timeoutMs")) {
		const timeout = input.timeoutMs;
		if (
			Number.isSafeInteger(timeout) &&
			(timeout as number) >= MIN_JEV_TIMEOUT_MS
		) {
			out.timeoutMs = timeout as number;
		} else {
			reject(`timeoutMs must be an integer of at least ${MIN_JEV_TIMEOUT_MS}`);
		}
	}
	if (Object.hasOwn(input, "apiKey")) {
		if (source === "project") {
			reject("apiKey is ignored in project configuration; set it globally");
		} else if (nonBlank(input.apiKey)) {
			out.apiKey = input.apiKey.trim();
		} else {
			reject("apiKey must be a non-empty string");
		}
	}
	if (Object.keys(input).some((key) => !JEV_KEYS.has(key))) {
		reject("contains unsupported keys that are ignored");
	}
	return out;
}

function validIdleDelaySeconds(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_IDLE_DELAY_SECONDS
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

	for (const key of REMOVED_KEYS) {
		if (!Object.hasOwn(input, key)) continue;
		diagnostics.push(
			diagnostic(
				source,
				`${key} was removed and has no effect; remove it from the configuration`,
				"error",
			),
		);
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

	if (Object.hasOwn(input, "reasonTypes")) {
		const reasonTypes = normalizeReasonTypes(input.reasonTypes);
		if (reasonTypes !== null) {
			config.reasonTypes = reasonTypes;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"reasonTypes must be a non-empty array of non-blank strings",
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

	if (Object.hasOwn(input, "jevWaitCheck")) {
		const jev = validateJevWaitCheck(source, input.jevWaitCheck, diagnostics);
		if (Object.keys(jev).length > 0) config.jevWaitCheck = jev;
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
		if (partial.maxRetries !== undefined) {
			config.maxRetries = partial.maxRetries;
		}
		if (partial.continuePrompt !== undefined) {
			config.continuePrompt = partial.continuePrompt;
		}
		if (partial.reasonTypes !== undefined) {
			config.reasonTypes = [...partial.reasonTypes];
		}
		if (partial.unlockShortcut !== undefined) {
			config.unlockShortcut = partial.unlockShortcut;
		}
		if (partial.jevWaitCheck !== undefined) {
			const jev = { ...(config.jevWaitCheck ?? BUILT_IN_JEV_WAIT_CHECK) };
			for (const [key, value] of Object.entries(partial.jevWaitCheck)) {
				if (value !== undefined) Object.assign(jev, { [key]: value });
			}
			config.jevWaitCheck = jev;
		}
	}

	return {
		config,
		diagnostics: layers.flatMap((layer) => layer.diagnostics),
	};
}
