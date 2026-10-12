import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import knowledgeExtension from "../../src/hosts/pi.ts";
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

function writeConfig(cwd: string, dir: string, config: Record<string, unknown>): void {
	fs.mkdirSync(path.join(cwd, dir), { recursive: true });
	fs.writeFileSync(path.join(cwd, dir, "knowledge.json"), JSON.stringify(config));
}

function compactEvent(): unknown {
	return {
		type: "session_compact",
		compactionEntry: { type: "compaction", id: "cmp" },
		fromExtension: false,
		reason: "manual",
		willRetry: false,
	};
}

test("the index is injected and frozen until compaction", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "pi_retry_budget", { title: "Alpha", when: ["setup"] }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		const first = beforeEvent("");
		h.emit("before_agent_start", first);
		assert.match(first.systemPromptOptions.sections["knowledge_index"] ?? "", /Alpha/);
		writeEntry(path.join(cwd, "knowledge"), "pi_stream_retry", { title: "Beta" }, BODY);
		const second = beforeEvent("");
		h.emit("before_agent_start", second);
		assert.equal(
			second.systemPromptOptions.sections["knowledge_index"],
			first.systemPromptOptions.sections["knowledge_index"],
		);
	});
});

test("compaction refreshes the index from the live catalog", async () => {
	await withProject(async (cwd) => {
		const dir = path.join(cwd, "knowledge");
		writeEntry(dir, "pi_retry_budget", { title: "Alpha" }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		const first = beforeEvent("");
		h.emit("before_agent_start", first);
		assert.match(first.systemPromptOptions.sections["knowledge_index"] ?? "", /Alpha/);
		writeEntry(dir, "pi_stream_retry", { title: "Beta" }, BODY);
		writeEntry(dir, "pi_retry_budget", { title: "Alpha", status: "deprecated" }, BODY);
		const stale = beforeEvent("");
		h.emit("before_agent_start", stale);
		assert.match(stale.systemPromptOptions.sections["knowledge_index"] ?? "", /Alpha/);
		assert.doesNotMatch(stale.systemPromptOptions.sections["knowledge_index"] ?? "", /Beta/);
		h.emit("session_compact", compactEvent());
		const fresh = beforeEvent("");
		h.emit("before_agent_start", fresh);
		const index = fresh.systemPromptOptions.sections["knowledge_index"] ?? "";
		assert.match(index, /Beta/);
		assert.doesNotMatch(index, /Alpha/);
	});
});

test("compaction before session start is a no-op", async () => {
	await withProject(async (cwd) => {
		const h = harness(cwd);
		h.emit("session_compact", { type: "session_compact" });
		assert.deepEqual(h.notifications, []);
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

test("a new entry keeps the model's id and becomes searchable in the same session", async () => {
	await withProject(async (cwd) => {
		fs.mkdirSync(path.join(cwd, "knowledge"), { recursive: true });
		const h = harness(cwd);
		h.emit("session_start", session());
		const input: Record<string, unknown> = {
			path: "knowledge/pi_new_entry.md",
			content: entryText({ title: "Fresh", tags: ["x"] }, BODY),
		};
		const outcome = h.emit<{ block?: boolean }>("tool_call", {
			type: "tool_call",
			toolName: "write",
			toolCallId: "t1",
			input,
		});
		assert.equal(outcome?.block, undefined);
		assert.equal(input["path"], "knowledge/pi_new_entry.md", "the plugin never renames the file");
		fs.writeFileSync(path.join(cwd, String(input["path"])), String(input["content"]));
		const result = h.emit<{ content: Array<{ text?: string }> }>("tool_result", {
			type: "tool_result",
			toolName: "write",
			toolCallId: "t1",
			input,
			content: [],
			isError: false,
			details: undefined,
		});
		assert.equal(result, undefined, "a clean entry needs no note");
		const found = await h.search({ query: "fresh" });
		assert.match(found.content[0]?.text ?? "", /Fresh/);
		assert.match(found.content[0]?.text ?? "", /\[x\]/);
		assert.deepEqual(h.notifications, []);
	});
});

test("a write onto an existing entry is refused, and warn mode annotates instead", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "pi_retry_budget", { title: "Alpha" }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		const blocked = h.emit<{ block?: boolean }>("tool_call", {
			type: "tool_call",
			toolName: "write",
			toolCallId: "t1",
			input: { path: "knowledge/pi_retry_budget.md", content: entryText({ title: "New" }, BODY) },
		});
		assert.equal(blocked.block, true);
		assert.match(String((blocked as { reason?: string }).reason), /use edit/);

		writeConfig(cwd, ".pi", { write: { enforce: "warn" } });
		const warned = harness(cwd);
		warned.emit("session_start", session());
		const allowed = warned.emit<{ block?: boolean }>("tool_call", {
			type: "tool_call",
			toolName: "write",
			toolCallId: "t2",
			input: { path: "knowledge/pi_retry_budget.md", content: entryText({ title: "New" }, BODY) },
		});
		assert.equal(allowed?.block, undefined);
		const result = warned.emit<{ content: Array<{ text?: string }> }>("tool_result", {
			type: "tool_result",
			toolName: "write",
			toolCallId: "t2",
			input: { path: "knowledge/pi_retry_budget.md" },
			content: [],
			isError: false,
			details: undefined,
		});
		assert.match(result?.content[0]?.text ?? "", /kb: warning: entry pi_retry_budget already exists/);
	});
});

test("edit is not intercepted but its lint findings reach the model", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "pi_retry_budget", { title: "Alpha" }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		const input = { path: "knowledge/pi_retry_budget.md", oldString: "Alpha", newString: "" };
		const outcome = h.emit<{ block?: boolean }>("tool_call", {
			type: "tool_call",
			toolName: "edit",
			toolCallId: "t1",
			input,
		});
		assert.equal(outcome?.block, undefined, "content is never validated before the write");

		const file = path.join(cwd, "knowledge", "pi_retry_budget.md");
		fs.writeFileSync(file, entryText({ title: "Alpha", source: "pi-knowledge/src/catalog.ts" }, BODY));
		const result = h.emit<{ content: Array<{ text?: string }> }>("tool_result", {
			type: "tool_result",
			toolName: "edit",
			toolCallId: "t1",
			input,
			content: [],
			isError: false,
			details: undefined,
		});
		assert.match(result?.content[0]?.text ?? "", /kb: warning:/);
		assert.match(result?.content[0]?.text ?? "", /points inside this repository/);
	});
});

