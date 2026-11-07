/**
 * "Ask your notes" — retrieval context + citation logic (pure, unit-tested).
 *
 * Retrieval rides the existing FTS5 search (ADR 2026-10-30-search-index):
 * top-K hits become numbered sources with real excerpts, the model answers
 * from ONLY those excerpts, and citations are accurate by construction
 * because the source list is what WE fed the model — not what it claims.
 * Excluded folders can never appear: search and note contents are already
 * the app's filtered view.
 */

export const ASK_TOP_K = 5;
/** Max excerpt characters per source. */
export const EXCERPT_CHARS = 1200;
/** Max total context characters across all sources. */
export const CONTEXT_CHARS = 8000;

export interface AskHit {
  path: string;
  matches: { line: number; snippet: string }[];
}

export interface AskSource {
  /** 1-based citation number, stable within one question. */
  n: number;
  path: string;
  /** 1-based line of the first match in this note. */
  line: number;
  excerpt: string;
}

export const ASK_INSTRUCTION =
  "Answer the user's question using ONLY the numbered note excerpts below. " +
  "Cite sources inline as [1], [2] after the claims they support. If the " +
  "excerpts do not contain the answer, reply with exactly: " +
  "NOT ENOUGH INFORMATION. Answer in the excerpts' language. " +
  "Do not use tools; return only the answer text.";

/** A content read failure must not sink the whole answer — skip that note. */
export type ContentLookup = (path: string) => Promise<string | null>;

/**
 * Retrieve context for a question: the top-K search hits, each excerpted
 * around its first match from the note's real content. Sources are numbered
 * in retrieval order — this exact list is what the UI renders as citations.
 */
export async function retrieveSources(
  hits: AskHit[],
  lookup: ContentLookup,
  topK = ASK_TOP_K,
): Promise<AskSource[]> {
  const sources: AskSource[] = [];
  for (const hit of hits.slice(0, topK)) {
    const first = hit.matches[0];
    if (!first) continue;
    const content = await lookup(hit.path);
    if (content === null) continue;
    sources.push({
      n: sources.length + 1,
      path: hit.path,
      line: first.line,
      excerpt: excerptAround(content, first.line, EXCERPT_CHARS),
    });
  }
  return sources;
}

/** Build the fenced context block sent to the model (budget-capped). */
export function buildContext(sources: AskSource[], budget = CONTEXT_CHARS): string {
  const parts: string[] = [];
  let used = 0;
  for (const s of sources) {
    const header = `--- [${s.n}] ${s.path}:${s.line} ---`;
    const body = s.excerpt.slice(0, Math.max(0, budget - used - header.length - 2));
    if (body.length <= 0) break;
    used += header.length + body.length + 2;
    parts.push(`${header}\n${body}`);
  }
  return parts.join("\n\n");
}

/** The excerpt around `line` (1-based), char-bounded, with line markers. */
export function excerptAround(content: string, line: number, maxChars: number): string {
  const lines = content.split("\n");
  const idx = Math.min(Math.max(line - 1, 0), lines.length - 1);
  const out: string[] = [];
  let used = 0;
  // Walk outward from the match line, alternating up/down, until the
  // character budget or the note bounds are hit.
  let lo = idx;
  let hi = idx;
  while (lo > 0 || hi < lines.length - 1) {
    const up = lo > 0 ? lines[lo - 1] : null;
    const down = hi < lines.length - 1 ? lines[hi + 1] : null;
    const next = up !== null && (down === null || idx - lo <= hi - idx) ? up : down;
    if (next === null) break;
    if (used + next.length + 1 > maxChars) break;
    used += next.length + 1;
    if (next === up) {
      lo--;
      out.unshift(lines[lo]);
    } else {
      hi++;
      out.push(lines[hi]);
    }
  }
  out.splice(idx - lo, 0, lines[idx]);
  return out.join("\n");
}
