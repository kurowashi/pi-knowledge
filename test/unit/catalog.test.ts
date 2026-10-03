import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildCatalog, parseEntryText, removeEntry, rescanCatalog, upsertEntry } from "../../src/catalog.ts";
import { entryText, makeEntry, makeRoot, withTempDir, writeEntry } from "../helpers/fixtures.ts";

const BODY = "Conclusion first. Then conditions, evidence, and counterexamples for the reader. ";

test("parseEntryText reads the documented fields", () => {
	const text = entryText(
		{
			title: "T",
			when: ["a", "b"],
			tags: ["x"],
			status: "superseded",
			supersedes: "deadbeef",
			review_after: "2027-01-01",
			source: "docs/a.md",
		},
		BODY,
	);
	const result = parseEntryText(text, "01234567", makeRoot("/k"), "/k/01234567.md", 1, 2);
	assert.equal(result.invalid, null);
	assert.equal(result.entry?.title, "T");
	assert.deepEqual(result.entry?.when, ["a", "b"]);
	assert.deepEqual(result.entry?.tags, ["x"]);
	assert.equal(result.entry?.status, "superseded");
	assert.equal(result.entry?.supersedes, "deadbeef");
	assert.equal(result.entry?.reviewAfter, "2027-01-01");
	assert.equal(result.entry?.source, "docs/a.md");
	assert.equal(result.entry?.mtimeMs, 1);
	assert.equal(result.entry?.size, 2);
});

test("when accepts a single string and defaults are applied", () => {
	const result = parseEntryText(`---\ntitle: T\nwhen: only\n---\n${BODY}`, "01234567", makeRoot("/k"), "/k/x.md", 0, 0);
	assert.deepEqual(result.entry?.when, ["only"]);
	assert.equal(result.entry?.status, "active");
	assert.deepEqual(result.entry?.tags, []);
});

test("parse and type errors exclude the entry", () => {
	const cases: Array<[string, string]> = [
		[BODY, "no frontmatter"],
		["---\nwhen: x\n---\nbody", "title is required"],
		[`---\ntitle: T\ntags: solo\n---\n${BODY}`, "tags must be a list of text"],
		[`---\ntitle: T\nstatus: nope\n---\n${BODY}`, "status must be"],
		[`---\ntitle: T\nreview_after: soon\n---\n${BODY}`, "review_after must be"],
		[`---\ntitle: T\nsupersedes:\n  - a\n---\n${BODY}`, "supersedes must be an id"],
		[`---\ntitle: T\nsource:\n  - a\n---\n${BODY}`, "source must be text"],
	];
	for (const [text, expected] of cases) {
		const result = parseEntryText(text, "01234567", makeRoot("/k"), "/k/x.md", 0, 0);
		assert.match(result.invalid ?? "", new RegExp(expected));
	}
});

test("a minimal valid entry parses", () => {
	const result = parseEntryText(`---\ntitle: T\n---\nbody`, "01234567", makeRoot("/k"), "/k/x.md", 0, 0);
	assert.equal(result.invalid, null);
	assert.equal(result.entry?.title, "T");
});

test("buildCatalog skips non-entry names and collects invalid entries", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		writeEntry(dir, "01234567", { title: "Good" }, BODY);
		fs.writeFileSync(path.join(dir, "README.md"), "# docs");
		fs.writeFileSync(path.join(dir, "11111111.md"), "no frontmatter here");
		const warnings: string[] = [];
		const catalog = buildCatalog([makeRoot(dir)], warnings);
		assert.equal(catalog.entries.length, 1);
		assert.equal(catalog.invalid.length, 1);
		assert.ok(warnings.some((warning) => warning.includes("not <hex8>.md")));
	});
});

test("id collisions are exposed and resolved by priority", () => {
	withTempDir((cwd) => {
		const project = path.join(cwd, "knowledge");
		const user = path.join(cwd, "user");
		writeEntry(project, "01234567", { title: "Project" }, BODY);
		writeEntry(user, "01234567", { title: "User" }, BODY);
		const catalog = buildCatalog([makeRoot(project), makeRoot(user, { scope: "user", priority: 10 })], []);
		assert.equal(catalog.collisions.size, 1);
		assert.equal(catalog.byId.get("01234567")?.title, "Project");
	});
});

test("upsertEntry and removeEntry rebuild the lookup", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		const root = makeRoot(dir);
		const catalog = buildCatalog([root], []);
		const entry = makeEntry({ dir, path: path.join(dir, "abcdef01.md") });
		const added = upsertEntry(catalog, entry, [root]);
		assert.equal(added.byId.get(entry.id)?.path, entry.path);
		const removed = removeEntry(added, entry.path, [root]);
		assert.equal(removed.byId.has(entry.id), false);
	});
});

test("rescanCatalog reuses unchanged entries and picks up edits", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		const file = writeEntry(dir, "01234567", { title: "Old" }, BODY);
		const roots = [makeRoot(dir)];
		const first = buildCatalog(roots, []);
		const second = rescanCatalog(first, roots, []);
		assert.equal(second.entries[0]?.title, "Old");
		fs.writeFileSync(file, entryText({ title: "New" }, BODY));
		fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
		const third = rescanCatalog(second, roots, []);
		assert.equal(third.entries[0]?.title, "New");
	});
});
