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

/**
 * Built-in, non-configurable callback wake texts. Pi's public events cannot
 * associate an input's source with the started message, so these exact texts,
 * copied verbatim from producer source, identify known extension wake-ups
 * that arrive as user-role messages. A match never starts a fresh cycle.
 *
 * Exact whole-text comparison only: no trimming, case folding, prefix or
 * pattern matching. Dynamically composed producer prompts are not covered.
 */
export const CALLBACK_WAKE_TEXTS: ReadonlySet<string> = new Set([
	// pi-subagents src/shared/parent-wake.ts PARENT_WAKE_TEXT
	"Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.",
	// pi-intercom index.ts idle wake
	"New intercom message above.",
]);

function messageText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	let text = "";
	for (const block of content) {
		if (
			typeof block !== "object" ||
			block === null ||
			(block as { readonly type?: unknown }).type !== "text"
		)
			return null;
		const value = (block as { readonly text?: unknown }).text;
		if (typeof value !== "string") return null;
		text += value;
	}
	return text;
}

/** True when a user-role message is exactly a known callback wake text. */
export function isKnownCallbackWake(event: MessageStartEvent): boolean {
	const text = messageText(
		(event.message as { readonly content?: unknown } | undefined)?.content,
	);
	return text !== null && CALLBACK_WAKE_TEXTS.has(text);
}

/** True when a normal Pi `message_start` carries a user-role message. */
export function isUserRoleMessageStart(event: MessageStartEvent): boolean {
	return event.message?.role === "user";
}

/**
 * Register exactly the public `message_start` lifecycle hook used for actual
 * user work. `input` is intentionally not observed: it represents queued editor
 * input rather than a message that has started processing. Known callback
 * wakes are automation and keep the current cycle.
 */
export function registerMainUserAutoLock(
	pi: ExtensionAPI,
	binding: MainUserAutoLockBinding,
): void {
	pi.on("message_start", (event) => {
		if (!isUserRoleMessageStart(event) || !binding.isCurrentMain()) return;
		if (isKnownCallbackWake(event)) return;
		binding.onMainUserMessageStart();
	});
}
