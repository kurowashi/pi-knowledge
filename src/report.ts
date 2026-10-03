/**
 * `/kb` subcommand output. Shared logic lives here so the extension stays a
 * thin adapter and the CLI and command surfaces use the same formatters.
 */

import { backendArg, loadFixtures, repeatArg, runBench } from "./bench.ts";
import type { KnowledgeConfig } from "./config.ts";
import { runDocs } from "./docs.ts";
import { formatCatalog, formatIssues, formatTagCounts } from "./format.ts";
import { lintCatalog } from "./lint.ts";
import { findReferences, formatReferences } from "./refs.ts";
import { findDuplicatePairs, formatDuplicatePairs } from "./similar.ts";
import { formatStale, staleReport } from "./stale.ts";
import type { CatalogData, ResolvedRoot } from "./types.ts";

export interface ReportContext {
	catalog: CatalogData | null;
	config: KnowledgeConfig | null;
	roots: ResolvedRoot[];
	cwd: string;
	now: Date;
	/** Extension-supplied status text (includes injected-index state). */
	status: () => string | null;
	/** Extension-supplied search output (uses the session catalog). */
	search: (rest: string[]) => Promise<string | null>;
}

export async function commandReport(action: string, rest: string[], ctx: ReportContext): Promise<string | null> {
	const { catalog, config } = ctx;
	if (catalog === null || config === null) return null;
	const handlers: Record<string, () => string | null | Promise<string | null>> = {
		status: () => ctx.status(),
		lint: () => formatIssues(lintCatalog(catalog, ctx.roots, ctx.cwd, ctx.now)) || "no issues",
		list: () => formatCatalog(catalog, ctx.roots.length > 1, false) || "no entries",
		tags: () => formatTagCounts(catalog) || "no tags",
		find: () => {
			const entries = catalog.entries.filter(
				(entry) => entry.status === "active" && rest.every((tag) => entry.tags.includes(tag)),
			);
			return formatCatalog({ ...catalog, entries }, ctx.roots.length > 1, true) || "no matches";
		},
		search: () => ctx.search(rest),
		stale: () => formatStale(staleReport(catalog, config, ctx.cwd, ctx.now)) || "no stale entries",
		dups: () => formatDuplicatePairs(findDuplicatePairs(catalog)) || "no duplicates",
		refs: () => {
			const id = rest[0];
			if (id === undefined) return "usage: /kb refs <id>";
			return formatReferences(findReferences(catalog, id), id) || "no references";
		},
		docs: () => {
			const outcome = runDocs(ctx.cwd, config, rest.includes("--check"));
			return [outcome.stdout, outcome.stderr].filter((line) => line !== "").join("\n") || "kb docs: done";
		},
		bench: async () => {
			const fixturePath = rest.find((arg) => !arg.startsWith("--"));
			if (fixturePath === undefined) return "usage: /kb bench <fixture.json> [--repeat N]";
			const loaded = loadFixtures(ctx.cwd, fixturePath);
			if ("error" in loaded) return `kb bench: ${loaded.error}`;
			const requested = backendArg(rest);
			const reports = await runBench(
				catalog,
				config,
				loaded.fixtures,
				repeatArg(rest),
				requested === null ? undefined : [requested],
			);
			return JSON.stringify(reports, null, 2);
		},
	};
	const handler = handlers[action];
	return handler ? await handler() : null;
}
