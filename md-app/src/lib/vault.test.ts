import { describe, expect, it } from "vitest";
import { remoteName, sanitizeVaultName } from "./vault";

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
