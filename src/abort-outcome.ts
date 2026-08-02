import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
	ControllerEffect,
	ControllerTransition,
	LockDecisionController,
} from "./controller.js";
import type { HubMainClaim } from "./hub.js";

/**
 * Narrow main-run abort detector.
 *
 * Captures an immutable leaf boundary at main `agent_start`, then at
 * `agent_settled` inspects only the newly appended branch suffix through public
 * `ctx.sessionManager` APIs. Unlocks only when the terminal new assistant has
 * `stopReason === "aborted"`. Never infers abort from settle alone.
 */

export type TerminalAssistantOutcome =
	| { readonly kind: "aborted" }
	| { readonly kind: "non-aborted"; readonly stopReason: string }
	| { readonly kind: "none" }
	| { readonly kind: "boundary-missing" }
	| { readonly kind: "invalid" };

export type AbortUnlockRuntimeEffect = Exclude<
	ControllerEffect,
	{ readonly kind: "notify" }
>;

export interface MainAbortUnlockRuntime {
	/**
	 * Live ownership check for whether this attachment is currently main.
	 * Used only to decide whether to capture at `agent_start`.
	 */
	isCurrentMain(): boolean;
	/** Capture the current main claim (token + ownership generation). */
	getMainClaim(): HubMainClaim | null;
	/** True only when the stored claim still identifies the current main. */
	isCurrentMainClaim(claim: HubMainClaim): boolean;
	readonly controller: LockDecisionController;
	applyEffect(
		effect: AbortUnlockRuntimeEffect,
		ctx: ExtensionContext,
	): Promise<void> | void;
}

interface CapturedRun {
	readonly claim: HubMainClaim;
	readonly boundaryLeafId: string | null;
}

type OwnDataRead =
	| { readonly kind: "missing" }
	| { readonly kind: "value"; readonly value: unknown }
	| { readonly kind: "invalid" };

/**
 * Reads only an own data property, never invoking a getter. SessionManager is
 * trusted, but entry payloads and hostile test doubles must not throw out of
 * Pi's event dispatch or spuriously unlock.
 */
function readOwnData(input: unknown, key: PropertyKey): OwnDataRead {
	if (
		input === null ||
		(typeof input !== "object" && typeof input !== "function")
	) {
		return { kind: "missing" };
	}
	try {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (descriptor === undefined) return { kind: "missing" };
		return Object.hasOwn(descriptor, "value")
			? { kind: "value", value: descriptor.value }
			: { kind: "invalid" };
	} catch {
		return { kind: "invalid" };
	}
}

function callPublicMethod(
	target: unknown,
	name: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
	if (
		target === null ||
		(typeof target !== "object" && typeof target !== "function")
	) {
		return { ok: false };
	}
	try {
		const method = (target as Record<string, unknown>)[name];
		if (typeof method !== "function") return { ok: false };
		return { ok: true, value: method.call(target) };
	} catch {
		return { ok: false };
	}
}

/**
 * Capture the immutable current leaf ID as a run boundary.
 * `null` means the branch was empty at start; every later branch entry is new.
 * `undefined` means the public API could not be read safely.
 */
export function captureBranchBoundary(
	sessionManager: unknown,
): string | null | undefined {
	const result = callPublicMethod(sessionManager, "getLeafId");
	if (!result.ok) return undefined;
	if (result.value === null) return null;
	return typeof result.value === "string" ? result.value : undefined;
}

function isAssistantMessageEntry(
	entry: unknown,
): { readonly stopReason: string } | null | "invalid" {
	const type = readOwnData(entry, "type");
	if (type.kind === "invalid") return "invalid";
	if (type.kind !== "value" || type.value !== "message") return null;

	const message = readOwnData(entry, "message");
	if (message.kind === "invalid") return "invalid";
	if (message.kind !== "value") return null;

	const role = readOwnData(message.value, "role");
	if (role.kind === "invalid") return "invalid";
	if (role.kind !== "value" || role.value !== "assistant") return null;

	const stopReason = readOwnData(message.value, "stopReason");
	if (stopReason.kind === "invalid") return "invalid";
	if (stopReason.kind !== "value" || typeof stopReason.value !== "string") {
		return "invalid";
	}
	return { stopReason: stopReason.value };
}

/**
 * Every public Pi SessionEntry exposes an own string `id`. Missing, non-string,
 * getter, or hostile id descriptors are treated as malformed.
 */
function entryId(entry: unknown): string | undefined {
	const id = readOwnData(entry, "id");
	if (id.kind !== "value" || typeof id.value !== "string") return undefined;
	return id.value;
}

/**
 * Snapshot a public `getBranch()` result into a fresh ordinary array using only
 * own data descriptors. All Array.isArray / length / index / descriptor probes
 * stay inside one try so revoked proxies, length traps, index traps, holes,
 * and accessors fail closed without escaping event dispatch.
 */
