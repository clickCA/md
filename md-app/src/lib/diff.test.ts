import { describe, expect, it } from "vitest";
import { diffLines, diffRows, diffStat, hunkHeader } from "./diff";

describe("diffLines", () => {
  it("returns no hunks for identical text", () => {
    expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("treats an empty old file as all additions", () => {
    const hunks = diffLines("", "# Title\n\nbody");
    expect(hunks).toHaveLength(1);
    expect(hunkHeader(hunks[0])).toBe("@@ -0,0 +1,3 @@");
    expect(hunks[0].rows.every((r) => r.type === "add")).toBe(true);
  });

  it("treats an emptied file as all deletions", () => {
    const hunks = diffLines("a\nb", "");
    expect(hunks).toHaveLength(1);
    expect(hunkHeader(hunks[0])).toBe("@@ -1,2 +0,0 @@");
    expect(hunks[0].rows.map((r) => r.type)).toEqual(["del", "del"]);
  });

  it("marks a middle edit with surrounding context", () => {
    const hunks = diffLines("one\ntwo\nthree", "one\nTwo\nthree");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].rows.map((r) => `${r.type}:${r.text}`)).toEqual([
      "ctx:one",
      "del:two",
      "add:Two",
      "ctx:three",
    ]);
    expect(hunkHeader(hunks[0])).toBe("@@ -1,3 +1,3 @@");
  });

  it("numbers old and new lines correctly across a change", () => {
    const rows = diffRows("a\nb\nc", "a\nB1\nB2\nc");
    expect(rows).toEqual([
      { type: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { type: "del", text: "b", oldNo: 2, newNo: null },
      { type: "add", text: "B1", oldNo: null, newNo: 2 },
      { type: "add", text: "B2", oldNo: null, newNo: 3 },
      { type: "ctx", text: "c", oldNo: 3, newNo: 4 },
    ]);
  });

  it("splits distant edits into separate hunks", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    const next = lines.map((l, i) => (i === 0 ? "A" : i === 11 ? "L" : l));
    const hunks = diffLines(lines.join("\n"), next.join("\n"));
    expect(hunks).toHaveLength(2);
    expect(hunkHeader(hunks[0])).toBe("@@ -1,4 +1,4 @@");
    expect(hunkHeader(hunks[1])).toBe("@@ -9,4 +9,4 @@");
  });

  it("merges nearby edits into one hunk", () => {
    // Two changes only four lines apart: their context overlaps.
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const next = lines.map((l, i) => (i === 0 ? "A" : i === 5 ? "F" : l));
    const hunks = diffLines(lines.join("\n"), next.join("\n"));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].rows.some((r) => r.type === "add" && r.text === "A")).toBe(true);
    expect(hunks[0].rows.some((r) => r.type === "add" && r.text === "F")).toBe(true);
  });

  it("counts additions and deletions", () => {
    const stat = diffStat(diffLines("# T\n\n- old\n", "# T\n\n- new\n- extra\n"));
    expect(stat).toEqual({ additions: 2, deletions: 1 });
  });

  it("handles a trailing newline as its own empty line", () => {
    const stat = diffStat(diffLines("a\n", "a\nb\n"));
    expect(stat).toEqual({ additions: 1, deletions: 0 });
  });
});
