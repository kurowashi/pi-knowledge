/**
 * Lexical search over the catalog.
 *
 * Phase 1 implements the lexical backend only. Other configured backends fall
 * back to lexical with a visible `fallbackReason` instead of failing or
 * silently pretending to be semantic (DESIGN.md §9).
 */

import type { KnowledgeConfig } from "./config.ts";
import { estimateTokens } from "./tokens.ts";
import type {
	Backend,
	CatalogData,
	EntryRecord,
	FallbackReason,
	SearchHit,
	SearchOptions,
	SearchResult,
} from "./types.ts";

const ASCII_RUN = /[a-z0-9]+/g;
const CJK_RUN = /[\u3040-\u30ff\u4e00-\u9fff]+/g;

/** Terms: ASCII words of length >= 2 plus CJK characters and bigrams. */
export function tokenize(text: string): string[] {
	const lower = text.toLowerCase();
	const terms = new Set<string>();
	for (const word of lower.match(ASCII_RUN) ?? []) if (word.length >= 2) terms.add(word);
	for (const run of lower.match(CJK_RUN) ?? []) {
		const chars = [...run];
		for (let i = 0; i < chars.length; i++) {
			terms.add(chars[i] ?? "");
			const next = chars[i + 1];
			if (next !== undefined) terms.add(`${chars[i]}${next}`);
		}
	}
	return [...terms].filter((term) => term.length > 0);
}

export function scoreEntry(entry: EntryRecord, terms: string[]): number {
	if (terms.length === 0) return 1;
	const title = entry.title.toLowerCase();
	const when = entry.when.join(" ").toLowerCase();
	const tags = entry.tags.join(" ").toLowerCase();
	const body = entry.body.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (title.includes(term)) score += 3;
		if (when.includes(term)) score += 2;
		if (tags.includes(term)) score += 2;
		if (body.includes(term)) score += 1;
	}
	return Math.min(1, score / (terms.length * 3));
}

function matchesFilters(entry: EntryRecord, options: SearchOptions): boolean {
	if (options.status !== "any" && entry.status !== options.status) return false;
	if (options.scope !== null && entry.scope !== options.scope) return false;
	return options.tags.every((tag) => entry.tags.includes(tag));
}

function toHit(
	entry: EntryRecord,
	score: number,
	backend: Backend,
	fallback: boolean,
	fallbackReason: FallbackReason | null,
): SearchHit {
	const hit: SearchHit = {
		id: entry.id,
		scope: entry.scope,
		title: entry.title,
		when: entry.when,
		tags: entry.tags,
		status: entry.status,
		source: entry.source,
		path: entry.path,
		score,
		backend,
	};
	if (fallback) {
		hit.fallback = true;
		hit.fallbackReason = fallbackReason ?? "unavailable";
	}
	return hit;
}

export function searchCatalog(catalog: CatalogData, options: SearchOptions, config: KnowledgeConfig): SearchResult {
	const requested = config.search.backend;
	const fallback = requested !== "lexical";
	const fallbackReason: FallbackReason | null = fallback ? "unavailable" : null;
	const terms = tokenize(options.query);
	const limit = Math.max(1, Math.min(50, Math.floor(options.limit)));
	const hits: SearchHit[] = [];
	for (const entry of catalog.entries) {
		if (!matchesFilters(entry, options)) continue;
		const score = scoreEntry(entry, terms);
		if (terms.length > 0 && score <= 0) continue;
		hits.push(toHit(entry, score, "lexical", fallback, fallbackReason));
	}
	hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	return { hits: hits.slice(0, limit), backend: "lexical", fallback, fallbackReason };
}

/** Keep model-facing search output under the on-demand token cap. */
export function capSearchText(lines: string[], maxTokens: number): { text: string; truncated: boolean } {
	const kept: string[] = [];
	let tokens = 0;
	let truncated = false;
	for (const line of lines) {
		const cost = estimateTokens(line) + 1;
		if (tokens + cost > maxTokens) {
			truncated = true;
			break;
		}
		kept.push(line);
		tokens += cost;
	}
	if (truncated) kept.push(`… (${lines.length - kept.length} more; use limit)`);
	return { text: kept.join("\n"), truncated };
}
