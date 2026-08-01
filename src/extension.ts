import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Minimal no-op Pi extension entry for Slice 0 packaging.
 * Product hooks land in later slices.
 */
export function createContinueWatchdogExtension(): (pi: ExtensionAPI) => void {
	return (_pi: ExtensionAPI): void => {
		// Intentionally empty: load-only scaffold.
	};
}

export default createContinueWatchdogExtension();
