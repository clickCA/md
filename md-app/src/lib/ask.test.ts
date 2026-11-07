import { describe, expect, it, vi } from "vitest";
import { buildContext, excerptAround, retrieveSources, ASK_INSTRUCTION, ASK_TOP_K } from "./ask";
import type { AskHit } from "./ask";

const CONTENT = [
  "intro line", // 1
  "filler one", // 2
  "the sync engine commits notes", // 3  ← match line
  "filler two", // 4
  "tail line", // 5
].join("\n");

const hits: AskHit[] = [
  { path: "notes/sync.md", matches: [{ line: 3, snippet: "sync engine" }] },
  { path: "notes/other.md", matches: [{ line: 1, snippet: "sync" }] },
];

describe("retrieveSources", () => {
  it("numbers sources in retrieval order with real excerpts", async () => {
    const lookup = vi.fn(async (path: string) => (path === "notes/sync.md" ? CONTENT : "x"));
    const sources = await retrieveSources(hits, lookup, 5);
    expect(sources.length).toBe(2);
    expect(sources[0]).toMatchObject({ n: 1, path: "notes/sync.md", line: 3 });
    expect(sources[0].excerpt).toContain("the sync engine commits notes");
    expect(sources[1].n).toBe(2);
  });

  it("caps retrieval at topK", async () => {
    const many: AskHit[] = Array.from({ length: 12 }, (_, i) => ({
      path: `n${i}.md`,
      matches: [{ line: 1, snippet: "x" }],
    }));
    const sources = await retrieveSources(many, async () => "content", ASK_TOP_K);
    expect(sources.length).toBe(ASK_TOP_K);
  });

  it("skips notes that cannot be read instead of failing", async () => {
    const lookup = vi.fn(async (path: string) => (path === "notes/sync.md" ? CONTENT : null));
    const sources = await retrieveSources(hits, lookup, 5);
    expect(sources.length).toBe(1);
    expect(sources[0].path).toBe("notes/sync.md");
  });

  it("keeps sources with no matches out of the list", async () => {
    const sources = await retrieveSources([{ path: "a.md", matches: [] }], async () => "x", 5);
    expect(sources).toEqual([]);
  });
});

describe("buildContext", () => {
  it("marks each source with its [n] path:line header", async () => {
    const sources = await retrieveSources(hits, async () => CONTENT, 5);
    const ctx = buildContext(sources);
    expect(ctx).toContain("[1] notes/sync.md:3");
    expect(ctx).toContain("[2] notes/other.md:1");
    expect(ctx).toContain("the sync engine commits notes");
  });

  it("respects the total character budget", async () => {
    const big = "x".repeat(2000);
    const many: AskHit[] = Array.from({ length: 10 }, (_, i) => ({
      path: `n${i}.md`,
      matches: [{ line: 1, snippet: "x" }],
    }));
    const sources = await retrieveSources(many, async () => big, 10);
    const ctx = buildContext(sources, 5000);
    expect(ctx.length).toBeLessThanOrEqual(5100);
  });
});

describe("excerptAround", () => {
  it("centers the excerpt on the match line", () => {
    const ex = excerptAround(CONTENT, 3, 200);
    expect(ex).toContain("the sync engine commits notes");
    expect(ex.split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("clamps out-of-range lines", () => {
    expect(excerptAround(CONTENT, 99, 100)).toContain("tail line");
    expect(excerptAround(CONTENT, 0, 100)).toContain("intro line");
  });

  it("respects the character budget", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} ${"y".repeat(80)}`).join("\n");
    const ex = excerptAround(long, 250, 600);
    expect(ex.length).toBeLessThanOrEqual(700);
  });

  it("the instruction demands honesty and citations", () => {
    expect(ASK_INSTRUCTION).toContain("ONLY");
    expect(ASK_INSTRUCTION).toContain("[1]");
    expect(ASK_INSTRUCTION).toContain("NOT ENOUGH INFORMATION");
  });
});
