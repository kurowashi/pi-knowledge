import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fingerprintCatalog, readJsonCache, writeJsonCache } from "../../src/index_cache.ts";
import { catalogOf, makeEntry, withTempDir } from "../helpers/fixtures.ts";

test("fingerprintCatalog is stable and changes with the catalog or variant", () => {
	const catalog = catalogOf([makeEntry({ path: "/k/11111111.md", mtimeMs: 1, size: 10 })]);
	const first = fingerprintCatalog(catalog, "fts5");
	assert.equal(fingerprintCatalog(catalog, "fts5"), first);
	assert.notEqual(fingerprintCatalog(catalog, "embedding"), first);
	const changed = catalogOf([makeEntry({ path: "/k/11111111.md", mtimeMs: 2, size: 10 })]);
	assert.notEqual(fingerprintCatalog(changed, "fts5"), first);
});

test("JSON caches round-trip, tolerate corruption, and warn on write failure", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "cache.json");
		assert.equal(readJsonCache(file), null);
		assert.equal(writeJsonCache(file, { a: 1 }), null);
		assert.deepEqual(readJsonCache(file), { a: 1 });
		fs.writeFileSync(file, "{broken");
		assert.equal(readJsonCache(file), null);
		const blocked = path.join(dir, "file.txt", "cache.json");
		fs.writeFileSync(path.join(dir, "file.txt"), "x");
		assert.match(writeJsonCache(blocked, { a: 1 }) ?? "", /cannot write cache/);
	});
});
