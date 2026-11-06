import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { CommitInfo, HistoryEntry } from "@/types";
import type { VaultFile } from "@/lib/vault";
import { GitPanel } from "./git-panel";

const noop = () => {};

const changes: VaultFile[] = [
  { path: "notes/alpha.md", content: "new text", committed: "old text" },
  { path: "beta.md", content: "# Beta\n", committed: null },
];

const noteHistory: HistoryEntry[] = [
  {
    oid: "aaaaaaaaaaaaaaaaaaaa",
    message: "auto: pending changes",
    author: "tester",
    time: Math.floor(Date.now() / 1000) - 60,
    change: "modified",
    path: "notes/alpha.md",
  },
  {
    oid: "bbbbbbbbbbbbbbbbbbbb",
    message: "auto: pending changes",
    author: "tester",
    time: Math.floor(Date.now() / 1000) - 3600,
    change: "added",
    path: "notes/alpha.md",
  },
];

const vaultHistory: CommitInfo[] = [
  {
    oid: "cccccccccccccccccccc",
    message: "auto: pending changes",
    author: "tester",
    time: Math.floor(Date.now() / 1000) - 30,
  },
];

async function renderPanel(
  opts: {
    diffPath?: string | null;
    activePath?: string | null;
  } = {},
) {
  const { diffPath = null, activePath = "notes/alpha.md" } = opts;
  const onOpen = vi.fn();
  const onShowDiff = vi.fn();
  const onShowRevision = vi.fn();
  const onRestoreSnapshot = vi.fn();
  const loadNoteHistory = vi.fn().mockResolvedValue(noteHistory);
  const loadVaultHistory = vi.fn().mockResolvedValue(vaultHistory);
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
      activePath={activePath}
      loadNoteHistory={loadNoteHistory}
      loadVaultHistory={loadVaultHistory}
      onShowRevision={onShowRevision}
      onRestoreSnapshot={onRestoreSnapshot}
      onOpen={onOpen}
      onShowDiff={onShowDiff}
      diffPath={diffPath}
      onSync={noop}
      onGitAction={noop}
      onInit={noop}
    />,
  );
  return {
    onOpen,
    onShowDiff,
    onShowRevision,
    onRestoreSnapshot,
    loadNoteHistory,
    loadVaultHistory,
  };
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
    await renderPanel({ diffPath: "notes/alpha.md" });

    const row = page.getByRole("button", { name: "Diff notes/alpha.md" });
    await expect.element(row).toHaveAttribute("aria-current", "true");
    await expect
      .element(page.getByRole("button", { name: "Diff beta.md" }))
      .not.toHaveAttribute("aria-current");
  });
});

describe("GitPanel history", () => {
  it("loads the note's history on demand and opens revisions", async () => {
    const { onShowRevision, loadNoteHistory } = await renderPanel();

    await page.getByRole("button", { name: "Show history" }).click();
    await expect.element(page.getByText("auto: pending changes").first()).toBeVisible();
    expect(loadNoteHistory).toHaveBeenCalledWith("notes/alpha.md");

    await page
      .getByTitle(/View revision/)
      .first()
      .click();
    expect(onShowRevision).toHaveBeenCalledWith(noteHistory[0]);
  });

  it("disables note scope without an open note", async () => {
    await renderPanel({ activePath: null });

    await expect.element(page.getByRole("button", { name: "Show history" })).toBeDisabled();
  });

  it("lists vault commits and restores a snapshot after confirmation", async () => {
    const { onRestoreSnapshot } = await renderPanel();

    await page.getByRole("button", { name: "Show history" }).click();
    await page.getByRole("button", { name: "Vault" }).click();

    const restore = page.getByRole("button", { name: /Restore snapshot/ });
    await restore.click();
    expect(onRestoreSnapshot).not.toHaveBeenCalled();
    await restore.click();
    expect(onRestoreSnapshot).toHaveBeenCalledWith(vaultHistory[0].oid);
  });
});
