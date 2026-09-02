/**
 * Neutral semantic-hook producer helpers.
 *
 * Channel and envelope are plain data only. This module has no product
 * consumer knowledge and does not import pi-notify or any other extension.
 */

/** Shared ResourceLoader-local bus channel for independent extension producers. */
export const SEMANTIC_HOOK_CHANNEL = "pi:semantic-hook:v1";

/** Semantic name published by this producer when the watchdog will not auto-wake. */
export const USER_READY_HOOK_NAME = "user-ready";

/** Semantic name published after an accepted wait is durably recorded. */
export const WATCHDOG_WAITING_HOOK_NAME = "watchdog-waiting";

/** Semantic name published after an accepted continue is durably recorded. */
export const WATCHDOG_CONTINUED_HOOK_NAME = "watchdog-continued";

export type UserReadyStopKind = "AI_UNLOCK" | "EXHAUSTED" | "DECISION_FAILED";

export type SemanticHookValues = Readonly<Record<string, string>>;

export interface SemanticHookEnvelope {
	readonly version: 1;
	readonly name: string;
	readonly values?: SemanticHookValues;
}

export interface UserReadyValues {
	readonly STOP_KIND: UserReadyStopKind;
	/** Present only for AI decision unlock; matched configured type uppercased. */
	readonly REASON_TYPE?: string;
	/** Present only for AI decision unlock; validated trimmed reason. */
	readonly REASON?: string;
}

export interface WatchdogWaitingValues {
	readonly REASON: string;
	readonly WAIT_SECONDS: string;
}

export interface WatchdogContinuedValues {
	readonly REASON_TYPE: string;
	readonly REASON: string;
}

/** Minimal Pi public bus surface used for emission. */
export interface SemanticHookEventBus {
	emit(channel: string, data: unknown): void;
}

function freezeValues(
	values: Record<string, string | undefined>,
): SemanticHookValues {
	const frozen: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) frozen[key] = value;
	}
	return Object.freeze(frozen);
}

/**
 * Build a fresh plain-data `user-ready` envelope. Nested values are frozen so
 * later producer mutations cannot change what listeners already observed.
 */
export function createUserReadyEnvelope(
	values: UserReadyValues,
): SemanticHookEnvelope {
	return Object.freeze({
		version: 1 as const,
		name: USER_READY_HOOK_NAME,
		values: freezeValues({
			STOP_KIND: values.STOP_KIND,
			REASON_TYPE: values.REASON_TYPE,
			REASON: values.REASON,
		}),
	});
}

/** Build a fresh plain-data accepted-wait envelope. */
export function createWatchdogWaitingEnvelope(
	values: WatchdogWaitingValues,
): SemanticHookEnvelope {
	return Object.freeze({
		version: 1 as const,
		name: WATCHDOG_WAITING_HOOK_NAME,
		values: freezeValues({
			REASON: values.REASON,
			WAIT_SECONDS: values.WAIT_SECONDS,
		}),
	});
}

/** Build a fresh plain-data accepted-continue envelope. */
export function createWatchdogContinuedEnvelope(
	values: WatchdogContinuedValues,
): SemanticHookEnvelope {
	return Object.freeze({
		version: 1 as const,
		name: WATCHDOG_CONTINUED_HOOK_NAME,
		values: freezeValues({
			REASON_TYPE: values.REASON_TYPE,
			REASON: values.REASON,
		}),
	});
}

/**
 * Emit one envelope on the public bus. The producer does not inspect listeners,
 * await consumers, acknowledge delivery, retry, or replay.
 */
export function emitSemanticHook(
	events: SemanticHookEventBus,
	envelope: SemanticHookEnvelope,
): void {
	events.emit(SEMANTIC_HOOK_CHANNEL, envelope);
}
