import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import type { VaultFile } from "@/lib/vault";
import { MarkdownEditor } from "./note-editor";
import { openUrl } from "@tauri-apps/plugin-opener";
import "../../index.css";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const noop = () => {};

const file: VaultFile = {
  path: "notes/Hello.md",
  content: "First line\nSecond line\n",
  committed: null,
};

const raf = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

describe("MarkdownEditor click hitboxes", () => {
  const content = [
    "# Big heading", // 1
    "plain text line two", // 2
    "- [ ] task item", // 3
    "short", // 4
    "[a link](https://example.com)", // 5
  ].join("\n");

  it("places the caret on the line that was clicked, at every boundary", async () => {
    await render(
      <MarkdownEditor
        file={{ ...file, content }}
        dir="/vault"
        onChange={noop}
        onCursor={noop}
        dark={false}
      />,
    );
    // CM6 measures line heights on animation frames — let it settle before
    // asserting anything about hitboxes.
    await raf();
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
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
    const title = document.querySelector(".inline-title") as HTMLElement;
    const tr = title.getBoundingClientRect();
    const below = click(tr.left + 10, tr.bottom + 3);
    expect(below).toBeGreaterThanOrEqual(0);
    expect(below).toBeLessThanOrEqual(lines[0].to);
  });
});

describe("MarkdownEditor inline title", () => {
  it("focuses the editor and drops the caret at the top when the title is clicked", async () => {
    await render(
      <MarkdownEditor file={file} dir="/vault" onChange={noop} onCursor={noop} dark={false} />,
    );
    await page.getByRole("heading", { name: "Hello" }).click();
    // The editor surface took focus; the caret was dispatched to doc start.
    expect(document.activeElement?.classList.contains("cm-content")).toBe(true);
    const selection = document.getSelection();
    expect(selection?.anchorNode?.parentElement?.closest(".cm-content")).not.toBeNull();
  });

  it("opens the note when a wikilink is Ctrl/Cmd-clicked", async () => {
    const onOpenLink = vi.fn();
    await render(
      <MarkdownEditor
        file={{ ...file, content: "\nsee [[Other Note]] here" }}
        dir="/vault"
        onChange={noop}
        onCursor={noop}
        onOpenLink={onOpenLink}
        dark={false}
      />,
    );
    await page.getByText("Other Note").click({ modifiers: ["Control"] });
    expect(onOpenLink).toHaveBeenCalledWith("Other Note");
  });

  it("opens the note of a relative markdown link on Ctrl/Cmd-click", async () => {
    const onOpenLink = vi.fn();
    await render(
      <MarkdownEditor
        file={{ ...file, content: "\nsee [docs page](notes/docs.md) here" }}
        dir="/vault"
        onChange={noop}
        onCursor={noop}
        onOpenLink={onOpenLink}
        dark={false}
      />,
    );
    await page.getByText("docs page").click({ modifiers: ["Control"] });
    expect(onOpenLink).toHaveBeenCalledWith("notes/docs.md");
  });

  it("opens external links in the system browser on Ctrl/Cmd-click", async () => {
    vi.mocked(openUrl).mockClear();
    await render(
      <MarkdownEditor
        file={{ ...file, content: "\nsee [the site](https://example.com) here" }}
        dir="/vault"
        onChange={noop}
        onCursor={noop}
        dark={false}
      />,
    );
    await page.getByText("the site").click({ modifiers: ["Control"] });
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });
});

describe("MarkdownEditor image paste/drop", () => {
  const mount = async (onChange = noop) => {
    await render(
      <MarkdownEditor file={file} dir="/vault" onChange={onChange} onCursor={noop} dark={false} />,
    );
    await raf();
    return EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
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

    view.contentDOM.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true }),
    );

    expect(invoke).not.toHaveBeenCalled();
  });
});
