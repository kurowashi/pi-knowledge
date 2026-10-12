/**
 * Behavioral contract for the OpenCode adapter: the hooks it registers must do
 * what the Pi adapter does, through OpenCode's own API (DESIGN.md §15.1).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommandInvocation } from "@opencode/plugin/promise/command";
import type { SessionContext } from "@opencode/plugin/promise/session";
import opencodePlugin from "../../src/hosts/opencode.ts";
import { entryText, withAgentDir, withEnv, writeEntry } from "../helpers/fixtures.ts";

const BODY = "Conclusion first. Then conditions, evidence, and counterexamples for the reader. ";

/** The shapes of the OpenCode events the adapter consumes. */
interface BeforeEvent {
	tool: string;
	sessionID: string;
	agent: string;
	messageID: string;
	id: string;
	input: unknown;
}

interface AfterEvent extends BeforeEvent {
	status: "completed" | "error";
	result: { content?: string | ReadonlyArray<{ type: "text"; text: string }> };
}

interface EvaluateEvent {
	action: string;
	resources: readonly string[];
	effect: "allow" | "ask" | "deny";
	message?: string;
}

interface DeclaredTool {
	name: string;
	description: string;
	input: unknown;
	execute: (input: unknown, context: { signal: AbortSignal }) => Promise<{ content?: string }>;
}

interface Loaded {
	tools: Map<string, DeclaredTool>;
	commands: Map<string, { name: string; execute: (input: CommandInvocation) => Promise<void> }>;
	hooks: {
		context?: (event: SessionContext & { system: Array<{ type: "text"; text: string }> }) => Promise<void>;
		compaction?: () => void;
		before?: (event: BeforeEvent) => void;
		after?: (event: AfterEvent) => void;
		evaluate?: (event: EvaluateEvent) => void;
	};
	prompts: string[];
	synthetics: string[];
}

/** Load the adapter against a stub context that records what it registers. */
async function load(cwd: string): Promise<Loaded> {
	const loaded: Loaded = { tools: new Map(), commands: new Map(), hooks: {}, prompts: [], synthetics: [] };
	const context: unknown = {
		location: { directory: cwd },
		session: {
			hook: async (name: string, callback: (event: never) => unknown) => {
				(loaded.hooks as Record<string, unknown>)[name === "context" ? "context" : "compaction"] = callback;
				return { dispose: () => {} };
			},
			prompt: async (input: { text: string }) => {
				loaded.prompts.push(input.text);
			},
			synthetic: async (input: { text: string }) => {
				loaded.synthetics.push(input.text);
			},
		},
		tool: {
			hook: async (name: string, callback: (event: never) => unknown) => {
				(loaded.hooks as Record<string, unknown>)[name === "execute.before" ? "before" : "after"] = callback;
				return { dispose: () => {} };
			},
			transform: async (callback: (editor: { add(tool: DeclaredTool): void }) => void) => {
				callback({ add: (tool) => loaded.tools.set(tool.name, tool) });
				return { dispose: () => {} };
			},
		},
		permission: {
			hook: async (_name: string, callback: (event: never) => unknown) => {
				(loaded.hooks as Record<string, unknown>)["evaluate"] = callback;
				return { dispose: () => {} };
			},
		},
		command: {
			transform: async (
				callback: (editor: {
					add(command: { name: string; execute: (input: CommandInvocation) => Promise<void> }): void;
				}) => void,
			) => {
				callback({ add: (command) => loaded.commands.set(command.name, command) });
				return { dispose: () => {} };
			},
		},
	};
	await opencodePlugin.setup(context as Parameters<typeof opencodePlugin.setup>[0]);
	return loaded;
}

interface ContextEvent {
	sessionID: string;
	system: Array<{ type: "text"; text: string }>;
	messages: unknown[];
}

function contextEvent(prompt = ""): ContextEvent {
	return {
		sessionID: "ses_1",
		system: [],
		messages: prompt === "" ? [] : [{ role: "user", content: [{ type: "text", text: prompt }] }],
	};
}

function beforeEvent(path: string): BeforeEvent {
	return { tool: "write", sessionID: "ses_1", agent: "build", messageID: "m1", id: "c1", input: { path } };
}

