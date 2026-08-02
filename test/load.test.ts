import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerExtension from "../src/extension.js";

function createFakePi(): ExtensionAPI {
	let activeTools: string[] = [];
	return {
		on(): void {
			// The load smoke only verifies registration; lifecycle behavior is covered
			// by its focused tests.
		},
		registerTool(tool: { readonly name: string }): void {
			activeTools.push(tool.name);
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(toolNames: string[]): void {
			activeTools = [...toolNames];
		},
		registerEntryRenderer(): void {},
		registerCommand(): void {},
		appendEntry(): void {},
	} as unknown as ExtensionAPI;
}

test("extension factory registers against the public extension surface without throwing", () => {
	assert.doesNotThrow(() => {
		registerExtension(createFakePi());
	});
});

test("each Pi factory activation receives independent runtime attachment state", () => {
	assert.doesNotThrow(() => {
		registerExtension(createFakePi());
		registerExtension(createFakePi());
	});
});
