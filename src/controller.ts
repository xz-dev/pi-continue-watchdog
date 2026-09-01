/**
 * Pure lock and decision-window state machine.
 *
 * Runtime wiring owns activity generations, grace timers, Pi hooks, and
 * notifications. This controller owns only lock and decision accounting.
 */

export interface LockDecisionControllerConfig {
	readonly maxRetries: number;
}

export interface LockDecisionSnapshot {
	readonly locked: boolean;
	/** Number of valid continue-or-wait outcomes already consumed in this lock cycle. */
	readonly attempt: number;
	readonly exhausted: boolean;
	readonly decisionFailed: boolean;
	readonly invalidDecisionAttempts: number;
	readonly lastInvalidDecisionError: string | null;
	readonly decisionOpen: boolean;
	/** Earliest absolute time when another automatic decision may open. */
	readonly waitUntilMs: number;
}

export type ControllerEffect =
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
	/** Unlocked => fresh lock; locked => strict no-op. */
	ensureLocked(): ControllerTransition;
	unlock(): ControllerTransition;
	onMainUserMessageStart(): ControllerTransition;
	beginDecision(nowMs: number): ControllerTransition;
	recordInvalidDecision(
		decisionId: number,
		error: unknown,
	): ControllerTransition;
	/** Undo a just-recorded non-terminal invalid decision after busy send defer. */
	rollbackInvalidDecision(
		decisionId: number,
		previousAttempts: number,
		previousError: string | null,
	): ControllerTransition;
	recordValidContinue(decisionId: number): ControllerTransition;
	/** Undo a just-recorded continue when its send raced a newly busy Pi. */
	rollbackValidContinue(): ControllerTransition;
	recordValidWait(
		decisionId: number,
		waitUntilMs: number,
	): ControllerTransition;
	/** Undo a just-recorded wait when durable evidence cannot be written. */
	rollbackValidWait(previousWaitUntilMs: number): ControllerTransition;
	recordValidUnlock(decisionId: number): ControllerTransition;
	/** Close a stale decision without consuming attempts or unlocking. */
	invalidateDecision(decisionId: number): ControllerTransition;
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
	decisionOpen: boolean;
	decisionId: number | null;
	waitUntilMs: number;
}

function snapshotOf(state: MutableState): LockDecisionSnapshot {
	return {
		locked: state.locked,
		attempt: state.attempt,
		exhausted: state.exhausted,
		decisionFailed: state.decisionFailed,
		invalidDecisionAttempts: state.invalidDecisionAttempts,
		lastInvalidDecisionError: state.lastInvalidDecisionError,
		decisionOpen: state.decisionOpen,
		waitUntilMs: state.waitUntilMs,
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
		decisionOpen: false,
		decisionId: null,
		waitUntilMs: 0,
	};
}

class PureLockDecisionController implements LockDecisionController {
	private state = initialState();
	private nextDecisionId = 1;
	private readonly maxRetries: number;

	public constructor(config: LockDecisionControllerConfig) {
		this.maxRetries = config.maxRetries;
	}

	public get snapshot(): LockDecisionSnapshot {
		return snapshotOf(this.state);
	}

	public lock(): ControllerTransition {
		const effects = this.clearPendingIntents();
		this.state = { ...initialState(), locked: true };
		effects.push({ kind: "notify", notification: "locked" });
		return this.applied(effects);
	}

	public ensureLocked(): ControllerTransition {
		return this.state.locked ? this.noop() : this.lock();
	}

	/**
	 * Assign locked=false, clear a pending decision, and notify. Attempt,
	 * exhaustion, decisionFailed, and invalid counters remain visible.
	 */
	public unlock(): ControllerTransition {
		const effects = this.clearPendingIntents();
		this.state = {
			...this.state,
			locked: false,
			decisionOpen: false,
			decisionId: null,
			waitUntilMs: 0,
		};
		effects.push({ kind: "notify", notification: "unlocked" });
		return this.applied(effects);
	}

	public onMainUserMessageStart(): ControllerTransition {
		return this.lock();
	}

