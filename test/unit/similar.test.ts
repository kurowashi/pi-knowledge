import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicatePairs, formatDuplicatePairs } from "../../src/similar.ts";
import { catalogOf, makeEntry } from "../helpers/fixtures.ts";

const BODY = "Conclusion first. Then conditions, evidence, and counterexamples for the reader. ";

test("findDuplicatePairs finds near-identical active entries", () => {
	const a = makeEntry({ id: "11111111", title: "Same", body: BODY });
	const b = makeEntry({ id: "22222222", title: "Same", body: BODY });
	const c = makeEntry({ id: "33333333", title: "Different", body: "unrelated words entirely here" });
	const pairs = findDuplicatePairs(catalogOf([a, b, c]));
	assert.equal(pairs.length, 1);
	assert.equal(formatDuplicatePairs(pairs), "11111111  22222222  1.00");
});

test("inactive entries and low similarity are ignored", () => {
	const a = makeEntry({ id: "11111111", title: "Same", body: BODY });
	const b = makeEntry({ id: "22222222", title: "Same", body: BODY, status: "superseded" });
	const c = makeEntry({ id: "33333333", title: "Alpha beta", body: "alpha beta gamma delta epsilon zeta" });
	const d = makeEntry({ id: "44444444", title: "Kappa", body: "kappa lambda mu nu xi omicron" });
	assert.deepEqual(findDuplicatePairs(catalogOf([a, b])), []);
	assert.deepEqual(findDuplicatePairs(catalogOf([c, d])), []);
	assert.deepEqual(findDuplicatePairs(catalogOf([])), []);
});

test("the threshold is configurable", () => {
	const a = makeEntry({ id: "11111111", title: "Alpha beta gamma", body: "delta epsilon zeta eta theta" });
	const b = makeEntry({ id: "22222222", title: "Alpha beta gamma", body: "delta epsilon zeta eta iota" });
	assert.equal(findDuplicatePairs(catalogOf([a, b]), 0.99).length, 0);
	assert.equal(findDuplicatePairs(catalogOf([a, b]), 0.1).length, 1);
});

test("CJK notes are compared with their full token runs", () => {
	const a = makeEntry({ id: "11111111", title: "認証の設定", body: "外部APIの応答をスキーマ検証する。" });
	const b = makeEntry({ id: "22222222", title: "認証の設定", body: "外部APIの応答をスキーマ検証する。" });
	const c = makeEntry({ id: "33333333", title: "別の話題", body: "全く関係のない内容です。" });
	const pairs = findDuplicatePairs(catalogOf([a, b, c]));
	assert.equal(pairs.length, 1);
	assert.equal(pairs[0]?.b.id, "22222222");
});
