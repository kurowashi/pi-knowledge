import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
	DEFAULT_CONFIG,
	deepMerge,
	globalConfigPath,
	loadConfig,
	projectConfigPath,
	resolveConfig,
} from "../../src/config.ts";
import { withAgentDir, withTempDir } from "../helpers/fixtures.ts";

test("defaults resolve with no raw config", () => {
	const warnings: string[] = [];
	const config = resolveConfig([], warnings);
	assert.deepEqual(warnings, []);
	assert.equal(config.enabled, true);
	assert.deepEqual(config.roots, DEFAULT_CONFIG.roots);
	assert.equal(config.injection.maxTokens, 4000);
	assert.equal(config.search.backend, "lexical");
	assert.equal(config.capture.mode, "manual");
	assert.equal(config.write.enforce, "block");
	assert.equal(config.docs.maxLines, 500);
	assert.equal(config.stale.days, 365);
});

test("deepMerge merges nested objects and replaces arrays", () => {
	const merged = deepMerge({ a: { x: 1, y: 2 }, list: [1] }, { a: { y: 3 }, list: [2] });
	assert.deepEqual(merged, { a: { x: 1, y: 3 }, list: [2] });
});

test("invalid values warn and fall back", () => {
	const warnings: string[] = [];
	const config = resolveConfig(
		[
			{
				enabled: "yes",
				injection: { maxTokens: -1, contextFraction: 5 },
				search: { backend: "magic" },
				capture: { mode: "auto" },
				write: { enforce: "nope" },
				docs: { include: "docs" },
				stale: { days: 0 },
			},
		],
		warnings,
	);
	assert.equal(config.enabled, true);
	assert.equal(config.injection.maxTokens, 4000);
	assert.equal(config.injection.contextFraction, 0.02);
	assert.equal(config.search.backend, "lexical");
	assert.equal(config.capture.mode, "manual");
	assert.equal(config.write.enforce, "block");
	assert.deepEqual(config.docs.include, ["docs/**"]);
	assert.equal(config.stale.days, 365);
	assert.ok(warnings.length >= 7);
});

test("roots parse; invalid entries skip; empty array means no roots", () => {
	const warnings: string[] = [];
	const config = resolveConfig(
		[{ roots: [{ path: "kb", scope: "user", priority: 5, readonly: true }, { nope: 1 }, "x"] }],
		warnings,
	);
	assert.deepEqual(config.roots, [{ path: "kb", scope: "user", priority: 5, readonly: true }]);
	assert.equal(warnings.length, 2);
	assert.deepEqual(resolveConfig([{ roots: [] }], []).roots, []);
	assert.deepEqual(resolveConfig([{ roots: "no" }], []).roots, DEFAULT_CONFIG.roots);
});

test("floorTokens above maxTokens is clamped to maxTokens", () => {
	const config = resolveConfig([{ injection: { maxTokens: 500, floorTokens: 1000 } }], []);
	assert.equal(config.injection.maxTokens, 500);
	assert.equal(config.injection.floorTokens, 500);
});

test("loadConfig merges global and project configs and honors trust", () => {
	withTempDir((cwd) => {
		const agent = path.join(cwd, "agent");
		fs.mkdirSync(agent, { recursive: true });
		withAgentDir(agent, () => {
			fs.writeFileSync(globalConfigPath(), JSON.stringify({ injection: { maxTokens: 1234 } }));
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ injection: { maxTokens: 99 } }));
			assert.equal(loadConfig(cwd, true).config.injection.maxTokens, 99);
			assert.equal(loadConfig(cwd, false).config.injection.maxTokens, 1234);
		});
	});
});

test("broken config files warn and never throw", () => {
	withTempDir((cwd) => {
		const agent = path.join(cwd, "agent");
		fs.mkdirSync(agent, { recursive: true });
		withAgentDir(agent, () => {
			fs.writeFileSync(globalConfigPath(), "{not json");
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(projectConfigPath(cwd), "[]");
			const loaded = loadConfig(cwd, true);
			assert.equal(loaded.config.enabled, true);
			assert.equal(loaded.warnings.length, 2);
		});
	});
});

test("the default root is a silent no-op when knowledge/ is absent", () => {
	withTempDir((cwd) => {
		const agent = path.join(cwd, "agent");
		fs.mkdirSync(agent, { recursive: true });
		withAgentDir(agent, () => {
			assert.deepEqual(loadConfig(cwd, true).config.roots, []);
			fs.mkdirSync(path.join(cwd, "knowledge"));
			assert.deepEqual(loadConfig(cwd, true).config.roots, DEFAULT_CONFIG.roots);
		});
	});
});

test("team scope and cache config resolve", () => {
	const config = resolveConfig([{ roots: [{ path: "shared", scope: "team" }], cache: { enabled: false } }], []);
	assert.equal(config.roots[0]?.scope, "team");
	assert.equal(config.cache.enabled, false);
	assert.equal(resolveConfig([], []).cache.enabled, true);
	const warnings: string[] = [];
	assert.equal(resolveConfig([{ cache: { enabled: "yes" } }], warnings).cache.enabled, true);
	assert.ok(warnings.some((warning) => warning.includes("cache.enabled")));
});
