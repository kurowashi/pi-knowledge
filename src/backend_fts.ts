/**
 * FTS5 backend: an in-memory SQLite index with CJK expansion and bm25 ranking.
 *
 * The index is optional: when the Node build lacks FTS5, `search` returns null
 * and the service falls back to lexical with a visible reason.
 */

import { matchesFilters, toHit, tokenize } from "./search.ts";
import type { CatalogData, EntryRecord, SearchHit, SearchOptions } from "./types.ts";

const BODY_INDEX_LIMIT = 64 * 1024;
const CJK_RUN = /[\u3040-\u30ff\u4e00-\u9fff]+/g;

export function expandCjk(text: string): string {
	return text.replace(CJK_RUN, (run) => {
		const chars = [...run];
		const parts: string[] = [];
		for (let i = 0; i < chars.length; i++) {
			parts.push(chars[i] ?? "");
			const next = chars[i + 1];
			if (next !== undefined) parts.push(`${chars[i]}${next}`);
		}
		return ` ${parts.join(" ")} `;
	});
}

function ftsDocument(entry: EntryRecord): string {
	return expandCjk(
		`${entry.title} ${entry.when.join(" ")} ${entry.tags.join(" ")} ${entry.body}`.slice(0, BODY_INDEX_LIMIT),
	);
}

function matchQuery(terms: string[]): string {
	return terms
		.filter((term) => term !== "")
		.map((term) => `"${term.replace(/"/g, '""')}"`)
		.join(" OR ");
}

interface FtsRow {
	key: string;
}

interface SqliteStatement {
	run(...args: unknown[]): unknown;
	all(...args: unknown[]): unknown[];
}

interface SqliteDb {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface SqliteModule {
	DatabaseSync: new (location: string) => SqliteDb;
}

export type DynamicImport = () => Promise<unknown>;

let sqliteModule: Promise<SqliteModule | null> | null = null;

export function loadSqlite(importer: DynamicImport = () => import("node:sqlite")): Promise<SqliteModule | null> {
	if (sqliteModule === null) {
		sqliteModule = importer()
			.then((mod) => mod as unknown as SqliteModule)
			.catch(() => null);
	}
	return sqliteModule;
}

export class FtsIndex {
	private readonly catalog: CatalogData;
	private dbPromise: Promise<SqliteDb | null> | null = null;
	private entriesByKey = new Map<string, EntryRecord>();

	constructor(catalog: CatalogData) {
		this.catalog = catalog;
	}

	async available(): Promise<boolean> {
		return (await this.index()) !== null;
	}

	/** Hits ordered by bm25, or null when FTS5 is unavailable. */
	async search(options: SearchOptions): Promise<SearchHit[] | null> {
		const db = await this.index();
		if (db === null) return null;
		const terms = tokenize(options.query);
		if (terms.length === 0) {
			return this.catalog.entries
				.filter((entry) => matchesFilters(entry, options))
				.slice(0, options.limit)
				.map((entry) => toHit(entry, 1, "fts5", false, null));
		}
		const rows = this.queryRows(db, terms, options);
		if (rows === null) return null;
		const hits: SearchHit[] = [];
		for (let index = 0; index < rows.length; index++) {
			const entry = this.entriesByKey.get(rows[index]?.key ?? "");
			if (entry === undefined || !matchesFilters(entry, options)) continue;
			hits.push(toHit(entry, 1 / (1 + hits.length), "fts5", false, null));
			if (hits.length >= options.limit) break;
		}
		return hits;
	}

	private queryRows(db: SqliteDb, terms: string[], options: SearchOptions): FtsRow[] | null {
		try {
			return db
				.prepare("SELECT key FROM entries WHERE entries MATCH ? ORDER BY bm25(entries) LIMIT ?")
				.all(matchQuery(terms), Math.max(options.limit * 5, 50)) as unknown as FtsRow[];
		} catch {
			return null;
		}
	}

	private index(): Promise<SqliteDb | null> {
		this.dbPromise ??= this.buildIndex();
		return this.dbPromise;
	}

	private async buildIndex(): Promise<SqliteDb | null> {
		const module = await loadSqlite();
		if (module === null) return null;
		try {
			const db = new module.DatabaseSync(":memory:");
			db.exec("CREATE VIRTUAL TABLE entries USING fts5(key UNINDEXED, body)");
			const insert = db.prepare("INSERT INTO entries (key, body) VALUES (?, ?)");
			const byKey = new Map<string, EntryRecord>();
			for (const entry of this.catalog.entries) {
				const key = `${entry.dir}/${entry.id}`;
				byKey.set(key, entry);
				insert.run(key, ftsDocument(entry));
			}
			this.entriesByKey = byKey;
			return db;
		} catch {
			return null;
		}
	}
}
