import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

interface Exports {
	[key: string]: string;
}

interface PackageJson {
	[key: string]: unknown;
}

function packageJson(): PackageJson {
	return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as PackageJson;
}

test("the distribution stays inside the files whitelist", () => {
	const pkg = packageJson();
	assert.deepEqual((pkg["files"] as string[]).sort(), ["skills", "src"]);
	const pi = pkg["pi"] as { extensions: string[] };
	for (const entry of pi.extensions) assert.ok(entry.startsWith("./src/"), entry);
});

test("no build step and the entry points exist", () => {
	const pkg = packageJson();
	const scripts = pkg["scripts"] as Record<string, string>;
	assert.equal(scripts["build"], undefined);
	const bin = pkg["bin"] as Record<string, string>;
	assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, bin["kb"] ?? "")));
	const pi = pkg["pi"] as { extensions: string[] };
	for (const entry of pi.extensions) assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, entry)));
});

test("Pi and OpenCode load the same package through different entry points", () => {
	const pkg = packageJson();
	const exports = pkg["exports"] as Exports;
	const pi = pkg["pi"] as { extensions: string[] };
	// OpenCode resolves `<package>/server` first (Host.resolve), Pi reads `pi.extensions`.
	assert.deepEqual(Object.keys(exports), ["./server"]);
	assert.equal(exports["./server"], "./src/hosts/opencode.ts");
	assert.equal(pi.extensions.length, 1);
	for (const entry of [...Object.values(exports), ...pi.extensions]) {
		assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, entry)), `${entry} must exist`);
		assert.ok(!entry.endsWith("/"), `${entry} must be a file, not a directory`);
	}
});

test("the curation skill ships with the package", () => {
	assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, "skills", "knowledge-curation", "SKILL.md")));
});
