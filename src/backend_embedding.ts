/**
 * Embedding backend: an OpenAI-compatible HTTP endpoint with cosine ranking.
 *
 * Failures are classified into the shared `FallbackReason` values so the
 * service can fall back to lexical visibly (DESIGN.md §9.1).
 */

import type { EmbeddingConfig } from "./config.ts";
import type { EntryRecord, FallbackReason } from "./types.ts";

const BODY_INDEX_LIMIT = 64 * 1024;

export interface EmbeddingResponse {
	data?: Array<{ embedding?: number[] }>;
	usage?: { prompt_tokens?: number; total_tokens?: number };
}

export type EmbeddingResult =
	| { ok: true; vectors: number[][]; tokens: number | null }
	| { ok: false; reason: FallbackReason };

/** Natural text for embeddings. */
export function embeddingDocument(entry: EntryRecord): string {
	return `${entry.title} ${entry.when.join(" ")} ${entry.tags.join(" ")} ${entry.body}`.slice(0, BODY_INDEX_LIMIT);
}

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function tokensOf(json: EmbeddingResponse): number | null {
	const value = json.usage?.prompt_tokens;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function parseResponse(response: Response, count: number): Promise<EmbeddingResult> {
	if (response.status === 401 || response.status === 403) return { ok: false, reason: "auth" };
	if (response.status === 429) return { ok: false, reason: "rate_limited" };
	if (response.status >= 500) return { ok: false, reason: "server" };
	if (!response.ok) return { ok: false, reason: "protocol" };
	let json: EmbeddingResponse;
	try {
		json = (await response.json()) as EmbeddingResponse;
	} catch {
		return { ok: false, reason: "protocol" };
	}
	const vectors = (json.data ?? [])
		.map((item) => item.embedding)
		.filter((vector): vector is number[] => Array.isArray(vector));
	if (vectors.length !== count || vectors.some((vector) => vector.length === 0)) {
		return { ok: false, reason: "protocol" };
	}
	const dimension = vectors[0]?.length ?? 0;
	if (vectors.some((vector) => vector.length !== dimension)) return { ok: false, reason: "protocol" };
	return { ok: true, vectors, tokens: tokensOf(json) };
}

export async function embedTexts(config: EmbeddingConfig, texts: string[]): Promise<EmbeddingResult> {
	const { endpoint, model, apiKeyEnv, timeoutMs } = config;
	if (endpoint === "" || model === "") return { ok: false, reason: "unavailable" };
	const headers: Record<string, string> = { "content-type": "application/json" };
	const key = apiKeyEnv === "" ? "" : (process.env[apiKeyEnv] ?? "");
	if (key !== "") headers["authorization"] = `Bearer ${key}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify({ model, input: texts }),
			signal: controller.signal,
		});
		return await parseResponse(response, texts.length);
	} catch {
		return { ok: false, reason: "network" };
	} finally {
		clearTimeout(timer);
	}
}
