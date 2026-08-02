import type {
	ExtensionAPI,
	MessageStartEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * The narrow lifecycle-to-controller seam for main user work.
 *
 * Main ownership is supplied by the caller. The runtime hub owns that
 * authority and validates the attachment claim on every event.
 */
export interface MainUserAutoLockBinding {
	/** Live ownership check for the current attachment. */
	isCurrentMain(): boolean;
	onMainUserMessageStart(): void;
}

/** True when a normal Pi `message_start` carries a user-role message. */
export function isUserRoleMessageStart(event: MessageStartEvent): boolean {
	return event.message?.role === "user";
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
