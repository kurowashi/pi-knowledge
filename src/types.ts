/** Shared types for pi-knowledge. */

export type Scope = "project" | "user";
export type Status = "active" | "superseded" | "deprecated";
export type Backend = "lexical" | "fts5" | "embedding" | "hybrid";
export type Enforce = "block" | "warn";

export interface RootConfig {
	path: string;
	scope: Scope;
	priority: number;
	readonly: boolean;
}

export interface ResolvedRoot {
	/** Display path for the injected `Roots:` line, exactly as configured. */
	display: string;
	scope: Scope;
	/** Absolute directory. */
	dir: string;
	priority: number;
	readonly: boolean;
}

export interface EntryRecord {
	id: string;
	scope: Scope;
	dir: string;
	path: string;
	readonly: boolean;
	title: string;
	when: string[];
	tags: string[];
	status: Status;
	supersedes: string | null;
	reviewAfter: string | null;
	source: string | null;
	body: string;
	mtimeMs: number;
	size: number;
}

export interface InvalidEntry {
	path: string;
	reason: string;
}

export interface CatalogData {
	/** Parsed entries, sorted by id then scope. */
	entries: EntryRecord[];
	/** Resolved lookup: the highest-priority entry per id. */
	byId: Map<string, EntryRecord>;
	/** Entries excluded from the catalog (parse or type errors). */
	invalid: InvalidEntry[];
	/** Same id in multiple roots (resolved by priority at lookup time). */
	collisions: Map<string, EntryRecord[]>;
}

export interface Issue {
	level: "error" | "warning";
	path: string;
	message: string;
}

export type FallbackReason = "unavailable" | "auth" | "network" | "rate_limited" | "server" | "protocol";

export interface SearchHit {
	id: string;
	scope: Scope;
	title: string;
	when: string[];
	tags: string[];
	status: Status;
	source: string | null;
	path: string;
	/** Body excerpt (≤200 chars) for model-facing results. */
	excerpt?: string;
	score: number;
	backend: Backend;
	fallback?: boolean;
	fallbackReason?: FallbackReason;
}

export interface SearchOptions {
	query: string;
	tags: string[];
	status: Status | "any";
	scope: Scope | null;
	limit: number;
}

export interface SearchResult {
	hits: SearchHit[];
	backend: Backend;
	fallback: boolean;
	fallbackReason: FallbackReason | null;
}
