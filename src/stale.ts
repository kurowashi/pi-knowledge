/**
 * Staleness checks: `review_after` overdue entries and entries whose last Git
 * change is older than `stale.days`. Non-Git repos and shallow clones are
 * skipped with a warning (DESIGN.md §11.3).
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { KnowledgeConfig } from "./config.ts";
import type { CatalogData, EntryRecord } from "./types.ts";

export interface StaleEntry {
	entry: EntryRecord;
	reason: "review_after" | "git_date";
	detail: string;
}

export interface StaleReport {
	entries: StaleEntry[];
	warnings: string[];
}

interface GitState {
	datesAvailable: boolean;
	warning: string | null;
}

function gitState(cwd: string): GitState {
	const version = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000 });
	if (version.error || version.status !== 0)
		return { datesAvailable: false, warning: "git is not available; git dates skipped" };
	const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", timeout: 5000 });
	if (inside.status !== 0 || (inside.stdout ?? "").trim() !== "true") {
		return { datesAvailable: false, warning: "not a git repository; git dates skipped" };
	}
	const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd, encoding: "utf8", timeout: 5000 });
	if ((shallow.stdout ?? "").trim() === "true") {
		return { datesAvailable: false, warning: "shallow clone; git dates skipped" };
	}
	return { datesAvailable: true, warning: null };
}

function gitTimestamp(cwd: string, file: string): number | null {
	const relative = path.relative(cwd, file);
	const result = spawnSync("git", ["log", "-1", "--format=%ct", "--", relative], {
		cwd,
		encoding: "utf8",
		timeout: 5000,
	});
	if (result.error || result.status !== 0) return null;
	const value = Number((result.stdout ?? "").trim());
	return Number.isFinite(value) && value > 0 ? value : null;
}

export function staleReport(catalog: CatalogData, config: KnowledgeConfig, cwd: string, now: Date): StaleReport {
	const today = now.toISOString().slice(0, 10);
	const cutoffSeconds = Math.floor((now.getTime() - config.stale.days * 86_400_000) / 1000);
	const state = gitState(cwd);
	const entries: StaleEntry[] = [];
	for (const entry of catalog.entries) {
		if (entry.status !== "active") continue;
		if (entry.reviewAfter !== null && entry.reviewAfter < today) {
			entries.push({ entry, reason: "review_after", detail: entry.reviewAfter });
			continue;
		}
		if (!state.datesAvailable) continue;
		const timestamp = gitTimestamp(cwd, entry.path);
		if (timestamp !== null && timestamp < cutoffSeconds) {
			entries.push({ entry, reason: "git_date", detail: new Date(timestamp * 1000).toISOString().slice(0, 10) });
		}
	}
	return { entries, warnings: state.warning === null ? [] : [state.warning] };
}

export function formatStale(report: StaleReport): string {
	const lines = report.entries.map(
		({ entry, reason, detail }) => `${entry.id}  ${entry.title}  (${reason}: ${detail})`,
	);
	return [...lines, ...report.warnings].join("\n");
}
