import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions, type Extension, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

const EXPECTED_EVENTS = ["before_agent_start", "session_start", "tool_call", "tool_result"];

async function loadKnowledgeExtension(): Promise<Extension> {
	const sandbox = mkdtempSync(join(tmpdir(), "pi-knowledge-surface-"));
	const result: LoadExtensionsResult = await discoverAndLoadExtensions(
		[join(PACKAGE_ROOT, "src", "index.ts")],
		sandbox,
		sandbox,
	);
	assert.deepEqual(result.errors, [], "the extension must load without errors");
	const extension = result.extensions[0];
	assert.ok(extension, "the loader must return the extension");
	assert.equal(result.extensions.length, 1, "the sandbox must load only this extension");
	return extension;
}

test("the only model-facing tool is kb_search", async () => {
	const extension = await loadKnowledgeExtension();
	assert.deepEqual([...extension.tools.keys()], ["kb_search"]);
});

test("the only command is /kb", async () => {
	const extension = await loadKnowledgeExtension();
	assert.deepEqual([...extension.commands.keys()], ["kb"]);
});

test("each documented event has exactly one handler", async () => {
	const extension = await loadKnowledgeExtension();
	assert.deepEqual([...extension.handlers.keys()].sort(), EXPECTED_EVENTS);
	for (const event of EXPECTED_EVENTS) {
		assert.equal(extension.handlers.get(event)?.length, 1, `${event} must have exactly one handler`);
	}
});
