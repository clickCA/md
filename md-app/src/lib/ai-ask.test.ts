import { describe, expect, it } from "vitest";
import { parseCitations, resolveCitations } from "./ai-ask";

describe("parseCitations", () => {
  it("extracts path and line, unique by path, in first-appearance order", () => {
    const answer =
      "Keep one trusted system [notes/gtd.md:3]. The weekly review [notes/gtd.md:7] keeps it current. Also see [notes/inbox.md].";
    expect(parseCitations(answer)).toEqual([
      { path: "notes/gtd.md", line: 3 },
      { path: "notes/inbox.md", line: null },
    ]);
  });

  it("ignores bracketed text that is not a markdown path", () => {
    expect(parseCitations("see [1] and [note] and [TODO: fix]")).toEqual([]);
  });

  it("drops citations whose line number is not a positive integer", () => {
    expect(parseCitations("[notes/a.md:0] [notes/b.md:x]")).toEqual([
      { path: "notes/a.md", line: null },
    ]);
  });
});

describe("resolveCitations", () => {
  const files = [{ path: "notes/gtd.md" }, { path: "notes/inbox.md" }];

  it("keeps only citations whose note exists (case-insensitive)", () => {
    const citations = [
      { path: "notes/gtd.md", line: 3 },
      { path: "Notes/INBOX.md", line: null },
      { path: "notes/deleted.md", line: 2 },
    ];
    expect(resolveCitations(citations, files)).toEqual([
      { path: "notes/gtd.md", line: 3 },
      { path: "Notes/INBOX.md", line: null },
    ]);
  });
});
