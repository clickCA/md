import { describe, expect, it } from "vitest";
import type { VaultFile } from "@/lib/vault";
import {
  buildSummaryContext,
  buildSummaryInstruction,
  folderLabel,
  folderNotes,
  summaryNotePath,
} from "./folder-summary";

const note = (path: string, content = `body of ${path}`): VaultFile => ({
  path,
  content,
  committed: content,
});

describe("folderNotes", () => {
  const files = [
    note("projects/alpha/one.md"),
    note("projects/alpha/deep/two.md"),
    note("projects/beta/three.md"),
    note("projects2/four.md"),
  ];

  it("includes nested notes and excludes siblings and prefix lookalikes", () => {
    expect(folderNotes(files, "projects/alpha").map((f) => f.path)).toEqual([
      "projects/alpha/one.md",
      "projects/alpha/deep/two.md",
    ]);
  });

  it("treats the empty folder as the whole vault", () => {
    expect(folderNotes(files, "")).toHaveLength(files.length);
  });

  it("does not match a folder name only as a path prefix segment", () => {
    // "projects2" must never be pulled into the "projects" folder.
    expect(folderNotes(files, "projects").map((f) => f.path)).not.toContain("projects2/four.md");
  });
});

describe("buildSummaryContext", () => {
  it("labels every note with its path and keeps whole notes only", () => {
    const files = [note("a/one.md", "first note"), note("a/two.md", "second note")];
    const context = buildSummaryContext(files, 10_000);
    expect(context.text).toContain("## a/one.md");
    expect(context.text).toContain("first note");
    expect(context.text).toContain("## a/two.md");
    expect(context.included).toBe(2);
    expect(context.total).toBe(2);
  });

  it("stops at the character budget instead of cutting a note in half", () => {
    const big = "x".repeat(80);
    const files = [note("a/one.md", big), note("a/two.md", big)];
    const context = buildSummaryContext(files, 120);
    expect(context.text).toContain("a/one.md");
    expect(context.text).not.toContain("a/two.md");
    expect(context.text.length).toBeLessThanOrEqual(120);
    expect(context.included).toBe(1);
    expect(context.total).toBe(2);
  });
});

describe("buildSummaryInstruction", () => {
  it("names the folder and the note count", () => {
    const instruction = buildSummaryInstruction("projects/alpha", 3);
    expect(instruction).toContain('"projects/alpha" folder');
    expect(instruction).toContain("3 note(s)");
    expect(instruction).toContain("only the provided notes");
  });

  it("labels the root as the vault", () => {
    expect(buildSummaryInstruction("", 2)).toContain("this vault");
  });

  it("admits when the context budget dropped notes", () => {
    expect(buildSummaryInstruction("projects/alpha", 8, 12)).toContain(
      "4 more note(s) are in scope but were not included",
    );
    expect(buildSummaryInstruction("projects/alpha", 8, 8)).not.toContain("Context limit");
  });
});

describe("summaryNotePath", () => {
  it("writes Summary.md inside the folder", () => {
    expect(summaryNotePath("projects/alpha", [])).toBe("projects/alpha/Summary.md");
  });

  it("uses a vault-level name at the root", () => {
    expect(summaryNotePath("", [])).toBe("Vault summary.md");
  });

  it("suffixes collisions case-insensitively", () => {
    const existing = ["projects/alpha/summary.md", "projects/alpha/Summary-2.md"];
    expect(summaryNotePath("projects/alpha", existing)).toBe("projects/alpha/Summary-3.md");
  });
});

describe("folderLabel", () => {
  it("names the root", () => {
    expect(folderLabel("")).toBe("Vault root");
    expect(folderLabel("notes")).toBe("notes");
  });
});
