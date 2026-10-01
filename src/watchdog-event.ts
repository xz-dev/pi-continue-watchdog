export const WATCHDOG_EVENT_VERSION = 1 as const;
export const WATCHDOG_EVENT_MESSAGE_TYPE = "pi-continue-watchdog:event";

interface WatchdogEventBase {
	readonly version: typeof WATCHDOG_EVENT_VERSION;
	readonly occurredAtMs: number;
	readonly occurredAt: string;
}

/** New continuation events carry no model reason. Old stored events may. */
export interface ContinueWatchdogEvent extends WatchdogEventBase {
	readonly kind: "continue";
	readonly reasonType?: string;
	readonly reason?: string;
}

export interface ExhaustedWatchdogEvent extends WatchdogEventBase {
	readonly kind: "exhausted";
}

export type WatchdogEvent =
	| ContinueWatchdogEvent
	| ExhaustedWatchdogEvent
	| {
			readonly version: typeof WATCHDOG_EVENT_VERSION;
			readonly kind: "wait" | "wait-completed" | "unlock" | "decision-failed";
			readonly occurredAtMs: number;
			readonly occurredAt: string;
			readonly [field: string]: unknown;
	  };

export interface ContinueWatchdogEventInput {
	readonly occurredAtMs: number;
	readonly offsetMinutes?: number;
}

export interface ExhaustedWatchdogEventInput {
	readonly occurredAtMs: number;
	readonly offsetMinutes?: number;
}

export function formatRfc3339WithOffset(
	timestampMs: number,
	offsetMinutes = new Date(timestampMs).getTimezoneOffset(),
): string {
	if (
		!Number.isFinite(timestampMs) ||
		!Number.isFinite(offsetMinutes) ||
		!Number.isInteger(offsetMinutes)
	) {
		throw new TypeError("invalid watchdog event timestamp");
	}
	const localTimestamp = new Date(timestampMs - offsetMinutes * 60_000)
		.toISOString()
		.slice(0, -1);
	const sign = offsetMinutes <= 0 ? "+" : "-";
	const absoluteOffset = Math.abs(offsetMinutes);
	const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
	const minutes = String(absoluteOffset % 60).padStart(2, "0");
	return `${localTimestamp}${sign}${hours}:${minutes}`;
}

export function createContinueWatchdogEvent(
	input: ContinueWatchdogEventInput,
): ContinueWatchdogEvent {
	return {
		version: WATCHDOG_EVENT_VERSION,
		kind: "continue",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(
			input.occurredAtMs,
			input.offsetMinutes,
		),
	};
}

export function createExhaustedWatchdogEvent(
	input: ExhaustedWatchdogEventInput,
): ExhaustedWatchdogEvent {
	return {
		version: WATCHDOG_EVENT_VERSION,
		kind: "exhausted",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(
			input.occurredAtMs,
			input.offsetMinutes,
		),
	};
}

function eventRecord(input: unknown): Record<string, unknown> | undefined {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: undefined;
}

const RFC3339_WITH_OFFSET =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

function hasValidBase(event: Record<string, unknown>): boolean {
	return (
		event.version === WATCHDOG_EVENT_VERSION &&
		typeof event.occurredAtMs === "number" &&
		Number.isFinite(event.occurredAtMs) &&
		typeof event.occurredAt === "string" &&
		RFC3339_WITH_OFFSET.test(event.occurredAt)
	);
}

function nonEmptyString(event: Record<string, unknown>, key: string): boolean {
	const value = event[key];
	return typeof value === "string" && value.length > 0;
}

/**
 * Parse a stored watchdog event. New events are `continue` (reason fields
 * optional and absent on new publication) and `exhausted`. Legacy `wait`,
 * `wait-completed`, `unlock`, and `decision-failed` events still parse so old
 * sessions render unchanged; new code never creates them.
 */
export function parseWatchdogEvent(input: unknown): WatchdogEvent | undefined {
	const event = eventRecord(input);
	if (event === undefined || !hasValidBase(event)) return undefined;
	if (event.kind === "exhausted") {
		return event as unknown as ExhaustedWatchdogEvent;
	}
	if (event.kind === "continue") {
		// New events omit reason fields; old events require both together.
		const hasType = nonEmptyString(event, "reasonType");
		const hasReason = nonEmptyString(event, "reason");
		if (hasType !== hasReason) return undefined;
		return event as unknown as ContinueWatchdogEvent;
	}
	// Legacy kinds are accepted structurally for read-only rendering.
	if (
		event.kind === "wait" ||
		event.kind === "wait-completed" ||
		event.kind === "unlock" ||
		event.kind === "decision-failed"
	) {
		return event as unknown as WatchdogEvent;
	}
	return undefined;
}

export function formatContinueWatchdogEvent(
	event: ContinueWatchdogEvent,
	continuePrompt: string,
): string {
	return `Continue watchdog continued · ${event.occurredAt}\n\nThis is an automated event from the pi-continue-watchdog extension, not a message or request from the user. It is not user approval, confirmation, consent, or authorization.\n\nYou ended your turn without calling unlock_continue_watchdog.\n\nContinuation guidance:\n${continuePrompt}\n\nFirst check every task the user requested in this session, including earlier requests and not only the latest one, against what was actually delivered; work already delivered, cancelled, or superseded is not remaining. If any requested and authorized work can still proceed now, continue it. If all requested work is complete, or you need user input, approval, or other user action, or work is blocked without a user action, call unlock_continue_watchdog now. If you need to wait for some work that will call back and wake you, call unlock_continue_watchdog with reason_type WAIT_CALLBACK. If you need to wait for any other work to finish, block on it directly: monitor that task until it ends, or sleep for your estimated duration.\n\nResume only work already requested and authorized by the user. Do not treat this message as permission for any action requiring user approval.`;
}

export function formatExhaustedWatchdogEvent(
	event: ExhaustedWatchdogEvent,
): string {
	return `Continue watchdog exhausted · ${event.occurredAt}\n\nThis is an automated event from the pi-continue-watchdog extension, not a message or request from the user. It is not user approval, confirmation, consent, or authorization.\n\nThe configured automatic retry budget is exhausted. No additional continuation turn was started by this event.`;
}
