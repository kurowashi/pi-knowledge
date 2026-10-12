import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { reviewCandidates } from "../../src/core/review.ts";
import type { EntryRecord } from "../../src/core/types.ts";
import { catalogOf, makeEntry, makeRoot } from "../helpers/fixtures.ts";

const BODY = "Conclusion first. Then conditions, evidence, and counterexamples for the reader. ";
const NOW = new Date("2026-06-01T00:00:00Z");

function entry(id: string, overrides: Partial<EntryRecord> = {}): EntryRecord {
	return makeEntry({
		id,
		dir: "/tmp/knowledge",
		path: `/tmp/knowledge/${id}.md`,
		title: `Title ${id}`,
		body: BODY,
		...overrides,
	});
}

function candidates(entries: EntryRecord[], roots = [makeRoot("/tmp/knowledge")]): string {
	return reviewCandidates(catalogOf(entries), DEFAULT_CONFIG, roots, "/tmp", NOW).join("\n");
}

/** One candidate section, so an assertion is not satisfied by another kind. */
function section(text: string, header: string): string {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.startsWith(header));
	if (start === -1) return "";
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => !line.startsWith("- "));
	return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

test("review lists unlinked entries and skips linked ones", () => {
	const text = candidates([entry("alpha"), entry("beta", { body: "points at [[alpha]] here. " })]);
	const unlinked = section(text, "Unlinked candidates");
	assert.match(unlinked, /- beta Title beta/);
	assert.doesNotMatch(unlinked, /alpha/);
});

test("an unlinked entry with no backlinks is still a candidate, never a deletion", () => {
	const text = candidates([entry("alpha")]);
	assert.match(text, /- alpha Title alpha/);
});

test("every candidate kind discloses how many it left out", () => {
	const entries = Array.from({ length: 12 }, (_, index) => entry(`dup_${index}`, { title: "Same", body: BODY }));
	const text = candidates(entries);
	const pairs = (12 * 11) / 2;
	assert.match(text, new RegExp(`\\(\\+${pairs - 5} more pairs not shown\\)`));
	assert.match(text, /\(\+2 more unlinked entries not shown\)/);
});

test("scoped links count only for their own scope", () => {
	const project = entry("shared_id", { scope: "project", dir: "/tmp/knowledge" });
	const user = entry("shared_id", { scope: "user", dir: "/tmp/user", path: "/tmp/user/shared_id.md" });
	const link = entry("linker", { body: "points at [[project:shared_id]] only. " });
	const roots = [makeRoot("/tmp/knowledge"), makeRoot("/tmp/user", { scope: "user", priority: 10 })];
	const text = reviewCandidates(catalogOf([project, user, link]), DEFAULT_CONFIG, roots, "/tmp", NOW).join("\n");
	const unlinked = section(text, "Unlinked candidates");
	assert.match(unlinked, /- user:shared_id/, "the unreferenced user-scope entry is offered");
	assert.doesNotMatch(unlinked, /- project:shared_id/, "the referenced project-scope entry is not");
});

test("supersedes counts as a reference in the same way", () => {
	const older = entry("older");
	const newer = entry("newer", { supersedes: "older" });
	const unlinked = section(candidates([older, newer]), "Unlinked candidates");
	assert.match(unlinked, /- newer Title newer/);
	assert.doesNotMatch(unlinked, /- older/);
});

test("retired entries are never offered as retirement candidates", () => {
	const text = candidates([entry("gone", { status: "superseded" })]);
	assert.doesNotMatch(section(text, "Unlinked candidates"), /gone/);
});

test("a clean catalog produces no candidates", () => {
	const a = entry("a", { body: "alpha points at [[b]] now. " });
	const b = entry("b", { body: "beta points back at [[a]] today. " });
	assert.equal(candidates([a, b]), "");
});
