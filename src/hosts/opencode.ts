/**
 * pi-knowledge host adapter for OpenCode (DESIGN.md §15.1).
 *
 * OpenCode owns the lifecycle; `Knowledge` owns the behavior. The mapping is:
 *
 * - `setup`: build the catalog once per location, then report lint findings to
 *   each session once at its first model call (there is no session-start event).
 * - `session` hook `context`: inject the index section into the system prompt
 *   and add the recall hint.
 * - `session` hook `compaction`: rescan and re-render after compaction.
 * - `tool` hook `execute.before`: refuse a `write` onto an existing entry. Here
 *   a throw becomes the tool error, which is the refusal.
 * - `permission` hook `evaluate`: deny writes to a read-only root, OpenCode's
 *   native enforcement path.
 * - `tool` hook `execute.after`: refresh the catalog and append lint notes.
 *
 * The model-facing surface is `kb_search` plus the `/kb` command. OpenCode's
 * server plugins have no toast equivalent, so `/kb` reports into the
 * conversation (DESIGN.md §15.2).
 */

import type { CommandInvocation } from "@opencode/plugin/promise/command";
import type { Plugin } from "@opencode/plugin/promise/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";

import { OPENCODE_HOST_PATHS } from "../core/config.ts";
import { Knowledge, type SearchParams } from "../core/engine.ts";

/** Concatenated text of the last user message, for the recall hint. */
function lastUserText(messages: SessionContext["messages"]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === undefined || message.role !== "user") continue;
		const texts = message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
		if (texts.length > 0) return texts.join("\n");
	}
	return "";
}

const SEARCH_INPUT = {
	type: "object",
	properties: {
		query: { type: "string", description: "English search terms. Required unless tags are given." },
		tags: { type: "array", items: { type: "string" }, description: "All tags must match (AND)." },
		status: {
			type: "string",
			enum: ["active", "any", "superseded", "deprecated"],
			description: 'Status filter. Default "active".',
		},
		scope: { type: "string", enum: ["project", "user", "team"], description: "Limit to one scope." },
		limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum results (default 10)." },
		backend: {
			type: "string",
			enum: ["lexical", "fts5", "embedding", "hybrid"],
			description: "Backend override for this call (default: config).",
		},
	},
	additionalProperties: false,
} as const;

const SEARCH_DESCRIPTION =
	"Search the project knowledge base. Returns matching entries with their file paths; read the file before applying an entry. " +
	"Supports tag, status, and scope filters.";

const pathOf = (input: unknown): unknown =>
	typeof input === "object" && input !== null ? (input as { path?: unknown }).path : undefined;

const FILE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["shell", "bash"]);

/**
 * Lint notes after a tool ran. `patch` is absent on purpose: its input is a
 * single patch text with no path to re-read, so the entry it created is picked
 * up by the next scan instead (DESIGN.md §7).
 */
function postWriteNotes(knowledge: Knowledge, tool: string, filePath: unknown): string[] {
	if (FILE_TOOLS.has(tool)) return knowledge.afterWrite(filePath);
	if (SHELL_TOOLS.has(tool)) knowledge.rescan();
	return [];
}

/** State a backend fallback in the result text so it is never silent. */
function fallbackNote(details: unknown, text: string): string {
	const result = details as { fallback?: boolean; fallbackReason?: string; backend?: string } | null;
	if (result?.fallback !== true) return text;
	const note = `kb: backend ${result.backend ?? "lexical"} used; the requested backend was unavailable (${result.fallbackReason ?? "unavailable"})`;
	return text === "" ? note : `${text}\n${note}`;
}

/** One lint message per session, but never an unbounded set of session ids. */
const ANNOUNCED_LIMIT = 500;

function forgetOldest(set: Set<string>, limit: number): void {
	while (set.size > limit) {
		const oldest = set.values().next();
		if (oldest.done === true) return;
		set.delete(oldest.value);
	}
}

/**
 * The plugin object is exported directly instead of through `Plugin.define`, so
 * loading this file never imports `@opencode/plugin` at runtime and the package
 * keeps zero runtime dependencies.
 */
const plugin: Plugin = {
	id: "pi-knowledge",
	async setup(ctx) {
		const knowledge = new Knowledge({
			cwd: ctx.location.directory,
			paths: OPENCODE_HOST_PATHS,
			trusted: true,
			contextWindow: null,
		});
		knowledge.start();

		const announced = new Set<string>();

		await ctx.session.hook("context", async (event) => {
			if (knowledge.indexSection) event.system.push({ type: "text", text: knowledge.indexSection });
			const recall = knowledge.recall(lastUserText(event.messages));
			if (recall !== null) event.system.push({ type: "text", text: recall.text });
			if (announced.has(event.sessionID)) return;
			const lint = knowledge.lintMessage();
			if (lint === null) return;
			announced.add(event.sessionID);
			forgetOldest(announced, ANNOUNCED_LIMIT);
			// A closed session rejects this; the context hook must not fail with it.
			await ctx.session.synthetic({ sessionID: event.sessionID, text: lint }).catch(() => {});
		});

		await ctx.session.hook("compaction", () => {
			knowledge.onCompacted();
		});

		await ctx.permission.hook("evaluate", (event) => {
			if (knowledge.enabled !== true || event.effect === "deny" || event.action !== "edit") return;
			const blocked = event.resources.find((resource) => knowledge.isReadonlyPath(resource));
			if (blocked === undefined) return;
			event.effect = "deny";
			event.message = `knowledge: ${blocked} is inside a read-only knowledge root`;
		});

		await ctx.tool.hook("execute.before", (event) => {
			if (knowledge.enabled !== true || event.tool !== "write") return;
			const outcome = knowledge.planWrite({ path: pathOf(event.input) });
			if (outcome === null || outcome.allow) return;
			throw new Error(outcome.reason ?? "blocked by pi-knowledge");
		});

		await ctx.tool.hook("execute.after", (event) => {
			if (knowledge.enabled !== true || event.status !== "completed") return;
			const notes = postWriteNotes(knowledge, event.tool, pathOf(event.input));
			if (notes.length === 0) return;
			const existing =
				typeof event.result.content === "string"
					? [{ type: "text" as const, text: event.result.content }]
					: (event.result.content ?? []);
			event.result = { ...event.result, content: [{ type: "text", text: `kb: ${notes.join("; ")}` }, ...existing] };
		});

		const tool: ToolInfo = {
			name: "kb_search",
			description: SEARCH_DESCRIPTION,
			input: SEARCH_INPUT,
			async execute(input) {
				const result = await knowledge.search(input as SearchParams);
				const text = result.content.map((part) => part.text).join("\n");
				// OpenCode has no details field on the tool result, so a backend
				// fallback is stated in the content instead of staying silent
				// (DESIGN.md §9.1).
				return { content: fallbackNote(result.details, text) };
			},
		};
		await ctx.tool.transform((editor) => {
			editor.add(tool);
		});

		await ctx.command.transform((editor) => {
			editor.add({
				name: "kb",
				description:
					"pi-knowledge: status | config | lint | list | tags | find <tag...> | search <query> | stale | dups | refs <id> | review [focus] | docs | bench | capture [focus]",
				async execute({ sessionID, prompt, delivery }: CommandInvocation) {
					const outcome = await knowledge.runCommand(prompt.text.replace(/^\/kb\b/, "").trim());
					await ctx.session.prompt({ sessionID, text: outcome.text, delivery });
					if (outcome.prompt !== undefined) {
						await ctx.session.prompt({ sessionID, text: outcome.prompt, delivery });
					}
				},
			});
		});
	},
};

export default plugin;
