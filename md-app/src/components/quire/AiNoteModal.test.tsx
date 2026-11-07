import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import type { AiNotePhase } from "@/hooks/useAiNote";
import { AiNoteModal } from "./AiNoteModal";

async function renderModal(phase: AiNotePhase, onClose = vi.fn()) {
  const handlers = {
    onCreate: vi.fn(),
    onStop: vi.fn(),
    onDismiss: vi.fn(),
    onClose,
  };
  await render(<AiNoteModal phase={phase} providerLabel="opencode" {...handlers} />);
  return handlers;
}

describe("AiNoteModal", () => {
  it("creates from the description and refuses empty input", async () => {
    const { onCreate } = await renderModal({ kind: "idle" });

    const button = page.getByRole("button", { name: /Create note/ });
    await expect.element(button).toBeDisabled();

    await page.getByPlaceholder(/Describe the note/).fill("weekly sync meeting template");
    await expect.element(button).toBeEnabled();
    await userEvent.click(button);
    expect(onCreate).toHaveBeenCalledWith("weekly sync meeting template");
  });

  it("shows progress with a stop while running, and no backdrop close then", async () => {
    const { onStop, onClose } = await renderModal({ kind: "running", streamed: "" });

    await expect.element(page.getByText("Writing the note…")).toBeVisible();
    await userEvent.click(page.getByText("Stop"));
    expect(onStop).toHaveBeenCalledOnce();

    // Clicking the backdrop while running must not close the modal.
    await userEvent.click(page.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows an error with a dismiss", async () => {
    const { onDismiss } = await renderModal({
      kind: "error",
      message: "opencode is not on PATH",
    });

    await expect.element(page.getByText(/not on PATH/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Dismiss error" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("closes from the X and via the backdrop when idle", async () => {
    const { onClose } = await renderModal({ kind: "idle" });

    await userEvent.click(page.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
