/**
 * Ask-your-notes frontend helpers: citation parsing for the retrieval Q&A
 * surface. The backend instructs the model to cite claims inline as
 * `[note-path:line]`; these helpers turn an answer into clickable,
 * vault-filtered citations.
 */

export interface Citation {
  path: string;
  /** 1-based line number, when the model supplied one. */
  line: number | null;
}

const CITATION = /\[([^[\]\n]+\.md)(?::(\d+))?\]/g;

/** Unique citations in first-appearance order. */
export function parseCitations(answer: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const m of answer.matchAll(CITATION)) {
    const path = m[1].trim();
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const line = m[2] !== undefined ? Number(m[2]) : null;
    out.push({ path, line: line !== null && Number.isFinite(line) && line > 0 ? line : null });
  }
  return out;
}

/** Citations that point at notes that actually exist in the vault. */
export function resolveCitations(citations: Citation[], files: { path: string }[]): Citation[] {
  const known = new Set(files.map((f) => f.path.toLowerCase()));
  return citations.filter((c) => known.has(c.path.toLowerCase()));
}
