/**
 * Selection-AI lifecycle — pure state, no editor imports (unit-testable).
 *
 * The version guard is the plan's "edit paragraph B while AI rewrites A"
 * guarantee: a suggestion may only be applied against the exact document it
 * was requested from. The captured (doc, range) pair is the source of truth —
 * NOT the live selection, which may have collapsed or moved while the model
 * was thinking. Any content change since the request makes the result stale
 * and it is refused (never auto-merged, never clobbered); Regenerate re-runs
 * against a fresh capture.
 */

import { diffLines, type Hunk } from "@/lib/diff";

export const REWRITE_INSTRUCTION =
  "Rewrite the given text for clarity and flow. Preserve its meaning, " +
  "language, and Markdown formatting. Return only the rewritten text.";

/** A selection-scoped AI request, captured when the request starts. */
export interface AiRequest {
  /** Full document text at request start — the version guard baseline. */
  doc: string;
  /** Captured selection range (character offsets into `doc`). */
  from: number;
  to: number;
  /** `doc.slice(from, to)` — what the model was given as context. */
  original: string;
  instruction: string;
}

export function captureSelection(
  doc: string,
  from: number,
  to: number,
  instruction: string,
): AiRequest | null {
  if (from >= to) return null;
  return { doc, from, to, original: doc.slice(from, to), instruction };
}

/** Did the document change since the request started? */
export function isStale(req: AiRequest, currentDoc: string): boolean {
  return currentDoc !== req.doc;
}

export type ApplyPlan =
  { ok: true; from: number; to: number; insert: string } | { ok: false; stale: true };

/** Where the suggestion would go in the *current* document — or stale. */
export function planApply(req: AiRequest, currentDoc: string, suggestion: string): ApplyPlan {
  if (currentDoc !== req.doc) return { ok: false, stale: true };
  return { ok: true, from: req.from, to: req.to, insert: suggestion };
}

/**
 * Keep the captured selection's outer newlines. A trimmed model reply would
 * otherwise merge the rewritten paragraph into the following line: when the
 * selection ends (or starts) with a newline, the suggestion must too.
 */
export function normalizeSuggestion(original: string, suggestion: string): string {
  const trimmed = suggestion.trim();
  if (!trimmed) return "";
  let out = trimmed;
  if (original.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  if (original.startsWith("\n") && !out.startsWith("\n")) out = `\n${out}`;
  return out;
}

/** The preview diff shown while reviewing: original selection → suggestion. */
export function suggestionDiff(original: string, suggestion: string): Hunk[] {
  return diffLines(original, suggestion);
}
