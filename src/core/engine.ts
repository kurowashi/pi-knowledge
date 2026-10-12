/**
 * Host-neutral engine: one Knowledge instance per host.
 *
 * A host (Pi, OpenCode) owns event subscription, tool registration, commands,
 * and where configuration and caches live. Everything else — config resolution,
 * the catalog, search, injection rendering, review candidates, and every
 * post-write notice — lives here so both hosts behave identically
 * (DESIGN.md §15).
 */

import * as path from "node:path";
import { buildCatalog, parseEntryFile, removeEntry, rescanCatalog, upsertEntry } from "./catalog.ts";
import { type HostPaths, type KnowledgeConfig, loadConfig } from "./config.ts";
import { formatSearchHit, formatSearchHits } from "./format.ts";
import { lintCatalog } from "./lint.ts";
import { type RenderedIndex, renderIndex } from "./render.ts";
import { commandReport } from "./report.ts";
import { reviewCandidates } from "./review.ts";
import { resolveRoots } from "./roots.ts";
import { capSearchText, scoreEntry, tokenize } from "./search.ts";
import { SearchService } from "./search_service.ts";
import type { Backend, CatalogData, Issue, ResolvedRoot, Scope, SearchOptions, SearchResult, Status } from "./types.ts";
import { findKnowledgeTarget, planWrite, type WriteContext, type WriteOutcome } from "./write_path.ts";

const RECALL_LIMIT = 3;
const LINT_MESSAGE_LIMIT = 8;
const SEARCH_CONTENT_TOKENS = 3000;
const REPORT_LIMIT = 8000;

const CAPTURE_PROMPT = [
	"Distill reusable knowledge from this session into the project knowledge base.",
	"Search first with kb_search, then write only self-contained entries that are not already covered.",
	"Name each new entry: write to knowledge/<slug>.md where the slug is up to five lowercase words joined by _ (DESIGN.md §6.3).",
	"Record external behavior you verified, never this project's own design (DESIGN.md §11.5).",
	"Follow the knowledge-curation skill: conclusion first, then conditions, evidence, counterexamples, and uncertainty.",
].join("\n");

const REVIEW_PROMPT = [
	"Tidy up the project knowledge base using the candidates below.",
	"Read each candidate entry before judging it, then apply accepted changes with the normal write/edit tools.",
	"Merge duplicates: keep one entry with the fuller conclusion and retire the other.",
	"Replace an entry: write the new entry with supersedes, then set the old entry to status: superseded.",
	"Refresh stale entries with new evidence and a new review_after, or retire them.",
	"Retire an unlinked entry only when its conclusion is already covered or wrong; an entry with no backlinks can still be the only record of a fact.",
	"Flag contradictions and low-value entries you find beyond these candidates, in your reply.",
	"Check kb refs before deleting anything; do not rewrite unrelated entries.",
].join("\n");

export interface KnowledgeOptions {
	cwd: string;
	paths: HostPaths;
	trusted: boolean;
	contextWindow: number | null;
}

export interface RecallHint {
	text: string;
}

export interface SearchParams {
	query?: string;
	tags?: string[];
	status?: Status | "any";
	scope?: Scope;
	limit?: number;
	backend?: Backend;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
}

/** Result of a `/kb` invocation. Every host renders `text` the same way. */
export interface CommandOutcome {
	kind: "report" | "state" | "prompt";
	text: string;
	level: "info" | "warning";
	/** Present only for `prompt`: the message to send to the model. */
	prompt?: string;
}

/** Host notification surface. A host without one passes a no-op. */
export interface KnowledgeHost {
	notify(text: string, level: "info" | "warning"): void;
}

const SILENT: KnowledgeHost = { notify: () => {} };

const NOT_LOADED: ToolResult = {
	content: [{ type: "text", text: "No knowledge base is loaded." }],
	details: { hits: [] },
};

const NO_ARGUMENTS: ToolResult = {
	content: [{ type: "text", text: "Provide a query or at least one tag." }],
	details: { hits: [] },
};

export class Knowledge {
	private config: KnowledgeConfig | null = null;
	private roots: ResolvedRoot[] = [];
	private catalog: CatalogData | null = null;
	private service: SearchService | null = null;
	private rendered: RenderedIndex | null = null;
	private section = "";
	private warnings: string[] = [];
	private recalled = new Set<string>();

