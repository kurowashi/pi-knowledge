---
name: knowledge-curation
description: Use when recording reusable knowledge, naming or curating entries, fixing outdated entries, or consolidating duplicates in a project knowledge base.
---

# Knowledge curation

Entries are self-contained Markdown notes in `knowledge/`. **You name the entry**: the file name is the id.

## What belongs in the knowledge base

Knowledge, not a copy of the design. Every entry must pass three tests:

1. **Readability**: do not record what the code, DESIGN.md, or README already says.
2. **Durability**: do not record a conclusion that breaks when the design changes.
3. **Re-verifiability**: point at the evidence with `source` (a URL, an implementation path) or a reproduction.

A repository-relative `source` makes `kb lint` warn. That is the machine-checkable part of tests 1 and 2; the rest is judgment.

## Naming an entry

- Write to `knowledge/<slug>.md`.
- The slug is lowercase words describing the conclusion, joined with `_`: at most five words, at most 40 characters, matching `^[a-z0-9]+(_[a-z0-9]+)*$`.
- A name that does not match is not an entry: it is skipped by the catalog and reported by `kb lint` as an error.
- Legacy eight-character names (`24b1d146`) are still valid.
- Names are permanent. To change one, create a new entry with `supersedes` and retire the old one.

## Writing an entry

1. Search first with `kb_search` using English key terms. If a similar entry exists, update it with `edit` instead of creating a new one.
2. Create with `write` and the slug path. A `write` onto an existing entry path is refused; use `edit` to update.
3. Put the conclusion first in the body, then conditions, evidence, counterexamples, and uncertainty.
4. Frontmatter fields: `title` (required, ≤120 chars), `when` (one English trigger condition, ≤15 words), `tags`, `status`, `supersedes`, `review_after`, `source`.
5. Keep one knowledge per entry. Split independent conclusions.
6. Write source URLs inline in the body for claims; use `source` for the document or implementation the entry came from.

## Updating

- Use `edit`. Overwriting with `write` is refused by design.
- When new evidence contradicts an entry, update the body and fix `review_after`.
- To replace an entry: write the new entry with `supersedes: <old id>`; edit the old entry to `status: superseded`; check `kb refs <old id>` for backlinks. Do this instead of deleting the old entry unless nothing references it. `supersedes` is only for replacement, not for general links.

## Curation

- `kb lint` reports form errors, unknown fields, dangling `[[id]]` links, stale `review_after`, duplicates, and entries that stay active after being superseded.
- `kb dups` lists near-duplicate candidates with their titles. `kb refs <id>` lists backlinks from `[[id]]` and `supersedes`.
- At session start, a `knowledge_lint` message lists the top findings when any exist. Fix them with `edit` in the same session.
- `/kb review` sends duplicate, stale, and unlinked candidates and asks you to judge them. Read each candidate entry, then apply merges with `write` / `edit`; it never rewrites entries for you.
- During review, also judge what the plugin cannot: entries whose conclusion is already covered elsewhere, and pairs of entries whose conclusions conflict. Report them in your reply and fix them with the same tools.
- An unlinked entry is not automatically a bad entry: it can be the only record of a fact. Check before retiring it.
- Deleting an entry is allowed when nothing references it; check `kb refs <id>` first.
