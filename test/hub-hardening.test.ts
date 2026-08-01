import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	type BindAttachmentInput,
	type BindAttachmentResult,
	createHubAttachmentInstance,
	createObservableAgentHub,
} from "../src/hub.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const tscCli = join(projectRoot, "node_modules", "typescript", "bin", "tsc");
const hubGlobalKey = "pi-continue-watchdog:hub:v1";

type BindProperty = keyof BindAttachmentInput;

function invalidResult(result: BindAttachmentResult): void {
	assert.deepEqual(
		{
			created: result.created,
			inputConflict: result.inputConflict,
			attachment: result.attachment,
			mainClaim: result.mainClaim,
			error: result.error,
			applied: result.transition.applied,
		},
		{
			created: false,
			inputConflict: false,
			attachment: null,
			mainClaim: null,
			error: "invalidInput",
			applied: false,
		},
	);
}

function runBounded(
	command: string,
	args: readonly string[],
	label: string,
): void {
	const result = spawnSync(command, args, {
		cwd: projectRoot,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(
		result.error,
		undefined,
		`${label} failed to start: ${result.error?.message ?? "unknown error"}`,
	);
	assert.equal(
		result.status,
		0,
		`${label} failed:\n${result.stdout}\n${result.stderr}`,
	);
}

function withPhysicalHubCopies(body: (directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "pi-continue-watchdog-hub-"));
	try {
		for (const copy of ["copy-a", "copy-b"]) {
			const destination = join(directory, copy);
			mkdirSync(destination);
			writeFileSync(
				join(destination, "hub.ts"),
				readFileSync(join(projectRoot, "src", "hub.ts"), "utf8"),
			);
		}
		body(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("I1 RED: bind snapshots every hostile input field exactly once before mutating the hub", () => {
	const state = createObservableAgentHub();
	const instance = createHubAttachmentInstance();
	const reads = new Map<BindProperty, number>();
	const input = new Proxy(
		{},
		{
			get(_target, property: BindProperty): unknown {
				const count = (reads.get(property) ?? 0) + 1;
				reads.set(property, count);
				if (count > 1) throw new Error(`read twice: ${property}`);
				switch (property) {
					case "instance":
						return instance;
					case "sessionId":
						return "root";
					case "hasUI":
						return true;
					case "initialBusy":
						return false;
					default:
						return undefined;
				}
			},
		},
	) as BindAttachmentInput;

	const result = state.bind(input);
	assert.equal(result.created, true);
	assert.equal(result.error, null);
	assert.deepEqual(Object.fromEntries(reads), {
		instance: 1,
		sessionId: 1,
		hasUI: 1,
		initialBusy: 1,
	});
	assert.equal(result.attachment?.identity.sessionId, "root");
	assert.equal(result.attachment?.identity.hasUI, true);
});

test("I1 RED: invalid and throwing bind inputs are deterministic, secret-free no-ops", () => {
	const state = createObservableAgentHub();
	const root = state.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "root",
		hasUI: true,
	});
	const before = state.snapshot;
	const secret = "not-for-results-or-logs";
	const properties: readonly BindProperty[] = [
		"instance",
		"sessionId",
		"hasUI",
		"initialBusy",
	];

	for (const throwingProperty of properties) {
		const reads = new Map<BindProperty, number>();
		const input = new Proxy(
			{},
			{
				get(_target, property: BindProperty): unknown {
					reads.set(property, (reads.get(property) ?? 0) + 1);
					if (property === throwingProperty) throw new Error(secret);
					switch (property) {
						case "instance":
							return createHubAttachmentInstance();
						case "sessionId":
							return "unexpected";
						case "hasUI":
							return false;
						case "initialBusy":
							return true;
						default:
							return undefined;
					}
				},
			},
		) as BindAttachmentInput;

		const result = state.bind(input);
		invalidResult(result);
		assert.equal(reads.get(throwingProperty), 1);
		assert.equal(JSON.stringify(result).includes(secret), false);
		assert.deepEqual(state.snapshot, before);
	}

	const malformed = state.bind({
		instance: createHubAttachmentInstance(),
		sessionId: "root",
		hasUI: true,
		initialBusy: "not-a-boolean",
	} as unknown as BindAttachmentInput);
	invalidResult(malformed);
	assert.deepEqual(state.snapshot, before);
	assert.equal(root.created, true);
});

test("I1 RED: bind accepts only one stable own data attachment-instance kind marker", () => {
	const state = createObservableAgentHub();
	const before = state.snapshot;
	const marker = "pi-continue-watchdog:hub-attachment-instance:v1";
	const factoryInstance = createHubAttachmentInstance();
	const factoryKind = Object.getOwnPropertyDescriptor(factoryInstance, "kind");
	assert.deepEqual(factoryKind, {
		value: marker,
		writable: false,
		enumerable: true,
		configurable: false,
	});

	let proxyDescriptorReads = 0;
	const exactMarkerProxy = new Proxy(factoryInstance, {
		getOwnPropertyDescriptor(target, property) {
			if (property === "kind") {
				proxyDescriptorReads += 1;
				if (proxyDescriptorReads > 1) throw new Error("kind inspected twice");
			}
			return Reflect.getOwnPropertyDescriptor(target, property);
		},
	});
	const valid = state.bind({
		instance: exactMarkerProxy,
		sessionId: "valid",
		hasUI: true,
	});
	assert.equal(valid.error, null);
	assert.equal(proxyDescriptorReads, 1);

	let accessorReads = 0;
	const accessorKind = {};
	Object.defineProperty(accessorKind, "kind", {
		get() {
			accessorReads += 1;
			return marker;
		},
		enumerable: true,
		configurable: false,
	});
	let changingGetterReads = 0;
	const changingGetterKind = {};
	Object.defineProperty(changingGetterKind, "kind", {
		get() {
			changingGetterReads += 1;
			return changingGetterReads === 1 ? marker : "changed";
		},
		enumerable: true,
		configurable: false,
	});
	const inheritedKind = Object.create({ kind: marker });
	const wrongKind = Object.freeze({ kind: "not-the-factory-marker" });
	const missingKind = Object.freeze({});
	const secret = "must-not-leak-kind-proxy-secret";
	const throwingKindProxy = new Proxy(
		{},
		{
			getOwnPropertyDescriptor() {
				throw new Error(secret);
			},
		},
	);

	for (const instance of [
		wrongKind,
		missingKind,
		inheritedKind,
		accessorKind,
		changingGetterKind,
		throwingKindProxy,
	]) {
		const result = state.bind({
			instance: instance as BindAttachmentInput["instance"],
			sessionId: "invalid",
			hasUI: false,
		});
		invalidResult(result);
		assert.equal(JSON.stringify(result).includes(secret), false);
		assert.deepEqual(state.snapshot, valid.transition.snapshot);
	}
	assert.equal(accessorReads, 0);
	assert.equal(changingGetterReads, 0);
	assert.notDeepEqual(state.snapshot, before);
});

test("I2 RED: detached attachment instances retain inactive weak tombstones and never resurrect", () => {
	const state = createObservableAgentHub();
	const instance = createHubAttachmentInstance();
	const first = state.bind({
		instance,
		sessionId: "root",
		hasUI: true,
		initialBusy: false,
	});
	assert.ok(first.attachment);
	assert.equal(state.detach(first.attachment).applied, true);
	assert.equal(state.snapshot.attachmentCount, 0);
	assert.equal(state.snapshot.main, null);

	const exactDuplicate = state.bind({
		instance,
		sessionId: "root",
		hasUI: true,
		initialBusy: false,
	});
	assert.equal(exactDuplicate.created, false);
	assert.equal(exactDuplicate.error, null);
	assert.equal(exactDuplicate.inputConflict, false);
	assert.equal(exactDuplicate.attachment, first.attachment);
	assert.equal(exactDuplicate.transition.applied, false);
	assert.equal(state.snapshot.attachmentCount, 0);

	const conflictingDuplicate = state.bind({
		instance,
		sessionId: "different",
		hasUI: false,
		initialBusy: true,
	});
	assert.equal(conflictingDuplicate.created, false);
	assert.equal(conflictingDuplicate.inputConflict, true);
	assert.equal(conflictingDuplicate.attachment, first.attachment);
	assert.equal(conflictingDuplicate.transition.applied, false);
	assert.equal(state.markBusy(first.attachment).applied, false);
	assert.equal(state.markIdle(first.attachment).applied, false);
	assert.equal(state.detach(first.attachment).applied, false);
	assert.equal(state.reclaimMain(first.attachment).applied, false);
});

test("I3 and I4 RED: physical module copies have compatible types and one hardened process singleton", () => {
	withPhysicalHubCopies((directory) => {
		writeFileSync(
			join(directory, "compat.ts"),
			[
				'import type { HubAttachmentInstance as AInstance, ObservableAgentHub as AHub } from "./copy-a/hub.js";',
				'import type { HubAttachmentInstance as BInstance, ObservableAgentHub as BHub } from "./copy-b/hub.js";',
				"declare const aInstance: AInstance;",
				"declare const bInstance: BInstance;",
				"declare const aHub: AHub;",
				"declare const bHub: BHub;",
				"const instanceFromA: BInstance = aInstance;",
				"const instanceFromB: AInstance = bInstance;",
				"const hubFromA: BHub = aHub;",
				"const hubFromB: AHub = bHub;",
				"void [instanceFromA, instanceFromB, hubFromA, hubFromB];",
			].join("\n"),
		);
		writeFileSync(
			join(directory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					noEmit: true,
					types: ["node"],
					typeRoots: [join(projectRoot, "node_modules", "@types")],
					skipLibCheck: true,
				},
				include: ["compat.ts", "copy-a/hub.ts", "copy-b/hub.ts"],
			}),
		);
		runBounded(
			process.execPath,
			[tscCli, "-p", join(directory, "tsconfig.json")],
			"physical-copy typecheck",
		);

		writeFileSync(
			join(directory, "singleton.ts"),
			[
				'import assert from "node:assert/strict";',
				'import { join } from "node:path";',
				'import { pathToFileURL } from "node:url";',
				"void (async () => {",
				"const directory = process.argv[2];",
				"assert.ok(directory);",
				'const firstCopy = await import(pathToFileURL(join(directory, "copy-a", "hub.ts")).href);',
				'const secondCopy = await import(pathToFileURL(join(directory, "copy-b", "hub.ts")).href);',
				"const first = firstCopy.getProcessObservableAgentHub();",
				"const second = secondCopy.getProcessObservableAgentHub();",
				"assert.equal(first, second);",
				'assert.equal(second.bind({ instance: firstCopy.createHubAttachmentInstance(), sessionId: "from-a", hasUI: false }).error, null);',
				'assert.equal(first.bind({ instance: secondCopy.createHubAttachmentInstance(), sessionId: "from-b", hasUI: false }).error, null);',
				`const key = Object.getOwnPropertySymbols(globalThis).find((symbol) => Symbol.keyFor(symbol) === ${JSON.stringify(hubGlobalKey)});`,
				"assert.ok(key);",
				"const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);",
				"assert.ok(descriptor);",
				"assert.equal(descriptor.value, first);",
				"assert.equal(descriptor.writable, false);",
				"assert.equal(descriptor.configurable, false);",
				"assert.equal(descriptor.enumerable, false);",
				"assert.equal(Reflect.deleteProperty(globalThis, key), false);",
				"assert.throws(() => Object.defineProperty(globalThis, key, { value: {} }), TypeError);",
				"})().catch((error: unknown) => { throw error; });",
			].join("\n"),
		);
		runBounded(
			process.execPath,
			[tsxCli, join(directory, "singleton.ts"), directory],
			"physical-copy singleton runtime",
		);
	});
});

