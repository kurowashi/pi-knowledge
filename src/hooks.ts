/**
 * Write/edit planning for the hooks.
 *
 * The plugin never writes files itself. It patches `input.path` to a canonical
 * `<root>/<id>.md`, blocks data-losing operations, and validates prospective
 * content. Paths outside the configured roots and non-`.md` files are never
 * touched (DESIGN.md §6, §7).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ID_PATTERN, parseEntryText } from "./catalog.ts";
import { validateEntry } from "./lint.ts";
import type { CatalogData, Issue, ResolvedRoot } from "./types.ts";

export interface HookContext {
	cwd: string;
	roots: ResolvedRoot[];
	catalog: CatalogData;
	enforce: "block" | "warn";
	now: Date;
}

export interface HookOutcome {
	allow: boolean;
	/** Canonical path when the write was normalized. */
	path?: string;
	reason?: string;
	notes: string[];
}

export interface KnowledgeTarget {
	root: ResolvedRoot;
	id: string;
	nested: boolean;
}

export function findKnowledgeTarget(filePath: string, cwd: string, roots: ResolvedRoot[]): KnowledgeTarget | null {
	if (!filePath.endsWith(".md")) return null;
	const abs = path.resolve(cwd, filePath);
	for (const root of roots) {
		const rel = path.relative(root.dir, abs);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
		return { root, id: path.basename(abs, ".md"), nested: rel.includes(path.sep) };
	}
	return null;
}

function generateId(root: ResolvedRoot, catalog: CatalogData): string | null {
	for (let attempt = 0; attempt < 10; attempt++) {
		const id = crypto.randomBytes(4).toString("hex");
		if (!fs.existsSync(path.join(root.dir, `${id}.md`)) && !catalog.byId.has(id)) return id;
	}
	return null;
}

function block(reason: string, notes: string[] = []): HookOutcome {
	return { allow: false, reason: `knowledge: ${reason}`, notes };
}

function notesFrom(issues: Issue[]): string[] {
	return issues.map((issue) => `${issue.level}: ${issue.message}`);
}

export function applyEdits(text: string, edits: Array<{ oldText: string; newText: string }>): string | null {
	let current = text;
	for (const edit of edits) {
		const index = current.indexOf(edit.oldText);
		if (index === -1) return null;
		current = current.slice(0, index) + edit.newText + current.slice(index + edit.oldText.length);
	}
	return current;
}

export function planWrite(input: { path: string; content: string }, ctx: HookContext): HookOutcome {
	const target = findKnowledgeTarget(input.path, ctx.cwd, ctx.roots);
	if (!target) return { allow: true, notes: [] };
	if (target.root.readonly) return block(`root ${target.root.display} is read-only`);

	const existing = path.join(target.root.dir, `${target.id}.md`);
	if (!target.nested && fs.existsSync(existing)) return block("entry exists; use edit to update it");

	let id = target.id;
	if (target.nested || !ID_PATTERN.test(id) || ctx.catalog.byId.has(id)) {
		const generated = generateId(target.root, ctx.catalog);
		if (generated === null) return block("could not allocate a new id after 10 attempts");
		id = generated;
	}
	const newPath = path.join(target.root.dir, `${id}.md`);
	const rewritten = path.isAbsolute(input.path) ? newPath : path.relative(ctx.cwd, newPath);
	const parsed = parseEntryText(input.content, id, target.root, newPath, 0, input.content.length);
	if (parsed.entry === null) return finish([parsed.invalid ?? "invalid entry"], [], ctx);
	const issues = validateEntry(parsed.entry, ctx.catalog, ctx.roots, ctx.cwd, ctx.now);
	return finish([], issues, ctx, rewritten);
}

export function planEdit(
	input: { path: string; edits: Array<{ oldText: string; newText: string }> },
	ctx: HookContext,
): HookOutcome {
	const target = findKnowledgeTarget(input.path, ctx.cwd, ctx.roots);
	if (!target || target.nested) return { allow: true, notes: [] };
	if (target.root.readonly) return block(`root ${target.root.display} is read-only`);

	const winner = ctx.catalog.byId.get(target.id);
	if (winner && winner.dir !== target.root.dir) return block(`id ${target.id} is shadowed by another root`);

	const abs = path.resolve(ctx.cwd, input.path);
	let text: string;
	try {
		text = fs.readFileSync(abs, "utf8");
	} catch {
		return { allow: true, notes: [] };
	}
	const prospective = applyEdits(text, input.edits);
	if (prospective === null) return { allow: true, notes: [] };

	const parsed = parseEntryText(prospective, target.id, target.root, abs, 0, prospective.length);
	if (parsed.entry === null) return finish([parsed.invalid ?? "invalid entry"], [], ctx);
	const issues = validateEntry(parsed.entry, ctx.catalog, ctx.roots, ctx.cwd, ctx.now);
	return finish([], issues, ctx);
}

function finish(errors: string[], issues: Issue[], ctx: HookContext, pathRewrite?: string): HookOutcome {
	const warnings = notesFrom(issues);
	if (errors.length > 0 && ctx.enforce === "block") return block(errors.join("; "), warnings);
	const notes = [...errors.map((error) => `error: ${error}`), ...warnings];
	return { allow: true, ...(pathRewrite !== undefined ? { path: pathRewrite } : {}), notes };
}
