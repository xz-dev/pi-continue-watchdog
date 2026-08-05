import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FATAL_EXIT_CODE, isProcessDomainFatalError } from "pi-process-domain";

const FALLBACK_DELAY_MS = 1_000;

export interface FatalExitProcess {
	exitCode: number | undefined;
	once(event: "exit", listener: (code: number) => void): unknown;
	off(event: "exit", listener: (code: number) => void): unknown;
	exit(code: number): never | undefined;
}

export interface FatalExitClock {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface FatalExitAdapter {
	fail(error: Error, ctx: ExtensionContext): void;
	completeShutdown(): void;
}

export function sanitizedProcessDomainError(error: Error): string {
	const code = isProcessDomainFatalError(error)
		? error.code
		: "DOMAIN_UNRECOVERABLE";
	return `Continue watchdog process domain failed (${code}). The Pi process will exit.`;
}

export function createFatalExitAdapter(options?: {
	readonly process?: FatalExitProcess;
	readonly clock?: FatalExitClock;
}): FatalExitAdapter {
	const processAdapter = options?.process ?? process;
	const clock = options?.clock ?? {
		setTimeout: (callback: () => void, delayMs: number) =>
			setTimeout(callback, delayMs),
		clearTimeout: (handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	let fallback: unknown | null = null;
	let exitListener: ((code: number) => void) | null = null;
	let failed = false;

	return {
		fail(error, ctx): void {
			if (failed) return;
			failed = true;
			processAdapter.exitCode = FATAL_EXIT_CODE;
			exitListener = () => {
				processAdapter.exitCode = FATAL_EXIT_CODE;
			};
			processAdapter.once("exit", exitListener);
			const message = sanitizedProcessDomainError(error);
			try {
				ctx.ui.notify(message, "error");
			} catch {
				console.error(message);
			}
			try {
				ctx.abort();
			} catch {
				// No active model run is also a valid fatal startup state.
			}
			if (ctx.mode === "tui" || ctx.mode === "rpc") {
				try {
					ctx.shutdown();
				} catch {
					// Bounded direct exit remains authoritative.
				}
			}
			fallback = clock.setTimeout(
				() => processAdapter.exit(FATAL_EXIT_CODE),
				FALLBACK_DELAY_MS,
			);
		},
		completeShutdown(): void {
			if (failed) processAdapter.exitCode = FATAL_EXIT_CODE;
			if (fallback !== null) {
				clock.clearTimeout(fallback);
				fallback = null;
			}
			if (exitListener !== null) {
				processAdapter.off("exit", exitListener);
				exitListener = null;
			}
		},
	};
}
