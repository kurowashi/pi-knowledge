# pi-knowledge

Project knowledge for Pi. The plugin injects a small discovery index at session start and refreshes it from disk after a successful compaction, validates Markdown entries while you edit them, searches them lexically, and bundles a `kb` CLI for CI.

**Scope (v0.1.0):** `kb list`, `tags`, `find`, `search`, `lint`, `stale`, `dups`, `refs`, `docs`, `bench`, and the `/kb` command (`status`, `config`) are implemented. Search backends are selectable: lexical (default), FTS5, embedding, and hybrid. Embedding needs an OpenAI-compatible endpoint; it is off until configured.

## What it does

- **Injects an index** of `knowledge/` entries into the system prompt within a token budget. The index is refreshed from disk after a successful compaction. Bodies stay out of context until read.
- **Assigns entry IDs** and validates every `write` / `edit` to the knowledge root. No separate write tool is added.
- **Searches** entries with `kb_search` (lexical, tag/status/scope filters).
- **Lints and curates** entries with `kb lint` (form errors, unknown fields, dangling `[[id]]` links, stale `review_after`, duplicates, superseded-but-active entries), `kb stale`, `kb dups`, and `kb refs`.
- **Reviews** duplicate and stale candidates with `/kb review`: the plugin hands the candidates to the agent, which applies accepted changes through the normal `write` / `edit` path. The plugin never writes entries itself.
- **Generates a document index** with `kb docs` and checks for drift in CI with `kb docs --check`.

## Install

```bash
pi install npm:pi-knowledge
```

## Entry format

Entries live in `knowledge/<id>.md`. Writes create entries only: a write to an existing entry path is always blocked, so update with `edit`. The plugin assigns the id. If the filename already is an unused `<hex8>`, it is kept; otherwise the hook rewrites the path to `<root>/<id>.md`.

```markdown
---
title: "External API responses must be schema-checked"
when:
  - When calling a new external API
tags: [api, validation]
status: active
review_after: 2027-03-31
source: docs/api.md
---

Conclusion: validate external API responses against the expected schema.
Then conditions, evidence, counterexamples, and uncertainty.
```

| Field | Required | Purpose |
|---|---|---|
| `title` | yes | One-line heading (≤120 chars) |
| `when` | no | Trigger conditions (string or list) |
| `tags` | no | Deterministic filters |
| `status` | no | `active` / `superseded` / `deprecated` |
| `supersedes` | no | Replaced entry id |
| `review_after` | no | `YYYY-MM-DD` (UTC) |
| `source` | no | URL or repo-relative path |

Unknown frontmatter fields stay in the file, are ignored by the catalog, and are reported by `kb lint`.

Frontmatter accepts plain scalars, quoted strings, inline arrays (`tags: [a, b]`), and block lists (`when:` with `- item` lines below). Full-line comments are ignored and inline `#` is kept as text; anchors are not interpreted. Nested mappings, unexpected indentation, and block scalars (`>` / `|`) fail validation. Quote values that start with `[`.

## CLI

```bash
kb list                 # active entries
kb tags                 # tag counts
kb find <tag>...        # AND filter
kb search "query"       # lexical by default; --backend lexical|fts5|embedding|hybrid
kb lint                 # errors and warnings (exit 1 on errors)
kb stale                # overdue review_after / old git dates
kb dups [--max N]       # near-duplicate candidates; exit 1 when pairs > N, 2 on invalid N
kb refs <id>            # backlinks
kb docs [--check]       # document index generation / drift check
kb bench <fixture.json> # recall and latency for a fixture set
```

Search backends are selectable (`search.backend` or `--backend`). An unavailable backend falls back to lexical with a visible reason; `--require-backend` turns that into exit code 3.

## Configuration

`knowledge.json` at `$PI_CODING_AGENT_DIR/knowledge.json` (global) or `.pi/knowledge.json` (project). Global values load first; a trusted project then overrides them key by key. Broken config falls back to defaults with a warning and never blocks the session. See [DESIGN.md §16](DESIGN.md#16-設定スキーマ) for the full schema and defaults.

Roots have a `scope`: `project` (default), `user`, or `team`. A team root is meant for a shared, read-only checkout (set `readonly: true`); writes to it are blocked.

Search indexes persist under `.pi/` (`knowledge-fts.sqlite`, `knowledge-embeddings.json`) and are reused while the corpus is unchanged. Add `.pi/knowledge-*` to your `.gitignore`; disable the cache with `"cache": { "enabled": false }`.

## Privacy

Search is local and lexical by default. Embedding search is opt-in: it sends entry text and queries to the endpoint you configure, with the API key read from an environment variable named in the config.
