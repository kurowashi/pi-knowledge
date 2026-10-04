/**
 * Frontmatter parsing for the documented subset.
 *
 * Supported syntax:
 *   key: value            (plain or quoted scalar)
 *   key: [a, "b"]         (inline array)
 *   key:
 *     - item              (block list)
 *
 * Nested mappings, unexpected indentation, and block scalars are errors, and
 * the caller excludes the entry with a warning. Anchors and inline comments
 * are not interpreted (they stay in the scalar); full-line comments are
 * skipped. This keeps the parser dependency free while the format stays small
 * and predictable.
 */

export interface FrontmatterResult {
	meta: Record<string, unknown> | null;
	body: string;
	error: string | null;
}

interface LineResult {
	key: string;
	value: unknown;
	next: number;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

function splitInline(inner: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (const char of inner) {
		if (quote) {
			current += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === ",") {
			items.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	items.push(current);
	return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseBlockList(lines: string[], index: number, key: string): LineResult {
	const items: string[] = [];
	let next = index + 1;
	for (; next < lines.length; next++) {
		const match = /^\s+-\s+(.*)$/.exec(lines[next] ?? "");
		if (!match) break;
		items.push(unquote((match[1] ?? "").trim()));
	}
	return { key, value: items, next: next - 1 };
}

function parseLine(lines: string[], index: number): LineResult | string {
	const raw = lines[index] ?? "";
	const colon = raw.indexOf(":");
	if (colon <= 0) return `invalid frontmatter line: ${raw.trim()}`;
	const key = raw.slice(0, colon).trim();
	const rest = raw.slice(colon + 1).trim();
	if (rest === "") return parseBlockList(lines, index, key);
	if (/^[>|](\d?[+-]?|[+-]\d?)$/.test(rest)) return `block scalars are not supported: ${raw.trim()}`;
	if (!rest.startsWith("[")) return { key, value: unquote(rest), next: index };
	if (!rest.endsWith("]")) return `unterminated inline array (quote the value if it starts with "["): ${raw.trim()}`;
	return { key, value: splitInline(rest.slice(1, -1)).map(unquote), next: index };
}

function findEnd(lines: string[]): number {
	for (let i = 1; i < lines.length; i++) {
		if ((lines[i] ?? "").trim() === "---") return i;
	}
	return -1;
}

export function parseFrontmatter(text: string): FrontmatterResult {
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
		return { meta: null, body: text, error: null };
	}
	const lines = text.split(/\r?\n/);
	const end = findEnd(lines);
	if (end === -1) return { meta: null, body: "", error: "frontmatter is not closed" };

	const meta: Record<string, unknown> = {};
	const metaLines = lines.slice(1, end);
	for (let i = 0; i < metaLines.length; i++) {
		const raw = metaLines[i] ?? "";
		if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
		if (/^\s/.test(raw)) return { meta: null, body: "", error: `unexpected indentation: ${raw.trim()}` };
		const result = parseLine(metaLines, i);
		if (typeof result === "string") return { meta: null, body: "", error: result };
		meta[result.key] = result.value;
		i = result.next;
	}
	const body = lines
		.slice(end + 1)
		.join("\n")
		.replace(/^\n+/, "");
	return { meta, body, error: null };
}