	private readonly options: KnowledgeOptions;
	private readonly host: KnowledgeHost;

	constructor(options: KnowledgeOptions, host: KnowledgeHost = SILENT) {
		this.options = options;
		this.host = host;
	}

	get enabled(): boolean {
		return this.config?.enabled === true;
	}

	/** Resolved configuration, or null before `start`. */
	get loaded(): KnowledgeConfig | null {
		return this.config;
	}

	/** Load config, resolve roots, build the catalog, render the index, and report lint. */
	start(): void {
		try {
			this.reload();
		} catch (error) {
			this.config = null;
			this.catalog = null;
			this.section = "";
			this.host.notify(`knowledge: failed to load: ${message(error)}`, "warning");
		}
	}

	private reload(): void {
		const loaded = loadConfig(this.options.cwd, this.options.trusted, this.options.paths);
		this.config = loaded.config;
		this.warnings = loaded.warnings;
		this.recalled.clear();
		this.rendered = null;
		this.section = "";
		if (!this.config.enabled) {
			this.roots = [];
			this.catalog = null;
			this.service = null;
			return;
		}
		this.roots = resolveRoots(this.options.cwd, this.config.roots, this.warnings);
		this.catalog = buildCatalog(this.roots, this.warnings);
		this.service = this.makeService();
		this.refreshIndex();
		const issues = lintCatalog(this.catalog, this.roots, new Date());
		const counts = issueCounts(issues);
		if (counts.errors > 0 || counts.warnings > 0) {
			this.host.notify(`knowledge: ${counts.errors} errors, ${counts.warnings} warnings (run /kb lint)`, "warning");
		}
		this.announceWarnings();
	}

	private makeService(): SearchService | null {
		if (this.config === null || this.catalog === null) return null;
		return new SearchService(this.catalog, this.config, {
			cwd: this.options.cwd,
			enabled: this.config.cache.enabled,
			cacheDirName: this.options.paths.cacheDirName,
		});
	}

	private announceWarnings(items: string[] = this.warnings): void {
		if (items.length === 0) return;
		const [first, ...rest] = items;
		this.host.notify(`knowledge: ${first ?? ""}${rest.length > 0 ? ` (+${rest.length} more)` : ""}`, "warning");
	}

	/** The injected index section, or "" when injection is off. */
	get indexSection(): string {
		return this.section;
	}

	get renderedIndex(): RenderedIndex | null {
		return this.rendered;
	}

	/** Re-render the injected index from the current catalog. */
	private refreshIndex(): void {
		if (this.config === null || this.catalog === null) return;
		this.rendered = renderIndex(this.catalog, this.roots, this.config, this.options.contextWindow);
		this.section = this.config.injection.enabled && this.roots.length > 0 ? this.rendered.text : "";
	}

	/** Rescan after compaction so a continuation sees the current knowledge. */
	onCompacted(): void {
		if (this.catalog === null || this.config === null || !this.config.enabled) return;
		const before = this.warnings.length;
		this.catalog = rescanCatalog(this.catalog, this.roots, this.warnings);
		this.service = this.makeService();
		this.refreshIndex();
		this.announceWarnings(this.warnings.slice(before));
	}

	/** Top lint findings for the model, or null when the catalog is clean. */
	lintMessage(): string | null {
		if (this.catalog === null) return null;
		const issues = lintCatalog(this.catalog, this.roots, new Date());
		if (issueCounts(issues).errors + issueCounts(issues).warnings === 0) return null;
		const shown = issues
			.slice(0, LINT_MESSAGE_LIMIT)
			.map((issue) => `- ${issue.level}: ${issue.path}: ${issue.message}`);
		const hidden = issues.length - shown.length;
		if (hidden > 0) shown.push(`- (+${hidden} more)`);
		return [
			"knowledge: lint findings in the knowledge base. Fix entries in place with edit; search with kb_search before adding new ones.",
			...shown,
		].join("\n");
	}

