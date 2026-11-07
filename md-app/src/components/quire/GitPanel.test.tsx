import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { CommitInfo, HistoryEntry } from "@/types";
import type { VaultFile } from "@/lib/vault";
import { GitPanel } from "./GitPanel";

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
    hasRemote?: boolean;
  } = {},
) {
  const { diffPath = null, activePath = "notes/alpha.md", hasRemote = false } = opts;
  const onOpen = vi.fn();
  const onShowDiff = vi.fn();
  const onShowRevision = vi.fn();
  const onRestoreSnapshot = vi.fn();
  const loadNoteHistory = vi.fn().mockResolvedValue(noteHistory);
  const loadVaultHistory = vi.fn().mockResolvedValue(vaultHistory);
  const loadBranches = vi
    .fn()
    .mockResolvedValue({ current: "main", branches: ["main", "feature"] });
  const onSwitchBranch = vi.fn();
  const onCreateBranch = vi.fn().mockResolvedValue(undefined);
  await render(
    <GitPanel
      name="Notes"
      isRepo
      hasRemote={hasRemote}
      relation="in-sync"
      branch="main"
      head={null}
      remoteHead={null}
      changes={changes}
      sync="idle"
      syncExcluded={false}
      onToggleSyncExcluded={noop}
      lastRun={null}
      lastSyncError={null}
      activePath={activePath}
      loadNoteHistory={loadNoteHistory}
      loadVaultHistory={loadVaultHistory}
      onShowRevision={onShowRevision}
      onRestoreSnapshot={onRestoreSnapshot}
      loadBranches={loadBranches}
      onSwitchBranch={onSwitchBranch}
      onCreateBranch={onCreateBranch}
      onOpen={onOpen}
      onShowDiff={onShowDiff}
      diffPath={diffPath}
      onSync={noop}
      onGitAction={noop}
      onInit={noop}
      loadRemotes={vi.fn().mockResolvedValue({ primary: "origin", remotes: [] })}
      onRemoteAdd={vi.fn().mockResolvedValue(undefined)}
      onRemoteRemove={noop}
      onRemoteRename={vi.fn().mockResolvedValue(undefined)}
      onRemoteSetPrimary={noop}
      onSyncFrom={noop}
    />,
  );
  return {
    onOpen,
    onShowDiff,
    onShowRevision,
    onRestoreSnapshot,
    onSwitchBranch,
    onCreateBranch,
    loadNoteHistory,
    loadVaultHistory,
    loadBranches,
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

describe("GitPanel branches", () => {
  it("shows the current branch in the status line", async () => {
    await renderPanel({ hasRemote: true });

    await expect.element(page.getByText("origin/main", { exact: false })).toBeVisible();
  });

  it("lists branches and switches on click", async () => {
    const { onSwitchBranch, loadBranches } = await renderPanel();

    await page.getByRole("button", { name: /Branches/ }).click();
    expect(loadBranches).toHaveBeenCalled();

    const switchTo = page.getByTitle(/refused while there are uncommitted changes/);
    await expect.element(switchTo).toBeVisible();
    await switchTo.click();
    expect(onSwitchBranch).toHaveBeenCalledWith("feature");
  });

  it("creates a branch without switching", async () => {
    const { onCreateBranch, onSwitchBranch } = await renderPanel();

    await page.getByRole("button", { name: "New branch" }).click();
    await page.getByRole("textbox", { name: "New branch name" }).fill("drafts");
    await page.getByRole("button", { name: "Create" }).click();

    expect(onCreateBranch).toHaveBeenCalledWith("drafts");
    expect(onSwitchBranch).not.toHaveBeenCalled();
  });
});

describe("GitPanel selective sync", () => {
  it("toggles excluded-file syncing from the status row", async () => {
    const setSyncExcludedCalls: boolean[] = [];
    const onToggle = (on: boolean) => setSyncExcludedCalls.push(on);
    const onOpen = vi.fn();
    await render(
      <GitPanel
        name="Notes"
        isRepo
        hasRemote
        relation="in-sync"
        branch="main"
        head={null}
        remoteHead={null}
        changes={[]}
        sync="idle"
        syncExcluded={false}
        onToggleSyncExcluded={onToggle}
        lastRun={null}
        lastSyncError={null}
        activePath="notes/alpha.md"
        loadNoteHistory={vi.fn().mockResolvedValue([])}
        loadVaultHistory={vi.fn().mockResolvedValue([])}
        onShowRevision={noop}
        onRestoreSnapshot={noop}
        loadBranches={vi.fn().mockResolvedValue({ current: "main", branches: ["main"] })}
        onSwitchBranch={noop}
        onCreateBranch={vi.fn().mockResolvedValue(undefined)}
        onOpen={onOpen}
        onShowDiff={noop}
        diffPath={null}
        onSync={noop}
        onGitAction={noop}
        onInit={noop}
        loadRemotes={vi.fn().mockResolvedValue({ primary: "origin", remotes: [] })}
        onRemoteAdd={vi.fn().mockResolvedValue(undefined)}
        onRemoteRemove={noop}
        onRemoteRename={vi.fn().mockResolvedValue(undefined)}
        onRemoteSetPrimary={noop}
        onSyncFrom={noop}
      />,
    );

    const sw = page.getByRole("switch");
    await expect.element(sw).toBeVisible();
    await expect.element(sw).not.toHaveAttribute("aria-checked", "true");
    await sw.click();
    expect(setSyncExcludedCalls).toEqual([true]);
  });
});
