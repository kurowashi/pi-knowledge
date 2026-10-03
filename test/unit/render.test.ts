import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { effectiveBudget, FIXED_TEXT, renderIndex, renderLine, rootsLine, truncate } from "../../src/render.ts";
import { estimateTokens } from "../../src/tokens.ts";
import { catalogOf, makeEntry, makeRoot } from "../helpers/fixtures.ts";

test("effectiveBudget clamps by window, floor, and max", () => {
	assert.equal(effectiveBudget(DEFAULT_CONFIG, null), 4000);
	assert.equal(effectiveBudget(DEFAULT_CONFIG, 0), 4000);
	assert.equal(effectiveBudget(DEFAULT_CONFIG, 200_000), 4000);
	assert.equal(effectiveBudget(DEFAULT_CONFIG, 100_000), 2000);
	assert.equal(effectiveBudget(DEFAULT_CONFIG, 30_000), 1000);
});

test("truncate and rootsLine keep the line bounded", () => {
	assert.equal(truncate("abc", 5), "abc");
	assert.equal(truncate("abcdef", 5), "abcd…");
	const roots = [makeRoot("/a", { display: "/a" }), makeRoot("/b", { scope: "user", display: "~/.pi/knowledge" })];
	assert.equal(rootsLine(roots), "Roots: project=/a user=~/.pi/knowledge");
	assert.match(rootsLine([makeRoot("/a", { display: "x".repeat(40) })]), /…/);
});

test("renderLine formats and truncates both tiers", () => {
	const entry = makeEntry({ id: "01234567", title: "T", when: ["A", "B"] });
	assert.equal(renderLine(entry, false, "full"), "01234567  T — A / B");
	assert.equal(renderLine(entry, true, "title"), "project:01234567  T");
	assert.ok(renderLine(makeEntry({ title: "x".repeat(130) }), false, "full").includes("…"));
	assert.ok(renderLine(makeEntry({ title: "x".repeat(130) }), false, "title").includes("…"));
	assert.ok(!renderLine(makeEntry({ when: [] }), false, "full").includes(" — "));
});

test("renderIndex keeps bodies out and the budget in", () => {
	const roots = [makeRoot("/tmp/knowledge")];
	const entry = makeEntry({ body: "SECRET BODY ".repeat(50) });
	const rendered = renderIndex(catalogOf([entry]), roots, DEFAULT_CONFIG, 200_000);
	assert.equal(rendered.tier, "full");
	assert.ok(rendered.text.includes(entry.title));
	assert.ok(!rendered.text.includes("SECRET BODY"));
	assert.ok(rendered.totalTokens <= 4000);
});

test("renderIndex degrades full -> title -> pointer within the budget", () => {
	const roots = [makeRoot("/tmp/knowledge")];
	const entry = makeEntry({ title: "日".repeat(120), when: ["条".repeat(200)] });
	const catalog = catalogOf([entry]);
	const header = `${FIXED_TEXT}\n${rootsLine(roots)}`;
	const overhead = estimateTokens(header) + 120 + 60;
	const base = { ...DEFAULT_CONFIG, injection: { ...DEFAULT_CONFIG.injection, maxTokens: overhead + 250 } };
	assert.equal(renderIndex(catalog, roots, base, 200_000).tier, "title");
	const pointer = { ...base, injection: { ...base.injection, maxTokens: overhead + 10 } };
	const pointerResult = renderIndex(catalog, roots, pointer, 200_000);
	assert.equal(pointerResult.tier, "pointer");
	assert.ok(pointerResult.text.includes("kb_search"));
	const full = { ...base, injection: { ...base.injection, maxTokens: overhead + 700 } };
	assert.equal(renderIndex(catalog, roots, full, 200_000).tier, "full");
});
