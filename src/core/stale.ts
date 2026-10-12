/**
 * Staleness checks: `review_after` overdue entries and entries whose last Git
 * change is older than `stale.days`. Non-Git repos and shallow clones are
 * skipped with a warning (DESIGN.md §11.3).
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { KnowledgeConfig } from "./config.ts";
import type { CatalogData, EntryRecord } from "./types.ts";

interface StaleEntry {
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

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

/** One `git log` pass: repo-relative path -> newest commit timestamp (seconds). */
function gitDates(cwd: string): Map<string, number> | null {
	const result = spawnSync("git", ["log", "--format=%ct", "--name-only"], {
		cwd,
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) return null;
	const dates = new Map<string, number>();
	let current = 0;
	for (const line of (result.stdout ?? "").split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		if (/^\d+$/.test(trimmed)) {
			current = Number(trimmed);
			continue;
		}
		if (current > 0 && !dates.has(trimmed)) dates.set(trimmed, current);
	}
	return dates;
}

function reviewAfterStale(entry: EntryRecord, today: string): StaleEntry | null {
	if (entry.reviewAfter === null || entry.reviewAfter >= today) return null;
	return { entry, reason: "review_after", detail: entry.reviewAfter };
}

function gitStale(
	entry: EntryRecord,
	cwd: string,
	dates: Map<string, number> | null,
	cutoffSeconds: number,
): StaleEntry | null {
	if (dates === null) return null;
	const timestamp = dates.get(toPosix(path.relative(cwd, entry.path))) ?? null;
	if (timestamp === null || timestamp >= cutoffSeconds) return null;
	return { entry, reason: "git_date", detail: new Date(timestamp * 1000).toISOString().slice(0, 10) };
}

export function staleReport(catalog: CatalogData, config: KnowledgeConfig, cwd: string, now: Date): StaleReport {
	const today = now.toISOString().slice(0, 10);
	const cutoffSeconds = Math.floor((now.getTime() - config.stale.days * 86_400_000) / 1000);
	const state = gitState(cwd);
	const dates = state.datesAvailable ? gitDates(cwd) : null;
	const warnings = state.warning === null ? [] : [state.warning];
	if (state.datesAvailable && dates === null) warnings.push("git log failed; git dates skipped");
	const entries: StaleEntry[] = [];
	for (const entry of catalog.entries) {
		if (entry.status !== "active") continue;
		const stale = reviewAfterStale(entry, today) ?? gitStale(entry, cwd, dates, cutoffSeconds);
		if (stale !== null) entries.push(stale);
	}
	return { entries, warnings };
}

export function formatStale(report: StaleReport): string {
	const lines = report.entries.map(
		({ entry, reason, detail }) => `${entry.id}  ${entry.title}  (${reason}: ${detail})`,
	);
	return [...lines, ...report.warnings].join("\n");
}
