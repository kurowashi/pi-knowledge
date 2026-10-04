import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import knowledgeExtension from "../../src/index.ts";
import { entryText, writeEntry } from "../helpers/fixtures.ts";

const BODY = "Conclusion first. Then conditions, evidence, and counterexamples for the reader. ";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;

interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

interface ToolLike {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<ToolResultLike>;
}

interface Harness {
	emit<T = unknown>(event: string, data: unknown): T;
	run(args: string): Promise<unknown>;
	search(params: Record<string, unknown>): Promise<ToolResultLike>;
	notifications: string[];
	sent: string[];
	messages: Array<{ customType?: string; content?: unknown; display?: boolean }>;
}

function harness(cwd: string): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, ToolLike>();
	const notifications: string[] = [];
	const sent: string[] = [];
	const messages: Array<{ customType?: string; content?: unknown; display?: boolean }> = [];
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool(tool: ToolLike) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		sendUserMessage: async (content: string) => {
			sent.push(content);
		},
		sendMessage: (message: { customType?: string; content?: unknown; display?: boolean }) => {
			messages.push(message);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		hasUI: true,
		isProjectTrusted: () => true,
		model: { contextWindow: 200_000 },
		ui: { notify: (text: string) => notifications.push(text) },
	} as unknown as ExtensionContext;
	knowledgeExtension(api);
	return {
		notifications,
		sent,
		messages,
		emit<T = unknown>(event: string, data: unknown): T {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = handler(data, ctx) ?? result;
			return result as T;
		},
		run(args: string): Promise<unknown> {
			const handler = commands.get("kb");
			if (!handler) throw new Error("the kb command is not registered");
			return Promise.resolve(handler(args, ctx));
		},
		search(params: Record<string, unknown>): Promise<ToolResultLike> {
			const tool = tools.get("kb_search");
			if (!tool) throw new Error("kb_search is not registered");
			return tool.execute("test", params, undefined, undefined, ctx);
		},
	};
}

async function withProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-knowledge-int-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-knowledge-agent-"));
	const saved = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agent;
	try {
		return await fn(cwd);
	} finally {
		if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = saved;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(agent, { recursive: true, force: true });
	}
}

function session(): unknown {
	return { type: "session_start", reason: "startup" };
}

function beforeEvent(prompt: string): {
	type: string;
	prompt: string;
	systemPromptOptions: { sections: Record<string, string> };
} {
	return { type: "before_agent_start", prompt, systemPromptOptions: { sections: {} } };
}

function writeConfig(cwd: string, config: Record<string, unknown>): void {
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "knowledge.json"), JSON.stringify(config));
}

test("the index is injected and frozen for the session", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "11111111", { title: "Alpha", when: ["setup"] }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		const first = beforeEvent("");
		h.emit("before_agent_start", first);
		assert.match(first.systemPromptOptions.sections["knowledge_index"] ?? "", /Alpha/);
		writeEntry(path.join(cwd, "knowledge"), "22222222", { title: "Beta" }, BODY);
		const second = beforeEvent("");
		h.emit("before_agent_start", second);
		assert.equal(
			second.systemPromptOptions.sections["knowledge_index"],
			first.systemPromptOptions.sections["knowledge_index"],
		);
	});
});

test("no knowledge directory is a silent no-op", async () => {
	await withProject(async (cwd) => {
		const h = harness(cwd);
		h.emit("session_start", session());
		const event = beforeEvent("");
		h.emit("before_agent_start", event);
		assert.equal("knowledge_index" in event.systemPromptOptions.sections, false);
		assert.deepEqual(h.notifications, []);
	});
});

test("a new entry gets an id and becomes searchable in the same session", async () => {
	await withProject(async (cwd) => {
		fs.mkdirSync(path.join(cwd, "knowledge"), { recursive: true });
		const h = harness(cwd);
		h.emit("session_start", session());
		const input: Record<string, unknown> = {
			path: "knowledge/new-note.md",
			content: entryText({ title: "Fresh" }, BODY),
		};
		h.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "t1", input });
		assert.match(String(input["path"]), /knowledge[/\\][0-9a-f]{8}\.md$/);
		fs.writeFileSync(path.join(cwd, String(input["path"])), String(input["content"]));
		h.emit("tool_result", {
			type: "tool_result",
			toolName: "write",
			toolCallId: "t1",
			input,
			content: [],
			isError: false,
			details: undefined,
		});
		const result = await h.search({ query: "fresh" });
		assert.match(result.content[0]?.text ?? "", /Fresh/);
		assert.deepEqual(h.notifications, []);
	});
});

test("overwrite and invalid edits are blocked", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "11111111", { title: "Alpha" }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		const overwrite = h.emit<{ block?: boolean }>("tool_call", {
			type: "tool_call",
			toolName: "write",
			toolCallId: "t1",
			input: { path: "knowledge/11111111.md", content: entryText({ title: "New" }, BODY) },
		});
		assert.equal(overwrite.block, true);
		const edit = h.emit<{ block?: boolean }>("tool_call", {
			type: "tool_call",
			toolName: "edit",
			toolCallId: "t2",
			input: { path: "knowledge/11111111.md", edits: [{ oldText: 'title: "Alpha"', newText: "nope: 1" }] },
		});
		assert.equal(edit.block, true);
	});
});

