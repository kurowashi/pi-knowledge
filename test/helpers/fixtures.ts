/** Fixtures shared by unit and integration tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogData, EntryRecord, ResolvedRoot } from "../../src/types.ts";

export function makeRoot(dir: string, overrides: Partial<ResolvedRoot> = {}): ResolvedRoot {
	return { display: "knowledge", scope: "project", dir, priority: 100, readonly: false, ...overrides };
}

export function makeEntry(overrides: Partial<EntryRecord> = {}): EntryRecord {
	return {
		id: "01234567",
		scope: "project",
		dir: "/tmp/knowledge",
		path: "/tmp/knowledge/01234567.md",
		readonly: false,
		title: "A title",
		when: [],
		tags: [],
		status: "active",
		supersedes: null,
		reviewAfter: null,
		source: null,
		body: "This body is long enough to pass the fifty character minimum. ".repeat(2),
		mtimeMs: 0,
		size: 0,
		...overrides,
	};
}

export interface EntryFields {
	title?: string;
	when?: string[] | string;
	tags?: string[];
	status?: string;
	supersedes?: string;
	review_after?: string;
	source?: string;
}

export function entryText(fields: EntryFields, body: string): string {
	const lines = ["---"];
	if (fields.title !== undefined) lines.push(`title: ${JSON.stringify(fields.title)}`);
	if (fields.when !== undefined) {
		const when = Array.isArray(fields.when) ? fields.when : [fields.when];
		lines.push("when:");
		for (const item of when) lines.push(`  - ${item}`);
	}
	if (fields.tags !== undefined) lines.push(`tags: [${fields.tags.join(", ")}]`);
	if (fields.status !== undefined) lines.push(`status: ${fields.status}`);
	if (fields.supersedes !== undefined) lines.push(`supersedes: ${fields.supersedes}`);
	if (fields.review_after !== undefined) lines.push(`review_after: ${fields.review_after}`);
	if (fields.source !== undefined) lines.push(`source: ${fields.source}`);
	lines.push("---", "", body);
	return lines.join("\n");
}

export function writeEntry(dir: string, id: string, fields: EntryFields, body: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${id}.md`);
	fs.writeFileSync(file, entryText(fields, body));
	return file;
}

export function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-knowledge-test-"));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

export function withAgentDir<T>(dir: string, fn: () => T): T {
	const saved = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = dir;
	try {
		return fn();
	} finally {
		if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = saved;
	}
}

export function catalogOf(entries: EntryRecord[]): CatalogData {
	const byId = new Map<string, EntryRecord>();
	const collisions = new Map<string, EntryRecord[]>();
	for (const entry of entries) {
		if (!byId.has(entry.id)) byId.set(entry.id, entry);
		const list = collisions.get(entry.id) ?? [];
		list.push(entry);
		collisions.set(entry.id, list);
	}
	for (const [id, list] of collisions) {
		if (list.length < 2) collisions.delete(id);
	}
	return { entries, byId, invalid: [], collisions };
}
