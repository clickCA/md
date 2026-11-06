import { describe, expect, it } from "vitest";
import { instructionFor, isProposalStale, unwrapCandidate, type InlineAiOp } from "./inline-ai";

describe("instructionFor", () => {
  const ops: InlineAiOp[] = ["rewrite", "grammar", "continue", "summarize"];

  it("states the operation's task for every operation", () => {
    expect(instructionFor("rewrite")).toContain("Rewrite the selection");
    expect(instructionFor("grammar")).toContain("Fix grammar");
    expect(instructionFor("continue")).toContain("Continue writing naturally");
    expect(instructionFor("summarize")).toContain("Summarize the selection");
  });

  it("tells the continuation to output only new text", () => {
    expect(instructionFor("continue")).toContain("do not repeat the selection");
  });

  it("keeps provider contracts out of the instruction — the command layer composes them", () => {
    for (const op of ops) {
      expect(instructionFor(op)).not.toContain("Reply with ONLY");
      expect(instructionFor(op)).not.toContain("Never use tools");
    }
  });
});

describe("unwrapCandidate", () => {
  it("unwraps a single outer fence from a prose reply", () => {
    expect(unwrapCandidate("```markdown\nClean prose.\n```", "Raw prose.")).toBe("Clean prose.");
  });

  it("unwraps a fence with a language tag", () => {
    expect(unwrapCandidate("```md\nClean.\n```", "Raw.")).toBe("Clean.");
  });

  it("keeps the reply as-is when the selection itself is fenced code", () => {
    const selection = "```rust\nfn main() {}\n```";
    const candidate = "```rust\nfn main() { /* rewritten */ }\n```";
    expect(unwrapCandidate(candidate, selection)).toBe(candidate);
  });

  it("returns plain replies untouched", () => {
    expect(unwrapCandidate("Just text.", "raw")).toBe("Just text.");
  });
});

describe("isProposalStale", () => {
  it("is stale only when the document version moved", () => {
    expect(isProposalStale(3, 3)).toBe(false);
    expect(isProposalStale(3, 4)).toBe(true);
    expect(isProposalStale(4, 3)).toBe(true);
  });
});
