import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { buildDocumentIndex, globToRegExp, runDocs } from "../../src/docs.ts";
import { withTempDir } from "../helpers/fixtures.ts";

function config(overrides: Partial<typeof DEFAULT_CONFIG.docs> = {}) {
	return { ...DEFAULT_CONFIG, docs: { ...DEFAULT_CONFIG.docs, ...overrides } };
}

test("globToRegExp handles *, **, and ? and rejects control characters", () => {
	assert.ok(globToRegExp("docs/**")?.test("docs/a/b.md"));
	assert.ok(globToRegExp("*.md")?.test("a.md"));
	assert.ok(!globToRegExp("*.md")?.test("sub/a.md"));
	assert.ok(globToRegExp("a?c.md")?.test("abc.md"));
	assert.ok(globToRegExp("a{b}.md")?.test("a{b}.md"));
	assert.equal(globToRegExp("bad\u0001"), null);
});

test("buildDocumentIndex lists files with headings in path order", () => {
	withTempDir((root) => {
		fs.mkdirSync(path.join(root, "docs", "sub"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "b.md"), "# Beta\nbody");
		fs.writeFileSync(path.join(root, "docs", "a.md"), "no heading here");
		fs.writeFileSync(path.join(root, "docs", "sub", "c.md"), "##   Sub title  \n");
		fs.writeFileSync(path.join(root, "docs", "bin.dat"), Buffer.from([0x00, 0x41]));
		const build = buildDocumentIndex(root, config());
		assert.equal(build.count, 3);
		assert.equal(build.failures, 0);
		assert.match(build.text, /docs\/a\.md\n/);
		assert.match(build.text, /docs\/b\.md — Beta/);
		assert.match(build.text, /docs\/sub\/c\.md — Sub title/);
		assert.ok(!build.text.includes("bin.dat"));
	});
});

test("excludes, dotfiles, binary files, and invalid patterns are handled", () => {
	withTempDir((root) => {
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "keep.md"), "# Keep");
		fs.writeFileSync(path.join(root, "docs", "skip.md"), "# Skip");
		fs.writeFileSync(path.join(root, "docs", ".hidden.md"), "# Hidden");
		fs.writeFileSync(path.join(root, "docs", "bin.md"), Buffer.from([0x23, 0x00, 0x41]));
		const build = buildDocumentIndex(root, {
			...DEFAULT_CONFIG,
			docs: { ...DEFAULT_CONFIG.docs, exclude: ["docs/skip.md"], include: ["docs/**", "{bad"] },
		});
		assert.equal(build.count, 1);
		assert.ok(build.text.includes("keep.md"));
		assert.ok(!build.text.includes("skip.md"));
		assert.ok(!build.text.includes("hidden"));
		const warned = buildDocumentIndex(root, {
			...DEFAULT_CONFIG,
			docs: { ...DEFAULT_CONFIG.docs, include: ["bad\u0001"] },
		});
		assert.ok(warned.warnings.some((warning) => warning.includes("invalid")));
	});
});

test("maxLines truncates with a note", () => {
	withTempDir((root) => {
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(root, "docs", `${name}.md`), `# ${name}`);
		const build = buildDocumentIndex(root, config({ maxLines: 2 }));
		const lines = build.text.trimEnd().split("\n");
		assert.equal(lines.length, 2);
		assert.match(lines[1] ?? "", /more\)/);
		assert.equal(build.count, 3);
	});
});

test("runDocs writes, checks, and reports drift", () => {
	withTempDir((root) => {
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "a.md"), "# Alpha");
		const configValue = config();
		const write = runDocs(root, configValue, false);
		assert.equal(write.code, 0);
		assert.match(write.stdout, /wrote/);
		assert.equal(runDocs(root, configValue, true).code, 0);
		fs.writeFileSync(path.join(root, "docs", "b.md"), "# Beta");
		assert.equal(runDocs(root, configValue, true).code, 1);
		fs.rmSync(path.join(root, DEFAULT_CONFIG.docs.path));
		assert.equal(runDocs(root, configValue, true).code, 1);
	});
});

test("runDocs with no matches and write failures use the documented codes", () => {
	withTempDir((root) => {
		const none = runDocs(root, config({ include: [] }), false);
		assert.equal(none.code, 0);
		assert.match(none.stdout, /no documents matched/);
		fs.writeFileSync(path.join(root, "note.md"), "# Note");
		fs.writeFileSync(path.join(root, "blocked"), "file");
		const failing = runDocs(
			root,
			{ ...DEFAULT_CONFIG, docs: { ...DEFAULT_CONFIG.docs, include: ["**"], path: "blocked/INDEX.md" } },
			false,
		);
		assert.equal(failing.code, 2);
		assert.match(failing.stderr, /cannot write/);
	});
});
