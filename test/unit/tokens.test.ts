import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "../../src/tokens.ts";

test("estimates are conservative per character class", () => {
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("abcd"), 2);
	assert.equal(estimateTokens("01234567"), 4);
	assert.equal(estimateTokens("日本語のテキスト"), 12);
	assert.ok(estimateTokens("日本語") > estimateTokens("abc"));
});

test("the id form costs at most four tokens", () => {
	assert.ok(estimateTokens("0123abcd") <= 4);
});
