import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { HookContext } from "../../src/hooks.ts";
import { applyEdits, findKnowledgeTarget, planEdit, planWrite } from "../../src/hooks.ts";
import { catalogOf, entryText, makeEntry, makeRoot, withTempDir, writeEntry } from "../helpers/fixtures.ts";

const BODY = "Conclusion first. Then conditions, evidence, and counterexamples for the reader. ";
const NOW = new Date("2026-06-01T00:00:00Z");

function context(cwd: string, dir: string, catalog = catalogOf([]), enforce: "block" | "warn" = "block"): HookContext {
	return { cwd, roots: [makeRoot(dir)], catalog, enforce, now: NOW };
}

test("findKnowledgeTarget detects in-root, nested, and outside paths", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(dir, { recursive: true });
		const roots = [makeRoot(dir)];
		assert.equal(findKnowledgeTarget("knowledge/a.md", cwd, roots)?.nested, false);
		assert.equal(findKnowledgeTarget("knowledge/sub/a.md", cwd, roots)?.nested, true);
		assert.equal(findKnowledgeTarget("knowledge/a.txt", cwd, roots), null);
		assert.equal(findKnowledgeTarget("other/a.md", cwd, roots), null);
	});
});

test("applyEdits applies sequentially and returns null on a miss", () => {
	assert.equal(applyEdits("abc", [{ oldText: "b", newText: "x" }]), "axc");
	assert.equal(applyEdits("abc", [{ oldText: "zz", newText: "x" }]), null);
	assert.equal(
		applyEdits("ab", [
			{ oldText: "a", newText: "c" },
			{ oldText: "b", newText: "d" },
		]),
		"cd",
	);
});

test("planWrite assigns an id and rewrites the path", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(dir, { recursive: true });
		const outcome = planWrite(
			{ path: "knowledge/my-note.md", content: entryText({ title: "N" }, BODY) },
			context(cwd, dir),
		);
		assert.equal(outcome.allow, true);
		assert.match(outcome.path ?? "", /knowledge[/\\][0-9a-f]{8}\.md$/);
	});
});

test("planWrite keeps a valid unused id and normalizes nested paths", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
		const kept = planWrite(
			{ path: "knowledge/abcdef01.md", content: entryText({ title: "N" }, BODY) },
			context(cwd, dir),
		);
		assert.equal(kept.path, path.join("knowledge", "abcdef01.md"));
		const nested = planWrite(
			{ path: "knowledge/sub/n.md", content: entryText({ title: "N" }, BODY) },
			context(cwd, dir),
		);
		assert.equal(path.dirname(nested.path ?? ""), "knowledge");
	});
});

test("planWrite avoids shadowing an id used by another root", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(dir, { recursive: true });
		const existing = makeEntry({ id: "abcdef01" });
		const outcome = planWrite(
			{ path: "knowledge/abcdef01.md", content: entryText({ title: "N" }, BODY) },
			context(cwd, dir, catalogOf([existing])),
		);
		assert.notEqual(outcome.path, path.join("knowledge", "abcdef01.md"));
	});
});

test("planWrite blocks overwrite, readonly, and errors; warn allows with notes", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		writeEntry(dir, "01234567", { title: "Old" }, BODY);
		const overwrite = planWrite(
			{ path: "knowledge/01234567.md", content: entryText({ title: "New" }, BODY) },
			context(cwd, dir),
		);
		assert.equal(overwrite.allow, false);
		assert.match(overwrite.reason ?? "", /use edit/);

		const readonly = planWrite(
			{ path: "knowledge/new.md", content: entryText({ title: "N" }, BODY) },
			{ ...context(cwd, dir), roots: [makeRoot(dir, { readonly: true })] },
		);
		assert.equal(readonly.allow, false);

		const invalid = { path: "knowledge/new.md", content: "no frontmatter" };
		assert.equal(planWrite(invalid, context(cwd, dir)).allow, false);
		const warned = planWrite(invalid, context(cwd, dir, catalogOf([]), "warn"));
		assert.equal(warned.allow, true);
		assert.ok(warned.notes.some((note) => note.startsWith("error:")));
	});
});

test("planWrite leaves paths outside the roots untouched", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(dir, { recursive: true });
		const outcome = planWrite({ path: "src/other.md", content: "anything" }, context(cwd, dir));
		assert.deepEqual(outcome, { allow: true, notes: [] });
	});
});

test("planEdit validates, blocks shadowed ids, and ignores non-entries", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		const file = writeEntry(dir, "01234567", { title: "Old" }, BODY);
		const ok = planEdit(
			{ path: path.relative(cwd, file), edits: [{ oldText: "Old", newText: "New" }] },
			context(cwd, dir),
		);
		assert.equal(ok.allow, true);

		const broken = planEdit(
			{ path: path.relative(cwd, file), edits: [{ oldText: 'title: "Old"', newText: "nope: 1" }] },
			context(cwd, dir),
		);
		assert.equal(broken.allow, false);
		const warned = planEdit(
			{ path: path.relative(cwd, file), edits: [{ oldText: 'title: "Old"', newText: "nope: 1" }] },
			context(cwd, dir, catalogOf([]), "warn"),
		);
		assert.equal(warned.allow, true);

		const shadow = planEdit(
			{ path: path.relative(cwd, file), edits: [{ oldText: "Old", newText: "New" }] },
			context(cwd, dir, catalogOf([makeEntry({ id: "01234567", dir: "/elsewhere" })])),
		);
		assert.equal(shadow.allow, false);

		assert.deepEqual(planEdit({ path: "knowledge/missing.md", edits: [] }, context(cwd, dir)), {
			allow: true,
			notes: [],
		});
		assert.deepEqual(planEdit({ path: "src/x.md", edits: [] }, context(cwd, dir)), { allow: true, notes: [] });
	});
});
