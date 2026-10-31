# ADR: Search is an FTS5 index, rebuilt on drift

Date: 2026-10-30
Status: accepted
Scope: vault-core (search), per-vault SQLite

## Context

The foundation plan requires search correctness as an exit criterion while
keeping SQLite a rebuildable index — never a second copy of editable content
and never proof that a note exists. The original implementation re-read every
Markdown file on each query: always correct, O(all notes) per keystroke-ish
query, and it had a latent crash: snippet truncation sliced at a byte offset,
which panics on multi-byte characters (the plan explicitly targets Thai).

## Decision

1. **FTS5 index in the per-vault SQLite** (`search_index`, unicode61
   tokenizer with diacritics removed; `search_state` keeps each indexed
   path's mtime + size).
2. **Drift-triggered full rebuild.** Before every query the current `.md`
   files are stat-ed and compared against `search_state`. Any difference —
   note added, edited, or deleted by us *or by an external editor* — rebuilds
   the whole index in one transaction, then the query runs. The index can
   therefore never answer stale results; being wrong costs one rebuild, not
   correctness.
3. **Ranked queries, familiar shape.** Matching notes come from FTS5
   `MATCH` + `bm25` ordering; line numbers and snippets are then derived from
   the file itself, so the `SearchHit` contract (path + up to 5 line/snippet
   pairs) is unchanged and no markup crosses the Rust boundary.
4. **Non-ASCII fallback.** Thai, CJK, and other space-less scripts tokenize
   poorly with unicode61. If a query contains non-ASCII terms and FTS returns
   nothing, search falls back to the original line scan. FTS query errors
   (malformed terms, corrupt index) also fall back. Correctness beats speed.
5. **Char-safe snippets everywhere.** Truncation counts characters, not
   bytes — no mid-UTF-8 panics on any script.

## Consequences

- Query cost is dominated by the index, not by reading the vault; rebuilds
  are O(vault) but rare (only after actual changes).
- The index lives next to the sync journal in `index.db`. Deleting the whole
  file is always safe: everything in it is rebuilt from Markdown.
- External-editor edits are picked up on the next search without any manual
  re-index action — verified by `external_edit_is_visible_without_reindex`.
- Known limit: Thai *sub-word* matching inside an unbroken run of Thai text
  is only found via the scan fallback path, never by tokenized FTS. Adequate
  for the MVP; a custom tokenizer is future work if needed.
