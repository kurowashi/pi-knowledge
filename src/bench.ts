/**
 * `kb bench`: recall, latency, and token accounting for each search backend.
 *
 * Fixtures come from a JSON file: [{ "query": "...", "expect": ["<id>"], "tags": [] }].
 * Lexical is always measured; FTS5, embedding, and hybrid are measured when
 * available. Unavailable backends are reported with `fallback: true` instead
 * of being skipped, so the JSON is a stable comparison surface (DESIGN.md §9.4).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { KnowledgeConfig } from "./config.ts";
import { formatSearchHit } from "./format.ts";
import { SearchService } from "./search_service.ts";
import { estimateTokens } from "./tokens.ts";
import type { Backend, CatalogData, FallbackReason } from "./types.ts";

const ALL_BACKENDS: readonly Backend[] = ["lexical", "fts5", "embedding", "hybrid"];

export interface BenchFixture {
	query: string;
	expect: string[];
	tags?: string[];
}

export interface BenchReport {
	backend: Backend;
	fallback: boolean;
	fallbackReason: FallbackReason | null;
	fixtures: number;
	recallAt1: number;
	recallAt3: number;
	recallAt5: number;
	mrr: number;
	latencyMs: { p50: number; p95: number };
	/** First fixture pass; for embedding this includes the index build. */
	indexBuildMs: number;
	estimatedTokens: number;
	/** Provider-reported query tokens for this run, when the backend reports them. */
	actualTokens: number | null;
}

