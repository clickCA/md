import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import type { FolderSummaryPhase } from "@/hooks/useFolderSummary";
import { FolderSummaryModal } from "./FolderSummaryModal";

async function renderModal(phase: Exclude<FolderSummaryPhase, { kind: "idle" }>) {
  const handlers = {
    onAccept: vi.fn(),
    onStop: vi.fn(),
    onRegenerate: vi.fn(),
    onDismiss: vi.fn(),
    onClose: vi.fn(),
  };
  await render(<FolderSummaryModal phase={phase} providerLabel="opencode" {...handlers} />);
  return handlers;
}

describe("FolderSummaryModal", () => {
  it("previews the summary and only writes on Accept", async () => {
    const { onAccept, onDismiss } = await renderModal({
      kind: "review",
      folder: "projects/alpha",
      content: "# Alpha\n\nTwo notes about the release.",
      path: "projects/alpha/Summary.md",
      scope: 2,
    });

    await expect
      .element(page.getByRole("dialog", { name: "Summarize projects/alpha" }))
      .toBeVisible();
    await expect
      .element(page.getByText(/Accept writes projects\/alpha\/Summary\.md/))
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: /Accept/ }));
    expect(onAccept).toHaveBeenCalledWith("# Alpha\n\nTwo notes about the release.");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("stops a running run and does not close on backdrop while running", async () => {
    const { onStop, onClose } = await renderModal({
      kind: "running",
      folder: "notes",
      streamed: "Partial",
      scope: 3,
    });

    await expect.element(page.getByText(/Reading 3 notes/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: /Stop/ }));
    expect(onStop).toHaveBeenCalledOnce();

    await userEvent.click(page.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows an error and can be dismissed", async () => {
    const { onDismiss } = await renderModal({
      kind: "error",
      folder: "",
      message: "This folder has no notes to summarize.",
    });

    await expect.element(page.getByText(/no notes to summarize/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: /Dismiss/ }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
