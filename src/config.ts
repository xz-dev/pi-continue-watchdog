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
const INVALID_CONFIG_MESSAGE = "configuration is invalid";

const KNOWN_KEYS = [
	"idleDelaySeconds",
	"maxRetries",
	"decisionPrompt",
	"continuePrompt",
] as const;

function diagnostic(source: string, message: string): ConfigDiagnostic {
	return { source, message: message.slice(0, MAX_DIAGNOSTIC_LENGTH) };
}

type OwnDataRead =
	| { kind: "missing" }
	| { kind: "data"; value: unknown }
	| { kind: "non_data" };

/**
 * Read an own data property without invoking accessors.
 * - missing/inherited-only → missing
 * - own data descriptor (own `value` property on the descriptor) → data
 * - own accessor / non-data descriptor → non_data (never invoke getter)
 *
 * Uses Object.hasOwn(descriptor, "value") so ambient Object.prototype.value
 * pollution cannot reclassify accessor descriptors as data.
 * Descriptor inspection traps may throw (hostile proxy).
 */
function readOwnDataProperty(object: object, key: string): OwnDataRead {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (descriptor === undefined) {
		return { kind: "missing" };
	}
	if (!Object.hasOwn(descriptor, "value")) {
		return { kind: "non_data" };
	}
	return { kind: "data", value: descriptor.value };
}

/**
 * Enumerate own property keys (strings and symbols).
 * Throws when enumeration traps throw (hostile proxy).
 */
function listOwnKeys(object: object): PropertyKey[] {
	return Reflect.ownKeys(object);
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

/**
 * Count Unicode code points only until the supplied bound is exceeded.
 *
 * This deliberately does not allocate a full `Array.from(value)` result for an
 * untrusted config string. Lone surrogate code units count as one code point,
 * matching the string iterator / Array.from behavior.
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

export function validateConfig(source: string, value: unknown): ConfigResult {
	// typeof/null checks are trap-free for ordinary values; Array.isArray and all
	// subsequent shape/descriptor/key inspection can throw on hostile proxies.
	if (value === null || typeof value !== "object") {
		return {
			config: Object.create(null),
			diagnostics: [diagnostic(source, "configuration must be an object")],
		};
	}

	try {
		if (Array.isArray(value)) {
			return {
				config: Object.create(null),
				diagnostics: [diagnostic(source, "configuration must be an object")],
			};
		}

		const input = value as object;
		// null-prototype so missing fields never read ambient Object.prototype pollution.
		const config: Partial<ContinueWatchdogConfig> = Object.create(null);
		const diagnostics: ConfigDiagnostic[] = [];

		const idle = readOwnDataProperty(input, "idleDelaySeconds");
		if (idle.kind === "non_data") {
			return {
				config: Object.create(null),
				diagnostics: [diagnostic(source, INVALID_CONFIG_MESSAGE)],
			};
		}
		if (idle.kind === "data") {
			if (validIdleDelaySeconds(idle.value)) {
				config.idleDelaySeconds = idle.value;
			} else {
				diagnostics.push(
					diagnostic(
						source,
						"idleDelaySeconds must be a safe integer between 1 and 3600",
					),
				);
			}
		}

		const retries = readOwnDataProperty(input, "maxRetries");
		if (retries.kind === "non_data") {
			return {
				config: Object.create(null),
				diagnostics: [diagnostic(source, INVALID_CONFIG_MESSAGE)],
			};
		}
		if (retries.kind === "data") {
			if (validMaxRetries(retries.value)) {
				config.maxRetries = retries.value;
			} else {
				diagnostics.push(
					diagnostic(
						source,
						"maxRetries must be a safe integer between 1 and 10",
					),
				);
			}
		}

		const decision = readOwnDataProperty(input, "decisionPrompt");
		if (decision.kind === "non_data") {
			return {
				config: Object.create(null),
				diagnostics: [diagnostic(source, INVALID_CONFIG_MESSAGE)],
			};
		}
		if (decision.kind === "data") {
			if (isValidPrompt(decision.value)) {
				config.decisionPrompt = decision.value;
			} else {
				diagnostics.push(
					diagnostic(
						source,
						`decisionPrompt must be a non-empty string of at most ${MAX_PROMPT_CHARACTERS} Unicode characters`,
					),
				);
			}
		}

		const cont = readOwnDataProperty(input, "continuePrompt");
		if (cont.kind === "non_data") {
			return {
				config: Object.create(null),
				diagnostics: [diagnostic(source, INVALID_CONFIG_MESSAGE)],
			};
		}
		if (cont.kind === "data") {
			if (isValidPrompt(cont.value)) {
				config.continuePrompt = cont.value;
			} else {
				diagnostics.push(
					diagnostic(
						source,
						`continuePrompt must be a non-empty string of at most ${MAX_PROMPT_CHARACTERS} Unicode characters`,
					),
				);
			}
		}

		const known = KNOWN_KEYS as readonly string[];
		let hasUnsupportedKey = false;
		for (const key of listOwnKeys(input)) {
			// Any own symbol (or non-string key) is unsupported; never coerce/describe.
			if (typeof key !== "string" || !known.includes(key)) {
				hasUnsupportedKey = true;
				break;
			}
		}
		if (hasUnsupportedKey) {
			diagnostics.push(diagnostic(source, "ignoring unsupported keys"));
		}

		return { config, diagnostics };
	} catch {
		// Hostile getters/proxies/revoked proxies during shape inspection must not escape.
		return {
			config: Object.create(null),
			diagnostics: [diagnostic(source, INVALID_CONFIG_MESSAGE)],
		};
	}
}

export function loadConfigText(source: string, text: string): ConfigResult {
	try {
		return validateConfig(source, JSON.parse(text) as unknown);
	} catch {
		return {
			config: Object.create(null),
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