	/** Relevant entries for a prompt, each offered once per session. */
	recall(prompt: string): RecallHint | null {
		if (this.config?.recall.mode !== "hint" || this.catalog === null) return null;
		const terms = tokenize(prompt);
		if (terms.length === 0) return null;
		const multiRoot = this.roots.length > 1;
		const hits = this.catalog.entries
			.filter((entry) => entry.status === "active" && !this.recalled.has(`${entry.scope}:${entry.id}`))
			.map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
			.filter((hit) => hit.score > 0)
			.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
			.slice(0, RECALL_LIMIT);
		if (hits.length === 0) return null;
		const labels = hits.map((hit) => {
			this.recalled.add(`${hit.entry.scope}:${hit.entry.id}`);
			return multiRoot ? `${hit.entry.scope}:${hit.entry.id}` : hit.entry.id;
		});
		return { text: `Possibly relevant knowledge: ${labels.join(", ")}` };
	}

	private writeContext(): WriteContext | null {
		if (this.config === null || this.catalog === null) return null;
		return {
			cwd: this.options.cwd,
			roots: this.roots,
			catalog: this.catalog,
			enforce: this.config.write.enforce,
		};
	}

	/**
	 * Decide a `write` call before it runs (DESIGN.md §7.1). Only the refusal
	 * and advisory notes matter; the path is never rewritten.
	 */
	planWrite(input: { path?: unknown }): WriteOutcome | null {
		const ctx = this.writeContext();
		if (ctx === null || typeof input.path !== "string") return null;
		return planWrite({ path: input.path }, ctx);
	}

	/** A readonly root refuses writes regardless of `write.enforce`. */
	isReadonlyPath(filePath: string): boolean {
		const target = findKnowledgeTarget(filePath, this.options.cwd, this.roots);
		return target?.root.readonly === true;
	}

	/**
	 * Re-read one entry after a tool ran and return lint notes for it. Errors
	 * exclude the entry from the catalog so the model is not handed a broken
	 * entry by the next search.
	 */
	afterWrite(filePath: unknown): string[] {
		if (this.catalog === null) return [];
		if (typeof filePath === "string") this.refreshTarget(filePath);
		return this.notesFor(filePath);
	}

	/** Refresh the whole catalog after a shell command changed files. */
	rescan(): string[] {
		if (this.catalog === null) return [];
		this.catalog = rescanCatalog(this.catalog, this.roots, this.warnings);
		this.service = this.makeService();
		return [];
	}

	private refreshTarget(filePath: unknown): void {
		if (typeof filePath !== "string" || this.catalog === null) return;
		const target = findKnowledgeTarget(filePath, this.options.cwd, this.roots);
		if (target === null || target.nested) return;
		const abs = path.join(target.root.dir, `${target.id}.md`);
		const result = parseEntryFile(abs, target.root);
		this.catalog = result.entry
			? upsertEntry(this.catalog, result.entry, this.roots)
			: removeEntry(this.catalog, abs, this.roots);
		if (result.invalid !== null) this.host.notify(`knowledge: entry not usable: ${result.invalid}`, "warning");
		if (result.entry !== null) this.service = this.makeService();
	}

	/** Lint notes for the entry a tool just wrote or edited. */
	private notesFor(filePath: unknown): string[] {
		if (this.catalog === null || typeof filePath !== "string") return [];
		const target = findKnowledgeTarget(filePath, this.options.cwd, this.roots);
		if (target === null || target.nested) return [];
		const entry = this.catalog.entries.find((item) => item.path === path.join(target.root.dir, `${target.id}.md`));
		if (entry === undefined) return [];
		return lintCatalog({ ...this.catalog, entries: [entry] }, this.roots, new Date()).map(
			(issue) => `${issue.level}: ${issue.message}`,
		);
	}

	async search(params: SearchParams): Promise<ToolResult> {
		const config = this.config;
		if (config === null || this.catalog === null || !config.enabled) return NOT_LOADED;
		const query = params.query?.trim() ?? "";
		const tags = params.tags ?? [];
		if (query === "" && tags.length === 0) return NO_ARGUMENTS;
		const service = this.service ?? this.makeService();
		if (service === null) return NOT_LOADED;
		const options: SearchOptions = {
			query,
			tags,
			status: params.status ?? "active",
			scope: params.scope ?? null,
			limit: params.limit ?? 10,
		};
		const result = await service.search(options, params.backend ?? config.search.backend);
		return renderHits(result, this.roots.length > 1);
	}

