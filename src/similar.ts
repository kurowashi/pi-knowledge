/**
 * Lexical similarity shared by lint and `kb dups`.
 *
 * Tokenization is ASCII words of length >= 2 plus CJK runs, split on the same
 * character classes the search backend uses. This is deliberately simple and
 * deterministic: duplicate detection is a curation aid, not a decision.
 */

import type { CatalogData, EntryRecord } from "./types.ts";

const DUPLICATE_THRESHOLD = 0.6;

function tokenSet(text: string): Set<string> {
	const words = text.toLowerCase().split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/);
	return new Set(words.filter((word) => word.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const item of a) if (b.has(item)) shared++;
	return shared / (a.size + b.size - shared);
}

function entryTokens(entry: EntryRecord): Set<string> {
	return tokenSet(`${entry.title} ${entry.when.join(" ")} ${entry.tags.join(" ")} ${entry.body}`);
}

export interface DuplicatePair {
	a: EntryRecord;
	b: EntryRecord;
	score: number;
}

/** Near-duplicate pairs among active entries, highest score first. */
export function findDuplicatePairs(catalog: CatalogData, threshold = DUPLICATE_THRESHOLD): DuplicatePair[] {
	const active = catalog.entries.filter((entry) => entry.status === "active");
	const cache = new Map<string, Set<string>>();
	const tokensOf = (entry: EntryRecord): Set<string> => {
		const key = `${entry.dir}/${entry.id}`;
		let set = cache.get(key);
		if (set === undefined) {
			set = entryTokens(entry);
			cache.set(key, set);
		}
		return set;
	};
	const pairs: DuplicatePair[] = [];
	for (let i = 0; i < active.length; i++) {
		for (let j = i + 1; j < active.length; j++) {
			const a = active[i];
			const b = active[j];
			if (a === undefined || b === undefined) continue;
			const score = jaccard(tokensOf(a), tokensOf(b));
			if (score >= threshold) pairs.push({ a, b, score });
		}
	}
	return pairs.sort((x, y) => y.score - x.score || x.a.id.localeCompare(y.a.id));
}

export function formatDuplicatePairs(pairs: DuplicatePair[]): string {
	return pairs.map((pair) => `${pair.a.id}  ${pair.b.id}  ${pair.score.toFixed(2)}`).join("\n");
}
