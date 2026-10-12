/**
 * Token-budget contract: the fixed text, the kb_search declaration, and the
 * bundled skill must stay within the budgets reserved by src/core/render.ts. If a
 * text grows past its budget, the index budget math silently overflows, so
 * this test fails the package instead (DESIGN.md §10.1).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions, formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { FIXED_TEXT, FIXED_TEXT_TOKEN_BUDGET, SKILL_TOKEN_BUDGET, TOOL_TOKEN_BUDGET } from "../../src/core/render.ts";
import { estimateTokens } from "../../src/core/tokens.ts";
import opencodePlugin from "../../src/hosts/opencode.ts";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

interface DeclaredTool {
	name: string;
	description: string;
	input: unknown;
}

/** Load the OpenCode adapter and capture the tool declaration it registers. */
async function opencodeSearchDeclaration(): Promise<string> {
	let declared: DeclaredTool | null = null;
	const context = {
		location: { directory: mkdtempSync(join(tmpdir(), "pi-knowledge-budget-oc-")) },
		session: { hook: async () => ({}), prompt: async () => {}, synthetic: async () => {} },
		tool: {
			hook: async () => ({}),
			transform: async (callback: (editor: { add(tool: DeclaredTool): void }) => void) => {
				callback({
					add: (tool) => {
						declared = tool;
					},
				});
				return { dispose: () => {} };
			},
		},
		permission: { hook: async () => ({ dispose: () => {} }) },
		command: { transform: async () => ({ dispose: () => {} }) },
	};
	await opencodePlugin.setup(context as never);
	assert.ok(declared, "kb_search must be registered for OpenCode");
	const { name, description, input } = declared as DeclaredTool;
	return JSON.stringify({ name, description, input });
}

test("the fixed text fits its token budget", () => {
	const tokens = estimateTokens(FIXED_TEXT);
	assert.ok(tokens <= FIXED_TEXT_TOKEN_BUDGET, `FIXED_TEXT is ${tokens} tokens (budget ${FIXED_TEXT_TOKEN_BUDGET})`);
});

test("the kb_search declaration fits its token budget", async () => {
	const sandbox = mkdtempSync(join(tmpdir(), "pi-knowledge-budget-"));
	const loaded = await discoverAndLoadExtensions([join(PACKAGE_ROOT, "src", "hosts", "pi.ts")], sandbox, sandbox);
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

test("the OpenCode kb_search declaration fits the same token budget", async () => {
	const declaration = await opencodeSearchDeclaration();
	const tokens = estimateTokens(declaration);
	assert.ok(
		tokens <= TOOL_TOKEN_BUDGET,
		`OpenCode kb_search declaration is ${tokens} tokens (budget ${TOOL_TOKEN_BUDGET})`,
	);
});

test("both hosts declare the same parameters for kb_search", async () => {
	const loaded = await discoverAndLoadExtensions(
		[join(PACKAGE_ROOT, "src", "hosts", "pi.ts")],
		mkdtempSync(join(tmpdir(), "kb-")),
		mkdtempSync(join(tmpdir(), "kb-")),
	);
	const pi = loaded.extensions[0]?.tools.get("kb_search")?.definition.parameters as {
		properties?: Record<string, unknown>;
	};
	const oc = JSON.parse(await opencodeSearchDeclaration()) as { input?: { properties?: Record<string, unknown> } };
	assert.deepEqual(Object.keys(oc.input?.properties ?? {}).sort(), Object.keys(pi?.properties ?? {}).sort());
});

test("the bundled skill prompt fits its token budget", () => {
	const loaded = loadSkillsFromDir({ dir: join(PACKAGE_ROOT, "skills"), source: "test" });
	// The absolute location varies per machine; measure the block, not the path.
	const prompt = formatSkillsForPrompt(loaded.skills ?? [], "read").replaceAll(PACKAGE_ROOT, "<pkg>");
	const tokens = estimateTokens(prompt);
	assert.ok(tokens <= SKILL_TOKEN_BUDGET, `skill prompt is ${tokens} tokens (budget ${SKILL_TOKEN_BUDGET})`);
});
