import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { HistoryEntry } from "@/types";
import { RevisionViewer } from "./revision-viewer";

const entry: HistoryEntry = {
  oid: "1234567890abcdef",
  message: "auto: pending changes",
  author: "tester",
  time: Math.floor(Date.now() / 1000) - 120,
  change: "modified",
  path: "notes/idea.md",
};

async function renderViewer(
  override: Partial<HistoryEntry> = {},
  content = "# Idea\n\nAn older draft.\n",
) {
  const onRestore = vi.fn();
  const onClose = vi.fn();
  await render(
    <RevisionViewer
      entry={{ ...entry, ...override }}
      content={content}
      onRestore={onRestore}
      onClose={onClose}
    />,
  );
  return { onRestore, onClose };
}

describe("RevisionViewer", () => {
  it("shows the revision content read-only", async () => {
    await renderViewer();

    const pre = page.getByRole("region", { name: "Revision" }).getByText("An older draft.", {
      exact: false,
    });
    await expect.element(pre).toBeVisible();
  });

  it("restores after a two-step confirmation", async () => {
    const { onRestore } = await renderViewer();

    const restore = page.getByRole("button", { name: "Restore" });
    await restore.click();
    // First click only arms the destructive action.
    expect(onRestore).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Really restore?" }).click();
    expect(onRestore).toHaveBeenCalledWith(entry);
  });

  it("closes without restoring", async () => {
    const { onClose, onRestore } = await renderViewer();

    await page.getByRole("button", { name: "Close revision" }).click();
    expect(onClose).toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("flags deleted revisions as resurrections", async () => {
    const { onRestore } = await renderViewer({ change: "deleted" });

    await expect
      .element(page.getByText("This revision deleted the note", { exact: false }))
      .toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();
    await page.getByRole("button", { name: "Really restore?" }).click();
    expect(onRestore).toHaveBeenCalled();
  });
});
