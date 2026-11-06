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

/** How far the context window reaches back for insertion-style requests. */
export const CONTEXT_TAIL_CHARS = 2000;

/** A selection-scoped AI request, captured when the request starts. */
export interface AiRequest {
  /** Full document text at request start — the version guard baseline. */
  doc: string;
  /** Captured edit range (character offsets into `doc`). */
  from: number;
  to: number;
  /** What the model was given as context (the selection, or the tail before an insertion point). */
  original: string;
  instruction: string;
  /** Card label, e.g. "Rewrite" — the preset that produced this request. */
  label: string;
  /** Text sent to the model as `context` (defaults to `original`). */
  context?: string;
}

/** The built-in presets. `kind: "select"` rewrites the selection; `kind: "insert"` continues at its end. */
export interface AiAction {
  id: "rewrite" | "improve" | "summarize" | "continue";
  label: string;
  /** Present-progressive for the generating card, e.g. "Rewriting…". */
  running: string;
  instruction: string;
  kind: "select" | "insert";
}

export const AI_ACTIONS: AiAction[] = [
  {
    id: "rewrite",
    label: "Rewrite",
    running: "Rewriting…",
    instruction:
      "Rewrite the given text for clarity and flow. Preserve its meaning, " +
      "language, and Markdown formatting. Return only the rewritten text.",
    kind: "select",
  },
  {
    id: "improve",
    label: "Improve writing",
    running: "Improving…",
    instruction:
      "Improve the given text: fix grammar, clarity, and flow. Preserve its " +
      "meaning, language, and Markdown formatting (code fences and tables " +
      "stay intact). Return only the improved text.",
    kind: "select",
  },
  {
    id: "summarize",
    label: "Summarize",
    running: "Summarizing…",
    instruction:
      "Summarize the given text as a concise Markdown paragraph, or a short " +
      "bullet list if that fits better. Keep the same language. Return only " +
      "the summary.",
    kind: "select",
  },
  {
    id: "continue",
    label: "Continue writing",
    running: "Continuing…",
    instruction:
      "Continue writing the given text naturally, matching its language, " +
      "tone, and Markdown style. Return only the continuation — do not " +
      "repeat the given text.",
    kind: "insert",
  },
];

export function actionById(id: AiAction["id"]): AiAction {
  const found = AI_ACTIONS.find((a) => a.id === id);
  if (!found) throw new Error(`unknown AI action: ${id}`);
  return found;
}

/**
 * Capture a request against `(doc, from, to)`. For `kind: "select"` the
 * range must be non-empty and the model's context is the selection; for
 * `kind: "insert"` (continue) the range is the empty insertion point at the
 * selection's end and the context is the text tail before it.
 */
export function makeRequest(
  doc: string,
  from: number,
  to: number,
  action: AiAction,
): AiRequest | null {
  if (action.kind === "select" && from >= to) return null;
  const clampedFrom = Math.max(0, Math.min(from, doc.length));
  const clampedTo = Math.max(clampedFrom, Math.min(to, doc.length));
  // Insert presets (continue) collapse to an empty range right after the
  // last non-whitespace character of the selection — a pure insertion point
  // that reads as "keep writing here" — and read context from the text tail
  // before it, so the model knows what to continue.
  let reqFrom = clampedFrom;
  let reqTo = clampedTo;
  if (action.kind === "insert") {
    reqFrom = clampedTo;
    while (reqFrom > 0 && /\s/.test(doc[reqFrom - 1])) reqFrom--;
    reqFrom = Math.max(reqFrom, clampedFrom);
    reqTo = reqFrom; // empty range: a pure insertion point
  }
  const original = doc.slice(reqFrom, reqTo);
  const context =
    action.kind === "insert"
      ? doc.slice(Math.max(0, reqFrom - CONTEXT_TAIL_CHARS), reqFrom)
      : original;
  return {
    doc,
    from: reqFrom,
    to: reqTo,
    original,
    instruction: action.instruction,
    label: action.label,
    context,
  };
}

/** Selection-capture helper kept for the rewrite-only flow and tests. */
export function captureSelection(
  doc: string,
  from: number,
  to: number,
  instruction: string,
): AiRequest | null {
  if (from >= to) return null;
  const req = makeRequest(doc, from, to, {
    ...AI_ACTIONS[0],
    instruction,
  });
  return req ? { ...req, label: "AI suggestion" } : null;
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
 *
 * Insertion requests (`keepLeading`) are different: the reply lands between
 * two existing characters, so its leading whitespace is meaningful ("…end. "
 + " Continued…") and only the trailing run is dropped.
 */
export function normalizeSuggestion(
  original: string,
  suggestion: string,
  { keepLeading = false }: { keepLeading?: boolean } = {},
): string {
  let out = keepLeading ? suggestion.replace(/\s+$/, "") : suggestion.trim();
  if (!out) return "";
  if (original.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  if (original.startsWith("\n") && !out.startsWith("\n")) out = `\n${out}`;
  return out;
}

/** The preview diff shown while reviewing: original selection → suggestion. */
export function suggestionDiff(original: string, suggestion: string): Hunk[] {
  return diffLines(original, suggestion);
}
