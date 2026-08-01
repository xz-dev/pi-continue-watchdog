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

const nodeFileIO: ConfigFileIO = {
	readFile: (path, encoding) => readFile(path, encoding),
};

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
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return { config: {}, diagnostics: [] };
		}
		const detail = String(error).slice(0, 180);
		return {
			config: {},
			diagnostics: [
				{
					source,
					message: `could not read configuration: ${detail}`.slice(0, 240),
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
		: { config: {}, diagnostics: [] as ConfigDiagnostic[] };

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
