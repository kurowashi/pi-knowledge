#!/usr/bin/env node
/**
 * kb CLI: list / tags / find / search / lint / stale / dups / refs / docs / bench.
 *
 * Uses the same config resolution, lint rules, search service, and catalog as
 * the extension. Exit codes: 0 ok, 1 lint errors / no find hits / docs drift,
 * 2 usage/config or docs read/write error, 3 `--require-backend` was given and
 * the requested backend fell back to lexical.
 */

import { pathToFileURL } from "node:url";
import { backendArg, loadFixtures, repeatArg, runBench } from "./bench.ts";
import { buildCatalog } from "./catalog.ts";
import { type KnowledgeConfig, loadConfig } from "./config.ts";
import { runDocs } from "./docs.ts";
import { formatCatalog, formatIssues, formatSearchHits, formatTagCounts } from "./format.ts";
import { lintCatalog } from "./lint.ts";
import { findReferences, formatReferences } from "./refs.ts";
import { resolveRoots } from "./roots.ts";
import { SearchService } from "./search_service.ts";
import { findDuplicatePairs, formatDuplicatePairs } from "./similar.ts";
import { formatStale, staleReport } from "./stale.ts";
import type { Backend, CatalogData, ResolvedRoot, Scope, Status } from "./types.ts";

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

export const CLI_USAGE =
	"usage: kb <list [--all] | tags | find <tag...> | search <query> [--json] [--limit N] [--status S] [--scope S] [--backend B] [--require-backend] | lint | stale | dups | refs <id> | docs [--check] | bench <fixture.json> [--repeat N] [--backend B]>";

const STATUSES: readonly (Status | "any")[] = ["active", "any", "superseded", "deprecated"];
const BACKENDS: readonly Backend[] = ["lexical", "fts5", "embedding", "hybrid"];

interface SearchArgs {
	query: string;
	json: boolean;
	limit: number;
	status: Status | "any";
	statusWarning: string | null;
	scope: Scope | null;
	scopeWarning: string | null;
	backend: Backend | null;
	backendWarning: string | null;
	requireBackend: boolean;
}

function appendNote(stderr: string, note: string): string {
	if (note === "") return stderr;
	return stderr === "" ? note : `${stderr}\n${note}`;
}

function usageError(stderr: string): CliResult {
	return { code: 2, stdout: "", stderr: appendNote(stderr, CLI_USAGE) };
}

function clampLimit(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : 10;
}

function parseStatus(value: string | undefined): { status: Status | "any"; warning: string | null } {
	if (value === undefined) return { status: "active", warning: null };
	if ((STATUSES as readonly string[]).includes(value)) return { status: value as Status | "any", warning: null };
	return { status: "active", warning: `kb: unknown status ${value}; using active` };
}

function parseScope(value: string | undefined): { scope: Scope | null; warning: string | null } {
	if (value === undefined) return { scope: null, warning: null };
	if (value === "project" || value === "user") return { scope: value, warning: null };
	return { scope: null, warning: `kb: unknown scope ${value}; searching all scopes` };
}

interface ParseState {
	args: SearchArgs;
	words: string[];
}

function applyFlag(state: ParseState, rest: string[], index: number): number {
	const arg = rest[index] ?? "";
	if (arg === "--json") {
		state.args.json = true;
		return index;
	}
	if (arg === "--require-backend") {
		state.args.requireBackend = true;
		return index;
	}
	if (arg === "--limit") {
		state.args.limit = clampLimit(rest[index + 1]);
		return index + 1;
	}
	if (arg === "--status") {
		const parsed = parseStatus(rest[index + 1]);
		state.args.status = parsed.status;
		state.args.statusWarning = parsed.warning;
		return index + 1;
	}
	if (arg === "--scope") {
		const parsed = parseScope(rest[index + 1]);
		state.args.scope = parsed.scope;
		state.args.scopeWarning = parsed.warning;
		return index + 1;
	}
	if (arg === "--backend") {
		const value = rest[index + 1];
		if (value !== undefined && (BACKENDS as readonly string[]).includes(value)) state.args.backend = value as Backend;
		else state.args.backendWarning = `kb: unknown backend ${value ?? ""}; using the configured backend`;
		return index + 1;
	}
	state.words.push(arg);
	return index;
}

function parseSearchArgs(rest: string[]): SearchArgs {
	const state: ParseState = {
		args: {
			query: "",
			json: false,
			limit: 10,
			status: "active",
			statusWarning: null,
			scope: null,
			scopeWarning: null,
			backend: null,
			backendWarning: null,
			requireBackend: false,
		},
		words: [],
	};
	for (let i = 0; i < rest.length; i++) i = applyFlag(state, rest, i);
	state.args.query = state.words.join(" ");
	return state.args;
}

function runList(rest: string[], catalog: CatalogData, roots: ResolvedRoot[], stderr: string): CliResult {
	return { code: 0, stdout: formatCatalog(catalog, roots.length > 1, rest.includes("--all")), stderr };
}

