/**
 * `/kb review` candidate generation (DESIGN.md §11.4).
 *
 * The plugin hands candidates to the model and never rewrites an entry. It also
 * never asks a model to score anything: value and contradiction are judgments,
 * so the prompt states them as instructions and the model reads the entries.
 * Only what is cheap and exact is computed here.
 */

import type { KnowledgeConfig } from "./config.ts";
import { type DuplicatePair, findDuplicatePairs } from "./similar.ts";
import { type StaleReport, staleReport } from "./stale.ts";
import type { CatalogData, EntryRecord, ResolvedRoot } from "./types.ts";

const DUP_LIMIT = 5;
const STALE_LIMIT = 10;
/** Entries nobody links to are candidates for retirement, not for deletion. */
const UNLINKED_LIMIT = 10;

function label(entry: EntryRecord, multiRoot: boolean): string {
	return multiRoot ? `${entry.scope}:${entry.id}` : entry.id;
}

function describe(entry: EntryRecord, multiRoot: boolean): string {
	return `${label(entry, multiRoot)} ${entry.title}`;
}

function duplicateLines(pairs: DuplicatePair[], multiRoot: boolean): string[] {
	if (pairs.length === 0) return [];
	const lines = [`Duplicate candidates (similarity >= 0.6, ${pairs.length} shown):`];
	for (const pair of pairs) {
		lines.push(`- ${describe(pair.a, multiRoot)} / ${describe(pair.b, multiRoot)} / ${pair.score.toFixed(2)}`);
	}
	return lines;
}

function staleLines(report: StaleReport, multiRoot: boolean): string[] {
	const shown = report.entries.slice(0, STALE_LIMIT);
	if (shown.length === 0) return [];
	const lines = ["Stale candidates (id / title / reason):"];
	for (const item of shown) {
		lines.push(`- ${describe(item.entry, multiRoot)} / ${item.reason}: ${item.detail}`);
	}
	if (report.entries.length > shown.length) {
		lines.push(`- (+${report.entries.length - shown.length} more stale entries not shown)`);
	}
	return lines;
}

function unlinkedEntries(catalog: CatalogData): EntryRecord[] {
	const referenced = new Set<string>();
	for (const entry of catalog.entries) {
		for (const match of entry.body.matchAll(/\[\[([^\]\s]+)\]\]/g)) {
			const target = match[1];
			if (target !== undefined) referenced.add(target);
		}
		if (entry.supersedes !== null) {
			const colon = entry.supersedes.indexOf(":");
			referenced.add(colon === -1 ? entry.supersedes : entry.supersedes.slice(colon + 1));
		}
	}
	return catalog.entries.filter((entry) => entry.status === "active" && !referenced.has(entry.id));
}

function unlinkedLines(catalog: CatalogData, multiRoot: boolean): string[] {
	const shown = unlinkedEntries(catalog).slice(0, UNLINKED_LIMIT);
	if (shown.length === 0) return [];
	const lines = ["Unlinked candidates (no [[id]] or supersedes points at them):"];
	for (const entry of shown) lines.push(`- ${describe(entry, multiRoot)}`);
	return lines;
}

export function reviewCandidates(
	catalog: CatalogData,
	config: KnowledgeConfig,
	roots: ResolvedRoot[],
	cwd: string,
	now: Date,
): string[] {
	const multiRoot = roots.length > 1;
	return [
		...duplicateLines(findDuplicatePairs(catalog).slice(0, DUP_LIMIT), multiRoot),
		...staleLines(staleReport(catalog, config, cwd, now), multiRoot),
		...unlinkedLines(catalog, multiRoot),
	];
}
