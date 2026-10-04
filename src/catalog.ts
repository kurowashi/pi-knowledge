/**
 * Catalog: scan roots, parse entries, and resolve id collisions.
 *
 * A `.md` directly under a root whose filename is `<hex8>.md` is an entry.
 * Parse or type errors exclude the entry from the catalog (`invalid`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { isValidDate } from "./lint.ts";
import type { CatalogData, EntryRecord, InvalidEntry, ResolvedRoot, Status } from "./types.ts";

export const ID_PATTERN = /^[0-9a-f]{8}$/;
const STATUSES: readonly Status[] = ["active", "superseded", "deprecated"];
const KNOWN_FIELDS = new Set(["title", "when", "tags", "status", "supersedes", "review_after", "source"]);

export interface ParseResult {
	entry: EntryRecord | null;
	invalid: string | null;
}

interface OptionalString {
	ok: boolean;
	value: string | null;
}

interface BaseFields {
	title: string;
	when: string[];
	tags: string[];
	status: Status;
}

interface ExtraFields {
	supersedes: string | null;
	reviewAfter: string | null;
	source: string | null;
}

function toWhen(value: unknown): string[] | null {
	if (value === undefined) return [];
	if (typeof value === "string") return value.trim() === "" ? [] : [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return value.map((item) => item.trim()).filter((item) => item !== "");
	}
	return null;
}

function toTags(value: unknown): string[] | null {
	if (value === undefined) return [];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return [...new Set(value.map((item) => item.trim()).filter((item) => item !== ""))];
	}
	return null;
}

function optionalString(value: unknown): OptionalString {
	if (value === undefined || value === null) return { ok: true, value: null };
	if (typeof value === "string") return { ok: true, value };
	return { ok: false, value: null };
}

function readBaseFields(meta: Record<string, unknown>): BaseFields | string {
	const title = meta["title"];
	if (typeof title !== "string" || title.trim() === "") return "title is required";
	const when = toWhen(meta["when"]);
	if (when === null) return "when must be text or a list of text";
	const tags = toTags(meta["tags"]);
	if (tags === null) return "tags must be a list of text";
	const status = meta["status"] ?? "active";
	if (typeof status !== "string" || !STATUSES.includes(status as Status)) {
		return "status must be active, superseded, or deprecated";
	}
	return { title, when, tags, status: status as Status };
}

function readExtraFields(meta: Record<string, unknown>): ExtraFields | string {
	const supersedes = optionalString(meta["supersedes"]);
	if (!supersedes.ok) return "supersedes must be an id";
	const reviewAfter = optionalString(meta["review_after"]);
	if (!reviewAfter.ok) return "review_after must be YYYY-MM-DD";
	if (reviewAfter.value !== null && !isValidDate(reviewAfter.value)) return "review_after must be YYYY-MM-DD";
	const source = optionalString(meta["source"]);
	if (!source.ok) return "source must be text";
	return { supersedes: supersedes.value, reviewAfter: reviewAfter.value, source: source.value };
}

/** Parse entry text. `filePath` is the prospective path for hooks. */
export function parseEntryText(
	text: string,
	id: string,
	root: ResolvedRoot,
	filePath: string,
	mtimeMs: number,
	size: number,
): ParseResult {
	const parsed = parseFrontmatter(text);
	if (parsed.error) return { entry: null, invalid: parsed.error };
	if (parsed.meta === null) return { entry: null, invalid: "no frontmatter" };
	const base = readBaseFields(parsed.meta);
	if (typeof base === "string") return { entry: null, invalid: base };
	const extra = readExtraFields(parsed.meta);
	if (typeof extra === "string") return { entry: null, invalid: extra };
	const unknownFields = Object.keys(parsed.meta)
		.filter((key) => !KNOWN_FIELDS.has(key))
		.sort();
	return {
		entry: {
			id,
			scope: root.scope,
			dir: root.dir,
			path: filePath,
			readonly: root.readonly,
			...base,
			...extra,
			unknownFields,
			body: parsed.body,
			mtimeMs,
			size,
		},
		invalid: null,
	};
}

export function parseEntryFile(filePath: string, root: ResolvedRoot): ParseResult {
	let text: string;
	let stat: fs.Stats;
	try {
		text = fs.readFileSync(filePath, "utf8");
		stat = fs.statSync(filePath);
	} catch (error) {
		return { entry: null, invalid: error instanceof Error ? error.message : String(error) };
	}
	return parseEntryText(text, path.basename(filePath, ".md"), root, filePath, stat.mtimeMs, stat.size);
}

