/**
 * Model-facing surface contract. Both hosts must expose exactly one tool and
 * one command, and no host may add a write tool (DESIGN.md §14).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions, type Extension, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { Context } from "@opencode/plugin/promise/plugin";
import opencodePlugin from "../../src/hosts/opencode.ts";
import { PACKAGE_ROOT } from "../helpers/paths.ts";

const EXPECTED_EVENTS = ["before_agent_start", "session_compact", "session_start", "tool_call", "tool_result"];

async function loadKnowledgeExtension(): Promise<Extension> {
	const sandbox = mkdtempSync(join(tmpdir(), "pi-knowledge-surface-"));
	const result: LoadExtensionsResult = await discoverAndLoadExtensions(
		[join(PACKAGE_ROOT, "src", "hosts", "pi.ts")],
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

interface StubHost {
	ctx: Context;
	tools: Map<string, { name: string; description: string }>;
	commands: Map<string, { name: string }>;
	hooks: string[];
}

/** Remove the scratch directories a test created. */
function cleanup(...dirs: string[]): void {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

async function loadOpencodePlugin(cwd: string): Promise<StubHost> {
	const tools = new Map<string, { name: string; description: string }>();
	const commands = new Map<string, { name: string }>();
	const hooks: string[] = [];
	const record = (name: string) => async () => {
		hooks.push(name);
		return { dispose: () => {} };
	};
	const noop = async () => {};
	const ctx = {
		location: { directory: cwd },
		session: {
			hook: async (name: string, _callback: unknown) => record(`session:${name}`)(),
			prompt: noop,
			synthetic: noop,
		},
		tool: {
			hook: async (name: string, _callback: unknown) => record(`tool:${name}`)(),
			transform: async (callback: (editor: { add(tool: { name: string; description: string }): void }) => void) => {
				callback({ add: (tool) => tools.set(tool.name, tool) });
				return { dispose: () => {} };
			},
		},
		permission: { hook: async (name: string, _callback: unknown) => record(`permission:${name}`)() },
		command: {
			transform: async (callback: (editor: { add(command: { name: string }): void }) => void) => {
				callback({ add: (command) => commands.set(command.name, command) });
				return { dispose: () => {} };
			},
		},
	} as unknown as Context;
	await opencodePlugin.setup(ctx);
	return { ctx, tools, commands, hooks };
}

test("the OpenCode host exposes the same one tool and one command", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-knowledge-opencode-"));
	try {
		const host = await loadOpencodePlugin(cwd);
		assert.deepEqual([...host.tools.keys()], ["kb_search"]);
		assert.deepEqual([...host.commands.keys()], ["kb"]);
	} finally {
		cleanup(cwd);
	}
});

test("the OpenCode host subscribes to exactly the documented hooks", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-knowledge-opencode-"));
	try {
		const host = await loadOpencodePlugin(cwd);
		assert.deepEqual(host.hooks.sort(), [
			"permission:evaluate",
			"session:compaction",
			"session:context",
			"tool:execute.after",
			"tool:execute.before",
		]);
	} finally {
		cleanup(cwd);
	}
});
