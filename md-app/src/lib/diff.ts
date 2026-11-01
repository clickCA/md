/* Line diff for the source-control diff viewer. Compares a note's committed
   content against the working copy and groups the result into git-style
   hunks. Dependency-free: notes are small, so an LCS table with a size
   fallback beats pulling in a diff library. */

export type DiffType = "add" | "del" | "ctx";

export type DiffRow = {
  type: DiffType;
  text: string;
  /** 1-based line number in the committed file (null for added lines). */
  oldNo: number | null;
  /** 1-based line number in the working copy (null for deleted lines). */
  newNo: number | null;
};

export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  rows: DiffRow[];
};

export type DiffStat = { additions: number; deletions: number };

/** Lines of unchanged context shown around each change cluster. */
const CONTEXT = 3;
/** Cap on LCS table cells before falling back to one coarse replace block. */
const MAX_DP_CELLS = 4_000_000;

type Op = { type: DiffType; text: string };

/** Longest-common-subsequence alignment of two line arrays. */
function lcsOps(a: string[], b: string[]): Op[] {
  // Trim the common prefix and suffix so the DP table only covers the
  // changed middle section — identical files cost O(1).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "ctx", text: a[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_DP_CELLS) {
    // Too big to align precisely — emit one coarse replace block.
    for (const text of midA) ops.push({ type: "del", text });
    for (const text of midB) ops.push({ type: "add", text });
  } else {
    const n = midA.length;
    const m = midB.length;
    // table[i*(m+1)+j] = LCS length of midA[i..] and midB[j..]
    const table = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[at(i, j)] =
          midA[i] === midB[j]
            ? table[at(i + 1, j + 1)] + 1
            : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: "ctx", text: midA[i] });
        i++;
        j++;
      } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
        ops.push({ type: "del", text: midA[i++] });
      } else {
        ops.push({ type: "add", text: midB[j++] });
      }
    }
    while (i < n) ops.push({ type: "del", text: midA[i++] });
    while (j < m) ops.push({ type: "add", text: midB[j++] });
  }

  for (let k = endA; k < a.length; k++) ops.push({ type: "ctx", text: a[k] });
  return ops;
}

/** Full row-by-row alignment of two texts (no hunk grouping). */
export function diffRows(oldText: string, newText: string): DiffRow[] {
  // An empty string means "no lines" (a new or deleted file) — git
  // semantics — not a single empty line.
  if (oldText === "" && newText === "") return [];
  if (oldText === "")
    return numberOps(newText.split("\n").map((text) => ({ type: "add" as const, text })));
  if (newText === "")
    return numberOps(oldText.split("\n").map((text) => ({ type: "del" as const, text })));
  return numberOps(lcsOps(oldText.split("\n"), newText.split("\n")));
}

function numberOps(ops: Op[]): DiffRow[] {
  let oldNo = 0;
  let newNo = 0;
  return ops.map((op) => {
    if (op.type === "del") return { ...op, oldNo: ++oldNo, newNo: null };
    if (op.type === "add") return { ...op, oldNo: null, newNo: ++newNo };
    oldNo++;
    newNo++;
    return { ...op, oldNo, newNo };
  });
}

/** git-style hunks: changed rows clustered with CONTEXT lines around them. */
export function diffLines(oldText: string, newText: string): Hunk[] {
  const rows = diffRows(oldText, newText);
  const changed = rows.flatMap((r, i) => (r.type === "ctx" ? [] : [i]));
  if (changed.length === 0) return [];

  // Grow each change cluster by CONTEXT on both sides; clusters whose
  // expansions touch share one hunk.
  const ranges: [number, number][] = [];
  let lo = Math.max(0, changed[0] - CONTEXT);
  let hi = Math.min(rows.length, changed[0] + CONTEXT + 1);
  for (const idx of changed.slice(1)) {
    if (idx - CONTEXT <= hi) {
      hi = Math.min(rows.length, idx + CONTEXT + 1);
    } else {
      ranges.push([lo, hi]);
      lo = Math.max(0, idx - CONTEXT);
      hi = Math.min(rows.length, idx + CONTEXT + 1);
    }
  }
  ranges.push([lo, hi]);

  return ranges.map(([start, end]) => {
    const slice = rows.slice(start, end);
    // The row before a range is always context (or nothing), so its numbers
    // tell us where the hunk begins in each file.
    const before = start > 0 ? rows[start - 1] : null;
    let oldStart = (before?.oldNo ?? 0) + 1;
    let newStart = (before?.newNo ?? 0) + 1;
    // git numbers the empty side of a new/deleted file from 0.
    if (oldText === "") oldStart = 0;
    if (newText === "") newStart = 0;
    return {
      oldStart,
      oldLines: slice.filter((r) => r.type !== "add").length,
      newStart,
      newLines: slice.filter((r) => r.type !== "del").length,
      rows: slice,
    };
  });
}

export function diffStat(hunks: Hunk[]): DiffStat {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const r of h.rows) {
      if (r.type === "add") additions++;
      else if (r.type === "del") deletions++;
    }
  }
  return { additions, deletions };
}

export function hunkHeader(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}
