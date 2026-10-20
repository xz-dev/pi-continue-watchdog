import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The utils postinstall prepares the private runtime; without it loading fails with
// "Cannot find module 'private-inquiry-subagents-runtime/watchdog-runtime'".
// Pi installs Git packages with npm (allowScripts) or embedded Bun (trustedDependencies).
test("both package managers Pi uses may run the utils runtime preparation", async () => {
	const pkg = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	const sha =
		/^git\+https:\/\/github\.com\/xz-dev\/pi-extension-utils\.git#([0-9a-f]{40})$/.exec(
			pkg.dependencies["pi-extension-utils"],
		)?.[1];
	assert.ok(sha, "pi-extension-utils must be pinned to a full commit");
	assert.deepEqual(pkg.allowScripts, {
		[`github:xz-dev/pi-extension-utils#${sha}`]: true,
	});
	assert.deepEqual(pkg.trustedDependencies, ["pi-extension-utils"]);
	assert.match(
		pkg.dependencies["private-inquiry-subagents-runtime"],
		/#[0-9a-f]{40}$/,
	);
});
