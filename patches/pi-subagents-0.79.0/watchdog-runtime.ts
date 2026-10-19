import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createForkContextResolver } from "../shared/fork-context.ts";
import {
	createDefaultChildSessionFactory,
	type ChildHookExtension,
	type ChildSession,
	type ParentProviderRegistry,
} from "../runs/shared/child-session.ts";
import { deriveForkPromptCacheKey } from "../runs/shared/child-tool-plan.ts";
import {
	applyForkSessionAffinity,
	modelBefore,
	projectForkRequest,
	rewriteForkCacheProviderRequest,
	systemMessagesBefore,
} from "../runs/shared/subagent-prompt-runtime.ts";

export interface WatchdogForkInput {
	parent: sdk.ReadonlySessionManager;
	parentProviderRegistry: ParentProviderRegistry;
	cwd: string;
	agentDir: string;
	resultFile: string;
	model: string;
	signal?: AbortSignal;
	projectContext?: (messages: AgentMessage[]) => AgentMessage[];
}

export function createWatchdogRuntime() {
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk });
	return {
		async fork(input: WatchdogForkInput): Promise<ChildSession> {
			if (input.signal?.aborted) throw input.signal.reason;
			const resolver = createForkContextResolver(input.parent, "fork", {
				runDirName: randomUUID,
				openSession: (file, dir) => sdk.SessionManager.open(file, dir, input.cwd),
			});
			await resolver.prepareSessionForIndex();
			const sessionFile = resolver.sessionFileForIndex();
			if (!sessionFile) throw new Error("The private decision requires a full fork.");
			const manager = sdk.SessionManager.open(sessionFile, undefined, input.cwd);
			const forkedAt = Date.parse(manager.getHeader()?.timestamp ?? "");
			if (!Number.isFinite(forkedAt)) throw new Error("Invalid private fork timestamp.");
			const messages = manager.buildSessionProjection().messages;
			// This frozen projection predates child creation; a compaction checkpoint
			// can share the fork's millisecond and still belongs to the parent.
			const inherited = systemMessagesBefore(messages, Number.POSITIVE_INFINITY);
			if (inherited.length === 0) throw new Error("The parent has no inheritable system state.");
			const parentModel = modelBefore(messages, Number.POSITIVE_INFINITY);
			const cacheKey = deriveForkPromptCacheKey(input.parent.getSessionId());
			const resultFile = resolve(input.resultFile);
			let active = false;
			let allowedWrite: string | undefined;
			let attemptError: string | undefined;
			let writeFailure: unknown;
			const writeResult = async (content: string) => {
				const file = await open(resultFile, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					if (!(await file.stat()).isFile()) throw new Error("The decision result must be a regular file.");
					await file.truncate(0);
					await file.writeFile(content, "utf8");
				} finally {
					await file.close();
				}
			};
			const singleResponse: ChildHookExtension = {
				name: "pi-continue-watchdog:single-response",
				factory(pi) {
					const writer = sdk.createWriteToolDefinition(input.cwd, {
						operations: {
							mkdir: async (path) => {
								if (resolve(path) !== dirname(resultFile)) throw new Error("Invalid result directory.");
							},
							writeFile: async (path, content) => {
								if (resolve(path) !== resultFile) throw new Error("Invalid result path.");
								await writeResult(content);
							},
						},
					});
					pi.registerTool({
						...writer,
						async execute(callId, args, signal, onUpdate, ctx) {
							try {
								if (!active || callId !== allowedWrite) throw new Error("No authorized result write.");
								return { ...await writer.execute(callId, args, signal, onUpdate, ctx), terminate: true };
							} catch (error) {
								writeFailure = error;
								return { content: [{ type: "text", text: "Decision result write failed." }], details: undefined, isError: true, terminate: true };
							}
						},
					});
					pi.on("message_end", (event) => {
						const message = event.message;
						if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") return;
						const calls = message.content.filter((block) => block.type === "toolCall");
						const call = calls[0];
						if (calls.length === 1 && call?.name === "write" && message.stopReason !== "length") {
							const args = call.arguments;
							if (args && typeof args === "object" && !Array.isArray(args) && typeof args.path === "string" && typeof args.content === "string" && resolve(input.cwd, args.path) === resultFile) {
								allowedWrite = call.id;
								return;
							}
						}
						attemptError = "Expected exactly one write call to the designated decision result file, with string path and content.";
						return { message: { ...message, content: message.content.filter((block) => block.type !== "toolCall"), stopReason: "stop" } };
					});
				},
			};
			const projection: ChildHookExtension = {
				name: "pi-continue-watchdog:private-fork",
				factory(pi) {
					pi.on("context", (event) => input.projectContext
						? { messages: input.projectContext(event.messages) }
						: undefined);
					pi.on("context_with_system", (event) => ({
						messages: projectForkRequest(event.messages, inherited, forkedAt),
					}));
					pi.on("before_provider_headers", (event, ctx) => {
						applyForkSessionAffinity(event.headers, ctx.model, input.parent.getSessionId(), parentModel);
					});
					pi.on("before_provider_request", (event, ctx) =>
						rewriteForkCacheProviderRequest(event, ctx, cacheKey));
				},
			};
			const child = await factory.create({
				cwd: input.cwd,
				agentDir: input.agentDir,
				projectTrusted: false,
				parentProviderRegistry: input.parentProviderRegistry,
				parentSessionFile: input.parent.getSessionFile(),
				storage: { kind: "file", sessionFile },
				model: input.model,
				signal: input.signal,
				tools: ["write"],
				extensionPaths: [],
				ambientExtensions: false,
				hooks: [singleResponse, projection],
				noSkills: true,
				noContextFiles: true,
				systemPrompt: "",
				runtime: {
					cwd: input.cwd,
					fanoutChild: false,
					depth: 1,
					maxDepth: 1,
					waitTool: { enabled: false },
					fast: false,
				},
			});
			const prompt = child.prompt;
			child.prompt = async (text) => {
				if (active) throw new Error("A private decision response is already running.");
				active = true;
				allowedWrite = undefined;
				attemptError = undefined;
				writeFailure = undefined;
				try {
					await writeResult("{}");
					await prompt(text);
					if (writeFailure) throw writeFailure;
				} finally {
					active = false;
				}
			};
			Object.defineProperty(child, "attemptError", { get: () => attemptError });
			return child;
		},
		dispose: () => factory.dispose(),
	};
}