function captureBranchEntries(input: unknown): readonly unknown[] | undefined {
	try {
		if (!Array.isArray(input)) return undefined;
		const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
		if (
			lengthDescriptor === undefined ||
			!Object.hasOwn(lengthDescriptor, "value") ||
			!Number.isSafeInteger(lengthDescriptor.value) ||
			lengthDescriptor.value < 0
		) {
			return undefined;
		}
		const length = lengthDescriptor.value as number;
		const values: unknown[] = [];
		for (let index = 0; index < length; index += 1) {
			const item = Object.getOwnPropertyDescriptor(input, String(index));
			if (item === undefined || !Object.hasOwn(item, "value")) {
				return undefined;
			}
			values.push(item.value);
		}
		return values;
	} catch {
		return undefined;
	}
}

/**
 * Inspect only the newly appended suffix of the current branch after the
 * captured leaf boundary. The terminal new assistant is the last newly
 * appended `type: "message"` entry with `message.role === "assistant"`.
 *
 * Fail closed when the boundary leaf is absent (branch switch / compaction /
 * rewrite), the public API is unreadable, the branch array is malformed, or
 * any inspected SessionEntry lacks an own string id.
 */
export function inspectTerminalAssistantOutcome(
	sessionManager: unknown,
	boundaryLeafId: string | null,
): TerminalAssistantOutcome {
	const branchResult = callPublicMethod(sessionManager, "getBranch");
	if (!branchResult.ok) {
		return { kind: "invalid" };
	}

	const branch = captureBranchEntries(branchResult.value);
	if (branch === undefined) {
		return { kind: "invalid" };
	}

	let startIndex = 0;

	if (boundaryLeafId !== null) {
		let found = false;
		for (let i = 0; i < branch.length; i++) {
			const id = entryId(branch[i]);
			if (id === undefined) return { kind: "invalid" };
			if (id === boundaryLeafId) {
				startIndex = i + 1;
				found = true;
				break;
			}
		}
		if (!found) return { kind: "boundary-missing" };
	}

	let terminalStopReason: string | null = null;
	for (let i = startIndex; i < branch.length; i++) {
		const id = entryId(branch[i]);
		if (id === undefined) return { kind: "invalid" };
		const assistant = isAssistantMessageEntry(branch[i]);
		if (assistant === "invalid") return { kind: "invalid" };
		if (assistant !== null) {
			terminalStopReason = assistant.stopReason;
		}
	}

	if (terminalStopReason === null) return { kind: "none" };
	if (terminalStopReason === "aborted") return { kind: "aborted" };
	return { kind: "non-aborted", stopReason: terminalStopReason };
}

const UNLOCKED_NOTIFICATION = "Continue watchdog unlocked";

async function applyUnlockEffects(
	transition: ControllerTransition,
	runtime: MainAbortUnlockRuntime,
	ctx: ExtensionContext,
): Promise<void> {
	for (const effect of transition.effects) {
		if (effect.kind === "notify") {
			// Reasonless abort unlock always uses the exact bare notification.
			if (effect.notification === "unlocked") {
				ctx.ui.notify(UNLOCKED_NOTIFICATION);
			}
			continue;
		}
		await runtime.applyEffect(effect, ctx);
	}
}

export interface MainAbortUnlockHandle {
	/** Discard any unconsumed capture (shutdown / reload / demotion cleanup). */
	clear(): void;
}

/**
 * Register the main-run abort unlock lifecycle on public `agent_start` and
 * `agent_settled` hooks. Child attachments with `isCurrentMain() === false`
 * never capture. A new main start supersedes any prior unconsumed capture.
 */
export function registerMainAbortUnlock(
	pi: ExtensionAPI,
	runtime: MainAbortUnlockRuntime,
): MainAbortUnlockHandle {
	let capture: CapturedRun | null = null;

	const clear = (): void => {
		capture = null;
	};

	pi.on("agent_start", (_event, ctx: ExtensionContext) => {
		if (!runtime.isCurrentMain()) {
			// Non-main attachments must never retain a boundary for a later
			// accidental settle after reclaim.
			clear();
			return;
		}

		const claim = runtime.getMainClaim();
		if (claim === null) {
			clear();
			return;
		}

		const boundaryLeafId = captureBranchBoundary(ctx.sessionManager);
		if (boundaryLeafId === undefined) {
			clear();
			return;
		}

		// A new start always supersedes any prior unconsumed capture.
		capture = Object.freeze({ claim, boundaryLeafId });
	});

	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		const active = capture;
		// Consume immediately so duplicate settle and concurrent paths are inert.
		capture = null;
		if (active === null) return;

		if (!runtime.isCurrentMainClaim(active.claim)) {
			return;
		}

		const outcome = inspectTerminalAssistantOutcome(
			ctx.sessionManager,
			active.boundaryLeafId,
		);
		if (outcome.kind !== "aborted") return;

		const transition = runtime.controller.unlock();
		await applyUnlockEffects(transition, runtime, ctx);
	});

	return { clear };
}
