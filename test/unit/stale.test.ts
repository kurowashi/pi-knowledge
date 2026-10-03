import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { formatStale, staleReport } from "../../src/stale.ts";
import { catalogOf, makeEntry, withTempDir } from "../helpers/fixtures.ts";

const NOW = new Date("2026-06-01T00:00:00Z");
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

test("review_after overdue entries are reported with a non-git warning", () => {
	const entry = makeEntry({ id: "11111111", reviewAfter: "2026-01-01" });
	const report = staleReport(catalogOf([entry]), DEFAULT_CONFIG, "/definitely/not/a/git/repo", NOW);
	assert.equal(report.entries.length, 1);
	assert.equal(report.entries[0]?.reason, "review_after");
	assert.match(formatStale(report), /review_after: 2026-01-01/);
	assert.ok(report.warnings.some((warning) => warning.includes("git")));
});

test("inactive entries are skipped", () => {
	const entry = makeEntry({ reviewAfter: "2026-01-01", status: "deprecated" });
	const report = staleReport(catalogOf([entry]), DEFAULT_CONFIG, "/definitely/not/a/git/repo", NOW);
	assert.deepEqual(report.entries, []);
	assert.equal(formatStale(report), report.warnings.join("\n"));
});

test("git dates flag old files and shallow clones are skipped", { skip: !gitAvailable }, () => {
	withTempDir((cwd) => {
		const run = ["-c", "user.email=t@example.com", "-c", "user.name=tester"];
		spawnSync("git", ["init", "-q"], { cwd });
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "11111111.md");
		fs.writeFileSync(file, "---\ntitle: Old\n---\nbody");
		spawnSync("git", ["add", "."], { cwd });
		const env = { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
		spawnSync("git", [...run, "commit", "-q", "-m", "old"], { cwd, env });
		const config = { ...DEFAULT_CONFIG, stale: { days: 1 } };
		const report = staleReport(catalogOf([makeEntry({ id: "11111111", path: file })]), config, cwd, NOW);
		assert.equal(report.entries[0]?.reason, "git_date");
		assert.equal(report.warnings.length, 0);

		fs.writeFileSync(path.join(cwd, ".git", "shallow"), "");
		const shallow = staleReport(catalogOf([makeEntry({ id: "11111111", path: file })]), config, cwd, NOW);
		assert.ok(shallow.warnings.some((warning) => warning.includes("shallow")));
	});
});
