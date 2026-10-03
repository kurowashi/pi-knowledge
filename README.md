# pi-knowledge

Project knowledge for Pi. The plugin injects a small discovery index at session start, validates Markdown entries while you edit them, searches them lexically, and bundles a `kb` CLI for CI.

**Scope (v0.1.0):** `kb list`, `tags`, `find`, `search` (lexical), `lint`, `stale`, `dups`, `refs`, `docs`, `bench`, and the `/kb` command are implemented. Embedding and FTS5 search are planned (see [DESIGN.md §21](DESIGN.md#21-実装フェーズ)).

## What it does

- **Injects an index** of `knowledge/` entries into the system prompt within a token budget. Bodies stay out of context until read.
- **Assigns entry IDs** and validates every `write` / `edit` to the knowledge root. No separate write tool is added.
- **Searches** entries with `kb_search` (lexical, tag/status/scope filters).
- **Lints and curates** entries with `kb lint` (form errors, dangling `[[id]]` links, stale `review_after`, duplicates), `kb stale`, `kb dups`, and `kb refs`.
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

## CLI

```bash
kb list                 # active entries
kb tags                 # tag counts
kb find <tag>...        # AND filter
kb search "query"       # lexical search
kb lint                 # errors and warnings (exit 1 on errors)
kb stale                # overdue review_after / old git dates
kb dups                 # near-duplicate candidates
kb refs <id>            # backlinks
kb docs [--check]       # document index generation / drift check
kb bench <fixture.json> # recall and latency for a fixture set
```

Embedding and FTS5 search are planned for a later phase (see [DESIGN.md §21](DESIGN.md#21-実装フェーズ)).

## Configuration

`knowledge.json` at `$PI_CODING_AGENT_DIR/knowledge.json` (global) or `.pi/knowledge.json` (project). Global values load first; a trusted project then overrides them key by key. Broken config falls back to defaults with a warning and never blocks the session. See [DESIGN.md §16](DESIGN.md#16-設定スキーマ) for the full schema and defaults.

## Privacy

Search is local and lexical. Optional embedding search is planned (Phase 3); when it ships it will send entry text to the endpoint you configure, with the API key read from an environment variable named in the config.
