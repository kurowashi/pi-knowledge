---
name: knowledge-curation
description: How to add, update, and curate pi-knowledge entries. Use when recording reusable knowledge, fixing outdated entries, or consolidating duplicates in a project knowledge base.
---

# Knowledge curation

Entries are self-contained Markdown notes in `knowledge/`. The plugin assigns the file id.

## Writing an entry

1. Search first: `kb_search` with the key terms. If a similar entry exists, update it with `edit` instead of creating a new one.
2. Create with the `write` tool. Writes create entries only: a write to an existing entry path is always blocked. Use `edit` to update. An unused `<hex8>` filename is kept; any other new filename is rewritten to `<root>/<id>.md` by the hook.
3. Put the conclusion first in the body, then conditions, evidence, counterexamples, and uncertainty.
4. Frontmatter fields: `title` (required, ≤120 chars), `when` (trigger conditions), `tags`, `status`, `supersedes`, `review_after`, `source`.
5. Keep one knowledge per entry. Split independent conclusions.
6. Write source URLs inline in the body for claims; use `source` for the document the entry came from.

## Updating

- Use `edit`. Overwriting with `write` is blocked by design.
- When new evidence contradicts an entry, update the body and fix `review_after`.
- When replacing an entry, set `status: superseded` and `supersedes: <old id>` instead of deleting it, unless nothing references it. `supersedes` is only used for replacement, not for general links.

## Curation

- `kb lint` reports form errors, dangling `[[id]]` links, stale `review_after`, and likely duplicates.
- Planned for the quality phase: `kb dups` (duplicate candidates) and `kb refs <id>` (backlinks). Until then, find references with `kb_search` and read the entries.
- Deleting an entry is allowed when nothing references it; search for its id first.
