import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { VaultFile } from "@/lib/vault";
import { GitPanel } from "./git-panel";

const noop = () => {};

const changes: VaultFile[] = [
  { path: "notes/alpha.md", content: "new text", committed: "old text" },
  { path: "beta.md", content: "# Beta\n", committed: null },
];

async function renderPanel(diffPath: string | null = null) {
  const onOpen = vi.fn();
  const onShowDiff = vi.fn();
  await render(
    <GitPanel
      name="Notes"
      isRepo
      hasRemote={false}
      relation="in-sync"
      head={null}
      remoteHead={null}
      changes={changes}
      sync="idle"
      lastRun={null}
      lastSyncError={null}
      onOpen={onOpen}
      onShowDiff={onShowDiff}
      diffPath={diffPath}
      onSync={noop}
      onGitAction={noop}
      onInit={noop}
    />,
  );
  return { onOpen, onShowDiff };
}

describe("GitPanel change navigation", () => {
  it("opens the diff when clicking a changed file", async () => {
    const { onShowDiff } = await renderPanel();

    await page.getByRole("button", { name: "Diff notes/alpha.md" }).click();
    expect(onShowDiff).toHaveBeenCalledWith("notes/alpha.md");
  });

  it("opens the note in the editor from the edit button", async () => {
    const { onOpen } = await renderPanel();

    await page.getByRole("button", { name: "Edit notes/alpha.md" }).click();
    expect(onOpen).toHaveBeenCalledWith("notes/alpha.md");
  });

  it("marks the file whose diff is open", async () => {
    await renderPanel("notes/alpha.md");

    const row = page.getByRole("button", { name: "Diff notes/alpha.md" });
    await expect.element(row).toHaveAttribute("aria-current", "true");
    await expect
      .element(page.getByRole("button", { name: "Diff beta.md" }))
      .not.toHaveAttribute("aria-current");
  });
});
