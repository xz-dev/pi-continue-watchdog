import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dependency = join(root, "node_modules/watchdog-subagents-runtime");
const patch = join(root, "patches/pi-subagents-0.79.0");
assert.equal(await realpath(dependency), dependency, "Refusing to patch a shared or linked runtime.");
const manifest = JSON.parse(await readFile(join(patch, "manifest.json"), "utf8"));
const packagePath = join(dependency, "package.json");
const metadata = JSON.parse(await readFile(packagePath, "utf8"));
assert.equal(metadata.name, "pi-subagents");
assert.equal(metadata.version, manifest.version);

const writes = [];
for (const [relativePath, source] of Object.entries(manifest.sources)) {
	const path = join(dependency, relativePath);
	let original = await readFile(path, "utf8");
	for (const { from, to } of source.replacements ?? []) original = original.replace(to, from);
	assert.equal(createHash("sha256").update(original).digest("hex"), source.sha256, `Unexpected upstream source: ${relativePath}`);
	let updated = original;
	for (const { from, to } of source.replacements ?? []) {
		assert.equal(updated.split(from).length, 2, `Ambiguous patch: ${relativePath}`);
		updated = updated.replace(from, to);
	}
	if (updated !== original) writes.push([path, updated]);
}

const entry = await readFile(join(patch, "watchdog-runtime.ts"), "utf8");
metadata.exports = {
	"./watchdog-runtime": {
		types: "./src/api/watchdog-runtime.d.ts",
		import: "./src/api/watchdog-runtime.ts",
	},
};
delete metadata.pi;
writes.push([join(dependency, "src/api/watchdog-runtime.ts"), entry]);
writes.push([join(dependency, "src/api/watchdog-runtime.d.ts"), await readFile(join(patch, "watchdog-runtime.d.ts"), "utf8")]);
writes.push([packagePath, `${JSON.stringify(metadata, null, 2)}\n`]);
for (const [path, content] of writes) {
	// Replace the inode so package-manager hardlinks never modify a shared cache.
	const temporary = `${path}.watchdog-${randomUUID()}`;
	try {
		await writeFile(temporary, content, { flag: "wx" });
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => {});
	}
}
console.log(`Prepared private pi-subagents ${manifest.version} (${manifest.commit}).`);
