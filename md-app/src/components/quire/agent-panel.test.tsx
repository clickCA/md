import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import type { AgentProviderInfo, AgentTurn } from "@/lib/agent";
import { AgentPanel, type AgentPanelProps } from "./agent-panel";

const noop = () => {};

/** The panel is controlled — wrap it to hold live input state like the hook does. */
type HarnessProps = Omit<AgentPanelProps, "input" | "onInput"> & { input?: string };
function Harness(props: HarnessProps) {
  const [input, setInput] = useState(props.input ?? "");
  return <AgentPanel {...props} input={input} onInput={setInput} />;
}

const providers: AgentProviderInfo[] = [
  { id: "opencode", label: "opencode", available: true, installHint: "npm i -g opencode-ai" },
  {
    id: "claude",
    label: "Claude Code",
    available: true,
    installHint: "npm i -g @anthropic-ai/claude-code",
  },
  { id: "codex", label: "codex", available: false, installHint: "codex login" },
];

const files = [{ path: "notes/alpha.md" }, { path: "beta.md" }];

const doneTurn: AgentTurn = {
  id: 1,
  provider: "opencode",
  prompt: "Summarize my daily notes",
  output: "Here is a summary:\n- a\n- b\n",
  status: "done",
  summary: "finished in 12.4s",
  changedFiles: ["notes/alpha.md", "deleted.md"],
};

async function renderPanel(overrides: Record<string, unknown> = {}) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const onOpenFile = vi.fn();
  const onSelect = vi.fn();
  await render(
    <Harness
      providers={providers}
      selected="opencode"
      onSelect={onSelect}
      running={false}
      turns={[doneTurn]}
      error={null}
      input=""
      onSend={onSend}
      onStop={onStop}
      onNewSession={noop}
      autoApprove={true}
      onAutoApproveChange={noop}
      files={files}
      onOpenFile={onOpenFile}
      {...overrides}
    />,
  );
  return { onSend, onStop, onOpenFile, onSelect };
}

describe("AgentPanel", () => {
  it("shows the prompt, streamed output and provider summary of a finished turn", async () => {
    await renderPanel();

    await expect.element(page.getByText("Summarize my daily notes")).toBeVisible();
    await expect.element(page.getByText(/Here is a summary:/)).toBeVisible();
    await expect.element(page.getByText("finished in 12.4s")).toBeVisible();
    await expect.element(page.getByText("Done")).toBeVisible();
  });

  it("lists only changed files that are real notes, and opens them on click", async () => {
    const { onOpenFile } = await renderPanel();

    // "deleted.md" is reported changed but not in the vault file set — its
    // chip must not render.
    const chip = page.getByRole("button", { name: "alpha" });
    await expect.element(chip).toBeVisible();
    expect(page.getByText("deleted.md").elements()).toHaveLength(0);

    await chip.click();
    expect(onOpenFile).toHaveBeenCalledWith("notes/alpha.md");
  });

  it("sends on Enter and keeps the send button disabled while input is empty", async () => {
    const { onSend } = await renderPanel();

    const send = page.getByRole("button", { name: "Send prompt" });
    await expect.element(send).toBeDisabled();

    const box = page.getByRole("textbox", { name: "Prompt the coding agent" });
    await box.fill("rewrite this note");
    await expect.element(send).toBeEnabled();

    // Focus the box, then press Enter → send (not a newline).
    await box.fill("rewrite this note\nmore");
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("shows a stop button while running and calls onStop", async () => {
    const { onStop } = await renderPanel({ running: true, input: "" });

    await page.getByRole("button", { name: "Stop agent" }).click();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("guides the user when no agent CLI is installed", async () => {
    await renderPanel({
      providers: providers.map((p) => ({ ...p, available: false })),
      selected: "opencode",
    });

    await expect.element(page.getByText("No coding agent installed")).toBeVisible();
    await expect.element(page.getByText(/npm i -g opencode-ai/)).toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Prompt the coding agent" }))
      .toBeDisabled();
  });
});
