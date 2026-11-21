import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { editorView, renderEditor } from "@/test/render";
import { settle } from "@/test/dom";
import { vaultFile } from "@/test/fixtures";
import "../../index.css";

const noop = () => {};

const file = vaultFile({
  path: "notes/Hello.md",
  content: "First line\nSecond line\n",
});

describe("MarkdownEditor click hitboxes", () => {
  const content = [
    "# Big heading", // 1
    "plain text line two", // 2
    "- [ ] task item", // 3
    "short", // 4
    "[a link](https://example.com)", // 5
  ].join("\n");

  it("places the caret on the line that was clicked, at every boundary", async () => {
    await renderEditor({ file: vaultFile({ ...file, content }) });
    // CM6 measures line heights on animation frames — settle before
    // asserting anything about hitboxes.
    await settle();
    const view = editorView();
    const click = (x: number, y: number) => {
      view.contentDOM.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          // detail: 1 = single click. The default 0 makes CodeMirror treat
          // the event as a triple-click (whole-line selection).
          detail: 1,
          clientX: x,
          clientY: y,
        }),
      );
      return view.state.selection.main.head;
    };

    const lines = Array.from({ length: view.state.doc.lines }, (_, i) =>
      view.state.doc.line(i + 1),
    );
    const rects = lines.map((l) => view.coordsAtPos(l.from)!);

    // 1) Clicking the middle of a line lands on that line.
    // 2) Clicking far past its last character stays on that line.
    for (let i = 0; i < lines.length; i++) {
      const { from, to } = lines[i];
      const midY = (rects[i].top + rects[i].bottom) / 2;
      const center = click(rects[i].left + 60, midY);
      expect(center, `center click on line ${i + 1}`).toBeGreaterThanOrEqual(from);
      expect(center, `center click on line ${i + 1}`).toBeLessThanOrEqual(to);
      const farRight = click(rects[i].left + 900, midY);
      expect(farRight, `far-right click on line ${i + 1}`).toBeGreaterThanOrEqual(from);
      expect(farRight, `far-right click on line ${i + 1}`).toBeLessThanOrEqual(to);
    }

    // 3) Clicking exactly between two lines lands on one of them — never a
    // line further away.
    for (let i = 0; i + 1 < lines.length; i++) {
      const between = click(rects[i + 1].left + 60, (rects[i].bottom + rects[i + 1].top) / 2);
      expect(between, `boundary click between lines ${i + 1}/${i + 2}`).toBeGreaterThanOrEqual(
        lines[i].from,
      );
      expect(between, `boundary click between lines ${i + 1}/${i + 2}`).toBeLessThanOrEqual(
        lines[i + 1].to,
      );
    }

    // 4) Clicking just below the inline title lands on the first line, not
    // one or two lines further down (title spacing must be part of its
    // measured height — padding, not margin).
    const title = document.querySelector(".cm-editor h1") as HTMLElement;
    const tr = title.getBoundingClientRect();
    const below = click(tr.left + 10, tr.bottom + 3);
    expect(below).toBeGreaterThanOrEqual(0);
    expect(below).toBeLessThanOrEqual(lines[0].to);
  });
});

describe("MarkdownEditor inline title", () => {
  it("focuses the editor and drops the caret at the top when the title is clicked", async () => {
    await renderEditor({ file });
    await page.getByRole("heading", { name: "Hello" }).click();
    // The editor surface took focus; the caret was dispatched to doc start.
    expect(document.activeElement?.classList.contains("cm-content")).toBe(true);
    const selection = document.getSelection();
    expect(selection?.anchorNode?.parentElement?.closest(".cm-content")).not.toBeNull();
  });

  it("opens the note when a wikilink is Ctrl/Cmd-clicked", async () => {
    const onOpenLink = vi.fn();
    await renderEditor({
      file: vaultFile({ ...file, content: "\nsee [[Other Note]] here" }),
      onOpenLink,
    });
    await page.getByText("Other Note").click({ modifiers: ["Control"] });
    expect(onOpenLink).toHaveBeenCalledWith("Other Note");
  });

  it("opens the note of a relative markdown link on Ctrl/Cmd-click", async () => {
    const onOpenLink = vi.fn();
    await renderEditor({
      file: vaultFile({ ...file, content: "\nsee [docs page](notes/docs.md) here" }),
      onOpenLink,
    });
    await page.getByText("docs page").click({ modifiers: ["Control"] });
    expect(onOpenLink).toHaveBeenCalledWith("notes/docs.md");
  });

  it("opens external links in the system browser on Ctrl/Cmd-click", async () => {
    vi.mocked(openUrl).mockClear();
    await renderEditor({
      file: vaultFile({ ...file, content: "\nsee [the site](https://example.com) here" }),
    });
    await page.getByText("the site").click({ modifiers: ["Control"] });
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });
});

describe("MarkdownEditor table editing", () => {
  it("moves cells with Tab instead of indenting the line", async () => {
    const content = ["| A | B |", "| --- | --- |", "| c | d |"].join("\n");
    await renderEditor({ file: vaultFile({ ...file, content }) });
    await settle();
    const view = editorView();
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 2 } });
    view.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);

    // The table keymap sits ahead of indentWithTab: the row is rewritten and
    // padded, and the caret moved to the second cell.
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.line(1).text).toBe("| A   | B   |");
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
  });
});

describe("MarkdownEditor image paste/drop", () => {
  const mount = async (onChange = noop) => {
    await renderEditor({ file, onChange });
    await settle();
    return editorView();
  };

  const pasteEventWith = (name: string, type: string): Event => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], name, { type }));
    return new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
  };

  it("stores a pasted screenshot and embeds it at the caret", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValue("assets/paste-123.png");
    const onChange = vi.fn();
    const view = await mount(onChange);

    view.contentDOM.dispatchEvent(pasteEventWith("Pasted image.png", "image/png"));

    await vi.waitFor(() => {
      expect(view.state.doc.toString()).toContain("![](assets/paste-123.png)");
    });
    expect(invoke).toHaveBeenCalledWith("save_image", {
      dir: "/vault",
      data: expect.any(String),
      ext: "png",
    });
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("![](assets/paste-123.png)"));
  });

  it("leaves text paste (no image files) to CodeMirror", async () => {
    vi.mocked(invoke).mockClear();
    const view = await mount();

    view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true }));

    expect(invoke).not.toHaveBeenCalled();
  });
});
