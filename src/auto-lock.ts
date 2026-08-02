import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The narrow lifecycle-to-controller seam for Example 1.
 *
 * Main ownership is deliberately supplied by the caller rather than inferred
 * from a session ID or event payload. The runtime hub owns that authority and
 * validates the captured attachment claim and generation on every event.
 */
export interface MainUserAutoLockBinding {
	/**
	 * One live ownership check. Callers must validate the current attachment and
	 * derive a fresh generation claim for it rather than retaining a stale claim.
	 */
	isCurrentMain(): boolean;
	onMainUserMessageStart(): void;
}

type OwnDataRead =
	| { readonly kind: "missing" }
	| { readonly kind: "value"; readonly value: unknown }
	| { readonly kind: "invalid" };

/**
 * Reads only an own data property, never invoking a getter. Pi supplies typed
 * lifecycle records, but this defensive boundary also keeps malformed test or
 * host input from triggering lock state or throwing out of Pi's event dispatch.
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

/** True only for a lifecycle record with an own user-role message. */
export function isUserRoleMessageStart(event: unknown): boolean {
	const message = readOwnData(event, "message");
	if (message.kind !== "value") return false;
	const role = readOwnData(message.value, "role");
	return role.kind === "value" && role.value === "user";
}

/**
 * Register exactly the public `message_start` lifecycle hook used for actual
 * user work. `input` is intentionally not observed: it represents queued editor
 * input rather than a message that has started processing.
 */
export function registerMainUserAutoLock(
	pi: ExtensionAPI,
	binding: MainUserAutoLockBinding,
): void {
	pi.on("message_start", (event) => {
		if (!isUserRoleMessageStart(event) || !binding.isCurrentMain()) return;
		binding.onMainUserMessageStart();
	});
}
