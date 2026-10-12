# pi-knowledge

Project knowledge for Pi and OpenCode. The plugin injects a small discovery index at session start and refreshes it from disk after a successful compaction, validates Markdown entries after they are written, searches them lexically, and bundles a `kb` CLI for CI.

**Scope (v0.1.0):** `kb list`, `tags`, `find`, `search`, `lint`, `stale`, `dups`, `refs`, `docs`, `bench`, and the `/kb` command (`status`, `config`, …) are implemented. Search backends are selectable: lexical (default), FTS5, embedding, and hybrid. Embedding needs an OpenAI-compatible endpoint; it is off until configured.

## What it does

- **Injects an index** of `knowledge/` entries into the system prompt within a token budget. The index is refreshed from disk after a successful compaction. Bodies stay out of context until read.
- **Names entries with the model**: you write `knowledge/<slug>.md` yourself, so the path is the id and no hook renames your file.
- **Refuses destructive writes only**: a `write` onto an existing entry path is refused so an entry cannot be silently replaced. Everything else is validated after the write, by `kb lint`, and in CI.
- **Searches** entries with `kb_search` (lexical, tag/status/scope filters).
- **Lints and curates** entries with `kb lint` (form errors, unknown fields, dangling `[[id]]` links, stale `review_after`, duplicates, superseded-but-active entries, self-referential sources), `kb stale`, `kb dups`, and `kb refs`.
- **Reviews** the knowledge base with `/kb review`: the plugin hands duplicate, stale, and unlinked candidates to the agent, which applies accepted changes through the normal `write` / `edit` path. Low-value entries and conflicting conclusions are judged by the agent, not by the plugin. The plugin never writes entries itself.
- **Generates a document index** with `kb docs` and checks for drift in CI with `kb docs --check`.

## Install

### Pi

```bash
pi install npm:pi-knowledge
```

### OpenCode

A source checkout is configured by directory; OpenCode resolves it as `<dir>/server` (the root `server.ts` re-exports the adapter):

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./pi-knowledge"],
  "skills": ["./pi-knowledge/skills"],
}
```

A configured plugin path must be a directory; a file path is rejected with `configured plugin path must be a directory`.

An installed package resolves through its `exports` map (`./server` → `src/hosts/opencode.ts`) the same way. **Do not reference this package by the bare name `pi-knowledge` on npm**: that name belongs to an unrelated package, and configuring it installs that one instead.

Host differences are documented in [DESIGN.md §15](DESIGN.md#15-統合面host):

| | Pi | OpenCode |
|---|---|---|
| User-facing notices | toast | none; warnings go to the conversation and the tool result |
| `write` refusal | `tool_call` block | `tool.execute.before` throw |
| Read-only root | `tool_call` block | `permission` hook deny |
| Config | `.pi/knowledge.json` | `.opencode/knowledge.json` |
| Search cache | `.pi/knowledge-*` | `.opencode/knowledge-*` |

`kb` takes no host: it reads both global files and both project files (`.pi` then `.opencode`, later wins), so CI resolves a superset of what any single agent loaded.

## Entry format

Entries live in `knowledge/<id>.md`. **You choose the id**: lowercase words describing the conclusion, joined with `_`, at most five words and 40 characters (`^[a-z0-9]+(_[a-z0-9]+)*$`). A name that does not match is not an entry, and `kb lint` reports it as an error. Legacy `[0-9a-f]{8}` names remain valid, so existing entries need no migration.

```markdown
---
title: "External API responses must be schema-checked"
when:
  - When calling a new external API
tags: [api, validation]
status: active
review_after: 2027-03-31
source: https://example.com/api.md
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
| `source` | no | URL or absolute path. A repository-relative path warns: it records this project's own design, which the knowledge base does not hold |

Unknown frontmatter fields stay in the file, are ignored by the catalog, and are reported by `kb lint`.

Frontmatter accepts plain scalars, quoted strings, inline arrays (`tags: [a, b]`), and block lists (`when:` with `- item` lines below). Full-line comments are ignored and inline `#` is kept as text; anchors are not interpreted. Nested mappings, unexpected indentation, and block scalars (`>` / `|`) fail validation. Quote values that start with `[`.

## What to record

The knowledge base holds **knowledge**, not a copy of the design. An entry earns its place when all three hold:

| Test | Rule |
|---|---|
| Readability | Do not record what the code, DESIGN.md, or README already says |
| Durability | Do not record a conclusion that breaks when the design changes |
| Re-verifiability | Point at the evidence: a URL, an implementation path, or a reproduction |

`kb lint` warns when `source` points inside the repository, which is the mechanical part of the first two tests. The rest is a judgment `/kb review` asks the agent to make.

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

| Host | Global | Project |
|---|---|---|
| Pi | `$PI_CODING_AGENT_DIR/knowledge.json` | `.pi/knowledge.json` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/knowledge.json` | `.opencode/knowledge.json` |
| `kb` CLI | both global files | both project files, `.opencode` wins |

Global values load first; a trusted project then overrides them key by key. Broken config falls back to defaults with a warning and never blocks the session. See [DESIGN.md §16](DESIGN.md#16-設定スキーマ) for the full schema and defaults.

Roots have a `scope`: `project` (default), `user`, or `team`. A team root is meant for a shared, read-only checkout (set `readonly: true`); the file tools are refused on it in every enforcement mode. Shell commands are not intercepted.

Search indexes persist under the host's directory (`.pi/knowledge-fts.sqlite`, `.pi/knowledge-embeddings.json`) and are reused while the corpus is unchanged. Add `.pi/knowledge-*` and `.opencode/knowledge-*` to your `.gitignore`; disable the cache with `"cache": { "enabled": false }`.

`write.enforce` governs one thing only: whether a `write` onto an existing entry path is refused (`block`, the default) or allowed with a note (`warn`). Content validation never blocks a write; it reports after the fact.

## Privacy

Search is local and lexical by default. Embedding search is opt-in: it sends entry text and queries to the endpoint you configure, with the API key read from an environment variable named in the config.
