import { describe, expect, it } from "vitest";
import {
  captureSelection,
  isStale,
  planApply,
  suggestionDiff,
  REWRITE_INSTRUCTION,
} from "./ai-selection";

const DOC = "Alpha paragraph.\n\nBeta paragraph.\n";
const req = captureSelection(DOC, 0, 17, REWRITE_INSTRUCTION)!;

describe("captureSelection", () => {
  it("captures the document, range, and original text", () => {
    expect(req).not.toBeNull();
    expect(req!.doc).toBe(DOC);
    expect(req!.from).toBe(0);
    expect(req!.to).toBe(17);
    expect(req!.original).toBe("Alpha paragraph.\n");
    expect(req!.instruction).toBe(REWRITE_INSTRUCTION);
  });

  it("rejects empty selections", () => {
    expect(captureSelection(DOC, 5, 5, REWRITE_INSTRUCTION)).toBeNull();
    expect(captureSelection(DOC, 10, 3, REWRITE_INSTRUCTION)).toBeNull();
  });
});

describe("isStale — the edit-paragraph-B guard", () => {
  it("is fresh while the document is untouched", () => {
    expect(isStale(req, DOC)).toBe(false);
  });

  it("goes stale on ANY edit elsewhere in the document", () => {
    const edited = "Alpha paragraph.\n\nBeta paragraph EDITED.\n";
    expect(isStale(req, edited)).toBe(true);
  });
});

describe("planApply", () => {
  it("plans a replacement of exactly the captured range on a fresh document", () => {
    const plan = planApply(req, DOC, "Alpha, rewritten.");
    expect(plan).toEqual({ ok: true, from: 0, to: 17, insert: "Alpha, rewritten." });
  });

  it("refuses with stale when the document changed — never merges", () => {
    const edited = "Alpha paragraph.\n\nBeta paragraph EDITED.\n";
    const plan = planApply(req, edited, "Alpha, rewritten.");
    expect(plan).toEqual({ ok: false, stale: true });
  });

  it("keeps paragraph B intact when applied", () => {
    const plan = planApply(req, DOC, "Alpha, rewritten.\n");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = DOC.slice(0, plan.from) + plan.insert + DOC.slice(plan.to);
    expect(next).toBe("Alpha, rewritten.\n\nBeta paragraph.\n");
  });
});

describe("suggestionDiff", () => {
  it("produces add/del rows for changed lines", () => {
    const hunks = suggestionDiff("old line\n", "new line\n");
    expect(hunks.length).toBe(1);
    const types = hunks[0].rows.map((r) => r.type);
    expect(types).toContain("del");
    expect(types).toContain("add");
  });

  it("produces no hunks when the suggestion equals the original", () => {
    expect(suggestionDiff("same\n", "same\n")).toEqual([]);
  });
});
