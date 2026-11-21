# ADR: One canonical Tauri mock; suites compose through shared test factories

Date: 2026-11-21
Status: accepted
Scope: md-app browser tests (`md-app/src/test/`, `md-app/vitest.config.ts`, `*.test.*`)

## Context

The browser suites hit the Tauri IPC boundary from two directions, and both
sourced brittleness — tests that broke in bulk whenever product code moved:

- Six suites hand-rolled `vi.mock("@tauri-apps/api/core")`; three duplicated
  the same fake `Channel` class, two duplicated the `plugin-opener` mock.
  A change to how the app consumes the core API (a new export, a new
  `Channel` method) had to be fixed in every file, and a missed one failed
  only in CI.
- Suites rendered mega-prop components by copying the full prop list:
  `GitPanel`'s ~35-prop JSX appeared twice in its own file, and
  `MarkdownEditor`'s render JSX appeared a dozen times across three suites.
  Every new prop cascaded into every render site.
- The same "let the DOM settle" problem was solved per suite with
  hand-rolled rAF dances (a double-rAF in NoteEditor, a single-rAF in
  Sidebar), so timing fixes could not be made in one place.

## Decision

- **`src/test/setup.ts` mocks the Tauri boundary once**, registered via
  `setupFiles` in `vitest.config.ts`: `@tauri-apps/api/core` (`invoke`,
  `Channel`) and `@tauri-apps/plugin-opener`. Its export list must stay a
  superset of what `src/` imports from those modules — an entry missing
  there is silently `undefined` in every suite. Suites configure command
  replies with `vi.mocked(invoke)`; a suite can still override with its own
  local `vi.mock`, which wins for that file.
- **`src/test/render.tsx` and `src/test/dom.ts` hold the shared plumbing**:
  render helpers (`renderEditor()`, `editorView()`) and DOM/timing
  primitives (`settle()`, `sleep()`, `pointerEvent()`). The settle dance
  and the synthetic drag-event shape are defined once; suites with
  genuinely different input semantics (touch swipe) keep their local
  variant.
- **`src/test/fixtures.ts` holds domain factories** (`vaultFile()`), never
  shared mutable literals, so suites cannot leak fixture state into each
  other and a new required field gets one default here.
- **Component harnesses shared by several suites** live beside them (e.g.
  `src/test/drawerHarness.tsx` for the two MobileDrawer suites). Stylesheet
  imports stay in the suite, not the harness, so a "bare" harness stays
  bare.
- Plugin mocks with suite-specific configured values (clipboard-manager in
  clipboard-menu, updater in useUpdate) stay local to their suite: one user,
  no duplication to remove.

## Consequences

- A boundary change is a one-file fix; a new component prop gets one new
  default instead of N suite edits.
- Every suite now runs with `invoke` resolving `undefined` by default
  instead of loading the real transport. Suites that reach IPC without
  arranging a reply get `undefined` data rather than an environment error;
  suites that care about IPC assert `invoke` calls explicitly, as they
  already did.
- Local `vi.mock` calls keep working, so migration of a suite is optional
  and reversible per file.
