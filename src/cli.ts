#!/usr/bin/env node
/**
 * kb CLI: list / tags / find / search / lint / stale / dups / refs / docs / bench.
 *
 * Uses the same config resolution, lint rules, and catalog as the extension.
 * Exit codes: 0 ok, 1 lint errors / no find hits / docs drift, 2 usage/config
 * or docs read/write error, 3 a required backend is unavailable (Phase 3).
 */

import { pathToFileURL } from "node:url";
import { loadFixtures, repeatArg, runBench } from "./bench.ts";
import { buildCatalog } from "./catalog.ts";
import { type KnowledgeConfig, loadConfig } from "./config.ts";
import { runDocs } from "./docs.ts";
import { formatCatalog, formatIssues, formatSearchHits, formatTagCounts } from "./format.ts";
import { lintCatalog } from "./lint.ts";
import { findReferences, formatReferences } from "./refs.ts";
import { resolveRoots } from "./roots.ts";
import { searchCatalog } from "./search.ts";
import { findDuplicatePairs, formatDuplicatePairs } from "./similar.ts";
import { formatStale, staleReport } from "./stale.ts";
import type { CatalogData, ResolvedRoot, Scope, Status } from "./types.ts";

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

export const CLI_USAGE =
	"usage: kb <list [--all] | tags | find <tag...> | search <query> [--json] [--limit N] [--status S] [--scope S] | lint | stale | dups | refs <id> | docs [--check] | bench <fixture.json> [--repeat N]>";

const STATUSES: readonly (Status | "any")[] = ["active", "any", "superseded", "deprecated"];

interface SearchArgs {
	query: string;
	json: boolean;
	limit: number;
	status: Status | "any";
	scope: Scope | null;
	statusWarning: string | null;
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

function parseScope(value: string | undefined): Scope | null {
	return value === "project" || value === "user" ? value : null;
}

function parseSearchArgs(rest: string[]): SearchArgs {
	const args: SearchArgs = { query: "", json: false, limit: 10, status: "active", scope: null, statusWarning: null };
	const words: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i] ?? "";
		if (arg === "--json") args.json = true;
		else if (arg === "--limit") {
			args.limit = clampLimit(rest[i + 1]);
			i++;
		} else if (arg === "--status") {
			const parsed = parseStatus(rest[i + 1]);
			args.status = parsed.status;
			args.statusWarning = parsed.warning;
			i++;
		} else if (arg === "--scope") {
			args.scope = parseScope(rest[i + 1]);
			i++;
		} else words.push(arg);
	}
	args.query = words.join(" ");
	return args;
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

function runSearch(
	rest: string[],
	catalog: CatalogData,
	roots: ResolvedRoot[],
	config: KnowledgeConfig,
	stderr: string,
): CliResult {
	const args = parseSearchArgs(rest);
	if (args.query.trim() === "") return usageError(stderr);
	const result = searchCatalog(
		catalog,
		{ query: args.query, tags: [], status: args.status, scope: args.scope, limit: args.limit },
		config,
	);
	const notes = [
		result.fallback ? `kb: backend ${config.search.backend} unavailable; used lexical` : "",
		args.statusWarning ?? "",
	]
		.filter((note) => note !== "")
		.join("\n");
	const stdout = args.json ? JSON.stringify(result, null, 2) : formatSearchHits(result.hits, roots.length > 1);
	return { code: 0, stdout, stderr: appendNote(stderr, notes) };
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

function runBenchCommand(
	rest: string[],
	catalog: CatalogData,
	config: KnowledgeConfig,
	cwd: string,
	stderr: string,
): CliResult {
	const fixturePath = rest.find((arg) => !arg.startsWith("--"));
	if (fixturePath === undefined) return usageError(stderr);
	const loaded = loadFixtures(cwd, fixturePath);
	if ("error" in loaded) return { code: 2, stdout: "", stderr: appendNote(stderr, `kb bench: ${loaded.error}`) };
	const report = runBench(catalog, config, loaded.fixtures, repeatArg(rest));
	return { code: 0, stdout: JSON.stringify(report, null, 2), stderr };
}

export function execute(argv: string[], cwd: string): CliResult {
	const [action = "list", ...rest] = argv;
	const loaded = loadConfig(cwd, true);
	const warnings = [...loaded.warnings];
	const roots = resolveRoots(cwd, loaded.config.roots, warnings);
	const catalog = buildCatalog(roots, warnings);
	const stderr = warnings.map((warning) => `kb: ${warning}`).join("\n");
	const runners: Record<string, () => CliResult> = {
		list: () => runList(rest, catalog, roots, stderr),
		tags: () => ({ code: 0, stdout: formatTagCounts(catalog), stderr }),
		find: () => runFind(rest, catalog, roots, stderr),
		search: () => runSearch(rest, catalog, roots, loaded.config, stderr),
		lint: () => runLint(catalog, roots, cwd, stderr),
		stale: () => runStale(catalog, loaded.config, cwd, stderr),
		dups: () => runDups(catalog, stderr),
		refs: () => runRefs(rest, catalog, stderr),
		docs: () => runDocsCommand(rest, cwd, loaded.config, stderr),
		bench: () => runBenchCommand(rest, catalog, loaded.config, cwd, stderr),
	};
	const runner = runners[action];
	return runner ? runner() : usageError(stderr);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
	const result = execute(process.argv.slice(2), process.cwd());
	if (result.stdout) process.stdout.write(`${result.stdout}\n`);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exitCode = result.code;
}
