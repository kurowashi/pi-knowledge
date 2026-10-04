/**
 * Token-budget contract: the fixed text, the kb_search declaration, and the
 * bundled skill must stay within the budgets reserved by src/render.ts. If a
 * text grows past its budget, the index budget math silently overflows, so
 * this test fails the package instead (DESIGN.md §10.1).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions, formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { FIXED_TEXT, FIXED_TEXT_TOKEN_BUDGET, SKILL_TOKEN_BUDGET, TOOL_TOKEN_BUDGET } from "../../src/render.ts";
import { estimateTokens } from "../../src/tokens.ts";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

test("the fixed text fits its token budget", () => {
	const tokens = estimateTokens(FIXED_TEXT);
	assert.ok(tokens <= FIXED_TEXT_TOKEN_BUDGET, `FIXED_TEXT is ${tokens} tokens (budget ${FIXED_TEXT_TOKEN_BUDGET})`);
});

test("the kb_search declaration fits its token budget", async () => {
	const sandbox = mkdtempSync(join(tmpdir(), "pi-knowledge-budget-"));
	const loaded = await discoverAndLoadExtensions([join(PACKAGE_ROOT, "src", "index.ts")], sandbox, sandbox);
	const tool = loaded.extensions[0]?.tools.get("kb_search");
	assert.ok(tool, "kb_search must be registered");
	const declaration = JSON.stringify({
		name: tool.definition.name,
		description: tool.definition.description,
		promptSnippet: tool.definition.promptSnippet,
		parameters: tool.definition.parameters,
	});
	const tokens = estimateTokens(declaration);
	assert.ok(tokens <= TOOL_TOKEN_BUDGET, `kb_search declaration is ${tokens} tokens (budget ${TOOL_TOKEN_BUDGET})`);
});

test("the bundled skill prompt fits its token budget", () => {
	const loaded = loadSkillsFromDir({ dir: join(PACKAGE_ROOT, "skills"), source: "test" });
	// The absolute location varies per machine; measure the block, not the path.
	const prompt = formatSkillsForPrompt(loaded.skills ?? [], "read").replaceAll(PACKAGE_ROOT, "<pkg>");
	const tokens = estimateTokens(prompt);
	assert.ok(tokens <= SKILL_TOKEN_BUDGET, `skill prompt is ${tokens} tokens (budget ${SKILL_TOKEN_BUDGET})`);
});
