import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { cosine, embedTexts } from "../../src/backend_embedding.ts";
import { expandCjk, FtsIndex } from "../../src/backend_fts.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { SearchService } from "../../src/search_service.ts";
import type { SearchOptions } from "../../src/types.ts";
import { catalogOf, makeEntry } from "../helpers/fixtures.ts";

const BODY = "Conclusion first. Then conditions, evidence, and counterexamples for the reader. ";

function searchOptions(overrides: Partial<SearchOptions> = {}): SearchOptions {
	return { query: "alpha", tags: [], status: "active", scope: null, limit: 10, ...overrides };
}

function embeddingConfig(endpoint: string) {
	return {
		...DEFAULT_CONFIG,
		search: {
			...DEFAULT_CONFIG.search,
			backend: "embedding" as const,
			embedding: { endpoint, model: "test-model", apiKeyEnv: "", timeoutMs: 2000 },
		},
	};
}

async function withServer(
	handler: (body: string, res: ServerResponse) => void,
	fn: (endpoint: string) => Promise<void>,
): Promise<void> {
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += String(chunk);
		});
		request.on("end", () => handler(body, response));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	try {
		await fn(`http://127.0.0.1:${port}/v1/embeddings`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

async function withCacheDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-knowledge-cache-"));
	try {
		return await fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function vectorHandler(body: string, res: ServerResponse): void {
	const parsed = JSON.parse(body) as { input: string | string[] };
	const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
	const data = inputs.map((text) => ({ embedding: text.toLowerCase().includes("alpha") ? [1, 0] : [0, 1] }));
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify({ data, usage: { prompt_tokens: inputs.length } }));
}

test("expandCjk emits characters and bigrams", () => {
	assert.equal(expandCjk("日本").trim(), "日 日本 本");
	assert.equal(expandCjk("alpha").trim(), "alpha");
});

test("cosine handles identical, orthogonal, and empty vectors", () => {
	assert.equal(cosine([1, 0], [1, 0]), 1);
	assert.equal(cosine([1, 0], [0, 1]), 0);
	assert.equal(cosine([0, 0], [1, 0]), 0);
});

test("FTS5 search ranks matching entries when available", async (t) => {
	const entry = makeEntry({ id: "11111111", title: "Alpha" });
	const index = new FtsIndex(catalogOf([entry]));
	if (!(await index.available())) {
		t.skip("FTS5 is unavailable in this Node build");
		return;
	}
	const hits = await index.search(searchOptions());
	assert.equal(hits?.[0]?.id, "11111111");
	assert.equal(hits?.[0]?.backend, "fts5");
});

test("embedding search ranks by cosine and reports provider tokens", async () => {
	await withServer(vectorHandler, async (endpoint) => {
		const catalog = catalogOf([
			makeEntry({ id: "11111111", title: "Alpha", body: BODY }),
			makeEntry({ id: "22222222", title: "Beta", body: BODY }),
		]);
		const service = new SearchService(catalog, embeddingConfig(endpoint));
		assert.equal((await service.status("embedding")).available, true);
		const result = await service.search(searchOptions(), "embedding");
		assert.equal(result.backend, "embedding");
		assert.equal(result.fallback, false);
		assert.equal(result.hits[0]?.id, "11111111");
		assert.ok(service.actualTokens !== null && service.actualTokens > 0);
	});
});

test("embedding failures fall back with classified reasons", async () => {
	await withServer(
		(_body, res) => {
			res.statusCode = 401;
			res.end("{}");
		},
		async (endpoint) => {
			const service = new SearchService(
				catalogOf([makeEntry({ id: "11111111", title: "Alpha" })]),
				embeddingConfig(endpoint),
			);
			const result = await service.search(searchOptions(), "embedding");
			assert.equal(result.fallback, true);
			assert.equal(result.fallbackReason, "auth");
			assert.equal(result.backend, "lexical");
		},
	);
	await withServer(
		(_body, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ embedding: [] }] }));
		},
		async (endpoint) => {
			const service = new SearchService(
				catalogOf([makeEntry({ id: "11111111", title: "Alpha" })]),
				embeddingConfig(endpoint),
			);
			assert.equal((await service.search(searchOptions(), "embedding")).fallbackReason, "protocol");
		},
	);
	const offline = new SearchService(
		catalogOf([makeEntry({ id: "11111111", title: "Alpha" })]),
		embeddingConfig("http://127.0.0.1:1/embeddings"),
	);
	assert.equal((await offline.search(searchOptions(), "embedding")).fallbackReason, "network");
});

