import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { VaultFile } from "@/lib/vault";
import { DiffViewer } from "./diff-viewer";

const noop = () => {};

const modified: VaultFile = {
  path: "Notes/Ideas.md",
  content: "# Ideas\n\n- new point\n- extra\n",
  committed: "# Ideas\n\n- old point\n",
};

const renderDiff = async (file: VaultFile, onOpenNote = noop, onClose = noop) => {
  await render(<DiffViewer file={file} onOpenNote={onOpenNote} onClose={onClose} />);
  await expect.element(page.getByText(file.path)).toBeInTheDocument();
};

describe("DiffViewer", () => {
  it("shows added and removed lines with a change stat", async () => {
    await renderDiff(modified);

    await expect.element(page.getByText("- old point")).toBeInTheDocument();
    await expect.element(page.getByText("- new point")).toBeInTheDocument();
    await expect.element(page.getByText("- extra")).toBeInTheDocument();
    // git-style hunk header with old/new ranges
    await expect.element(page.getByText("@@ -1,4 +1,5 @@")).toBeInTheDocument();
  });

  it("flags untracked notes as a new file", async () => {
    await renderDiff({ path: "Inbox.md", content: "# Inbox\n", committed: null });

    await expect.element(page.getByText("new file")).toBeInTheDocument();
    await expect.element(page.getByText("# Inbox")).toBeInTheDocument();
  });

  it("says so when the working copy matches the commit", async () => {
    await renderDiff({ path: "Done.md", content: "same", committed: "same" });

    await expect.element(page.getByText("No changes against the last commit.")).toBeInTheDocument();
  });

  it("opens the note from the diff and closes back", async () => {
    const onOpenNote = vi.fn();
    const onClose = vi.fn();
    await renderDiff(modified, onOpenNote, onClose);

    await page.getByRole("button", { name: "Edit note" }).click();
    expect(onOpenNote).toHaveBeenCalledWith("Notes/Ideas.md");

    await page.getByRole("button", { name: "Close diff" }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