	/** `/kb status`: resolved state a user can act on (DESIGN.md §16). */
	statusReport(): string {
		if (this.catalog === null || this.config === null) return "pi-knowledge: not loaded";
		const counts = issueCounts(lintCatalog(this.catalog, this.roots, new Date()));
		const active = this.catalog.entries.filter((entry) => entry.status === "active").length;
		return [
			`pi-knowledge: ${this.config.enabled ? "on" : "off"}`,
			`roots: ${this.roots.map((root) => `${root.scope}=${root.display}${root.readonly ? " (readonly)" : ""}`).join(", ") || "(none)"}`,
			`entries: ${this.catalog.entries.length} (${active} active)`,
			`injection: ${this.rendered?.tier ?? "off"} ~${this.rendered?.totalTokens ?? 0} tokens${this.rendered?.overBudget ? " (over fixed budget)" : ""}`,
			`lint: ${counts.errors} errors, ${counts.warnings} warnings`,
			`backend: ${this.config.search.backend}`,
		].join("\n");
	}

	private async searchReport(rest: string[]): Promise<string | null> {
		if (this.catalog === null || this.config === null || this.service === null) return "pi-knowledge: not loaded";
		const result = await this.service.search(
			{ query: rest.join(" "), tags: [], status: "active", scope: null, limit: 10 },
			this.config.search.backend,
		);
		const text = formatSearchHits(result.hits, this.roots.length > 1) || "no matches";
		return result.fallback ? `${text}\n(fallback: ${result.fallbackReason ?? "unavailable"})` : text;
	}

	/** Report text for a `/kb` subcommand, or null when the action is unknown. */
	report(action: string, rest: string[]): Promise<string | null> {
		return commandReport(action, rest, {
			catalog: this.catalog,
			config: this.config,
			roots: this.roots,
			cwd: this.options.cwd,
			now: new Date(),
			status: () => this.statusReport(),
			search: (sub) => this.searchReport(sub),
		});
	}

	/** Prompt text for `/kb capture`, or null when capture is off. */
	capturePrompt(focus: string[]): string | null {
		if (this.config?.capture.mode !== "manual") return null;
		const suffix = focus.length > 0 ? `\nFocus: ${focus.join(" ")}` : "";
		return `${CAPTURE_PROMPT}${suffix}`;
	}

	/** Prompt text for `/kb review`, or null when there is nothing to review. */
	reviewPrompt(focus: string[]): string | null {
		if (this.catalog === null || this.config === null) return null;
		const candidates = reviewCandidates(this.catalog, this.config, this.roots, this.options.cwd, new Date());
		if (candidates.length === 0) return null;
		const suffix = focus.length > 0 ? `\nFocus: ${focus.join(" ")}` : "";
		return `${REVIEW_PROMPT}\n\n${candidates.join("\n")}${suffix}`;
	}

	/** Command surface shared by every host. */
	static usage =
		"usage: /kb status | config | lint | list | tags | find <tag...> | search <query> | stale | dups | refs <id> | review [focus] | docs | bench | capture [focus]";

	/** Run a `/kb` subcommand. `text` is for the user; `prompt` is for the model. */
	async runCommand(args: string): Promise<CommandOutcome> {
		if (this.config === null) return { kind: "state", text: "pi-knowledge: not loaded", level: "warning" };
		if (!this.config.enabled) return { kind: "state", text: "pi-knowledge: disabled", level: "info" };
		const [action = "status", ...rest] = args.trim().split(/\s+/);
		if (action === "capture") {
			const prompt = this.capturePrompt(rest);
			if (prompt === null) return { kind: "state", text: "pi-knowledge: capture is disabled", level: "warning" };
			return { kind: "prompt", text: "pi-knowledge: capture requested", level: "info", prompt };
		}
		if (action === "review") {
			const prompt = this.reviewPrompt(rest);
			if (prompt === null) return { kind: "state", text: "pi-knowledge: nothing to review", level: "info" };
			return { kind: "prompt", text: "pi-knowledge: review requested", level: "info", prompt };
		}
		const text = await this.report(action, rest);
		if (text === null) return { kind: "state", text: Knowledge.usage, level: "warning" };
		return { kind: "report", text: cap(text, REPORT_LIMIT), level: "info" };
	}
}

/** Format search hits for the model within the content budget. */
function renderHits(result: SearchResult, multiRoot: boolean): ToolResult {
	const capped = capSearchText(
		result.hits.map((hit) => formatSearchHit(hit, multiRoot)),
		SEARCH_CONTENT_TOKENS,
	);
	return {
		content: [{ type: "text", text: capped.text || "No matches." }],
		details: { ...result, truncated: capped.truncated },
	};
}

function cap(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
