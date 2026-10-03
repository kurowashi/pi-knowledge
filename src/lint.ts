/**
 * Validation: errors block writes (unless `write.enforce: "warn"`), warnings
 * are reported but allowed. The same rules feed the write hooks, `/kb lint`,
 * the CLI, and session-start reporting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findDuplicatePairs } from "./similar.ts";
import type { CatalogData, EntryRecord, Issue, ResolvedRoot } from "./types.ts";

const LINK_PATTERN = /\[\[([^\]\s]+)\]\]/g;
const TITLE_LIMIT = 120;
const WHEN_TOTAL_LIMIT = 200;
const WHEN_COUNT_LIMIT = 5;

export function extractLinks(body: string): string[] {
	const links: string[] = [];
	for (const match of body.matchAll(LINK_PATTERN)) {
		const target = match[1];
		if (target) links.push(target);
	}
	return links;
}

export function isValidDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function resolveId(id: string, catalog: CatalogData, roots: ResolvedRoot[]): EntryRecord | null {
	const colon = id.indexOf(":");
	if (colon === -1) return catalog.byId.get(id) ?? null;
	const scope = id.slice(0, colon);
	const local = id.slice(colon + 1);
	const root = roots.find((item) => item.scope === scope);
	if (!root) return null;
	return catalog.entries.find((entry) => entry.id === local && entry.dir === root.dir) ?? null;
}

function warn(entry: EntryRecord, message: string): Issue {
	return { level: "warning", path: entry.path, message };
}

function fieldIssues(entry: EntryRecord): Issue[] {
	const issues: Issue[] = [];
	if (entry.title.length > TITLE_LIMIT)
		issues.push(warn(entry, `title is ${entry.title.length} chars (limit ${TITLE_LIMIT})`));
	const whenChars = entry.when.reduce((sum, item) => sum + item.length, 0);
	if (whenChars > WHEN_TOTAL_LIMIT)
		issues.push(warn(entry, `when totals ${whenChars} chars (limit ${WHEN_TOTAL_LIMIT})`));
	if (entry.when.length > WHEN_COUNT_LIMIT)
		issues.push(warn(entry, `${entry.when.length} when items (limit ${WHEN_COUNT_LIMIT})`));
	if (entry.body.trim().length < 50) issues.push(warn(entry, "body is empty or shorter than 50 chars"));
	return issues;
}

function referenceIssues(
	entry: EntryRecord,
	catalog: CatalogData,
	roots: ResolvedRoot[],
	repoRoot: string,
	today: string,
): Issue[] {
	const issues: Issue[] = [];
	for (const link of extractLinks(entry.body)) {
		if (!resolveId(link, catalog, roots)) issues.push(warn(entry, `link [[${link}]] has no target`));
	}
	if (entry.supersedes !== null && !resolveId(entry.supersedes, catalog, roots)) {
		issues.push(warn(entry, `supersedes target ${entry.supersedes} not found`));
	}
	if (entry.source !== null && !entry.source.includes("://") && !fs.existsSync(path.resolve(repoRoot, entry.source))) {
		issues.push(warn(entry, `source path not found: ${entry.source}`));
	}
	if (entry.reviewAfter !== null && entry.reviewAfter < today) {
		issues.push(warn(entry, `review_after ${entry.reviewAfter} has passed`));
	}
	return issues;
}

/** Warnings for one parsed entry. Type errors were already excluded at parse time. */
export function validateEntry(
	entry: EntryRecord,
	catalog: CatalogData,
	roots: ResolvedRoot[],
	repoRoot: string,
	now: Date,
): Issue[] {
	return [...fieldIssues(entry), ...referenceIssues(entry, catalog, roots, repoRoot, now.toISOString().slice(0, 10))];
}

function invalidIssues(catalog: CatalogData): Issue[] {
	return catalog.invalid.map((invalid) => ({ level: "error" as const, path: invalid.path, message: invalid.reason }));
}

function collisionIssues(catalog: CatalogData): Issue[] {
	const issues: Issue[] = [];
	for (const [id, list] of catalog.collisions) {
		issues.push({ level: "error", path: list[0]?.path ?? id, message: `id ${id} exists in ${list.length} roots` });
	}
	return issues;
}

function dupIssues(catalog: CatalogData): Issue[] {
	return findDuplicatePairs(catalog).map((pair) => warn(pair.a, `similar to ${pair.b.id}`));
}

function nestedMarkdown(root: ResolvedRoot): Issue[] {
	const issues: Issue[] = [];
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(root.dir, { withFileTypes: true });
	} catch {
		return issues;
	}
	for (const dirent of dirents) {
		if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
		const dir = path.join(root.dir, dirent.name);
		try {
			for (const name of fs.readdirSync(dir)) {
				if (name.endsWith(".md")) {
					issues.push({
						level: "warning",
						path: path.join(dir, name),
						message: `nested markdown is not an entry: ${root.display}/${dirent.name}/${name}`,
					});
				}
			}
		} catch {
			// Unreadable subdirectory: ignore; the entry scan does not use it.
		}
	}
	return issues;
}

function nestedIssues(roots: ResolvedRoot[]): Issue[] {
	return roots.flatMap((root) => nestedMarkdown(root));
}

export function lintCatalog(catalog: CatalogData, roots: ResolvedRoot[], repoRoot: string, now: Date): Issue[] {
	const entryIssues = catalog.entries.flatMap((entry) => validateEntry(entry, catalog, roots, repoRoot, now));
	return [
		...invalidIssues(catalog),
		...collisionIssues(catalog),
		...entryIssues,
		...dupIssues(catalog),
		...nestedIssues(roots),
	];
}
