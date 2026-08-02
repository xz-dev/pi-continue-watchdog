/**
 * Pure lock and decision-window state machine.
 *
 * Runtime wiring owns timers, Pi hooks, tool registration, and notifications.
 * This controller only records state and emits intents for that wiring.
 */

export interface LockDecisionControllerConfig {
	readonly idleDelaySeconds: number;
	readonly maxRetries: number;
}

export interface IdleTimerIntent {
	readonly id: number;
	readonly attempt: number;
	readonly delaySeconds: number;
}

export interface LockDecisionSnapshot {
	readonly locked: boolean;
	/** Number of valid continue decisions already consumed in this lock cycle. */
	readonly attempt: number;
	readonly exhausted: boolean;
	readonly decisionFailed: boolean;
	readonly invalidDecisionAttempts: number;
	readonly lastInvalidDecisionError: string | null;
	readonly idleTimer: IdleTimerIntent | null;
	readonly decisionOpen: boolean;
}

export type ControllerEffect =
	| {
			readonly kind: "armIdleTimer";
			readonly timerId: number;
			readonly attempt: number;
			readonly delaySeconds: number;
	  }
	| { readonly kind: "cancelIdleTimer"; readonly timerId: number }
	| {
			readonly kind: "openDecisionWindow";
			readonly decisionId: number;
			readonly attempt: number;
	  }
	| { readonly kind: "restoreDecisionTools"; readonly decisionId: number }
	| {
			readonly kind: "reaskDecision";
			readonly decisionId: number;
			readonly invalidDecisionAttempt: 1 | 2;
			readonly error: string;
	  }
	| { readonly kind: "decisionFailed"; readonly error: string }
	| { readonly kind: "notify"; readonly notification: "locked" | "unlocked" };

export interface ControllerTransition {
	readonly applied: boolean;
	readonly snapshot: LockDecisionSnapshot;
	readonly effects: readonly ControllerEffect[];
}

export interface LockDecisionController {
	readonly snapshot: LockDecisionSnapshot;
	lock(): ControllerTransition;
	unlock(): ControllerTransition;
	onMainUserMessageStart(): ControllerTransition;
	onAllObservableIdle(): ControllerTransition;
	onObservableBusy(): ControllerTransition;
	beginDecision(timerId: number): ControllerTransition;
	recordInvalidDecision(
		decisionId: number,
		error: unknown,
	): ControllerTransition;
	recordValidContinue(decisionId: number): ControllerTransition;
	recordValidUnlock(decisionId: number): ControllerTransition;
}

const INVALID_DECISION_LIMIT = 3;
const GENERIC_INVALID_DECISION_ERROR = "Invalid decision.";

interface MutableState {
	locked: boolean;
	attempt: number;
	exhausted: boolean;
	decisionFailed: boolean;
	invalidDecisionAttempts: number;
	lastInvalidDecisionError: string | null;
	idleTimer: IdleTimerIntent | null;
	decisionOpen: boolean;
	decisionId: number | null;
}

function snapshotOf(state: MutableState): LockDecisionSnapshot {
	return {
		locked: state.locked,
		attempt: state.attempt,
		exhausted: state.exhausted,
		decisionFailed: state.decisionFailed,
		invalidDecisionAttempts: state.invalidDecisionAttempts,
		lastInvalidDecisionError: state.lastInvalidDecisionError,
		idleTimer: state.idleTimer ? { ...state.idleTimer } : null,
		decisionOpen: state.decisionOpen,
	};
}

function normaliseInvalidDecisionError(error: unknown): string {
	return typeof error === "string" && error.length > 0
		? error
		: GENERIC_INVALID_DECISION_ERROR;
}

function initialState(): MutableState {
	return {
		locked: false,
		attempt: 0,
		exhausted: false,
		decisionFailed: false,
		invalidDecisionAttempts: 0,
		lastInvalidDecisionError: null,
		idleTimer: null,
		decisionOpen: false,
		decisionId: null,
	};
}

class PureLockDecisionController implements LockDecisionController {
	private state = initialState();
	private nextTimerId = 1;
	private nextDecisionId = 1;
	private readonly idleDelaySeconds: number;
	private readonly maxRetries: number;

	public constructor(config: LockDecisionControllerConfig) {
		this.idleDelaySeconds = config.idleDelaySeconds;
		this.maxRetries = config.maxRetries;
	}

	public get snapshot(): LockDecisionSnapshot {
		return snapshotOf(this.state);
	}

	public lock(): ControllerTransition {
		const effects = this.clearPendingIntents();
		this.state = {
			...initialState(),
			locked: true,
		};
		effects.push({ kind: "notify", notification: "locked" });
		return this.applied(effects);
	}

	public unlock(): ControllerTransition {
		const effects = this.clearPendingIntents();
		this.state = initialState();
		effects.push({ kind: "notify", notification: "unlocked" });
		return this.applied(effects);
	}

	public onMainUserMessageStart(): ControllerTransition {
		return this.lock();
	}

