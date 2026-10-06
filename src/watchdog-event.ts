export const WATCHDOG_EVENT_VERSION = 1 as const;
export const WATCHDOG_EVENT_MESSAGE_TYPE = "pi-continue-watchdog:event";

interface WatchdogEventBase {
	readonly version: typeof WATCHDOG_EVENT_VERSION;
	readonly occurredAtMs: number;
	readonly occurredAt: string;
}

/** Legacy record type: persisted by versions that still accepted waits. */
export interface CompletedWaitWatchdogEvent extends WatchdogEventBase {
	readonly kind: "wait-completed";
	readonly waitIdentity: string;
	readonly acceptedAtMs: number;
	readonly acceptedAt: string;
	readonly waitSeconds: number;
	readonly elapsedSeconds: number;
}

export interface ContinueWatchdogEvent extends WatchdogEventBase {
	readonly kind: "continue";
	readonly reasonType: string;
	readonly reason: string;
}

/** Legacy record type: persisted by versions that still accepted waits. */
export interface WaitWatchdogEvent extends WatchdogEventBase {
	readonly kind: "wait";
	readonly reason: string;
	readonly waitSeconds: number;
	readonly deadlineMs: number;
	readonly deadline: string;
}

export interface DecisionFailedWatchdogEvent extends WatchdogEventBase {
	readonly kind: "decision-failed";
	readonly error: string;
}

export interface ExhaustedWatchdogEvent extends WatchdogEventBase {
	readonly kind: "exhausted";
}

export interface UnlockWatchdogEvent extends WatchdogEventBase {
	readonly kind: "unlock";
	readonly reasonType: string;
	readonly reason: string;
}

export type WatchdogEvent =
	| CompletedWaitWatchdogEvent
	| ContinueWatchdogEvent
	| WaitWatchdogEvent
	| UnlockWatchdogEvent
	| DecisionFailedWatchdogEvent
	| ExhaustedWatchdogEvent;

export interface ContinueWatchdogEventInput {
	readonly occurredAtMs: number;
	readonly offsetMinutes?: number;
	readonly reasonType: string;
	readonly reason: string;
}

export interface DecisionFailedWatchdogEventInput {
	readonly occurredAtMs: number;
	readonly offsetMinutes?: number;
	readonly error: string;
}

export interface ExhaustedWatchdogEventInput {
	readonly occurredAtMs: number;
	readonly offsetMinutes?: number;
}

