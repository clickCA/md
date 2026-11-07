# ADR: AI agent panel runs the user's coding-agent CLI in the vault

Date: 2026-11-06
Status: accepted
Scope: md-app (Tauri command layer + React), not vault-core

## Context

The product boundary previously excluded AI (`docs/RUN-PRODUCT.md` §7). The vault
is plain Markdown files in a directory the user already owns and edits with other
tools, so the natural "AI" is not a bespoke assistant but the user's own **coding
agent** — opencode, Claude Code, or codex — pointed at the vault folder. These
CLIs already solve the hard problems (prompting, tool use, file edits, auth); the
app should be a thin, streaming client for them, not a reimplementation.

Open questions this record settles: does the agent get its own auth? Which CLI
flags? What happens to the files it changes? Where does the panel live?

## Decision

1. **Run the user's installed CLI as a subprocess, non-interactively.** Quire
   spawns `opencode run` / `codex exec` / `claude -p` with the vault root as the
   working directory, and streams stdout/stderr over a Tauri `Channel` to the UI.
   One run at a time; a stop button kills the child and the run resolves
   `status: "cancelled"`. Commands live in `commands/agent.rs`; the React panel
   (`components/quire/AgentPanel.tsx`) is a right-side pane like the Inspector,
   toggled from the header or `Ctrl Shift A`.

2. **Auth stays entirely with the CLI.** opencode/codex/Claude Code read their own
   credentials from the user's HOME. Quire never stores or forwards API keys,
   models, or auth state — nothing new to leak, and the app works the moment the
   user has already signed in to the CLI from a terminal.

3. **Agent edits are ordinary working-tree changes.** The agent mutates files in
   the vault; `changedFiles` is derived from `git status --porcelain` after the
   run and surfaced as clickable chips filtered against the current vault file
   set. From there the existing source-control panel and sync flow take over —
   no special commit path, same crash/conflict guarantees. This is why the agent
   backend is a command-layer concern, not a vault-core one: `vault-core` must
   stay UI- and process-free.

4. **Permissions default to "can edit files" only.** `autoApprove` maps to each
   CLI's non-interactive flag (`opencode --auto`, `codex --full-auto`,
   `claude --permission-mode bypassPermissions`); without it, Claude Code still
   edits existing files (`acceptEdits`) while Bash/git stays denied. Running a
   coding agent against a user-owned repository carries the same trust as running
   the CLI yourself in that directory — the panel defaults the toggle on and
   labels it.

5. **Session continuity is best-effort per provider.** Claude Code returns an
   explicit `session_id` (from its `result` event) that we resume with
   `--resume`; opencode stamps every `--format json` event with a `sessionID`,
   which we harvest the same way and resume precisely with `--session`; codex
   continues its most recent session in the directory (`--continue`). "New
   session" forgets all of them. Fine for a panel where the agent's own memory
   is secondary to file state.

6. **The stream is normalized to text *and* tool-call activity.** `claude -p
   --output-format stream-json` and `opencode run --format json` both emit
   JSONL; Rust parsers (`parse_claude_line`, `parse_opencode_line`) turn them
   into two event kinds — `output` (assistant text) and `tool` (name + short
   detail: file path, command, pattern). The panel renders the latter as a
   compact activity log. codex is left streaming raw lines (see limits).

7. **No new bundling or runtime deps.** PATH discovery is a pure probe
   (`split_path`/`find_in_path`, unit-tested), so installing an agent later is
   enough — the panel refreshes its detection on open. No sidecars, no shell
   plugin, no `Cargo.toml` changes beyond none.

## Consequences

- **The one deliberate process boundary.** Everywhere else the app never spawns
  git; here it intentionally launches the user's coding agent. Scoped to
  `commands/agent.rs`, documented in `docs/api.md`. The binary name is fixed per
  provider (no shell interpolation), so there is no command-injection surface.
- The 60-second tour and §7 exclusions in `docs/RUN-PRODUCT.md` are updated: AI is
  now a client integration, not a subscription feature.
- Claude's `stream-json` and opencode's `--format json` output are normalized in
  Rust (`parse_claude_line`, `parse_opencode_line`, tested) into text + tool-call
  events; codex streams raw lines.
- Learned flag facts are pinned by tests: `opencode run --format json
  [-c|--session <id>] [--auto] <msg>`, `claude -p [--resume <id>]
  [--permission-mode …] --output-format stream-json --verbose
  --include-partial-messages` (`--verbose` is *required* by `-p` +
  `stream-json` — without it the CLI exits with an error), `codex exec
  [--continue] [--full-auto] <msg>`. `codex` was not installable to verify
  interactively during this change — its flags are best-effort and marked so
  in the provider table.
- Known limits: multi-turn runs spawn a fresh process per turn (no persistent
  terminal); codex (uninstalled at decision time) shows raw text only, no
  structured tool calls; opencode text events arrive per completed segment, not
  per token.
