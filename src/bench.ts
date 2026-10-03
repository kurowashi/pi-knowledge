/**
 * `kb bench`: recall and latency for the configured search backend.
 *
 * Fixtures come from a JSON file: [{ "query": "...", "expect": ["<id>"], "tags": [] }].
 * Phase 2 measures lexical search; other backends fall back and are reported
 * as such. Real provider token usage is recorded as null until Phase 3 wires a
 * provider call (DESIGN.md §9.4).
 */

import type { KnowledgeConfig } from "./config.ts";
import { searchCatalog } from "./search.ts";
import { estimateTokens } from "./tokens.ts";
import type { CatalogData } from "./types.ts";

export interface BenchFixture {
	query: string;
	expect: string[];
	tags?: string[];
}

export interface BenchReport {
	backend: string;
	fallback: boolean;
	fixtures: number;
	recallAt1: number;
	recallAt3: number;
	recallAt5: number;
	mrr: number;
	latencyMs: { p50: number; p95: number };
	/** Lexical has no separate index; the first fixture pass is reported as a proxy. */
	indexBuildMs: number;
	estimatedTokens: number;
	actualTokens: null;
}

export function parseFixtures(value: unknown): BenchFixture[] | null {
	if (!Array.isArray(value)) return null;
	const fixtures: BenchFixture[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) return null;
		const record = item as Record<string, unknown>;
		const expect = record["expect"];
		if (
			typeof record["query"] !== "string" ||
			!Array.isArray(expect) ||
			!expect.every((id) => typeof id === "string")
		) {
			return null;
		}
		fixtures.push({ query: record["query"], expect: expect as string[] });
	}
	return fixtures;
}

function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

interface FixtureScore {
	rank: number;
	tokens: number;
}

function scoreFixture(
	catalog: CatalogData,
	config: KnowledgeConfig,
	fixture: BenchFixture,
	rounds: number,
	latencies: number[],
): FixtureScore {
	let rank = 0;
	let tokens = 0;
	for (let round = 0; round < rounds; round++) {
		const start = process.hrtime.bigint();
		const result = searchCatalog(
			catalog,
			{ query: fixture.query, tags: fixture.tags ?? [], status: "active", scope: null, limit: 10 },
			config,
		);
		latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
		if (round > 0) continue;
		rank = result.hits.findIndex((hit) => fixture.expect.includes(hit.id)) + 1;
		tokens = estimateTokens(result.hits.map((hit) => `${hit.id} ${hit.title}`).join("\n"));
	}
	return { rank, tokens };
}

interface BenchAccumulator {
	hit1: number;
	hit3: number;
	hit5: number;
	reciprocalRank: number;
	tokens: number;
}

function addScore(acc: BenchAccumulator, score: FixtureScore): void {
	if (score.rank === 1) acc.hit1++;
	if (score.rank >= 1 && score.rank <= 3) acc.hit3++;
	if (score.rank >= 1 && score.rank <= 5) acc.hit5++;
	if (score.rank > 0) acc.reciprocalRank += 1 / score.rank;
	acc.tokens += score.tokens;
}

function accumulate(
	fixtures: BenchFixture[],
	catalog: CatalogData,
	config: KnowledgeConfig,
	rounds: number,
	latencies: number[],
): { acc: BenchAccumulator; indexBuildMs: number } {
	const acc: BenchAccumulator = { hit1: 0, hit3: 0, hit5: 0, reciprocalRank: 0, tokens: 0 };
	const firstStart = process.hrtime.bigint();
	let indexBuildMs = 0;
	for (let i = 0; i < fixtures.length; i++) {
		const fixture = fixtures[i];
		if (fixture === undefined) continue;
		const score = scoreFixture(catalog, config, fixture, rounds, latencies);
		if (i === 0) indexBuildMs = Number(process.hrtime.bigint() - firstStart) / 1e6;
		addScore(acc, score);
	}
	return { acc, indexBuildMs };
}

export function runBench(
	catalog: CatalogData,
	config: KnowledgeConfig,
	fixtures: BenchFixture[],
	repeat = 5,
): BenchReport {
	const rounds = Math.max(1, Math.floor(repeat));
	const latencies: number[] = [];
	const { acc, indexBuildMs } = accumulate(fixtures, catalog, config, rounds, latencies);
	const total = Math.max(1, fixtures.length);
	return {
		backend: config.search.backend,
		fallback: config.search.backend !== "lexical",
		fixtures: fixtures.length,
		recallAt1: acc.hit1 / total,
		recallAt3: acc.hit3 / total,
		recallAt5: acc.hit5 / total,
		mrr: acc.reciprocalRank / total,
		latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
		indexBuildMs,
		estimatedTokens: acc.tokens,
		actualTokens: null,
	};
}
