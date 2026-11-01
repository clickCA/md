import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { NoteHeader } from "./note-header";

const noop = () => {};

const renderHeader = async (diffOpen = false, onToggleDiff = noop) => {
  await render(
    <NoteHeader
      path="Notes/Ideas.md"
      mode="edit"
      diffOpen={diffOpen}
      sidebarOpen
      outlineOpen={false}
      onShowSidebar={noop}
      onToggleMode={noop}
      onToggleDiff={onToggleDiff}
      onToggleOutline={noop}
      onOpenPalette={noop}
      onOpenTypography={noop}
      onNewNote={noop}
    />,
  );
};

describe("NoteHeader diff toggle", () => {
  it("opens the diff from the toolbar", async () => {
    const onToggleDiff = vi.fn();
    await renderHeader(false, onToggleDiff);

    await page.getByRole("button", { name: "View changes (Ctrl Shift D)" }).click();
    expect(onToggleDiff).toHaveBeenCalledOnce();
  });

  it("offers a way back while the diff is open", async () => {
    await renderHeader(true);

    const back = page.getByRole("button", { name: "Back to note (Ctrl Shift D)" });
    await expect.element(back).toHaveAttribute("aria-pressed", "true");
  });

  it("opens typography settings from the toolbar", async () => {
    const onOpenTypography = vi.fn();
    await render(
      <NoteHeader
        path="Notes/Ideas.md"
        mode="edit"
        diffOpen={false}
        sidebarOpen
        outlineOpen={false}
        onShowSidebar={noop}
        onToggleMode={noop}
        onToggleDiff={noop}
        onToggleOutline={noop}
        onOpenPalette={noop}
        onOpenTypography={onOpenTypography}
        onNewNote={noop}
      />,
    );
    await page.getByRole("button", { name: "Typography settings" }).click();
    expect(onOpenTypography).toHaveBeenCalledOnce();
  });
});
