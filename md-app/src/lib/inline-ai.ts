/**
 * Inline AI — the narrow editor surface from
 * `docs/adr/2026-11-06-inline-ai-surface.md`: single-selection text
 * operations whose candidate is previewed as a diff and applied only on an
 * explicit Accept. Prompt building, fence unwrapping, and the stale check
 * are pure TypeScript so they are testable without Tauri.
 */

export type InlineAiOp = "rewrite" | "grammar" | "continue" | "summarize";

export const INLINE_AI_LABEL: Record<InlineAiOp, string> = {
  rewrite: "Rewrite",
  grammar: "Fix grammar",
  continue: "Continue writing",
  summarize: "Summarize",
};

const TASK: Record<InlineAiOp, string> = {
  rewrite:
    "Rewrite the selection below to be clearer and better structured. Preserve its meaning, voice, reading level, and markdown formatting.",
  grammar:
    "Fix grammar, spelling and punctuation in the selection below. Do not otherwise change the wording or formatting.",
  continue:
    "Continue writing naturally from where the selection below ends. Write 2-4 sentences that flow from it, then stop. Output only the new continuation — do not repeat the selection.",
  summarize: "Summarize the selection below in 1-3 concise sentences.",
};

/**
 * The per-operation instruction sent to `ai_text`. The command layer composes
 * the full prompt (instruction + context-as-data fencing + the reply-only
 * contract), so this stays a plain task sentence.
 */
export function instructionFor(op: InlineAiOp): string {
  return TASK[op];
}

/**
 * Models like to wrap even plain-prose replies in code fences. Unwrap one
 * outer fence — unless the selection itself is fenced code, in which case a
 * fence in the reply may be meaningful, so the candidate is returned as-is.
 */
export function unwrapCandidate(candidate: string, selection: string): string {
  const trimmed = candidate.trim();
  const selectionFenced = selection.trimStart().startsWith("```");
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (!fence || selectionFenced) return candidate;
  return fence[1];
}

/**
 * The version guard from the ADR: a proposal is stale when the document
 * changed since the request captured its (version, span). Stale proposals
 * are never applied — the UI offers re-diff (regenerate) or discard.
 */
export function isProposalStale(requestVersion: number, currentVersion: number): boolean {
  return requestVersion !== currentVersion;
}
