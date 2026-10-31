import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@/index.css";
import { LiveEditor } from "./live-editor";

const noop = () => {};
const CONTENT = "First paragraph\n\nSecond paragraph\n\nThird paragraph";

/* The editor is controlled: feed onChange back or typed text evaporates. */
function EditorHarness({ initial }: { initial: string }) {
  const [content, setContent] = useState(initial);
  return (
    <LiveEditor
      dir="/v"
      file={{ path: "note.md", content, committed: initial }}
      dark={false}
      onChange={setContent}
      onCursor={noop}
      onOpenLink={noop}
      existing={new Set()}
    />
  );
}

function renderEditor(content = CONTENT) {
  return render(<EditorHarness initial={content} />);
}

/* The live editor keeps a single textarea for the focused block, so
   Ctrl+A is scoped to that box; a second press must grow to the note. */
describe("LiveEditor select-all", () => {
  const textbox = page.getByRole("textbox", { name: "Markdown for this block" });
  const selection = () => {
    const el = textbox.element() as HTMLTextAreaElement;
    return [el.selectionStart, el.selectionEnd] as const;
  };

  it("first Ctrl+A selects the focused block", async () => {
    await renderEditor();
    await page.getByText("First paragraph", { exact: true }).click();
    await expect.element(textbox).toBeInTheDocument();

    await userEvent.keyboard("{Control>}{a}{/Control}");
    expect(selection()).toEqual([0, "First paragraph".length]);
  });

  it("second Ctrl+A expands the selection to the whole note", async () => {
    await renderEditor();
    await page.getByText("Second paragraph", { exact: true }).click();
    await expect.element(textbox).toBeInTheDocument();

    await userEvent.keyboard("{Control>}{a}{/Control}{Control>}{a}{/Control}");
    await expect.poll(selection).toEqual([0, CONTENT.length]);
  });

  it("typing after select-all replaces the whole note", async () => {
    await renderEditor();
    await page.getByText("Third paragraph", { exact: true }).click();
    await expect.element(textbox).toBeInTheDocument();

    await userEvent.keyboard("{Control>}{a}{/Control}{Control>}{a}{/Control}");
    await userEvent.keyboard("rewritten");

    await expect.poll(() => (textbox.element() as HTMLTextAreaElement).value).toBe("rewritten");
  });
});