test("I2 RED: fixed branded global hubs require the prototype snapshot getter without invoking it", () => {
	withPhysicalHubCopies((directory) => {
		for (const scenario of ["no-snapshot", "own-snapshot-accessor"] as const) {
			writeFileSync(
				join(directory, `${scenario}.ts`),
				[
					'import assert from "node:assert/strict";',
					'import { join } from "node:path";',
					'import { pathToFileURL } from "node:url";',
					`const key = Symbol.for(${JSON.stringify(hubGlobalKey)});`,
					'const brand = Symbol.for("pi-continue-watchdog:hub-brand:v1");',
					"const candidate: Record<PropertyKey, unknown> = {};",
					'Object.defineProperty(candidate, brand, { value: "pi-continue-watchdog:hub:v1", writable: false, configurable: false, enumerable: false });',
					'for (const name of ["bind", "markBusy", "markIdle", "detach", "reclaimMain", "mainClaimFor", "isCurrentMain"]) Object.defineProperty(candidate, name, { value() {}, configurable: true });',
					scenario === "own-snapshot-accessor"
						? 'let snapshotReads = 0; Object.defineProperty(candidate, "snapshot", { get() { snapshotReads += 1; throw new Error("snapshot getter must not run"); }, configurable: false });'
						: "",
					"Object.defineProperty(globalThis, key, { value: candidate, writable: false, configurable: false, enumerable: false });",
					"void (async () => {",
					"const directory = process.argv[2];",
					"assert.ok(directory);",
					'const copy = await import(pathToFileURL(join(directory, "copy-a", "hub.ts")).href);',
					"assert.throws(() => copy.getProcessObservableAgentHub(), (error: unknown) => error instanceof TypeError && error.message === 'Invalid process observable agent hub');",
					"assert.equal(Object.getOwnPropertyDescriptor(globalThis, key)?.value, candidate);",
					scenario === "own-snapshot-accessor"
						? "assert.equal(snapshotReads, 0);"
						: "",
					"})().catch((error: unknown) => { throw error; });",
				].join("\n"),
			);
			runBounded(
				process.execPath,
				[tsxCli, join(directory, `${scenario}.ts`), directory],
				`global ${scenario} snapshot validation`,
			);
		}
	});
});

