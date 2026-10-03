#!/usr/bin/env node
/**
 * kb CLI: list / tags / find / search / lint.
 *
 * Uses the same config resolution and lint rules as the extension. Exit codes:
 * 0 ok, 1 lint errors or no find hits, 2 usage/config error. Phase 3 adds
 * backend selection and exit 3 for a required backend that is unavailable.
 */

import { pathToFileURL } from "node:url";
import { buildCatalog } from "./catalog.ts";
import { type KnowledgeConfig, loadConfig } from "./config.ts";
import { lintCatalog } from "./lint.ts";
import { renderLine } from "./render.ts";
import { resolveRoots } from "./roots.ts";
import { searchCatalog } from "./search.ts";
import type { CatalogData, ResolvedRoot, Status } from "./types.ts";

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

export const CLI_USAGE =
	"usage: kb <list [--all] | tags | find <tag...> | search <query> [--json] [--limit N] [--status S] | lint>";

const STATUSES: readonly (Status | "any")[] = ["active", "any", "superseded", "deprecated"];

interface SearchArgs {
	query: string;
	json: boolean;
	limit: number;
	status: Status | "any";
}

function entryLines(catalog: CatalogData, roots: ResolvedRoot[], all: boolean): string[] {
	const multi = roots.length > 1;
	return catalog.entries
		.filter((entry) => all || entry.status === "active")
		.map((entry) => renderLine(entry, multi, "full"));
}

function tagCounts(catalog: CatalogData): string {
	const counts = new Map<string, number>();
	for (const entry of catalog.entries) {
		for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([tag, count]) => `${tag}\t${count}`)
		.join("\n");
}

function usageError(stderr: string): CliResult {
	return { code: 2, stdout: "", stderr: appendNote(stderr, CLI_USAGE) };
}

function appendNote(stderr: string, note: string): string {
	if (note === "") return stderr;
	return stderr === "" ? note : `${stderr}\n${note}`;
}

function clampLimit(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : 10;
}

function parseStatus(value: string | undefined): Status | "any" {
	if (value !== undefined && (STATUSES as readonly string[]).includes(value)) return value as Status | "any";
	return "active";
}

function parseSearchArgs(rest: string[]): SearchArgs {
	const args: SearchArgs = { query: "", json: false, limit: 10, status: "active" };
	const words: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i] ?? "";
		if (arg === "--json") args.json = true;
		else if (arg === "--limit") {
			args.limit = clampLimit(rest[i + 1]);
			i++;
		} else if (arg === "--status") {
			args.status = parseStatus(rest[i + 1]);
			i++;
		} else words.push(arg);
	}
	args.query = words.join(" ");
	return args;
}

function runList(rest: string[], catalog: CatalogData, roots: ResolvedRoot[], stderr: string): CliResult {
	return { code: 0, stdout: entryLines(catalog, roots, rest.includes("--all")).join("\n"), stderr };
}

function runFind(rest: string[], catalog: CatalogData, roots: ResolvedRoot[], stderr: string): CliResult {
	const tags = rest.filter((arg) => !arg.startsWith("--"));
	if (tags.length === 0) return usageError(stderr);
	const hits = catalog.entries.filter((entry) => tags.every((tag) => entry.tags.includes(tag)));
	const multi = roots.length > 1;
	return {
		code: hits.length > 0 ? 0 : 1,
		stdout: hits.map((entry) => renderLine(entry, multi, "full")).join("\n"),
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
		{ query: args.query, tags: [], status: args.status, scope: null, limit: args.limit },
		config,
	);
	const note = result.fallback ? `kb: backend ${config.search.backend} unavailable; used lexical` : "";
	if (args.json) return { code: 0, stdout: JSON.stringify(result, null, 2), stderr: appendNote(stderr, note) };
	const lines = result.hits.map((hit) => {
		const label = roots.length > 1 ? `${hit.scope}:${hit.id}` : hit.id;
		const when = hit.when.length > 0 ? ` — ${hit.when.join(" / ")}` : "";
		return `${label}  ${hit.title}${when}\n  path: ${hit.path}`;
	});
	return { code: 0, stdout: lines.join("\n"), stderr: appendNote(stderr, note) };
}

function runLint(catalog: CatalogData, roots: ResolvedRoot[], cwd: string, stderr: string): CliResult {
	const issues = lintCatalog(catalog, roots, cwd, new Date());
	const text = issues.map((issue) => `${issue.level}\t${issue.path}: ${issue.message}`).join("\n");
	return { code: issues.some((issue) => issue.level === "error") ? 1 : 0, stdout: text, stderr };
}

export function execute(argv: string[], cwd: string): CliResult {
	const [action = "list", ...rest] = argv;
	const loaded = loadConfig(cwd, true);
	const warnings = [...loaded.warnings];
	const roots = resolveRoots(cwd, loaded.config.roots, warnings);
	const catalog = buildCatalog(roots, warnings);
	const stderr = warnings.map((warning) => `kb: ${warning}`).join("\n");
	switch (action) {
		case "list":
			return runList(rest, catalog, roots, stderr);
		case "tags":
			return { code: 0, stdout: tagCounts(catalog), stderr };
		case "find":
			return runFind(rest, catalog, roots, stderr);
		case "search":
			return runSearch(rest, catalog, roots, loaded.config, stderr);
		case "lint":
			return runLint(catalog, roots, cwd, stderr);
		default:
			return usageError(stderr);
	}
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
	const result = execute(process.argv.slice(2), process.cwd());
	if (result.stdout) process.stdout.write(`${result.stdout}\n`);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exitCode = result.code;
}