async function withProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = fs.mkdtempSync(join(tmpdir(), "pi-knowledge-oc-"));
	const agent = fs.mkdtempSync(join(tmpdir(), "pi-knowledge-oc-agent-"));
	const config = fs.mkdtempSync(join(tmpdir(), "pi-knowledge-oc-xdg-"));
	try {
		return await withEnv({ PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: config }, () =>
			withAgentDir(agent, () => fn(cwd)),
		);
	} finally {
		for (const dir of [cwd, agent, config]) fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("the context hook injects the index into the system prompt", async () => {
	await withProject(async (cwd) => {
		writeEntry(join(cwd, "knowledge"), "pi_retry_budget", { title: "Alpha" }, BODY);
		const loaded = await load(cwd);
		const event = contextEvent();
		await loaded.hooks.context?.(event as never);
		const index = event.system.find((part) => part.text.includes("Project Knowledge"));
		assert.ok(index, "the index must be pushed onto event.system");
		assert.match(index?.text ?? "", /Alpha/);
	});
});

test("the context hook adds the recall hint from the last user message", async () => {
	await withProject(async (cwd) => {
		writeEntry(join(cwd, "knowledge"), "pi_retry_budget", { title: "Retry budget" }, BODY);
		fs.mkdirSync(join(cwd, ".opencode"), { recursive: true });
		fs.writeFileSync(join(cwd, ".opencode", "knowledge.json"), JSON.stringify({ recall: { mode: "hint" } }));
		const loaded = await load(cwd);
		const event = contextEvent("retry budget question");
		await loaded.hooks.context?.(event as never);
		assert.ok(
			event.system.some((part) => part.text.includes("Possibly relevant knowledge")),
			"recall must read the user message, not an empty prompt",
		);
		const again = contextEvent("retry budget again");
		await loaded.hooks.context?.(again as never);
		assert.equal(again.system.filter((part) => part.text.includes("Possibly relevant")).length, 0);
	});
});

test("the lint summary reaches the model once per session", async () => {
	await withProject(async (cwd) => {
		const dir = join(cwd, "knowledge");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(join(dir, "pi_broken_entry.md"), "no frontmatter");
		const loaded = await load(cwd);
		await loaded.hooks.context?.(contextEvent() as never);
		await loaded.hooks.context?.(contextEvent() as never);
		assert.equal(loaded.synthetics.length, 1);
		assert.match(loaded.synthetics[0] ?? "", /no frontmatter/);
	});
});

test("the compaction hook refreshes the index from disk", async () => {
	await withProject(async (cwd) => {
		writeEntry(join(cwd, "knowledge"), "pi_retry_budget", { title: "Alpha" }, BODY);
		const loaded = await load(cwd);
		const first = contextEvent();
		await loaded.hooks.context?.(first as never);
		writeEntry(join(cwd, "knowledge"), "pi_stream_retry", { title: "Beta" }, BODY);
		const stale = contextEvent();
		await loaded.hooks.context?.(stale as never);
		assert.doesNotMatch(stale.system.map((part) => part.text).join(""), /Beta/);
		loaded.hooks.compaction?.();
		const fresh = contextEvent();
		await loaded.hooks.context?.(fresh as never);
		assert.match(fresh.system.map((part) => part.text).join(""), /Beta/);
	});
});

test("a write onto an existing entry is refused by throwing", async () => {
	await withProject(async (cwd) => {
		writeEntry(join(cwd, "knowledge"), "pi_retry_budget", { title: "Alpha" }, BODY);
		const loaded = await load(cwd);
		assert.doesNotThrow(() => loaded.hooks.before?.(beforeEvent("knowledge/pi_new_entry.md")));
		assert.throws(
			() => loaded.hooks.before?.(beforeEvent("knowledge/pi_retry_budget.md")),
			/use edit/,
			"an existing entry must be refused",
		);
	});
});

test("a read-only root is denied through the permission hook", async () => {
	await withProject(async (cwd) => {
		fs.mkdirSync(join(cwd, "shared"), { recursive: true });
		fs.mkdirSync(join(cwd, ".opencode"), { recursive: true });
		fs.writeFileSync(
			join(cwd, ".opencode", "knowledge.json"),
			JSON.stringify({ roots: [{ path: "shared", scope: "team", readonly: true }] }),
		);
		const loaded = await load(cwd);
		const deny: EvaluateEvent = { action: "edit", resources: [join(cwd, "shared/entry.md")], effect: "ask" };
		loaded.hooks.evaluate?.(deny);
		assert.equal(deny.effect, "deny");
		assert.match(deny.message ?? "", /read-only/);
		const allowed: EvaluateEvent = { action: "edit", resources: [join(cwd, "knowledge/entry.md")], effect: "ask" };
		loaded.hooks.evaluate?.(allowed);
		assert.equal(allowed.effect, "ask", "a writable root is untouched");
	});
});

test("a disabled knowledge base denies nothing", async () => {
	await withProject(async (cwd) => {
		fs.mkdirSync(join(cwd, "shared"), { recursive: true });
		fs.mkdirSync(join(cwd, ".opencode"), { recursive: true });
		fs.writeFileSync(
			join(cwd, ".opencode", "knowledge.json"),
			JSON.stringify({ enabled: false, roots: [{ path: "shared", scope: "team", readonly: true }] }),
		);
		const loaded = await load(cwd);
		const event: EvaluateEvent = { action: "edit", resources: [join(cwd, "shared/entry.md")], effect: "ask" };
		loaded.hooks.evaluate?.(event);
		assert.equal(event.effect, "ask");
	});
});

test("post-write lint findings are prepended to the tool result", async () => {
	await withProject(async (cwd) => {
		fs.mkdirSync(join(cwd, "knowledge"), { recursive: true });
		const loaded = await load(cwd);
		fs.writeFileSync(
			join(cwd, "knowledge", "pi_retry_budget.md"),
			entryText({ title: "Alpha", source: "pi-knowledge/src/catalog.ts" }, BODY),
		);
		const event: AfterEvent = {
			tool: "write",
			sessionID: "ses_1",
			agent: "build",
			messageID: "m1",
			id: "c1",
			input: { path: "knowledge/pi_retry_budget.md" },
			status: "completed",
			result: { content: "wrote 1 file" },
		};
		loaded.hooks.after?.(event);
		const content = event.result.content as unknown as Array<{ text: string }>;
		assert.match(content[0]?.text ?? "", /kb: warning:/);
		assert.match(content[0]?.text ?? "", /points inside this repository/);
		assert.equal(content[1]?.text, "wrote 1 file", "the original result is preserved");
	});
});

test("a badly named entry leaves the catalog and says so", async () => {
	await withProject(async (cwd) => {
		fs.mkdirSync(join(cwd, "knowledge"), { recursive: true });
		const loaded = await load(cwd);
		fs.writeFileSync(join(cwd, "knowledge", "Bad-Name.md"), entryText({ title: "Bad" }, BODY));
		const event: AfterEvent = {
			tool: "write",
			sessionID: "ses_1",
			agent: "build",
			messageID: "m1",
			id: "c1",
			input: { path: "knowledge/Bad-Name.md" },
			status: "completed",
			result: { content: "wrote 1 file" },
		};
		loaded.hooks.after?.(event);
		const tool = loaded.tools.get("kb_search");
		assert.ok(tool);
		const hits = await tool.execute({ query: "Bad" }, { signal: new AbortController().signal });
		assert.equal(hits.content ?? "", "No matches.", "a file the scan rejects must not be searchable");
	});
});

test("the command reports into the conversation and asks the model to act", async () => {
	await withProject(async (cwd) => {
		writeEntry(join(cwd, "knowledge"), "pi_alone_entry", { title: "Alone" }, BODY);
		const loaded = await load(cwd);
		const command = loaded.commands.get("kb");
		assert.ok(command);
		await command.execute({
			sessionID: "ses_1",
			prompt: { text: "/kb review" },
			delivery: "steer",
		} as unknown as CommandInvocation);
		assert.equal(loaded.prompts.length, 2, "the report and the review prompt");
		assert.match(loaded.prompts[0] ?? "", /review requested/);
		assert.match(loaded.prompts[1] ?? "", /Unlinked candidates/);
	});
});
