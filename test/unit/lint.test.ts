import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildCatalog } from "../../src/catalog.ts";
import { extractLinks, isValidDate, lintCatalog, validateEntry } from "../../src/lint.ts";
import type { EntryRecord } from "../../src/types.ts";
import { catalogOf, entryText, makeEntry, makeRoot, withTempDir, writeEntry } from "../helpers/fixtures.ts";

const NOW = new Date("2026-06-01T00:00:00Z");
const BODY = "Conclusion first. Then conditions, evidence, and counterexamples for the reader. ";

test("extractLinks finds plain and scoped links", () => {
	assert.deepEqual(extractLinks("see [[abcdef01]] and [[user:abcdef01]]"), ["abcdef01", "user:abcdef01"]);
	assert.deepEqual(extractLinks("nothing"), []);
});

test("isValidDate rejects impossible dates", () => {
	assert.equal(isValidDate("2026-06-01"), true);
	assert.equal(isValidDate("2026-02-30"), false);
	assert.equal(isValidDate("soon"), false);
});

test("validateEntry warns for each rule", () => {
	const root = makeRoot("/k");
	const cases: Array<[EntryRecord, string]> = [
		[makeEntry({ title: "x".repeat(121) }), "title is 121 chars"],
		[makeEntry({ when: Array.from({ length: 6 }, () => "y".repeat(40)) }), "when totals"],
		[makeEntry({ body: "short" }), "shorter than 50"],
		[makeEntry({ body: "see [[zzzzzzzz]] and more text to reach the length minimum here" }), "has no target"],
		[makeEntry({ supersedes: "zzzzzzzz" }), "supersedes target"],
		[makeEntry({ reviewAfter: "2026-01-01" }), "has passed"],
		[makeEntry({ unknownFields: ["legacy"] }), "unknown frontmatter field"],
	];
	for (const [entry, expected] of cases) {
		const issues = validateEntry(entry, catalogOf([entry]), [root], "/repo", NOW);
		assert.ok(
			issues.some((issue) => issue.message.includes(expected)),
			`expected ${expected} in ${issues.map((issue) => issue.message).join(", ")}`,
		);
	}
});

test("validateEntry warns for a missing source path", () => {
	const entry = makeEntry({ source: "docs/missing.md" });
	const issues = validateEntry(entry, catalogOf([entry]), [makeRoot("/k")], "/definitely/missing", NOW);
	assert.ok(issues.some((issue) => issue.message.includes("source path not found")));
});

test("lintCatalog reports duplicates and nested markdown", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		writeEntry(dir, "11111111", { title: "Same" }, BODY);
		writeEntry(dir, "22222222", { title: "Same" }, BODY);
		const nested = path.join(dir, "sub");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "x.md"), entryText({ title: "Nested" }, BODY));
		const roots = [makeRoot(dir)];
		const catalog = buildCatalog(roots, []);
		const issues = lintCatalog(catalog, roots, cwd, NOW);
		assert.ok(issues.some((issue) => issue.message.includes("similar to")));
		assert.ok(issues.some((issue) => issue.message.includes("nested markdown")));
	});
});

test("lintCatalog reports invalid entries as errors", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "11111111.md"), "no frontmatter");
		const roots = [makeRoot(dir)];
		const catalog = buildCatalog(roots, []);
		const issues = lintCatalog(catalog, roots, cwd, NOW);
		assert.ok(issues.some((issue) => issue.level === "error" && issue.message.includes("no frontmatter")));
	});
});

test("lintCatalog warns when a superseded entry is still active", () => {
	const old = makeEntry({ id: "11111111", title: "Old" });
	const next = makeEntry({ id: "22222222", title: "New", supersedes: "11111111" });
	const roots = [makeRoot("/k")];
	const issues = lintCatalog(catalogOf([old, next]), roots, "/repo", NOW);
	assert.ok(issues.some((issue) => issue.message.includes("superseded by 22222222 but status is active")));
	const inactive = makeEntry({ id: "11111111", title: "Old", status: "superseded" });
	const clean = lintCatalog(catalogOf([inactive, next]), roots, "/repo", NOW);
	assert.ok(!clean.some((issue) => issue.message.includes("but status is active")));
});

test("lintCatalog reports id collisions between roots as errors", () => {
	withTempDir((cwd) => {
		const project = path.join(cwd, "knowledge");
		const user = path.join(cwd, "user");
		writeEntry(project, "01234567", { title: "P" }, BODY);
		writeEntry(user, "01234567", { title: "U" }, BODY);
		const roots = [makeRoot(project), makeRoot(user, { scope: "user", priority: 10 })];
		const catalog = buildCatalog(roots, []);
		const issues = lintCatalog(catalog, roots, cwd, NOW);
		assert.ok(issues.some((issue) => issue.level === "error" && issue.message.includes("exists in 2 roots")));
	});
});
