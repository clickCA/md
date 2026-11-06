import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import type { InlineAiPhase } from "@/hooks/useInlineAi";
import { InlineAiPanel } from "./inline-ai-panel";

const noop = async () => {};

const previewPhase: InlineAiPhase = {
  kind: "preview",
  op: "rewrite",
  candidate: "A cleaner sentence.",
  selectionText: "A sentence that rambles on.",
  from: 5,
  to: 32,
  version: 7,
};

async function renderPanel(phase: InlineAiPhase, overrides: Record<string, unknown> = {}) {
  const handlers = {
    onRun: vi.fn(),
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onRegenerate: vi.fn(),
    onStop: vi.fn(),
    onDismiss: vi.fn(),
  };
  await render(
    <InlineAiPanel
      phase={phase}
      stale={false}
      providerLabel="opencode"
      hasSelection={true}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("InlineAiPanel", () => {
  it("renders nothing when idle without a selection", async () => {
    const { container } = await render(
      <InlineAiPanel
        phase={{ kind: "idle" }}
        stale={false}
        providerLabel={null}
        hasSelection={false}
        onRun={vi.fn()}
        onAccept={noop}
        onReject={noop}
        onRegenerate={noop}
        onStop={noop}
        onDismiss={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("offers the operations for a selection and reports the chosen one", async () => {
    const { onRun } = await renderPanel({ kind: "idle" });

    for (const label of ["Rewrite", "Fix grammar", "Continue writing", "Summarize"]) {
      await expect.element(page.getByText(label)).toBeVisible();
    }
    await userEvent.click(page.getByText("Fix grammar"));
    expect(onRun).toHaveBeenCalledWith("grammar");
  });

  it("streams progress and stops on demand", async () => {
    const { onStop } = await renderPanel({ kind: "running", op: "rewrite", streamed: "A cle" });

    await expect.element(page.getByText(/Rewrite…/)).toBeVisible();
    await expect.element(page.getByText(/A cle/)).toBeVisible();
    await userEvent.click(page.getByText("Stop"));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("previews the candidate as a diff against the selection and applies on Accept", async () => {
    const { onAccept } = await renderPanel(previewPhase);

    await expect.element(page.getByText(/A cleaner sentence\./)).toBeVisible();
    await expect.element(page.getByText(/rambles on\./)).toBeVisible();
    await userEvent.click(page.getByText("Accept"));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("rejects a proposal", async () => {
    const { onReject } = await renderPanel(previewPhase);

    await userEvent.click(page.getByRole("button", { name: "Reject proposal" }));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("blocks Accept when stale and offers regeneration instead", async () => {
    const { onAccept, onRegenerate } = await renderPanel(previewPhase, { stale: true });

    await expect.element(page.getByText(/no longer matches the selection/)).toBeVisible();
    const accept = page.getByRole("button", { name: /Accept/ });
    await expect.element(accept).toBeDisabled();
    await userEvent.click(page.getByText("Regenerate"));
    expect(onRegenerate).toHaveBeenCalledOnce();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("shows an error with a dismiss", async () => {
    const { onDismiss } = await renderPanel({
      kind: "error",
      message: "opencode is not on PATH",
    });

    await expect.element(page.getByText(/not on PATH/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Dismiss error" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
