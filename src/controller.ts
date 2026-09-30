/**
 * Pure lock and attempt state machine.
 *
 * Runtime wiring owns activity generations, grace timers, Pi hooks, and
 * notifications. This controller owns only lock and continuation accounting.
 */

export interface LockDecisionControllerConfig {
	readonly maxRetries: number;
}

export interface LockDecisionSnapshot {
	readonly locked: boolean;
	/** Number of automatic continuations already consumed in this lock cycle. */
	readonly attempt: number;
	readonly exhausted: boolean;
}

export type ControllerEffect = {
	readonly kind: "notify";
	notification: "locked" | "unlocked";
};

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
	/** Consume one automatic-continuation attempt; sets exhausted at the budget. */
	recordAutomaticContinue(): ControllerTransition;
	/** Undo a just-consumed continuation when its message cannot be published. */
	rollbackAutomaticContinue(): ControllerTransition;
	/** AI unlock tool effect: unlock without resetting cycle accounting. */
	recordAiUnlock(): ControllerTransition;
}

interface MutableState {
	locked: boolean;
	attempt: number;
	exhausted: boolean;
}

function snapshotOf(state: MutableState): LockDecisionSnapshot {
	return {
		locked: state.locked,
		attempt: state.attempt,
		exhausted: state.exhausted,
	};
}

function initialState(): MutableState {
	return {
		locked: false,
		attempt: 0,
		exhausted: false,
	};
}

class PureLockDecisionController implements LockDecisionController {
	private state = initialState();
	private readonly maxRetries: number;

	public constructor(config: LockDecisionControllerConfig) {
		this.maxRetries = config.maxRetries;
	}

	public get snapshot(): LockDecisionSnapshot {
		return snapshotOf(this.state);
	}

	public lock(): ControllerTransition {
		this.state = { ...initialState(), locked: true };
		return this.applied([{ kind: "notify", notification: "locked" }]);
	}

	public ensureLocked(): ControllerTransition {
		return this.state.locked ? this.noop() : this.lock();
	}

	/**
	 * Assign locked=false and notify. Attempt and exhaustion remain visible
	 * until the next fresh lock resets the cycle.
	 */
	public unlock(): ControllerTransition {
		this.state = { ...this.state, locked: false };
		return this.applied([{ kind: "notify", notification: "unlocked" }]);
	}

	public onMainUserMessageStart(): ControllerTransition {
		return this.lock();
	}

	public recordAutomaticContinue(): ControllerTransition {
		if (!this.state.locked || this.state.exhausted) return this.noop();
		const attempt = this.state.attempt + 1;
		this.state = {
			...this.state,
			attempt,
			exhausted: attempt >= this.maxRetries,
		};
		return this.applied([]);
	}

	public rollbackAutomaticContinue(): ControllerTransition {
		if (this.state.attempt === 0) return this.noop();
		this.state = {
			...this.state,
			attempt: this.state.attempt - 1,
			exhausted: false,
		};
		return this.applied([]);
	}

	public recordAiUnlock(): ControllerTransition {
		if (!this.state.locked) return this.noop();
		return this.unlock();
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