export interface UnlockWatchdogEventInput {
	readonly occurredAtMs: number;
	readonly offsetMinutes?: number;
	readonly reasonType: string;
	readonly reason: string;
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
		reasonType: input.reasonType,
		reason: input.reason,
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

export function createUnlockWatchdogEvent(
	input: UnlockWatchdogEventInput,
): UnlockWatchdogEvent {
	return {
		version: WATCHDOG_EVENT_VERSION,
		kind: "unlock",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(
			input.occurredAtMs,
			input.offsetMinutes,
		),
		reasonType: input.reasonType,
		reason: input.reason,
	};
}

export function createDecisionFailedWatchdogEvent(
	input: DecisionFailedWatchdogEventInput,
): DecisionFailedWatchdogEvent {
	return {
		version: WATCHDOG_EVENT_VERSION,
		kind: "decision-failed",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(
			input.occurredAtMs,
			input.offsetMinutes,
		),
		error: input.error,
	};
}

function eventRecord(input: unknown): Record<string, unknown> | undefined {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: undefined;
}

function hasValidBase(event: Record<string, unknown>): boolean {
	return (
		event.version === WATCHDOG_EVENT_VERSION &&
		typeof event.occurredAtMs === "number" &&
		Number.isFinite(event.occurredAtMs) &&
		typeof event.occurredAt === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(
			event.occurredAt,
		)
	);
}

export function parseWatchdogEvent(input: unknown): WatchdogEvent | undefined {
	const event = eventRecord(input);
	if (event === undefined || !hasValidBase(event)) return undefined;
	if (
		event.kind === "wait-completed" &&
		typeof event.waitIdentity === "string" &&
		event.waitIdentity.length > 0 &&
		typeof event.acceptedAtMs === "number" &&
		Number.isFinite(event.acceptedAtMs) &&
		typeof event.acceptedAt === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(
			event.acceptedAt,
		) &&
		typeof event.waitSeconds === "number" &&
		Number.isSafeInteger(event.waitSeconds) &&
		event.waitSeconds > 0 &&
		typeof event.elapsedSeconds === "number" &&
		Number.isSafeInteger(event.elapsedSeconds) &&
		event.elapsedSeconds >= event.waitSeconds
	) {
		return event as unknown as CompletedWaitWatchdogEvent;
	}
	if (
		event.kind === "continue" &&
		typeof event.reasonType === "string" &&
		event.reasonType.length > 0 &&
		typeof event.reason === "string" &&
		event.reason.length > 0
	) {
		return event as unknown as ContinueWatchdogEvent;
	}
	if (
		event.kind === "unlock" &&
		typeof event.reasonType === "string" &&
		event.reasonType.length > 0 &&
		typeof event.reason === "string" &&
		event.reason.length > 0
	) {
		return event as unknown as UnlockWatchdogEvent;
	}
	if (event.kind === "exhausted") {
		return event as unknown as ExhaustedWatchdogEvent;
	}
	if (
		event.kind === "decision-failed" &&
		typeof event.error === "string" &&
		event.error.length > 0
	) {
		return event as unknown as DecisionFailedWatchdogEvent;
	}
	if (
		event.kind === "wait" &&
		typeof event.reason === "string" &&
		event.reason.length > 0 &&
		typeof event.waitSeconds === "number" &&
		Number.isSafeInteger(event.waitSeconds) &&
		event.waitSeconds > 0 &&
		typeof event.deadlineMs === "number" &&
		Number.isSafeInteger(event.deadlineMs) &&
		typeof event.deadline === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(
			event.deadline,
		)
	) {
		return event as unknown as WaitWatchdogEvent;
	}
	return undefined;
}

export function formatContinueWatchdogEvent(
	event: ContinueWatchdogEvent,
	continuePrompt: string,
): string {
	return `Continue watchdog · continue · ${event.reasonType} · ${event.occurredAt}

Automated guidance from the pi-continue-watchdog extension, not a user message or request.
This is not user approval, confirmation, consent, or authorization.
Absence of new authorization from this notice does not revoke or reset permission the user already granted; permission is reevaluated only against actual scope changes, revocations, and applicable unsatisfied requirements.

Suggested next step: ${event.reason}

Continuation guidance:
${continuePrompt}

Reconcile this suggested step against the user's current authorized scope and the latest actually delivered results before acting: exclude work already delivered, cancelled, or superseded; do not repeat an already-delivered answer and do not reopen a permission question the user already answered. Resume only requested, authorized work that remains actionable. If additional user input, approval, or assistance is required, stop that action and ask the user normally.`;
}

export function formatExhaustedWatchdogEvent(
	event: ExhaustedWatchdogEvent,
): string {
	return `Continue watchdog exhausted · ${event.occurredAt}\n\nThis is an automated event from the pi-continue-watchdog extension, not a message or request from the user. It is not user approval, confirmation, consent, or authorization.\n\nThe configured automatic retry budget is exhausted. No additional inquiry or ordinary work turn was started by this event.`;
}

export function formatUnlockWatchdogEvent(event: UnlockWatchdogEvent): string {
	return `Continue watchdog unlocked · ${event.reasonType} · ${event.occurredAt}\n\nThis is an automated event from the pi-continue-watchdog extension, not a message or request from the user. It is not user approval, confirmation, consent, or authorization.\n\nModel-generated reason (not a runtime-verified task fact):\n${JSON.stringify(event.reason)}\n\nThe watchdog is unlocked. This event does not grant permission for any further action.`;
}

export function formatDecisionFailedWatchdogEvent(
	event: DecisionFailedWatchdogEvent,
): string {
	return `Continue watchdog decision failed · ${event.occurredAt}\n\nThis is an automated event from the pi-continue-watchdog extension, not a message or request from the user. It is not user approval, confirmation, consent, or authorization.\n\nSafe validator diagnostic:\n${JSON.stringify(event.error)}\n\nThe raw invalid model response is intentionally excluded. No ordinary work turn was started.`;
}
