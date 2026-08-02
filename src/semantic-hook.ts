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

export type UserReadyStopKind = "AI_UNLOCK" | "EXHAUSTED" | "DECISION_FAILED";

export type SemanticHookValues = Readonly<Record<string, string>>;

export interface SemanticHookEnvelope {
	readonly version: 1;
	readonly name: string;
	readonly values?: SemanticHookValues;
}

export interface UserReadyValues {
	readonly STOP_KIND: UserReadyStopKind;
	readonly REASON?: string;
}

/** Minimal Pi public bus surface used for emission. */
export interface SemanticHookEventBus {
	emit(channel: string, data: unknown): void;
}

function freezeValues(values: UserReadyValues): SemanticHookValues {
	const frozen: Record<string, string> = { STOP_KIND: values.STOP_KIND };
	if (values.REASON !== undefined) {
		frozen.REASON = values.REASON;
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
		values: freezeValues(values),
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
