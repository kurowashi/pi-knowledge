/**
 * pi-knowledge host adapter for Pi (DESIGN.md §15.1).
 *
 * Pi owns the lifecycle; `Knowledge` owns the behavior. This file only maps Pi
 * events onto engine calls and formats their results for Pi:
 *
 * - `session_start`: load config, resolve roots, build the catalog, render the
 *   injected index, and report lint findings to the model.
 * - `session_compact`: rescan and re-render so a continuation after compaction
 *   sees the current knowledge.
 * - `before_agent_start`: apply the index section and the optional recall hint.
 * - `tool_call`: refuse a `write` onto an existing entry and any `write` or `edit`
 *   on a readonly root (DESIGN.md §7.1).
 * - `tool_result`: refresh the catalog and append lint notes for what changed.
 *
 * The model-facing surface is `kb_search` plus the `/kb` command. No write tools
 * are added (DESIGN.md §14).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PI_HOST_PATHS } from "../core/config.ts";
import { Knowledge } from "../core/engine.ts";

/** Tools whose completion means files under the knowledge roots may have changed. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Lint notes after a successful write/edit, or a rescan after a shell command. */
function notesAfter(knowledge: Knowledge, toolName: string, input: unknown): string[] {
	if (toolName === "write" || toolName === "edit") {
		return knowledge.afterWrite((input as Record<string, unknown> | undefined)?.["path"]);
	}
	if (SHELL_TOOLS.has(toolName)) knowledge.rescan();
	return [];
}

export default function knowledgeExtension(pi: ExtensionAPI): void {
	let knowledge: Knowledge | null = null;
	const notesByCall = new Map<string, string[]>();

	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning"): void => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	};

	pi.on("session_start", (_event, ctx) => {
		knowledge = new Knowledge(
			{
				cwd: ctx.cwd,
				paths: PI_HOST_PATHS,
				trusted: ctx.isProjectTrusted(),
				contextWindow: ctx.model?.contextWindow ?? null,
			},
			{ notify: (text, level) => notify(ctx, text, level) },
		);
		notesByCall.clear();
		knowledge.start();
		const lint = knowledge.lintMessage();
		if (lint !== null) pi.sendMessage({ customType: "knowledge_lint", content: lint, display: false });
	});

	pi.on("session_compact", (_event, _ctx) => {
		knowledge?.onCompacted();
	});

	pi.on("before_agent_start", (event, _ctx) => {
		const section = knowledge?.indexSection ?? "";
		if (section) event.systemPromptOptions.sections["knowledge_index"] = section;
		else delete event.systemPromptOptions.sections["knowledge_index"];
		const recall = knowledge?.recall(event.prompt) ?? null;
		if (recall === null) return;
		return { message: { customType: "knowledge_recall", content: recall.text, display: false } };
	});

	pi.on("tool_call", (event, _ctx) => {
		if (knowledge?.enabled !== true) return undefined;
		const outcome = knowledge.planFileTool(event.toolName, event.input as { path?: unknown });
		if (outcome === null) return undefined;
		if (!outcome.allow) return { block: true, reason: outcome.reason ?? "blocked by pi-knowledge" };
		if (outcome.notes.length > 0) notesByCall.set(event.toolCallId, outcome.notes);
		return undefined;
	});

	pi.on("tool_result", (event, _ctx) => {
		if (knowledge?.enabled !== true) return;
		const notes = notesByCall.get(event.toolCallId) ?? [];
		notesByCall.delete(event.toolCallId);
		const fresh = event.isError === true ? [] : notesAfter(knowledge, event.toolName, event.input);
		const all = [...notes, ...fresh];
		if (all.length === 0) return;
		return { content: [...event.content, { type: "text" as const, text: `kb: ${all.join("; ")}` }] };
	});

	pi.registerTool({
		name: "kb_search",
		label: "Knowledge Search",
		description:
			"Search the project knowledge base. Returns matching entries with their file paths; read the file before applying an entry. " +
			"Supports tag, status, and scope filters.",
		promptSnippet: "Search project knowledge entries (title, when, tags, body)",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "English search terms. Required unless tags are given." })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "All tags must match (AND)." })),
			status: Type.Optional(
				Type.Union(
					[Type.Literal("active"), Type.Literal("any"), Type.Literal("superseded"), Type.Literal("deprecated")],
					{ description: 'Status filter. Default "active".' },
				),
			),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("user"), Type.Literal("team")], {
					description: "Limit to one scope.",
				}),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results (default 10)." })),
			backend: Type.Optional(
				Type.Union([Type.Literal("lexical"), Type.Literal("fts5"), Type.Literal("embedding"), Type.Literal("hybrid")], {
					description: "Backend override for this call (default: config).",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (knowledge === null) {
				return { content: [{ type: "text" as const, text: "No knowledge base is loaded." }], details: { hits: [] } };
			}
			return knowledge.search(params);
		},
	});

	pi.registerCommand("kb", {
		description:
			"pi-knowledge: status | config | lint | list | tags | find <tag...> | search <query> | stale | dups | refs <id> | review [focus] | docs | bench | capture [focus]",
		handler: async (args, ctx) => {
			if (knowledge === null) {
				notify(ctx, "pi-knowledge: not loaded", "warning");
				return;
			}
			const outcome = await knowledge.runCommand(args);
			notify(ctx, outcome.text, outcome.level);
			if (outcome.prompt !== undefined) await pi.sendUserMessage(outcome.prompt, { deliverAs: "followUp" });
		},
	});
}
