# ADR: Inline AI is a narrow surface distinct from the coding-agent panel

Date: 2026-11-06
Status: Accepted
Scope: md-app (command layer + React editor) — not vault-core, matching
`docs/adr/2026-11-06-coding-agent-panel.md`

## Context

The product plan (AI Editor / AI Helper) asks for **single-selection text
operations** — rewrite, improve writing, continue, summarize, change tone,
translate, generate Markdown — plus retrieval Q&A ("ask your notes"), each
with a preview-then-accept interaction and a hard "never silently overwrite"
guarantee.

The existing AI decision (`docs/adr/2026-11-06-coding-agent-panel.md`)
established the opposite shape: AI is the user's own **coding agent** CLI
(opencode / Claude Code / codex), run as a multi-turn, tool-using black box
against the vault working tree; the app never holds keys; auth lives in the
CLI's HOME; the app only observes `git status` afterwards.

That shape is right for open-ended file surgery ("reorganize my meeting
notes") but **wrong for inline editing**, for three concrete reasons:

1. An agent that edits the file directly cannot give a *scoped* suggestion:
   the app sees only the net `git status` delta, so it cannot guarantee that
   only the selected range changed, and it cannot produce a per-selection
   diff to approve.
2. It may do more than asked (reformat neighbouring lines, touch other
   files), which violates the product's core "AI previews everything before
   it changes your file" promise.
3. It is heavy: session spin-up and tool-driven generation, unnecessary for a
   quick selection rewrite.

The plan also reintroduces "provider abstraction / switch AI providers". That
is compatible with the BYO-auth principle but must be framed so it does not
silently reverse the boundary ruling out app-held credentials.

## Decision

**AI is two complementary surfaces with a sharp line between them.**

1. **Keep the agent panel** (status quo) for open-ended, tool-using work and
   working-tree edits: reorganizing, creating notes, linking, cross-note
   surgery. Unchanged.

2. **Add a narrow "inline AI" surface** for single-selection text operations
   and retrieval Q&A. Its defining constraint: **the inline model never
   writes the file.** It returns a candidate replacement string; the UI shows
   it as a diff; only an explicit **Accept** applies it as a CodeMirror
   document transaction. **Reject / Regenerate / edit-manually leave the
   working tree byte-identical.** Git remains the only writer of commit
   history and this makes "a rejected suggestion never appears in git" true
   by construction.

3. **Version-guarded apply.** A request carries `(document version, selection
   span)` captured when it starts. On Accept, the change applies only if the
   document version is unchanged; otherwise the UI surfaces a stale-result
   state (offer re-diff or regenerate) instead of overwriting. This covers
   "user edits paragraph B while AI rewrites paragraph A" and external edits
   pulled in mid-generation. The editor currently has no document-version
   concept — this slice introduces one.

4. **Same BYO-auth principle; no new credential surface.** The inline backend
   invokes the user's installed coding agent in a **tool-disabled, single
   reply** mode; the exact per-provider invocation flags (opencode / Claude
   Code / codex) are pinned by tests, exactly as the agent-panel flags are.
   The surface sits behind a small provider seam so a native provider can
   slot in later — but adding one is a decision, not a helper: it re-introduces
   key storage and therefore requires its own ADR (explicit opt-in, OS-keychain
   storage, per-provider SDKs). Until then, "switch AI providers" is satisfied
   by choosing which installed CLI to use.

5. **Retrieval first, embeddings later.** "Ask your notes" ingests the
   existing FTS5 index, takes top-k matches, sends extracted excerpts with the
   question to the inline seam, and returns an answer with vault-relative
   citations (path + line). No vector infrastructure now; revisit only if
   keyword recall proves insufficient.

6. **Layers stay intact.** Subprocess + streaming live in the command layer
   (an `ai` command module alongside the agent module); `vault-core` remains
   process-free; the editor transaction and diff logic is pure TypeScript
   (Vitest-testable), reusing the existing line-diff rendering already used by
   the git diff view.

7. **Exclusions are shared.** A small per-vault path-exclusion concept is
   honored by the file tree, note listing, search, and AI retrieval/actions
   — and later by selective sync — so privacy for AI and selectivity for sync
   share one mechanism instead of drifting apart.

## Consequences

- Inline rewrites carry spawn + single-completion latency: fine for
  selection-sized operations, never keystroke-level assist. Accepted.
- Inline AI writes through the normal note write path only on Accept, so
  sync, merge, conflict-copies, and the SQLite index behave identically to
  the user having typed the text. No changes to sync/merge guarantees.
- The agent panel and inline AI coexist with clearly different trust
  postures: the agent may edit many things (reviewed via git), inline AI may
  edit precisely one selection (reviewed via diff).
- The "provider abstraction" language from the plan is scoped to the inline
  surface only and deliberately excludes the agent panel.

## Out of scope (deliberate)

Changes to the agent panel; native providers / app-held keys (future ADR);
embeddings / semantic search; auto-resolution of conflicts; any write that is
not previewed and accepted.

## References

- `docs/adr/2026-11-06-coding-agent-panel.md` (the surface this narrows around)
- `docs/adr/2026-10-30-search-index.md` (FTS5 index used for retrieval)
- `docs/api.md` § Notes and § Agent commands (the contracts the inline seam
  extends)
