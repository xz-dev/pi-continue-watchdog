/**
 * Root-cause RED: split process hub under independent Pi module evaluations.
 *
 * On baseline 27c9a8b, each distinct-cwd DefaultResourceLoader re-evaluates the
 * extension graph via jiti (moduleCache:false + cwd-keyed factory cache clear).
 * Module-level `let processHub` therefore forks, so independent loaders do not
 * share one realm-wide observable-agent domain.
 *
 * This is the lower-level identity RED for the acceptance example that requires
 * one process domain across independent ResourceLoaders. It does not inject
 * createObservableAgentHub() into multiple runtimes.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

import {
	getProcessDomainCaptures,
	resetProcessDomainCaptures,
} from "./fixtures/process-domain-identity-probe.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probePath = resolve(
	repoRoot,
	"test/fixtures/process-domain-identity-probe.ts",
);

async function loadProbeThroughPublicResourceLoader(
	cwd: string,
	agentDir: string,
) {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [probePath],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(
		loader.getExtensions().errors,
		[],
		`DefaultResourceLoader must load the probe under cwd=${cwd}`,
	);
	const loaded = loader
		.getExtensions()
		.extensions.find((extension) => extension.resolvedPath === probePath);
	assert.ok(loaded, "probe extension must be present after reload");
	return loader;
}

test("root-cause RED: independent DefaultResourceLoader cwd evaluations share one process hub", async () => {
	resetProcessDomainCaptures();
	const root = await mkdtemp(join(tmpdir(), "pi-continue-watchdog-domain-"));
	const agentDir = join(root, "agent");
	const cwdA = join(root, "project-a");
	const cwdB = join(root, "project-b");
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(cwdA, { recursive: true }),
		mkdir(cwdB, { recursive: true }),
	]);

	try {
		// Control: same cwd reuses Pi's extension factory cache (one evaluation).
		await loadProbeThroughPublicResourceLoader(cwdA, agentDir);
		await loadProbeThroughPublicResourceLoader(cwdA, agentDir);
		const sameCwdCaptures = getProcessDomainCaptures();
		assert.equal(sameCwdCaptures.length, 2);
		assert.equal(
			sameCwdCaptures[0]?.moduleEvaluationIdentity,
			sameCwdCaptures[1]?.moduleEvaluationIdentity,
			"same-cwd reload must reuse the cached factory/module evaluation (control)",
		);
		assert.equal(
			sameCwdCaptures[0]?.hub,
			sameCwdCaptures[1]?.hub,
			"same evaluation must return the same process hub (control)",
		);

		// Treatment: distinct cwd forces a fresh jiti evaluation of the hub module.
		await loadProbeThroughPublicResourceLoader(cwdB, agentDir);
		const captures = getProcessDomainCaptures();
		assert.equal(captures.length, 3);

		const firstEval = captures[0];
		const secondEval = captures[2];
		assert.ok(firstEval);
		assert.ok(secondEval);

		assert.notEqual(
			firstEval.moduleEvaluationIdentity,
			secondEval.moduleEvaluationIdentity,
			"distinct-cwd DefaultResourceLoader loads must be genuine separate module evaluations, not two loader objects reusing one factory cache entry",
		);

		// Desired product behavior (GREEN): one realm-wide process domain.
		// On baseline 27c9a8b this fails because module-level processHub forks.
		assert.equal(
			firstEval.hub,
			secondEval.hub,
			"independent ResourceLoader/module evaluations in one process must share getProcessObservableAgentHub() — not a per-evaluation singleton",
		);
	} finally {
		resetProcessDomainCaptures();
		await rm(root, { recursive: true, force: true });
	}
});
