import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { execute } from "../../src/cli.ts";
import { writeEntry } from "../helpers/fixtures.ts";

const BODY = "Conclusion first. Then conditions, evidence, and counterexamples for the reader. ";

async function project<T>(fn: (cwd: string, agent: string) => Promise<T>): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-knowledge-cli-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-knowledge-cli-agent-"));
	const saved = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agent;
	try {
		const dir = path.join(cwd, "knowledge");
		writeEntry(dir, "11111111", { title: "Alpha", tags: ["x"], when: ["setup"] }, BODY);
		writeEntry(dir, "22222222", { title: "Beta", tags: ["x", "y"], status: "superseded" }, BODY);
		return await fn(cwd, agent);
	} finally {
		if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = saved;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(agent, { recursive: true, force: true });
	}
}

test("list and tags respect status", async () => {
	await project(async (cwd) => {
		const list = await execute(["list"], cwd);
		assert.equal(list.code, 0);
		assert.match(list.stdout, /Alpha/);
		assert.doesNotMatch(list.stdout, /Beta/);
		assert.match((await execute(["list", "--all"], cwd)).stdout, /Beta/);
		assert.match((await execute(["tags"], cwd)).stdout, /x\t2/);
	});
});

test("find uses AND semantics and exit codes", async () => {
	await project(async (cwd) => {
		assert.equal((await execute(["find", "x"], cwd)).code, 0);
		assert.equal((await execute(["find", "x", "y"], cwd)).code, 0);
		assert.equal((await execute(["find", "missing"], cwd)).code, 1);
		assert.equal((await execute(["find"], cwd)).code, 2);
	});
});

test("search prints text and JSON with the entry path", async () => {
	await project(async (cwd) => {
		const text = await execute(["search", "alpha"], cwd);
		assert.equal(text.code, 0);
		assert.match(text.stdout, /Alpha/);
		assert.match(text.stdout, /\[x\]/);
		assert.match(text.stdout, /path:/);
		const json = await execute(["search", "alpha", "--json"], cwd);
		const parsed = JSON.parse(json.stdout) as { hits: unknown[] };
		assert.equal(parsed.hits.length, 1);
		assert.equal((await execute(["search", "alpha", "--limit", "1", "--status", "any"], cwd)).code, 0);
		assert.equal((await execute(["search", ""], cwd)).code, 2);
	});
});

test("a configured non-lexical backend falls back with a stderr note", async () => {
	await project(async (cwd) => {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "knowledge.json"), JSON.stringify({ search: { backend: "embedding" } }));
		const result = await execute(["search", "alpha"], cwd);
		assert.equal(result.code, 0);
		assert.match(result.stderr, /used lexical/);
		const required = await execute(["search", "alpha", "--require-backend"], cwd);
		assert.equal(required.code, 3);
	});
});

test("lint exits 1 on errors and unknown actions exit 2", async () => {
	await project(async (cwd) => {
		assert.equal((await execute(["lint"], cwd)).code, 0);
		fs.writeFileSync(path.join(cwd, "knowledge", "33333333.md"), "no frontmatter");
		const lint = await execute(["lint"], cwd);
		assert.equal(lint.code, 1);
		assert.match(lint.stdout, /no frontmatter/);
		const unknown = await execute(["nope"], cwd);
		assert.equal(unknown.code, 2);
		assert.match(unknown.stderr, /usage:/);
	});
});

test("a broken global config warns without failing", async () => {
	await project(async (cwd, agent) => {
		fs.writeFileSync(path.join(agent, "knowledge.json"), "{not json");
		const result = await execute(["list"], cwd);
		assert.equal(result.code, 0);
		assert.match(result.stderr, /not valid JSON/);
	});
});

test("stale, dups, and refs report from the catalog", async () => {
	await project(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "33333333", { title: "Alpha", review_after: "2020-01-01" }, BODY);
		const stale = await execute(["stale"], cwd);
		assert.equal(stale.code, 0);
		assert.match(stale.stdout, /review_after: 2020-01-01/);
		const dups = await execute(["dups"], cwd);
		assert.equal(dups.code, 0);
		assert.match(dups.stdout, /11111111 {2}33333333 {2}0\.9/);
		assert.equal((await execute(["dups", "--max", "1"], cwd)).code, 0);
		assert.equal((await execute(["dups", "--max", "0"], cwd)).code, 1);
		assert.equal((await execute(["dups", "--max", "nope"], cwd)).code, 2);
		assert.equal((await execute(["dups", "--max"], cwd)).code, 2);
		const refs = await execute(["refs", "11111111"], cwd);
		assert.equal(refs.code, 0);
		assert.match(refs.stdout, /no references/);
		assert.equal((await execute(["refs"], cwd)).code, 2);
	});
});

test("docs writes an index and checks drift", async () => {
	await project(async (cwd) => {
		fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "docs", "guide.md"), "# Guide\nbody");
		const write = await execute(["docs"], cwd);
		assert.equal(write.code, 0);
		assert.match(write.stdout, /wrote/);
		assert.ok(fs.existsSync(path.join(cwd, "docs", "INDEX.md")));
		assert.equal((await execute(["docs", "--check"], cwd)).code, 0);
		fs.writeFileSync(path.join(cwd, "docs", "guide.md"), "# Guide v2\nbody");
		assert.equal((await execute(["docs", "--check"], cwd)).code, 1);
	});
});

test("bench reads fixtures and validates them", async () => {
	await project(async (cwd) => {
		fs.writeFileSync(path.join(cwd, "fixtures.json"), JSON.stringify([{ query: "alpha", expect: ["11111111"] }]));
		const result = await execute(["bench", "fixtures.json", "--backend", "lexical"], cwd);
		assert.equal(result.code, 0);
		const reports = JSON.parse(result.stdout) as Array<{ recallAt1: number; backend: string }>;
		assert.equal(reports[0]?.backend, "lexical");
		assert.equal(reports[0]?.recallAt1, 1);
		assert.equal((await execute(["bench"], cwd)).code, 2);
		fs.writeFileSync(path.join(cwd, "bad.json"), "[1]");
		assert.equal((await execute(["bench", "bad.json"], cwd)).code, 2);
	});
});

test("search accepts --scope and warns on unknown status", async () => {
	await project(async (cwd) => {
		const projectScope = await execute(["search", "alpha", "--scope", "project"], cwd);
		assert.equal(projectScope.code, 0);
		assert.match(projectScope.stdout, /Alpha/);
		const userScope = await execute(["search", "alpha", "--scope", "user"], cwd);
		assert.equal(userScope.code, 0);
		assert.equal(userScope.stdout, "");
		const bad = await execute(["search", "alpha", "--status", "Active"], cwd);
		assert.equal(bad.code, 0);
		assert.match(bad.stderr, /unknown status/);
	});
});