function toFixture(item: unknown): BenchFixture | null {
	if (typeof item !== "object" || item === null) return null;
	const record = item as Record<string, unknown>;
	const expect = record["expect"];
	if (typeof record["query"] !== "string" || !Array.isArray(expect) || !expect.every((id) => typeof id === "string")) {
		return null;
	}
	const tags = record["tags"];
	if (tags !== undefined && (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string"))) return null;
	return {
		query: record["query"],
		expect: expect as string[],
		...(tags === undefined ? {} : { tags: tags as string[] }),
	};
}

export function parseFixtures(value: unknown): BenchFixture[] | null {
	if (!Array.isArray(value)) return null;
	const fixtures: BenchFixture[] = [];
	for (const item of value) {
		const fixture = toFixture(item);
		if (fixture === null) return null;
		fixtures.push(fixture);
	}
	return fixtures;
}

export type FixtureLoad = { fixtures: BenchFixture[] } | { error: string };

/** Read and validate a fixture file; shared by the CLI and `/kb bench`. */
export function loadFixtures(cwd: string, fixturePath: string): FixtureLoad {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(path.resolve(cwd, fixturePath), "utf8"));
	} catch (error) {
		return { error: `cannot read ${fixturePath}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const fixtures = parseFixtures(parsed);
	if (fixtures === null) return { error: "fixtures must be [{ query, expect }]" };
	return { fixtures };
}

/** Parse `--repeat N` from an argument list; defaults to 5. */
export function repeatArg(rest: string[]): number {
	const index = rest.indexOf("--repeat");
	if (index < 0) return 5;
	const value = Number(rest[index + 1]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 5;
}

/** Parse `--backend <name>` from an argument list; null when absent or unknown. */
export function backendArg(rest: string[]): Backend | null {
	const index = rest.indexOf("--backend");
	const value = rest[index + 1];
	return value !== undefined && (ALL_BACKENDS as readonly string[]).includes(value) ? (value as Backend) : null;
}

function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index] ?? 0;
}

interface Accumulator {
	hit1: number;
	hit3: number;
	hit5: number;
	reciprocalRank: number;
	tokens: number;
}

function addScore(acc: Accumulator, rank: number, tokens: number): void {
	if (rank === 1) acc.hit1++;
	if (rank >= 1 && rank <= 3) acc.hit3++;
	if (rank >= 1 && rank <= 5) acc.hit5++;
	if (rank > 0) acc.reciprocalRank += 1 / rank;
	acc.tokens += tokens;
}

function unavailable(backend: Backend, reason: FallbackReason, fixtures: number): BenchReport {
	return {
		backend,
		fallback: true,
		fallbackReason: reason,
		fixtures,
		recallAt1: 0,
		recallAt3: 0,
		recallAt5: 0,
		mrr: 0,
		latencyMs: { p50: 0, p95: 0 },
		indexBuildMs: 0,
		estimatedTokens: 0,
		actualTokens: null,
	};
}

interface Measurement {
	acc: Accumulator;
	latencies: number[];
	indexBuildMs: number;
	fallback: boolean;
	fallbackReason: FallbackReason | null;
	actualTokens: number | null;
}

interface FixtureMeasurement {
	rank: number;
	tokens: number;
	fallback: boolean;
	fallbackReason: FallbackReason | null;
	actualTokens: number | null;
}

async function measureFixture(
	service: SearchService,
	fixture: BenchFixture,
	rounds: number,
	backend: Backend,
	latencies: number[],
): Promise<FixtureMeasurement> {
	let rank = 0;
	let tokens = 0;
	let fallback = false;
	let fallbackReason: FallbackReason | null = null;
	let actualTokens: number | null = null;
	for (let round = 0; round < rounds; round++) {
		const start = process.hrtime.bigint();
		const result = await service.search(
			{ query: fixture.query, tags: fixture.tags ?? [], status: "active", scope: null, limit: 10 },
			backend,
		);
		latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
		if (round > 0) continue;
		rank = result.hits.findIndex((hit) => fixture.expect.includes(hit.id)) + 1;
		tokens = estimateTokens(result.hits.map((hit) => formatSearchHit(hit, false)).join("\n"));
		fallback = result.fallback;
		fallbackReason = result.fallbackReason;
		if (service.actualTokens !== null) actualTokens = (actualTokens ?? 0) + service.actualTokens;
	}
	return { rank, tokens, fallback, fallbackReason, actualTokens };
}

async function measure(
	service: SearchService,
	fixtures: BenchFixture[],
	rounds: number,
	backend: Backend,
): Promise<Measurement> {
	const acc: Accumulator = { hit1: 0, hit3: 0, hit5: 0, reciprocalRank: 0, tokens: 0 };
	const latencies: number[] = [];
	const firstStart = process.hrtime.bigint();
	let indexBuildMs = 0;
	let fallback = false;
	let fallbackReason: FallbackReason | null = null;
	let actualTokens: number | null = null;
	for (let i = 0; i < fixtures.length; i++) {
		const fixture = fixtures[i];
		if (fixture === undefined) continue;
		const measured = await measureFixture(service, fixture, rounds, backend, latencies);
		if (i === 0) indexBuildMs = Number(process.hrtime.bigint() - firstStart) / 1e6;
		addScore(acc, measured.rank, measured.tokens);
		fallback = measured.fallback;
		fallbackReason = measured.fallbackReason;
		if (measured.actualTokens !== null) actualTokens = (actualTokens ?? 0) + measured.actualTokens;
	}
	return { acc, latencies, indexBuildMs, fallback, fallbackReason, actualTokens };
}

export async function runBench(
	catalog: CatalogData,
	config: KnowledgeConfig,
	fixtures: BenchFixture[],
	repeat = 5,
	backends: readonly Backend[] = ALL_BACKENDS,
): Promise<BenchReport[]> {
	const rounds = Math.max(1, Math.floor(repeat));
	const service = new SearchService(catalog, config);
	const reports: BenchReport[] = [];
	for (const backend of backends) {
		const status = await service.status(backend);
		if (!status.available) {
			reports.push(unavailable(backend, status.reason ?? "unavailable", fixtures.length));
			continue;
		}
		const measured = await measure(service, fixtures, rounds, backend);
		const total = Math.max(1, fixtures.length);
		reports.push({
			backend,
			fallback: measured.fallback,
			fallbackReason: measured.fallbackReason,
			fixtures: fixtures.length,
			recallAt1: measured.acc.hit1 / total,
			recallAt3: measured.acc.hit3 / total,
			recallAt5: measured.acc.hit5 / total,
			mrr: measured.acc.reciprocalRank / total,
			latencyMs: { p50: percentile(measured.latencies, 0.5), p95: percentile(measured.latencies, 0.95) },
			indexBuildMs: measured.indexBuildMs,
			estimatedTokens: measured.acc.tokens,
			actualTokens: measured.actualTokens,
		});
	}
	return reports;
}