	public beginDecision(nowMs: number): ControllerTransition {
		if (!this.isDecisionEligible(nowMs)) return this.noop();
		const decisionId = this.nextDecisionId++;
		this.state = {
			...this.state,
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
		if (!this.isCurrentDecision(decisionId)) return this.noop();
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

	public rollbackInvalidDecision(
		decisionId: number,
		previousAttempts: number,
		previousError: string | null,
	): ControllerTransition {
		if (!this.isCurrentDecision(decisionId) || this.state.decisionFailed) {
			return this.noop();
		}
		this.state = {
			...this.state,
			invalidDecisionAttempts: previousAttempts,
			lastInvalidDecisionError: previousError,
		};
		return this.applied([]);
	}

	public recordValidContinue(decisionId: number): ControllerTransition {
		if (!this.isCurrentDecision(decisionId)) return this.noop();
		const attempt = this.state.attempt + 1;
		this.state = {
			...this.state,
			attempt,
			exhausted: attempt >= this.maxRetries,
			invalidDecisionAttempts: 0,
			lastInvalidDecisionError: null,
			decisionOpen: false,
			decisionId: null,
			waitUntilMs: 0,
		};
		return this.applied([{ kind: "restoreDecisionTools", decisionId }]);
	}

	public rollbackValidContinue(): ControllerTransition {
		if (this.state.decisionOpen || this.state.attempt === 0) return this.noop();
		this.state = {
			...this.state,
			attempt: this.state.attempt - 1,
			exhausted: false,
		};
		return this.applied([]);
	}

	public recordValidWait(
		decisionId: number,
		waitUntilMs: number,
	): ControllerTransition {
		if (
			!this.isCurrentDecision(decisionId) ||
			!Number.isSafeInteger(waitUntilMs) ||
			waitUntilMs < 0
		) {
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
			waitUntilMs,
		};
		return this.applied([{ kind: "restoreDecisionTools", decisionId }]);
	}

	public rollbackValidWait(previousWaitUntilMs: number): ControllerTransition {
		if (
			this.state.decisionOpen ||
			this.state.attempt === 0 ||
			!Number.isSafeInteger(previousWaitUntilMs) ||
			previousWaitUntilMs < 0
		) {
			return this.noop();
		}
		this.state = {
			...this.state,
			attempt: this.state.attempt - 1,
			exhausted: false,
			waitUntilMs: previousWaitUntilMs,
		};
		return this.applied([]);
	}

	public invalidateDecision(decisionId: number): ControllerTransition {
		if (!this.isCurrentDecision(decisionId)) return this.noop();
		this.state = {
			...this.state,
			decisionOpen: false,
			decisionId: null,
		};
		return this.applied([{ kind: "restoreDecisionTools", decisionId }]);
	}

	public recordValidUnlock(decisionId: number): ControllerTransition {
		if (!this.isCurrentDecision(decisionId)) return this.noop();
		this.state = {
			...this.state,
			locked: false,
			decisionOpen: false,
			decisionId: null,
			waitUntilMs: 0,
		};
		return this.applied([
			{ kind: "restoreDecisionTools", decisionId },
			{ kind: "notify", notification: "unlocked" },
		]);
	}

	private isDecisionEligible(nowMs: number): boolean {
		return (
			Number.isFinite(nowMs) &&
			this.state.locked &&
			!this.state.exhausted &&
			!this.state.decisionFailed &&
			!this.state.decisionOpen &&
			nowMs >= this.state.waitUntilMs
		);
	}

	private isCurrentDecision(decisionId: number): boolean {
		return this.state.decisionOpen && this.state.decisionId === decisionId;
	}

	private clearPendingIntents(): ControllerEffect[] {
		return this.state.decisionOpen && this.state.decisionId !== null
			? [
					{
						kind: "restoreDecisionTools",
						decisionId: this.state.decisionId,
					},
				]
			: [];
	}

	private applied(effects: readonly ControllerEffect[]): ControllerTransition {
		return { applied: true, snapshot: this.snapshot, effects: [...effects] };
	}

	private noop(): ControllerTransition {
		return { applied: false, snapshot: this.snapshot, effects: [] };
	}
}

/** Construct an in-memory controller from already validated runtime config. */
export function createLockDecisionController(
	config: LockDecisionControllerConfig,
): LockDecisionController {
	return new PureLockDecisionController({ maxRetries: config.maxRetries });
}
