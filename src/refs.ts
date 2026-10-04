/**
 * Reference graph: who links to an entry via `[[id]]` or `supersedes`.
 * Used by `kb refs <id>` and by lint for dangling-target warnings.
 */

import { extractLinks } from "./lint.ts";
import type { CatalogData, EntryRecord } from "./types.ts";

interface Reference {
	from: EntryRecord;
	kind: "link" | "supersedes";
}

export interface RefReport {
	target: EntryRecord | null;
	references: Reference[];
}

export function findReferences(catalog: CatalogData, id: string): RefReport {
	const target = catalog.byId.get(id) ?? null;
	const references: Reference[] = [];
	for (const entry of catalog.entries) {
		if (entry.supersedes !== null && linkMatches(entry.supersedes, id)) {
			references.push({ from: entry, kind: "supersedes" });
			continue;
		}
		if (extractLinks(entry.body).some((link) => linkMatches(link, id))) {
			references.push({ from: entry, kind: "link" });
		}
	}
	return { target, references };
}

/** `[[id]]`, `[[scope:id]]`, and scoped `supersedes` all reference the local id. */
function linkMatches(link: string, id: string): boolean {
	const colon = link.indexOf(":");
	return colon === -1 ? link === id : link.slice(colon + 1) === id;
}

export function formatReferences(report: RefReport, id: string): string {
	if (report.target === null) return `no entry with id ${id}`;
	if (report.references.length === 0) return "no references";
	return report.references.map((reference) => `${reference.from.id}  (${reference.kind})`).join("\n");
}
