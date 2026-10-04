import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontmatter } from "../../src/frontmatter.ts";

test("no frontmatter returns the body unchanged", () => {
	const result = parseFrontmatter("plain text");
	assert.equal(result.meta, null);
	assert.equal(result.error, null);
	assert.equal(result.body, "plain text");
});

test("scalars, block lists, and inline arrays parse", () => {
	const text = [
		"---",
		"title: Hello world",
		'quoted: "a: b"',
		"single: 'it''s'",
		"when:",
		"  - first",
		"  - second",
		"tags: [a, 'b', c]",
		"empty:",
		"comment: before # trailing",
		"---",
		"",
		"Body line",
	].join("\n");
	const result = parseFrontmatter(text);
	assert.equal(result.error, null);
	assert.deepEqual(result.meta, {
		title: "Hello world",
		quoted: "a: b",
		single: "it's",
		when: ["first", "second"],
		tags: ["a", "b", "c"],
		empty: [],
		comment: "before # trailing",
	});
	assert.equal(result.body, "Body line");
});

test("unclosed frontmatter is an error", () => {
	const result = parseFrontmatter("---\ntitle: x\n");
	assert.equal(result.meta, null);
	assert.match(result.error ?? "", /not closed/);
});

test("invalid lines, indentation, and arrays are errors", () => {
	assert.match(parseFrontmatter("---\nnovalue\n---\n").error ?? "", /invalid frontmatter line/);
	assert.match(parseFrontmatter("---\n  nested: x\n---\n").error ?? "", /unexpected indentation/);
	assert.match(parseFrontmatter("---\ntags: [a, b\n---\n").error ?? "", /unterminated inline array/);
	assert.match(parseFrontmatter("---\ntitle: [WIP] fix\n---\n").error ?? "", /unterminated inline array/);
});

test("block scalar indicators are rejected with a clear error", () => {
	for (const value of [">", ">-", "|", "|+", ">2", "|2-", ">-2"]) {
		const result = parseFrontmatter(`---\ntitle: ${value}\n---\n`);
		assert.match(result.error ?? "", /block scalars are not supported/, `value ${value}`);
	}
});
