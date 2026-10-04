/**
 * Rendering of the injected index.
 *
 * The section is rendered at session start and refreshed from the live catalog
 * after compaction (DESIGN.md §10.4). Within the effective budget the renderer
 * degrades full -> title -> pointer, so the permanent context cost stays
 * bounded regardless of entry count or field lengths (DESIGN.md §10).
 */

import type { KnowledgeConfig } from "./config.ts";
import { estimateTokens } from "./tokens.ts";
import type { CatalogData, EntryRecord, ResolvedRoot } from "./types.ts";

export const FIXED_TEXT = [
	"## Project Knowledge",
	"",
	"This list is a discovery index. Read the entry file before applying it: `<dir>/<id>.md` per the Roots line. The body holds the conclusion, conditions, counterexamples, and evidence. Fix outdated entries in place; add an entry when work yields reusable knowledge.",
].join("\n");

export const TOOL_TOKEN_BUDGET = 500;
export const SKILL_TOKEN_BUDGET = 300;
/** Contract-test budget for FIXED_TEXT alone (measured 105). */
export const FIXED_TEXT_TOKEN_BUDGET = 110;
const TITLE_LIMIT = 120;
const TITLE_COMPACT_LIMIT = 60;
const WHEN_LIMIT = 200;

type Tier = "full" | "title" | "pointer";

export interface RenderedIndex {
	text: string;
	tier: Tier;
	/** Tokens of the injected section only. */
	sectionTokens: number;
	/** Section plus the provider tool declaration and skill metadata. */
	totalTokens: number;
	/** True when the fixed cost alone exceeds the configured budget. */
	overBudget: boolean;
}

export function effectiveBudget(config: KnowledgeConfig, contextWindow: number | null): number {
	if (contextWindow === null || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return config.injection.maxTokens;
	}
	const fromWindow = Math.floor(contextWindow * config.injection.contextFraction);
	return Math.min(config.injection.maxTokens, Math.max(config.injection.floorTokens, fromWindow));
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function rootsLine(roots: ResolvedRoot[]): string {
	return `Roots: ${roots.map((root) => `${root.scope}=${truncate(root.display, 32)}`).join(" ")}`;
}

export function renderLine(entry: EntryRecord, multiRoot: boolean, tier: "full" | "title"): string {
	const label = multiRoot ? `${entry.scope}:${entry.id}` : entry.id;
	if (tier === "title") return `${label}  ${truncate(entry.title, TITLE_COMPACT_LIMIT)}`;
	const title = truncate(entry.title, TITLE_LIMIT);
	if (entry.when.length === 0) return `${label}  ${title}`;
	return `${label}  ${title} — ${truncate(entry.when.join(" / "), WHEN_LIMIT)}`;
}

function sectionText(header: string, lines: string[]): string {
	return lines.length === 0 ? header : `${header}\n\n${lines.join("\n")}`;
}

export function renderIndex(
	catalog: CatalogData,
	roots: ResolvedRoot[],
	config: KnowledgeConfig,
	contextWindow: number | null,
): RenderedIndex {
	const header = `${FIXED_TEXT}\n${rootsLine(roots)}`;
	const budget = effectiveBudget(config, contextWindow);
	const sectionBudget = Math.max(0, budget - TOOL_TOKEN_BUDGET - SKILL_TOKEN_BUDGET);
	const multiRoot = roots.length > 1;
	const active = catalog.entries.filter((entry) => entry.status === "active");

	const make = (text: string, tier: Tier): RenderedIndex => {
		const sectionTokens = estimateTokens(text);
		const totalTokens = sectionTokens + TOOL_TOKEN_BUDGET + SKILL_TOKEN_BUDGET;
		return { text, tier, sectionTokens, totalTokens, overBudget: totalTokens > budget };
	};

	const attempt = (tier: "full" | "title"): RenderedIndex => {
		const text = sectionText(
			header,
			active.map((entry) => renderLine(entry, multiRoot, tier)),
		);
		return make(text, tier);
	};

	const full = attempt("full");
	if (full.sectionTokens <= sectionBudget) return full;
	const title = attempt("title");
	if (title.sectionTokens <= sectionBudget) return title;

	const tags = [...new Set(active.flatMap((entry) => entry.tags))].slice(0, 20);
	const count = `${active.length} entries`;
	const pointers = [
		`${count}. Tags: ${tags.join(", ") || "(none)"}. Use kb_search to find and read entries.`,
		`${count}. Use kb_search to find and read entries.`,
	];
	for (const pointer of pointers) {
		const rendered = make(sectionText(header, [pointer]), "pointer");
		if (rendered.sectionTokens <= sectionBudget) return rendered;
	}
	// The fixed header is mandatory; report the overflow instead of dropping it.
	return make(header, "pointer");
}
