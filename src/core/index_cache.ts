/**
 * Session-to-session index cache.
 *
 * The fingerprint covers the catalog files (path, mtime, size) plus a backend
 * variant string (for example the embedding model), so a cache is reused only
 * while the corpus and backend parameters are unchanged. All cache operations
 * are fail-open: a missing or unreadable cache just means a rebuild.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CatalogData } from "./types.ts";

export function fingerprintCatalog(catalog: CatalogData, variant: string): string {
	const hash = crypto.createHash("sha256");
	hash.update(variant);
	for (const entry of catalog.entries) {
		hash.update(`${entry.path}\n${entry.mtimeMs}\n${entry.size}\n`);
	}
	return hash.digest("hex");
}

export function readJsonCache<T>(file: string): T | null {
	try {
		if (!fs.existsSync(file)) return null;
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

/** Write a JSON cache file; returns a warning string when the write fails. */
export function writeJsonCache(file: string, value: unknown): string | null {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(value));
		return null;
	} catch (error) {
		return `knowledge: cannot write cache ${file}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