test("bash changes are picked up by the next search", async () => {
	await withProject(async (cwd) => {
		fs.mkdirSync(path.join(cwd, "knowledge"), { recursive: true });
		const h = harness(cwd);
		h.emit("session_start", session());
		writeEntry(path.join(cwd, "knowledge"), "pi_added_later", { title: "Added" }, BODY);
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
		writeEntry(path.join(cwd, "knowledge"), "pi_retry_budget", { title: "Alpha", tags: ["x"] }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("status");
		assert.match(h.notifications.at(-1) ?? "", /pi-knowledge: on/);
		await h.run("config");
		assert.match(h.notifications.at(-1) ?? "", /"stale": \{\s*"days": 365/);
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
		assert.match(h.sent[0] ?? "", /knowledge\/<slug>\.md/);
	});
});

test("capture respects the disabled mode", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "pi_retry_budget", { title: "Alpha" }, BODY);
		writeConfig(cwd, ".pi", { capture: { mode: "off" } });
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("capture");
		assert.equal(h.sent.length, 0);
		assert.match(h.notifications.at(-1) ?? "", /capture is disabled/);
	});
});

test("review sends duplicate candidates to the agent", async () => {
	await withProject(async (cwd) => {
		const dir = path.join(cwd, "knowledge");
		writeEntry(dir, "pi_retry_budget", { title: "Same" }, BODY);
		writeEntry(dir, "pi_stream_retry", { title: "Same" }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("review");
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0] ?? "", /Duplicate candidates/);
		assert.match(h.sent[0] ?? "", /pi_retry_budget Same \/ pi_stream_retry Same/);
		assert.match(h.sent[0] ?? "", /superseded/);
	});
});

