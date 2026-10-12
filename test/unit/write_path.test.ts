import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { WriteContext } from "../../src/core/write_path.ts";
import { findKnowledgeTarget, planWrite } from "../../src/core/write_path.ts";
import { catalogOf, makeRoot, withTempDir, writeEntry } from "../helpers/fixtures.ts";

function context(cwd: string, dir: string, enforce: "block" | "warn" = "block"): WriteContext {
	return { cwd, roots: [makeRoot(dir)], catalog: catalogOf([]), enforce };
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

test("planWrite allows a new entry and never rewrites the path", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(dir, { recursive: true });
		const outcome = planWrite({ path: "knowledge/my-note.md" }, context(cwd, dir));
		assert.deepEqual(outcome, { allow: true, notes: [] });
		assert.equal("path" in outcome, false);
	});
});

test("planWrite refuses an existing entry and warns in warn mode", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		writeEntry(dir, "pi_retry_budget", { title: "Old" }, "body");

		const blocked = planWrite({ path: "knowledge/pi_retry_budget.md" }, context(cwd, dir));
		assert.equal(blocked.allow, false);
		assert.match(blocked.reason ?? "", /use edit/);

		const warned = planWrite({ path: "knowledge/pi_retry_budget.md" }, context(cwd, dir, "warn"));
		assert.equal(warned.allow, true);
		assert.equal(warned.notes.length, 1);
		assert.match(warned.notes[0] ?? "", /warning: entry pi_retry_budget already exists/);
	});
});

test("planWrite refuses a read-only root even in warn mode", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(dir, { recursive: true });
		const ctx = { ...context(cwd, dir, "warn"), roots: [makeRoot(dir, { readonly: true })] };
		const outcome = planWrite({ path: "knowledge/new.md" }, ctx);
		assert.equal(outcome.allow, false);
		assert.match(outcome.reason ?? "", /read-only/);
	});
});

test("planWrite leaves paths outside the roots and nested paths untouched", () => {
	withTempDir((cwd) => {
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
		assert.deepEqual(planWrite({ path: "src/other.md" }, context(cwd, dir)), { allow: true, notes: [] });
		assert.deepEqual(planWrite({ path: "knowledge/sub/n.md" }, context(cwd, dir)), { allow: true, notes: [] });
	});
});