function rebuildLookup(entries: EntryRecord[], roots: ResolvedRoot[]): CatalogData {
	const priorityByDir = new Map(roots.map((root) => [root.dir, root.priority]));
	const ordered = [...entries].sort(
		(a, b) =>
			a.id.localeCompare(b.id) ||
			(priorityByDir.get(b.dir) ?? 0) - (priorityByDir.get(a.dir) ?? 0) ||
			a.dir.localeCompare(b.dir),
	);
	const byId = new Map<string, EntryRecord>();
	const collisions = new Map<string, EntryRecord[]>();
	for (const entry of ordered) {
		if (!byId.has(entry.id)) byId.set(entry.id, entry);
		const list = collisions.get(entry.id) ?? [];
		list.push(entry);
		collisions.set(entry.id, list);
	}
	for (const [id, list] of collisions) {
		if (list.length < 2) collisions.delete(id);
	}
	return {
		entries: [...entries].sort((a, b) => a.id.localeCompare(b.id) || a.dir.localeCompare(b.dir)),
		byId,
		invalid: [],
		collisions,
	};
}

function isUnchanged(filePath: string, cached: EntryRecord): boolean {
	try {
		const stat = fs.statSync(filePath);
		return stat.mtimeMs === cached.mtimeMs && stat.size === cached.size;
	} catch {
		return false;
	}
}

function isInvalid(item: EntryRecord | InvalidEntry): item is InvalidEntry {
	return "reason" in item;
}

function scanFile(
	root: ResolvedRoot,
	name: string,
	warnings: string[],
	cache: Map<string, EntryRecord> | undefined,
): EntryRecord | InvalidEntry | null {
	const id = name.slice(0, -3);
	if (!ID_PATTERN.test(id)) {
		warnings.push(`knowledge: ${root.display}/${name} is not <hex8>.md; not an entry`);
		return null;
	}
	const filePath = path.join(root.dir, name);
	const cached = cache?.get(filePath);
	if (cached && isUnchanged(filePath, cached)) return cached;
	const result = parseEntryFile(filePath, root);
	return result.entry ?? { path: filePath, reason: result.invalid ?? "invalid" };
}

function scanRoot(
	root: ResolvedRoot,
	warnings: string[],
	cache: Map<string, EntryRecord> | undefined,
): { entries: EntryRecord[]; invalid: InvalidEntry[] } {
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(root.dir, { withFileTypes: true });
	} catch (error) {
		warnings.push(`knowledge: cannot read ${root.display}: ${error instanceof Error ? error.message : error}`);
		return { entries: [], invalid: [] };
	}
	const entries: EntryRecord[] = [];
	const invalid: InvalidEntry[] = [];
	for (const dirent of dirents) {
		if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
		const item = scanFile(root, dirent.name, warnings, cache);
		if (item === null) continue;
		if (isInvalid(item)) invalid.push(item);
		else entries.push(item);
	}
	return { entries, invalid };
}

export function buildCatalog(roots: ResolvedRoot[], warnings: string[], cache?: Map<string, EntryRecord>): CatalogData {
	const entries: EntryRecord[] = [];
	const invalid: InvalidEntry[] = [];
	for (const root of roots) {
		const scan = scanRoot(root, warnings, cache);
		entries.push(...scan.entries);
		invalid.push(...scan.invalid);
	}
	const data = rebuildLookup(entries, roots);
	data.invalid = invalid;
	return data;
}

/** Rescan roots, reusing parsed entries whose mtime and size are unchanged. */
export function rescanCatalog(previous: CatalogData, roots: ResolvedRoot[], warnings: string[]): CatalogData {
	return buildCatalog(roots, warnings, new Map(previous.entries.map((entry) => [entry.path, entry])));
}

/** Replace or add one entry (after a write/edit) and rebuild the id lookup. */
export function upsertEntry(data: CatalogData, entry: EntryRecord, roots: ResolvedRoot[]): CatalogData {
	const entries = data.entries.filter((item) => !(item.id === entry.id && item.dir === entry.dir));
	entries.push(entry);
	const next = rebuildLookup(entries, roots);
	next.invalid = data.invalid.filter((item) => item.path !== entry.path);
	return next;
}

/** Drop an entry by path (after deletion or rename) and rebuild the id lookup. */
export function removeEntry(data: CatalogData, filePath: string, roots: ResolvedRoot[]): CatalogData {
	const entries = data.entries.filter((item) => item.path !== filePath);
	const next = rebuildLookup(entries, roots);
	next.invalid = data.invalid.filter((item) => item.path !== filePath);
	return next;
}
