import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

function packageJson(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
}

test("the distribution stays inside the files whitelist", () => {
	const pkg = packageJson();
	assert.deepEqual((pkg["files"] as string[]).sort(), ["skills", "src"]);
	const extensions = pkg["pi"] as { extensions: string[] };
	for (const entry of extensions.extensions) assert.ok(entry.startsWith("./src/"), entry);
});

test("no build step and the entry points exist", () => {
	const pkg = packageJson();
	const scripts = pkg["scripts"] as Record<string, string>;
	assert.equal(scripts["build"], undefined);
	const bin = pkg["bin"] as Record<string, string>;
	assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, bin["kb"] ?? "")));
	const extensions = (pkg["pi"] as { extensions: string[] }).extensions;
	for (const entry of extensions) assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, entry)));
});

test("the curation skill ships with the package", () => {
	assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, "skills", "knowledge-curation", "SKILL.md")));
});
