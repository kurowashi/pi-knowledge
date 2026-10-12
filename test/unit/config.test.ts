import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
	DEFAULT_CONFIG,
	deepMerge,
	loadConfig,
	OPENCODE_HOST_PATHS,
	piGlobalConfigFile,
	resolveConfig,
	SHARED_HOST_PATHS,
} from "../../src/core/config.ts";
import { withAgentDir, withEnv, withTempDir } from "../helpers/fixtures.ts";

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
			fs.writeFileSync(piGlobalConfigFile(), JSON.stringify({ injection: { maxTokens: 1234 } }));
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".pi", "knowledge.json"), JSON.stringify({ injection: { maxTokens: 99 } }));
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
			fs.writeFileSync(piGlobalConfigFile(), "{not json");
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".pi", "knowledge.json"), "[]");
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

test("each host resolves its own cache directory but keeps its own config sources", () => {
	assert.equal(OPENCODE_HOST_PATHS.cacheDirName, ".opencode");
	assert.equal(SHARED_HOST_PATHS.cacheDirName, ".pi");
	withTempDir((cwd) => {
		withEnv({ XDG_CONFIG_HOME: path.join(cwd, "xdg") }, () => {
			assert.deepEqual(OPENCODE_HOST_PATHS.globalConfigFiles(), [path.join(cwd, "xdg", "opencode", "knowledge.json")]);
		});
	});
});

test("kb reads both hosts' global and project config, in that order", () => {
	withTempDir((cwd) => {
		const agent = path.join(cwd, "agent");
		const xdg = path.join(cwd, "xdg");
		fs.mkdirSync(agent, { recursive: true });
		fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		withEnv({ PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: xdg }, () => {
			fs.writeFileSync(piGlobalConfigFile(), JSON.stringify({ stale: { days: 1 }, docs: { maxLines: 10 } }));
			fs.writeFileSync(
				path.join(xdg, "opencode", "knowledge.json"),
				JSON.stringify({ stale: { days: 2 }, docs: { maxLines: 20 } }),
			);
			fs.writeFileSync(path.join(cwd, ".pi", "knowledge.json"), JSON.stringify({ stale: { days: 3 } }));
			const config = loadConfig(cwd, true, SHARED_HOST_PATHS).config;
			assert.equal(config.docs.maxLines, 20, "the OpenCode global overrides the Pi one");
			assert.equal(config.stale.days, 3, "a project config overrides every global");
		});
	});
});

test("kb reads both hosts' project config so CI matches the agent", () => {
	withTempDir((cwd) => {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.mkdirSync(path.join(cwd, ".opencode"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "knowledge.json"), JSON.stringify({ stale: { days: 10 } }));
		fs.writeFileSync(path.join(cwd, ".opencode", "knowledge.json"), JSON.stringify({ search: { backend: "fts5" } }));
		const shared = loadConfig(cwd, true, SHARED_HOST_PATHS).config;
		assert.equal(shared.stale.days, 10, "kb sees the Pi config");
		assert.equal(shared.search.backend, "fts5", "kb sees the OpenCode config");
		const opencode = loadConfig(cwd, true, OPENCODE_HOST_PATHS).config;
		assert.equal(opencode.stale.days, 365, "the OpenCode host ignores .pi");
		assert.equal(opencode.search.backend, "fts5");
	});
});
