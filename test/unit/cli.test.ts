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
