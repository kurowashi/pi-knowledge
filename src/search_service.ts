/**
 * Search service: selects a backend, builds its index lazily, and falls back to
 * lexical with a visible reason when the requested backend is unavailable
 * (DESIGN.md §9).
 */

import { cosine, embeddingDocument, embedTexts } from "./backend_embedding.ts";
import { FtsIndex } from "./backend_fts.ts";
import type { KnowledgeConfig } from "./config.ts";
import { matchesFilters, searchCatalog, toHit } from "./search.ts";
import type { Backend, CatalogData, FallbackReason, SearchHit, SearchOptions, SearchResult } from "./types.ts";

const RRF_K = 60;

export interface BackendStatus {
	id: Backend;
	available: boolean;
	reason: FallbackReason | null;
	detail: string | null;
}

interface EmbeddingHits {
	hits: SearchHit[];
	tokens: number | null;
}

export class SearchService {
	private readonly catalog: CatalogData;
	private readonly config: KnowledgeConfig;
	private readonly fts: FtsIndex;
	private embeddingVectors: Map<string, number[]> | null = null;
	private embeddingIndexPromise: Promise<FallbackReason | null> | null = null;
	private lastTokens: number | null = null;

	constructor(catalog: CatalogData, config: KnowledgeConfig) {
		this.catalog = catalog;
		this.config = config;
		this.fts = new FtsIndex(catalog);
	}

	/** Provider-reported query tokens from the most recent search, if any. */
	get actualTokens(): number | null {
		return this.lastTokens;
	}

	async status(backend: Backend): Promise<BackendStatus> {
		if (backend === "lexical") return { id: backend, available: true, reason: null, detail: null };
		if (backend === "fts5") {
			const available = await this.fts.available();
			return available
				? { id: backend, available: true, reason: null, detail: null }
				: { id: backend, available: false, reason: "unavailable", detail: "FTS5 is not available in this Node build" };
		}
		if (!this.embeddingConfigured()) {
			return { id: backend, available: false, reason: "unavailable", detail: "embedding endpoint is not configured" };
		}
		return { id: backend, available: true, reason: null, detail: null };
	}

	async search(options: SearchOptions, requested: Backend): Promise<SearchResult> {
		this.lastTokens = null;
		if (requested === "lexical") return searchCatalog(this.catalog, options);
		if (requested === "fts5") {
			const hits = await this.fts.search(options);
			if (hits === null) return this.fallback(options, "unavailable");
			return { hits, backend: "fts5", fallback: false, fallbackReason: null };
		}
		if (options.query.trim() === "") {
			// Tag/filter-only searches have no semantic signal: lexical filters are the honest backend.
			return searchCatalog(this.catalog, options);
		}
		if (requested === "embedding") {
			const embedded = await this.embeddingHits(options);
			if ("reason" in embedded) return this.fallback(options, embedded.reason);
			this.lastTokens = embedded.tokens;
			return { hits: embedded.hits, backend: "embedding", fallback: false, fallbackReason: null };
		}
		return this.hybrid(options);
	}

	private fallback(options: SearchOptions, reason: FallbackReason): SearchResult {
		const lexical = searchCatalog(this.catalog, options);
		this.lastTokens = null;
		return { hits: lexical.hits, backend: "lexical", fallback: true, fallbackReason: reason };
	}

	private embeddingConfigured(): boolean {
		const { endpoint, model } = this.config.search.embedding;
		return endpoint !== "" && model !== "";
	}

	private async embeddingIndex(): Promise<FallbackReason | null> {
		if (this.embeddingVectors !== null) return null;
		if (this.embeddingIndexPromise === null) this.embeddingIndexPromise = this.buildEmbeddingIndex();
		const result = await this.embeddingIndexPromise;
		if (result !== null) this.embeddingIndexPromise = null;
		return result;
	}

	private async buildEmbeddingIndex(): Promise<FallbackReason | null> {
		if (this.embeddingVectors !== null) return null;
		const entries = this.catalog.entries;
		if (entries.length === 0) {
			this.embeddingVectors = new Map();
			return null;
		}
		const result = await embedTexts(
			this.config.search.embedding,
			entries.map((entry) => embeddingDocument(entry)),
		);
		if (!result.ok) return result.reason;
		const vectors = new Map<string, number[]>();
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			const vector = result.vectors[index];
			if (entry === undefined || vector === undefined) return "protocol";
			vectors.set(`${entry.dir}/${entry.id}`, vector);
		}
		this.embeddingVectors = vectors;
		return null;
	}

	private rankEmbeddingHits(queryVector: number[], options: SearchOptions): SearchHit[] {
		const vectors = this.embeddingVectors ?? new Map<string, number[]>();
		const hits: SearchHit[] = [];
		for (const entry of this.catalog.entries) {
			if (!matchesFilters(entry, options)) continue;
			const vector = vectors.get(`${entry.dir}/${entry.id}`);
			if (vector === undefined) continue;
			const similarity = cosine(queryVector, vector);
			if (similarity <= 0) continue;
			hits.push(toHit(entry, Math.min(1, (similarity + 1) / 2), "embedding", false, null));
		}
		hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		return hits.slice(0, Math.max(1, options.limit));
	}

	private async embeddingHits(options: SearchOptions): Promise<EmbeddingHits | { reason: FallbackReason }> {
		const indexFailure = await this.embeddingIndex();
		if (indexFailure !== null) return { reason: indexFailure };
		const queryResult = await embedTexts(this.config.search.embedding, [options.query]);
		if (!queryResult.ok) return { reason: queryResult.reason };
		const queryVector = queryResult.vectors[0] ?? [];
		const expected = firstDimension(this.embeddingVectors);
		if (expected > 0 && queryVector.length !== expected) return { reason: "protocol" };
		return { hits: this.rankEmbeddingHits(queryVector, options), tokens: queryResult.tokens };
	}

	private async hybrid(options: SearchOptions): Promise<SearchResult> {
		const lexical = searchCatalog(this.catalog, options);
		const embedded = await this.embeddingHits(options);
		if ("reason" in embedded) {
			this.lastTokens = null;
			return { hits: lexical.hits, backend: "lexical", fallback: true, fallbackReason: embedded.reason };
		}
		this.lastTokens = embedded.tokens;
		return {
			hits: fuse(lexical.hits, embedded.hits, options.limit),
			backend: "hybrid",
			fallback: false,
			fallbackReason: null,
		};
	}
}

function firstDimension(vectors: Map<string, number[]> | null): number {
	if (vectors === null) return 0;
	for (const vector of vectors.values()) return vector.length;
	return 0;
}

function fuse(lexical: SearchHit[], embedded: SearchHit[], limit: number): SearchHit[] {
	const scores = new Map<string, number>();
	const hits = new Map<string, SearchHit>();
	const add = (list: SearchHit[]): void => {
		for (let index = 0; index < list.length; index++) {
			const hit = list[index];
			if (hit === undefined) continue;
			const key = `${hit.scope}:${hit.id}`;
			scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + index + 1));
			hits.set(key, hit);
		}
	};
	add(lexical);
	add(embedded);
	if (scores.size === 0) return [];
	const best = Math.max(...scores.values());
	return [...scores.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, Math.max(1, limit))
		.flatMap(([key, score]) => {
			const hit = hits.get(key);
			return hit === undefined ? [] : [{ ...hit, backend: "hybrid" as const, score: score / best }];
		});
}
