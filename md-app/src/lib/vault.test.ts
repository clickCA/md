import { describe, expect, it } from "vitest";
import { relatedNotes, remoteName, sanitizeVaultName } from "./vault";

describe("remoteName", () => {
  it("derives owner-repo from a GitHub URL", () => {
    expect(remoteName("https://github.com/clickCA/md.git")).toBe("clickCA-md");
  });

  it("works without a trailing .git", () => {
    expect(remoteName("https://gitlab.com/group/sub/project")).toBe("sub-project");
  });

  it("falls back to the repo for a bare URL", () => {
    expect(remoteName("https://example.com/repo")).toBe("example.com-repo");
  });

  it("returns empty for junk", () => {
    expect(remoteName("   ")).toBe("");
  });
});

describe("sanitizeVaultName", () => {
  it("makes a typed name filesystem-safe", () => {
    expect(sanitizeVaultName("My Notes")).toBe("My-Notes");
    expect(sanitizeVaultName(" a  b ")).toBe("a-b");
  });

  it("blocks path traversal", () => {
    expect(sanitizeVaultName("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeVaultName("../..")).toBe("vault");
  });

  it("falls back to vault for empty input", () => {
    expect(sanitizeVaultName("   ")).toBe("vault");
    expect(sanitizeVaultName("...")).toBe("vault");
  });
});

describe("relatedNotes", () => {
  const note = (path: string, content: string) => ({ path, content, committed: null });

  it("ranks notes sharing wikilink targets above mere term overlap", () => {
    const target = note("notes/alpha.md", "Discusses [[Shared Topic]] and graph databases.");
    const linked = note("notes/linked.md", "Also about [[Shared Topic]] entirely.");
    const words = note(
      "notes/words.md",
      "Discusses graph databases repeatedly. Graph databases scale well for graph workloads.",
    );
    const unrelated = note("notes/other.md", "A recipe for sourdough bread.");
    const files = [target, linked, words, unrelated];

    const related = relatedNotes(files, "notes/alpha.md", 5);
    expect(related[0]).toBe(linked);
    expect(related).toContain(words);
    expect(related).not.toContain(unrelated);
  });

  it("counts a direct link in either direction", () => {
    const target = note("notes/a.md", "Root note.");
    const child = note("notes/b.md", "Expands on [[a]] in depth.");
    const parent = note("notes/c.md", "");
    const files = [target, child, { ...parent, content: "The index links back to [[a]]." }];

    const related = relatedNotes(files, "notes/a.md", 5);
    expect(related).toContain(child);
    expect(related.some((f) => f.path === "notes/c.md")).toBe(true);
  });

  it("normalizes link targets (path, alias, anchor, case)", () => {
    const target = note("notes/Alpha.md", "Sees [[Projects/Roadmap]] and [[Daily|today]].");
    const other = note("notes/linked.md", "Reads [[roadmap#section]] and [[daily]].");
    const files = [target, other];

    expect(relatedNotes(files, "notes/Alpha.md")).toEqual([other]);
  });

  it("never includes the note itself and respects the limit", () => {
    const files = [
      note("notes/a.md", "Term alpha term beta term gamma."),
      note("notes/b.md", "Term alpha term beta term gamma."),
      note("notes/c.md", "Term alpha term beta term gamma."),
      note("notes/d.md", "Term alpha term beta term gamma."),
    ];
    const related = relatedNotes(files, "notes/a.md", 2);
    expect(related.length).toBe(2);
    expect(related.every((f) => f.path !== "notes/a.md")).toBe(true);
  });

  it("returns nothing for a note with no connections", () => {
    const files = [
      note("notes/a.md", "Unique content here."),
      note("notes/b.md", "Completely different words appear."),
    ];
    expect(relatedNotes(files, "notes/a.md")).toEqual([]);
    expect(relatedNotes(files, "notes/missing.md")).toEqual([]);
  });
});
