export interface ActivityGeneration {
	readonly domainEpoch: string;
	readonly activityGeneration: bigint;
	readonly ownershipGeneration: number;
	readonly localActivityGeneration: number;
}

export type ActivityGraceTimerHandle = object;

export interface ActivityGraceClock {
	setTimeout(callback: () => void, delayMs: number): ActivityGraceTimerHandle;
	clearTimeout(handle: ActivityGraceTimerHandle): void;
	now(): number;
}

export interface ActivityGraceSnapshot {
	readonly phase: "blocked" | "grace" | "ready";
	readonly generation: ActivityGeneration | null;
	readonly deadlineMs: number | null;
}

export interface ActivityGraceCoordinator {
	readonly snapshot: ActivityGraceSnapshot;
	/** Every call replaces the previous candidate, including equal observations. */
	update(input: {
		readonly allIdle: boolean;
		readonly generation: ActivityGeneration;
	}): void;
	invalidate(): void;
	dispose(): void;
}

/** Product invariant: every automatic inquiry waits one complete fixed fence. */
export const INQUIRY_FENCE_MS = 10_000;

const nodeClock: ActivityGraceClock = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
};

export function createActivityGraceCoordinator(options: {
	readonly clock?: ActivityGraceClock;
	readonly onReady: (generation: ActivityGeneration) => void;
}): ActivityGraceCoordinator {
	const clock = options.clock ?? nodeClock;
	let phase: ActivityGraceSnapshot["phase"] = "blocked";
	let generation: ActivityGeneration | null = null;
	let deadlineMs: number | null = null;
	let timer: ActivityGraceTimerHandle | null = null;
	let token = 0;
	let disposed = false;

	const clearTimer = (): void => {
		if (timer !== null) clock.clearTimeout(timer);
		timer = null;
	};

	return {
		get snapshot(): ActivityGraceSnapshot {
			return { phase, generation, deadlineMs };
		},
		update(input): void {
			if (disposed) return;
			const capturedToken = ++token;
			clearTimer();
			generation = input.generation;
			if (!input.allIdle) {
				phase = "blocked";
				deadlineMs = null;
				return;
			}

			phase = "grace";
			deadlineMs = clock.now() + INQUIRY_FENCE_MS;
			const handle = clock.setTimeout(() => {
				if (
					disposed ||
					capturedToken !== token ||
					phase !== "grace" ||
					generation !== input.generation
				) {
					return;
				}
				timer = null;
				phase = "ready";
				deadlineMs = null;
				options.onReady(input.generation);
			}, INQUIRY_FENCE_MS);
			timer = handle;
			if ("unref" in handle && typeof handle.unref === "function") {
				handle.unref();
			}
		},
		invalidate(): void {
			if (disposed) return;
			token += 1;
			clearTimer();
			phase = "blocked";
			deadlineMs = null;
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			token += 1;
			clearTimer();
			phase = "blocked";
			generation = null;
			deadlineMs = null;
		},
	};
}
