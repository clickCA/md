import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { invoke } from "@tauri-apps/api/core";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { VaultFile } from "@/lib/vault";
import { mdLivePreview, type LivePreviewOptions } from "./live-preview";
import { MarkdownEditor } from "./note-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/* Live-preview rendering contract, per construct: on inactive lines the
   page reads like rendered markdown (syntax collapsed away), the raw
   markdown stays untouched in the document, and only replaced widgets
   (the task checkbox) are atomic so clicks always map to real text. */

const noop = () => {};

/* 1×1 red PNG — a valid bitmap, so the widget keeps its <img> after load. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function mount(doc: string, options: LivePreviewOptions = {}) {
  const view = new EditorView({
    // Same parser config as note-editor.tsx: markdown() defaults to plain
    // CommonMark — without the GFM base, task markers are not parsed.
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), mdLivePreview(options)],
    }),
    parent: document.body,
  });
  return view;
}

/** Visible text of the last line (cursor rests on line 1, line 2 inactive). */
const renderedLine = (view: EditorView) => {
  const lines = view.contentDOM.querySelectorAll(".cm-line");
  return (lines[lines.length - 1]?.textContent ?? "").replace(/\u200b/g, "");
};

describe("mdLivePreview decorations", () => {
  it("collapses heading hashes flush and keeps the doc raw", () => {
    const view = mount("\n## H2 text");
    try {
      expect(renderedLine(view)).toBe("H2 text");
      expect(view.state.doc.toString()).toBe("\n## H2 text");
    } finally {
      view.destroy();
    }
  });

  it("collapses emphasis, strikethrough and inline-code marks", () => {
    const view = mount("\n**bold** and *em* and ~~gone~~ and `code`");
    try {
      expect(renderedLine(view)).toBe("bold and em and gone and code");
    } finally {
      view.destroy();
    }
  });

  it("renders links as the label only", () => {
    const view = mount("\n[label](https://example.com)");
    try {
      expect(view.contentDOM.querySelector(".cm-md-link")?.textContent).toBe("label");
      expect(renderedLine(view)).toBe("label");
    } finally {
      view.destroy();
    }
  });

  it("collapses links with unescaped spaces in the destination", () => {
    // CommonMark refuses destinations with raw spaces, so "[note](My
    // Note.md)" parses as a bare "[note]" with the destination left as
    // literal text. Live preview must recover the "(...)" tail: hide it,
    // style the label, and expose the destination as data-href.
    const view = mount("\n[note](My Note.md) tail");
    try {
      const link = view.contentDOM.querySelector(".cm-md-link");
      expect(link?.textContent).toBe("note");
      expect(link?.getAttribute("data-href")).toBe("My Note.md");
      expect(renderedLine(view)).toBe("note tail");
    } finally {
      view.destroy();
    }
  });

  it("collapses images with unescaped spaces in the destination", () => {
    const view = mount("\n![alt text](My Image.png)");
    try {
      expect(renderedLine(view)).toBe("alt text");
    } finally {
      view.destroy();
    }
  });

  it("renders reference links and hides the [ref] part", () => {
    const view = mount("\n[label][ref]");
    try {
      expect(view.contentDOM.querySelector(".cm-md-link")?.textContent).toBe("label");
      expect(renderedLine(view)).toBe("label");
    } finally {
      view.destroy();
    }
  });

  it("renders images as the alt text", () => {
    const view = mount("\n![alt text](img.png)");
    try {
      expect(view.contentDOM.querySelector(".cm-md-image")?.textContent).toBe("alt text");
      expect(renderedLine(view)).toBe("alt text");
    } finally {
      view.destroy();
    }
  });

  it("renders a pasted image as a bitmap and opens the viewer on click", async () => {
    vi.mocked(invoke).mockResolvedValue(PNG_B64);
    const onOpenImage = vi.fn();
    const view = mount("\n![](assets/paste-1.png)", { dir: "/vault", onOpenImage });
    try {
      const widget = view.contentDOM.querySelector(".cm-md-image-widget") as HTMLElement;
      expect(widget).toBeTruthy();
      // Empty alt text must never collapse the image to a blank line.
      expect(widget.textContent).toBe("paste-1.png");
      await vi.waitFor(() => {
        expect(widget.querySelector("img")?.getAttribute("src")).toBe(
          `data:image/png;base64,${PNG_B64}`,
        );
      });
      widget.click();
      expect(onOpenImage).toHaveBeenCalledWith("assets/paste-1.png");
    } finally {
      view.destroy();
    }
  });

  it("renders Obsidian image embeds (![[…]]) as images", async () => {
    vi.mocked(invoke).mockResolvedValue(PNG_B64);
    const view = mount("\n![[Images/Pasted image.png]]", { dir: "/vault" });
    try {
      const widget = view.contentDOM.querySelector(".cm-md-image-widget") as HTMLElement;
      expect(widget).toBeTruthy();
      await vi.waitFor(() => {
        expect(widget.querySelector("img")?.getAttribute("src")).toBe(
          `data:image/png;base64,${PNG_B64}`,
        );
      });
      expect(view.state.doc.toString()).toBe("\n![[Images/Pasted image.png]]");
    } finally {
      view.destroy();
    }
  });

  it("keeps bare and autolinked URLs visible", () => {
    const view = mount("\nsee <https://example.com> and https://example.com");
    try {
      expect(renderedLine(view)).toBe("see https://example.com and https://example.com");
    } finally {
      view.destroy();
    }
  });

  it("renders wikilinks like read mode: styled note name, no brackets", () => {
    const view = mount("\nsee [[Other Note]] here");
    try {
      const wiki = view.contentDOM.querySelector(".cm-md-wikilink");
      expect(wiki?.textContent).toBe("Other Note");
      expect(wiki?.getAttribute("data-wikilink")).toBe("Other Note");
      expect(renderedLine(view)).toBe("see Other Note here");
    } finally {
      view.destroy();
    }
  });

  it("collapses blockquote marks and fence lines", () => {
    const view = mount("\n> quoted line\n\n```js\nlet x = 1;\n```\n");
    try {
      const lines = Array.from(view.contentDOM.querySelectorAll(".cm-line"));
      const text = lines.map((l) => (l.textContent ?? "").replace(/\u200b/g, ""));
      expect(text).toContain("quoted line");
      expect(text).toContain("let x = 1;");
      expect(text.join("\n")).not.toContain("```");
      expect(text.join("\n")).not.toContain(">");
    } finally {
      view.destroy();
    }
  });

  it("renders the task checkbox even on the cursor's line", () => {
    const view = mount("- [x] done");
    try {
      const box = view.contentDOM.querySelector('[role="checkbox"]');
      expect(box?.getAttribute("aria-checked")).toBe("true");
    } finally {
      view.destroy();
    }
  });

  it("renders an inactive table with header, recessed pipes and a hairline rule", () => {
    const view = mount("\n| Name | Age |\n| --- | ---: |\n| Ada | 36 |");
    try {
      expect(view.contentDOM.querySelector(".cm-md-table-header")).toBeTruthy();
      expect(view.contentDOM.querySelector(".cm-md-table-row")).toBeTruthy();
      expect(view.contentDOM.querySelectorAll(".cm-md-table-pipe").length).toBeGreaterThan(0);
      expect(view.contentDOM.querySelector(".cm-md-table-rule-widget")).toBeTruthy();
      // Presentation only: the markdown source stays untouched.
      expect(view.state.doc.toString()).toBe("\n| Name | Age |\n| --- | ---: |\n| Ada | 36 |");
    } finally {
      view.destroy();
    }
  });

  it("reveals the whole table's raw markdown while the caret is inside it", () => {
    const source = "intro\n| A | B |\n| --- | --- |\n| **x** | y |";
    // Cursor on the header line (line 2): the body row below must also show
    // its raw syntax, so arrowing through a table does not re-render rows.
    const view = mount(source);
    try {
      const head = view.state.doc.line(2).from;
      view.dispatch({ selection: { anchor: head } });
      expect(view.contentDOM.querySelector(".cm-md-table-rule-widget")).toBeNull();
      expect(renderedLine(view)).toContain("**x**");
      expect(view.state.doc.toString()).toBe(source);
    } finally {
      view.destroy();
    }
  });

  it("makes only the task checkbox atomic — collapsed syntax stays clickable", () => {
    const view = mount("\n**bold**\n- [ ] t");
    try {
      const atoms: [number, number][] = [];
      for (const set of view.state.facet(EditorView.atomicRanges).map((f) => f(view))) {
        set.between(0, view.state.doc.length, (from, to) => {
          atoms.push([from, to]);
        });
      }
      // The [ ] of the task (positions 12–15), and nothing else — in
      // particular not the ** of the bold mark, which must accept clicks.
      expect(atoms).toEqual([[12, 15]]);
    } finally {
      view.destroy();
    }
  });
});

describe("mdLivePreview in the editor", () => {
  it("hides syntax in the real editor stack, revealing it on the cursor's line", async () => {
    const file: VaultFile = {
      path: "notes/sample.md",
      content: "# Title\n\n**bold** here\n\nplain line",
      committed: null,
    };
    await render(
      <MarkdownEditor file={file} dir="/vault" onChange={noop} onCursor={noop} dark={false} />,
    );
    // Cursor is on line 1 (the heading): raw. Lines 3 and 5 are inactive.
    const text = (document.querySelector(".cm-content")?.textContent ?? "").replace(/\u200b/g, "");
    expect(text).toContain("# Title"); // active line shows raw markdown
    expect(text).toContain("bold here"); // inactive line collapsed
    expect(text).not.toContain("**bold**");
  });
});
