import { describe, expect, it } from "vitest";
import { headingLevel, kindOf, listPrefix, parseBlocks, toggleTask } from "./blocks";

describe("blocks", () => {
  it("classifies block kinds", () => {
    expect(kindOf("# Title")).toBe("heading");
    expect(kindOf("- item")).toBe("list");
    expect(kindOf("```")).toBe("code");
    expect(kindOf("| a | b |")).toBe("table");
    expect(kindOf("> quote")).toBe("quote");
    expect(kindOf("plain text")).toBe("paragraph");
  });

  it("computes heading level", () => {
    expect(headingLevel("### x")).toBe(3);
    expect(headingLevel("plain")).toBe(0);
  });

  it("parses blocks and skips blank lines", () => {
    const lines = ["# Title", "", "- a", "  cont", "para"];
    expect(parseBlocks(lines).map((b) => [b.start, b.end, b.kind])).toEqual([
      [0, 1, "heading"],
      [2, 4, "list"],
      [4, 5, "paragraph"],
    ]);
  });

  it("continues ordered lists", () => {
    expect(listPrefix("3. foo")?.next).toBe("4. ");
    expect(listPrefix("- foo")?.next).toBe("- ");
  });

  it("toggles task checkboxes", () => {
    expect(toggleTask(["- [ ] do it"], 0)).toEqual(["- [x] do it"]);
    expect(toggleTask(["- [x] done"], 0)).toEqual(["- [ ] done"]);
  });
});
