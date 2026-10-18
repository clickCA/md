import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { VaultFile } from "@/lib/vault";
import { FileTree } from "./file-tree";

const files: VaultFile[] = [
  { path: "Welcome.md", content: "# Welcome\n", committed: "# Welcome\n" },
  { path: "Projects/Roadmap.md", content: "# R\n", committed: null },
];

const noop = () => {};

function renderTree(onOpen: (path: string) => void = noop) {
  return render(
    <FileTree
      files={files}
      folders={[]}
      showStatus
      active={null}
      onOpen={onOpen}
      onCreate={noop}
      onCreateFolder={noop}
      onOpenFolder={noop}
      onMove={noop}
    />,
  );
}

describe("FileTree", () => {
  it("renders note names and folders", async () => {
    await renderTree();
    await expect.element(page.getByText("Welcome")).toBeInTheDocument();
    await expect.element(page.getByText("Projects")).toBeInTheDocument();
  });

  it("opens a note when clicked", async () => {
    const onOpen = vi.fn();
    await renderTree(onOpen);
    await page.getByText("Welcome").click();
    expect(onOpen).toHaveBeenCalledWith("Welcome.md");
  });
});
