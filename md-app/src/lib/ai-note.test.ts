import { describe, expect, it } from "vitest";
import { buildNoteInstruction, notePathFromContent } from "./ai-note";

describe("buildNoteInstruction", () => {
  it("carries the description and the shape of a good note", () => {
    const instruction = buildNoteInstruction("  meeting template  ");
    expect(instruction).toContain("Description: meeting template");
    expect(instruction).toContain("H1 title");
  });
});

describe("notePathFromContent", () => {
  it("uses the first H1 as the file name", () => {
    expect(notePathFromContent("# Weekly Sync\n\nbody", [])).toBe("Weekly Sync.md");
  });

  it("falls back to Untitled without a heading", () => {
    expect(notePathFromContent("just some text", [])).toBe("Untitled.md");
  });

  it("strips characters that are unsafe in file names", () => {
    expect(notePathFromContent("# Ideas: 2026/2027 *draft*?", [])).toBe(
      "Ideas- 2026-2027 draft.md",
    );
  });

  it("uniquifies against existing notes", () => {
    const existing = ["Weekly Sync.md", "Weekly Sync-2.md"];
    expect(notePathFromContent("# Weekly Sync\n\nx", existing)).toBe("Weekly Sync-3.md");
  });

  it("matches existing paths case-insensitively", () => {
    expect(notePathFromContent("# weekly sync", ["Weekly Sync.md"])).toBe("weekly sync-2.md");
  });

  it("caps long titles", () => {
    const path = notePathFromContent("# " + "a".repeat(200), []);
    expect(path.length).toBeLessThanOrEqual(61 + 3);
  });
});
