/**
 * Root resolution.
 *
 * Rules (DESIGN.md §5.2):
 * - Paths resolve against cwd; `~` expands.
 * - Display paths (the injected `Roots:` line) must not contain whitespace,
 *   `=`, or `]`; such roots are disabled with a warning.
 * - Nonexistent roots are disabled with a warning.
 * - Contained roots disable the contained side.
 * - One active root per scope, highest priority wins; scopes are project,
 *   user, and team (read-only shared).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedRoot, RootConfig } from "./types.ts";

function displayIsSafe(display: string): boolean {
	return !/[\s=\]]/.test(display);
}

function resolveDir(cwd: string, rootPath: string): string {
	const expanded = rootPath.startsWith("~/") ? path.join(os.homedir(), rootPath.slice(2)) : rootPath;
	if (expanded === "~") return os.homedir();
	return path.resolve(cwd, expanded);
}

function isAncestorOrSame(a: string, b: string): boolean {
	const rel = path.relative(a, b);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveRoots(cwd: string, roots: RootConfig[], warnings: string[]): ResolvedRoot[] {
	const resolved: ResolvedRoot[] = [];
	for (const root of roots) {
		if (!displayIsSafe(root.path)) {
			warnings.push(`knowledge: root path contains unsafe characters for the Roots line: ${root.path}`);
			continue;
		}
		const dir = resolveDir(cwd, root.path);
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
			warnings.push(`knowledge: root is not a directory: ${root.path}`);
			continue;
		}
		resolved.push({ display: root.path, scope: root.scope, dir, priority: root.priority, readonly: root.readonly });
	}

	// Structural dedupe: the contained side loses regardless of priority.
	resolved.sort((a, b) => a.dir.length - b.dir.length);
	const kept: ResolvedRoot[] = [];
	for (const candidate of resolved) {
		const container = kept.find((root) => isAncestorOrSame(root.dir, candidate.dir));
		if (container) {
			warnings.push(`knowledge: root ${candidate.display} is inside ${container.display}; disabling it`);
			continue;
		}
		kept.push(candidate);
	}

	// One root per scope: highest priority wins.
	const byScope = new Map<string, ResolvedRoot>();
	for (const root of kept.sort((a, b) => b.priority - a.priority)) {
		const active = byScope.get(root.scope);
		if (!active) {
			byScope.set(root.scope, root);
			continue;
		}
		warnings.push(`knowledge: only one ${root.scope} root is active; disabling ${root.display}`);
	}
	return [...byScope.values()];
}
