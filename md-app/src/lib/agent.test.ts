import { describe, expect, it } from "vitest";
import { chipName, openableChangedFiles } from "./agent";

describe("openableChangedFiles", () => {
  it("intersects changed paths with the current vault file set", () => {
    const files = [{ path: "notes/alpha.md" }, { path: "beta.md" }];
    expect(openableChangedFiles(["notes/alpha.md", "gone.md", "beta.md"], files)).toEqual([
      "notes/alpha.md",
      "beta.md",
    ]);
  });

  it("keeps order and never emits unknown paths", () => {
    expect(openableChangedFiles(["x.md"], [])).toEqual([]);
    expect(openableChangedFiles([], [{ path: "x.md" }])).toEqual([]);
  });
});

describe("chipName", () => {
  it("strips folder and .md extension", () => {
    expect(chipName("Journal/2026-11-06.md")).toBe("2026-11-06");
    expect(chipName("plain.md")).toBe("plain");
  });
});