function runFind(rest: string[], catalog: CatalogData, roots: ResolvedRoot[], stderr: string): CliResult {
	const tags = rest.filter((arg) => !arg.startsWith("--"));
	if (tags.length === 0) return usageError(stderr);
	const hits = catalog.entries.filter((entry) => tags.every((tag) => entry.tags.includes(tag)));
	return {
		code: hits.length > 0 ? 0 : 1,
		stdout: formatCatalog({ ...catalog, entries: hits }, roots.length > 1, true),
		stderr,
	};
}

async function runSearch(
	rest: string[],
	roots: ResolvedRoot[],
	config: KnowledgeConfig,
	service: SearchService,
	stderr: string,
): Promise<CliResult> {
	const args = parseSearchArgs(rest);
	if (args.query.trim() === "") return usageError(stderr);
	const requested = args.backend ?? config.search.backend;
	const result = await service.search(
		{ query: args.query, tags: [], status: args.status, scope: args.scope, limit: args.limit },
		requested,
	);
	const notes = [
		result.fallback
			? `kb: backend ${requested} unavailable; used lexical (${result.fallbackReason ?? "unavailable"})`
			: "",
		args.statusWarning ?? "",
		args.scopeWarning ?? "",
		args.backendWarning ?? "",
	]
		.filter((note) => note !== "")
		.join("\n");
	const stdout = args.json ? JSON.stringify(result, null, 2) : formatSearchHits(result.hits, roots.length > 1);
	const code = args.requireBackend && result.fallback ? 3 : 0;
	return { code, stdout, stderr: appendNote(stderr, notes) };
}

function runLint(catalog: CatalogData, roots: ResolvedRoot[], cwd: string, stderr: string): CliResult {
	const issues = lintCatalog(catalog, roots, cwd, new Date());
	return { code: issues.some((issue) => issue.level === "error") ? 1 : 0, stdout: formatIssues(issues), stderr };
}

function runStale(catalog: CatalogData, config: KnowledgeConfig, cwd: string, stderr: string): CliResult {
	return { code: 0, stdout: formatStale(staleReport(catalog, config, cwd, new Date())), stderr };
}

function runDups(catalog: CatalogData, stderr: string): CliResult {
	return { code: 0, stdout: formatDuplicatePairs(findDuplicatePairs(catalog)), stderr };
}

function runRefs(rest: string[], catalog: CatalogData, stderr: string): CliResult {
	const id = rest[0];
	if (id === undefined || id.startsWith("--")) return usageError(stderr);
	return { code: 0, stdout: formatReferences(findReferences(catalog, id), id), stderr };
}

function runDocsCommand(rest: string[], cwd: string, config: KnowledgeConfig, stderr: string): CliResult {
	const outcome = runDocs(cwd, config, rest.includes("--check"));
	return { code: outcome.code, stdout: outcome.stdout, stderr: appendNote(stderr, outcome.stderr) };
}

async function runBenchCommand(
	rest: string[],
	catalog: CatalogData,
	config: KnowledgeConfig,
	cwd: string,
	stderr: string,
): Promise<CliResult> {
	const fixturePath = rest.find((arg) => !arg.startsWith("--"));
	if (fixturePath === undefined) return usageError(stderr);
	const loaded = loadFixtures(cwd, fixturePath);
	if ("error" in loaded) return { code: 2, stdout: "", stderr: appendNote(stderr, `kb bench: ${loaded.error}`) };
	const requested = backendArg(rest);
	const reports = await runBench(
		catalog,
		config,
		loaded.fixtures,
		repeatArg(rest),
		requested === null ? undefined : [requested],
	);
	return { code: 0, stdout: JSON.stringify(reports, null, 2), stderr };
}

export async function execute(argv: string[], cwd: string): Promise<CliResult> {
	const [action = "list", ...rest] = argv;
	const loaded = loadConfig(cwd, true);
	const warnings = [...loaded.warnings];
	const roots = resolveRoots(cwd, loaded.config.roots, warnings);
	const catalog = buildCatalog(roots, warnings);
	const stderr = warnings.map((warning) => `kb: ${warning}`).join("\n");
	const service = new SearchService(catalog, loaded.config);
	const runners: Record<string, () => CliResult | Promise<CliResult>> = {
		list: () => runList(rest, catalog, roots, stderr),
		tags: () => ({ code: 0, stdout: formatTagCounts(catalog), stderr }),
		find: () => runFind(rest, catalog, roots, stderr),
		search: () => runSearch(rest, roots, loaded.config, service, stderr),
		lint: () => runLint(catalog, roots, cwd, stderr),
		stale: () => runStale(catalog, loaded.config, cwd, stderr),
		dups: () => runDups(catalog, stderr),
		refs: () => runRefs(rest, catalog, stderr),
		docs: () => runDocsCommand(rest, cwd, loaded.config, stderr),
		bench: () => runBenchCommand(rest, catalog, loaded.config, cwd, stderr),
	};
	const runner = runners[action];
	return runner ? await runner() : usageError(stderr);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
	void execute(process.argv.slice(2), process.cwd()).then(
		(result) => {
			if (result.stdout) process.stdout.write(`${result.stdout}\n`);
			if (result.stderr) process.stderr.write(result.stderr);
			process.exitCode = result.code;
		},
		(error: unknown) => {
			process.stderr.write(`kb: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 2;
		},
	);
}