test("hybrid fuses lexical and embedding results", async () => {
	await withServer(vectorHandler, async (endpoint) => {
		const base = embeddingConfig(endpoint);
		const catalog = catalogOf([
			makeEntry({ id: "11111111", title: "Alpha", body: BODY }),
			makeEntry({ id: "22222222", title: "Beta", body: BODY }),
		]);
		const service = new SearchService(catalog, { ...base, search: { ...base.search, backend: "hybrid" } });
		const result = await service.search(searchOptions(), "hybrid");
		assert.equal(result.backend, "hybrid");
		assert.equal(result.hits[0]?.id, "11111111");
	});
});

test("embedTexts returns unavailable without an endpoint", async () => {
	assert.deepEqual(await embedTexts(DEFAULT_CONFIG.search.embedding, ["x"]), { ok: false, reason: "unavailable" });
});

test("embedding vectors are cached across service instances", async () => {
	let indexRequests = 0;
	await withServer(
		(body, res) => {
			const parsed = JSON.parse(body) as { input: string | string[] };
			const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
			if (inputs.length > 1) indexRequests++;
			vectorHandler(body, res);
		},
		async (endpoint) => {
			await withCacheDir(async (cwd) => {
				const catalog = catalogOf([
					makeEntry({ id: "11111111", title: "Alpha" }),
					makeEntry({ id: "22222222", title: "Beta" }),
				]);
				const config = embeddingConfig(endpoint);
				const cache = { cwd, enabled: true };
				await new SearchService(catalog, config, cache).search(searchOptions(), "embedding");
				assert.equal(indexRequests, 1);
				assert.ok(fs.existsSync(path.join(cwd, ".pi", "knowledge-embeddings.json")));
				await new SearchService(catalog, config, cache).search(searchOptions(), "embedding");
				assert.equal(indexRequests, 1);
			});
		},
	);
});

test("the cache is skipped when disabled", async () => {
	await withServer(vectorHandler, async (endpoint) => {
		await withCacheDir(async (cwd) => {
			const catalog = catalogOf([makeEntry({ id: "11111111", title: "Alpha" })]);
			const service = new SearchService(catalog, embeddingConfig(endpoint), { cwd, enabled: false });
			await service.search(searchOptions(), "embedding");
			assert.ok(!fs.existsSync(path.join(cwd, ".pi")));
		});
	});
});

test("team scope filters entries", async () => {
	const catalog = catalogOf([
		makeEntry({ id: "11111111", scope: "team", title: "Alpha" }),
		makeEntry({ id: "22222222", title: "Beta" }),
	]);
	const service = new SearchService(catalog, DEFAULT_CONFIG);
	const result = await service.search(searchOptions({ scope: "team" }), "lexical");
	assert.equal(result.hits[0]?.id, "11111111");
});

test("FTS5 index cache is created and reused when available", async (t) => {
	await withCacheDir(async (cwd) => {
		const catalog = catalogOf([makeEntry({ id: "11111111", title: "Alpha" })]);
		const cache = { cwd, enabled: true };
		const first = new SearchService(catalog, DEFAULT_CONFIG, cache);
		if (!(await first.status("fts5")).available) {
			t.skip("FTS5 is unavailable in this Node build");
			return;
		}
		await first.search(searchOptions(), "fts5");
		assert.ok(fs.existsSync(path.join(cwd, ".pi", "knowledge-fts.sqlite")));
		const result = await new SearchService(catalog, DEFAULT_CONFIG, cache).search(searchOptions(), "fts5");
		assert.equal(result.backend, "fts5");
		assert.equal(result.hits[0]?.id, "11111111");
	});
});
