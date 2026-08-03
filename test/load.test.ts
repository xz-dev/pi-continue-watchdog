import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerExtension from "../src/extension.js";

interface FakePi {
	readonly pi: ExtensionAPI;
	readonly registeredTools: string[];
	readonly activeTools: () => readonly string[];
}

function createFakePi(): FakePi {
	let activeTools: string[] = [];
	const registeredTools: string[] = [];
	const pi = {
		on(): void {
			// The load smoke only verifies registration; lifecycle behavior is covered
			// by its focused tests.
		},
		registerTool(tool: { readonly name: string }): void {
			registeredTools.push(tool.name);
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
	return {
		pi,
		registeredTools,
		activeTools: () => [...activeTools],
	};
}

test("extension load does not register or activate decision tools before inquiry", () => {
	const fake = createFakePi();
	assert.doesNotThrow(() => {
		registerExtension(fake.pi);
	});
	assert.deepEqual(fake.registeredTools, []);
	assert.deepEqual(fake.activeTools(), []);
});

test("each Pi factory activation receives independent runtime attachment state", () => {
	assert.doesNotThrow(() => {
		registerExtension(createFakePi().pi);
		registerExtension(createFakePi().pi);
	});
});