test("I4 RED: invalid or accessor-backed global hubs are rejected without replacement or accessor invocation", () => {
	withPhysicalHubCopies((directory) => {
		for (const scenario of ["invalid-data", "accessor"] as const) {
			writeFileSync(
				join(directory, `${scenario}.ts`),
				[
					'import assert from "node:assert/strict";',
					'import { join } from "node:path";',
					'import { pathToFileURL } from "node:url";',
					`const key = Symbol.for(${JSON.stringify(hubGlobalKey)});`,
					scenario === "invalid-data"
						? "const invalid = {}; Object.defineProperty(globalThis, key, { value: invalid, writable: true, configurable: true, enumerable: true });"
						: "let getterReads = 0; Object.defineProperty(globalThis, key, { get() { getterReads += 1; throw new Error('must not run'); }, configurable: true });",
					"void (async () => {",
					"const directory = process.argv[2];",
					"assert.ok(directory);",
					'const copy = await import(pathToFileURL(join(directory, "copy-a", "hub.ts")).href);',
					"assert.throws(() => copy.getProcessObservableAgentHub(), (error: unknown) => error instanceof TypeError && error.message === 'Invalid process observable agent hub');",
					scenario === "invalid-data"
						? "assert.equal(Object.getOwnPropertyDescriptor(globalThis, key)?.value, invalid);"
						: "assert.equal(getterReads, 0);",
					"})().catch((error: unknown) => { throw error; });",
				].join("\n"),
			);
			runBounded(
				process.execPath,
				[tsxCli, join(directory, `${scenario}.ts`), directory],
				`global ${scenario} validation`,
			);
		}
	});
});
