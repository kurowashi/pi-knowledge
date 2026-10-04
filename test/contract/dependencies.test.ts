import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

const ALLOWED_PACKAGES = ["@earendil-works/pi-coding-agent", "typebox"];
const ALLOWED_DEV = [
	"@biomejs/biome",
	"@earendil-works/pi-coding-agent",
	"@types/node",
	"knip",
	"lefthook",
	"typebox",
	"typescript",
];

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

test("runtime dependencies stay empty", () => {
	const dependencies = packageJson()["dependencies"];
	assert.ok(dependencies === undefined || Object.keys(dependencies as Record<string, unknown>).length === 0);
});

test("src imports only node builtins, relative .ts files, and host packages", () => {
	for (const file of sourceFiles(path.join(PACKAGE_ROOT, "src"))) {
		const text = fs.readFileSync(file, "utf8");
		for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
			const specifier = match[1] ?? "";
			const allowed =
				specifier.startsWith("node:") ||
				specifier.startsWith(".") ||
				ALLOWED_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
			assert.ok(allowed, `${file}: unexpected import ${specifier}`);
			if (specifier.startsWith(".")) assert.match(specifier, /\.ts$/);
		}
	}
});

test("devDependencies stay in the allowlist", () => {
	const dev = packageJson()["devDependencies"] as Record<string, string> | undefined;
	for (const name of Object.keys(dev ?? {})) {
		assert.ok(ALLOWED_DEV.includes(name), `unexpected devDependency ${name}`);
	}
});
