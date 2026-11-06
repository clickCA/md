import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import type { AiAskPhase } from "@/hooks/useAiAsk";
import { AiAskModal } from "./ai-ask-modal";

const files = [{ path: "notes/gtd.md" }, { path: "notes/inbox.md" }];

async function renderModal(phase: AiAskPhase, onClose = vi.fn()) {
  const handlers = {
    onAsk: vi.fn(),
    onStop: vi.fn(),
    onDismiss: vi.fn(),
    onClose,
    onOpenCitation: vi.fn(),
  };
  await render(<AiAskModal phase={phase} providerLabel="opencode" files={files} {...handlers} />);
  return handlers;
}

describe("AiAskModal", () => {
  it("asks from the question box and refuses empty input", async () => {
    const { onAsk } = await renderModal({ kind: "idle" });

    const button = page.getByRole("button", { name: "Ask" });
    await expect.element(button).toBeDisabled();

    await page.getByPlaceholder(/Ask something/).fill("what did I decide about sync?");
    await expect.element(button).toBeEnabled();
    await userEvent.click(button);
    expect(onAsk).toHaveBeenCalledWith("what did I decide about sync?");
  });

  it("shows progress with a stop while running", async () => {
    const { onStop } = await renderModal({
      kind: "running",
      question: "sync?",
      streamed: "partial…",
    });

    await expect.element(page.getByText("Searching your notes…")).toBeVisible();
    await expect.element(page.getByText(/partial…/)).toBeVisible();
    await userEvent.click(page.getByText("Stop"));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("renders the answer with clickable source chips", async () => {
    const { onOpenCitation } = await renderModal({
      kind: "answer",
      question: "sync?",
      answer: "Keep one trusted system [notes/gtd.md:3]. Also mind the inbox [notes/missing.md:1].",
    });

    await expect.element(page.getByText(/trusted system/)).toBeVisible();
    await expect.element(page.getByText("Sources")).toBeVisible();
    // The missing note is filtered out; only the real one renders. (The
    // accessible name drops the ".md" punctuation: "gtd:3".)
    const chip = page.getByRole("button", { name: /gtd/ });
    await expect.element(chip).toBeVisible();

    await userEvent.click(chip);
    expect(onOpenCitation).toHaveBeenCalledWith("notes/gtd.md");
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
});
