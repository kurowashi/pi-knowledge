/**
 * pi-knowledge extension entry.
 *
 * - `session_start`: load config, resolve roots, build the catalog, render the
 *   injected index, and report lint warnings.
 * - `session_compact`: rescan the catalog and re-render the injected index so a
 *   continuation after compaction sees the current knowledge (DESIGN.md §10.4).
 * - `before_agent_start`: re-apply the current index section every run, and
 *   optionally add a recall hint.
 * - `tool_call`: normalize new-entry paths (id assignment) and validate writes.
 * - `tool_result`: refresh the catalog after write/edit/bash and surface notes.
 *
 * The model-facing surface is `kb_search` plus the `/kb` command. No write
 * tools are added (DESIGN.md §14).
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildCatalog, parseEntryFile, removeEntry, rescanCatalog, upsertEntry } from "./catalog.ts";
import { type KnowledgeConfig, loadConfig } from "./config.ts";
import { formatSearchHit, formatSearchHits } from "./format.ts";
import { findKnowledgeTarget, type HookContext, type HookOutcome, planEdit, planWrite } from "./hooks.ts";
import { lintCatalog } from "./lint.ts";
import { type RenderedIndex, renderIndex } from "./render.ts";
import { commandReport } from "./report.ts";
import { resolveRoots } from "./roots.ts";
import { capSearchText, scoreEntry, tokenize } from "./search.ts";
import { SearchService } from "./search_service.ts";
import { findDuplicatePairs } from "./similar.ts";
import { type StaleReport, staleReport } from "./stale.ts";
import type { Backend, CatalogData, EntryRecord, Issue, ResolvedRoot, Scope, SearchOptions, Status } from "./types.ts";

const RECALL_LIMIT = 3;
const LINT_MESSAGE_LIMIT = 8;
const REVIEW_LIMIT = 5;
const REVIEW_STALE_LIMIT = 10;
const SEARCH_CONTENT_TOKENS = 3000;
const COMMAND_OUTPUT_LIMIT = 8000;
const CAPTURE_PROMPT = [
	"Distill reusable knowledge from this session into the project knowledge base.",
	"Search first with kb_search, then write only self-contained entries that are not already covered.",
	"Use the write tool with a descriptive filename; the plugin assigns the entry id.",
	"Follow the knowledge-curation skill: conclusion first, then conditions, evidence, counterexamples, and uncertainty.",
].join("\n");
const REVIEW_PROMPT = [
	"Tidy up the project knowledge base using the candidates below.",
	"Judge each candidate and apply accepted changes with the normal write/edit tools.",
	"To replace an entry: write the new entry with supersedes, then set the old entry to status: superseded.",
	"For stale entries: refresh the body and review_after, or retire the entry.",
	"Check kb refs before deleting anything; do not rewrite unrelated entries.",
].join("\n");

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function cap(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;
}

interface KnowledgeToolParams {
	query?: string;
	tags?: string[];
	status?: Status | "any";
	scope?: Scope;
	limit?: number;
	backend?: Backend;
}

async function runKnowledgeSearch(
	catalog: CatalogData,
	config: KnowledgeConfig,
	service: SearchService | null,
	params: KnowledgeToolParams,
	roots: ResolvedRoot[],
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
	const query = params.query?.trim() ?? "";
	const tags = params.tags ?? [];
	if (query === "" && tags.length === 0) {
		return { content: [{ type: "text", text: "Provide a query or at least one tag." }], details: { hits: [] } };
	}
	const options: SearchOptions = {
		query,
		tags,
		status: params.status ?? "active",
		scope: params.scope ?? null,
		limit: params.limit ?? 10,
	};
	const requested = params.backend ?? config.search.backend;
	const active = service ?? new SearchService(catalog, config);
	const result = await active.search(options, requested);
	const capped = capSearchText(
		result.hits.map((hit) => formatSearchHit(hit, roots.length > 1)),
		SEARCH_CONTENT_TOKENS,
	);
	return {
		content: [{ type: "text", text: capped.text || "No matches." }],
		details: { ...result, truncated: capped.truncated },
	};
}

function entryLabel(entry: EntryRecord, multiRoot: boolean): string {
	return multiRoot ? `${entry.scope}:${entry.id}` : entry.id;
}

function duplicateLines(catalog: CatalogData, multiRoot: boolean): string[] {
	const pairs = findDuplicatePairs(catalog).slice(0, REVIEW_LIMIT);
	if (pairs.length === 0) return [];
	const lines = ["Duplicate candidates (id / id / similarity):"];
	for (const pair of pairs) {
		lines.push(`- ${entryLabel(pair.a, multiRoot)} / ${entryLabel(pair.b, multiRoot)} / ${pair.score.toFixed(2)}`);
	}
	return lines;
}

function staleLines(report: StaleReport, multiRoot: boolean): string[] {
	const shown = report.entries.slice(0, REVIEW_STALE_LIMIT);
	if (shown.length === 0) return [];
	const lines = ["Stale entries (id / title / reason):"];
	for (const item of shown) {
		lines.push(`- ${entryLabel(item.entry, multiRoot)} / ${item.entry.title} / ${item.reason}: ${item.detail}`);
	}
	if (report.entries.length > shown.length) lines.push(`- (+${report.entries.length - shown.length} more)`);
	return lines;
}

function issueCounts(issues: Issue[]): { errors: number; warnings: number } {
	let errors = 0;
	let warnings = 0;
	for (const issue of issues) {
		if (issue.level === "error") errors++;
		else warnings++;
	}
	return { errors, warnings };
}

/** One-time session-start message that makes lint findings actionable for the model. */
function formatLintMessage(issues: Issue[]): string {
	const shown = issues.slice(0, LINT_MESSAGE_LIMIT).map((issue) => `- ${issue.level}: ${issue.path}: ${issue.message}`);
	const hidden = issues.length - shown.length;
	if (hidden > 0) shown.push(`- (+${hidden} more)`);
	return [
		"knowledge: lint findings in the knowledge base. Fix entries in place with edit; search with kb_search before adding new ones.",
		...shown,
	].join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEdits(value: unknown): Array<{ oldText: string; newText: string }> | null {
	if (!Array.isArray(value)) return null;
	const edits: Array<{ oldText: string; newText: string }> = [];
	for (const item of value) {
		if (!isObject(item) || typeof item["oldText"] !== "string" || typeof item["newText"] !== "string") return null;
		edits.push({ oldText: item["oldText"], newText: item["newText"] });
	}
	return edits;
}

export default function knowledgeExtension(pi: ExtensionAPI): void {
	let config: KnowledgeConfig | null = null;
	let roots: ResolvedRoot[] = [];
	let catalog: CatalogData | null = null;
	let service: SearchService | null = null;
	let rendered: RenderedIndex | null = null;
	let section = "";
	let warnings: string[] = [];
	const notesByCall = new Map<string, string[]>();
	const recalled = new Set<string>();

	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning"): void => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	};

	const hookContext = (ctx: ExtensionContext): HookContext => ({
		cwd: ctx.cwd,
		roots,
		catalog: catalog ?? { entries: [], byId: new Map(), invalid: [], collisions: new Map() },
		enforce: config?.write.enforce ?? "block",
		now: new Date(),
	});

	const announceWarnings = (ctx: ExtensionContext, items: string[] = warnings): void => {
		if (items.length === 0) return;
		const [first, ...rest] = items;
		notify(ctx, `knowledge: ${first ?? ""}${rest.length > 0 ? ` (+${rest.length} more)` : ""}`, "warning");
	};

	/** Re-render the injected index from the current catalog (session start, compaction). */
	const refreshIndex = (ctx: ExtensionContext): void => {
		if (config === null || catalog === null) return;
		rendered = renderIndex(catalog, roots, config, ctx.model?.contextWindow ?? null);
		section = config.injection.enabled && roots.length > 0 ? rendered.text : "";
	};

	const reload = (ctx: ExtensionContext): void => {
		const loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		config = loaded.config;
		warnings = loaded.warnings;
		recalled.clear();
		notesByCall.clear();
		rendered = null;
		section = "";
		if (!config.enabled) {
			roots = [];
			catalog = null;
			service = null;
			return;
		}
		roots = resolveRoots(ctx.cwd, config.roots, warnings);
		catalog = buildCatalog(roots, warnings);
		service = new SearchService(catalog, config, { cwd: ctx.cwd, enabled: config.cache.enabled });
		refreshIndex(ctx);
		const issues = lintCatalog(catalog, roots, ctx.cwd, new Date());
		const counts = issueCounts(issues);
		if (counts.errors > 0 || counts.warnings > 0) {
			notify(ctx, `knowledge: ${counts.errors} errors, ${counts.warnings} warnings (run /kb lint)`, "warning");
			pi.sendMessage({ customType: "knowledge_lint", content: formatLintMessage(issues), display: false });
		}
		announceWarnings(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			reload(ctx);
		} catch (error) {
			config = null;
			catalog = null;
			section = "";
			notify(ctx, `knowledge: failed to load: ${message(error)}`, "warning");
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		if (config === null || catalog === null || !config.enabled) return;
		const before = warnings.length;
		const next = rescanCatalog(catalog, roots, warnings);
		service = new SearchService(next, config, { cwd: ctx.cwd, enabled: config.cache.enabled });
		catalog = next;
		refreshIndex(ctx);
		announceWarnings(ctx, warnings.slice(before));
	});

	const recallHint = (
		prompt: string,
	): { message: { customType: string; content: string; display: boolean } } | undefined => {
		if (config?.recall.mode !== "hint" || catalog === null) return undefined;
		const terms = tokenize(prompt);
		if (terms.length === 0) return undefined;
		const hits = catalog.entries
			.filter((entry) => entry.status === "active" && !recalled.has(`${entry.scope}:${entry.id}`))
			.map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
			.filter((hit) => hit.score > 0)
			.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
			.slice(0, RECALL_LIMIT);
		if (hits.length === 0) return undefined;
		const labels = hits.map((hit) => {
			recalled.add(`${hit.entry.scope}:${hit.entry.id}`);
			return roots.length > 1 ? `${hit.entry.scope}:${hit.entry.id}` : hit.entry.id;
		});
		return {
			message: {
				customType: "knowledge_recall",
				content: `Possibly relevant knowledge: ${labels.join(", ")}`,
				display: false,
			},
		};
	};

	pi.on("before_agent_start", (event, _ctx) => {
		if (section) event.systemPromptOptions.sections["knowledge_index"] = section;
		else delete event.systemPromptOptions.sections["knowledge_index"];
		return recallHint(event.prompt);
	});

	const planWriteCall = (ctx: ExtensionContext, input: Record<string, unknown>): HookOutcome | null => {
		if (typeof input["path"] !== "string" || typeof input["content"] !== "string") return null;
		const outcome = planWrite({ path: input["path"], content: input["content"] }, hookContext(ctx));
		if (outcome.allow && outcome.path !== undefined) input["path"] = outcome.path;
		return outcome;
	};

	const planEditCall = (ctx: ExtensionContext, input: Record<string, unknown>): HookOutcome | null => {
		if (typeof input["path"] !== "string") return null;
		const edits = toEdits(input["edits"]);
		if (edits === null) return null;
		return planEdit({ path: input["path"], edits }, hookContext(ctx));
	};

	const planCall = (ctx: ExtensionContext, toolName: string, input: Record<string, unknown>): HookOutcome | null => {
		if (toolName === "write") return planWriteCall(ctx, input);
		if (toolName === "edit") return planEditCall(ctx, input);
		return null;
	};

	pi.on("tool_call", (event, ctx) => {
		if (config === null || catalog === null || !config.enabled) return;
		const outcome = planCall(ctx, event.toolName, event.input as Record<string, unknown>);
		if (outcome === null) return;
		if (!outcome.allow) return { block: true, reason: outcome.reason ?? "blocked by pi-knowledge" };
		if (outcome.notes.length > 0) notesByCall.set(event.toolCallId, outcome.notes);
		return;
	});

	const refreshAfter = (toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): void => {
		if (catalog === null) return;
		const before = catalog;
		if (toolName === "write" || toolName === "edit") refreshTarget(input["path"], ctx);
		else if (toolName === "bash") catalog = rescanCatalog(catalog, roots, warnings);
		if (config !== null && catalog !== null && catalog !== before) {
			service = new SearchService(catalog, config, { cwd: ctx.cwd, enabled: config.cache.enabled });
		}
	};

	pi.on("tool_result", (event, ctx) => {
		if (config === null || !config.enabled) return;
		const notes = notesByCall.get(event.toolCallId) ?? [];
		notesByCall.delete(event.toolCallId);
		refreshAfter(event.toolName, event.input, ctx);
		if (notes.length === 0) return;
		return { content: [...event.content, { type: "text" as const, text: `kb: ${notes.join("; ")}` }] };
	});

	/** Re-parse one knowledge file after a successful write/edit. */
	const refreshTarget = (filePath: unknown, ctx: ExtensionContext): void => {
		if (typeof filePath !== "string" || catalog === null) return;
		const target = findKnowledgeTarget(filePath, ctx.cwd, roots);
		if (target === null || target.nested) return;
		const abs = path.join(target.root.dir, `${target.id}.md`);
		const result = parseEntryFile(abs, target.root);
		catalog = result.entry ? upsertEntry(catalog, result.entry, roots) : removeEntry(catalog, abs, roots);
		if (result.invalid !== null) notify(ctx, `knowledge: entry not usable: ${result.invalid}`, "warning");
	};

	pi.registerTool({
		name: "kb_search",
		label: "Knowledge Search",
		description:
			"Search the project knowledge base. Returns matching entries with their file paths; read the file before applying an entry. " +
			"Supports tag, status, and scope filters.",
		promptSnippet: "Search project knowledge entries (title, when, tags, body)",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search terms. Required unless tags are given." })),
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
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (config === null || catalog === null || !config.enabled) {
				return { content: [{ type: "text" as const, text: "No knowledge base is loaded." }], details: { hits: [] } };
			}
			return runKnowledgeSearch(catalog, config, service, params, roots);
		},
	});

	const statusReport = (ctx: ExtensionContext): string => {
		if (catalog === null || config === null) return "pi-knowledge: not loaded";
		const counts = issueCounts(lintCatalog(catalog, roots, ctx.cwd, new Date()));
		return [
			`pi-knowledge: ${config.enabled ? "on" : "off"}`,
			`roots: ${roots.map((root) => `${root.scope}=${root.display}${root.readonly ? " (readonly)" : ""}`).join(", ") || "(none)"}`,
			`entries: ${catalog.entries.length} (${catalog.entries.filter((entry) => entry.status === "active").length} active)`,
			`injection: ${rendered?.tier ?? "off"} ~${rendered?.totalTokens ?? 0} tokens${rendered?.overBudget ? " (over fixed budget)" : ""}`,
			`lint: ${counts.errors} errors, ${counts.warnings} warnings`,
			`backend: ${config.search.backend}`,
		].join("\n");
	};

	const searchReport = async (rest: string[]): Promise<string> => {
		if (catalog === null || config === null || service === null) return "pi-knowledge: not loaded";
		const result = await service.search(
			{ query: rest.join(" "), tags: [], status: "active", scope: null, limit: 10 },
			config.search.backend,
		);
		const text = formatSearchHits(result.hits, roots.length > 1) || "no matches";
		return result.fallback ? `${text}\n(fallback: ${result.fallbackReason ?? "unavailable"})` : text;
	};

	const report = (action: string, rest: string[], ctx: ExtensionContext): Promise<string | null> =>
		commandReport(action, rest, {
			catalog,
			config,
			roots,
			cwd: ctx.cwd,
			now: new Date(),
			status: () => statusReport(ctx),
			search: (sub) => searchReport(sub),
		});

	const runCapture = async (ctx: ExtensionContext, rest: string[]): Promise<void> => {
		if (config === null || config.capture.mode !== "manual") {
			notify(ctx, "pi-knowledge: capture is disabled", "warning");
			return;
		}
		const focus = rest.length > 0 ? `\nFocus: ${rest.join(" ")}` : "";
		await pi.sendUserMessage(`${CAPTURE_PROMPT}${focus}`, { deliverAs: "followUp" });
		notify(ctx, "pi-knowledge: capture requested", "info");
	};

	const reviewCandidates = (ctx: ExtensionContext): string | null => {
		if (catalog === null || config === null) return null;
		const multiRoot = roots.length > 1;
		const lines = [
			...duplicateLines(catalog, multiRoot),
			...staleLines(staleReport(catalog, config, ctx.cwd, new Date()), multiRoot),
		];
		return lines.length === 0 ? null : lines.join("\n");
	};

	const runReview = async (ctx: ExtensionContext, rest: string[]): Promise<void> => {
		const candidates = reviewCandidates(ctx);
		if (candidates === null) {
			notify(ctx, "pi-knowledge: nothing to review", "info");
			return;
		}
		const focus = rest.length > 0 ? `\nFocus: ${rest.join(" ")}` : "";
		await pi.sendUserMessage(`${REVIEW_PROMPT}\n\n${candidates}${focus}`, { deliverAs: "followUp" });
		notify(ctx, "pi-knowledge: review requested", "info");
	};

	pi.registerCommand("kb", {
		description:
			"pi-knowledge: status | config | lint | list | tags | find <tag...> | search <query> | stale | dups | refs <id> | review [focus] | docs | bench | capture [focus]",
		handler: async (args, ctx) => {
			if (config === null || !config.enabled) {
				notify(ctx, "pi-knowledge: disabled", "info");
				return;
			}
			const [action = "status", ...rest] = args.trim().split(/\s+/);
			if (action === "capture") {
				await runCapture(ctx, rest);
				return;
			}
			if (action === "review") {
				await runReview(ctx, rest);
				return;
			}
			const text = await report(action, rest, ctx);
			if (text === null) {
				notify(
					ctx,
					"usage: /kb status | config | lint | list | tags | find <tag...> | search <query> | stale | dups | refs <id> | review [focus] | docs | bench | capture [focus]",
					"warning",
				);
				return;
			}
			notify(ctx, cap(text, COMMAND_OUTPUT_LIMIT), "info");
		},
	});
}
