import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { execute } from "../../src/cli.ts";
import { withAgentDir, withTempDir, writeEntry } from "../helpers/fixtures.ts";

const BODY = "Conclusion first. Then conditions, evidence, and counterexamples for the reader. ";

function project<T>(fn: (cwd: string, agent: string) => T): T {
	return withTempDir((cwd) =>
		withTempDir((agent) =>
			withAgentDir(agent, () => {
				const dir = path.join(cwd, "knowledge");
				writeEntry(dir, "11111111", { title: "Alpha", tags: ["x"], when: ["setup"] }, BODY);
				writeEntry(dir, "22222222", { title: "Beta", tags: ["x", "y"], status: "superseded" }, BODY);
				return fn(cwd, agent);
			}),
		),
	);
}

test("list and tags respect status", () => {
	project((cwd) => {
		const list = execute(["list"], cwd);
		assert.equal(list.code, 0);
		assert.match(list.stdout, /Alpha/);
		assert.doesNotMatch(list.stdout, /Beta/);
		assert.match(execute(["list", "--all"], cwd).stdout, /Beta/);
		assert.match(execute(["tags"], cwd).stdout, /x\t2/);
	});
});

test("find uses AND semantics and exit codes", () => {
	project((cwd) => {
		assert.equal(execute(["find", "x"], cwd).code, 0);
		assert.equal(execute(["find", "x", "y"], cwd).code, 0);
		assert.equal(execute(["find", "missing"], cwd).code, 1);
		assert.equal(execute(["find"], cwd).code, 2);
	});
});

test("search prints text and JSON with the entry path", () => {
	project((cwd) => {
		const text = execute(["search", "alpha"], cwd);
		assert.equal(text.code, 0);
		assert.match(text.stdout, /Alpha/);
		assert.match(text.stdout, /path:/);
		const json = execute(["search", "alpha", "--json"], cwd);
		const parsed = JSON.parse(json.stdout) as { hits: unknown[] };
		assert.equal(parsed.hits.length, 1);
		assert.equal(execute(["search", "alpha", "--limit", "1", "--status", "any"], cwd).code, 0);
		assert.equal(execute(["search", ""], cwd).code, 2);
	});
});

test("a configured non-lexical backend falls back with a stderr note", () => {
	project((cwd) => {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "knowledge.json"), JSON.stringify({ search: { backend: "embedding" } }));
		const result = execute(["search", "alpha"], cwd);
		assert.equal(result.code, 0);
		assert.match(result.stderr, /used lexical/);
	});
});

test("lint exits 1 on errors and unknown actions exit 2", () => {
	project((cwd) => {
		assert.equal(execute(["lint"], cwd).code, 0);
		fs.writeFileSync(path.join(cwd, "knowledge", "33333333.md"), "no frontmatter");
		const lint = execute(["lint"], cwd);
		assert.equal(lint.code, 1);
		assert.match(lint.stdout, /no frontmatter/);
		const unknown = execute(["nope"], cwd);
		assert.equal(unknown.code, 2);
		assert.match(unknown.stderr, /usage:/);
	});
});

test("a broken global config warns without failing", () => {
	project((cwd, agent) => {
		fs.writeFileSync(path.join(agent, "knowledge.json"), "{not json");
		const result = execute(["list"], cwd);
		assert.equal(result.code, 0);
		assert.match(result.stderr, /not valid JSON/);
	});
});

test("stale, dups, and refs report from the catalog", () => {
	project((cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "33333333", { title: "Alpha", review_after: "2020-01-01" }, BODY);
		const stale = execute(["stale"], cwd);
		assert.equal(stale.code, 0);
		assert.match(stale.stdout, /review_after: 2020-01-01/);
		const dups = execute(["dups"], cwd);
		assert.equal(dups.code, 0);
		assert.match(dups.stdout, /11111111 {2}33333333 {2}0\.9/);
		const refs = execute(["refs", "11111111"], cwd);
		assert.equal(refs.code, 0);
		assert.match(refs.stdout, /no references/);
		assert.equal(execute(["refs"], cwd).code, 2);
	});
});

test("docs writes an index and checks drift", () => {
	project((cwd) => {
		fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "docs", "guide.md"), "# Guide\nbody");
		const write = execute(["docs"], cwd);
		assert.equal(write.code, 0);
		assert.match(write.stdout, /wrote/);
		assert.ok(fs.existsSync(path.join(cwd, "docs", "INDEX.md")));
		assert.equal(execute(["docs", "--check"], cwd).code, 0);
		fs.writeFileSync(path.join(cwd, "docs", "guide.md"), "# Guide v2\nbody");
		assert.equal(execute(["docs", "--check"], cwd).code, 1);
	});
});

test("bench reads fixtures and validates them", () => {
	project((cwd) => {
		fs.writeFileSync(path.join(cwd, "fixtures.json"), JSON.stringify([{ query: "alpha", expect: ["11111111"] }]));
		const result = execute(["bench", "fixtures.json"], cwd);
		assert.equal(result.code, 0);
		const report = JSON.parse(result.stdout) as { recallAt1: number; backend: string };
		assert.equal(report.recallAt1, 1);
		assert.equal(report.backend, "lexical");
		assert.equal(execute(["bench"], cwd).code, 2);
		fs.writeFileSync(path.join(cwd, "bad.json"), "[1]");
		assert.equal(execute(["bench", "bad.json"], cwd).code, 2);
	});
});
