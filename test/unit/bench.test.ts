import assert from "node:assert/strict";
import test from "node:test";
import { parseFixtures, runBench } from "../../src/bench.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { catalogOf, makeEntry } from "../helpers/fixtures.ts";

test("parseFixtures validates the shape", () => {
	assert.deepEqual(parseFixtures([{ query: "a", expect: ["x"] }]), [{ query: "a", expect: ["x"] }]);
	assert.equal(parseFixtures("no"), null);
	assert.equal(parseFixtures([{ query: "a", expect: [1] }]), null);
	assert.equal(parseFixtures([{ query: 1, expect: [] }]), null);
	assert.equal(parseFixtures([null]), null);
	assert.equal(parseFixtures([{ query: "a", expect: [], tags: [1] }]), null);
	assert.deepEqual(parseFixtures([{ query: "a", expect: [], tags: ["x"] }]), [{ query: "a", expect: [], tags: ["x"] }]);
});

test("runBench computes recall and MRR for lexical search", async () => {
	const catalog = catalogOf([makeEntry({ id: "11111111", title: "Alpha" })]);
	const reports = await runBench(catalog, DEFAULT_CONFIG, [{ query: "alpha", expect: ["11111111"] }], 2, ["lexical"]);
	const report = reports[0];
	assert.ok(report);
	assert.equal(report.backend, "lexical");
	assert.equal(report.recallAt1, 1);
	assert.equal(report.recallAt3, 1);
	assert.equal(report.recallAt5, 1);
	assert.equal(report.mrr, 1);
	assert.equal(report.fallback, false);
	assert.equal(report.actualTokens, null);
	assert.ok(report.latencyMs.p50 >= 0);
	assert.ok(report.indexBuildMs >= 0);
});

test("tag-only fixtures can hit and missing expectations score zero", async () => {
	const entry = makeEntry({ id: "11111111", title: "Unrelated", tags: ["x"], body: "nothing relevant here" });
	const tagged = await runBench(
		catalogOf([entry]),
		DEFAULT_CONFIG,
		[{ query: "", expect: ["11111111"], tags: ["x"] }],
		1,
		["lexical"],
	);
	assert.equal(tagged[0]?.recallAt1, 1);
	const miss = await runBench(catalogOf([entry]), DEFAULT_CONFIG, [{ query: "alpha", expect: ["99999999"] }], 1, [
		"lexical",
	]);
	assert.equal(miss[0]?.recallAt1, 0);
	assert.equal(miss[0]?.mrr, 0);
});

test("an unavailable backend is reported with a fallback reason", async () => {
	const config = { ...DEFAULT_CONFIG, search: { ...DEFAULT_CONFIG.search, backend: "embedding" as const } };
	const reports = await runBench(catalogOf([]), config, [{ query: "x", expect: [] }], 1, ["embedding"]);
	assert.equal(reports[0]?.backend, "embedding");
	assert.equal(reports[0]?.fallback, true);
	assert.equal(reports[0]?.fallbackReason, "unavailable");
	const empty = await runBench(catalogOf([]), DEFAULT_CONFIG, [], 1, ["lexical"]);
	assert.equal(empty[0]?.fixtures, 0);
	assert.equal(empty[0]?.recallAt1, 0);
});
