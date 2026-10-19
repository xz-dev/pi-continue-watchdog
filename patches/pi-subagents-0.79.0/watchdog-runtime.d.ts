import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ModelRuntime,
	ReadonlySessionManager,
} from "@earendil-works/pi-coding-agent";

export interface WatchdogForkInput {
	parent: ReadonlySessionManager;
	parentProviderRegistry: Pick<ModelRuntime, "getRegisteredProviderIds" | "getRegisteredProviderConfig" | "getRegisteredNativeProvider">;
	cwd: string;
	agentDir: string;
	resultFile: string;
	model: string;
	signal?: AbortSignal;
	projectContext?: (messages: AgentMessage[]) => AgentMessage[];
}

export interface WatchdogChildSession {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
	readonly messages: readonly AgentMessage[];
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly modelId: string | undefined;
	readonly inheritedProvider?: string;
	readonly attemptError?: string;
}

export interface WatchdogRuntime {
	fork(input: WatchdogForkInput): Promise<WatchdogChildSession>;
	dispose(): Promise<void>;
}

export declare function createWatchdogRuntime(): WatchdogRuntime;