	public onAllObservableIdle(): ControllerTransition {
		if (!this.isIdleTimerEligible()) {
			return this.noop();
		}

		const idleTimer: IdleTimerIntent = {
			id: this.nextTimerId++,
			attempt: this.state.attempt,
			delaySeconds: Math.min(
				this.idleDelaySeconds * 2 ** this.state.attempt,
				Number.MAX_VALUE,
			),
		};
		this.state = { ...this.state, idleTimer };
		return this.applied([
			{
				kind: "armIdleTimer",
				timerId: idleTimer.id,
				attempt: idleTimer.attempt,
				delaySeconds: idleTimer.delaySeconds,
			},
		]);
	}

	public onObservableBusy(): ControllerTransition {
		if (this.state.idleTimer === null) {
			return this.noop();
		}

		const timerId = this.state.idleTimer.id;
		this.state = { ...this.state, idleTimer: null };
		return this.applied([{ kind: "cancelIdleTimer", timerId }]);
	}

	public beginDecision(timerId: number): ControllerTransition {
		if (this.state.idleTimer?.id !== timerId) {
			return this.noop();
		}

		const decisionId = this.nextDecisionId++;
		this.state = {
			...this.state,
			idleTimer: null,
			decisionOpen: true,
			decisionId,
			invalidDecisionAttempts: 0,
			lastInvalidDecisionError: null,
		};
		return this.applied([
			{
				kind: "openDecisionWindow",
				decisionId,
				attempt: this.state.attempt,
			},
		]);
	}

	public recordInvalidDecision(
		decisionId: number,
		error: unknown,
	): ControllerTransition {
		if (!this.isCurrentDecision(decisionId)) {
			return this.noop();
		}

		const normalisedError = normaliseInvalidDecisionError(error);
		const invalidDecisionAttempts = this.state.invalidDecisionAttempts + 1;
		if (invalidDecisionAttempts < INVALID_DECISION_LIMIT) {
			this.state = {
				...this.state,
				invalidDecisionAttempts,
				lastInvalidDecisionError: normalisedError,
			};
			return this.applied([
				{
					kind: "reaskDecision",
					decisionId,
					invalidDecisionAttempt: invalidDecisionAttempts as 1 | 2,
					error: normalisedError,
				},
			]);
		}

		this.state = {
			...this.state,
			decisionOpen: false,
			decisionId: null,
			decisionFailed: true,
			invalidDecisionAttempts: INVALID_DECISION_LIMIT,
			lastInvalidDecisionError: normalisedError,
		};
		return this.applied([
			{ kind: "restoreDecisionTools", decisionId },
			{ kind: "decisionFailed", error: normalisedError },
		]);
	}

	public recordValidContinue(decisionId: number): ControllerTransition {
		if (!this.isCurrentDecision(decisionId)) {
			return this.noop();
		}

		const attempt = this.state.attempt + 1;
		this.state = {
			...this.state,
			attempt,
			exhausted: attempt >= this.maxRetries,
			invalidDecisionAttempts: 0,
			lastInvalidDecisionError: null,
			decisionOpen: false,
			decisionId: null,
		};
		return this.applied([{ kind: "restoreDecisionTools", decisionId }]);
	}

	public recordValidUnlock(decisionId: number): ControllerTransition {
		if (!this.isCurrentDecision(decisionId)) {
			return this.noop();
		}

		this.state = initialState();
		return this.applied([
			{ kind: "restoreDecisionTools", decisionId },
			{ kind: "notify", notification: "unlocked" },
		]);
	}

	private isIdleTimerEligible(): boolean {
		return (
			this.state.locked &&
			!this.state.exhausted &&
			!this.state.decisionFailed &&
			!this.state.decisionOpen &&
			this.state.idleTimer === null
		);
	}

	private isCurrentDecision(decisionId: number): boolean {
		return this.state.decisionOpen && this.state.decisionId === decisionId;
	}

	private clearPendingIntents(): ControllerEffect[] {
		const effects: ControllerEffect[] = [];
		if (this.state.idleTimer !== null) {
			effects.push({
				kind: "cancelIdleTimer",
				timerId: this.state.idleTimer.id,
			});
		}
		if (this.state.decisionOpen && this.state.decisionId !== null) {
			effects.push({
				kind: "restoreDecisionTools",
				decisionId: this.state.decisionId,
			});
		}
		return effects;
	}

	private applied(effects: readonly ControllerEffect[]): ControllerTransition {
		return {
			applied: true,
			snapshot: this.snapshot,
			effects: [...effects],
		};
	}

	private noop(): ControllerTransition {
		return {
			applied: false,
			snapshot: this.snapshot,
			effects: [],
		};
	}
}

/**
 * Construct an in-memory controller from already validated runtime config.
 * No timers, Pi APIs, I/O, or config parsing are performed here.
 */
export function createLockDecisionController(
	config: LockDecisionControllerConfig,
): LockDecisionController {
	return new PureLockDecisionController({
		idleDelaySeconds: config.idleDelaySeconds,
		maxRetries: config.maxRetries,
	});
}
