/**
 * Config discovery, merge, and validation.
 *
 * Files merge nearest-last: the global config at
 * `$PI_CODING_AGENT_DIR/knowledge.json` (or `~/.pi/agent/knowledge.json`) is
 * read first, then the project config at `<cwd>/.pi/knowledge.json` overrides
 * it key by key. Project configs are ignored when the project is not trusted.
 *
 * Unknown keys are ignored and invalid values fall back to the default with a
 * warning, so a broken config never breaks a session.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Backend, Enforce, RootConfig, Scope } from "./types.ts";

interface InjectionConfig {
	enabled: boolean;
	maxTokens: number;
	floorTokens: number;
	contextFraction: number;
}

export interface EmbeddingConfig {
	endpoint: string;
	model: string;
	apiKeyEnv: string;
	timeoutMs: number;
}

interface SearchConfig {
	backend: Backend;
	embedding: EmbeddingConfig;
}

interface CaptureConfig {
	mode: "off" | "manual";
}

interface DocsConfig {
	path: string;
	include: string[];
	exclude: string[];
	maxLines: number;
}

export interface KnowledgeConfig {
	enabled: boolean;
	roots: RootConfig[];
	injection: InjectionConfig;
	recall: { mode: "off" | "hint" };
	search: SearchConfig;
	capture: CaptureConfig;
	write: { enforce: Enforce };
	docs: DocsConfig;
	stale: { days: number };
	cache: { enabled: boolean };
}

const CONFIG_FILE_NAME = "knowledge.json";

export const DEFAULT_CONFIG: KnowledgeConfig = {
	enabled: true,
	roots: [{ path: "knowledge", scope: "project", priority: 100, readonly: false }],
	injection: { enabled: true, maxTokens: 4000, floorTokens: 1000, contextFraction: 0.02 },
	recall: { mode: "off" },
	search: {
		backend: "lexical",
		embedding: { endpoint: "", model: "", apiKeyEnv: "", timeoutMs: 5000 },
	},
	capture: { mode: "manual" },
	write: { enforce: "block" },
	docs: { path: "docs/INDEX.md", include: ["docs/**"], exclude: [], maxLines: 500 },
	stale: { days: 365 },
	cache: { enabled: true },
};

function agentDir(): string {
	const override = process.env["PI_CODING_AGENT_DIR"]?.trim();
	return override && override.length > 0 ? override : path.join(os.homedir(), ".pi", "agent");
}

export function globalConfigPath(): string {
	return path.join(agentDir(), CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", CONFIG_FILE_NAME);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive merge for plain objects; arrays and scalars replace. */
export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const prev = out[key];
		out[key] = isObject(prev) && isObject(value) ? deepMerge(prev, value) : value;
	}
	return out;
}