test("review lists unlinked entries and asks for value judgments", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "pi_alone_entry", { title: "Alone" }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("review");
		assert.match(h.sent[0] ?? "", /Unlinked candidates/);
		assert.match(h.sent[0] ?? "", /pi_alone_entry Alone/);
		assert.match(h.sent[0] ?? "", /contradictions and low-value entries/);
	});
});

test("review reports when there is nothing to review", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "linked", { title: "Linked" }, "Alpha points at [[other]] for the rest. ");
		writeEntry(path.join(cwd, "knowledge"), "other", { title: "Other" }, "Beta points back at [[linked]] meanwhile. ");
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("review");
		assert.equal(h.sent.length, 0);
		assert.match(h.notifications.at(-1) ?? "", /nothing to review/);
	});
});

test("review includes stale candidates and the focus", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "pi_stale_entry", { title: "Old", review_after: "2020-01-01" }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("review tidy stale");
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0] ?? "", /review_after: 2020-01-01/);
		assert.match(h.sent[0] ?? "", /Focus: tidy stale/);
	});
});

test("review labels candidates with scope:id in a multi-root setup", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "pi_retry_budget", { title: "Same" }, BODY);
		writeEntry(path.join(cwd, "user"), "pi_stream_retry", { title: "Same" }, BODY);
		writeConfig(cwd, ".pi", {
			roots: [
				{ path: "knowledge", scope: "project" },
				{ path: "user", scope: "user" },
			],
		});
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("review");
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0] ?? "", /project:pi_retry_budget Same \/ user:pi_stream_retry Same/);
	});
});

test("recall hint is added once per session", async () => {
	await withProject(async (cwd) => {
		writeEntry(path.join(cwd, "knowledge"), "pi_retry_budget", { title: "Alpha" }, BODY);
		writeConfig(cwd, ".pi", { recall: { mode: "hint" } });
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
		writeConfig(cwd, ".pi", { enabled: false });
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
		fs.writeFileSync(path.join(dir, "pi_broken_entry.md"), "no frontmatter");
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
		writeEntry(path.join(cwd, "knowledge"), "pi_retry_budget", { title: "Same", review_after: "2020-01-01" }, BODY);
		writeEntry(path.join(cwd, "knowledge"), "pi_stream_retry", { title: "Same" }, BODY);
		const h = harness(cwd);
		h.emit("session_start", session());
		await h.run("stale");
		assert.match(h.notifications.at(-1) ?? "", /review_after/);
		await h.run("dups");
		assert.match(h.notifications.at(-1) ?? "", /pi_retry_budget Same/);
		await h.run("refs pi_retry_budget");
		assert.ok((h.notifications.at(-1) ?? "").length > 0);
		await h.run("docs");
		assert.match(h.notifications.at(-1) ?? "", /kb docs/);
	});
});

test("a read-only root is reported through the permission path", async () => {
	await withProject(async (cwd) => {
		fs.mkdirSync(path.join(cwd, "shared"), { recursive: true });
		writeConfig(cwd, ".pi", { roots: [{ path: "shared", scope: "team", readonly: true }] });
		const h = harness(cwd);
		h.emit("session_start", session());
		const outcome = h.emit<{ block?: boolean }>("tool_call", {
			type: "tool_call",
			toolName: "write",
			toolCallId: "t1",
			input: { path: "shared/anything.md", content: BODY },
		});
		assert.equal(outcome?.block, true);
		assert.match(String((outcome as { reason?: string }).reason), /read-only/);
	});
});
