import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { resolveRoots } from "../../src/roots.ts";
import type { RootConfig } from "../../src/types.ts";
import { withTempDir } from "../helpers/fixtures.ts";

function root(overrides: Partial<RootConfig> = {}): RootConfig {
	return { path: "knowledge", scope: "project", priority: 100, readonly: false, ...overrides };
}

test("resolves existing roots and preserves the display path", () => {
	withTempDir((cwd) => {
		fs.mkdirSync(path.join(cwd, "knowledge"));
		const warnings: string[] = [];
		const roots = resolveRoots(cwd, [root()], warnings);
		assert.deepEqual(warnings, []);
		assert.equal(roots.length, 1);
		assert.equal(roots[0]?.dir, path.join(cwd, "knowledge"));
		assert.equal(roots[0]?.display, "knowledge");
		assert.equal(roots[0]?.scope, "project");
	});
});

test("missing directories and unsafe display paths are disabled with warnings", () => {
	withTempDir((cwd) => {
		const warnings: string[] = [];
		const roots = resolveRoots(cwd, [root({ path: "missing" }), root({ path: "with space" })], warnings);
		assert.deepEqual(roots, []);
		assert.equal(warnings.length, 2);
		assert.ok(warnings.some((warning) => warning.includes("not a directory")));
		assert.ok(warnings.some((warning) => warning.includes("unsafe characters")));
	});
});

test("contained roots disable the contained side", () => {
	withTempDir((cwd) => {
		fs.mkdirSync(path.join(cwd, "docs", "inner"), { recursive: true });
		const warnings: string[] = [];
		const roots = resolveRoots(cwd, [root({ path: "docs" }), root({ path: "docs/inner" })], warnings);
		assert.equal(roots.length, 1);
		assert.equal(roots[0]?.display, "docs");
		assert.ok(warnings.some((warning) => warning.includes("is inside")));
	});
});

test("one root per scope wins by priority and the result is at most two roots", () => {
	withTempDir((cwd) => {
		fs.mkdirSync(path.join(cwd, "low"), { recursive: true });
		fs.mkdirSync(path.join(cwd, "high"), { recursive: true });
		fs.mkdirSync(path.join(cwd, "user"), { recursive: true });
		const warnings: string[] = [];
		const roots = resolveRoots(
			cwd,
			[root({ path: "low", priority: 1 }), root({ path: "high", priority: 50 }), root({ path: "user", scope: "user" })],
			warnings,
		);
		assert.equal(roots.length, 2);
		assert.ok(roots.some((entry) => entry.display === "high"));
		assert.ok(!roots.some((entry) => entry.display === "low"));
		assert.ok(warnings.some((warning) => warning.includes("only one project root")));
	});
});

test("~ paths expand and missing ones warn", () => {
	withTempDir((cwd) => {
		const warnings: string[] = [];
		const roots = resolveRoots(cwd, [root({ path: "~/definitely-missing-pi-knowledge" })], warnings);
		assert.deepEqual(roots, []);
		assert.equal(warnings.length, 1);
	});
});
