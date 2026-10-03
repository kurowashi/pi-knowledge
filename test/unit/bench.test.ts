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
});

test("runBench computes recall and MRR for lexical search", () => {
	const catalog = catalogOf([makeEntry({ id: "11111111", title: "Alpha" })]);
	const report = runBench(catalog, DEFAULT_CONFIG, [{ query: "alpha", expect: ["11111111"] }], 2);
	assert.equal(report.recallAt1, 1);
	assert.equal(report.recallAt3, 1);
	assert.equal(report.recallAt5, 1);
	assert.equal(report.mrr, 1);
	assert.equal(report.backend, "lexical");
	assert.equal(report.fallback, false);
	assert.equal(report.actualTokens, null);
	assert.ok(report.latencyMs.p50 >= 0);
	assert.ok(report.indexBuildMs >= 0);
});

test("missing expectations count as zero recall and an empty fixture set is safe", () => {
	const catalog = catalogOf([makeEntry({ id: "11111111", title: "Alpha" })]);
	const miss = runBench(catalog, DEFAULT_CONFIG, [{ query: "alpha", expect: ["99999999"] }], 1);
	assert.equal(miss.recallAt1, 0);
	assert.equal(miss.mrr, 0);
	const empty = runBench(catalog, DEFAULT_CONFIG, [], 1);
	assert.equal(empty.fixtures, 0);
	assert.equal(empty.recallAt1, 0);
});

test("a non-lexical backend is reported as a fallback", () => {
	const config = { ...DEFAULT_CONFIG, search: { ...DEFAULT_CONFIG.search, backend: "embedding" as const } };
	const report = runBench(catalogOf([]), config, [{ query: "x", expect: [] }], 1);
	assert.equal(report.fallback, true);
	assert.equal(report.backend, "embedding");
});
