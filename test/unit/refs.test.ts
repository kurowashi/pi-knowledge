import assert from "node:assert/strict";
import test from "node:test";
import { findReferences, formatReferences } from "../../src/refs.ts";
import { catalogOf, makeEntry } from "../helpers/fixtures.ts";

test("findReferences finds plain links, scoped links, and supersedes", () => {
	const target = makeEntry({ id: "11111111" });
	const linker = makeEntry({ id: "22222222", body: "see [[11111111]] for details, plus enough text" });
	const scoped = makeEntry({ id: "33333333", scope: "user", body: "see [[user:11111111]] here, plus enough text" });
	const replacer = makeEntry({ id: "44444444", supersedes: "11111111" });
	const report = findReferences(catalogOf([target, linker, scoped, replacer]), "11111111");
	assert.equal(report.target?.id, "11111111");
	assert.deepEqual(report.references.map((reference) => `${reference.from.id}:${reference.kind}`).sort(), [
		"22222222:link",
		"33333333:link",
		"44444444:supersedes",
	]);
	assert.match(formatReferences(report, "11111111"), /22222222 {2}\(link\)/);
});

test("an unknown id and an empty reference list format cleanly", () => {
	const missing = findReferences(catalogOf([]), "nope");
	assert.equal(missing.target, null);
	assert.match(formatReferences(missing, "nope"), /no entry with id nope/);
	const empty = { target: makeEntry(), references: [] };
	assert.equal(formatReferences(empty, "11111111"), "no references");
});

test("scoped links from another scope resolve to the local id", () => {
	const target = makeEntry({ id: "11111111", scope: "user" });
	const linker = makeEntry({ id: "22222222", scope: "project", body: "see [[user:11111111]] for details" });
	const report = findReferences(catalogOf([target, linker]), "11111111");
	assert.equal(report.references.length, 1);
	assert.equal(report.references[0]?.kind, "link");
});

test("an entry that supersedes and links is reported once", () => {
	const entry = makeEntry({ id: "22222222", supersedes: "11111111", body: "was [[11111111]] before" });
	const report = findReferences(catalogOf([makeEntry({ id: "11111111" }), entry]), "11111111");
	assert.equal(report.references.length, 1);
	assert.equal(report.references[0]?.kind, "supersedes");
});

test("scoped supersedes is a backlink", () => {
	const target = makeEntry({ id: "11111111", scope: "user" });
	const replacer = makeEntry({ id: "22222222", supersedes: "user:11111111" });
	const report = findReferences(catalogOf([target, replacer]), "11111111");
	assert.deepEqual(
		report.references.map((reference) => `${reference.from.id}:${reference.kind}`),
		["22222222:supersedes"],
	);
});
