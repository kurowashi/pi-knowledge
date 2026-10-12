/**
 * `/kb review` candidate generation (DESIGN.md §11.4).
 *
 * The plugin hands candidates to the model and never rewrites an entry. It also
 * never asks a model to score anything: value and contradiction are judgments,
 * so the prompt states them as instructions and the model reads the entries.
 * Only what is cheap and exact is computed here.
 */

import type { KnowledgeConfig } from "./config.ts";
import { extractLinks } from "./lint.ts";
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

/** Every candidate kind discloses its truncation; the model must know the total. */
function hiddenLine(shown: number, total: number, noun: string): string[] {
	return total > shown ? [`- (+${total - shown} more ${noun} not shown)`] : [];
}

function duplicateLines(pairs: DuplicatePair[], multiRoot: boolean, total: number): string[] {
	if (pairs.length === 0) return [];
	return [
		`Duplicate candidates (similarity >= 0.6):`,
		...pairs.map(
			(pair) => `- ${describe(pair.a, multiRoot)} / ${describe(pair.b, multiRoot)} / ${pair.score.toFixed(2)}`,
		),
		...hiddenLine(pairs.length, total, "pairs"),
	];
}

function staleLines(report: StaleReport, multiRoot: boolean): string[] {
	const shown = report.entries.slice(0, STALE_LIMIT);
	if (shown.length === 0) return [];
	const lines = ["Stale candidates (id / title / reason):"];
	for (const item of shown) {
		lines.push(`- ${describe(item.entry, multiRoot)} / ${item.reason}: ${item.detail}`);
	}
	return [...lines, ...hiddenLine(shown.length, report.entries.length, "stale entries")];
}

/**
 * Entries nothing points at. A `scope:id` reference only counts for that scope;
 * a bare `[[id]]` matches the id in every scope, so it is checked per scope.
 */
function unlinkedEntries(catalog: CatalogData): EntryRecord[] {
	const scoped = new Set<string>();
	const bare = new Set<string>();
	for (const entry of catalog.entries) {
		for (const link of extractLinks(entry.body)) {
			const colon = link.indexOf(":");
			if (colon === -1) bare.add(link);
			else scoped.add(link);
		}
		if (entry.supersedes !== null) {
			const colon = entry.supersedes.indexOf(":");
			if (colon === -1) bare.add(entry.supersedes);
			else scoped.add(entry.supersedes);
		}
	}
	return catalog.entries.filter((entry) => {
		if (entry.status !== "active") return false;
		if (bare.has(entry.id)) return false;
		return !scoped.has(`${entry.scope}:${entry.id}`);
	});
}

function unlinkedLines(catalog: CatalogData, multiRoot: boolean): string[] {
	const entries = unlinkedEntries(catalog);
	const shown = entries.slice(0, UNLINKED_LIMIT);
	if (shown.length === 0) return [];
	return [
		"Unlinked candidates (no [[id]] or supersedes points at them):",
		...shown.map((entry) => `- ${describe(entry, multiRoot)}`),
		...hiddenLine(shown.length, entries.length, "unlinked entries"),
	];
}

export function reviewCandidates(
	catalog: CatalogData,
	config: KnowledgeConfig,
	roots: ResolvedRoot[],
	cwd: string,
	now: Date,
): string[] {
	const multiRoot = roots.length > 1;
	const pairs = findDuplicatePairs(catalog);
	return [
		...duplicateLines(pairs.slice(0, DUP_LIMIT), multiRoot, pairs.length),
		...staleLines(staleReport(catalog, config, cwd, now), multiRoot),
		...unlinkedLines(catalog, multiRoot),
	];
}