test("warn mode surfaces notes on the tool result", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "11111111", { title: "Alpha" }, BODY);
		writeConfig(cwd, { write: { enforce: "warn" } });
		const h = harness(cwd);
		h.emit("session_start", session());
		const input = { path: "knowledge/11111111.md", edits: [{ oldText: 'title: "Alpha"', newText: "nope: 1" }] };
		const outcome = h.emit<{ block?: boolean }>("tool_call", {
			type: "tool_call",
			toolName: "edit",
			toolCallId: "t3",
			input,
		});
		assert.equal(outcome?.block, undefined);
		const result = h.emit<{ content: Array<{ text?: string }> }>("tool_result", {
			type: "tool_result",
			toolName: "edit",
			toolCallId: "t3",
			input,
			content: [],
			isError: false,
			details: undefined,
		});
		assert.match(result.content[0]?.text ?? "", /kb: error:/);
	});
});

test("bash changes are picked up by the next search", async () => {
	await withProject(async (cwd) => {
		fs.mkdirSync(path.join(cwd, "knowledge"), { recursive: true });
		const h = harness(cwd);
		h.emit("session_start", session());
		writeEntry(path.join(cwd, "knowledge"), "33333333", { title: "Added" }, BODY);
		h.emit("tool_result", {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "b1",
			input: {},
			content: [],
			isError: false,
			details: undefined,
		});
		const result = await h.search({ query: "added" });
		assert.match(result.content[0]?.text ?? "", /Added/);
	});
});

test("kb_search explains missing arguments", async () => {
	await withProject(async (cwd) => {
		fs.mkdirSync(path.join(cwd, "knowledge"), { recursive: true });
		const h = harness(cwd);
		h.emit("session_start", session());
		const empty = await h.search({});
		assert.match(empty.content[0]?.text ?? "", /Provide a query/);
	});
});

test("commands report and capture", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "11111111", { title: "Alpha", tags: ["x"] }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("status");
		assert.match(h.notifications.at(-1) ?? "", /pi-knowledge: on/);
		await h.run("list");
		assert.match(h.notifications.at(-1) ?? "", /Alpha/);
		await h.run("tags");
		await h.run("find x");
		await h.run("search alpha");
		await h.run("bogus");
		assert.match(h.notifications.at(-1) ?? "", /usage:/);
		await h.run("capture focus");
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0] ?? "", /Focus: focus/);
	});
});

test("capture respects the disabled mode", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "11111111", { title: "Alpha" }, BODY);
		writeConfig(cwd, { capture: { mode: "off" } });
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("capture");
		assert.equal(h.sent.length, 0);
		assert.match(h.notifications.at(-1) ?? "", /capture is disabled/);
	});
});

test("recall hint is added once per session", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "11111111", { title: "Alpha" }, BODY);
		writeConfig(cwd, { recall: { mode: "hint" } });
		const h = harness(cwd);
		h.emit("session_start", session());
		const first = h.emit<{ message?: { customType?: string } }>("before_agent_start", beforeEvent("alpha question"));
		assert.equal(first.message?.customType, "knowledge_recall");
		const second = h.emit<{ message?: unknown }>("before_agent_start", beforeEvent("alpha again"));
		assert.equal(second, undefined);
	});
});

test("a disabled plugin stays silent and the command reports it", async () => {
	await withProject(async (cwd) => {
		writeConfig(cwd, { enabled: false });
		const h = harness(cwd);
		h.emit("session_start", session());
		const event = beforeEvent("");
		h.emit("before_agent_start", event);
		assert.equal("knowledge_index" in event.systemPromptOptions.sections, false);
		await h.run("status");
		assert.match(h.notifications.at(-1) ?? "", /disabled/);
	});
});

test("lint findings are announced and sent to the model at session start", async () => {
	await withProject(async (cwd) => {
		const dir = path.join(cwd, "knowledge");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "11111111.md"), "no frontmatter");
		const h = harness(cwd);
		h.emit("session_start", session());
		assert.ok(h.notifications.some((note) => note.includes("errors")));
		assert.ok(
			h.messages.some(
				(item) => item.customType === "knowledge_lint" && String(item.content).includes("no frontmatter"),
			),
		);
	});
});

test("quality subcommands report", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "11111111", { title: "Same", review_after: "2020-01-01" }, BODY);
		writeEntry(path.join(cwd, "knowledge"), "22222222", { title: "Same" }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("stale");
		assert.match(h.notifications.at(-1) ?? "", /review_after/);
		await h.run("dups");
		assert.match(h.notifications.at(-1) ?? "", /11111111 {2}22222222/);
		await h.run("refs 11111111");
		assert.ok((h.notifications.at(-1) ?? "").length > 0);
		await h.run("docs");
		assert.match(h.notifications.at(-1) ?? "", /kb docs/);
	});
});
