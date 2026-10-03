/**
 * Document index generation (`kb docs`).
 *
 * One line per file: `<repo-relative path> — <first # heading within 20 lines>`.
 * Binary files, dotfiles, node_modules, and symlinks are skipped. The index is
 * never injected into the system prompt; it exists for `read` discovery and CI
 * drift checks (DESIGN.md §12).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { KnowledgeConfig } from "./config.ts";

const MAX_DESCRIPTION = 120;
const BINARY_SNIFF_BYTES = 8192;
const HEADING_SCAN_LINES = 20;
const MAX_FAILURE_RATIO = 0.1;
const MAX_DEPTH = 32;

export interface DocsBuild {
	text: string;
	count: number;
	matched: number;
	failures: number;
	warnings: string[];
}

export interface DocsOutcome {
	code: number;
	stdout: string;
	stderr: string;
}

interface GlobChar {
	source: string;
	skipNext: boolean;
}

function globChar(char: string, next: string | undefined): GlobChar | null {
	const code = char.codePointAt(0) ?? 0;
	if (code < 32) return null;
	if (char === "*") return next === "*" ? { source: ".*", skipNext: true } : { source: "[^/]*", skipNext: false };
	if (char === "?") return { source: "[^/]", skipNext: false };
	return { source: /[A-Za-z0-9/_-]/.test(char) ? char : `\\${char}`, skipNext: false };
}

export function globToRegExp(pattern: string): RegExp | null {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const part = globChar(pattern[i] ?? "", pattern[i + 1]);
		if (part === null) return null;
		source += part.source;
		if (part.skipNext) i++;
	}
	try {
		return new RegExp(`^${source}$`);
	} catch {
		return null;
	}
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function appendNote(stderr: string, note: string): string {
	if (note === "") return stderr;
	return stderr === "" ? note : `${stderr}\n${note}`;
}

function compilePatterns(patterns: string[], label: string, warnings: string[]): RegExp[] {
	const compiled: RegExp[] = [];
	for (const pattern of patterns) {
		const regex = globToRegExp(pattern);
		if (regex === null) warnings.push(`kb docs: invalid ${label} pattern: ${pattern}`);
		else compiled.push(regex);
	}
	return compiled;
}

function isIncluded(rel: string, include: RegExp[], exclude: RegExp[]): boolean {
	return include.some((regex) => regex.test(rel)) && !exclude.some((regex) => regex.test(rel));
}

function readSniff(file: string): { text: string; binary: boolean } | null {
	let fd: number | null = null;
	try {
		fd = fs.openSync(file, "r");
		const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
		const bytes = fs.readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0);
		const slice = buffer.subarray(0, bytes);
		return { text: slice.toString("utf8"), binary: slice.includes(0) };
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				// The file may already be closed; nothing else to do.
			}
		}
	}
}

function sanitize(value: string): string {
	let out = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 32 && code !== 127) out += char;
	}
	return out;
}

function descriptionOf(text: string): string {
	let inFence = false;
	for (const line of text.split(/\r?\n/).slice(0, HEADING_SCAN_LINES)) {
		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence || !line.trimStart().startsWith("#")) continue;
		const cleaned = sanitize(line.replace(/^#+\s*/, "")).trim();
		if (cleaned === "") return "";
		return cleaned.length <= MAX_DESCRIPTION ? cleaned : `${cleaned.slice(0, MAX_DESCRIPTION - 1)}…`;
	}
	return "";
}

interface WalkState {
	entries: Array<{ rel: string; description: string }>;
	warnings: string[];
	matched: number;
	failures: number;
}

function considerFile(
	full: string,
	rel: string,
	include: RegExp[],
	exclude: RegExp[],
	skip: Set<string>,
	state: WalkState,
): void {
	if (skip.has(rel) || !isIncluded(rel, include, exclude)) return;
	state.matched++;
	const sniffed = readSniff(full);
	if (sniffed === null) {
		state.warnings.push(`kb docs: cannot read ${rel}`);
		state.failures++;
		return;
	}
	if (sniffed.binary) return;
	state.entries.push({ rel, description: descriptionOf(sniffed.text) });
}

function walkDirectory(
	dir: string,
	root: string,
	include: RegExp[],
	exclude: RegExp[],
	skip: Set<string>,
	state: WalkState,
	depth: number,
): void {
	if (depth > MAX_DEPTH) {
		state.warnings.push(`kb docs: max depth reached at ${dir}`);
		return;
	}
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		state.warnings.push(`kb docs: cannot read ${dir}: ${message(error)}`);
		state.failures++;
		return;
	}
	for (const dirent of dirents) {
		if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
		const full = path.join(dir, dirent.name);
		if (dirent.isSymbolicLink()) continue;
		if (dirent.isDirectory()) {
			walkDirectory(full, root, include, exclude, skip, state, depth + 1);
			continue;
		}
		if (!dirent.isFile()) continue;
		considerFile(full, toPosix(path.relative(root, full)), include, exclude, skip, state);
	}
}

export function buildDocumentIndex(repoRoot: string, config: KnowledgeConfig): DocsBuild {
	const warnings: string[] = [];
	const include = compilePatterns(config.docs.include, "include", warnings);
	const exclude = compilePatterns(config.docs.exclude, "exclude", warnings);
	const generated = toPosix(path.relative(repoRoot, path.resolve(repoRoot, config.docs.path)));
	const state: WalkState = { entries: [], warnings, matched: 0, failures: 0 };
	walkDirectory(repoRoot, repoRoot, include, exclude, new Set([generated]), state, 0);
	state.entries.sort((a, b) => a.rel.localeCompare(b.rel));
	let lines = state.entries.map((entry) =>
		entry.description === "" ? entry.rel : `${entry.rel} — ${entry.description}`,
	);
	if (lines.length > config.docs.maxLines) {
		const kept = lines.slice(0, Math.max(0, config.docs.maxLines - 1));
		kept.push(`… (${lines.length - kept.length} more)`);
		lines = kept;
	}
	return {
		text: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
		count: state.entries.length,
		matched: state.matched,
		failures: state.failures,
		warnings,
	};
}

export function runDocs(repoRoot: string, config: KnowledgeConfig, check: boolean): DocsOutcome {
	const build = buildDocumentIndex(repoRoot, config);
	const stderr = build.warnings.join("\n");
	if (build.matched > 0 && build.failures / build.matched > MAX_FAILURE_RATIO) {
		return {
			code: 2,
			stdout: "",
			stderr: appendNote(stderr, `kb docs: too many read failures (${build.failures}/${build.matched})`),
		};
	}
	if (build.count === 0) return { code: 0, stdout: "kb docs: no documents matched", stderr };
	const target = path.resolve(repoRoot, config.docs.path);
	if (check) {
		let existing: string | null = null;
		try {
			existing = fs.readFileSync(target, "utf8");
		} catch {
			existing = null;
		}
		if (existing === null) {
			return { code: 1, stdout: "kb docs: index is missing", stderr: appendNote(stderr, "run kb docs to regenerate") };
		}
		if (existing !== build.text) {
			return {
				code: 1,
				stdout: "kb docs: index differs from the tree",
				stderr: appendNote(stderr, "run kb docs to regenerate"),
			};
		}
		return { code: 0, stdout: `kb docs: up to date (${build.count} documents)`, stderr };
	}
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, build.text);
	} catch (error) {
		return {
			code: 2,
			stdout: "",
			stderr: appendNote(stderr, `kb docs: cannot write ${config.docs.path}: ${message(error)}`),
		};
	}
	return { code: 0, stdout: `kb docs: wrote ${config.docs.path} (${build.count} documents)`, stderr };
}
