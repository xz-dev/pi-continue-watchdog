export interface ActivityGeneration {
	readonly brokerEpoch: string;
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
	update(input: {
		readonly allIdle: boolean;
		readonly generation: ActivityGeneration;
	}): void;
	invalidate(): void;
	dispose(): void;
}

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const nodeClock: ActivityGraceClock = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
};

function sameGeneration(
	left: ActivityGeneration | null,
	right: ActivityGeneration,
): boolean {
	return (
		left !== null &&
		left.brokerEpoch === right.brokerEpoch &&
		left.activityGeneration === right.activityGeneration &&
		left.ownershipGeneration === right.ownershipGeneration &&
		left.localActivityGeneration === right.localActivityGeneration
	);
}

export function createActivityGraceCoordinator(options: {
	readonly graceSeconds: number;
	readonly clock?: ActivityGraceClock;
	readonly onReady: (generation: ActivityGeneration) => void;
}): ActivityGraceCoordinator {
	const clock = options.clock ?? nodeClock;
	let phase: ActivityGraceSnapshot["phase"] = "blocked";
	let generation: ActivityGeneration | null = null;
	let deadlineMs: number | null = null;
	let timer: ActivityGraceTimerHandle | null = null;
	let token = 0;
	let scheduleToken = 0;
	let disposed = false;

	const clearTimer = (): void => {
		scheduleToken += 1;
		if (timer !== null) clock.clearTimeout(timer);
		timer = null;
	};

	const schedule = (capturedToken: number): void => {
		if (disposed || phase !== "grace" || deadlineMs === null) return;
		const delayMs = Math.min(
			Math.max(0, deadlineMs - clock.now()),
			MAX_TIMER_DELAY_MS,
		);
		const capturedScheduleToken = ++scheduleToken;
		const handle = clock.setTimeout(() => {
			if (
				disposed ||
				capturedToken !== token ||
				capturedScheduleToken !== scheduleToken
			) {
				return;
			}
			timer = null;
			if (deadlineMs !== null && clock.now() < deadlineMs) {
				schedule(capturedToken);
				return;
			}
			if (phase !== "grace" || generation === null) return;
			phase = "ready";
			deadlineMs = null;
			options.onReady(generation);
		}, delayMs);
		timer = handle;
		if ("unref" in handle && typeof handle.unref === "function") {
			handle.unref();
		}
	};

	return {
		get snapshot(): ActivityGraceSnapshot {
			return { phase, generation, deadlineMs };
		},
		update(input): void {
			if (disposed) return;
			if (sameGeneration(generation, input.generation)) {
				if (input.allIdle || phase === "blocked") return;
				token += 1;
				clearTimer();
				phase = "blocked";
				deadlineMs = null;
				return;
			}

			token += 1;
			clearTimer();
			generation = input.generation;
			if (!input.allIdle) {
				phase = "blocked";
				deadlineMs = null;
				return;
			}

			phase = "grace";
			deadlineMs = Math.min(
				clock.now() + options.graceSeconds * 1000,
				Number.MAX_VALUE,
			);
			schedule(token);
		},
		invalidate(): void {
			if (disposed) return;
			token += 1;
			clearTimer();
			phase = "blocked";
			generation = null;
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
