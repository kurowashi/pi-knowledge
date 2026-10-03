import assert from "node:assert/strict";
import test from "node:test";
import { capSearchText, scoreEntry, searchCatalog, tokenize } from "../../src/search.ts";
import { catalogOf, makeEntry } from "../helpers/fixtures.ts";

function options(overrides: Partial<Parameters<typeof searchCatalog>[1]> = {}) {
	return { query: "", tags: [], status: "active" as const, scope: null, limit: 10, ...overrides };
}

test("tokenize splits ASCII and produces CJK characters and bigrams", () => {
	assert.deepEqual(tokenize("Hello World"), ["hello", "world"]);
	assert.deepEqual(tokenize("日本"), ["日", "日本", "本"]);
	assert.deepEqual(tokenize("a!!"), []);
});

test("scoreEntry weights title over body and handles empty terms", () => {
	const entry = makeEntry({ title: "API validation", body: "schema check only" });
	assert.equal(scoreEntry(entry, []), 1);
	assert.equal(scoreEntry(entry, ["missing"]), 0);
	assert.ok(scoreEntry(entry, ["validation"]) > scoreEntry(entry, ["schema"]));
});

test("searchCatalog filters by status, scope, tags, and query", () => {
	const alpha = makeEntry({ id: "aaaaaaaa", title: "Alpha", tags: ["x"] });
	const beta = makeEntry({ id: "bbbbbbbb", title: "Beta", status: "superseded", tags: ["x"] });
	const gamma = makeEntry({ id: "cccccccc", title: "Gamma", scope: "user", tags: ["y"] });
	const catalog = catalogOf([alpha, beta, gamma]);

	const active = searchCatalog(catalog, options());
	assert.deepEqual(
		active.hits.map((hit) => hit.id),
		["aaaaaaaa", "cccccccc"],
	);
	assert.equal(searchCatalog(catalog, options({ status: "superseded" })).hits.length, 1);
	assert.equal(searchCatalog(catalog, options({ scope: "user" })).hits[0]?.id, "cccccccc");
	assert.equal(searchCatalog(catalog, options({ tags: ["y"] })).hits[0]?.id, "cccccccc");
	assert.equal(searchCatalog(catalog, options({ query: "alpha" })).hits.length, 1);
	assert.equal(searchCatalog(catalog, options({ limit: 1 })).hits.length, 1);
	assert.equal(searchCatalog(catalog, options({ limit: 999 })).hits.length, 2);
});

test("equal scores tie-break by id", () => {
	const catalog = catalogOf([makeEntry({ id: "ffffffff" }), makeEntry({ id: "11111111" })]);
	assert.deepEqual(
		searchCatalog(catalog, options()).hits.map((hit) => hit.id),
		["11111111", "ffffffff"],
	);
});

test("searchCatalog is pure and includes a body excerpt", () => {
	const catalog = catalogOf([makeEntry({ body: "A body snippet that should appear in results." })]);
	const result = searchCatalog(catalog, options());
	assert.equal(result.backend, "lexical");
	assert.equal(result.fallback, false);
	assert.equal(result.fallbackReason, null);
	assert.equal(result.hits[0]?.fallback, undefined);
	assert.match(result.hits[0]?.excerpt ?? "", /should appear/);
});

test("capSearchText truncates with a pointer to limit", () => {
	const lines = ["a".repeat(50), "b".repeat(50)];
	assert.equal(capSearchText(lines, 1000).truncated, false);
	const capped = capSearchText(lines, 1);
	assert.equal(capped.truncated, true);
	assert.match(capped.text, /more; use limit/);
});

test("body-only matches are searchable", () => {
	const entry = makeEntry({ title: "Nothing", body: "uniqueterm appears here" });
	const hit = searchCatalog(catalogOf([entry]), options({ query: "uniqueterm" })).hits[0];
	assert.ok(hit !== undefined);
});
