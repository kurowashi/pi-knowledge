/**
 * Shared output formatting for the CLI and the `/kb` command, so both surfaces
 * stay in sync (DESIGN.md §14).
 */

import { renderLine } from "./render.ts";
import type { CatalogData, Issue, SearchHit } from "./types.ts";

export function formatCatalog(catalog: CatalogData, multiRoot: boolean, all: boolean): string {
	return catalog.entries
		.filter((entry) => all || entry.status === "active")
		.map((entry) => renderLine(entry, multiRoot, "full"))
		.join("\n");
}

export function formatTagCounts(catalog: CatalogData): string {
	const counts = new Map<string, number>();
	for (const entry of catalog.entries) {
		for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([tag, count]) => `${tag}\t${count}`)
		.join("\n");
}

export function formatIssues(issues: Issue[]): string {
	return issues.map((issue) => `${issue.level} ${issue.path}: ${issue.message}`).join("\n");
}

export function formatSearchHit(hit: SearchHit, multiRoot: boolean): string {
	const label = multiRoot ? `${hit.scope}:${hit.id}` : hit.id;
	const when = hit.when.length > 0 ? ` — ${hit.when.join(" / ")}` : "";
	const excerpt = hit.excerpt === undefined ? "" : `\n  ${hit.excerpt}`;
	return `${label}  ${hit.title}${when}${excerpt}\n  path: ${hit.path}`;
}

export function formatSearchHits(hits: SearchHit[], multiRoot: boolean): string {
	return hits.map((hit) => formatSearchHit(hit, multiRoot)).join("\n");
}
