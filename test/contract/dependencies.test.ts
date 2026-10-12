import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

/** Host packages may be imported by `src/hosts` only; `src/core` is host-free. */
const HOST_PACKAGES = ["@earendil-works/pi-coding-agent", "@opencode/plugin", "typebox"];
const ALLOWED_DEV = [
	"@biomejs/biome",
	"@earendil-works/pi-coding-agent",
	"@opencode/plugin",
	"@types/node",
	"knip",
	"lefthook",
	"typebox",
	"typescript",
];

/**
 * Pi ships `typebox` and its own API at runtime, so those imports are values.
 * `@opencode/plugin` is a type-only dev dependency: OpenCode never loads it, so
 * the adapter must erase it.
 */
const TYPE_ONLY_PACKAGES = ["@opencode/plugin"];

function packageJson(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
}

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, dirent.name);
		if (dirent.isDirectory()) files.push(...sourceFiles(full));
		else if (dirent.name.endsWith(".ts")) files.push(full);
	}
	return files;
}

function importsOf(file: string): Array<{ specifier: string; typeOnly: boolean }> {
	const text = fs.readFileSync(file, "utf8");
	const found: Array<{ specifier: string; typeOnly: boolean }> = [];
	for (const match of text.matchAll(/(import|export)(?:\s+type)?\s[^;]*?from\s+"([^"]+)"/g)) {
		const specifier = match[2] ?? "";
		found.push({
			specifier,
			typeOnly: match[1] === "import" ? /\bimport\s+type\b/.test(match[0]) : /\bexport\s+type\b/.test(match[0]),
		});
	}
	return found;
}

test("runtime dependencies stay empty", () => {
	const dependencies = packageJson()["dependencies"];
	assert.ok(dependencies === undefined || Object.keys(dependencies as Record<string, unknown>).length === 0);
});

test("src imports only node builtins, relative .ts files, and host packages", () => {
	for (const file of sourceFiles(path.join(PACKAGE_ROOT, "src"))) {
		for (const { specifier } of importsOf(file)) {
			const allowed =
				specifier.startsWith("node:") ||
				specifier.startsWith(".") ||
				HOST_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
			assert.ok(allowed, `${file}: unexpected import ${specifier}`);
			if (specifier.startsWith(".")) assert.match(specifier, /\.ts$/);
		}
	}
});

test("src/core imports no host package at all", () => {
	for (const file of sourceFiles(path.join(PACKAGE_ROOT, "src", "core"))) {
		for (const { specifier } of importsOf(file)) {
			assert.ok(specifier.startsWith("node:") || specifier.startsWith("."), `${file}: ${specifier}`);
		}
	}
});

test("type-only host imports are erased so the runtime stays dependency-free", () => {
	const files = sourceFiles(path.join(PACKAGE_ROOT, "src", "hosts"));
	let checked = 0;
	for (const file of files) {
		for (const { specifier, typeOnly } of importsOf(file)) {
			if (!TYPE_ONLY_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))) continue;
			assert.ok(typeOnly, `${file}: ${specifier} must be a type-only import`);
			checked++;
		}
	}
	assert.ok(checked > 0, "the OpenCode adapter must import its types");
});

test("devDependencies stay in the allowlist", () => {
	const dev = packageJson()["devDependencies"] as Record<string, string> | undefined;
	for (const name of Object.keys(dev ?? {})) {
		assert.ok(ALLOWED_DEV.includes(name), `unexpected devDependency ${name}`);
	}
});
