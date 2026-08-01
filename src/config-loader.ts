import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	type ConfigDiagnostic,
	type ContinueWatchdogConfig,
	loadConfigText,
	mergeConfig,
} from "./config.js";

export interface ConfigFileIO {
	readFile(path: string, encoding: "utf8"): Promise<string>;
}

export interface LoadRuntimeConfigOptions {
	cwd: string;
	trusted: boolean;
	/** Injected agent config directory (normally $PI_CODING_AGENT_DIR or ~/.pi/agent). */
	agentDir: string;
	io?: ConfigFileIO;
}

export interface LoadedConfig {
	config: ContinueWatchdogConfig;
	diagnostics: ConfigDiagnostic[];
}

const CONFIG_FILE_NAME = "pi-continue-watchdog.json";
const PROJECT_CONFIG_DIR = ".pi";
const READ_FAILURE_MESSAGE = "could not read configuration";

const nodeFileIO: ConfigFileIO = {
	readFile: (path, encoding) => readFile(path, encoding),
};

/**
 * True only when `error` is a non-null object with an own data property
 * `code` whose stored value is exactly `"ENOENT"`.
 * Never invokes getters/proxies; any inspection failure is non-silent.
 */
function isSilentMissing(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "code");
		// Require an own data `value` on the descriptor — never `in`, so ambient
		// Object.prototype.value pollution cannot reclassify accessors as data.
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
			return false;
		}
		return descriptor.value === "ENOENT";
	} catch {
		return false;
	}
}

async function readConfig(
	path: string,
	source: string,
	io: ConfigFileIO,
): Promise<{
	config: Partial<ContinueWatchdogConfig>;
	diagnostics: ConfigDiagnostic[];
}> {
	try {
		return loadConfigText(source, await io.readFile(path, "utf8"));
	} catch (error) {
		if (isSilentMissing(error)) {
			return { config: Object.create(null), diagnostics: [] };
		}
		return {
			config: Object.create(null),
			diagnostics: [
				{
					source,
					message: READ_FAILURE_MESSAGE,
				},
			],
		};
	}
}

/**
 * Load effective continue-watchdog config from global + trusted-project files.
 * Does not read process.env itself: callers inject agentDir (from PI_CODING_AGENT_DIR / getAgentDir).
 */
export async function loadRuntimeConfig(
	options: LoadRuntimeConfigOptions,
): Promise<LoadedConfig> {
	const io = options.io ?? nodeFileIO;
	const global = await readConfig(
		join(options.agentDir, CONFIG_FILE_NAME),
		"global",
		io,
	);
	const project = options.trusted
		? await readConfig(
				join(options.cwd, PROJECT_CONFIG_DIR, CONFIG_FILE_NAME),
				"project",
				io,
			)
		: { config: Object.create(null), diagnostics: [] as ConfigDiagnostic[] };

	const merged = mergeConfig(global.config, project.config);
	return {
		config: merged.config,
		diagnostics: [
			...global.diagnostics,
			...project.diagnostics,
			...merged.diagnostics,
		],
	};
}