function boolOr(value: unknown, key: string, fallback: boolean, warnings: string[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warnings.push(`knowledge: ${key} must be a boolean; using ${fallback}`);
	return fallback;
}

function positiveIntOr(value: unknown, key: string, fallback: number, warnings: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	warnings.push(`knowledge: ${key} must be a positive number; using ${fallback}`);
	return fallback;
}

function stringOr(value: unknown, key: string, fallback: string, warnings: string[]): string {
	if (value === undefined) return fallback;
	if (typeof value === "string") return value;
	warnings.push(`knowledge: ${key} must be a string; using ${fallback}`);
	return fallback;
}

function enumOr<T extends string>(
	value: unknown,
	key: string,
	allowed: readonly T[],
	fallback: T,
	warnings: string[],
): T {
	if (value === undefined) return fallback;
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	warnings.push(`knowledge: ${key} must be one of ${allowed.join(", ")}; using ${fallback}`);
	return fallback;
}

function stringArrayOr(value: unknown, key: string, fallback: string[], warnings: string[]): string[] {
	if (value === undefined) return fallback;
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
	warnings.push(`knowledge: ${key} must be an array of strings; using the default`);
	return fallback;
}

function objectOr(value: unknown, key: string, warnings: string[]): Record<string, unknown> {
	if (value === undefined) return {};
	if (isObject(value)) return value;
	warnings.push(`knowledge: ${key} must be an object; using defaults`);
	return {};
}

function rootsOr(value: unknown, warnings: string[]): RootConfig[] {
	if (value === undefined) return DEFAULT_CONFIG.roots;
	if (!Array.isArray(value)) {
		warnings.push("knowledge: roots must be an array; using the default root");
		return DEFAULT_CONFIG.roots;
	}
	const roots: RootConfig[] = [];
	for (const item of value) {
		if (!isObject(item) || typeof item["path"] !== "string" || item["path"].trim() === "") {
			warnings.push("knowledge: each root needs a path; skipping one");
			continue;
		}
		roots.push({
			path: item["path"],
			scope: enumOr<Scope>(item["scope"], "roots[].scope", ["project", "user", "team"], "project", warnings),
			priority:
				typeof item["priority"] === "number" && Number.isFinite(item["priority"]) && item["priority"] >= 1
					? Math.floor(item["priority"])
					: 100,
			readonly: boolOr(item["readonly"], "roots[].readonly", false, warnings),
		});
	}
	return roots;
}

/** Validate raw configs (lowest precedence first) into a complete config. */
export function resolveConfig(raws: Record<string, unknown>[], warnings: string[]): KnowledgeConfig {
	const raw = raws.reduce<Record<string, unknown>>((acc, next) => deepMerge(acc, next), {});
	const injection = objectOr(raw["injection"], "injection", warnings);
	const maxTokens = positiveIntOr(
		injection["maxTokens"],
		"injection.maxTokens",
		DEFAULT_CONFIG.injection.maxTokens,
		warnings,
	);
	const floorRaw = positiveIntOr(
		injection["floorTokens"],
		"injection.floorTokens",
		DEFAULT_CONFIG.injection.floorTokens,
		warnings,
	);
	const search = objectOr(raw["search"], "search", warnings);
	const embedding = objectOr(search["embedding"], "search.embedding", warnings);
	const capture = objectOr(raw["capture"], "capture", warnings);
	const write = objectOr(raw["write"], "write", warnings);
	const docs = objectOr(raw["docs"], "docs", warnings);
	const stale = objectOr(raw["stale"], "stale", warnings);
	const recall = objectOr(raw["recall"], "recall", warnings);
	const cache = objectOr(raw["cache"], "cache", warnings);
	return {
		enabled: boolOr(raw["enabled"], "enabled", DEFAULT_CONFIG.enabled, warnings),
		roots: rootsOr(raw["roots"], warnings),
		injection: {
			enabled: boolOr(injection["enabled"], "injection.enabled", DEFAULT_CONFIG.injection.enabled, warnings),
			maxTokens,
			floorTokens: Math.min(floorRaw, maxTokens),
			contextFraction: fractionOr(injection["contextFraction"], warnings),
		},
		recall: { mode: enumOr(recall["mode"], "recall.mode", ["off", "hint"] as const, "off", warnings) },
		search: {
			backend: enumOr<Backend>(
				search["backend"],
				"search.backend",
				["lexical", "fts5", "embedding", "hybrid"],
				"lexical",
				warnings,
			),
			embedding: {
				endpoint: stringOr(embedding["endpoint"], "search.embedding.endpoint", "", warnings),
				model: stringOr(embedding["model"], "search.embedding.model", "", warnings),
				apiKeyEnv: stringOr(embedding["apiKeyEnv"], "search.embedding.apiKeyEnv", "", warnings),
				timeoutMs: positiveIntOr(embedding["timeoutMs"], "search.embedding.timeoutMs", 5000, warnings),
			},
		},
		capture: { mode: enumOr(capture["mode"], "capture.mode", ["off", "manual"] as const, "manual", warnings) },
		write: { enforce: enumOr<Enforce>(write["enforce"], "write.enforce", ["block", "warn"], "block", warnings) },
		docs: {
			path: stringOr(docs["path"], "docs.path", DEFAULT_CONFIG.docs.path, warnings),
			include: stringArrayOr(docs["include"], "docs.include", DEFAULT_CONFIG.docs.include, warnings),
			exclude: stringArrayOr(docs["exclude"], "docs.exclude", DEFAULT_CONFIG.docs.exclude, warnings),
			maxLines: positiveIntOr(docs["maxLines"], "docs.maxLines", DEFAULT_CONFIG.docs.maxLines, warnings),
		},
		stale: { days: positiveIntOr(stale["days"], "stale.days", DEFAULT_CONFIG.stale.days, warnings) },
		cache: { enabled: boolOr(cache["enabled"], "cache.enabled", DEFAULT_CONFIG.cache.enabled, warnings) },
	};
}

function fractionOr(value: unknown, warnings: string[]): number {
	if (value === undefined) return DEFAULT_CONFIG.injection.contextFraction;
	if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1) return value;
	warnings.push(
		`knowledge: injection.contextFraction must be in (0, 1]; using ${DEFAULT_CONFIG.injection.contextFraction}`,
	);
	return DEFAULT_CONFIG.injection.contextFraction;
}

function readConfigFile(file: string): { value: Record<string, unknown> | null; warning: string | null } {
	if (!fs.existsSync(file)) return { value: null, warning: null };
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return { value: null, warning: `cannot read ${file}: ${message(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { value: null, warning: `${file} is not valid JSON: ${message(error)}` };
	}
	if (!isObject(parsed)) return { value: null, warning: `${file} must contain a JSON object` };
	return { value: parsed, warning: null };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface LoadedConfig {
	config: KnowledgeConfig;
	warnings: string[];
	globalFile: string;
	projectFile: string;
}

export function loadConfig(cwd: string, trusted: boolean): LoadedConfig {
	const globalFile = globalConfigPath();
	const projectFile = projectConfigPath(cwd);
	const warnings: string[] = [];
	const raws: Record<string, unknown>[] = [];
	const global = readConfigFile(globalFile);
	if (global.warning) warnings.push(global.warning);
	if (global.value) raws.push(global.value);
	if (trusted) {
		const project = readConfigFile(projectFile);
		if (project.warning) warnings.push(project.warning);
		if (project.value) raws.push(project.value);
	}
	const config = resolveConfig(raws, warnings);
	// The default root is implicit: when no config declares roots and the
	// conventional directory is absent, the plugin is a silent no-op.
	const rootsDeclared = raws.some((raw) => raw["roots"] !== undefined);
	if (!rootsDeclared && !fs.existsSync(path.resolve(cwd, "knowledge"))) config.roots = [];
	return { config, warnings, globalFile, projectFile };
}
