import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerExtension from "../src/extension.js";

test("extension factory loads without throwing", () => {
	const pi = {} as ExtensionAPI;
	assert.doesNotThrow(() => {
		registerExtension(pi);
	});
});
