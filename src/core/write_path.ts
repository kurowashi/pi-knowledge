/**
 * The one refused write operation.
 *
 * Content is never validated before it lands on disk (DESIGN.md §7): a `write`
 * onto an existing entry path would destroy an entry that lint and CI cannot
 * report as missing, so that is the only operation refused. Update with `edit`.
 *
 * The plugin never writes files itself. It reads the prospective path, decides,
 * and returns the reason; the host's own write tool does the write.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Enforce, ResolvedRoot } from "./types.ts";

export interface WriteContext {
	cwd: string;
	roots: ResolvedRoot[];
	enforce: Enforce;
}

export interface WriteOutcome {
	allow: boolean;
	/** Refusal message. Absent when allowed. */
	reason?: string;
	/** Advisory notes to show after the write when `enforce` is `warn`. */
	notes: string[];
}

export interface KnowledgeTarget {
	root: ResolvedRoot;
	id: string;
	nested: boolean;
}

/** The knowledge root a path belongs to, or null when it is not an entry path. */
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

function refuse(reason: string): WriteOutcome {
	return { allow: false, reason: `knowledge: ${reason}`, notes: [] };
}

export function planWrite(input: { path: string }, ctx: WriteContext): WriteOutcome {
	const target = findKnowledgeTarget(input.path, ctx.cwd, ctx.roots);
	if (!target || target.nested) return { allow: true, notes: [] };
	if (target.root.readonly) return refuse(`root ${target.root.display} is read-only`);

	const existing = path.join(target.root.dir, `${target.id}.md`);
	if (!fs.existsSync(existing)) return { allow: true, notes: [] };

	const reason = `entry ${target.id} already exists; use edit to update it (DESIGN.md §7.1)`;
	if (ctx.enforce === "block") return refuse(reason);
	return { allow: true, notes: [`warning: ${reason}`] };
}
